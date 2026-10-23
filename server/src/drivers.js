'use strict';
// 驱动中心：本地 PPD 目录、推荐驱动、在线驱动库（OpenPrinting）、URL 下载、本地上传。
// 目标：扫描到打印机后能直接给出可用驱动，避免「队列建了但打印不出来」。
const fs = require('fs');
const path = require('path');
const os = require('os');
const zlib = require('zlib');
const dns = require('dns').promises;
const crypto = require('crypto');
const { execFile } = require('child_process');
const config = require('./config');
const cups = require('./cups');
const orphans = require('./orphans');

const driversDir = path.join(config.dataDir, 'drivers');
try { fs.mkdirSync(driversDir, { recursive: true }); } catch (_) {}

const ONLINE_BASE = 'https://www.openprinting.org/download/PPD';
const ONLINE_TTL = 60 * 60 * 1000;
const MAX_DRIVER_BYTES = 30 * 1024 * 1024;

let localCache = { at: 0, list: [] };
let vendorCache = { at: 0, list: [] };
const indexCache = new Map(); // vendor -> {at, files:[{name,url}]}

function run(cmd, args, timeout = 30000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, LC_ALL: 'C' } },
      (err, stdout, stderr) => resolve({
        ok: !err, stdout: String(stdout || ''), stderr: String(stderr || ''), error: err ? err.message : ''
      }));
  });
}

// ---------- 本地 PPD 目录 ----------
async function listLocal() {
  if (Date.now() - localCache.at < 5 * 60000 && localCache.list.length) return localCache.list;
  const r = await run('lpinfo', ['-m'], 40000);
  const list = [];
  for (const line of r.stdout.split(/\r?\n/)) {
    const raw = line.trim();
    if (!raw || /^lpinfo:/.test(raw)) continue;
    const idx = raw.indexOf(' ');
    if (idx < 0) continue;
    const id = raw.slice(0, idx).trim();
    const label = raw.slice(idx + 1).trim();
    if (!id || !label) continue;
    if (/^(raw|everywhere)$/i.test(id)) continue;
    list.push({ id, label, short: shortLabel(label) });
  }
  localCache = { at: Date.now(), list };
  return list;
}

function shortLabel(label) {
  return String(label || '').replace(/\s+/g, ' ').slice(0, 80);
}

