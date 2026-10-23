'use strict';
// 极简 PDF 生成（仅用于测试页，不引入额外依赖）
function esc(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')
    .replace(/[^\x20-\x7E]/g, '?');
}

function buildTestPagePdf({ printer = 'PRINTER', time = new Date().toISOString(), app = 'PrintGate' } = {}) {
  const lines = [
    { text: `${app} - Test Page`, size: 26, y: 760, font: 'F1' },
    { text: 'If this page prints correctly, the queue is working.', size: 12, y: 720, font: 'F2' },
    { text: `Printer queue: ${printer}`, size: 13, y: 660, font: 'F2' },
    { text: `Generated at: ${time}`, size: 13, y: 636, font: 'F2' },
    { text: 'Alignment: |<-- 100 mm -->|', size: 11, y: 580, font: 'F2' },
    { text: 'Color check: K C M Y  [grid below]', size: 11, y: 540, font: 'F2' }
  ];

  let content = '0.1 0.1 0.1 RG 2 w\n40 60 515 745 re S\n';
  for (const l of lines) {
    content += `BT /${l.font} ${l.size} Tf 60 ${l.y} Td (${esc(l.text)}) Tj ET\n`;
  }
  // 灰阶条：10 级，从左到右由浅到深
  for (let i = 0; i < 10; i++) {
    const g = ((9 - i) / 9).toFixed(2);
    content += `${g} ${g} ${g} rg ${60 + i * 48} 470 44 34 re f\n`;
  }
  // 彩色块（RGB 近似 CMYK 四色 + 黑）
  const colors = [[1, 0, 0], [0, 1, 0], [0, 0, 1], [0, 0, 0], [1, 1, 0]];
  colors.forEach((c, i) => {
    content += `${c[0]} ${c[1]} ${c[2]} rg ${60 + i * 48} 420 44 34 re f\n`;
  });
  content += '0 0 0 rg\n';

  const objs = [];
  objs[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objs[2] = '<< /Type /Pages /Kids [3 0 R] /Count 1 >>';
  objs[3] = '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] '
    + '/Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> /Contents 4 0 R >>';
  objs[4] = `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}endstream`;
  objs[5] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>';
  objs[6] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';

  let pdf = '%PDF-1.4\n';
  const offsets = [];
  for (let i = 1; i < objs.length; i++) {
    offsets[i] = Buffer.byteLength(pdf, 'latin1');
    pdf += `${i} 0 obj\n${objs[i]}\nendobj\n`;
  }
  const xrefPos = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${objs.length}\n0000000000 65535 f \n`;
  for (let i = 1; i < objs.length; i++) {
    pdf += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objs.length} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

module.exports = { buildTestPagePdf };
