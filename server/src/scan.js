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
  // 给 airscan 设备补上真实地址，方便看出「发现到的主机名容器能不能解析」
  if (devices.some((d) => d.device.startsWith('airscan:'))) {
    const disc = await airscanDiscover().catch(() => ({ list: [] }));
    let idx = 0;
    for (const d of devices) {
      if (!d.device.startsWith('airscan:')) continue;
      const hit = (disc.list || [])[idx++];
      if (hit) {
        d.url = hit.url;
        d.addressKind = /^https?:\/\/\d{1,3}(\.\d{1,3}){3}/.test(hit.url) ? 'ip' : 'host';
      }
    }
  }
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


// ---------- 网络扫描仪（sane-airscan） ----------
// 桥接网络下 mDNS 广播过不来，scanimage -L 看不到一体机。两条路：
//   1) 容器用 host 网络（Linux 下最省事，自动发现就能用）
//   2) 在 airscan.conf 里手写设备地址（任何网络模式都能用，推荐）
const AIRSCAN_CONF = path.join(config.saneConfDir, 'airscan.conf');

function readAirscanConf() {
  const devices = [];
  try {
    const text = fs.readFileSync(AIRSCAN_CONF, 'utf8');
    let inSection = false;
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#') || line.startsWith(';')) continue;
      if (/^\[devices\]$/i.test(line)) { inSection = true; continue; }
      if (/^\[/.test(line)) { inSection = false; continue; }
      if (!inSection) continue;
      const m = line.match(/^"([^"]+)"\s*=\s*(.+)$/) || line.match(/^([^=\s]+)\s*=\s*(.+)$/);
      if (m) devices.push({ name: m[1], url: m[2].trim() });
    }
  } catch (_) { /* 文件不存在就是没配过 */ }
  return devices;
}

function writeAirscanConf(devices) {
  const lines = [
    '# 由 PrintGate 生成：后台「扫描仪 → 网络扫描仪」维护，手改会被覆盖',
    'discovered = ',
    '[devices]'
  ];
  for (const d of devices) lines.push(`"${d.name.replace(/"/g, '')}" = ${d.url}`);
  lines.push('');
  fs.writeFileSync(AIRSCAN_CONF, lines.join('\n'), 'utf8');
  return AIRSCAN_CONF;
}

// 规范化用户输入：接受 192.168.1.50 / 192.168.1.50:8080 / http://host 三种写法
function normalizeHost(input) {
  let s = String(input || '').trim();
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) s = 'http://' + s;
  let u;
  try { u = new URL(s); } catch (_) { return null; }
  if (!u.hostname) return null;
  if (!/^(\d{1,3}\.){3}\d{1,3}$|^[a-z0-9.-]+$/i.test(u.hostname)) return null;
  if (u.pathname === '/') u.pathname = '';
  return u.toString().replace(/\/$/, '');
}

// 探测 eSCL（AirScan / Mopria）：GET /eSCL/ScannerCapabilities，读 makeAndModel
// eSCL 的接口路径各家不一样：HP/Canon 多在 /eSCL/ScannerCapabilities，
// 部分兄弟打印机直接 /eSCL，少数固件用驼峰变体。逐个试，命中就停。
const ESCL_PATHS = [
  '/eSCL/ScannerCapabilities',
  '/eSCL/ScannerStatus',
  '/eSCL',
  '/ScannerCapabilities',
  '/scan/scannerCapabilities',
  '/Scan/ScannerCapabilities'
];

function parseModel(xml) {
  const m = xml.match(/<(?:pwg|scan|sm)?:?MakeAndModel>([^<]+)</i)
    || xml.match(/<(?:pwg|scan|sm)?:?ModelName>([^<]+)</i)
    || xml.match(/<(?:pwg|scan|sm)?:?ManufacturerAndModel>([^<]+)</i);
  return m ? m[1].trim().slice(0, 80) : '';
}

