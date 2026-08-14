#!/usr/bin/env python3
"""零幻觉 Agentic RAG — Markdown 仓库多轮检索 CLI。

核心约束：LLM 只做搜索规划/筛选/打分，输出内容 100% 源自 Markdown 原文摘抄。
详见「零幻觉RAG需求说明书.md」。

用法:
    # CLI 参数模式
    python rag_search.py -q "Data Pipeline 相关章节" -d ~/pymupdftest -o result.md

    # 交互模式（进入后输入查询）
    python rag_search.py -d ~/pymupdftest

    # 指定模型/轮次
    python rag_search.py -q "GPU内存层次" -d ~/docs --max-rounds 5 --model glm-4-flash

环境变量:
    ZHIPU_API_KEY    智谱 API Key（默认从 k.md 读取的内置值）
    ZHIPU_BASE_URL   智谱 API 地址（默认 https://open.bigmodel.cn/api/paas/v4/）

依赖:
    pip install openai
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import re
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path

from openai import OpenAI

try:
    import jieba
    jieba.setLogLevel(20)  # 抑制 jieba 初始化日志
    _HAS_JIEBA = True
except ImportError:
    _HAS_JIEBA = False


def tokenize_query(query: str) -> list[str]:
    """对中文查询做分词，返回有效词列表。

    jieba 分词后过滤停用词和短词，确保中文复合词（如"控制状态机"）
    能被拆成可搜索的子词（"状态机"、"状态"、"控制"）。
    """
    tokens = []
    if _HAS_JIEBA:
        seg_list = jieba.cut_for_search(query)
        for word in seg_list:
            word = word.strip()
            if len(word) >= 2 and word not in _STOPWORDS:
                tokens.append(word)
    # 同时保留原始空格/标点分词
    for t in re.split(r"[\s,，。、；;:：()（）]+", query):
        t = t.strip()
        if len(t) >= 3 and t not in tokens:
            tokens.append(t)
    return tokens

# ── 配置文件加载 ─────────────────────────────────────────────────────
_CONFIG_PATH = Path(__file__).parent / "rag-web" / "config.json"
_config = {}
if _CONFIG_PATH.exists():
    try:
        _config = json.loads(_CONFIG_PATH.read_text(encoding="utf-8"))
    except Exception:
        pass

DEFAULT_API_KEY = _config.get("api_key", "")
DEFAULT_BASE_URL = _config.get("base_url", "https://open.bigmodel.cn/api/paas/v4/")
DEFAULT_MODEL = _config.get("model", "glm-4-flash")
DEFAULT_MAX_ROUNDS = 3
CONTEXT_LINES = 3  # 命中行前后各取多少行作为上下文


# ── 数据结构 ──────────────────────────────────────────────────────────
@dataclass
class PageMeta:
    """从 <!-- page: N | book: ... | chapter: ... --> 解析的元数据。"""
    page: str = ""
    book: str = ""
    chapter: str = ""
    raw: str = ""

    def __str__(self) -> str:
        parts = []
        if self.page:
            parts.append(f"page: {self.page}")
        if self.book:
            parts.append(f"book: {self.book}")
        if self.chapter:
            parts.append(f"chapter: {self.chapter}")
        return " | ".join(parts) if parts else "未识别到标准化章节页码信息"


@dataclass
class SearchHit:
    """单条搜索命中。"""
    file_path: str
    line_start: int  # 1-based
    line_end: int  # 1-based
    text: str  # 原文摘抄（含上下文）
    meta: PageMeta
    matched_keyword: str
    round_num: int
    score: int = 0  # 相关性概率 0-100
    exact_match: bool = False  # 是否严格包含用户原始查询词

    def key(self) -> str:
        """用于去重的唯一键：文件+起始行。"""
        return f"{self.file_path}:{self.line_start}"


@dataclass
class RoundLog:
    """单轮搜索日志。"""
    round_num: int
    keywords: list[str]
    hit_files: list[str] = field(default_factory=list)
    new_hits_count: int = 0
    judgment: str = ""
    next_plan: str = ""


# ── Markdown 元数据解析 ────────────────────────────────────────────────
_PAGE_META_RE = re.compile(
    r"<!--\s*page:\s*(.*?)-->", re.DOTALL
)


def parse_page_meta(line: str) -> PageMeta | None:
    """从单行文本中提取 <!-- page: ... --> 元数据。"""
    m = _PAGE_META_RE.search(line)
    if not m:
        return None
    raw = m.group(1).strip()
    meta = PageMeta(raw=raw)
    # 按 | 分割字段
    for part in raw.split("|"):
        part = part.strip()
        if part.lower().startswith("page:"):
            meta.page = part[5:].strip()
        elif part.lower().startswith("book:"):
            meta.book = part[5:].strip()
        elif part.lower().startswith("chapter:"):
            meta.chapter = part[8:].strip()
    return meta


def find_meta_for_line(lines: list[str], line_idx: int) -> PageMeta:
    """向前搜索最近的 <!-- page --> 标记，返回该行所属的元数据。"""
    for i in range(line_idx, -1, -1):
        meta = parse_page_meta(lines[i])
        if meta:
            return meta
    return PageMeta()


# ── Markdown 全文搜索 ──────────────────────────────────────────────────

# 英文泛化词黑名单（长度短/出现频率高/无技术意义）
_STOPWORDS = frozenset({
    "data", "flow", "line", "stream", "method", "design", "system",
    "the", "and", "for", "with", "from", "that", "this", "were",
    "are", "was", "will", "can", "has", "have", "not", "but",
    "process", "value", "type", "size", "code", "text", "word",
    "time", "rate", "mode", "port", "host", "node", "path",
})


def _is_valid_keyword(kw: str) -> bool:
    """过滤无效/泛化关键词。"""
    kw_lower = kw.lower().strip()
    if not kw_lower:
        return False
    # 纯英文单词且在停用词表中
    if kw_lower in _STOPWORDS:
        return False
    # 纯英文且长度 < 5（太短的英文词命中率太高）
    if re.fullmatch(r"[a-zA-Z]+", kw_lower) and len(kw_lower) < 5:
        return False
    return True

def _common_root(md_files: list[Path]) -> Path:
    """计算所有 md 文件的公共父目录，作为 ripgrep 的搜索根。"""
    if len(md_files) == 1:
        return md_files[0].parent
    common = md_files[0].parent
    for f in md_files[1:]:
        # 逐步收窄公共前缀
        while common != common.parent and common not in f.parents:
            common = common.parent
        if common == common.parent:
            break
    return common


def _rg_escape_literal(s: str) -> str:
    """转义 regex 元字符为字面量，兼容 ripgrep 与 grep -E。

    不用 re.escape（它会把空格也转义成 '\\ '，ripgrep 不接受）。
    """
    return re.sub(r'([\\\[\]{}()*+?.^$|])', r'\\\1', s)


def _ripgrep_matches(
    keywords: list[str], root: Path, md_files: list[Path]
) -> list[tuple[Path, int, str]]:
    """调用 ripgrep 并集扫描，返回 [(文件路径, 1-based 行号, 命中的关键词)]。

    ripgrep 以 --json 输出，每条 match 含 path / line_number / submatches。
    关键词转义为字面量、大小写不敏感，用 | 合并为单个并集 pattern。
    """
    # 每个关键词转义为字面量，按长度降序匹配（长词优先，避免短词误吞长词的子串）
    kws_sorted = sorted((kw.strip() for kw in keywords if kw.strip()), key=len, reverse=True)
    pattern = "|".join(_rg_escape_literal(kw) for kw in kws_sorted)
    # 若 rg 不可用，回退到 grep（输出格式 path:lineno:line，无法区分是哪个词，需逐词判定）
    rg_bin = shutil.which("rg")
    if rg_bin:
        try:
            proc = subprocess.run(
                [rg_bin, "--json", "-i", "-n", "--no-heading", pattern, "--glob", "*.md"],
                cwd=str(root), capture_output=True, text=True, timeout=60,
                stdin=subprocess.DEVNULL,
            )
            results: list[tuple[Path, int, str]] = []
            kw_lower = [kw.lower() for kw in kws_sorted]
            for line in proc.stdout.splitlines():
                if not line:
                    continue
                try:
                    obj = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if obj.get("type") != "match":
                    continue
                data = obj.get("data", {})
                path_text = data.get("path", {}).get("text")
                lineno = data.get("line_number")
                if not path_text or lineno is None:
                    continue
                # 优先用 ripgrep 报告的 submatches 确定命中的词；否则回退到逐词检测
                matched_kw = ""
                subs = data.get("submatches", [])
                if subs:
                    hit_text = subs[0].get("match", {}).get("text", "").lower()
                    for i, kl in enumerate(kw_lower):
                        if kl == hit_text:
                            matched_kw = kws_sorted[i]
                            break
                if not matched_kw:
                    line_text = data.get("lines", {}).get("text", "").lower()
                    for i, kl in enumerate(kw_lower):
                        if kl in line_text:
                            matched_kw = kws_sorted[i]
                            break
                if not matched_kw:
                    matched_kw = kws_sorted[0]
                results.append((root / path_text, int(lineno), matched_kw))
            return results
        except (subprocess.SubprocessError, FileNotFoundError):
            pass  # 落到 grep 回退

    # 回退：grep -r -i -n（输出 path:lineno:line，按 (文件,行号) 升序）
    grep_bin = shutil.which("grep") or "grep"
    try:
        proc = subprocess.run(
            [grep_bin, "-r", "-i", "-n", "--include=*.md", "-E", pattern, "."],
            cwd=str(root), capture_output=True, text=True, timeout=60,
            stdin=subprocess.DEVNULL,
        )
        results = []
        kw_lower = [kw.lower() for kw in kws_sorted]
        for line in proc.stdout.splitlines():
            # 格式: relative/path:lineno:content
            idx = line.find(":")
            if idx < 0:
                continue
            rest = line[idx + 1:]
            idx2 = rest.find(":")
            if idx2 < 0:
                continue
            rel = line[:idx]
            try:
                lineno = int(rest[:idx2])
            except ValueError:
                continue
            content = rest[idx2 + 1:].lower()
            matched_kw = kws_sorted[0]
            for i, kl in enumerate(kw_lower):
                if kl in content:
                    matched_kw = kws_sorted[i]
                    break
            results.append((root / rel, lineno, matched_kw))
        return results
    except (subprocess.SubprocessError, FileNotFoundError):
        return []


def _build_meta_index(lines: list[str]) -> list[int]:
    """O(n) 预建每行所属 page meta 的起始行索引。

    返回与 lines 等长的数组，meta_idx[i] = 该行所属最近 meta 标记的行号（无则 -1）。
    替代原 find_meta_for_line 每命中一次 O(i) 反向扫描。
    """
    idx = [-1] * len(lines)
    last = -1
    for i, line in enumerate(lines):
        if parse_page_meta(line):
            last = i
        idx[i] = last
    return idx


def _meta_at(meta_idx: list[int], line_idx: int, lines: list[str] | None = None) -> PageMeta:
    """根据预建索引取出命中行的 PageMeta。"""
    if not meta_idx or line_idx >= len(meta_idx):
        return PageMeta()
    at = meta_idx[line_idx]
    if at < 0 or lines is None:
        return PageMeta()
    return parse_page_meta(lines[at]) or PageMeta()

def search_markdown(
    md_files: list[Path],
    keywords: list[str],
    round_num: int,
    context_lines: int = CONTEXT_LINES,
    max_hits_per_kw: int = 50,
    max_hits_per_file: int = 3,
    no_filter: bool = False,
) -> list[SearchHit]:
    """在所有 Markdown 文件中搜索关键词，返回命中片段（含上下文+元数据）。

    用 ripgrep (rg) 做底层全文扫描（比纯 Python 逐行正则快 10-30 倍），
    一次并集扫描拿到所有命中（文件+行号+命中的具体词），再只读取命中文件
    抽取上下文和 <!-- page --> 元数据。
    每个文件最多保留 max_hits_per_file 个命中（防止高频文件淹没其他文件），
    每个关键词全局最多 max_hits_per_kw 个命中。
    """
    if no_filter:
        valid_keywords = [kw.strip() for kw in keywords if kw.strip()]
    else:
        valid_keywords = [kw for kw in keywords if _is_valid_keyword(kw)]
    if not valid_keywords:
        return []

    # 确定搜索根目录（所有 md_files 的公共父目录）
    md_root = _common_root(md_files)

    matches = _ripgrep_matches(valid_keywords, md_root, md_files)
    # 只保留 md_files 白名单内的命中（过滤 rg 扫到但应排除的文件，如临时报告）
    md_set = {str(f) for f in md_files}
    matches = [(fp, ln, kw) for fp, ln, kw in matches if str(fp) in md_set]

    hits: list[SearchHit] = []
    seen_keys: set[str] = set()
    # 按关键词分组：matches 内部已按 (文件,行号) 升序
    per_kw: dict[str, list[tuple[Path, int, str]]] = {}
    for fpath, lineno, matched_kw in matches:
        per_kw.setdefault(matched_kw, []).append((fpath, lineno, matched_kw))

    # ── 轮询分配：保证所有文件平等获得配额 ──
    # 先每文件各取 1 条，不够 max_hits_per_kw 再取第 2 轮、第 3 轮...
    # 这样高频文件不会因为排在前面而霸占全部配额
    selected: list[tuple[Path, int, str]] = []
    for kw in valid_keywords:
        # 按文件分组该关键词的所有匹配
        per_file: dict[str, list[tuple[Path, int, str]]] = {}
        file_order: list[str] = []
        for fpath, lineno, k in per_kw.get(kw, []):
            fkey = str(fpath)
            if fkey not in per_file:
                per_file[fkey] = []
                file_order.append(fkey)
            per_file[fkey].append((fpath, lineno, k))
        # 自适应每文件上限：文件少时放宽，文件多时收紧（保证多样性）
        n_files = len(file_order)
        adaptive_cap = max(max_hits_per_file, max_hits_per_kw // max(1, n_files))
        file_idx = {fkey: 0 for fkey in file_order}
        remaining = max_hits_per_kw
        for round_i in range(adaptive_cap):
            if remaining <= 0:
                break
            for fkey in file_order:
                if remaining <= 0:
                    break
                idx = file_idx[fkey]
                matches_list = per_file[fkey]
                if idx < len(matches_list):
                    selected.append(matches_list[idx])
                    file_idx[fkey] += 1
                    remaining -= 1

    # 命中的文件统一读取一次并缓存行 + 元数据索引（避免重复读大文件）
    file_cache: dict[str, tuple[list[str], list[int]]] = {}

    for fpath, lineno, kw in selected:
        # 读取文件（带缓存），并预建页码元数据索引
        fkey = str(fpath)
        if fkey not in file_cache:
            try:
                flines = fpath.read_text(encoding="utf-8").splitlines()
            except Exception:
                file_cache[fkey] = ([], [])
                continue
            # 预计算每行所属的 page meta 索引（O(n) 一次扫完，替代原 O(i) 反向扫描）
            meta_idx = _build_meta_index(flines)
            file_cache[fkey] = (flines, meta_idx)
        flines, meta_idx = file_cache[fkey]
        if not flines:
            continue
        i = lineno - 1  # 0-based
        # 跳过行首为注释标记的命中（保留原语义）
        if i < len(flines) and flines[i].lstrip().startswith("<!--"):
            continue
        start = max(0, i - context_lines)
        end = min(len(flines), i + context_lines + 1)
        text = "\n".join(flines[start:end])
        meta = _meta_at(meta_idx, i, flines)
        hit = SearchHit(
            file_path=str(fpath),
            line_start=start + 1,
            line_end=end,
            text=text,
            meta=meta,
            matched_keyword=kw,
            round_num=round_num,
        )
        if hit.key() not in seen_keys:
            seen_keys.add(hit.key())
            hits.append(hit)

    return hits


def find_markdown_files(directory: str, exclude: list[str] | None = None) -> list[Path]:
    """递归查找目录下所有 .md 文件。

    排除：node_modules、-toc.md、rag-result-*.md、检索报告、ctrl.md 等生成文件。
    """
    root = Path(directory)
    if root.is_file() and root.suffix == ".md":
        return [root]
    default_exclude_names = ["-toc.md", "rag-result-", "检索整理", "检索报告", "ctrl.md", "endian.md", ".rag-temp-report.md"]
    default_exclude_dirs = {"node_modules", ".git", "dist"}
    if exclude:
        default_exclude_names.extend(exclude)
    files = sorted(root.rglob("*.md"))
    result = []
    for f in files:
        # 排除指定目录下的文件
        if any(part in default_exclude_dirs for part in f.parts):
            continue
        # 排除指定文件名模式
        if any(pat in f.name for pat in default_exclude_names):
            continue
        result.append(f)
    return result


# ── LLM Agent ─────────────────────────────────────────────────────────
class LLMAgent:
    """LLM 调用封装：仅做搜索规划/筛选/打分，绝不生成原文内容。"""

    def __init__(self, api_key: str, base_url: str, model: str):
        self.client = OpenAI(api_key=api_key, base_url=base_url)
        self.model = model

    def plan_keywords(self, query: str) -> list[str]:
        """第1轮：解析用户查询，拆解检索关键词。"""
        prompt = f"""你是技术文档搜索规划引擎。用户提问如下：
