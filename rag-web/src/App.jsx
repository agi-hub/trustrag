import { useState, useRef, useEffect, useCallback } from 'react';
import { renderMarkdown, renderMermaidBlocks } from './utils/markdownRenderer';
import { exportToWord } from './utils/exportUtils';
import './App.css';

function App() {
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [processing, setProcessing] = useState(false); // 打分/过滤/生成报告阶段
  const [rounds, setRounds] = useState([]);

  // ── 标签页系统 ──
  // 每个 tab: { id, title, type: 'report'|'file', md, html, filePath?, targetLine? }
  const [tabs, setTabs] = useState([]);
  const [activeTabId, setActiveTabId] = useState(null);
  const [editorVisible, setEditorVisible] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [summarizing, setSummarizing] = useState(false);
  const previewRefs = useRef({}); // tabId -> preview div ref
  const tabCounter = useRef(0);

  const activeTab = tabs.find(t => t.id === activeTabId);

  // ── 创建新标签页 ──
  const openTab = useCallback((tab) => {
    const id = `tab-${tabCounter.current++}`;
    const newTab = { id, ...tab };
    setTabs(prev => [...prev, newTab]);
    setActiveTabId(id);
    return id;
  }, []);

  // ── 关闭标签页 ──
  const closeTab = useCallback((id, e) => {
    e?.stopPropagation();
    setTabs(prev => {
      const idx = prev.findIndex(t => t.id === id);
      const next = prev.filter(t => t.id !== id);
      // 如果关闭的是当前激活的标签，切换到相邻标签
      if (id === activeTabId && next.length > 0) {
        const newIdx = Math.min(idx, next.length - 1);
        setActiveTabId(next[newIdx].id);
      } else if (next.length === 0) {
        setActiveTabId(null);
      }
      return next;
    });
  }, [activeTabId]);

  // ── 执行搜索 ──
  const handleSearch = useCallback(async () => {
    if (!query.trim() || searching) return;
    setSearching(true);
    setProcessing(false);

    try {
      const resp = await fetch('api/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: query.trim() }),
      });

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let reportMd = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try {
            const data = JSON.parse(line.slice(6));
            handleSSEEvent(data, setRounds);
            if (data.type === 'complete') {
              // 搜索完成，进入整理阶段
              setSearching(false);
              setProcessing(true);
            }
            if (data.type === 'report') {
              reportMd = data.markdown;
            }
          } catch (e) { }
        }
      }

      // 搜索完成，打开报告标签页
      if (reportMd) {
        openTab({
          title: `🔍 ${query.trim()}`,
          type: 'report',
          md: reportMd,
          html: renderReportHtml(reportMd),
        });
      }
    } catch (err) {
      console.error('搜索失败:', err);
    } finally {
      setSearching(false);
      setProcessing(false);
    }
  }, [query, searching, openTab]);

  // ── 渲染报告 HTML（page 注释 → 可点击标签，文件路径 → 可点击超链接） ──
  const renderReportHtml = (md) => {
    let metaId = 0;
    const processed = md.replace(/<!--\s*page:\s*(.*?)-->/g, () => `⟦PM:${metaId++}⟧`);
    let html = renderMarkdown(processed);
    // page 注释 → 可点击标签
    html = html.replace(/⟦PM:(\d+)⟧/g, (match, id) => {
      const matches = [...md.matchAll(/<!--\s*page:\s*(.*?)-->/g)];
      const content = matches[id] ? matches[id][1].trim() : '';
      return `<span class="page-meta-link" data-meta-id="${id}">📄 ${content}</span>`;
    });
    // 文件路径 → 可点击超链接
    html = html.replace(/文件路径[：:]\s*<code>(.+?\.md)<\/code>/g, (match, path) => {
      return `文件路径：<a class="file-path-link" data-file-path="${escapeAttr(path)}">${path.split('/').pop()}</a>`;
    });
    // 具体章节 → 带 data-meta 的 span（用于点击文件路径时提取章节信息）
    html = html.replace(/具体章节[：:]\s*(.+?)(<br>|<\/p>|\n|$)/g, (match, chapter) => {
      const chapterTrim = chapter.trim();
      return `具体章节：<span class="chapter-info" data-meta="chapter: ${escapeAttr(chapterTrim)}">${chapterTrim}</span>`;
    });
    // 搜索总结表格中的 ⟦FILE:path⟧L行号⟧name⟦/FILE⟧ → 可点击超链接
    html = html.replace(/⟦FILE:(.+?)⟧L(\d+)⟧(.+?)[⟦⟧]\/FILE⟧/g, (match, path, lineNum, name) => {
      return `<a class="file-path-link" data-file-path="${escapeAttr(path)}" data-line="${lineNum}">${name}</a>`;
    });
    // PDF 链接 ⟦PDF:basename⟧label⟦/PDF⟧ → 可点击超链接
    html = html.replace(/⟦PDF:(.+?)⟧(.+?)[⟦⟧]\/PDF⟧/g, (match, baseName, label) => {
      return `<a class="pdf-link" data-pdf-name="${escapeAttr(baseName)}">${label}</a>`;
    });
    // 关键词高亮：从报告元数据提取关键词，在文本节点中加粗
    const kwMatch = md.match(/<!--\s*search-keywords:\s*(.*?)\s*-->/);
    if (kwMatch) {
      const kws = [...new Set(kwMatch[1].split(',').map(k => k.trim()).filter(k => k.length > 1))];
      if (kws.length) {
        const sorted = kws.sort((a, b) => b.length - a.length);
        const pattern = sorted.map(k => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
        const kwRegex = new RegExp(`(${pattern})`, 'gi');
        html = html.replace(/>([^<]+)</g, (match, text) =>
          '>' + text.replace(kwRegex, '<strong>$1</strong>') + '<');
      }
    }
    return html;
  };

  // ── 定位到指定行：在渲染后的 DOM 中查找该行文本并滚动高亮 ──
  const jumpToLine = useCallback((tab, line) => {
    const el = previewRefs.current[tab.id];
    if (!el || !tab.md || !line) return;
    const norm = (s) => String(s)
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/[|*`_#>-]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const lines = tab.md.split('\n');
    let target = '';
    for (let off = 0; off < 5; off++) { // 目标行可能是 page 注释行，向下找几行
      const t = norm(lines[line - 1 + off] || '');
      if (t.length >= 4) { target = t.slice(0, 80); break; }
    }
    if (!target) return;
    const blocks = el.querySelectorAll('p, li, h1, h2, h3, h4, h5, h6, td, th, tr, pre');
    for (const b of blocks) {
      if (norm(b.textContent).includes(target)) {
        b.scrollIntoView({ block: 'start' });
        b.style.outline = '2px solid #6366f1';
        setTimeout(() => { b.style.outline = ''; }, 1500);
        return;
      }
    }
  }, []);

  // 待执行的行跳转（等标签页 DOM 渲染完成后消费）
  const pendingJumpRef = useRef(null);

  // ── 打开文件标签页（带行号时定位到对应位置） ──
  const openFileTab = useCallback(async (filePath, line) => {
    // 已有该文件的标签页，直接切换
    const existing = tabs.find(t => t.type === 'file' && t.filePath === filePath);
    if (existing) {
      setActiveTabId(existing.id);
      if (line) {
        pendingJumpRef.current = { filePath, line };
      } else {
        const el = previewRefs.current[existing.id];
        if (el) el.scrollTop = 0;
      }
      return;
    }
    try {
      const resp = await fetch('api/file', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filePath }),
      });
      const data = await resp.json();
      const html = renderMarkdown(data.content);
      openTab({
        title: `📄 ${data.fileName}`,
        type: 'file',
        md: data.content,
        html,
        filePath,
      });
      if (line) pendingJumpRef.current = { filePath, line };
    } catch (err) {
      console.error('打开文件失败:', err);
    }
  }, [tabs, openTab]);

  // 渲染完成后执行待处理的行跳转
  useEffect(() => {
    const pj = pendingJumpRef.current;
    if (!pj || !activeTab || activeTab.type !== 'file' || activeTab.filePath !== pj.filePath) return;
    pendingJumpRef.current = null;
    jumpToLine(activeTab, pj.line);
  }, [activeTabId, activeTab, jumpToLine]);

  // ── 打开 PDF 标签页 ──
  const openPdfTab = useCallback(async (pdfBaseName) => {
    // 已有该 PDF 的标签页，直接切换
    const existing = tabs.find(t => t.type === 'pdf' && t.pdfBaseName === pdfBaseName);
    if (existing) {
      setActiveTabId(existing.id);
      return;
    }
    try {
      // 查找 PDF 文件
      const resp = await fetch('api/find-pdf', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mdPath: pdfBaseName }),
      });
      const data = await resp.json();
      if (data.found) {
        openTab({
          title: `📕 ${data.pdfName}`,
          type: 'pdf',
          pdfUrl: data.url,
          pdfBaseName,
          html: `<iframe src="${data.url}" style="width:100%;height:calc(100vh - 120px);border:none;"></iframe>`,
        });
      } else {
        // 死链兜底：正常情况下渲染后已被剔除，这里不再弹窗
        console.warn('未找到对应的 PDF 文件:', pdfBaseName);
      }
    } catch (err) {
      console.error('打开PDF失败:', err);
    }
  }, [tabs, openTab]);

  // ── 渲染文件 Markdown（纯渲染） ──
  const renderFileHtml = (md) => {
    return renderMarkdown(md);
  };

  // ── 渲染 mermaid（当前激活标签页） ──
  useEffect(() => {
    if (activeTab && previewRefs.current[activeTab.id]) {
      renderMermaidBlocks(previewRefs.current[activeTab.id]);
    }
  }, [activeTabId, activeTab]);

  // ── 点击事件委托：page-meta-link 和 file-path-link ──
  useEffect(() => {
    if (!activeTab || activeTab.type !== 'report') return;
    const el = previewRefs.current[activeTab.id];
    if (!el) return;

    const handler = async (e) => {
      // PDF 链接 → 查找 PDF 并在新标签页预览
      const pdfLink = e.target.closest('.pdf-link');
      if (pdfLink) {
        e.preventDefault();
        await openPdfTab(pdfLink.dataset.pdfName);
        return;
      }
      // 文件路径链接 → 打开 MD 文件
      const fileLink = e.target.closest('.file-path-link');
      if (fileLink) {
        e.preventDefault();
        openFileTab(fileLink.dataset.filePath, parseInt(fileLink.dataset.line, 10) || undefined);
        return;
      }
      // page-meta-link → 打开 MD 文件
      const pageLink = e.target.closest('.page-meta-link');
      if (pageLink) {
        e.preventDefault();
        const metaId = pageLink.dataset.metaId;
        const item = findHitItemByMetaId(metaId, activeTab.md);
        if (item) {
          openFileTab(item.filePath);
        }
        return;
      }
    };
    el.addEventListener('click', handler);
    return () => el.removeEventListener('click', handler);
  }, [activeTabId, activeTab, openFileTab, openPdfTab]);

  // ── 报告渲染后：剔除找不到对应 PDF 的死链（纯 md / Word 等无 PDF 来源） ──
  useEffect(() => {
    if (!activeTab || activeTab.type !== 'report') return;
    const el = previewRefs.current[activeTab.id];
    if (!el) return;
    let cancelled = false;
    const links = [...el.querySelectorAll('a.pdf-link')];
    if (!links.length) return;
    const uniqueNames = [...new Set(links.map(a => a.dataset.pdfName))];
    Promise.allSettled(uniqueNames.map(async name => {
      const resp = await fetch('api/find-pdf', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mdPath: name }),
      });
      const data = await resp.json();
      return [name, Boolean(data.found)];
    })).then(results => {
      if (cancelled) return;
      const dead = new Set(
        results
          .filter(r => r.status === 'fulfilled' && !r.value[1])
          .map(r => r.value[0])
      );
      if (!dead.size) return;
      for (const a of el.querySelectorAll('a.pdf-link')) {
        if (!dead.has(a.dataset.pdfName)) continue;
        const prev = a.previousSibling;
        const next = a.nextSibling;
        if (next && next.nodeType === Node.TEXT_NODE) {
          next.textContent = next.textContent.replace(/^\s*[·|]\s*/, '');
        }
        if (prev && prev.nodeType === Node.TEXT_NODE) {
          prev.textContent = prev.textContent
            .replace(/\s*PDF文件：\s*$/, '')
            .replace(/\s*[·|]\s*$/, '');
        }
        a.remove();
      }
    });
    return () => { cancelled = true; };
  }, [activeTab]);

  // ── 回车搜索 ──
  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSearch();
    }
  };

  // ── 导出 Word ──
  const handleExportWord = useCallback(async () => {
    if (!activeTab || !activeTab.html) return;
    setExporting(true);
    try {
      const el = previewRefs.current[activeTab.id];
      const filename = `${activeTab.title.replace(/[🔍📄]/g, '').trim() || '检索报告'}.docx`;
      await exportToWord(el ? el.innerHTML : activeTab.html, filename);
    } catch (err) {
      console.error('导出失败:', err);
      alert('导出失败: ' + err.message);
    } finally {
      setExporting(false);
    }
  }, [activeTab]);

  // ── AI 整理总结（SSE 流式文本模式：LLM 全程输出 Markdown 纯文本，无 JSON 格式约束） ──
  const handleSummarize = useCallback(async () => {
    if (!activeTab || !activeTab.md || activeTab.type !== 'report') return;
    setSummarizing(true);
    const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const tabId = openTab({
      title: `AI总结: ${activeTab.title.replace(/[🔍📄🤖]/g, '').trim()}`,
      type: 'report',
      md: '',
      // 占位必须非空：html 为空时 React 渲染空态分支，预览容器不挂载，流式内容无处写入
      html: '<div class="ai-stream-preview">正在连接模型…</div>',
    });
    let paintTimer = null;
    try {
      const resp = await fetch('api/summarize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: activeTab.title.replace(/[🔍📄]/g, '').trim(), reportMd: activeTab.md }),
      });
      if (!resp.ok || !resp.body) {
        const errText = await resp.text().catch(() => '');
        throw new Error(`服务端错误 HTTP ${resp.status} ${errText.slice(0, 150)}`);
      }
      // 逐帧解析 SSE 事件（chunk/done/error）；LLM 正文始终按纯文本累积
      const reader = resp.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let buf = '', acc = '', finalSummary = '';
      const paint = () => {
        const el = previewRefs.current[tabId];
        if (el) {
          el.innerHTML = `<pre class="ai-stream-preview">${esc(acc)}▌</pre>`;
        } else if (!paintTimer) {
          // React 渲染异步，容器 ref 尚未挂载时稍后重试
          paintTimer = setTimeout(paint, 100);
        }
      };
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const frames = buf.split('\n\n');
        buf = frames.pop() || '';
        for (const frame of frames) {
          const dataLine = frame.split('\n').find(l => l.startsWith('data: '));
          if (!dataLine) continue;
          let evt;
          try { evt = JSON.parse(dataLine.slice(6)); } catch { continue; }
          if (evt.type === 'chunk') {
            acc += evt.text || '';
            paint();
          } else if (evt.type === 'done') {
            finalSummary = evt.summary || acc;
          } else if (evt.type === 'error') {
            throw new Error(evt.error || 'AI 整理失败');
          }
        }
      }
      if (!finalSummary) finalSummary = acc;
      if (!finalSummary.trim()) throw new Error('AI 未返回任何内容');
      // 流结束：渲染最终版（引用后处理已完成），并同步回 tab 状态供导出/切换
      const html = renderReportHtml(finalSummary);
      setTabs(prev => prev.map(t => t.id === tabId ? { ...t, md: finalSummary, html } : t));
      const el = previewRefs.current[tabId];
      if (el) el.innerHTML = html;
    } catch (err) {
      console.error('AI整理失败:', err);
      const errHtml = `<div class="ai-stream-error">AI 整理失败：${esc(err.message)}</div>`;
      setTabs(prev => prev.map(t => t.id === tabId ? { ...t, md: `> AI 整理失败：${err.message}`, html: errHtml } : t));
      const el = previewRefs.current[tabId];
      if (el) el.innerHTML = errHtml;
    } finally {
      clearTimeout(paintTimer);
      setSummarizing(false);
    }
  }, [activeTab, openTab]);

  return (
    <div className="app">
      {/* 顶部搜索栏 */}
      <header className="search-bar">
        <div className="search-bar-inner">
          <svg className="search-icon" viewBox="0 0 24 24" width="22" height="22">
            <path fill="none" stroke="currentColor" strokeWidth="2"
              d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
          <input
            type="text"
            className="search-input"
            placeholder="输入搜索关键词（多个用分号 ; 分隔），按回车搜索..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            autoFocus
          />
          <button
            className="search-btn"
            onClick={handleSearch}
            disabled={searching || !query.trim()}
          >
            {searching ? '搜索中...' : '搜索'}
          </button>
        </div>
      </header>

      {/* 标签页栏 */}
      {tabs.length > 0 && (
        <div className="tab-bar">
          {tabs.map(tab => (
            <div
              key={tab.id}
              className={`tab-item ${tab.id === activeTabId ? 'tab-active' : ''}`}
              onClick={() => setActiveTabId(tab.id)}
            >
              <span className="tab-title">{tab.title}</span>
              <button className="tab-close" onClick={(e) => closeTab(tab.id, e)}>✕</button>
            </div>
          ))}
        </div>
      )}

      <div className="main-layout">
        {/* 左侧状态栏 */}
        <aside className="status-sidebar">
          <h3 className="sidebar-title">搜索状态</h3>
          {rounds.length === 0 && !searching && !processing && (
            <p className="sidebar-empty">等待搜索...</p>
          )}
          {(searching || processing) && (
            <div className="round-card round-active">
              <span className="loading-dots">{processing ? '整理结果中' : '搜索进行中'}</span>
            </div>
          )}
          {rounds.map((r, i) => (
            <div key={i} className={`round-card ${r.done ? 'round-done' : ''}`}>
              <div className="round-header">
                <span className="round-badge">第 {r.round || i + 1} 轮</span>
                {r.hits !== undefined && (
                  <span className="round-hits">{r.hits} 条命中</span>
                )}
              </div>
              {r.keywords && r.keywords.length > 0 && (
                <div className="round-keywords">
                  {r.keywords.map((kw, j) => (
                    <span key={j} className="keyword-tag">{kw}</span>
                  ))}
                </div>
              )}
              {r.judgment && (
                <p className="round-judgment">{r.judgment}</p>
              )}
              {r.done && <span className="round-done-mark">✓</span>}
            </div>
          ))}
        </aside>

        {/* 右侧主内容区 */}
        <main className="content-area">
          {/* 源码查看面板 */}
          {editorVisible && activeTab && (
            <div className="editor-panel">
              <div className="panel-header">
                <span>Markdown 源码</span>
                <button className="btn-collapse" onClick={() => setEditorVisible(false)}>✕</button>
              </div>
              <textarea
                className="editor"
                value={activeTab.md || ''}
                readOnly
                spellCheck={false}
              />
            </div>
          )}

          {/* 预览面板 */}
          <div className="preview-panel">
            <div className="panel-header">
              <span>{activeTab ? activeTab.title : '检索报告'}</span>
              {activeTab && activeTab.md && (
                <div className="panel-header-actions">
                  <button className="btn-toggle-editor" onClick={() => setEditorVisible(!editorVisible)}>
                    {editorVisible ? '隐藏源码' : '显示源码'}
                  </button>
                  {activeTab.type === 'report' && (
                    <button
                      className="btn-summarize"
                      onClick={handleSummarize}
                      disabled={summarizing}
                    >
                      {summarizing ? '整理中...' : 'AI 整理'}
                    </button>
                  )}
                  <button
                    className="btn-export-word"
                    onClick={handleExportWord}
                    disabled={exporting || !activeTab?.html}
                  >
                    {exporting ? '导出中...' : '📄 导出 Word'}
                  </button>
                </div>
              )}
            </div>
            {activeTab && activeTab.html ? (
              <div
                ref={el => { if (el) previewRefs.current[activeTab.id] = el; }}
                className="preview markdown-body"
                dangerouslySetInnerHTML={{ __html: activeTab.html }}
              />
            ) : (
              <div className="preview-empty">
                <p>🔍 请在上方输入关键词搜索知识库</p>
              </div>
            )}
          </div>
        </main>
      </div>
    </div>
  );
}

// ── 工具函数 ──

function handleSSEEvent(data, setRounds) {
  switch (data.type) {
    case 'round':
      setRounds(prev => [...prev, { round: data.round, keywords: [], hits: undefined, judgment: '', done: false }]);
      break;
    case 'keywords':
      setRounds(prev => {
        const copy = [...prev];
        if (copy.length > 0) copy[copy.length - 1] = { ...copy[copy.length - 1], keywords: data.keywords };
        return copy;
      });
      break;
    case 'hits':
      setRounds(prev => {
        const copy = [...prev];
        if (copy.length > 0) copy[copy.length - 1] = { ...copy[copy.length - 1], hits: data.count };
        return copy;
      });
      break;
    case 'judgment':
      setRounds(prev => {
        const copy = [...prev];
        if (copy.length > 0) copy[copy.length - 1] = { ...copy[copy.length - 1], judgment: data.text };
        return copy;
      });
      break;
    case 'done':
      setRounds(prev => {
        const copy = [...prev];
        if (copy.length > 0) copy[copy.length - 1] = { ...copy[copy.length - 1], done: true };
        return copy;
      });
      break;
    case 'complete':
      setRounds(prev => prev.map(r => ({ ...r, done: true })));
      break;
  }
}

function findHitItemByMetaId(metaId, reportMd) {
  const allPageMatches = [...reportMd.matchAll(/<!--\s*page:.*?-->/g)];
  if (metaId >= allPageMatches.length) return null;
  const pagePos = allPageMatches[metaId].index;
  const beforeText = reportMd.slice(0, pagePos);
  const blockHeaders = [...beforeText.matchAll(/^### 【(\d+)】/gm)];
  if (blockHeaders.length === 0) return null;
  const blockStart = blockHeaders[blockHeaders.length - 1].index;
  const afterBlock = reportMd.slice(blockStart + 10);
  const nextBlockIdx = afterBlock.search(/^### 【/m);
  const blockText = nextBlockIdx > 0
    ? reportMd.slice(blockStart, blockStart + 10 + nextBlockIdx)
    : reportMd.slice(blockStart);
  const fileMatch = blockText.match(/文件路径[：:]\s*`(.+?)`/);
  const lineMatch = blockText.match(/行号[：:]\s*L(\d+)-(\d+)/);
  // 提取章节和 page 信息（新格式：> 具体章节：xxx | page: N）
  const chapterMatch = blockText.match(/具体章节[：:]\s*(.+)/);
  const pageMatch = blockText.match(/page:\s*(\d+)/);
  let metaStr = '';
  if (pageMatch) metaStr += `page: ${pageMatch[1]}`;
  if (chapterMatch) metaStr += (metaStr ? ' | ' : '') + `chapter: ${chapterMatch[1].trim()}`;
  if (fileMatch) {
    return {
      filePath: fileMatch[1],
      lineStart: lineMatch ? parseInt(lineMatch[1]) : 1,
      lineEnd: lineMatch ? parseInt(lineMatch[2]) : 20,
      meta: metaStr,
    };
  }
  return null;
}

function escapeAttr(str) {
  return str.replace(/"/g, '&quot;');
}

export default App;
