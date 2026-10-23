'use strict';
// 扫描仪（SANE / eSCL）：组件自检、设备枚举、参数读取、扫描到文件
//
// 「扫不出来」通常是三种不同的问题，接口要分开说清楚，否则用户只会看到一句通用的失败：
//   1) 容器里没有 scanimage（镜像构建时 sane-utils 没装上 / 没启用 community 仓库）
//   2) 有 scanimage 但 USB 没挂进容器（缺 --device /dev/bus/usb 或权限不足）
//   3) USB 可见但没有匹配的后端驱动（sane-find-scanner 看得到，scanimage -L 列不出）
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cups = require('./cups');
const config = require('./config');

const HINT_INSTALL = '容器内未安装扫描组件（sane）。镜像需启用 community 仓库后安装 sane + sane-utils（提供 scanimage），详见 docker-compose.yml 注释。';
const HINT_USB = '未发现扫描仪：USB 扫描仪需要把 /dev/bus/usb 挂进容器（docker run --device /dev/bus/usb 或 compose 的 devices），网络扫描仪需要与容器同网段（建议 network_mode: host）。';
const HINT_DRIVER = 'USB 上能看到设备，但 SANE 没有匹配到驱动：老机型可能不被 sane-backends 支持，网络一体机可尝试安装 sane-airscan 后在 airscan.conf 中手写设备地址。';

// 检测结果短时缓存，避免每次枚举都 spawn 一次 scanimage
let cache = { at: 0, data: null };
const CACHE_MS = 15000;

async function version() {
  const r = await cups.run('scanimage', ['--version'], { timeout: 5000 });
  if (!r.ok) return { ok: false, version: '', msg: HINT_INSTALL };
  const line = String(r.stdout || r.stderr || '').split(/\r?\n/).find((l) => /scanimage|backend/i.test(l)) || '';
  return { ok: true, version: line.trim(), msg: '' };
}

async function available() {
  const v = await version();
  return v.ok;
}

// 只看 USB 总线层面能不能看到设备，用来区分「没挂载」和「没驱动」
async function findUsb() {
  const r = await cups.run('sane-find-scanner', ['-q'], { timeout: 20000 });
  const text = `${r.stdout || ''}\n${r.stderr || ''}`;
  const hits = [];
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/found\s+(SCSI|USB)\s+scanner\s+(.+?)\s+at\s+(\S+)/i);
    if (m) hits.push({ bus: m[1].toUpperCase(), model: m[2].trim(), at: m[3] });
  }
  return { ok: r.ok, hits, raw: text.trim().slice(0, 2000) };
}

