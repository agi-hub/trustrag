import express from 'express';
import https from 'https';
import http from 'http';
import cors from 'cors';
import { spawn } from 'child_process';
import { readFileSync, existsSync, readdirSync, statSync } from 'fs';
import { join, dirname, resolve as resolvePath } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3001;

// Markdown 仓库根目录（默认为 pymupdftest 目录）
const MD_ROOT = process.env.MD_ROOT || resolvePath(__dirname, '..');

// 加载配置文件
const configPath = join(__dirname, 'config.json');
let ragConfig = { api_key: '', base_url: 'https://open.bigmodel.cn/api/paas/v4/', model: 'glm-4-flash' };
if (existsSync(configPath)) {
  try { ragConfig = JSON.parse(readFileSync(configPath, 'utf-8')); } catch (e) {}
}

app.use(cors());
app.use(express.json({ limit: '50mb' }));
// 递归查找所有 images/ 目录，注册为 /images 静态路由
import { existsSync as _exists, readdirSync as _readdir, statSync as _stat } from 'fs';
function findImageDirs(dir, base = dir) {
  const results = [];
  try {
    for (const entry of _readdir(dir)) {
      if (entry === 'node_modules' || entry === '.git' || entry === 'dist') continue;
      const fullPath = join(dir, entry);
      if (_stat(fullPath).isDirectory()) {
        if (entry === 'images') {
          results.push(fullPath);
        } else {
          results.push(...findImageDirs(fullPath, base));
        }
      }
    }
  } catch (e) {}
  return results;
}
const imageDirs = findImageDirs(MD_ROOT);
for (const imgDir of imageDirs) {
  app.use('/images', express.static(imgDir));
}
if (imageDirs.length > 0) {
  console.log(`已注册 ${imageDirs.length} 个图片目录: ${imageDirs.map(d => d.replace(MD_ROOT, '.')).join(', ')}`);
}

// 服务 PDF 文件（source/ 与 KB/ 同构，整棵树挂到 /pdf 路由下）
const SOURCE_ROOT = join(resolvePath(__dirname, '..'), 'source');
if (existsSync(SOURCE_ROOT)) {
  app.use('/pdf', express.static(SOURCE_ROOT));
}

// ── 搜索 API：通过 SSE 流式返回搜索进度，最终返回完整报告 ──
app.post('/api/search', (req, res) => {
  const { query, maxRounds = 3, model = 'glm-4-flash' } = req.body;

  if (!query || !query.trim()) {
    return res.status(400).json({ error: '查询不能为空' });
  }

  // SSE headers
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });

  const ragScript = join(__dirname, '..', 'rag_search.py');

  // 调用 rag_search.py，捕获 stdout 的实时输出
  const proc = spawn('python3', [
    ragScript, '-q', query,
    '-d', MD_ROOT,
    '-o', join(MD_ROOT, '.rag-temp-report.md'),
    '--max-rounds', String(maxRounds),
    '--model', model,
  ], {
    cwd: MD_ROOT,
    env: { ...process.env, PYTHONUNBUFFERED: '1' },
  });

  let fullOutput = '';

  // 实时解析 stdout，提取搜索状态推送给前端
  const lineBuffer = [];
  proc.stdout.on('data', (chunk) => {
    const text = chunk.toString();
    fullOutput += text;
    const lines = text.split('\n');

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      // 解析搜索进度
      let m;
      // "第1轮搜索：..." 或 "第2轮：LLM 评估..."
      if (m = trimmed.match(/第(\d+)轮/)) {
        sendSSE(res, { type: 'round', round: parseInt(m[1]) });
      }
      // "  关键词：xxx" / "  关键词（N个）：xxx" / "  新关键词：xxx"
      else if (m = trimmed.match(/^(?:新)?关键词(?:[（(]\d+个[）)])?[：:](.+)$/)) {
        const keywords = m[1].split(',').map(k => k.trim());
        sendSSE(res, { type: 'keywords', keywords });
      }
      // "  命中文件：N 个，新增片段：M"
      else if (m = trimmed.match(/新增片段[：:]\s*(\d+)/)) {
        sendSSE(res, { type: 'hits', count: parseInt(m[1]) });
      }
      // "  判定：xxx"
      else if (m = trimmed.match(/判定[：:]\s*(.+)/)) {
        sendSSE(res, { type: 'judgment', text: m[1] });
      }
      else if (trimmed.includes('检索终止') || trimmed.includes('提前终止')) {
        sendSSE(res, { type: 'done' });
      }
      // "✅ 完成！耗时 X.Xs，N 条结果，M 轮搜索"
      else if (m = trimmed.match(/完成.*?(\d+)\s*条结果.*?(\d+)\s*轮搜索/)) {
        sendSSE(res, { type: 'complete', hits: parseInt(m[1]), rounds: parseInt(m[2]) });
      }
    }
  });

  proc.stderr.on('data', (chunk) => {
    // 忽略 stderr（jieba 警告等）
  });

  proc.on('close', (code) => {
    // 读取生成的报告
    const reportPath = join(MD_ROOT, '.rag-temp-report.md');
    try {
      if (existsSync(reportPath)) {
        const report = readFileSync(reportPath, 'utf-8');
        sendSSE(res, { type: 'report', markdown: report });
      }
    } catch (e) {
      // ignore
    }
    sendSSE(res, { type: 'end', code });
    res.end();
  });

  proc.on('error', (err) => {
    sendSSE(res, { type: 'error', message: err.message });
    res.end();
  });
});

