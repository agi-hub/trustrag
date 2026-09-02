#!/usr/bin/env python3
"""将 PDF 转换为 Markdown.

默认使用 pdf-inspector（快速、准确），失败时自动回退到 pymupdf4llm 的 legacy 引擎
（use_layout=False），避免幻灯片类 PDF 常见的字体缺字、表格错乱问题；并抽取图片、清理重复页脚。

用法:
    python convert.py <pdf路径> [-o 输出.md] [--dpi 200] [--no-images]

依赖:
    pip install pdf-inspector pymupdf4llm
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

# 优先尝试 pdf-inspector，失败时使用 pymupdf4llm 作为备选
try:
    import pdf_inspector
    _HAS_PDF_INSPECTOR = True
except ImportError:
    pdf_inspector = None
    _HAS_PDF_INSPECTOR = False

import pymupdf4llm


# ── 自动检测重复页脚/水印 ──────────────────────────────────────────
# 扫描 PDF 前若干页，提取每页首尾的短文本行；在多页中重复出现的即为页脚/页眉。


def detect_repeated_headers_footers(
    doc: pymupdf.Document, sample_pages: int = 20, min_repeat: int = 3
) -> list[str]:
    """扫描 PDF 自动检测重复的页眉/页脚/水印文本。

    Args:
        doc: pymupdf 文档对象。
        sample_pages: 采样页数（从前 sample_pages 页中检测）。
        min_repeat: 最小重复次数才视为重复内容。

    Returns:
        重复文本行列表。
    """
    repeated: list[str] = []
    if doc.page_count < min_repeat:
        return repeated

    # 提取每页首尾各 3 行，记录出现的次数
    line_counts: dict[str, int] = {}
    for i in range(min(sample_pages, doc.page_count)):
        page = doc[i]
        text = page.get_text()
        lines = [ln.strip() for ln in text.split("\n") if ln.strip()]
        if not lines:
            continue
        # 取前 3 行和后 3 行
        candidates = lines[:3] + lines[-3:] if len(lines) > 6 else lines
        for ln in candidates:
            # 仅考虑短文本（可能的页脚/水印）
            if len(ln) <= 100:
                line_counts[ln] = line_counts.get(ln, 0) + 1

    # 筛选出重复次数 >= min_repeat 的行
    repeated = [ln for ln, cnt in line_counts.items() if cnt >= min_repeat]
    return repeated


def build_footer_patterns(repeated_texts: list[str]) -> list[tuple[str, str, int]]:
    """把检测到的重复文本转为正则清理规则。

    Args:
        repeated_texts: 重复文本列表。

    Returns:
        (正则模式, 替换字符串, 标志) 列表。
    """
    patterns: list[tuple[str, str, int]] = []
    for text in repeated_texts:
        # 转义正则特殊字符
        escaped = re.escape(text)
        # 匹配整行（可能前后有空格）
        patterns.append((rf"^\s*{escaped}\s*$", "", re.MULTILINE))
    return patterns


# ── ISSCC 幻灯片专用补充规则（含分散在 caption 中的变体） ──────────
ISSCC_FOOTER_PATTERNS: list[tuple[str, str, int]] = [
    # 常见会议信息、版权、页码等
    (r"^\s*ISSCC \d{4} SESSION.*$", "", re.MULTILINE),
    (r"^\s*\d{4}\.\d{2}\.\d{2}.*$", "", re.MULTILINE),
    (r"^\s*Page \d+ of \d+.*$", "", re.MULTILINE),
    (r"^\s*\d+/\d+/\d{4}.*$", "", re.MULTILINE),
    (r"^\s*Copyright.*$", "", re.MULTILINE),
    (r"^\s*Confidential.*$", "", re.MULTILINE),
]


def build_page_chapter_map(
    toc: list[list[int | str]], page_count: int
) -> dict[int, list[str]]:
    """把 PDF 书签树（TOC）转成 {page_number: [章节层级路径]} 映射。

    Args:
        toc: pymupdf get_toc() 结果，每条 [level, title, start_page]。
        page_count: 总页数。

    Returns:
        {页码: [层级1标题, 层级2标题, ...]} 映射；无书签页返回空列表。
    """
    page_map: dict[int, list[str]] = {}
    stack: list[tuple[int, str]] = []  # (level, title) 栈

    for level, title, start_page in toc:
        # 弹出比当前 level 高或相等的栈项
        while stack and stack[-1][0] >= level:
            stack.pop()
        # 压入当前项
        stack.append((level, title))
        # 为该页记录完整的层级路径
        path = [item[1] for item in stack]
        # 从 start_page 开始，后续页继承该路径，直到遇到新的同级/上级书签
        for page in range(start_page, page_count + 1):
            # 仅当该页还未映射或映射为空时才设置（避免覆盖更具体的下级映射）
            if page not in page_map:
                page_map[page] = path.copy()

    # 填充未映射的页（无书签覆盖的页）
    for page in range(1, page_count + 1):
        if page not in page_map:
            page_map[page] = []

    return page_map


def format_page_comment(
    page: int, book_title: str, chapter_path: list[str]
) -> str:
    """生成富信息 HTML 注释，仅包含非空字段。

    Args:
        page: 页码（1-based）。
        book_title: 书名。
        chapter_path: 章节层级路径。

    Returns:
        HTML 注释字符串，如 <!-- page: 5 | book: 深度学习 | chapter: 第一章 基础 -->
    """
    parts = [f"page: {page}"]
    if book_title:
        parts.append(f"book: {book_title}")
    if chapter_path:
        parts.append(f"chapter: {' > '.join(chapter_path)}")
    return f"<!-- {' | '.join(parts)} -->"


def derive_book_title(metadata_title: str, filepath: str) -> str:
    """优先用 metadata.title，为空则用文件名（去扩展名）。"""
    return metadata_title.strip() or Path(filepath).stem


# ── 段落合并：消除 PDF 软换行 ───────────────────────────────────────
# PDF 文本提取按视觉行断行，但同一段落的多行在 Markdown 中应合并为一行。


_SPECIAL_LINE = re.compile(
    r"^\s*([#*+-]|\d+\.)\s"  # 列表项、标题
)
_LIST_ITEM = re.compile(r"^(\s*)([-*+]\s|\d+[.)]\s)")
# 加粗段落起始（如 **1. 系统规划：**），作为段落边界
_PARA_START = re.compile(r"^\*\*[^*]{1,60}[：:]\*\*")


def join_paragraphs(text: str) -> str:
    """将 PDF 视觉软换行合并为 Markdown 段落。

    规则：
    1. 空行分隔段落，保留。
    2. 连续的非空行：如果下一行不是特殊行（列表/标题/加粗段落起始），
       且当前行不以句号/问号/感叹号/引号结尾，则合并。
    3. 列表项、标题、加粗段落起始等行视为新段落，不与前一行合并。
    """
    lines = text.split("\n")
    result: list[str] = []
    i = 0
    while i < len(lines):
        line = lines[i].rstrip()
        # 空行直接保留
        if not line:
            result.append("")
            i += 1
            continue
        # 特殊行直接保留
        if _SPECIAL_LINE.match(line) or _PARA_START.match(line):
            result.append(line)
            i += 1
            continue
        # 列表项直接保留
        if _LIST_ITEM.match(line):
            result.append(line)
            i += 1
            continue
        # 普通行：尝试与下一行合并
        merged = line
        j = i + 1
        while j < len(lines):
            next_line = lines[j].rstrip()
            # 遇到空行或特殊行，停止合并
            if not next_line or _SPECIAL_LINE.match(next_line) or _PARA_START.match(next_line) or _LIST_ITEM.match(next_line):
                break
            # 当前行不以结束符结尾，且下一行首字母小写（可能是续行），则合并
            if not re.search(r"[。！？.!?\"\']$", merged) and not re.match(r"[A-Z]", next_line):
                merged += " " + next_line
                j += 1
            else:
                break
        result.append(merged)
        i = j
    return "\n".join(result)


def export_toc(
    toc: list[list[int | str]], book_title: str, output_path: str
) -> str:
    """把 PDF 书签树导出为 Markdown 目录文档。

    Args:
        toc: pymupdf get_toc() 结果，每条 [level, title, start_page].
        book_title: 书名（用于标题）.
        output_path: 输出 .md 路径.

    Returns:
        输出路径（无 TOC 时返回空字符串）.
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