function norm(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

async function searchLocal(q, limit = 60) {
  const list = await listLocal();
  const tokens = norm(q).split(' ').filter((t) => t.length > 1);
  const builtin = [
    { id: 'everywhere', label: 'IPP Everywhere（免驱，适用于支持 IPP/AirPrint 的机型）', short: 'IPP Everywhere 免驱', builtin: true },
    { id: 'raw', label: 'RAW 直通（不做任何转换，适用于设备自带驱动或 PCL/PS 原生直通）', short: 'RAW 直通', builtin: true }
  ];
  const all = [...builtin, ...list];
  if (!tokens.length) return all.slice(0, limit);
  const scored = [];
  for (const item of all) {
    const hay = norm(`${item.label} ${item.id}`);
    let score = 0;
    for (const t of tokens) if (hay.includes(t)) score += t.length;
    if (score) scored.push({ ...item, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

// ---------- 已下载 / 上传的驱动 ----------
function storedDrivers() {
  let files = [];
  try { files = fs.readdirSync(driversDir).filter((f) => /\.ppd$/i.test(f)); } catch (_) { return []; }
  return files.map((f) => {
    const full = path.join(driversDir, f);
    let meta = {};
    try { meta = JSON.parse(fs.readFileSync(`${full}.json`, 'utf8')); } catch (_) {}
    let size = 0;
    try { size = fs.statSync(full).size; } catch (_) {}
    return {
      id: `ppd:${full}`,
      file: f,
      label: meta.label || f.replace(/\.ppd$/i, ''),
      short: meta.label || f.replace(/\.ppd$/i, ''),
      source: meta.source || '本地文件',
      url: meta.url || '',
      size,
      at: meta.at || ''
    };
  }).sort((a, b) => String(b.at).localeCompare(String(a.at)));
}

function validatePpd(text) {
  const head = String(text).slice(0, 4096);
  return /\*PPD-Adobe/i.test(head) || /\*OpenUI/i.test(text) || /\*cupsFilter/i.test(text);
}

function safeName(name) {
  const base = String(name || 'driver').replace(/\.ppd(\.gz)?$/i, '').replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 48);
  return base || 'driver';
}

function savePpd(text, { label, source, url }) {
  const id = `${safeName(label)}-${crypto.randomBytes(3).toString('hex')}`;
  const file = path.join(driversDir, `${id}.ppd`);
  fs.writeFileSync(file, text);
  fs.writeFileSync(`${file}.json`, JSON.stringify({
    label: label || id, source: source || '', url: url || '', at: new Date().toISOString()
  }));
  return { id: `ppd:${file}`, file: `${id}.ppd`, label: label || id, source: source || '', url: url || '' };
}

function removeStored(id) {
  const file = String(id || '').replace(/^ppd:/, '');
  if (!require('./fsutil').isInside(driversDir, file)) return { ok: false, msg: '非法的驱动路径' };
  try {
    fs.unlinkSync(file);
  } catch (e) {
    return { ok: false, msg: e.message };
  }
  // 主文件删掉了，辅助 json 删不掉只留个孤儿文件——登记后由清理任务重试，不影响删除结果
  try { fs.unlinkSync(`${file}.json`); } catch (_) { orphans.add(`${file}.json`); }
  return { ok: true };
}

// ---------- 压缩包解包（.gz / .tar.gz / .zip） ----------
function extractPpdFromBuffer(buf, filename, unzipTo) {
  const name = String(filename || '').toLowerCase();
  const isGzip = buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b;
  if (buf.length > 4 && buf[0] === 0x50 && buf[1] === 0x4b) {
    // zip：交给容器内的 unzip（Dockerfile 已安装）
    return { needUnzip: true, path: unzipTo };
  }
  let data = buf;
  if (isGzip) {
    try { data = zlib.gunzipSync(buf, { maxOutputLength: 64 * 1024 * 1024 }); } catch (e) {
      return { error: `解压失败：${e.message}` };
    }
  }
  const asText = data.toString('utf8');
  if (validatePpd(asText)) return { text: asText };
  // tar（未压缩或已 gunzip）：手工扫 512 字节块找 *.ppd
  if (data.length > 512 && (data.slice(257, 262).toString() === 'ustar' || name.endsWith('.tar'))) {
    let off = 0;
    while (off + 512 <= data.length) {
      const header = data.slice(off, off + 512);
      if (header.every((b) => b === 0)) break;
      const fname = header.slice(0, 100).toString('utf8').replace(/\0.*$/, '').trim();
      const sizeStr = header.slice(124, 136).toString('utf8').replace(/\0.*$/, '').trim();
      const size = parseInt(sizeStr, 8) || 0;
      const body = data.slice(off + 512, off + 512 + size);
      if (/\.ppd$/i.test(fname) && validatePpd(body.toString('utf8'))) {
        return { text: body.toString('utf8'), innerName: path.basename(fname) };
      }
      off += 512 + Math.ceil(size / 512) * 512;
    }
  }
  if (validatePpd(asText)) return { text: asText };
  return { error: '文件里没有可识别的 PPD（不是 PDF/PostScript 打印机驱动）' };
}

function privateIp(ip) {
  if (!ip) return true;
  const v4 = String(ip).replace(/^::ffff:/, '');
  if (/^127\./.test(v4) || /^10\./.test(v4) || /^192\.168\./.test(v4) || /^169\.254\./.test(v4)) return true;
  const m = v4.match(/^172\.(\d+)\./);
  if (m && Number(m[1]) >= 16 && Number(m[1]) <= 31) return true;
  if (v4 === '0.0.0.0' || v4 === '::1') return true;
  if (/^f[cd][0-9a-f]{2}:/i.test(v4) || /^fe80:/i.test(v4)) return true;
  return false;
}

// 下载保护：只允许 http/https，限制大小/超时/跳转，默认禁止访问内网地址（防 SSRF）
async function safeFetch(url, { maxBytes = MAX_DRIVER_BYTES, timeout = 30000, allowPrivate = false } = {}) {
  let current = String(url || '').trim();
  for (let hop = 0; hop < 4; hop++) {
    let u;
    try { u = new URL(current); } catch (_) { return { ok: false, error: '地址格式不正确（需以 http:// 或 https:// 开头）' }; }
    if (!/^https?:$/.test(u.protocol)) return { ok: false, error: '只支持 http / https 地址' };
    if (!allowPrivate) {
      let ip = u.hostname;
      if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) {
        try { ip = (await dns.lookup(ip)).address; } catch (e) { return { ok: false, error: `域名解析失败：${e.message}` }; }
      }
      if (privateIp(ip)) return { ok: false, error: '出于安全考虑，不允许从内网地址下载（如需请设置 PG_ALLOW_PRIVATE_DRIVER_URL=1）' };
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    try {
      const res = await fetch(current, { signal: ctrl.signal, redirect: 'manual' });
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get('location');
        if (!loc) return { ok: false, error: '重定向缺少 Location' };
        current = new URL(loc, current).toString();
        continue;
      }
      if (!res.ok) return { ok: false, error: `下载失败：HTTP ${res.status}` };
      const len = Number(res.headers.get('content-length') || 0);
      if (len && len > maxBytes) return { ok: false, error: `文件超过 ${Math.round(maxBytes / 1024 / 1024)} MB 限制` };
      // 边读边计数：先 arrayBuffer() 再判大小的话，对方不给 content-length 就能把内存打爆
      const reader = res.body.getReader();
      const parts = [];
      let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.length;
        if (total > maxBytes) {
          try { await reader.cancel(); } catch (_) {}
          return { ok: false, error: `文件超过 ${Math.round(maxBytes / 1024 / 1024)} MB 限制` };
        }
        parts.push(Buffer.from(value));
      }
      const buf = Buffer.concat(parts);
      // 下载前后各解析一次：域名解析被人为翻转（DNS rebinding）时这里会不一致
      if (!allowPrivate) {
        let ip2 = '';
        try { ip2 = (await dns.lookup(new URL(current).hostname)).address; } catch (_) {}
        if (ip2 && privateIp(ip2)) return { ok: false, error: '下载过程中目标地址解析到了内网，已中止' };
      }
      return { ok: true, buf, url: current };
    } catch (e) {
      return { ok: false, error: e.name === 'AbortError' ? '下载超时' : `下载失败：${e.message}` };
    } finally {
      clearTimeout(timer);
    }
  }
  return { ok: false, error: '重定向次数过多' };
}

async function unzipPpd(buf) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pgdrv-'));
  const zipPath = path.join(tmpDir, 'pkg.zip');
  fs.writeFileSync(zipPath, buf);
  try {
    // 先读清单：几百 KB 的 zip 可以解出几十 GB，必须先拦
    const listR = await run('unzip', ['-l', zipPath], 20000);
    const lines = String(listR.stdout || '').split(String.fromCharCode(10));
    let count = 0;
    let bytes = 0;
    for (const raw of lines) {
      const t = raw.trim();
      if (!t || t.charCodeAt(0) < 48 || t.charCodeAt(0) > 57) continue;
      const cols = t.split(' ').filter(Boolean);
      const size = Number(cols[0]);
      const name = Number(cols[1]);
      if (Number.isFinite(size) && Number.isFinite(name)) { count += 1; bytes += size; }
    }
    if (count > 500 || bytes > 200 * 1024 * 1024) {
      return { error: `压缩包过大（${count} 个文件 / ${Math.round(bytes / 1048576)} MB），已拒绝解包` };
    }
    await run('unzip', ['-o', '-q', zipPath, '-d', tmpDir], 40000);
    const stack = [tmpDir];
    let found = null;
    while (stack.length && !found) {
      const dir = stack.pop();
      for (const f of fs.readdirSync(dir)) {
        const full = path.join(dir, f);
        let st;
        try { st = fs.statSync(full); } catch (_) { continue; }
        if (st.isDirectory()) stack.push(full);
        else if (/\.ppd$/i.test(f)) { found = full; break; }
        else if (/\.ppd\.gz$/i.test(f)) {
          try {
            const text = zlib.gunzipSync(fs.readFileSync(full)).toString('utf8');
            if (validatePpd(text)) { found = full; break; }
          } catch (_) {}
        }
      }
    }
    if (!found) return { error: '压缩包里没有 .ppd 文件（厂商驱动包通常是 exe，请在系统里解出 PPD 后上传）' };
    let text;
    if (/\.gz$/i.test(found)) text = zlib.gunzipSync(fs.readFileSync(found)).toString('utf8');
    else text = fs.readFileSync(found, 'utf8');
    if (!validatePpd(text)) return { error: '包内的 PPD 文件无效' };
    return { text, innerName: path.basename(found) };
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  }
}

// ---------- 在线驱动库（OpenPrinting PPD 镜像） ----------
function parseLinks(html, filter) {
  const out = [];
  const re = /href="([^"]+)"/g;
  let m;
  while ((m = re.exec(html))) {
    const href = m[1];
    if (/^\?/.test(href) || href.startsWith('/') || href.startsWith('http')) continue;
    if (filter(href)) out.push(decodeURIComponent(href));
  }
  return out;
}