"{query}"

请拆解出 3-5 个精准检索关键词或短语，用于在技术文档（GPU/CUDA/FPGA/数字IC/存储系统）Markdown 仓库中全文搜索。
要求：
- **必须包含用户原始查询中的完整术语**，如"多时钟域"必须保留为"多时钟域"，不能裁剪为"时钟域"或"时钟"
- **严禁裁剪、缩短、简化用户查询中的专业术语**，每个术语必须原样保留
- 紧扣用户原始问题，不发散、不新增无关维度
- 可以补充该概念的英文原文术语和同义词（如 pipeline/pipelining、流水线/管线）
- 避免泛化词（如 "数据"、"设计"、"方法"、"相关"）
- 每个关键词至少 2 个字符
- 每个关键词单独一行，不要编号、不要解释

只输出关键词列表，每行一个："""

        resp = self.client.chat.completions.create(
            model=self.model,
            messages=[{"role": "user", "content": prompt}],
            temperature=0.1,
            max_tokens=300,
        )
        raw = resp.choices[0].message.content.strip()
        keywords = [k.strip() for k in raw.splitlines() if k.strip()]
        # 去掉可能的前缀编号
        keywords = [re.sub(r"^[\d.\-*\[\]]+\s*", "", k) for k in keywords]
        return [k for k in keywords if k]

    def judge_and_plan(
        self,
        query: str,
        current_keywords: list[str],
        hits_summary: list[str],
        round_num: int,
    ) -> tuple[bool, list[str], str]:
        """判断是否需要继续搜索 + 生成下一轮关键词。

        Returns:
            (should_continue, new_keywords, judgment)
        """
        hits_text = "\n".join(hits_summary[:30]) if hits_summary else "（无命中）"

        prompt = f"""你是搜索调度引擎。分析当前检索状态，决定是否需要下一轮搜索。

