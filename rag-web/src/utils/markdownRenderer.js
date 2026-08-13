import { marked } from 'marked';
import hljs from 'highlight.js';
import katex from 'katex';
import mermaid from 'mermaid';
import { renderMermaidSVG } from 'beautiful-mermaid';

// 初始化 mermaid（作为不支持的图表类型的回退）
mermaid.initialize({
  startOnLoad: false,
  theme: 'default',
  securityLevel: 'loose',
});

// beautiful-mermaid 支持的图表类型前缀
const BEAUTIFUL_MERMAID_TYPES = [
  'graph',
  'stateDiagram',
  'sequenceDiagram',
  'classDiagram',
  'erDiagram',
  'xychart-beta',
];

// 检测图表类型，判断是否可以用 beautiful-mermaid 渲染
function isBeautifulMermaidSupported(code) {
  const trimmed = code.trim();
  return BEAUTIFUL_MERMAID_TYPES.some(type => trimmed.startsWith(type));
}

// beautiful-mermaid 自定义主题：深色线条与边框，白底适配
const MERMAID_THEME = {
  bg: '#ffffff',
  fg: '#1e293b',        // 深色前景文字
  line: '#475569',       // 连接线：slate-600，较深
  accent: '#334155',     // 箭头：slate-700，更深
  muted: '#64748b',      // 次要文字：slate-500
  surface: '#f1f5f9',    // 节点填充：slate-100 微蓝灰
  border: '#334155',     // 节点边框：slate-700
};

// 配置 marked
const renderer = new marked.Renderer();

// 代码块渲染 - 支持 mermaid、内联 SVG 和语法高亮
renderer.code = function ({ text, lang }) {
  if (lang === 'mermaid') {
    return `<div class="mermaid-block" data-mermaid="${encodeURIComponent(text)}"></div>`;
  }
  // 检测被 ``` 包裹的内联 SVG（lang 为 svg 或内容本身是 <svg>...</svg>）
  const trimmed = text.trim();
  if (lang === 'svg' || (trimmed.startsWith('<svg') && trimmed.endsWith('</svg>'))) {
    return `<div class="md-inline-svg">${trimmed}</div>`;
  }
  const validLang = hljs.getLanguage(lang) ? lang : 'plaintext';
  const highlighted = hljs.highlight(text, { language: validLang }).value;
  return `<pre><code class="hljs language-${validLang}">${highlighted}</code></pre>`;
};

// 图片渲染
renderer.image = function ({ href, title, text }) {
  const titleAttr = title ? ` title="${title}"` : '';
  if (href && href.endsWith('.svg')) {
    return `<img src="${href}" alt="${text}"${titleAttr} class="md-svg" loading="lazy" />`;
  }
  return `<img src="${href}" alt="${text}"${titleAttr} class="md-image" loading="lazy" onerror="this.alt='[图片加载失败: ' + this.src + ']'"/>`;
};

// 链接渲染 - 新标签页打开
renderer.link = function ({ href, title, text }) {
  const titleAttr = title ? ` title="${title}"` : '';
  return `<a href="${href}"${titleAttr} target="_blank" rel="noopener noreferrer">${text}</a>`;
};

// 禁用删除线：GFM 的 ~ 会把 "20%~30%" 误渲染为删除线，直接原样输出
renderer.del = function ({ text }) {
  return text;
};

marked.setOptions({
  renderer,
  gfm: true,
  breaks: true,
});

// 渲染 mermaid 图表（beautiful-mermaid 优先，不支持的类型回退到原始 mermaid）
export async function renderMermaidBlocks(container) {
  const mermaidBlocks = container.querySelectorAll('.mermaid-block');
  for (const block of mermaidBlocks) {
    const code = decodeURIComponent(block.getAttribute('data-mermaid'));
    try {
      if (isBeautifulMermaidSupported(code)) {
        // 使用 beautiful-mermaid 渲染（同步、更美观，使用深色主题）
        const svg = renderMermaidSVG(code, { ...MERMAID_THEME, transparent: true });
        block.innerHTML = svg;
      } else {
        // 回退到原始 mermaid（支持饼图、甘特图等）
        const id = `mermaid-${Math.random().toString(36).substr(2, 9)}`;
        const { svg } = await mermaid.render(id, code);
        block.innerHTML = svg;
      }
    } catch (e) {
      block.innerHTML = `<pre class="mermaid-error">Mermaid 渲染错误: ${e.message}</pre>`;
    }
  }
}

// 主渲染函数 - 使用 HTML 注释占位符避免公式被 marked 二次解析
export function renderMarkdown(markdown) {
  const katexMap = [];
  let counter = 0;

  // 0. 规范化 LaTeX 分隔符：将双反斜杠 \\( \\) \\[ \\] 转为单反斜杠
  let text = markdown
    .replace(/\\\\\(/g, '\\(')
    .replace(/\\\\\)/g, '\\)')
    .replace(/\\\\\[/g, '\\[')
    .replace(/\\\\\]/g, '\\]');

  // 1. 提取块级公式 $$...$$ 和 \[...\]，替换为 HTML 注释占位符
  text = text.replace(/\$\$([\s\S]+?)\$\$/g, (match, formula) => {
    const id = counter++;
    try {
      const html = katex.renderToString(formula.trim(), { displayMode: true, throwOnError: false });
      katexMap[id] = html;
    } catch (e) {
      katexMap[id] = `<span class="katex-error">${formula}</span>`;
    }
    return `<!--KATEXBLOCK${id}-->`;
  });

  text = text.replace(/\\\[([\s\S]+?)\\\]/g, (match, formula) => {
    const id = counter++;
    try {
      const html = katex.renderToString(formula.trim(), { displayMode: true, throwOnError: false });
      katexMap[id] = html;
    } catch (e) {
      katexMap[id] = `<span class="katex-error">${formula}</span>`;
    }
    return `<!--KATEXBLOCK${id}-->`;
  });

  // 2. 提取行内公式 $...$ 和 \(...\)，替换为 HTML 注释占位符
  text = text.replace(/\$([^\$\n]+?)\$/g, (match, formula) => {
    const id = counter++;
    try {
      const html = katex.renderToString(formula.trim(), { displayMode: false, throwOnError: false });
      katexMap[id] = html;
    } catch (e) {
      katexMap[id] = `<span class="katex-error">${formula}</span>`;
    }
    return `<!--KATEXINLINE${id}-->`;
  });

  text = text.replace(/\\\(([\s\S]+?)\\\)/g, (match, formula) => {
    const id = counter++;
    try {
      const html = katex.renderToString(formula.trim(), { displayMode: false, throwOnError: false });
      katexMap[id] = html;
    } catch (e) {
      katexMap[id] = `<span class="katex-error">${formula}</span>`;
    }
    return `<!--KATEXINLINE${id}-->`;
  });

  // 3. marked 渲染 Markdown（HTML 注释会被原样保留）
  let html = marked.parse(text);

  // 4. 将占位符替换回 KaTeX HTML
  for (let i = 0; i < counter; i++) {
    html = html.replace(`<!--KATEXBLOCK${i}-->`, katexMap[i]);
    html = html.replace(`<!--KATEXINLINE${i}-->`, katexMap[i]);
  }

  return html;
}