async function onlineVendors() {
  if (Date.now() - vendorCache.at < ONLINE_TTL && vendorCache.list.length) return vendorCache.list;
  // 国内网络首次 TLS 握手偶尔超时：失败重试一次，两边都失败才判定为不可用
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await safeFetch(`${ONLINE_BASE}/`, { maxBytes: 2 * 1024 * 1024, timeout: 25000 });
    if (r.ok) {
      const html = r.buf.toString('utf8');
      const list = parseLinks(html, (h) => /\/$/.test(h) && !/^(Parent|\.\.)/i.test(h))
        .map((h) => h.replace(/\/$/, ''))
        .filter((v) => /^[A-Za-z0-9_.-]{1,40}$/.test(v));
      vendorCache = { at: Date.now(), list: [...new Set(list)] };
      return vendorCache.list;
    }
    if (attempt === 0) await new Promise((res) => setTimeout(res, 600));
  }
  return [];
}

async function vendorFiles(vendor) {
  const cached = indexCache.get(vendor);
  if (cached && Date.now() - cached.at < ONLINE_TTL) return cached.files;
  const url = `${ONLINE_BASE}/${encodeURIComponent(vendor)}/`;
  const r = await safeFetch(url, { maxBytes: 8 * 1024 * 1024, timeout: 25000 });
  if (!r.ok) return [];
  const files = parseLinks(r.buf.toString('utf8'), (h) => /\.ppd(\.gz)?$/i.test(h))
    .map((h) => ({ name: h, url: `${url}${encodeURIComponent(h)}` }));
  indexCache.set(vendor, { at: Date.now(), files });
  return files;
}

