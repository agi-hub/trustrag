import express from 'express';
import https from 'https';
import http from 'http';
import cors from 'cors';
import { StringDecoder } from 'string_decoder';
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

app.post('/api/summarize', (req, res) => {
  const { query, reportMd } = req.body;
  if (!reportMd || !reportMd.trim()) {
    return res.status(400).json({ error: '报告内容为空' });
  }
  // 与 rag_search.py 一致：config.json 为配置真源，环境变量仅兜底；
  // base_url 统一补尾斜杠（openai SDK 自动容错，此处手拼 URL 必须自带）
  const apiKey = ragConfig.api_key || process.env.ZHIPU_API_KEY;
  const baseUrl = (ragConfig.base_url || process.env.ZHIPU_BASE_URL || 'https://open.bigmodel.cn/api/paas/v4/').replace(/\/?$/, '/');
  const model = ragConfig.model || process.env.RAG_MODEL || 'glm-4-flash';

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

  const prompt = `你是技术文献整理助手。请阅读下面的检索结果摘抄，把其中的核心观点分类整理成一份报告。

整理要求：
1. 只使用检索结果中的信息，禁止编造或补充任何摘抄之外的内容。
2. 第一行输出标题"## 观点整理"，随后按主题分类：每个分类用一行"### 分类名"作小标题，分类下面逐条列出该主题的观点，每条观点占一行，行首用"- "。
3. 覆盖检索结果中的全部核心观点，一条都不遗漏；摘抄里有多少个观点就整理多少条。
4. 忠实呈现原文表述，不要压缩、合并或过度概括；保留原文的关键数据与术语（芯片型号、带宽数值、容量、倍数、技术名称）。
5. 每条观点的句末标注来源编号：方括号加数字，编号取自摘抄中的【数字】，例如：……显著缩短了首token时延[3]。一条观点可标多个编号，如[2][5]。禁止把编号放在句首，禁止输出"[编号]""[引用N]"这类占位文字。
6. 只写技术内容本身，禁止出现"在检索过程中""摘抄显示""本文分析了"这类描述检索行为或自指的话。
7. 除标题、分类名和观点条目外，不要输出任何其他文字。

检索结果摘抄：

${llmSource}`;

  // ── SSE 流式响应头 ──
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });

  // ── 引用后处理函数（流结束后调用） ──
  function postProcessCitations(rawText) {
    let summary = rawText;
    // 0) 清理 LLM 原样照抄的占位符（小模型会发明各种写法：[引用N]/[编号]/[源引12]…）
    summary = summary.replace(
      /\s*\[(?:引用|源引|来源|引证|编号|ref|cite)\s*(?:N|n|#|编号|\d+)?\s*\]/gi,
      ''
    );
    // 剥掉正文开头的检索元话语（标题行之后，如"在检索过程中，重点关注了……，"）
    summary = summary.replace(
      /(^##[^\n]*\n+)(?:在)?(?:检索|搜索)(?:过程中|结果中)[^。\n]{0,60}?[,，]/,
      '$1'
    );
    // 1) 去掉 LLM 自行生成的引用列表/参考文献区（系统会自动生成干净的版本）
    summary = summary.replace(/\n#{0,6}\s*(?:参考文献|引用列表|参考来源|来源列表)[^\n]*[\s\S]*$/i, '');
    // 1.5) 分类主题行（- **xxx**）上的引用编号移除：主题行不承担引用，引用归观点行
    summary = summary.replace(/^(\s*-\s*\*\*[^*]+\*\*)\s*\[(?:引用\s*)?\d[\d\s,]*\]\s*$/gm, '$1');
    const original = summary;

    // 2) 内容匹配：对每个 [引用N]，按上下文关键词匹配到正确的源片段
    const citationOrder = [];
    const citationSeen = new Set();

    summary = summary.replace(/\[(?:引用\s*)?(\d[\d\s,]*)\]/g, (_match, numsStr, offset) => {
      const nums = numsStr.match(/\d+/g) || [];
      const context = original.substring(Math.max(0, offset - 150), Math.min(original.length, offset + 30));
      const parts = [];
      for (const num of nums) {
        let best = sourceSnippets.find(s => s.n === parseInt(num));
        if (!best) best = _matchSnippet(context, sourceSnippets);
        if (best) {
          const key = best.path + ':' + best.line;
          if (!citationSeen.has(key)) {
            citationSeen.add(key);
            citationOrder.push(best);
          }
          const seqN = citationOrder.findIndex(c => c.path === best.path && c.line === best.line) + 1;
          parts.push(`⟦FILE:${best.path}⟧L${best.line}⟧[引用${seqN}]⟦/FILE⟧`);
        }
      }
      return parts.length ? parts.join(', ') : _match;
    });

    // 2.5) 兜底：小模型常漏标来源编号——观点行若没有任何引用角标，按内容匹配自动补一条
    summary = summary.split('\n').map(line => {
      const t = line.trim();
      if (!t || t.length < 15) return line;                 // 空行/标题/主题短语不补
      if (t.startsWith('#') || t.startsWith('---')) return line;
      if (/^-\s*\*\*/.test(t)) return line;                 // 分类主题行不补
      if (line.includes('⟦FILE:')) return line;             // 已有角标
      const best = _matchSnippet(line, sourceSnippets);
      if (!best) return line;
      const key = best.path + ':' + best.line;
      if (!citationSeen.has(key)) {
        citationSeen.add(key);
        citationOrder.push(best);
      }
      const seqN = citationOrder.findIndex(c => c.path === best.path && c.line === best.line) + 1;
      return `${line}⟦FILE:${best.path}⟧L${best.line}⟧[引用${seqN}]⟦/FILE⟧`;
    }).join('\n');

    // 3) 自动生成干净的引用列表
    if (citationOrder.length) {
      let refList = '\n\n---\n\n### 引用列表\n';
      citationOrder.forEach((ref, i) => {
        refList += `- ⟦FILE:${ref.path}⟧L${ref.line}⟧[引用${i + 1}] ${ref.name}⟦/FILE⟧ ⟦PDF:${ref.path}⟧[PDF]⟦/PDF⟧\n`;
      });
      summary += refList;
    }
    return summary;
  }

  // ── 流式调用智谱 API ──
  const reqBody = JSON.stringify({
    model,
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.1,
    max_tokens: 4096,
    stream: true,
  });

  const lib = baseUrl.startsWith('https') ? https : http;
  const u = new URL(`${baseUrl}chat/completions`);
  const zhipuReq = lib.request({
    hostname: u.hostname,
    port: u.port || (u.protocol === 'https:' ? 443 : 80),
    path: u.pathname + u.search,
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(reqBody),
    },
  }, (zhipuResp) => {
    if (zhipuResp.statusCode !== 200) {
      let errBody = '';
      zhipuResp.on('data', c => errBody += c);
      zhipuResp.on('end', () => {
        sendSSE(res, { type: 'error', error: `LLM API错误 ${zhipuResp.statusCode}: ${errBody.slice(0, 200)}` });
        res.end();
      });
      return;
    }

    let buf = '';
    let fullText = '';
    let pendingFlush = '';

    const utf8Decoder = new StringDecoder('utf-8');
    zhipuResp.on('data', (chunk) => {
      buf += utf8Decoder.write(chunk);
      const lines = buf.split('\n');
      buf = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data: ')) continue;
        const payload = trimmed.slice(6);
        if (payload === '[DONE]') continue;
        try {
          const parsed = JSON.parse(payload);
          const delta = parsed.choices?.[0]?.delta?.content;
          if (delta) {
            fullText += delta;
            pendingFlush += delta;
            // 每累积约 10 个字符就推送给前端
            if (pendingFlush.length >= 10) {
              sendSSE(res, { type: 'chunk', text: pendingFlush });
              pendingFlush = '';
            }
          }
        } catch (e) { /* 忽略解析失败的行 */ }
      }
    });

    zhipuResp.on('end', () => {
      // flush UTF-8 decoder 剩余字节
      buf += utf8Decoder.end();
      // 处理 buffer 中残留的最后一行
      if (buf.trim().startsWith('data: ')) {
        const payload = buf.trim().slice(6);
        if (payload !== '[DONE]') {
          try {
            const parsed = JSON.parse(payload);
            const delta = parsed.choices?.[0]?.delta?.content;
            if (delta) { fullText += delta; pendingFlush += delta; }
          } catch (e) { }
        }
      }
      // 推送最后不足 10 字的残余
      if (pendingFlush) {
        sendSSE(res, { type: 'chunk', text: pendingFlush });
        pendingFlush = '';
      }
      // 后处理引用 → 发送最终版
      try {
        const finalSummary = postProcessCitations(fullText);
        sendSSE(res, { type: 'done', summary: finalSummary });
      } catch (e) {
        sendSSE(res, { type: 'error', error: '引用后处理失败: ' + e.message });
      }
      res.end();
    });

    zhipuResp.on('error', (e) => {
      sendSSE(res, { type: 'error', error: e.message });
      res.end();
    });
  });

  zhipuReq.on('error', (e) => {
    sendSSE(res, { type: 'error', error: e.message });
    res.end();
  });

  zhipuReq.write(reqBody);
  zhipuReq.end();
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
