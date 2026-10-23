'use strict';
// 打印机自动发现：mDNS(AirPrint) + CUPS 设备枚举 + 网段主动探测（含真实 IPP 握手）
//
// 这里修掉三个导致「内网打印机扫不到 / 加了用不了」的根本问题：
//   1. 原实现「快速扫描」完全不探测网段，只靠 mDNS + lpinfo。容器在桥接网络下收不到
//      局域网组播，lpinfo 也只反映容器内后端 → 必然 0 结果。现在快速扫描也会扫描
//      已保存的局域网网段（仅 631/9100，短超时）。
//   2. 原实现只探测 631/9100。只开 443(IPPS) 或 515(LPD) 的机器会被漏掉。
//   3. 原实现把 IPP 资源路径硬编码成 /ipp/print，且不做 IPP 握手，型号/设备 ID 全空，
//      队列建好后打印 404。现在对 631/443 做真实 Get-Printer-Attributes，逐一试
//      /ipp/print、/ipp/printer、/ 等路径，拿到真实型号与 device-id 供驱动推荐。
const net = require('net');
const os = require('os');
const crypto = require('crypto');
const cups = require('./cups');
const ipp = require('./ipp');
const { getSetting, setSetting } = require('./db');

const sessions = new Map();
const SCAN_DEADLINE_MS = 180000;

function newSession(mode) {
  const id = crypto.randomBytes(8).toString('hex');
  const s = {
    id, mode, status: 'running', progress: 0, stage: '准备扫描',
    found: [], error: '', scanned: 0, total: 0,
    startedAt: Date.now(), finishedAt: 0
  };
  sessions.set(id, s);
  setTimeout(() => sessions.delete(id), 30 * 60000).unref();
  return s;
}

function getSession(id) { return sessions.get(id) || null; }

// 是否已有正在进行的扫描会话：多次点击 / 自动重扫会叠加多个 180s 会话，
// 每个会话最多 48~64 并发探测，叠加起来会打爆文件描述符与 CPU。
function hasRunningScan() {
  for (const s of sessions.values()) if (s.status === 'running') return s;
  return null;
}

