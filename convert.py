#!/usr/bin/env python3
"""将 PDF 转换为 Markdown。

用 pymupdf4llm 的 legacy 引擎（use_layout=False），避免幻灯片类 PDF
常见的字体缺字、表格错乱问题；并抽取图片、清理重复页脚。

用法:
    python convert.py <pdf路径> [-o 输出.md] [--dpi 200] [--no-images]

依赖:
    pip install pymupdf4llm
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
import time
from pathlib import Path

import pymupdf4llm


# ── 自动检测重复页脚/水印 ──────────────────────────────────────────
# 扫描 PDF 前若干页，提取每页首尾的短文本行；在多页中重复出现的即为页脚/页眉。


def detect_repeated_headers_footers(
    doc: pymupdf.Document, sample_pages: int = 20, min_repeat: int = 3
) -> list[str]:
    """扫描 PDF 自动检测重复的页眉/页脚/水印文本。

    策略：取前 sample_pages 页，每页抽首 2 行 + 末 2 行（trimmed），
    在 >= min_repeat 页中重复出现的行视为重复页脚/页眉。

    Returns:
        重复文本行的列表（已去重），用于构建正则。
    """
    counter: dict[str, int] = {}
    pages_to_check = min(sample_pages, doc.page_count)
    for pno in range(pages_to_check):
        page = doc[pno]
        lines = [
            l.strip() for l in page.get_text().split("\n") if l.strip()
        ]
        if not lines:
            continue
        # 首尾各取2行
        candidates = set()
        for line in lines[:2]:
            candidates.add(line)
        for line in lines[-2:]:
            candidates.add(line)
        for c in candidates:
            counter[c] = counter.get(c, 0) + 1

    # 出现在 >= min_repeat 页中的即为重复页脚/水印
    repeated = [
        text for text, count in counter.items() if count >= min_repeat
    ]
    # 过滤掉过短（可能是数字）或过长的（可能是正文）
    repeated = [t for t in repeated if 2 <= len(t) <= 80]
    return repeated


def build_footer_patterns(repeated_texts: list[str]) -> list[tuple[str, str, int]]:
    """把检测到的重复文本转为正则清理规则。

    匹配策略：转换后页脚常被合并到一行（如 "作者 标题 N of M"），
    所以用 "整行包含该文本" 的模糊匹配，而非要求整行等于该文本。
    同时限制行长 < 120 字符，避免误删含相同词的正文段落。
    """
    patterns: list[tuple[str, str, int]] = []
    for text in repeated_texts:
        if text.isdigit():
            continue
        escaped = re.escape(text)
        # 将被转义的连续数字替换为 \d+ （如 "2 of 105" -> "\d+ of \d+"）
        escaped = re.sub(r"\\d+", r"\\d+", escaped)
        # 匹配：整行长度 < 120 且包含该重复文本
        patterns.append(
            (r"^(.{0,120}?" + escaped + r".{0,120}?)\s*$", "", re.MULTILINE)
        )
    return patterns


# ── ISSCC 幻灯片专用补充规则（含分散在 caption 中的变体） ──────────
ISSCC_FOOTER_PATTERNS: list[tuple[str, str, int]] = [
    (r"KH Kim ISSCC 2021 Tutorial \d+ of 105\s*", "", 0),
    (
        r"KH Kim BW per processor \(CPU, GPU or Accelerator ASIC\) \d+ of 105",
        "",
        0,
    ),
]

def build_page_chapter_map(
    toc: list[list[int | str]], page_count: int
) -> dict[int, list[str]]:
    """把 PDF 书签树（TOC）转成 {page_number: [章节层级路径]} 映射。

    用层级栈算法：遍历每页，处理所有 start_page <= 当前的 TOC 条目，
    遇到新条目时弹出所有 >= 其 level 的条目再压入，保证路径始终反映
    当前页所属的完整章节继承链。

    Args:
        toc: pymupdf get_toc() 结果，每条 [level, title, start_page]。
        page_count: PDF 总页数。

    Returns:
        {1-based page_number: [章节标题列表，从顶级到子级]}。
    """
    toc_sorted = sorted(toc, key=lambda x: (x[2], x[0]))
    page_map: dict[int, list[str]] = {}
    stack: list[tuple[int, str]] = []
    ti = 0
    for pno in range(1, page_count + 1):
        while ti < len(toc_sorted) and toc_sorted[ti][2] <= pno:
            level, title, _ = toc_sorted[ti]
            while stack and stack[-1][0] >= level:
                stack.pop()
            stack.append((level, title))
            ti += 1
        page_map[pno] = [title for _, title in stack]
    return page_map


def format_page_comment(
    page: int,
    book_title: str,
    chapter_path: list[str],
) -> str:
    """生成富信息 HTML 注释，仅包含非空字段。

    格式: <!-- page: N | book: ... | chapter: A > B > C -->
    """
    parts = [f"page: {page}"]
    if book_title:
        parts.append(f"book: {book_title}")
    if chapter_path:
        parts.append(f"chapter: {' > '.join(chapter_path)}")
    return f"<!-- {' | '.join(parts)} -->"


def derive_book_title(metadata_title: str, filepath: str) -> str:
    """优先用 metadata.title，为空则用文件名（去扩展名）。"""
    title = (metadata_title or "").strip()
    if title:
        return title
    return Path(filepath).stem


# ── 段落合并：消除 PDF 软换行 ───────────────────────────────────────
# PDF 文本提取按视觉行断行，但同一段落的多行在 Markdown 中应合并为一行。

_SPECIAL_LINE = re.compile(
    r"^(<!--|"  # HTML 注释
    r"\|(?:.|$)|"  # 表格行
    r"#{1,6}\s|"  # 标题
    r"!\[|"  # 图片
    r">|"  # 引用
    r"```)"  # 代码块
)
_LIST_ITEM = re.compile(r"^(\s*)([-*+]\s|\d+[.)]\s)")
# 加粗段落起始（如 **1. 系统规划：**），作为段落边界
_PARA_START = re.compile(r"^\*\*[^*]{1,60}[：:]\*\*")


def join_paragraphs(text: str) -> str:
    """将 PDF 视觉软换行合并为 Markdown 段落。

    仅合并每页内部的连续普通文本行，保留所有 Markdown 块级结构
   （标题、表格、图片、列表、引用、代码块）。

    合并规则:
    - 英文连字符断词: 'shared-\\nmemory' -> 'sharedmemory'
    - 中英文衔接: 中文行尾 + 中文行首 -> 无空格直接连接
    - 其他: 用空格连接
    """
    lines = text.split("\n")
    result: list[str] = []
    i = 0
    while i < len(lines):
        line = lines[i].rstrip()
        if not line.strip():
            result.append("")
            i += 1
            continue
        if _SPECIAL_LINE.match(line) or _LIST_ITEM.match(line):
            result.append(line)
            i += 1
            continue

        # 收集连续普通行
        para_lines = [line]
        i += 1
        while i < len(lines):
            nl = lines[i].rstrip()
            if not nl.strip():
                break
            if _SPECIAL_LINE.match(nl) or _LIST_ITEM.match(nl):
                break
            if _PARA_START.match(nl):
                break
            para_lines.append(nl)
            i += 1

        merged = para_lines[0]
        for pl in para_lines[1:]:
            # 英文连字符断词修复
            if (
                merged.endswith("-")
                and len(merged) > 1
                and re.search(r"[a-zA-Z]$", merged[:-1])
            ):
                merged = merged[:-1] + pl
            # 中文衔接（无空格）
            elif re.search(
                r"[\u4e00-\u9fff，。；：）」』]$", merged
            ) and re.search(r"^[\u4e00-\u9fff]", pl):
                merged += pl
            else:
                merged += " " + pl
        result.append(merged)
    return "\n".join(result)


def export_toc(
    toc: list[list[int | str]],
    book_title: str,
    output_path: str,
) -> str:
    """把 PDF 书签树导出为 Markdown 目录文档。

    通用方式：只要有 TOC 就导出，没有则跳过。
    输出格式用缩进列表 + 页码，可直接作为文档导航索引。

    Args:
        toc: pymupdf get_toc() 结果，每条 [level, title, start_page]。
        book_title: 书名（用于标题）。
        output_path: 输出 .md 路径。

    Returns:
        输出路径（无 TOC 时返回空字符串）。
    """
    if not toc:
        return ""

    lines = [f"# {book_title} — 目录", ""]
    for level, title, page in toc:
        indent = "  " * (level - 1)
        lines.append(f"{indent}- {title} (p.{page})")
    lines.append("")

    Path(output_path).write_text("\n".join(lines), encoding="utf-8")
    return output_path


def convert(
    pdf_path: str,
    output: str | None = None,
    *,
    toc_output: str | None = None,
    dpi: int = 200,
    write_images: bool = True,
    image_format: str = "png",
    table_strategy: str = "lines_strict",
    auto_footer: bool = True,
    extra_footer_patterns: list[tuple[str, str, int]] | None = None,
    page_markers: bool = True,
    merge_paragraphs: bool = True,
) -> str:
    """转换单个 PDF 为 Markdown 并写盘，返回输出路径。

    Args:
        pdf_path:            输入 PDF 路径。
        output:              输出 .md 路径；None 则与 PDF 同名换 .md。
        dpi:                 图片分辨率，默认 200（高于库默认 150）。
        write_images:        是否抽取图片到 images/ 子目录。
        image_format:        png / jpg 等。
        table_strategy:      表格检测策略。
        auto_footer:         自动检测并清理重复页脚/水印。
        extra_footer_patterns: 额外的页脚正则规则（在自动检测之外追加）。
        page_markers:        在每页内容前插入 HTML 注释页码标记。
        toc_output:          章节目录 .md 输出路径；None 则与正文同目录同名加 -toc.md。
    """
    pdf = Path(pdf_path).resolve()
    if not pdf.exists():
        sys.exit(f"文件不存在: {pdf}")

    if output is None:
        output = str(pdf.with_suffix(".md"))
    out_path = Path(output).resolve()

    # 图片目录：输出文件同级下的 images/
    image_dir = ""
    if write_images:
        image_dir = str(out_path.parent / "images")

    # 关键：legacy 引擎，避免 layout 模式的缺字/表格问题
    pymupdf4llm.use_layout(False)

    # ── 读取元数据、TOC、自动检测页脚（共用一次 pymupdf 打开） ──
    footer_patterns: list[tuple[str, str, int]] = []
    book_title = ""
    page_chapters: dict[int, list[str]] = {}
    toc: list[list[int | str]] = []

    import pymupdf

    doc = pymupdf.open(str(pdf))
    if doc.page_count > 0:
        book_title = derive_book_title(doc.metadata.get("title", ""), str(pdf))
        if auto_footer:
            repeated = detect_repeated_headers_footers(doc)
            footer_patterns = build_footer_patterns(repeated)
            if footer_patterns:
                print(f"检测到 {len(footer_patterns)} 条重复页脚/水印:")
                for pat, _, _ in footer_patterns:
                    print(f"  {pat}")
        toc = doc.get_toc(simple=True)
        if toc:
            page_chapters = build_page_chapter_map(toc, doc.page_count)
            print(f"TOC: {len(toc)} 条书签，已建立章节映射")
    doc.close()

    if extra_footer_patterns:
        footer_patterns.extend(extra_footer_patterns)

    print(f"转换中: {pdf.name} ...")
    t0 = time.time()

    if page_markers:
        # 用 page_chunks 获取逐页文本 + 页码，插入 HTML 注释标记
        # page_chunks 模式下 write_images 仍正常工作（图片引用在 text 内）
        chunks = pymupdf4llm.to_markdown(
            str(pdf),
            write_images=write_images,
            image_path=image_dir,
            image_format=image_format,
            dpi=dpi,
            table_strategy=table_strategy,
            page_chunks=True,
            show_progress=True,
        )
        print(f"转换耗时 {time.time() - t0:.1f}s，{len(chunks)} 页")

        # 拼接：每页前插入富信息注释 <!-- page: N | book: ... | chapter: ... -->
        page_parts: list[str] = []
        for chunk in chunks:
            page = chunk["metadata"]["page"]  # 1-based
            text = chunk["text"].strip()
            if not text:
                continue
            # 页内先清理页脚，再插入标记
            if footer_patterns:
                for pat, repl, flags in footer_patterns:
                    text = re.sub(pat, repl, text, flags=flags)
            chapter_path = page_chapters.get(page, [])
            comment = format_page_comment(page, book_title, chapter_path)
            # 合并段落软换行
            if merge_paragraphs:
                text = join_paragraphs(text)
            page_parts.append(f"{comment}\n\n{text}")
        md = "\n\n".join(page_parts)
    else:
        md = pymupdf4llm.to_markdown(
            str(pdf),
            write_images=write_images,
            image_path=image_dir,
            image_format=image_format,
            dpi=dpi,
            table_strategy=table_strategy,
            show_progress=True,
        )
        print(f"转换耗时 {time.time() - t0:.1f}s，原始 {len(md)} 字符")

        # ── 后处理：清理重复页脚 ──
        if footer_patterns:
            before = len(md)
            for pat, repl, flags in footer_patterns:
                md = re.sub(pat, repl, md, flags=flags)
            removed = before - len(md)
            print(f"页脚清理去除 {removed} 字符")

        # 合并段落软换行
        if merge_paragraphs:
            md = join_paragraphs(md)
    # 合并多余空行
    md = re.sub(r"\n{3,}", "\n\n", md).strip() + "\n"

    # 把图片引用从绝对路径转成相对路径（相对于 .md 所在目录）
    if image_dir:
        img_dir_abs = os.path.abspath(image_dir)
        md = md.replace(img_dir_abs + "/", "images/")

    out_path.write_text(md, encoding="utf-8")
    n_imgs = (
        len(os.listdir(image_dir)) if image_dir and os.path.isdir(image_dir) else 0
    )
    print(f"输出: {out_path} ({out_path.stat().st_size} bytes, {md.count(chr(10))} 行)")
    if page_markers:
        n_pages = len(re.findall(r"<!-- page: \d+", md))
        print(f"页码标记: {n_pages} 个 (含书名/章节信息)")
    if n_imgs:
        print(f"图片: {n_imgs} 张 @ {dpi}dpi -> {image_dir}/")

    # 导出章节目录文档（有 TOC 时）
    if toc:
        toc_path = str(Path(toc_output)) if toc_output else str(
            out_path.parent / (out_path.stem + "-toc.md")
        )
        Path(toc_path).parent.mkdir(parents=True, exist_ok=True)
        export_toc(toc, book_title, toc_path)
        print(f"章节目录: {toc_path}")

    return str(out_path)


MANIFEST_NAME = ".manifest.json"


def sha256_of(path: Path) -> str:
    """流式计算文件 SHA-256（不一次性读入大文件）。"""
    h = hashlib.sha256()
    with path.open("rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):  # 1 MiB
            h.update(block)
    return h.hexdigest()


def load_manifest(kb_dir: Path) -> dict[str, dict]:
    """读取 KB/.manifest.json；无则返回空 dict。"""
    mf = kb_dir / MANIFEST_NAME
    if not mf.exists():
        return {}
    try:
        return json.loads(mf.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return {}


def save_manifest(kb_dir: Path, manifest: dict[str, dict]) -> None:
    """写回 KB/.manifest.json（pretty-print，便于人查）。"""
    mf = kb_dir / MANIFEST_NAME
    mf.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2, sort_keys=True),
        encoding="utf-8",
    )

def _purge_artifacts(rel_key: str, kb: Path, menu: Path) -> None:
    """删除某源 PDF 对应的 KB md / MENU toc，并清理空目录。

    rel_key 为 source 相对 posix 路径（如 "HPC/x.pdf"）。
    图片不按单文件区分（多书共享 images/），保留不动以免误删其他书的图。
    """
    rel = Path(rel_key)
    kb_md = kb / rel.with_suffix(".md")
    menu_md = menu / rel.parent / (rel.stem + "-toc.md")
    for p in (kb_md, menu_md):
        if p.exists():
            p.unlink()
    # 该书专属的 images/ 子目录（与 md 同级或更深）若空则删，避免目录清理被阻断
    book_img_dir = kb_md.parent / "images"
    if book_img_dir.is_dir() and not any(book_img_dir.iterdir()):
        book_img_dir.rmdir()
    # 清理 MENU 中变空的子目录；KB 根目录及共享 images/ 保留
    _remove_empty_dirs(menu, menu_md.parent)
    _remove_empty_dirs(kb, kb_md.parent)


def _remove_empty_dirs(root: Path, start: Path) -> None:
    """从 start 向上删除空目录，直到 root（不含）。"""
    start = start.resolve()
    root = root.resolve()
    try:
        cur = start
        while cur != root and cur.is_dir():
            if not any(cur.iterdir()):  # 空
                cur.rmdir()
                cur = cur.parent
            else:
                break
    except OSError:
        pass


def ingest(
    source_dir: str,
    kb_dir: str | None = None,
    menu_dir: str | None = None,
    *,
    force: bool = False,
    dpi: int = 200,
    write_images: bool = True,
    image_format: str = "png",
    table_strategy: str = "lines_strict",
    auto_footer: bool = True,
    extra_footer_patterns: list[tuple[str, str, int]] | None = None,
    page_markers: bool = True,
    merge_paragraphs: bool = True,
) -> list[str]:
    """批量增量入库：扫描 source/ 下所有 PDF，同步到 KB/、MENU/。

    目录镜像：source/ 的相对子目录结构在 KB/ 与 MENU/ 中原样重建；
    图片随正文落到 KB/ 对应子目录的 images/ 下。

    增量检测（基于 KB/.manifest.json 记录的 size/mtime/sha256）：
      - 新增：source 有、manifest 无 → 转换。
      - 修改：(size,mtime) 变了 → 重算 sha256；sha256 变了才转换（mtime/size 变但内容未变则刷新 manifest 不重转）。
      - 删除：source 无、manifest 有 → 删除 KB md + MENU toc + 残留空目录。
      - 无变化：stat 指纹(size,mtime) 与 manifest 一致且 force=False → 跳过（不重算 sha）。
    force=True 时忽略所有缓存，全部重转。

    Args:
        source_dir: 入库前文档根目录（PDF 所在）。
        kb_dir:     入库后 Markdown 根目录；None 则取 source 同级 KB。
        menu_dir:   章节目录根目录；None 则取 source 同级 MENU。
        force:      强制全部重转（忽略缓存）。

    Returns:
        本次实际生成的 .md 路径列表。
    """
    source = Path(source_dir).resolve()
    if not source.is_dir():
        sys.exit(f"source 目录不存在: {source}")

    kb = Path(kb_dir).resolve() if kb_dir else source.parent / "KB"
    menu = Path(menu_dir).resolve() if menu_dir else source.parent / "MENU"
    kb.mkdir(parents=True, exist_ok=True)
    menu.mkdir(parents=True, exist_ok=True)

    manifest = load_manifest(kb)
    pdfs = sorted(source.rglob("*.pdf"))
    current_rels = {p.relative_to(source).as_posix() for p in pdfs}

    if not pdfs and not manifest:
        print(f"source 中未找到 PDF: {source}")
        return []

    print(f"入库: {len(pdfs)} 个 PDF  | source={source}")
    print(f"      KB={kb}")
    print(f"      MENU={menu}")

    # ── 1) 删除同步：manifest 中存在、source 中已不存在的文件 ──
    removed = 0
    for rel_key in sorted(set(manifest) - current_rels):
        _purge_artifacts(rel_key, kb, menu)
        manifest.pop(rel_key, None)
        print(f"  删除(源已移除): {rel_key}")
        removed += 1

    # ── 2) 新增/修改：遍历当前 source PDF ──
    generated: list[str] = []
    skipped = 0
    for pdf in pdfs:
        rel = pdf.relative_to(source)
        rel_key = rel.as_posix()
        # 镜像目录结构：KB/<相对路径>.md ; MENU/<相对父目录>/<stem>-toc.md
        kb_md = kb / rel.with_suffix(".md")
        menu_md = menu / rel.parent / (rel.stem + "-toc.md")

        st = pdf.stat()
        entry = manifest.get(rel_key)
        stat_match = (
            entry is not None
            and entry.get("size") == st.st_size
            and entry.get("mtime") == st.st_mtime
        )

        # 快速路径：stat 指纹一致且非强制 → 直接跳过（不重算 sha，省大文件 IO）
        if not force and stat_match and entry.get("sha256"):
            print(f"  跳过(无变化): {rel_key}")
            skipped += 1
            continue

        # 慢路径：重算 sha256（force 或 stat 变了）
        digest = sha256_of(pdf)
        if not force and entry and entry.get("sha256") == digest:
            # 内容未变，仅 stat（如 touch / 复制覆盖）变化 → 刷新 manifest，不重转
            print(f"  跳过(内容未变): {rel_key}")
            manifest[rel_key] = {
                "size": st.st_size, "mtime": st.st_mtime, "sha256": digest,
            }
            skipped += 1
            continue

        kb_md.parent.mkdir(parents=True, exist_ok=True)
        menu_md.parent.mkdir(parents=True, exist_ok=True)
        print(f"\n→ {rel_key}")
        out = convert(
            str(pdf),
            output=str(kb_md),
            toc_output=str(menu_md),
            dpi=dpi,
            write_images=write_images,
            image_format=image_format,
            table_strategy=table_strategy,
            auto_footer=auto_footer,
            extra_footer_patterns=extra_footer_patterns,
            page_markers=page_markers,
            merge_paragraphs=merge_paragraphs,
        )
        generated.append(out)
        manifest[rel_key] = {
            "size": st.st_size, "mtime": st.st_mtime, "sha256": digest,
        }

    save_manifest(kb, manifest)
    print(
        f"\n入库完成: 转换 {len(generated)}，跳过 {skipped}，"
        f"删除 {removed}，共 {len(pdfs)} 个源文件"
    )
    return generated



def main() -> None:
    ap = argparse.ArgumentParser(description="PDF -> Markdown 高精度转换")
    ap.add_argument("pdf", nargs="?", help="输入 PDF 路径（单文件模式）")
    ap.add_argument("-o", "--output", help="输出 .md 路径（默认同名 .md）")
    ap.add_argument("--dpi", type=int, default=200, help="图片分辨率 (默认 200)")
    ap.add_argument("--no-images", action="store_true", help="不抽取图片")
    ap.add_argument(
        "--table-strategy",
        default="lines_strict",
        choices=["lines_strict", "lines", "text"],
        help="表格检测策略 (默认 lines_strict)",
    )
    ap.add_argument(
        "--no-auto-footer",
        action="store_true",
        help="禁用自动页脚/水印检测清理",
    )
    ap.add_argument(
        "--no-page-markers",
        action="store_true",
        help="禁用页码注释标记（默认启用）",
    )
    ap.add_argument(
        "--no-join-paragraphs",
        action="store_true",
        help="禁用段落软换行合并（默认启用）",
    )
    # ── 入库（批量）模式 ──
    ap.add_argument(
        "--ingest",
        action="store_true",
        help="增量入库：按 SHA-256 检测 source/ 增删改，同步到 KB/ 与 MENU/",
    )
    ap.add_argument(
        "--source",
        default="source",
        help="入库前文档根目录 (默认 source)",
    )
    ap.add_argument("--kb", help="入库后 Markdown 根目录 (默认 source 同级 KB)")
    ap.add_argument("--menu", help="章节目录根目录 (默认 source 同级 MENU)")
    ap.add_argument(
        "--force",
        action="store_true",
        help="强制全部重转（忽略缓存，重算并转换所有文件）",
    )
    args = ap.parse_args()

    if args.ingest:
        ingest(
            args.source,
            args.kb,
            args.menu,
            force=args.force,
            dpi=args.dpi,
            write_images=not args.no_images,
            table_strategy=args.table_strategy,
            auto_footer=not args.no_auto_footer,
            page_markers=not args.no_page_markers,
            merge_paragraphs=not args.no_join_paragraphs,
        )
        return

    if not args.pdf:
        ap.error("单文件模式需要 PDF 路径；批量入库请加 --ingest")

    convert(
        args.pdf,
        args.output,
        dpi=args.dpi,
        write_images=not args.no_images,
        table_strategy=args.table_strategy,
        auto_footer=not args.no_auto_footer,
        page_markers=not args.no_page_markers,
        merge_paragraphs=not args.no_join_paragraphs,
    )


if __name__ == "__main__":
    main()
