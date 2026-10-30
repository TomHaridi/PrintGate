'use strict';
// 小程序图标生成：一套统一的线性图标（24×24 网格、1.7px 描边、圆角端点）
// 输出：images/tab/*.png (81×81)、images/icons/*.png (48×48)
// 用法：NODE_PATH=<sharp 所在> node tools/gen-mp-icons.js
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const MP = path.join(__dirname, '..', 'miniprogram');
const TAB = path.join(MP, 'images', 'tab');
const ICO = path.join(MP, 'images', 'icons');

// 主题色
const GRAY = '#9AA8AE';      // tab 未选中
const TEAL = '#0C8B80';      // 主色
const INK = '#0F172A';       // 深色文字

// ---------- 图形路径（24×24 网格）----------
const SHAPES = {
  print: `
    <path d="M6.5 9V3.5h11V9"/>
    <path d="M6.5 18H5a1.5 1.5 0 0 1-1.5-1.5V10A1.5 1.5 0 0 1 5 8.5h14A1.5 1.5 0 0 1 20.5 10v6.5A1.5 1.5 0 0 1 19 18h-1.5"/>
    <rect x="6.5" y="14" width="11" height="6.5" rx="1.2"/>
    <path d="M17 11.6h.01"/>`,
  doc: `
    <path d="M13.6 3.2H7.4A2.2 2.2 0 0 0 5.2 5.4v13.2a2.2 2.2 0 0 0 2.2 2.2h9.2a2.2 2.2 0 0 0 2.2-2.2V8.4z"/>
    <path d="M13.6 3.2v5.2h5.2"/>
    <path d="M8.8 12.6h6.4M8.8 16.2h4.2"/>`,
  clock: `
    <circle cx="12" cy="12" r="8.6"/>
    <path d="M12 7.4V12l3.2 2"/>`,
  user: `
    <circle cx="12" cy="8.2" r="3.6"/>
    <path d="M4.8 20a7.2 7.2 0 0 1 14.4 0"/>`,

  // ---- 页面内图标 ----
  users: `
    <circle cx="9.2" cy="8.2" r="3.2"/>
    <path d="M2.8 19.4a6.4 6.4 0 0 1 12.8 0"/>
    <path d="M16.2 5.4a3.2 3.2 0 0 1 0 5.7"/>
    <path d="M17.6 13.4a6.2 6.2 0 0 1 3.6 6"/>`,
  check: `
    <circle cx="12" cy="12" r="8.6"/>
    <path d="M8.1 12.4l2.6 2.6 5.2-5.4"/>`,
  clipboard: `
    <path d="M9.4 5.2H7.6A2.1 2.1 0 0 0 5.5 7.3v11.4a2.1 2.1 0 0 0 2.1 2.1h8.8a2.1 2.1 0 0 0 2.1-2.1V7.3a2.1 2.1 0 0 0-2.1-2.1h-1.8"/>
    <rect x="9.4" y="3" width="5.2" height="4" rx="1.2"/>
    <path d="M9 12.2h6M9 15.8h4"/>`,
  info: `
    <circle cx="12" cy="12" r="8.6"/>
    <path d="M12 11v5.2M12 8.1h.01"/>`,
  key: `
    <circle cx="8.4" cy="15.6" r="3.9"/>
    <path d="M11.2 12.8l7.6-7.6"/>
    <path d="M16.2 7.8l1.7 1.7"/>`,
  logout: `
    <path d="M14.6 3.8h2.9a2.1 2.1 0 0 1 2.1 2.1v12.2a2.1 2.1 0 0 1-2.1 2.1h-2.9"/>
    <path d="M9.6 8.2L5.8 12l3.8 3.8"/>
    <path d="M5.8 12h8.6"/>`,
  scan: `
    <path d="M4.2 9V6.3a2.1 2.1 0 0 1 2.1-2.1H9"/>
    <path d="M19.8 9V6.3a2.1 2.1 0 0 0-2.1-2.1H15"/>
    <path d="M4.2 15v2.7a2.1 2.1 0 0 0 2.1 2.1H9"/>
    <path d="M19.8 15v2.7a2.1 2.1 0 0 1-2.1 2.1H15"/>
    <path d="M4.2 12h15.6"/>`,
  search: `
    <circle cx="10.8" cy="10.8" r="6.6"/>
    <path d="M15.7 15.7l4.3 4.3"/>`,
  server: `
    <rect x="3.2" y="4" width="17.6" height="6.6" rx="2"/>
    <rect x="3.2" y="13.4" width="17.6" height="6.6" rx="2"/>
    <path d="M7.2 7.3h.01M7.2 16.7h.01"/>
    <path d="M11 7.3h5.6M11 16.7h5.6"/>`,
  shield: `
    <path d="M12 3.2l7.2 2.9v5.5c0 4.2-3 7.7-7.2 9.6-4.2-1.9-7.2-5.4-7.2-9.6V6.1z"/>
    <path d="M9.2 12l2.1 2.1 3.6-3.9"/>`,
  sliders: `
    <path d="M4 7.4h8.4M17.4 7.4h2.6"/>
    <path d="M4 16.6h3.2M12 16.6h8"/>
    <circle cx="15" cy="7.4" r="2.2"/>
    <circle cx="9.6" cy="16.6" r="2.2"/>`,
  upload: `
    <path d="M12 15.8V4.2"/>
    <path d="M8.1 8.1L12 4.2l3.9 3.9"/>
    <path d="M4.2 15.6v2.5a2.1 2.1 0 0 0 2.1 2.1h11.4a2.1 2.1 0 0 0 2.1-2.1v-2.5"/>`,
  wifi: `
    <path d="M3.4 9.2a13.4 13.4 0 0 1 17.2 0"/>
    <path d="M6.6 12.6a8.6 8.6 0 0 1 10.8 0"/>
    <path d="M9.7 16a4 4 0 0 1 4.6 0"/>
    <path d="M12 19.2h.01"/>`,
  home: `
    <path d="M4 10.4L12 3.6l8 6.8V19a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z"/>
    <path d="M9.6 21v-6.4h4.8V21"/>`
};

