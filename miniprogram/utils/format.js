// 格式化工具：体积 / 时间 / 状态文案 / 打印参数摘要
function formatSize(bytes) {
  const b = Number(bytes) || 0;
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1024 / 1024).toFixed(2)} MB`;
}

function pad(n) { return n < 10 ? `0${n}` : `${n}`; }

// 稳健日期解析：
// - 后端返回 ISO（可能带 Z / ±HH:MM）→ 原样按 UTC 解析
// - SQLite 风格 "YYYY-MM-DD HH:MM:SS"（iOS/Android WebView 不认空格分隔）→ 归一化后按 UTC 解析
// - 无法解析 → null（调用方自行降级展示原始串）
function parseDate(v) {
  if (!v) return null;
  if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
  const s = String(v).trim();
  // 捕获日期主体 + 可选时区后缀（Z / +08:00 / +0800 / -05:30）
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?\s*(Z|[+-]\d{2}:?\d{2})?$/i);
  if (m) {
    const tz = m[7] || 'Z';   // 无时区信息按 UTC 处理（与后端 UTC 存储一致）
    const sec = m[6] || '00';
    const d = new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${sec}${tz}`);
    if (!isNaN(d.getTime())) return d;
  }
  const d2 = new Date(s);
  return isNaN(d2.getTime()) ? null : d2;
}

function formatTime(iso, withYear = false) {
  if (!iso) return '';
  const d = parseDate(iso);
  if (!d) return String(iso).slice(0, 16);
  const ymd = withYear
    ? `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
    : `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return `${ymd} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function relativeTime(iso) {
  if (!iso) return '';
  const d = parseDate(iso);
  if (!d) return '';
  const diff = Date.now() - d.getTime();
  if (diff < 60 * 1000) return '刚刚';
  if (diff < 3600 * 1000) return `${Math.floor(diff / 60000)} 分钟前`;
  if (diff < 24 * 3600 * 1000) return `${Math.floor(diff / 3600000)} 小时前`;
  if (diff < 7 * 24 * 3600 * 1000) return `${Math.floor(diff / 86400000)} 天前`;
  return formatTime(iso, true);
}

// ---------- 任务状态 ----------
const TASK_STATUS = {
  pending: { text: '待审批', kind: 'warning' },
  approved: { text: '已放行', kind: 'info' },
  printing: { text: '打印中', kind: 'primary' },
  done: { text: '已完成', kind: 'success' },
  failed: { text: '失败', kind: 'danger' },
  rejected: { text: '已拒绝', kind: 'plain' },
  canceled: { text: '已取消', kind: 'plain' }
};
function taskStatus(s) {
  return TASK_STATUS[s] || { text: s || '未知', kind: 'plain' };
}

// ---------- 用户状态 ----------
const USER_STATUS = {
  pending: { text: '待审批', kind: 'warning' },
  approved: { text: '已授权', kind: 'success' },
  rejected: { text: '已拒绝', kind: 'plain' },
  blocked: { text: '已拉黑', kind: 'danger' }
};
function userStatus(s) {
  return USER_STATUS[s] || { text: s || '未知', kind: 'plain' };
}

// ---------- 打印机状态 ----------
// 后端 /api/mp/printers 与 /api/mp/admin/printers 的 state 是字符串：
//   idle（空闲）/ printing（打印中）/ stopped（已暂停/禁用）
// 同时兼容 CUPS 数字形态（3=idle 4=printing 5=stopped），以防后端切回数值。
function printerState(s) {
  const byName = {
    idle: { text: '空闲', kind: 'success' },
    printing: { text: '打印中', kind: 'primary' },
    stopped: { text: '已暂停', kind: 'danger' },
    processing: { text: '处理中', kind: 'primary' }
  };
  const byCode = {
    3: byName.idle, 4: byName.printing, 5: byName.stopped
  };
  const key = String(s == null ? '' : s).trim().toLowerCase();
  if (byName[key]) return byName[key];
  const num = Number(key);
  return byCode[num] || { text: key ? key : '未知', kind: 'plain' };
}

// ---------- 打印参数摘要 ----------
const MEDIA_TEXT = { A4: 'A4', A3: 'A3', A5: 'A5', A6: 'A6', Letter: 'Letter', Legal: 'Legal', B5: 'B5', '16K': '16K' };
const SIDES_TEXT = { 'one-sided': '单面', 'two-sided-long-edge': '双面长边', 'two-sided-short-edge': '双面短边' };
const SCALING_TEXT = { auto: '自动', fit: '适应', fill: '填充', none: '原始' };
const PAGE_SET_TEXT = { odd: '奇数页', even: '偶数页', 'even-reverse': '偶数倒序' };

function optionsSummary(o = {}) {
  const parts = [];
  parts.push(`${o.copies || 1} 份`);
  parts.push(o.color === 'color' ? '彩色' : '黑白');
  parts.push(SIDES_TEXT[o.sides] || '单面');
  if (o.media && o.media !== 'A4') parts.push(MEDIA_TEXT[o.media] || o.media);
  if (o.orientation === 'landscape') parts.push('横向');
  if (o.numberUp && o.numberUp > 1) parts.push(`每页 ${o.numberUp} 张`);
  if (o.pageRanges) parts.push(`页码 ${o.pageRanges}`);
  if (o.pageSet && PAGE_SET_TEXT[o.pageSet]) parts.push(PAGE_SET_TEXT[o.pageSet]);
  if (o.mirror) parts.push('镜像');
  if (o.pageBorder) parts.push('页边框');
  if (o.watermark) parts.push('水印');
  return parts.join(' · ');
}

function extOf(filename) {
  const m = String(filename || '').match(/\.([a-z0-9]+)$/i);
  return m ? m[1].toLowerCase() : '';
}

function fileKind(filename) {
  const e = extOf(filename);
  if (['jpg', 'jpeg', 'png', 'bmp', 'gif', 'tif', 'tiff', 'webp'].includes(e)) return 'image';
  if (e === 'pdf') return 'pdf';
  if (['doc', 'docx'].includes(e)) return 'doc';
  if (['xls', 'xlsx'].includes(e)) return 'xls';
  if (['ppt', 'pptx'].includes(e)) return 'ppt';
  if (e === 'txt') return 'txt';
  return 'other';
}

module.exports = {
  formatSize, formatTime, relativeTime, pad, parseDate,
  taskStatus, userStatus, printerState, optionsSummary,
  extOf, fileKind
};