def convert_with_pdf_inspector(
    pdf_path: str,
    output: str | None = None,
    *,
    write_images: bool = True,
    image_format: str = "png",
    dpi: int = 200,
    page_markers: bool = True,
    merge_paragraphs: bool = True,
) -> tuple[str, bool, str]:
    """使用 pdf-inspector 转换 PDF 为 Markdown.

    Returns:
        (markdown文本, 是否成功, 错误信息)
    """
    try:
        print(f"使用 pdf-inspector 转换: {Path(pdf_path).name} ...")
        t0 = time.time()

        result = pdf_inspector.process_pdf(pdf_path)

        if result.markdown is None:
            return "", False, "pdf-inspector 未能提取 Markdown 内容"

        md = result.markdown
        print(f"pdf-inspector 转换完成，耗时 {time.time() - t0:.1f}s")
        print(f"  PDF 类型: {result.pdf_type}, 页数: {result.page_count}")

        # 如果需要图片，单独使用pymupdf4llm提取图片
        if write_images:
            print(f"使用 pymupdf4llm 提取图片...")
            t0_img = time.time()
            try:
                # 确定输出路径和图片目录
                if output is None:
                    output = str(Path(pdf_path).with_suffix(".md"))
                out_path = Path(output)
                image_dir = str(out_path.parent / "images")

                # 使用pymupdf4llm提取图片（不获取文本）
                import pymupdf
                doc = pymupdf.open(pdf_path)
                
                # 创建图片目录
                Path(image_dir).mkdir(parents=True, exist_ok=True)
                
                # 提取图片
                img_count = 0
                for page_num in range(doc.page_count):
                    page = doc[page_num]
                    image_list = page.get_images()
                    for img_index, img in enumerate(image_list):
                        try:
                            xref = img[0]
                            base_image = doc.extract_image(xref)
                            if base_image:
                                image_ext = base_image["ext"]
                                image_filename = f"{Path(pdf_path).stem}-{page_num+1}-{img_index}.{image_ext}"
                                image_filepath = Path(image_dir) / image_filename
                                
                                with open(image_filepath, "wb") as img_file:
                                    img_file.write(base_image["image"])
                                img_count += 1
                        except Exception as e:
                            print(f"  警告：提取图片失败: {e}")
                            continue
                
                doc.close()
                print(f"  提取了 {img_count} 张图片 -> {image_dir}/")
                print(f"  图片提取耗时 {time.time() - t0_img:.1f}s")
            except Exception as e:
                print(f"  ⚠️ 图片提取失败: {str(e)}")

        # 应用段落合并
        if merge_paragraphs:
            md = join_paragraphs(md)

        # 合并多余空行
        md = re.sub(r"\n{3,}", "\n\n", md).strip() + "\n"

        return md, True, ""

    except Exception as e:
        error_msg = f"pdf-inspector 转换失败: {str(e)}"
        print(f"⚠️  {error_msg}")
        return "", False, error_msg


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
    force_pymupdf: bool = False,
) -> str:
    """转换单个 PDF 为 Markdown 并写盘，返回输出路径.

    Args:
        pdf_path:            输入 PDF 路径.
        output:              输出 .md 路径；None 则与 PDF 同名换 .md.
        dpi:                 图片分辨率，默认 200（高于库默认 150）.
        write_images:        是否抽取图片到 images/ 子目录.
        image_format:        png / jpg 等.
        table_strategy:      表格检测策略.
        auto_footer:         自动检测并清理重复页脚/水印.
        extra_footer_patterns: 额外的页脚正则规则（在自动检测之外追加）.
        page_markers:        在每页内容前插入 HTML 注释页码标记.
        toc_output:          章节目录 .md 输出路径；None 则与正文同目录同名加 -toc.md.
        force_pymupdf:       强制使用 pymupdf4llm 而不是 pdf-inspector.
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

    # ── 优先使用 pdf-inspector，失败时回退到 pymupdf4llm ──
    md = ""
    used_pdf_inspector = False

    if not force_pymupdf and _HAS_PDF_INSPECTOR:
        md, success, error = convert_with_pdf_inspector(
            str(pdf),
            output=str(out_path),
            write_images=write_images,
            image_format=image_format,
            dpi=dpi,
            page_markers=page_markers,
            merge_paragraphs=merge_paragraphs,
        )
        if success:
            used_pdf_inspector = True
        else:
            print(f"回退到 pymupdf4llm: {error}")
    elif force_pymupdf:
        print("强制使用 pymupdf4llm（--force-pymupdf）")
    else:
        print("pdf-inspector 未安装，使用 pymupdf4llm")

    # 只有当 pdf-inspector 失败或未安装或强制使用pymupdf时才使用 pymupdf4llm
    if not used_pdf_inspector:
        print(f"转换中: {pdf.name} (使用 pymupdf4llm) ...")
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
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def load_manifest(kb_dir: Path) -> dict[str, dict]:
    """读取 KB/.manifest.json；无则返回空 dict。"""
    manifest_path = kb_dir / MANIFEST_NAME
    if not manifest_path.exists():
        return {}
    try:
        with manifest_path.open("r", encoding="utf-8") as f:
            return json.load(f)
    except (json.JSONDecodeError, IOError):
        return {}


def save_manifest(kb_dir: Path, manifest: dict[str, dict]) -> None:
    """写回 KB/.manifest.json（pretty-print，便于人查）。"""
    manifest_path = kb_dir / MANIFEST_NAME
    with manifest_path.open("w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2, ensure_ascii=False)


def _purge_artifacts(rel_key: str, kb: Path, menu: Path) -> None:
    """删除某源 PDF 对应的 KB md / MENU toc，并清理空目录。"""
    # KB 侧：删除 md 和 images/ 子目录
    kb_md = kb / rel_key
    kb_images = kb_md.parent / "images"
    if kb_md.exists():
        kb_md.unlink()
    if kb_images.exists() and kb_images.is_dir():
        import shutil
        shutil.rmtree(kb_images)
    _remove_empty_dirs(kb, kb_md.parent)

    # MENU 侧：删除 toc 文件
    menu_toc = menu / Path(rel_key).parent / (Path(rel_key).stem + "-toc.md")
    if menu_toc.exists():
        menu_toc.unlink()
    _remove_empty_dirs(menu, menu_toc.parent)


def _remove_empty_dirs(root: Path, start: Path) -> None:
    """从 start 向上删除空目录，直到 root（不含）。"""
    current = start
    while current != root and current.exists() and current.is_dir():
        try:
            current.rmdir()  # 仅在目录为空时成功
            current = current.parent
        except OSError:
            # 目录非空，停止删除
            break


def ingest(
    source_dir: str,
    kb_dir: str | None = None,
    menu_dir: str | None = None,
    *,
    force: bool = False,
    force_pymupdf: bool = False,
    dpi: int = 200,
    write_images: bool = True,
    image_format: str = "png",
    table_strategy: str = "lines_strict",
    auto_footer: bool = True,
    extra_footer_patterns: list[tuple[str, str, int]] | None = None,
    page_markers: bool = True,
    merge_paragraphs: bool = True,
) -> list[str]:
    """批量增量入库：扫描 source/ 下所有 PDF，同步到 KB/、MENU/.

    目录镜像：source/ 的相对子目录结构在 KB/ 与 MENU/ 中原样重建；
    每个源 PDF 生成：
      - KB/<相对路径>.md（正文，含页码标记）
      - MENU/<相对父目录>/<stem>-toc.md（章节目录）

    增量策略：
      - 按 SHA-256 内容指纹检测变更，仅转换新增或修改的 PDF.
      - 保留 .manifest.json 记录已处理文件的指纹，支持断点续传和删除同步.

    Args:
        source_dir: 源 PDF 根目录.
        kb_dir: KB Markdown 根目录（默认 source 同级 KB）.
        menu_dir: MENU 章节目录根目录（默认 source 同级 MENU）.
        force: 强制全部重转（忽略缓存）.
        force_pymupdf: 强制使用 pymupdf4llm 而不是 pdf-inspector.
        其他参数同 convert().

    Returns:
        新生成的 .md 路径列表.
    """
    source = Path(source_dir).resolve()
    if not source.exists():
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
            force_pymupdf=force_pymupdf,
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
    ap.add_argument(
        "--force-pymupdf",
        action="store_true",
        help="强制使用 pymupdf4llm（默认优先使用 pdf-inspector，失败时回退）",
    )
    args = ap.parse_args()

    if args.ingest:
        ingest(
            args.source,
            args.kb,
            args.menu,
            force=args.force,
            force_pymupdf=args.force_pymupdf,
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
        force_pymupdf=args.force_pymupdf,
    )


if __name__ == "__main__":
    main()