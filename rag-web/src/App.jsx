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
    html = html.replace(/⟦FILE:(.+?)⟧L(\d+)⟧(.+?)⟦\/FILE⟧/g, (match, path, lineNum, name) => {
      return `<a class="file-path-link" data-file-path="${escapeAttr(path)}" data-line="${lineNum}">${name}</a>`;
    });
    // PDF 链接 ⟦PDF:basename⟧label⟦/PDF⟧ → 可点击超链接
    html = html.replace(/⟦PDF:(.+?)⟧(.+?)⟦\/PDF⟧/g, (match, baseName, label) => {
      return `<a class="pdf-link" data-pdf-name="${escapeAttr(baseName)}">${label}</a>`;
    });
    // 关键词高亮：从报告元数据提取关键词，在文本节点中标黄
    const kwMatch = md.match(/<!--\s*search-keywords:\s*(.*?)\s*-->/);
    if (kwMatch) {
      const kws = [...new Set(kwMatch[1].split(',').map(k => k.trim()).filter(k => k.length > 1))];
      if (kws.length) {
        const sorted = kws.sort((a, b) => b.length - a.length);
        const pattern = sorted.map(k => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
        const kwRegex = new RegExp(`(${pattern})`, 'gi');
        html = html.replace(/>([^<]+)</g, (match, text) =>
          '>' + text.replace(kwRegex, '<mark class="kw-hl">$1</mark>') + '<');
      }
    }
    return html;
  };

  // ── 打开文件标签页（定位到文档开头） ──
  const openFileTab = useCallback(async (filePath) => {
    // 已有该文件的标签页，直接切换
    const existing = tabs.find(t => t.type === 'file' && t.filePath === filePath);
    if (existing) {
      setActiveTabId(existing.id);
      const el = previewRefs.current[existing.id];
      if (el) el.scrollTop = 0;
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
    } catch (err) {
      console.error('打开文件失败:', err);
    }
  }, [tabs, openTab]);

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
        alert('未找到对应的 PDF 文件');
      }
    } catch (err) {
      console.error('打开PDF失败:', err);
      alert('打开PDF失败: ' + err.message);
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
        openFileTab(fileLink.dataset.filePath);
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

  // ── AI 整理总结 ──
  const handleSummarize = useCallback(async () => {
    if (!activeTab || !activeTab.md || activeTab.type !== 'report') return;
    setSummarizing(true);
    try {
      const resp = await fetch('api/summarize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: activeTab.title.replace(/[🔍📄]/g, '').trim(), reportMd: activeTab.md }),
      });
      const data = await resp.json();
      if (data.summary) {
        openTab({
          title: `AI总结: ${activeTab.title.replace(/[🔍📄🤖]/g, '').trim()}`,
          type: 'report',
          md: data.summary,
          html: renderReportHtml(data.summary),
        });
      }
    } catch (err) {
      console.error('AI整理失败:', err);
      alert('AI整理失败: ' + err.message);
    } finally {
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
            placeholder="输入搜索关键词，按回车搜索 Markdown 文档..."
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