async function tryUrl(url, timeoutMs = 3500) {
  const started = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctrl.signal, redirect: 'follow' });
    const ms = Date.now() - started;
    // 401/403 说明 eSCL 端点确实在，只是要认证 —— 也算"找对了地方"
    if (r.status === 401 || r.status === 403) {
      return { url, status: r.status, ms, hit: true, auth: true, model: '', text: '' };
    }
    if (!r.ok) return { url, status: r.status, ms, hit: false, model: '', text: '' };
    const text = await r.text();
    const model = parseModel(text);
    // 有 XML 根节点就认为是 eSCL（有些固件不返回 MakeAndModel）
    const xmlish = /<(?:w+:)?Scanner(?:Capabilities|Status)/i.test(text);
    return { url, status: r.status, ms, hit: xmlish || !!model, model, text: text.slice(0, 400) };
  } catch (e) {
    return { url, status: 0, ms: Date.now() - started, hit: false, model: '', text: '', error: e.name === 'AbortError' ? 'timeout' : (e.cause && e.cause.code) || e.message };
  } finally {
    clearTimeout(timer);
  }
}

// 端口连通性：判断"网络层通不通"，和"是不是 eSCL"分开看
function probePort(host, port, timeoutMs = 2000) {
  const net = require('net');
  return new Promise((resolve) => {
    const started = Date.now();
    const sock = net.connect({ host, port });
    let done = false;
    const finish = (ok, err) => {
      if (done) return; done = true;
      try { sock.destroy(); } catch (_) {}
      resolve({ port, ok, ms: Date.now() - started, error: err || '' });
    };
    sock.setTimeout(timeoutMs, () => finish(false, 'timeout'));
    sock.on('connect', () => finish(true));
    sock.on('error', (e) => finish(false, e.code || e.message));
  });
}

async function probeNetwork(input) {
  const base = normalizeHost(input);
  if (!base) return { ok: false, msg: '地址格式不对，填 IP 或 IP:端口，例如 192.168.1.50' };

  const u = new URL(base);
  const host = u.hostname;
  const explicitPort = !!u.port;
  const explicitScheme = /^https:/i.test(base);

  // 候选入口：用户显式写了端口就只试那一个；否则按 80 → 8080 → https:443 依次试
  const candidates = [];
  if (explicitPort || explicitScheme) {
    candidates.push(base);
  } else {
    candidates.push(`http://${host}`, `http://${host}:8080`, `https://${host}`);
  }

  const steps = [];
  for (const c of candidates) {
    for (const path of ESCL_PATHS) {
      const url = c.replace(/\/+$/, '') + path;
      const r = await tryUrl(url);
      steps.push({ url, status: r.status, ms: r.ms, hit: r.hit, error: r.error || '' });
      if (r.hit) {
        return {
          ok: true,
          url: c.replace(/\/+$/, ''),      // 只存 base，airscan 自己会拼路径
          protocol: 'eSCL',
          model: r.model,
          auth: !!r.auth,
          ms: r.ms,
          hitUrl: url,
          steps,
          msg: `已连通（eSCL${r.model ? ' · ' + r.model : ''}${r.auth ? ' · 需要认证' : ''}）`
        };
      }
    }
  }

  // 没命中 eSCL：再看端口通不通，把结论说清楚。
  // 用户显式写了端口时，以那个端口为准——本机其它端口开着不代表他填的地址可用。
  const wantPort = Number(u.port) || 0;
  const checkList = [...new Set([wantPort, 80, 443, 8080, 9100, 631].filter(Boolean))];
  const ports = await Promise.all(checkList.map((p) => probePort(host, p)));
  const open = ports.filter((x) => x.ok).map((x) => x.port);
  const primaryOpen = wantPort ? !!(ports.find((x) => x.port === wantPort) || {}).ok : open.length > 0;

  let msg;
  let reason;
  if (!primaryOpen) {
    reason = 'unreachable';
    msg = `连不上 ${host}${wantPort ? ':' + wantPort : ''} 的任何端口（试过 ${checkList.join('/')}）。请检查：① IP 和端口是否写错 ② 一体机是否开机并在同一网段 ③ 宿主机防火墙是否挡了容器出网`;
  } else if (open.includes(9100) || open.includes(631)) {
    reason = 'not-escl';
    msg = `${host} 的端口是通的（${open.join('/')}），但没响应 eSCL 接口。这台机器大概率只支持厂商私有协议或旧版 WSD —— 可以点「强制添加」让 airscan 自己再试一次，扫不出来就需要换 USB 连接`;
  } else {
    reason = 'no-escl-path';
    msg = `${host} 的 Web 服务是通的（${open.join('/')}），但没有找到 eSCL 的 ScannerCapabilities。可能是路径不同或需要登录 —— 可先点「强制添加」，airscan 会再尝试 /eSCL 与 WSD 两种方式`;
  }

  return { ok: false, url: base, reason, ports, open, steps, msg, canForce: true };
}