function hostOf(uri) {
  if (!uri) return '';
  const m = String(uri).match(/^[a-z+]+:\/\/(?:[^@/]*@)?(\[[^\]]+\]|[^:/?#]+)/i);
  return m ? m[1].replace(/^\[|\]$/g, '') : '';
}

// 同一台机器可能同时通过 mDNS、631、9100 被发现：按 host 合并，避免列表里出现 3 条。
function pushDevice(s, item) {
  const host = item.host || '';
  const existing = s.found.find((f) => f.host === host);
  if (existing) {
    for (const u of [item.uri, ...(item.altUris || [])]) {
      if (u && !existing.altUris.includes(u) && u !== existing.uri) existing.altUris.push(u);
    }
    if (!existing.name && item.name) existing.name = item.name;
    if (!existing.model && item.model) existing.model = item.model;
    if (!existing.deviceId && item.deviceId) existing.deviceId = item.deviceId;
    if (item.driverless) existing.driverless = true;
    if (item.pathConfidence && !existing.pathConfidence) existing.pathConfidence = item.pathConfidence;
    if (item.ports) existing.ports = [...new Set([...(existing.ports || []), ...item.ports])];
    // IPP 比 socket 更适合做队列地址，若新条目是 IPP 而旧条目不是则替换
    if (item.kind === 'ipp' && existing.kind !== 'ipp') {
      existing.kind = 'ipp';
      existing.uri = item.uri;
      existing.method = item.method;
      existing.source = item.source;
    }
    return existing;
  }
  const dev = {
    host, port: item.port || 0, kind: item.kind, name: item.name || host,
    model: item.model || '', note: item.note || '', uri: item.uri,
    altUris: item.altUris || [], driverless: !!item.driverless,
    source: item.source, method: item.method || '',
    deviceId: item.deviceId || '', ports: item.ports || [], pathConfidence: item.pathConfidence || ''
  };
  s.found.push(dev);
  return dev;
}

// ---------- mDNS / Avahi ----------
async function browseAvahi() {
  const r = await cups.run('avahi-browse', ['-artp', '_ipp._tcp,_ipps._tcp,_printer._tcp'], { timeout: 9000 });
  if (!r.ok) return [];
  const out = [];
  for (const line of r.stdout.split(/\r?\n/)) {
    if (!line.startsWith('=')) continue;
    const f = line.split(';');
    if (f.length < 10) continue;
    const name = f[3];
    const type = f[4];
    const addr = f[7];
    const port = parseInt(f[8], 10) || 631;
    const txt = f.slice(9).join(';');
    if (!addr) continue;
    const note = (txt.match(/note=([^"]+)/) || [])[1] || '';
    const model = (txt.match(/ty=([^"]+)/) || [])[1] || '';
    const rp = (txt.match(/rp=([^"]+)/) || [])[1] || 'ipp/print';
    const scheme = type.startsWith('_ipps') ? 'ipps' : 'ipp';
    const cleanRp = rp.replace(/^\//, '');
    out.push({
      host: addr, port, kind: 'mdns', name,
      model: model || name, note,
      uri: `${scheme}://${addr}:${port}/${cleanRp}`,
      driverless: true, source: 'AirPrint / mDNS',
      method: type.replace(/^_|\._tcp$/g, ''), ports: [port]
    });
  }
  return out;
}

// ---------- CUPS 已发现设备 ----------
async function cupsDevices() {
  const { devices } = await cups.listDevices();
  return devices.map((d) => {
    const isUsb = d.uri.startsWith('usb://');
    let host = hostOf(d.uri);
    if (!host && d.uri.startsWith('dnssd://')) {
      host = decodeURIComponent(d.uri.slice(8).split('.')[0] || '');
    }
    if (!host && isUsb) host = d.uri.slice(6).split('?')[0];
    const friendly = d.name
      || (d.uri.startsWith('dnssd://') ? decodeURIComponent(d.uri.slice(8).split('._')[0]) : '')
      || host || d.uri;
    return {
      host, port: 0, kind: isUsb ? 'usb' : 'cups', name: friendly,
      model: d.uri.startsWith('dnssd://') ? '通过 mDNS 发现的网络打印机' : '',
      note: '', uri: d.uri, driverless: !!d.driverless,
      source: isUsb ? 'USB 直连' : 'CUPS 设备枚举',
      method: d.class, ports: []
    };
  });
}

// ---------- 网段 ----------
function ipList(cidr) {
  const m = String(cidr || '').trim().match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/);
  if (!m) return [];
  const [a, b, c, d, prefix] = m.slice(1).map(Number);
  if ([a, b, c, d].some((x) => x > 255) || prefix > 32 || prefix < 22) return [];
  const base = ((a << 24) | (b << 16) | (c << 8) | d) >>> 0;
  const size = 2 ** (32 - prefix);
  const mask = size >= 2 ** 32 ? 0 : (~(size - 1) >>> 0);
  const network = (base & mask) >>> 0;
  const hosts = [];
  for (let i = network + 1; i < network + size - 1 && hosts.length < 1022; i++) {
    hosts.push([(i >>> 24) & 255, (i >>> 16) & 255, (i >>> 8) & 255, i & 255].join('.'));
  }
  return hosts;
}

function parseCidrs(input) {
  const list = String(input || '').split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean);
  const out = [];
  for (const one of list) {
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(one)) out.push(`${one}/32`);
    else if (/^\d{1,3}(\.\d{1,3}){3}\/\d{1,2}$/.test(one)) out.push(one);
    else if (/^[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(one)) out.push(one);
  }
  return out.slice(0, 6);
}

function tcpProbe(host, port, timeout = 1200) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(timeout);
    sock.once('connect', () => finish(true));
    sock.once('timeout', () => finish(false));
    sock.once('error', () => finish(false));
    sock.connect(port, host);
  });
}

async function pool(items, limit, worker, deadline) {
  let idx = 0;
  const runners = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    while (idx < items.length) {
      if (Date.now() > deadline) return;
      const i = idx++;
      try { await worker(items[i]); } catch (_) { /* 单点失败忽略 */ }
    }
  });
  await Promise.all(runners);
}

function selfHosts() {
  const set = new Set(['127.0.0.1', '::1', 'localhost']);
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list || []) if (ni.family === 'IPv4') set.add(ni.address);
  }
  return set;
}

// 单主机识别：返回可添加的设备（找不到则 null）
async function probeHost(host, { deep = false } = {}) {
  const timeout = deep ? 1600 : 900;
  const ports = deep ? [631, 9100, 515, 443] : [631, 9100];
  const open = await Promise.all(ports.map((p) => tcpProbe(host, p, timeout)));
  const openPorts = ports.filter((_, i) => open[i]);
  if (!openPorts.length) return null;

  let ippInfo = null;
  for (const p of [631, 443]) {
    if (!openPorts.includes(p)) continue;
    const r = await ipp.detect(host, p, { timeout: deep ? 3200 : 2000 });
    if (r.ok) { ippInfo = { ...r, port: p }; break; }
    if (r.ipp && !ippInfo) ippInfo = { ok: false, ipp: true, path: r.path || '/ipp/print', secure: r.secure, port: p };
  }

  const summary = ippInfo && ippInfo.ok ? ipp.summarize(ippInfo.attrs) : null;
  const altUris = [];
  let primary = '';
  let kind = 'unknown';
  let source = '网段扫描';
  let method = '';
  let pathConfidence = '';

  if (ippInfo && ippInfo.ok) {
    const scheme = ippInfo.secure ? 'ipps' : 'ipp';
    primary = `${scheme}://${host}:${ippInfo.port}${ippInfo.path}`;
    kind = 'ipp';
    method = 'ipp';
    source = `网段扫描 (${ippInfo.port}/IPP)`;
    pathConfidence = 'confirmed';
  } else if (ippInfo) {
    // 是 IPP 服务但没问到属性：给一个最可能的地址，并标记路径待确认
    primary = `${ippInfo.secure ? 'ipps' : 'ipp'}://${host}:${ippInfo.port}${ippInfo.path || '/ipp/print'}`;
    kind = 'ipp';
    method = 'ipp';
    source = `网段扫描 (${ippInfo.port}/IPP)`;
    pathConfidence = 'guess';
  } else if (openPorts.includes(9100)) {
    primary = `socket://${host}:9100`;
    kind = 'socket';
    method = 'socket';
    source = '网段扫描 (9100/RAW)';
  } else if (openPorts.includes(515)) {
    primary = `lpd://${host}/PASSTHRU`;
    kind = 'lpd';
    method = 'lpd';
    source = '网段扫描 (515/LPD)';
  }

  // 其他端口也记下来，供用户切换协议
  for (const p of openPorts) {
    if (primary.includes(`:${p}`)) continue;
    if (p === 9100) altUris.push(`socket://${host}:9100`);
    else if (p === 515) altUris.push(`lpd://${host}/PASSTHRU`);
    else if (p === 631) altUris.push(`ipp://${host}:631/ipp/print`);
    else if (p === 443) altUris.push(`ipps://${host}:443/ipp/print`);
  }

  const model = summary && summary.model ? summary.model : '';
  let name = (summary && summary.name) || model || host;
  if (!model && kind === 'socket') name = `${host}（RAW）`;
  if (!model && kind === 'unknown') name = `${host}（未知服务）`;

  return {
    host,
    port: openPorts[0],
    kind,
    name,
    model: model || (kind === 'socket' ? 'RAW/JetDirect 打印服务' : ''),
    uri: primary,
    altUris,
    // 只有设备真的声明支持 PWG Raster/URF 才算免驱，否则「有 IPP 服务」不等于「能免驱」
    driverless: !!(summary && summary.driverless),
    deviceId: (summary && summary.deviceId) || '',
    formats: (summary && summary.formats) || [],
    source,
    method,
    ports: openPorts,
    pathConfidence
  };
}

async function probeSubnet(s, cidrs) {
  const self = selfHosts();
  const targets = [];
  for (const cidr of cidrs) {
    if (cidr.includes('/')) {
      if (/\/32$/.test(cidr)) {
        const h = cidr.split('/')[0];
        // 已添加的打印机也要探测：结果里标「已添加」，而不是从列表里消失
        if (!self.has(h)) targets.push(h);
        continue;
      }
      for (const h of ipList(cidr)) {
        if (!self.has(h)) targets.push(h);
      }
    } else if (/^[A-Za-z0-9.-]+$/.test(cidr)) {
      if (!self.has(cidr)) targets.push(cidr);
    }
  }
  if (!targets.length) {
    s.stage = '没有可探测的地址（网段格式示例：192.168.1.0/24）';
    return [];
  }
  const deep = s.mode === 'deep';
  s.total = targets.length;
  let scanned = 0;
  const found = [];
  const deadline = s.startedAt + SCAN_DEADLINE_MS;

  await pool(targets, deep ? 64 : 48, async (host) => {
    const dev = await probeHost(host, { deep });
    scanned++;
    if (dev) {
      found.push(dev);
      pushDevice(s, dev);
    }
    s.scanned = scanned;
    s.progress = Math.min(95, 5 + Math.round((scanned / targets.length) * 90));
    s.stage = `正在探测 ${targets.length} 个地址：${scanned}/${targets.length}（已发现 ${s.found.length}）`;
  }, deadline);

  return found;
}

// ---------- 网段候选 ----------
function localSubnets() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.family !== 'IPv4' || ni.internal) continue;
      const parts = ni.address.split('.');
      const cidr = `${parts[0]}.${parts[1]}.${parts[2]}.0/24`;
      // Docker / 容器网段对普通用户没意义，标注出来避免误以为是局域网
      const container = /^(172\.(1[7-9]|2[0-9]|3[01])\.|10\.88\.|192\.168\.65\.)/.test(ni.address);
      out.push({ iface: name, address: ni.address, cidr, container });
    }
  }
  return out;
}

// 常见家用/办公网段，扫描不到时一键换一个试试
const COMMON_CIDRS = ['192.168.1.0/24', '192.168.0.0/24', '192.168.2.0/24', '192.168.31.0/24', '10.0.0.0/24', '192.168.123.0/24'];

async function runScan({ mode = 'quick', cidr = '' } = {}) {
  // 并发锁：在「创建会话」这一步同步完成检查，避免两个并发请求都通过判断后又各自新建会话
  const running = hasRunningScan();
  if (running) return { alreadyRunning: true, id: running.id };
  const s = newSession(mode);
  (async () => {
    try {
      const saved = getSetting('discoverCidr', '');
      const cidrs = parseCidrs(cidr || saved);
      const { printers } = await cups.listPrinters();
      const existingHosts = new Set();
      for (const p of printers) {
        const h = hostOf(p.uri);
        if (h) existingHosts.add(h);
      }

      s.stage = '正在枚举 CUPS 已发现设备与 mDNS 广播';
      s.progress = 8;
      const [mdns, devs] = await Promise.all([browseAvahi(), cupsDevices()]);
      for (const item of [...mdns, ...devs]) {
        if (item.host && existingHosts.has(item.host)) item.added = true;
        pushDevice(s, item);
      }
      s.progress = 15;
      s.stage = `mDNS / CUPS 枚举完成（${s.found.length} 个），开始网段探测`;

      // 快速扫描也做网段探测：桥接网络下 mDNS 收不到，只靠 mDNS 必然 0 结果
      let useCidrs = cidrs.length ? cidrs : (mode === 'deep' ? localSubnets().map((x) => x.cidr) : []);
      // 快速扫描把大网段收缩到 /24，避免点了「快速扫描」却等上好几分钟
      if (mode === 'quick') {
        useCidrs = [...new Set(useCidrs.map((c) => {
          if (c.includes('/')) {
            const [ip, p] = c.split('/');
            if (Number(p) >= 24) return c;
            return `${ip.split('.').slice(0, 3).join('.')}.0/24`;
          }
          return c;
        }))];
      }
      if (useCidrs.length) {
        await probeSubnet(s, useCidrs);
      } else if (s.mode === 'quick') {
        s.stage = 'mDNS / CUPS 枚举完成（未配置扫描网段，跳过网段探测）';
      }

      for (const f of s.found) {
        if (f.host && existingHosts.has(f.host)) f.added = true;
        if (f.uri && printers.some((p) => p.uri === f.uri)) f.added = true;
      }
      s.status = 'done';
      s.progress = 100;
      s.finishedAt = Date.now();
      const n = s.found.length;
      s.stage = n
        ? `扫描完成，发现 ${n} 台设备${useCidrs.length ? `（扫描网段 ${useCidrs.join(', ')}）` : ''}`
        : `扫描完成，未发现设备${useCidrs.length ? `（扫描网段 ${useCidrs.join(', ')}）` : '（未配置网段，局域网打印机请填写网段后重扫）'}`;
    } catch (e) {
      s.status = 'error';
      s.error = e.message;
      s.stage = '扫描失败：' + e.message;
    }
  })();
  return s;
}

// 手动探测单个地址（扫描不到时的补救入口）
async function probeOne(host, { deep = true } = {}) {
  const clean = String(host || '').trim().replace(/^https?:\/\//, '').replace(/[/:].*$/, '');
  if (!/^(\d{1,3}\.){3}\d{1,3}$/.test(clean) && !/^[A-Za-z0-9.-]{1,80}$/.test(clean)) {
    return { ok: false, msg: '请输入 IP 或主机名' };
  }
  const dev = await probeHost(clean, { deep });
  if (!dev) return { ok: false, msg: `${clean} 的 631 / 9100 / 515 / 443 端口均无响应，请确认设备在线且与本机网络互通` };
  return { ok: true, device: dev };
}

function saveCidr(cidr) {
  const list = parseCidrs(cidr);
  if (!list.length) return { ok: false, msg: '网段格式示例：192.168.1.0/24' };
  setSetting('discoverCidr', list.join(','));
  return { ok: true, cidr: list.join(',') };
}

module.exports = {
  runScan, probeOne, getSession, hasRunningScan, localSubnets, saveCidr, parseCidrs, COMMON_CIDRS
};