// ── 获取源 Markdown 文件内容（用于点击链接跳转到原文位置） ──
app.post('/api/source', (req, res) => {
  const { filePath, lineStart, lineEnd } = req.body;

  if (!filePath || !existsSync(filePath)) {
    return res.status(404).json({ error: '文件不存在' });
  }

  try {
    const content = readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');
    const start = Math.max(0, (lineStart || 1) - 1);
    const end = Math.min(lines.length, lineEnd || start + 20);

    // 找到对应行附近的最近 page 标记
    let pageMeta = '';
    for (let i = start; i >= 0; i--) {
      const m = lines[i].match(/<!--\s*page:.*?-->/);
      if (m) { pageMeta = m[0]; break; }
    }

    // 返回前后 15 行的上下文
    const contextStart = Math.max(0, start - 5);
    const contextEnd = Math.min(lines.length, end + 15);
    const snippet = lines.slice(contextStart, contextEnd).join('\n');

    res.json({
      snippet,
      lineStart: contextStart + 1,
      lineEnd: contextEnd,
      targetLine: start + 1,
      pageMeta,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── 获取完整 Markdown 文件内容（用于在新标签页预览） ──
app.post('/api/file', (req, res) => {
  const { filePath } = req.body;
  if (!filePath || !existsSync(filePath)) {
    return res.status(404).json({ error: '文件不存在' });
  }
  try {
    const content = readFileSync(filePath, 'utf-8');
    res.json({ content, filePath, fileName: filePath.split('/').pop() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── 查找 MD 文件对应的 PDF（KB/source 目录映射） ──
// KB 结构：.../{base}/{base}.md（每篇文档有独立子文件夹，放 md+images）
// source 结构：.../{base}.pdf（PDF 直接在父目录，无独立子文件夹）
app.post('/api/find-pdf', (req, res) => {
  const { mdPath } = req.body;
  if (!mdPath) return res.status(400).json({ error: '缺少 mdPath' });

  const sourceRoot = join(resolvePath(__dirname, '..'), 'source');
  const kbSeg = mdPath.lastIndexOf('/KB/');
  if (kbSeg < 0) return res.json({ found: false });

  const relPath = mdPath.slice(kbSeg + 4);           // HotChips/.../{base}/{base}.md
  const baseName = relPath.split('/').pop().replace(/\.md$/i, '');  // {base}
  const parentName = relPath.split('/').slice(-2, -1)[0] || '';     // {base} 或其他

  // 候选路径（按优先级）：
  // 1) per-doc 模式：source/.../{base}.pdf（去掉 per-doc 子文件夹层）
  // 2) 直接替换：source/.../{base}/{base}.pdf（目录结构完全一致的兜底）
  const dirs = relPath.split('/').slice(0, -2);      // 去掉 {base}/ 和 {base}.md
  const grandparentRel = dirs.join('/');
  const candidates = [];
  if (parentName === baseName) {
    candidates.push(join(sourceRoot, grandparentRel, baseName + '.pdf'));
    candidates.push(join(sourceRoot, grandparentRel, parentName, baseName + '.pdf'));
  } else {
    candidates.push(join(sourceRoot, grandparentRel, parentName, baseName + '.pdf'));
    candidates.push(join(sourceRoot, grandparentRel, baseName + '.pdf'));
  }

  const pdfPath = candidates.find(p => existsSync(p));
  if (pdfPath) {
    const pdfName = pdfPath.split('/').pop();
    const relUnderSource = pdfPath.startsWith(sourceRoot + '/')
      ? pdfPath.slice(sourceRoot.length + 1)
      : pdfName;
    res.json({ found: true, pdfName, url: `pdf/${relUnderSource.split('/').map(encodeURIComponent).join('/')}` });
  } else {
    res.json({ found: false });
  }
});
// ── AI 整理总结 API ──
// 内容匹配辅助：从文本中提取关键词（英文词 + 中文2-gram）
function _extractTokens(text) {
  const tokens = [];
  const enWords = text.match(/[a-zA-Z]{3,}/g) || [];
  tokens.push(...enWords.map(w => w.toLowerCase()));
  const cjk = text.match(/[\u4e00-\u9fff]+/g) || [];
  for (const seg of cjk) {
    for (let i = 0; i <= seg.length - 2; i++) tokens.push(seg.substring(i, i + 2));
  }
  return tokens;
}

// 内容匹配：按上下文关键词找到最佳匹配的源片段（不依赖 LLM 的编号正确性）
function _matchSnippet(context, snippets) {
  if (!snippets.length) return null;
  const tokens = _extractTokens(context);
  if (!tokens.length) return snippets[0];
  let bestScore = 0, bestSnip = null;
  for (const snip of snippets) {
    const lower = snip.text.toLowerCase();
    let score = 0;
    for (const w of tokens) { if (lower.includes(w)) score++; }
    if (score > bestScore) { bestScore = score; bestSnip = snip; }
  }
  return bestSnip || snippets[0];
}

app.post('/api/summarize', async (req, res) => {
  const { query, reportMd } = req.body;
  if (!reportMd || !reportMd.trim()) {
    return res.status(400).json({ error: '报告内容为空' });
  }
  const apiKey = process.env.ZHIPU_API_KEY || ragConfig.api_key;
  const baseUrl = ragConfig.base_url;
  const model = process.env.RAG_MODEL || ragConfig.model;

  // ── 解析源文件片段：从 reportMd 的 ### 【N】原文摘抄 块提取文本和位置 ──
  const sourceSnippets = [];
  const blockRe = /### 【(\d+)】原文摘抄\s*\n([\s\S]*?)\n>\s*相关性[\s\S]*?⟦FILE:(.+?)⟧L(\d+)⟧(.+?)⟦\/FILE⟧/g;
  let bm;
  while ((bm = blockRe.exec(reportMd)) !== null) {
    sourceSnippets.push({
      n: parseInt(bm[1]), text: bm[2].trim(),
      path: bm[3], line: parseInt(bm[4]), name: bm[5],
    });
  }

  // ── 给 LLM 的源文本：去掉标记，保留 【N】 编号 ──
  const llmSource = reportMd
    .replace(/<!--\s*search-keywords:.*?-->/g, '')
    .replace(/⟦PDF:.+?⟧.+?⟦\/PDF⟧/g, '')
    .replace(/\s*\|\s*PDF文件：\s*/g, '')
    .replace(/⟦FILE:.+?⟧L\d+⟧.+?⟦\/FILE⟧/g, '（见原文）');

  const prompt = `你是技术文献分析助手。以下是基于查询"${query}"的检索结果（原文摘抄），请基于这些内容生成一份结构化总结报告。

【刚性红线 — 违反即为严重错误】
1. 所有论据必须出自下方检索结果原文，严禁使用任何外部知识、推理、补全或发挥
2. 每个核心结论必须引用原文出处，标注格式：[引用N]，N 为原文中的【N】编号
3. 禁止臆测、推断、融合原文中未明确陈述的信息
4. 如原文不足以回答某方面问题，必须如实标注，不得编造

【输出格式】
## 总结报告
(2-4段总结性文字，每段核心观点后标注[引用N])

## 附录

### 表1：核心观点与原文对照
| 序号 | 核心观点 | 原文摘录 | 出处 |
|---|---|---|---|
| 1 | ... | 原文前30字... | [引用N] |

### 表2：未能明确回答或可能不准确的观点
| 序号 | 问题/观点 | 说明 | 相关度 |
|---|---|---|---|
| 1 | ... | 原文未充分覆盖... | 低/中 |

注意：不要自行生成引用列表，系统会自动生成。

---
以下是检索结果原文：

${llmSource}`;

  try {
    const body = JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.1,
      max_tokens: 4096,
    });
    const resp = await httpPostJson(
      `${baseUrl}chat/completions`,
      { 'Authorization': `Bearer ${apiKey}` },
      body
    );
    const data = resp.json();
    let summary = data.choices?.[0]?.message?.content || '';

    // ── 后处理 ──
    // 1) 去掉 LLM 可能生成的引用列表
    summary = summary.replace(/\n#{0,6}\s*引用列表[\s\S]*$/m, '');

    // 2) 内容匹配：对每个 [引用N]，按上下文关键词匹配到正确的源片段（不依赖编号正确性）
    const original = summary;  // replace 回调中的 offset 指向原始字符串
    const citationOrder = [];  // 按首次出现顺序排列的去重引用
    const citationSeen = new Set();

    summary = summary.replace(/\[(?:引用)?(\d{1,2})\]/g, (_match, _num, offset) => {
      const context = original.substring(Math.max(0, offset - 150), Math.min(original.length, offset + 30));
      const best = _matchSnippet(context, sourceSnippets);
      if (best) {
        const key = best.path + ':' + best.line;
        if (!citationSeen.has(key)) {
          citationSeen.add(key);
          citationOrder.push(best);
        }
        const seqN = citationOrder.findIndex(c => c.path === best.path && c.line === best.line) + 1;
        return `⟦FILE:${best.path}⟧L${best.line}⟧[引用${seqN}]⟦/FILE⟧`;
      }
      return _match;
    });

    // 3) 自动生成干净的引用列表（仅含正文实际引用的，按出现顺序编号）
    if (citationOrder.length) {
      let refList = '\n\n---\n\n### 引用列表\n';
      citationOrder.forEach((ref, i) => {
        refList += `- ⟦FILE:${ref.path}⟧L${ref.line}⟧[引用${i + 1}] ${ref.name}⟦/FILE⟧ ⟦PDF:${ref.path}⟧[PDF]⟦/PDF⟧\n`;
      });
      summary += refList;
    }
    res.json({ summary });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── 获取文件列表 ──

app.get('/api/files', (req, res) => {
  const files = [];
  function scanDir(dir) {
    try {
      const entries = readdirSync(dir);
      for (const entry of entries) {
        const fullPath = join(dir, entry);
        const stat = statSync(fullPath);
        if (stat.isDirectory() && !entry.startsWith('.') && entry !== 'node_modules') {
          scanDir(fullPath);
        } else if (entry.endsWith('.md') && !entry.endsWith('-toc.md') && !entry.startsWith('rag-result') && !entry.includes('检索')) {
          files.push({ path: fullPath, name: entry, size: stat.size });
        }
      }
    } catch (e) { }
  }
  scanDir(MD_ROOT);
  res.json(files);
});

// ── 服务前端静态文件 ──
const distPath = join(__dirname, 'dist');
// /trustrag/assets/... 需要映射到 dist/assets/...
app.use('/trustrag', express.static(distPath));
app.use(express.static(distPath));
// 根路径重定向到 /trustrag/
app.get('/', (req, res) => {
  res.redirect('/trustrag/');
});
// SPA fallback：/trustrag/ 下的非资源路径返回 index.html
app.get('/trustrag/', (req, res) => {
  res.sendFile(join(distPath, 'index.html'));
});
app.get('/trustrag/{*splat}', (req, res) => {
  const filePath = join(distPath, req.params.splat);
  // 如果请求的是实际存在的文件，直接返回；否则返回 index.html（SPA 路由）
  if (existsSync(filePath)) {
    res.sendFile(filePath);
  } else {
    res.sendFile(join(distPath, 'index.html'));
  }
});

function sendSSE(res, data) {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

// 用内置 https/http 模块发 JSON POST（兼容 Node 17，无 fetch/node-fetch 依赖）
function httpPostJson(urlStr, headers, body) {
  return new Promise((resolve, reject) => {
    const lib = urlStr.startsWith('https') ? https : http;
    const u = new URL(urlStr);
    const req = lib.request({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (resp) => {
      let data = '';
      resp.on('data', (chunk) => { data += chunk; });
      resp.on('end', () => {
        try { resolve({ ok: resp.statusCode >= 200 && resp.statusCode < 300, status: resp.statusCode, json: () => JSON.parse(data) }); }
        catch (e) { reject(new Error(`JSON 解析失败 (${resp.statusCode}): ${data.slice(0, 200)}`)); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

app.listen(PORT, () => {
  console.log(`RAG 搜索服务已启动: http://localhost:${PORT}`);
});