用户问题：{query}
已搜索轮次：{round_num}
已用关键词：{', '.join(current_keywords)}

当前检索到的内容摘要（片段前80字）：
{hits_text}

判断规则：
1. 当前结果是否已覆盖用户问题的核心维度？
2. 如果有明显信息缺口，生成 2-4 个新的精准检索词（必须是具体的专业术语/实体，避免泛化词如"数据""设计""方法"）
3. 如果已充分覆盖或连续无新增，停止搜索
4. 新词不能与已用关键词重复或高度相似
用 JSON 格式回复，不要输出其他内容：
{{
  "should_continue": true/false,
  "judgment": "一句话说明判断依据",
  "new_keywords": ["关键词1", "关键词2"]
}}"""

        resp = self.client.chat.completions.create(
            model=self.model,
            messages=[{"role": "user", "content": prompt}],
            temperature=0.1,
            max_tokens=400,
        )
        raw = resp.choices[0].message.content.strip()
        # 提取 JSON
        try:
            # 去掉可能的 markdown 代码块标记
            raw = re.sub(r"^```json\s*", "", raw, flags=re.MULTILINE)
            raw = re.sub(r"\s*```$", "", raw, flags=re.MULTILINE)
            data = json.loads(raw)
            should_continue = data.get("should_continue", False)
            new_keywords = data.get("new_keywords", [])
            judgment = data.get("judgment", "")
            return should_continue, new_keywords, judgment
        except (json.JSONDecodeError, KeyError):
            return False, [], "JSON解析失败，终止搜索"

    def score_and_filter(
        self, query: str, hits: list[SearchHit], batch_size: int = 50
    ) -> list[SearchHit]:
        """一次 LLM 调用同时完成相关性打分与无关片段筛选。

        合并了原 score_hits + filter_irrelevant 两步，把后处理 LLM 调用数
        减半以上（每个批次从 2 次调用降到 1 次）。

        - 精确命中用户查询词的片段（exact_match=True）直接保留、分数≥90，
          不消耗任何 LLM 调用；
        - 其余片段分批发给 LLM，每条同时返回 score(0-100) 与 relevant(bool)；
        - 仅保留 relevant=True 的片段。
        """
        if not hits:
            return hits

        # 精确命中：直接保留，分数保底 90，不走 LLM
        exact_hits = [h for h in hits if h.exact_match]
        for h in exact_hits:
            h.score = max(h.score, 90)
        candidates = [h for h in hits if not h.exact_match]
        print(f"  精确命中 {len(exact_hits)} 条（直接保留），待 LLM 评估 {len(candidates)} 条")

        if not candidates:
            return exact_hits

        kept: list[SearchHit] = list(exact_hits)
        total_batches = (len(candidates) + batch_size - 1) // batch_size
        for batch_idx in range(total_batches):
            batch_start = batch_idx * batch_size
            batch = candidates[batch_start : batch_start + batch_size]
            summaries = []
            for j, hit in enumerate(batch):
                snippet = hit.text.replace("\n", " ")[:150]
                summaries.append(f"[{j}] {snippet}")

            prompt = f"""你是相关性评估引擎。对以下检索片段同时做两件事：打分（0-100）并判断是否与用户查询相关。