function addNetworkScanner(name, url) {
  const devices = readAirscanConf().filter((d) => d.name !== name && d.url !== url);
  devices.push({ name, url });
  writeAirscanConf(devices);
  cache = { at: 0, data: null };   // 清缓存，下一次 listDevices 会重新枚举
  return devices;
}

function removeNetworkScanner(name) {
  const devices = readAirscanConf().filter((d) => d.name !== name);
  writeAirscanConf(devices);
  cache = { at: 0, data: null };
  return devices;
}

// 容器网络概况：用来判断「要不要改 host 网络」
function netInfo() {
  const os = require('os');
  const ifaces = os.networkInterfaces();
  const out = [];
  for (const [name, list] of Object.entries(ifaces)) {
    for (const it of list || []) {
      if (it.family !== 'IPv4' || it.internal) continue;
      out.push({ name, address: it.address, netmask: it.netmask });
    }
  }
  // 判断是否桥接网络：容器里 eth0 的 iflink 指向 veth 对端（与 ifindex 不等）→ 桥接；
  // 两者相等说明没有 veth 对，基本就是 host 网络。读不到（Windows/macOS 开发机）再退回网段判断。
  let bridged = out.some((x) => /^172\.(1[7-9]|2\d|3[01])\./.test(x.address));
  try {
    const iflink = Number(fs.readFileSync('/sys/class/net/eth0/iflink', 'utf8').trim());
    const ifindex = Number(fs.readFileSync('/sys/class/net/eth0/ifindex', 'utf8').trim());
    if (Number.isFinite(iflink) && Number.isFinite(ifindex) && iflink > 0 && ifindex > 0) {
      bridged = iflink !== ifindex;
    }
  } catch (_) { /* 非 Linux 或没有 eth0，用网段兜底 */ }
  return {
    interfaces: out,
    bridged,
    likelyHostNetwork: out.length > 0 && !bridged,
    advice: bridged
      ? '当前是 Docker 桥接网络：自动发现（mDNS）到不了一体机，请在下面「网络扫描仪」里手填 IP；或把容器改成 network_mode: host（仅 Linux 支持）'
      : '网络模式看起来是 host 或已与局域网同段，mDNS 自动发现应当可用'
  };
}

// airscan-discover 会打印每个设备的实际地址，形如：
//   eSCL  HP OfficeJet Pro 9010  http://192.168.1.50:80/eSCL/  ...
// 设备名（airscan:e0:1）里的序号跟这里顺序对应，用来判断「发现出来的地址是 IP 还是主机名」
async function airscanDiscover() {
  const r = await cups.run('airscan-discover', [], { timeout: 12000 });
  if (!r.ok) return { ok: false, list: [], raw: (r.stderr || r.error || '').slice(0, 500) };
  const list = [];
  for (const line of String(r.stdout || '').split(/\r?\n/)) {
    const m = line.match(/^\s*(eSCL|WSD|\S+)\s+(.+?)\s+(https?:\/\/\S+)\s*$/i);
    if (m) list.push({ kind: m[1].toLowerCase(), name: m[2].trim(), url: m[3].trim() });
  }
  return { ok: true, list, raw: String(r.stdout || '').slice(0, 2000) };
}

