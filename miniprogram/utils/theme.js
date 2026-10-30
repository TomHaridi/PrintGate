// 主题管理：auto（跟随系统）/ light / dark + 主色（可自定义）
const MODE_KEY = 'pg_theme_mode';
const PRIMARY_KEY = 'pg_primary';

// 主色预设：每种给一个可用的基础色，soft 版本在运行期按透明度生成
const PRIMARY_PRESETS = [
  { v: '#0C8B80', t: '青绿' },
  { v: '#2F6FED', t: '海蓝' },
  { v: '#00A9A5', t: '碧蓝' },
  { v: '#7C4DFF', t: '罗兰紫' },
  { v: '#F5793B', t: '暖橙' },
  { v: '#E4446B', t: '玫红' },
  { v: '#37474F', t: '石墨' }
];
const DEFAULT_PRIMARY = '#0C8B80';

function isHexColor(v) {
  return /^#[0-9a-fA-F]{6}$/.test(String(v || ''));
}

function getPrimary() {
  let v = '';
  try { v = wx.getStorageSync(PRIMARY_KEY) || ''; } catch (_) {}
  return isHexColor(v) ? v : DEFAULT_PRIMARY;
}

function setPrimary(hex) {
  const v = isHexColor(hex) ? hex : DEFAULT_PRIMARY;
  try { wx.setStorageSync(PRIMARY_KEY, v); } catch (_) {}
  return v;
}

// ---------- 颜色运算：由主色派生深浅/浅底/前景色 ----------
function hexToRgb(hex) {
  const v = isHexColor(hex) ? hex : DEFAULT_PRIMARY;
  return {
    r: parseInt(v.slice(1, 3), 16),
    g: parseInt(v.slice(3, 5), 16),
    b: parseInt(v.slice(5, 7), 16)
  };
}

function rgbToHex(r, g, b) {
  const c = (n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`;
}

// 与黑白混色：ratio 越大越接近目标
function mixHex(hex, target, ratio) {
  const a = hexToRgb(hex);
  const b = hexToRgb(target);
  return rgbToHex(
    a.r + (b.r - a.r) * ratio,
    a.g + (b.g - a.g) * ratio,
    a.b + (b.b - a.b) * ratio
  );
}

// 相对亮度（WCAG），用于决定主色上的文字用白还是深色
function luminance(hex) {
  const { r, g, b } = hexToRgb(hex);
  const f = (c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

function primaryDeep(hex) { return mixHex(hex, '#000000', 0.20); }
function primaryBright(hex) { return mixHex(hex, '#FFFFFF', 0.22); }
function onPrimary(hex) { return luminance(hex) > 0.42 ? '#12262B' : '#FFFFFF'; }

// 主色的浅色版（用于选中态底色/标签）：8 位 hex 带透明度，微信支持
function primarySoft(hex, alpha = '1A') {
  const v = isHexColor(hex) ? hex : DEFAULT_PRIMARY;
  return `${v}${alpha}`;
}

// 暗夜下把主色提亮一档，避免在深色背景上发闷
function primaryForDark(hex) {
  return mixHex(hex, '#FFFFFF', 0.14);
}

// 页面根节点用它注入 CSS 变量，自定义属性会向下继承到组件内部
// 必须一次性覆盖整组派生 token，否则渐变按钮 / 浅底标签还会停留在旧色
function primaryStyle(hex, dark) {
  const base = isHexColor(hex) ? hex : DEFAULT_PRIMARY;
  const main = dark ? primaryForDark(base) : base;
  return [
    `--pg-primary: ${main};`,
    `--pg-primary-deep: ${primaryDeep(main)};`,
    `--pg-primary-bright: ${primaryBright(main)};`,
    `--pg-primary-soft: ${primarySoft(main)};`,
    `--pg-primary-softer: ${primarySoft(main, '0D')};`,
    `--pg-on-primary: ${onPrimary(main)};`
  ].join(' ');
}

function getMode() {
  try { return wx.getStorageSync(MODE_KEY) || 'auto'; } catch (_) { return 'auto'; }
}

function setMode(mode) {
  const m = ['auto', 'light', 'dark'].includes(mode) ? mode : 'auto';
  try { wx.setStorageSync(MODE_KEY, m); } catch (_) {}
  return m;
}

// 系统是否深色（base lib 3.x 支持 theme 字段）
function systemDark() {
  try {
    const info = wx.getSystemInfoSync();
    return info.theme === 'dark';
  } catch (_) {
    return false;
  }
}

// 解析当前是否暗夜
function isDark(mode) {
  const m = mode || getMode();
  if (m === 'dark') return true;
  if (m === 'light') return false;
  return systemDark();
}

const MODE_LABEL = { auto: '跟随系统', light: '浅色', dark: '深色' };

module.exports = {
  getMode, setMode, isDark, systemDark, MODE_LABEL, MODE_KEY,
  PRIMARY_PRESETS, DEFAULT_PRIMARY, PRIMARY_KEY,
  getPrimary, setPrimary, isHexColor,
  primarySoft, primaryDeep, primaryBright, primaryForDark, onPrimary, primaryStyle
};