// tab 选中态额外填充（轻微实心，视觉上更"亮"，但保持同一套线条）
const TAB_FILL = {
  print: '<rect x="6.5" y="14" width="11" height="6.5" rx="1.2" fill="{C}" fill-opacity="0.22"/>',
  doc: '<path d="M13.6 3.2H7.4A2.2 2.2 0 0 0 5.2 5.4v13.2a2.2 2.2 0 0 0 2.2 2.2h9.2a2.2 2.2 0 0 0 2.2-2.2V8.4z" fill="{C}" fill-opacity="0.16"/>',
  clock: '<circle cx="12" cy="12" r="8.6" fill="{C}" fill-opacity="0.14"/>',
  user: '<circle cx="12" cy="8.2" r="3.6" fill="{C}" fill-opacity="0.22"/><path d="M4.8 20a7.2 7.2 0 0 1 14.4 0" fill="{C}" fill-opacity="0.14"/>'
};

function svg(body, { color, size, width = 1.7, fill = '' }) {
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" ` +
    `fill="none" stroke="${color}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round">` +
    `${fill}${body}</svg>`
  );
}

async function writePng(out, buf, size) {
  await sharp(buf, { density: 384 }).resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).png({ compressionLevel: 9 }).toFile(out);
}

(async () => {
  fs.mkdirSync(TAB, { recursive: true });
  fs.mkdirSync(ICO, { recursive: true });
  const made = [];

  // tab：4 组 × (normal + active)
  for (const name of ['print', 'doc', 'clock', 'user']) {
    const body = SHAPES[name];
    await writePng(path.join(TAB, `${name}.png`), svg(body, { color: GRAY, size: 81 }), 81);
    const fill = (TAB_FILL[name] || '').replace(/\{C\}/g, TEAL);
    await writePng(path.join(TAB, `${name}-active.png`), svg(body, { color: TEAL, size: 81, width: 1.9, fill }), 81);
    made.push(`tab/${name}.png`, `tab/${name}-active.png`);
  }

  // 页面内图标：常规为 teal，-ink 为深色（跟随文字）
  const icons = [
    ['print', 'teal'], ['doc', 'teal'], ['clock', 'teal'], ['user', 'teal'],
    ['users', 'teal'], ['check', 'teal'], ['clipboard', 'teal'], ['info', 'teal'],
    ['info-ink', 'ink'], ['key', 'teal'], ['logout-ink', 'ink'], ['scan', 'teal'],
    ['search-ink', 'ink'], ['server', 'teal'], ['shield', 'teal'], ['sliders', 'teal'],
    ['upload', 'teal'], ['wifi', 'teal'], ['home', 'teal']
  ];
  for (const [name, tone] of icons) {
    const base = name.replace(/-ink$/, '');
    const body = SHAPES[base];
    if (!body) { console.log('缺图形:', base); continue; }
    const color = tone === 'ink' ? INK : TEAL;
    await writePng(path.join(ICO, `${name}.png`), svg(body, { color, size: 48 }), 48);
    made.push(`icons/${name}.png`);
  }

  console.log(`生成 ${made.length} 个图标`);
  console.log(made.join(' '));
})();