async function onlineSearch(q, vendor = '') {
  const tokens = norm(q).split(' ').filter((t) => t.length > 1);
  // 只选厂商不填关键词时，直接列出该厂商全部机型，方便手动翻找
  if (!tokens.length && vendor) {
    const files = await vendorFiles(vendor);
    return {
      ok: true, total: files.length, vendors: 1,
      items: files.slice(0, 80).map((f) => ({
        name: f.name.replace(/\.ppd(\.gz)?$/i, '').replace(/_/g, ' '),
        file: f.name, vendor, url: f.url
      }))
    };
  }
  if (!tokens.length) return { ok: false, msg: '请输入型号关键词，例如 officejet 9100' };
  const vendors = vendor ? [vendor] : await onlineVendors();
  if (!vendors.length) {
    return {
      ok: false,
      msg: '无法连接 OpenPrinting 驱动库（容器可能无外网）。可改为「按 URL 下载」或上传 PPD 文件。'
    };
  }
  const batches = await Promise.all(vendors.slice(0, 40).map(async (v) => {
    const files = await vendorFiles(v);
    return files.map((f) => ({ ...f, vendor: v }));
  }));
  const flat = batches.flat();
  const scored = [];
  for (const f of flat) {
    const hay = norm(f.name);
    let score = 0;
    for (const t of tokens) if (hay.includes(t)) score += t.length;
    if (score) scored.push({ ...f, score });
  }
  scored.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  return {
    ok: true,
    total: flat.length,
    vendors: vendors.length,
    items: scored.slice(0, 60).map((f) => ({
      name: f.name.replace(/\.ppd(\.gz)?$/i, '').replace(/_/g, ' '),
      file: f.name, vendor: f.vendor, url: f.url
    }))
  };
}