用户查询："{query}"

片段列表（前150字摘要）：
{chr(10).join(summaries)}

判断规则：
- 直接讨论用户查询核心概念的片段打 60-100 分，relevant=true
- 仅顺带提及该主题、但有可能帮助理解的片段打 30-59 分，relevant=true
- 完全无关、只是碰巧含某个搜索词的片段打 0-29 分，relevant=false
- 必须为每个片段都返回结果，不能遗漏任何 index
- 仅做相关性评估，不评判内容对错

用 JSON 数组回复，必须包含全部 {len(batch)} 条，格式 [{{"index": 0, "score": 85, "relevant": true}}]："""
            try:
                resp = self.client.chat.completions.create(
                    model=self.model,
                    messages=[{"role": "user", "content": prompt}],
                    temperature=0.1,
                    max_tokens=2048,
                )
                raw = resp.choices[0].message.content.strip()
                raw = re.sub(r"^```json\s*", "", raw, flags=re.MULTILINE)
                raw = re.sub(r"\s*```$", "", raw, flags=re.MULTILINE)
                result = json.loads(raw)
                info: dict[int, tuple[int, bool]] = {}
                for item in result:
                    idx = item.get("index")
                    if idx is not None and 0 <= idx < len(batch):
                        info[idx] = (int(item.get("score", 50)), bool(item.get("relevant", True)))
                for j, hit in enumerate(batch):
                    score, relevant = info.get(j, (50, True))
                    hit.score = max(score, 10)  # 最低 10 分保底
                    if relevant:
                        kept.append(hit)
            except Exception:
                # 解析失败时保留全部（宁多勿少），分数保底 50
                for hit in batch:
                    hit.score = max(hit.score, 50)
                kept.extend(batch)

            print(f"  评估进度：{batch_idx + 1}/{total_batches} 批")

        return kept

# ── 多轮搜索主循环 ─────────────────────────────────────────────────────
def run_rag_search(
    query: str,
    md_dir: str,
    agent: LLMAgent,
    max_rounds: int = DEFAULT_MAX_ROUNDS,
) -> tuple[list[SearchHit], list[RoundLog]]:
    """执行多轮 Agentic RAG 搜索。

    Returns:
        (所有命中片段, 搜索日志列表)
    """
    md_files = find_markdown_files(md_dir)
    if not md_files:
        print(f"错误：目录 {md_dir} 下未找到 Markdown 文件")
        return [], []

    print(f"已加载 {len(md_files)} 个 Markdown 文件")

    all_hits: list[SearchHit] = []
    all_seen_keys: set[str] = set()
    round_logs: list[RoundLog] = []
    all_keywords_used: list[str] = []
    exact_search = False  # 精确命中模式：不走 LLM，放宽上限

    # ── 第1轮：先用查询词本身试搜，精确命中则跳过 LLM 拆词 ──
    query_clean = query.strip()
    print(f"\n{'='*60}")
    quick_hits = search_markdown(md_files, [query_clean], round_num=1, no_filter=True) if query_clean else []
    quick_exact = any(query_clean.lower() in h.text.lower() for h in quick_hits)
    if quick_exact:
        keywords = [query_clean]
        exact_search = True
        hits = search_markdown(md_files, [query_clean], round_num=1, no_filter=True, max_hits_per_kw=100)
        print(f"首轮直接命中查询词，跳过 LLM 关键词拆解（省 1 次调用），放宽上限至 100 条")
    else:
        # 原文无该词 → 调 LLM 拆解同义词/扩展词
        print("第1轮搜索：LLM 解析查询，拆解关键词...")
        keywords = agent.plan_keywords(query)
        # 补充原始查询本身（确保精确匹配）
        if query_clean not in keywords:
            keywords.insert(0, query_clean)
        # 限制总共最多 5 个关键词
        keywords = keywords[:5]
        hits = search_markdown(md_files, keywords, round_num=1)

    print(f"  关键词（{len(keywords)}个）：{', '.join(keywords)}")
    all_keywords_used.extend(keywords)

    new_count = 0
    for h in hits:
        if h.key() not in all_seen_keys:
            all_seen_keys.add(h.key())
            all_hits.append(h)
            new_count += 1

    hit_files = sorted(set(h.file_path for h in hits))
    log = RoundLog(
        round_num=1,
        keywords=keywords,
        hit_files=hit_files,
        new_hits_count=new_count,
        judgment=f"第1轮命中 {new_count} 个片段",
    )
    round_logs.append(log)
    print(f"  命中文件：{len(hit_files)} 个，新增片段：{new_count}")

    # ── 迭代搜索 ──
    for round_num in range(2, max_rounds + 1):
        # 第一轮命中已足够多（>10条），跳过后续轮次避免发散
        if len(all_hits) > 10:
            print(f"\n信息充足：第一轮已命中 {len(all_hits)} 条，跳过迭代搜索")
            break
        # 第一轮已精确命中用户查询词（查询被原文直接覆盖），跳过 LLM 评估与宽词扩展
        _ql = query.strip().lower()
        if any(_ql and _ql in h.text.lower() for h in all_hits):
            print(f"\n首轮已精确命中查询词，跳过迭代搜索")
            break

        print(f"\n{'='*60}")
        print(f"第{round_num}轮：LLM 评估信息缺口...")
        # 构造命中摘要给 LLM 判断
        hits_summary = [h.text[:80].replace("\n", " ") for h in all_hits]
        should_continue, new_keywords, judgment = agent.judge_and_plan(
            query, all_keywords_used, hits_summary, round_num - 1
        )

        log = RoundLog(
            round_num=round_num,
            keywords=new_keywords,
            judgment=judgment,
        )

        if not should_continue or not new_keywords:
            log.next_plan = "检索终止"
            round_logs.append(log)
            print(f"  判定：{judgment}")
            print("  检索终止")
            break

        print(f"  新关键词：{', '.join(new_keywords)}")
        print(f"  判定：{judgment}")
        all_keywords_used.extend(new_keywords)

        hits = search_markdown(md_files, new_keywords, round_num=round_num)
        new_count = 0
        for h in hits:
            if h.key() not in all_seen_keys:
                all_seen_keys.add(h.key())
                all_hits.append(h)
                new_count += 1

        hit_files = sorted(set(h.file_path for h in hits))
        log.hit_files = hit_files
        log.new_hits_count = new_count
        round_logs.append(log)
        print(f"  命中文件：{len(hit_files)} 个，新增片段：{new_count}")

        # 连续两轮无新增 -> 强制终止
        if new_count == 0:
            print("  连续无新增有效内容，提前终止搜索")
            break

    # ── 后置：合并重叠片段 ──
    all_hits = merge_overlapping_hits(all_hits)
    print(f"  合并重叠后剩余 {len(all_hits)} 条片段")

    # ── 后置：本地 term-overlap 预排序 + 截取前 20 条 ──
    # 用廉价本地相关性排序，只把最相关的少数片段交给 LLM，大幅减少 LLM 处理量与生成耗时
    query_lower = query.strip().lower()
    query_terms = [t.lower() for t in tokenize_query(query) if len(t) >= 2]
    if query_lower and query_lower not in query_terms:
        query_terms.append(query_lower)
    # 文件级频次：命中次数多的文件整体更相关（避免高频文件的单条片段被低频文件挤掉）
    from collections import Counter as _Counter
    file_freq = _Counter(h.file_path for h in all_hits)
    scored: list[tuple[SearchHit, int]] = []
    for h in all_hits:
        text_lower = h.text.lower()
        h.exact_match = query_lower in text_lower
        overlap = sum(text_lower.count(t) for t in query_terms)
        # 文件级加权：该文件总命中数的对数（防止超大文件压倒一切，但给多命中文件合理加权）
        file_boost = int(file_freq[h.file_path] ** 0.5)
        scored.append((h, overlap + file_boost))
    scored.sort(key=lambda ho: (ho[0].exact_match, ho[1]), reverse=True)
    all_hits = [h for h, _ in scored]
    CANDIDATE_CAP = 100 if exact_search else 20
    if len(all_hits) > CANDIDATE_CAP:
        print(f"  命中过多，本地预排序后截取前 {CANDIDATE_CAP} 条（原有 {len(all_hits)} 条）")
        all_hits = all_hits[:CANDIDATE_CAP]

    # ── 后置：LLM 打分 + 筛选（合并为单次调用，精确命中直接保留不走 LLM） ──
    print(f"\n{'='*60}")
    print(f"LLM 对 {len(all_hits)} 条命中片段进行相关性打分与筛选...")
    before_filter = len(all_hits)
    all_hits = agent.score_and_filter(query, all_hits)
    print(f"  保留 {len(all_hits)}/{before_filter} 条（过滤 {before_filter - len(all_hits)} 条无关结果）")

    # 最终排序：精确包含的排前面，组内按分数降序
    all_hits.sort(key=lambda h: (h.exact_match, h.score), reverse=True)

    return all_hits, round_logs


def merge_overlapping_hits(hits: list[SearchHit], overlap_threshold: int = 5) -> list[SearchHit]:
    """合并同文件中行号区间重叠的命中片段。

    如果两个片段在同一文件且行号区间差距 <= overlap_threshold，
    合并为范围更大的片段，从源文件重新读取合并后的文本。
    """
    if not hits:
        return hits

    # 缓存已读取的文件行
    file_cache: dict[str, list[str]] = {}

    def get_lines(path: str) -> list[str]:
        if path not in file_cache:
            try:
                file_cache[path] = Path(path).read_text(encoding="utf-8").splitlines()
            except Exception:
                file_cache[path] = []
        return file_cache[path]

    # 按文件分组
    by_file: dict[str, list[SearchHit]] = {}
    for h in hits:
        by_file.setdefault(h.file_path, []).append(h)

    result: list[SearchHit] = []
    for file_path, file_hits in by_file.items():
        file_hits.sort(key=lambda h: h.line_start)
        merged: list[SearchHit] = []
        for h in file_hits:
            if merged:
                prev = merged[-1]
                if h.line_start <= prev.line_end + overlap_threshold:
                    prev.line_end = max(prev.line_end, h.line_end)
                    # 保留更高分
                    if h.score > prev.score:
                        prev.score = h.score
                    # 重新读取合并后的文本
                    lines = get_lines(file_path)
                    prev.text = "\n".join(lines[prev.line_start - 1 : prev.line_end])
                    continue
            merged.append(h)
        result.extend(merged)

    return result



def _extract_keyword_preview(text: str, keywords: list[str], window: int = 120) -> str:
    """从 text 中找到第一个出现的关键词，截取关键词前后各 window/2 字的窗口。
    关键词未命中时回退为取开头 window 字。"""
    lower = text.lower()
    pos = -1
    kw_len = 0
    for kw in keywords:
        if len(kw) < 2:
            continue
        idx = lower.find(kw.lower())
        if idx >= 0:
            pos = idx
            kw_len = len(kw)
            break
    if pos < 0:
        snippet = text[:window]
        return snippet + ("..." if len(text) > window else "")
    half = window // 2
    start = max(0, pos - half)
    end = min(len(text), pos + kw_len + half)
    prefix = "..." if start > 0 else ""
    suffix = "..." if end < len(text) else ""
    return prefix + text[start:end] + suffix

# ── 报告生成 ──────────────────────────────────────────────────────────
def generate_report(
    query: str,
    hits: list[SearchHit],
    round_logs: list[RoundLog],
    output_path: str,
) -> str:
    """生成 Markdown 报告：检索结果在前，搜索路径日志在后。"""
    # 收集所有搜索关键词（从 round_logs + 原始查询），供预览截取和前端高亮使用
    search_keywords: list[str] = []
    _seen_kw: set[str] = set()
    for log in round_logs:
        for kw in log.keywords:
            if kw and kw not in _seen_kw:
                _seen_kw.add(kw)
                search_keywords.append(kw)
    if query.strip() and query.strip() not in _seen_kw:
        search_keywords.insert(0, query.strip())

    lines: list[str] = []
    # 嵌入关键词元数据（前端提取后用于高亮；HTML 注释不显示）
    lines.append(f"<!-- search-keywords: {', '.join(search_keywords)} -->\n")
    lines.append(f"# {query}检索报告\n")
    lines.append(f"> 时间：{time.strftime('%Y-%m-%d %H:%M:%S')}\n")
    # ── 搜索总结（放在最前面） ──
    if hits:
        total_rounds = len(round_logs) if round_logs else 1
        lines.append(f"\n---\n")
        lines.append("## 搜索总结\n")
        lines.append(
            f'基于您给出的关键词"{query}"，共进行了 {total_rounds} 轮次检索，'
            f"共检索出相关文章片段 {len(hits)} 段，涉及到如下的文档：\n"
        )
        # 汇总表格：文件名+章节、相关度、原文前20字
        lines.append("| 序号 | 文件名及章节位置 | 相关度 | 原文预览 |")
        lines.append("|---|---|---|---|")
        for i, hit in enumerate(hits, 1):
            file_name = hit.file_path.split("/")[-1]
            chapter = hit.meta.chapter or "—"
            # MD 链接 + PDF 链接
            file_cell = f"⟦FILE:{hit.file_path}⟧L{hit.line_start}⟧{file_name}⟦/FILE⟧"
            pdf_cell = f" ⟦PDF:{hit.file_path}⟧[PDF]⟦/PDF⟧"
            chapter_cell = chapter if len(chapter) <= 40 else chapter[:37] + "..."
            location_cell = f"{file_cell}{pdf_cell}<br>{chapter_cell}"
            # 原文预览：去 page 注释、去图片标记、换行转空格，然后围绕关键词截取窗口
            preview = re.sub(r"<!--\s*page:.*?-->", "", hit.text)
            preview = re.sub(r"!\[[^\]]*\]\([^)]*\)", "", preview)  # 去除 Markdown 图片标记
            preview = re.sub(r"<img[^>]*/?>", "", preview)  # 去除 HTML 图片标签
            preview = re.sub(r"[\r\n\t]+", " ", preview)  # 换行/制表符 → 单个空格
            preview = re.sub(r" {2,}", " ", preview).strip()
            if not preview:
                preview = "（纯图片片段，无文字预览）"
            else:
                preview = _extract_keyword_preview(preview, search_keywords, window=120)
            preview = preview.replace("|", "\\|")
            lines.append(f"| {i} | {location_cell} | {hit.score}% | {preview} |")
        lines.append("\n以下是详细情况。\n")

    # ── 检索结果（详细，在总结之后） ──
    lines.append(f"\n---\n")
    lines.append("## 检索结果\n")

    if not hits:
        lines.append("> 多轮检索完成，未在 Markdown 仓库中查询到相关原文内容。\n")
    else:
        for i, hit in enumerate(hits, 1):
            lines.append(f"### 【{i}】原文摘抄\n")
            # 原文内容直接作为 Markdown 渲染（不包裹在代码块中）
            # 去掉原文中的 page 注释行（避免重复显示元数据）
            clean_text = re.sub(r"<!--\s*page:.*?-->", "", hit.text).strip()
            lines.append(clean_text + "\n")
            # 元信息放在引用块中
            meta_parts = []
            if hit.meta.chapter:
                meta_parts.append(f"具体章节：{hit.meta.chapter}")
            if hit.meta.page:
                meta_parts.append(f"page: {hit.meta.page}")
            pdf_name = hit.file_path.split("/")[-1].replace(".md", "")
            lines.append(f"> 相关性：**{hit.score}%** | 轮次：第 {hit.round_num} 轮 | 命中词：`{hit.matched_keyword}` | 行号：L{hit.line_start}-{hit.line_end}\n")
            lines.append(f"> MD文件：⟦FILE:{hit.file_path}⟧L{hit.line_start}⟧{hit.file_path.split('/')[-1]}⟦/FILE⟧ | PDF文件：⟦PDF:{hit.file_path}⟧{pdf_name}.pdf⟦/PDF⟧\n")
            if meta_parts:
                lines.append(f"> {' | '.join(meta_parts)}\n")
            else:
                lines.append(f"> {hit.meta}\n")

    # ── 多轮搜索路径日志（放在最后） ──
    lines.append(f"\n---\n")
    lines.append("## 多轮搜索路径日志\n")

    for log in round_logs:
        lines.append(f"### 第 {log.round_num} 轮搜索\n")
        lines.append(f"- **检索关键词**：{', '.join(log.keywords)}")
        if log.hit_files:
            short_files = [
                f if len(f) <= 60 else "..." + f[-57:]
                for f in log.hit_files
            ]
            lines.append(f"- **命中文件**：{', '.join(short_files)}")
        lines.append(f"- **新增片段数**：{log.new_hits_count}")
        lines.append(f"- **检索判定**：{log.judgment}")
        if log.next_plan:
            lines.append(f"- **下一步**：{log.next_plan}")
        lines.append("")

    lines.append(f"\n---\n")
    lines.append(f"*共 {len(hits)} 条检索结果，{len(round_logs)} 轮搜索。*\n")

    content = "\n".join(lines)
    Path(output_path).write_text(content, encoding="utf-8")
    return output_path


# ── CLI 主入口 ────────────────────────────────────────────────────────
def main() -> None:
    ap = argparse.ArgumentParser(
        description="零幻觉 Agentic RAG — Markdown 仓库多轮检索",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""示例:
  python rag_search.py -q "Data Pipeline" -d ~/pymupdftest
  python rag_search.py -d ~/docs          # 交互模式
""",
    )
    ap.add_argument("-q", "--query", help="搜索查询（不指定则进入交互模式）")
    ap.add_argument("-d", "--dir", default=".", help="Markdown 仓库目录（默认当前目录）")
    ap.add_argument("-o", "--output", help="输出报告路径（默认 rag-result-<时间戳>.md）")
    ap.add_argument(
        "--max-rounds", type=int, default=DEFAULT_MAX_ROUNDS, help=f"最大搜索轮次（默认 {DEFAULT_MAX_ROUNDS}）"
    )
    ap.add_argument("--model", default=DEFAULT_MODEL, help=f"LLM 模型名（默认 {DEFAULT_MODEL}）")
    ap.add_argument("--api-key", default=None, help="智谱 API Key（默认环境变量或内置）")
    ap.add_argument("--base-url", default=None, help="API 地址（默认智谱）")
    args = ap.parse_args()

    # API 配置
    api_key = args.api_key or os.environ.get("ZHIPU_API_KEY") or DEFAULT_API_KEY
    base_url = args.base_url or os.environ.get("ZHIPU_BASE_URL") or DEFAULT_BASE_URL

    agent = LLMAgent(api_key=api_key, base_url=base_url, model=args.model)

    # 查询来源
    query = args.query
    if not query:
        print("=" * 60)
        print("  零幻觉 Agentic RAG — Markdown 仓库多轮检索")
        print("  输入查询后按回车，输入 q 退出")
        print("=" * 60)
        while True:
            try:
                query = input("\n🔍 请输入查询: ").strip()
            except (EOFError, KeyboardInterrupt):
                print("\n再见。")
                return
            if query.lower() in ("q", "quit", "exit"):
                print("再见。")
                return
            if query:
                break
            print("查询不能为空。")

    # 执行搜索
    output = args.output or f"rag-result-{time.strftime('%Y%m%d-%H%M%S')}.md"
    print(f"\n查询：{query}")
    print(f"目录：{args.dir}")
    print(f"输出：{output}")
    print(f"模型：{args.model}")
    print(f"最大轮次：{args.max_rounds}")

    t0 = time.time()
    hits, logs = run_rag_search(query, args.dir, agent, args.max_rounds)
    elapsed = time.time() - t0

    # 生成报告
    generate_report(query, hits, logs, output)
    print(f"\n{'='*60}")
    print(f"✅ 完成！耗时 {elapsed:.1f}s，{len(hits)} 条结果，{len(logs)} 轮搜索")
    print(f"📄 报告已写入：{output}")

    # 交互模式：继续下一轮查询
    if not args.query:
        while True:
            try:
                query = input("\n🔍 继续查询（q 退出）: ").strip()
            except (EOFError, KeyboardInterrupt):
                print("\n再见。")
                return
            if query.lower() in ("q", "quit", "exit"):
                print("再见。")
                return
            if not query:
                continue
            output = f"rag-result-{time.strftime('%Y%m%d-%H%M%S')}.md"
            t0 = time.time()
            hits, logs = run_rag_search(query, args.dir, agent, args.max_rounds)
            elapsed = time.time() - t0
            generate_report(query, hits, logs, output)
            print(f"\n✅ 完成！耗时 {elapsed:.1f}s，报告：{output}")


if __name__ == "__main__":
    main()