// 设备自检：--test 只打开设备读参数、不真正扫描，能区分「打不开」和「扫失败」
async function deviceSelfTest(device) {
  if (!device) return { ok: false, msg: '缺少设备名' };
  const [test, opts, disc] = await Promise.all([
    cups.run('scanimage', ['-d', device, '--test'], { timeout: 20000 }),
    cups.run('scanimage', ['-d', device, '-A'], { timeout: 20000 }),
    airscanDiscover()
  ]);
  const text = `${test.stderr || ''}\n${opts.stderr || ''}`.trim();
  const openable = test.ok || opts.ok;
  // scanimage 都没装（ENOENT）时不要把锅甩给设备
  const noBinary = !!(test.enoent || opts.enoent);
  return {
    ok: true,
    device,
    openable,
    test: { ok: test.ok, code: test.code, msg: (test.stderr || test.stdout || '').slice(0, 400).trim() },
    options: { ok: opts.ok, count: (opts.stdout || '').split(/\r?\n/).filter((l) => /^\s+--/.test(l)).length },
    discover: disc.list,
    discoverOk: disc.ok,
    noBinary,
    hint: noBinary
      ? HINT_INSTALL
      : (openable
          ? '设备可以打开，扫描失败多半是参数或原稿问题（看具体报错）'
          : (text ? translateError(text) : '设备打不开，但没返回具体原因，可尝试用 IP 手填后重试'))
  };
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
  // 「open of device ... failed: Invalid argument」= 设备名不存在（被删掉/改过名），不是参数问题
  if (/open of device .*failed: Invalid argument/i.test(t)) {
    return '这个设备名已经不存在了（可能被移除或重命名），请点「重新检测」后再选一次';
  }
  // 「open of device ... failed: Invalid argument」= 设备名不存在（被删掉/改过名），不是参数问题
  if (/open of device .*failed: Invalid argument/i.test(t)) {
    return '这个设备名已经不存在了（可能被移除或重命名），请点「重新检测」后再选一次';
  }
  if (/Invalid argument|unsupported|not supported/i.test(t)) {
    return '该设备不支持所选参数（分辨率/色彩/来源），请换一组参数重试';
  }
  if (/No such device|couldn't open|failed to open/i.test(t)) {
    return '打不开扫描仪：设备已断开或不是这个设备名，请重新检测';
  }
  // airscan 最常见的坑：能发现设备，但真正打开时 TCP 连不上 —— 报的就是这句。
  // 典型原因：mDNS 发现来的地址是主机名（容器里解析不了）、设备被别的客户端占用、设备休眠。
  if (new RegExp('Error during device I/O|device I/O|I/O error', 'i').test(t)) {
    return '设备连不上（Error during device I/O）：设备能被发现但打不开连接。常见三种：'
      + '① 这是 mDNS 自动发现的设备，它的地址是主机名，容器里解析不了 —— 请改用「网络扫描仪」手填 IP 再扫；'
      + '② 一体机正被别的电脑占用（比如 HP 的「扫描到计算机」、手机 App 正在预览），关掉后重试；'
      + '③ 设备休眠/刚开机，等 10 秒再试。可点「设备自检」查看实际地址与连通性';
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

  let r = await cups.run('scanimage', args, { timeout: 240000 });
  // 设备刚唤醒 / 刚被别人释放时，第一次打开常常报 device I/O，隔一会儿再来一次基本就好
  if (!r.ok && /device I\/O|Error during device I\/O/i.test(`${r.stderr || ''}${r.error || ''}`)) {
    await new Promise((done) => setTimeout(done, 1500));
    r = await cups.run('scanimage', args, { timeout: 240000 });
  }
  if (!r.ok) return { ok: false, msg: translateError(`${r.stderr || ''} ${r.error || ''}`), device };

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

module.exports = {
  deviceSelfTest, airscanDiscover,
  readAirscanConf, writeAirscanConf, addNetworkScanner, removeNetworkScanner,
  probeNetwork, normalizeHost, netInfo, AIRSCAN_CONF, available, version, findUsb, listDevices, deviceOptions, scan, pickValues, translateError, HINT_INSTALL, HINT_USB, HINT_DRIVER };