function parseDevices(text) {
  const out = [];
  for (const line of String(text).split(/\r?\n/)) {
    // 兼容两种引号：device `xxx' is a ... / device "xxx" is a ...
    const m = line.match(/^device\s+[`'"]([^'"]+)[`'"]\s+is\s+a\s+(.+)$/);
    if (m) out.push({ device: m[1], model: m[2].trim() });
  }
  return out;
}

async function listDevices(force = false) {
  if (!force && cache.data && Date.now() - cache.at < CACHE_MS) return cache.data;

  const v = await version();
  if (!v.ok) {
    cache = { at: Date.now(), data: { ok: false, msg: HINT_INSTALL, devices: [], sane: false } };
    return cache.data;
  }

  const r = await cups.run('scanimage', ['-L'], { timeout: 25000 });
  const devices = parseDevices(r.stdout || '');
  let data;
  if (devices.length) {
    data = { ok: true, sane: true, version: v.version, devices, msg: '' };
  } else {
    // 有组件没设备：再探一次 USB 总线，把「没挂载」和「没驱动」区分开
    const usb = await findUsb();
    data = {
      ok: true,
      sane: true,
      version: v.version,
      devices: [],
      usbSeen: usb.hits,
      msg: usb.hits.length ? HINT_DRIVER : HINT_USB
    };
  }
  cache = { at: Date.now(), data };
  return data;
}

function parseOptions(text) {
  const opts = [];
  const re = /^\s+--([a-zA-Z0-9_-]+)\s+(.*)$/;
  for (const line of String(text).split(/\r?\n/)) {
    const m = line.match(re);
    if (!m) continue;
    const raw = m[2];
    const bracket = raw.match(/\[([^\]]*)\]$/);
    const spec = bracket ? raw.slice(0, bracket.index).trim() : raw.trim();
    let values = [];
    if (/[|]/.test(spec.split('(')[0])) values = spec.split('(')[0].split('|').map((s) => s.trim()).filter(Boolean);
    const range = spec.match(/^(\d+)(?:\.\.(\d+))?(?:dpi)?/);
    if (!values.length && range && /dpi|px|mm/i.test(spec)) {
      values = range[2] ? [`${range[1]}`, `${range[2]}`] : [range[1]];
    }
    opts.push({ name: m[1], spec, values, current: bracket ? bracket[1] : '' });
  }
  return opts;
}

async function deviceOptions(device) {
  const v = await version();
  if (!v.ok) return { ok: false, msg: HINT_INSTALL, options: [] };
  if (!device) return { ok: false, msg: '缺少扫描设备', options: [] };
  const r = await cups.run('scanimage', ['-d', device, '-A'], { timeout: 25000 });
  if (!r.ok) return { ok: false, msg: '读取扫描参数失败：设备可能被占用或已断开', options: [] };
  return { ok: true, options: parseOptions(r.stdout), raw: (r.stdout + r.stderr).trim().slice(0, 4000) };
}

function pickValues(options, name) {
  const o = options.find((x) => x.name === name);
  return o ? o.values : [];
}

// 把 scanimage 的原始报错翻成能看懂的话
function translateError(text) {
  const t = String(text || '');
  if (/Access denied|permission denied|Operation not permitted/i.test(t)) {
    return '没有访问扫描仪的权限：请确认 /dev/bus/usb 已挂载且容器有读写权限';
  }
  if (/Device busy|resource busy/i.test(t)) return '扫描仪正忙：可能正在被其他任务占用，稍后再试';
  if (/out of paper|document feeder empty|no documents/i.test(t)) return '馈纸器里没有纸，请放入原稿后再扫描';
  if (/Invalid argument|unsupported|not supported/i.test(t)) {
    return '该设备不支持所选参数（分辨率/色彩/来源），请换一组参数重试';
  }
  if (/No such device|couldn't open|failed to open/i.test(t)) {
    return '打不开扫描仪：设备已断开或不是这个设备名，请重新检测';
  }
  if (/timed out|timeout/i.test(t)) return '扫描超时：设备响应过慢或原稿卡住，请检查扫描仪状态';
  return (t.split(/\r?\n/).filter(Boolean).slice(0, 3).join('；') || '扫描失败').slice(0, 300);
}

async function scan({ device, resolution = 300, mode = 'Color', source = '', format = 'jpeg', pages = 1 }) {
  if (!device) return { ok: false, msg: '缺少扫描设备' };
  const v = await version();
  if (!v.ok) return { ok: false, msg: HINT_INSTALL };
  try { fs.mkdirSync(config.scanDir, { recursive: true }); } catch (_) {}

  const id = crypto.randomBytes(8).toString('hex');
  const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const ext = format === 'png' ? 'png' : format === 'pdf' ? 'pdf' : 'jpg';
  const base = `scan_${ts}_${id}`;
  const outPath = path.join(config.scanDir, `${base}.${ext}`);
  const args = ['-d', device, '--resolution', String(Math.min(Math.max(parseInt(resolution, 10) || 300, 75), 1200))];
  if (mode) args.push('--mode', mode);
  if (source) args.push('--source', source);
  args.push('--format', ext === 'jpg' ? 'jpeg' : ext);
  if (ext === 'pdf') {
    // scanimage 原生不支持 PDF，先出图再由.img2pdf/gs 合成；没有转换工具时退回图片
    args[args.length - 1] = 'png';
  }
  const batch = Math.min(Math.max(parseInt(pages, 10) || 1, 1), 20);
  if (batch > 1) args.push(`--batch=${path.join(config.scanDir, base)}-%02d.${ext === 'pdf' ? 'png' : ext}`);
  else args.push('-o', ext === 'pdf' ? path.join(config.scanDir, `${base}.png`) : outPath);

  const r = await cups.run('scanimage', args, { timeout: 240000 });
  if (!r.ok) return { ok: false, msg: translateError(`${r.stderr || ''} ${r.error || ''}`) };

  let files = fs.readdirSync(config.scanDir)
    .filter((f) => f.startsWith(base))
    .map((f) => {
      const p = path.join(config.scanDir, f);
      const st = fs.statSync(p);
      return { filename: f, path: p, size: st.size, mime: 'image/png' };
    });

  if (ext === 'pdf' && files.length) {
    const pdfPath = path.join(config.scanDir, `${base}.pdf`);
    const inputs = files.map((f) => f.path).sort();
    const conv = await cups.run('convert', [...inputs, pdfPath], { timeout: 120000 }).catch(() => ({ ok: false }));
    if (!conv.ok) {
      // 没有 imagemagick 时退回 PNG，并告诉前端实际拿到的格式
      return { ok: true, files, base, note: '容器缺少 imagemagick，已改为输出 PNG' };
    }
    files = [{ filename: `${base}.pdf`, path: pdfPath, size: fs.statSync(pdfPath).size, mime: 'application/pdf' }];
  }

  return { ok: true, files, base };
}

module.exports = { available, version, findUsb, listDevices, deviceOptions, scan, pickValues, translateError, HINT_INSTALL, HINT_USB, HINT_DRIVER };
