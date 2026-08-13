import { Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell, WidthType, BorderStyle, AlignmentType } from 'docx';
import { saveAs } from 'file-saver';

// 提取节点中的纯文本内容（递归）
function extractTextRuns(node) {
  const runs = [];
  function walk(n) {
    if (n.nodeType === Node.TEXT_NODE) {
      const text = n.textContent;
      if (text) runs.push({ text, bold: false, italic: false });
      return;
    }
    if (n.nodeType !== Node.ELEMENT_NODE) return;
    const tag = n.tagName.toLowerCase();
    const bold = tag === 'strong' || tag === 'b';
    const italic = tag === 'em' || tag === 'i';
    const code = tag === 'code';
    for (const child of n.childNodes) {
      const childRuns = extractTextRuns(child);
      for (const r of childRuns) {
        r.bold = r.bold || bold;
        r.italic = r.italic || italic;
        r.code = r.code || code;
      }
      runs.push(...childRuns);
    }
  }
  walk(node);
  return runs;
}

// 将 HTML 转换为 docx 段落
function htmlToDocxChildren(html) {
  const container = document.createElement('div');
  container.innerHTML = html;
  const children = [];

  for (const node of container.childNodes) {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent.trim();
      if (text) {
        children.push(new Paragraph({ children: [new TextRun(text)] }));
      }
      continue;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) continue;

    const tag = node.tagName.toLowerCase();
    const textRuns = extractTextRuns(node).map(r =>
      new TextRun({ text: r.text, bold: r.bold, italics: r.italic, font: r.code ? 'Consolas' : undefined })
    );

    if (tag === 'h1') {
      children.push(new Paragraph({ heading: HeadingLevel.HEADING_1, children: textRuns }));
    } else if (tag === 'h2') {
      children.push(new Paragraph({ heading: HeadingLevel.HEADING_2, children: textRuns }));
    } else if (tag === 'h3') {
      children.push(new Paragraph({ heading: HeadingLevel.HEADING_3, children: textRuns }));
    } else if (tag === 'h4') {
      children.push(new Paragraph({ heading: HeadingLevel.HEADING_4, children: textRuns }));
    } else if (tag === 'p') {
      children.push(new Paragraph({ children: textRuns.length ? textRuns : [new TextRun('')] }));
    } else if (tag === 'blockquote') {
      for (const r of textRuns) {
        children.push(new Paragraph({
          children: [r],
          indent: { left: 720 },
          spacing: { after: 40 },
        }));
      }
    } else if (tag === 'pre') {
      const codeText = node.textContent;
      for (const line of codeText.split('\n')) {
        children.push(new Paragraph({
          children: [new TextRun({ text: line, font: 'Consolas', size: 20 })],
          spacing: { after: 0, line: 240 },
        }));
      }
    } else if (tag === 'ul' || tag === 'ol') {
      for (const li of node.querySelectorAll(':scope > li')) {
        const liRuns = extractTextRuns(li).map(r =>
          new TextRun({ text: r.text, bold: r.bold, italics: r.italic })
        );
        children.push(new Paragraph({
          children: liRuns,
          bullet: { level: 0 },
        }));
      }
    } else if (tag === 'table') {
      const rows = [];
      for (const tr of node.querySelectorAll('tr')) {
        const cells = [];
        for (const td of tr.querySelectorAll('td, th')) {
          const cellRuns = extractTextRuns(td).map(r =>
            new TextRun({ text: r.text, bold: r.bold || td.tagName.toLowerCase() === 'th' })
          );
          cells.push(new TableCell({
            children: [new Paragraph({ children: cellRuns })],
            width: { size: Math.floor(100 / (tr.querySelectorAll('td, th').length || 1)), type: WidthType.PERCENTAGE },
          }));
        }
        if (cells.length) rows.push(new TableRow({ children: cells }));
      }
      if (rows.length) {
        children.push(new Table({
          rows,
          width: { size: 100, type: WidthType.PERCENTAGE },
        }));
      }
    } else if (tag === 'hr') {
      children.push(new Paragraph({
        border: { bottom: { color: 'CCCCCC', style: BorderStyle.SINGLE, size: 6, space: 1 } },
      }));
    } else {
      const text = node.textContent.trim();
      if (text) children.push(new Paragraph({ children: textRuns }));
    }
  }

  return children;
}

// Word 导出
export async function exportToWord(htmlContent, filename = 'document.docx') {
  const children = htmlToDocxChildren(htmlContent);
  if (children.length === 0) {
    children.push(new Paragraph({ children: [new TextRun('空文档')] }));
  }

  const doc = new Document({
    styles: {
      default: {
        document: {
          run: { font: 'Calibri', size: 22 },
          paragraph: { spacing: { line: 276, after: 120 } },
        },
        heading1: {
          run: { font: 'Calibri', size: 32, bold: true, color: '2E74B5' },
          paragraph: { spacing: { before: 240, after: 120 } },
        },
        heading2: {
          run: { font: 'Calibri', size: 26, bold: true, color: '2E74B5' },
          paragraph: { spacing: { before: 200, after: 80 } },
        },
        heading3: {
          run: { font: 'Calibri', size: 24, bold: true, color: '1F4D78' },
          paragraph: { spacing: { before: 160, after: 60 } },
        },
        heading4: {
          run: { font: 'Calibri', size: 22, bold: true, color: '1F4D78' },
          paragraph: { spacing: { before: 120, after: 40 } },
        },
      },
    },
    sections: [{
      properties: {
        page: { margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 } },
      },
      children,
    }],
  });

  const blob = await Packer.toBlob(doc);
  saveAs(blob, filename);
}