// 下载并入库：支持直链 PPD / .gz / .tar.gz / .zip，也支持 OpenPrinting 站内文件
async function downloadToStore(url, label) {
  const r = await safeFetch(url, { allowPrivate: process.env.PG_ALLOW_PRIVATE_DRIVER_URL === '1' });
  if (!r.ok) return { ok: false, msg: r.error };
  const guessName = decodeURIComponent(String(url).split('/').pop() || 'driver.ppd');
  let extracted = extractPpdFromBuffer(r.buf, guessName);
  if (extracted.needUnzip) extracted = await unzipPpd(r.buf);
  if (extracted.error) return { ok: false, msg: extracted.error };
  const saved = savePpd(extracted.text, {
    label: label || extracted.innerName || guessName.replace(/\.ppd(\.gz)?$/i, ''),
    source: '在线下载', url
  });
  return { ok: true, driver: saved };
}

function saveUploaded(file, label) {
  let buf;
  try { buf = fs.readFileSync(file.path); } catch (e) { return { ok: false, msg: `读取上传文件失败：${e.message}` }; }
  const extracted = extractPpdFromBuffer(buf, file.originalname);
  if (extracted.error && !extracted.needUnzip) return { ok: false, msg: extracted.error };
  return { ok: true, pending: buf, filename: file.originalname };
}

async function saveUploadedFull(file, label) {
  const r = saveUploaded(file, label);
  if (!r.ok) return r;
  let extracted = r.pending ? extractPpdFromBuffer(r.pending, r.filename) : { error: '空文件' };
  if (extracted.needUnzip) extracted = await unzipPpd(r.pending);
  if (extracted.error) return { ok: false, msg: extracted.error };
  const saved = savePpd(extracted.text, {
    label: label || extracted.innerName || r.filename,
    source: '手动上传'
  });
  return { ok: true, driver: saved };
}

// ---------- 驱动推荐 ----------
function parseDeviceId(deviceId) {
  const out = {};
  for (const part of String(deviceId || '').split(';')) {
    const idx = part.indexOf(':');
    if (idx <= 0) continue;
    out[part.slice(0, idx).trim().toUpperCase()] = part.slice(idx + 1).trim();
  }
  return out;
}

function isColorDevice(device, modelText) {
  if (device && device.color === false) return false;
  return /colou?r|彩色/i.test(`${modelText || ''} ${(device && device.model) || ''}`);
}

// 根据设备信息给出推荐驱动：能免驱就免驱，其次按 device-id 的 PDL 选通用驱动，最后 raw
async function recommend(device = {}) {
  const model = String(device.model || '');
  const deviceId = parseDeviceId(device.deviceId);
  const cmd = `${deviceId.CMD || ''}`.toUpperCase();
  const modelText = `${model} ${deviceId.MDL || ''} ${deviceId.MFG || ''}`.trim();
  const local = await listLocal();
  const out = { alternatives: [] };
  const pushAlt = (id, label, reason, confidence) => out.alternatives.push({ id, label, reason, confidence });

  const isIpp = device.kind === 'ipp' || /^(ipp|ipps):/i.test(device.uri || '');
  const color = isColorDevice(device, modelText);

  // 1) 型号能匹配到本地具体 PPD，优先用它（最精确）
  const tokens = norm(modelText).split(' ').filter((t) => t.length > 2 && !/^(printer|series|laserjet|officejet)$/.test(t));
  if (tokens.length >= 1) {
    const scored = [];
    for (const item of local) {
      const hay = norm(`${item.label} ${item.id}`);
      let score = 0;
      for (const t of tokens) if (hay.includes(t)) score += t.length;
      // 颜色不一致的降权
      if (score && isColorDevice(null, item.label) !== color) score -= 3;
      if (score > 0) scored.push({ item, score });
    }
    scored.sort((a, b) => b.score - a.score);
    if (scored.length) {
      const best = scored[0];
      out.id = best.item.id;
      out.label = best.item.label;
      out.source = '本地驱动库（型号匹配）';
      out.confidence = 'high';
      out.reason = '从打印机上报的型号匹配到同名 PPD';
      for (const s of scored.slice(1, 4)) pushAlt(s.item.id, s.item.label, '型号相近', 'medium');
    }
  }

  // 2) IPP/PWG 设备用 everywhere 免驱（PWG Raster/URF 是硬指标，只有 PDF 时降级为「尝试」）
  if (!out.id && isIpp && device.driverless) {
    out.id = 'everywhere';
    out.label = 'IPP Everywhere（免驱）';
    out.source = '免驱（IPP Everywhere）';
    out.confidence = 'high';
    out.reason = '设备声明支持 PWG Raster / URF，无需额外驱动';
  }
  // 2b) 只支持 PDF 的 IPP 设备：可以试免驱，但优先级低于型号匹配
  if (!out.id && isIpp && (device.pdf || /pdf/i.test((device.formats || []).join(',')))) {
    out.id = 'everywhere';
    out.label = 'IPP Everywhere（免驱，设备仅声明 PDF）';
    out.source = '免驱（PDF 直传）';
    out.confidence = 'medium';
    out.reason = '设备支持 PDF 直传，可先按免驱尝试';
  }

  // 3) 按 PDL 选通用驱动。注意不能硬编码 drv:/// 路径：不同 CUPS 打包方式下
  //    通用驱动的 ID 可能是 lsb/usr/cupsfilters/pxlmono.ppd 或 drv:///sample.drv/*.ppd，
  //    写错会直接报 "PPD not found"。这里从 lpinfo -m 的实际列表里按名字挑。
  const pickLocal = (patterns) => {
    for (const re of patterns) {
      const hit = local.find((x) => re.test(x.id) || re.test(x.label));
      if (hit) return hit;
    }
    return null;
  };
  if (!out.id) {
    let hit = null;
    let label = '';
    let reason = '';
    if (/PCLXL|PCL6|PCL-6|PCL 6/.test(cmd)) {
      hit = pickLocal(color ? [/pxlcolor/i, /PCL 6.*Color/i] : [/pxlmono/i, /PCL 6/i]);
      label = color ? 'PCL 6/XL 彩色通用驱动' : 'PCL 6/XL 黑白通用驱动';
      reason = `设备声明支持 ${deviceId.CMD}，用 PCL 通用驱动`;
    } else if (/POSTSCRIPT|^PS/.test(cmd)) {
      hit = pickLocal([/sample\.drv\/generic\.ppd/, /Generic PostScript/i]);
      label = 'Generic PostScript 驱动';
      reason = '设备声明支持 PostScript';
    } else if (/PCL5|PCL-5/.test(cmd)) {
      hit = pickLocal([/sample\.drv\/laserjet\.ppd/, /HP LaserJet Series PCL 4\/5/i, /generpcl/i]);
      label = 'PCL 5 通用激光驱动';
      reason = `设备声明支持 ${deviceId.CMD}`;
    }
    if (hit) {
      out.id = hit.id;
      out.label = `${label}（${hit.label}）`;
      out.source = '通用驱动（按 device-id 推断）';
      out.confidence = 'medium';
      out.reason = reason;
    }
  }

  // 4) IPP 但没拿到属性：先试 everywhere，失败再说
  if (!out.id && isIpp) {
    out.id = 'everywhere';
    out.label = 'IPP Everywhere（免驱，未确认设备能力）';
    out.source = '免驱（推测）';
    out.confidence = 'low';
    out.reason = '设备 631/443 上有 IPP 服务，先按免驱尝试';
  }

  // 5) 都不行 → RAW
  if (!out.id) {
    out.id = 'raw';
    out.label = 'RAW 直通（不做转换）';
    out.source = 'RAW';
    out.confidence = 'low';
    out.reason = /^(socket|lpd):/i.test(device.uri || '')
      ? '设备只开放 RAW/LPD 端口，需要打印机自带 PCL/PS 解释器'
      : '未识别到设备支持的页面描述语言，先用 RAW 占位';
  }

  if (out.id !== 'everywhere' && isIpp) {
    pushAlt('everywhere', 'IPP Everywhere（免驱）', '同样适用 IPP 设备', 'medium');
  }
  if (out.id !== 'raw') pushAlt('raw', 'RAW 直通', '驱动不匹配时的兜底', 'low');
  return out;
}

// ---------- 用 driverless 现场生成免驱 PPD ----------
// 背景：部分打印机固件（实测 Canon MF650C Series）把 IPP 的 naturalLanguage 返回成
// 非法的 "en-  "，CUPS 调度器在「免驱自动查属性」那条路上会拒收整条响应，
// 于是 lpadmin -m everywhere 建不了队列，用户只能退回 RAW 直通、丢掉彩色等选项。
// 而 cups-filters 自带的 driverless 工具解析宽松，能正常拿到打印机能力并生成 PPD。
// 这里直接调用它，把结果存成本地驱动；用户选它建队列即可
// （IPP 打印后端不校验这个值，彩色/双面/纸盒等选项都能随作业正常下发）。
async function generateDriverless(uri, label) {
  const u = String(uri || '').trim();
  if (!/^(ipp|ipps|dnssd):\/\//i.test(u)) {
    return { ok: false, msg: '只有 ipp:// 、ipps:// 、dnssd:// 地址能生成免驱驱动' };
  }
  const r = await run('driverless', [u], 90000);
  if (!r.ok || !r.stdout || !r.stdout.trim()) {
    const first = String(r.stderr || r.error || '').trim().split(/\r?\n/)[0];
    return { ok: false, msg: `生成失败：${first ? first.slice(0, 160) : 'driverless 没有输出'}` };
  }
  const text = r.stdout;
  if (!validatePpd(text)) return { ok: false, msg: 'driverless 没有返回有效的 PPD 内容' };
  const nick = (text.match(/^\*NickName:\s*"?([^"\r\n]+)"?/mi) || [])[1];
  const saved = savePpd(text, {
    label: label || `${(nick || u).trim()}（免驱生成）`,
    source: 'driverless 生成'
  });
  return { ok: true, driver: saved };
}

module.exports = {
  driversDir,
  listLocal,
  searchLocal,
  storedDrivers,
  removeStored,
  recommend,
  downloadToStore,
  saveUploadedFull,
  generateDriverless,
  extractPpdFromBuffer,
  onlineVendors,
  onlineSearch,
  validatePpd,
  MAX_DRIVER_BYTES
};
