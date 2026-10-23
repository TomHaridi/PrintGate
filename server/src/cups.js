'use strict';
// CUPS 封装：只通过 lp/lpadmin/lpstat/lpinfo 等命令行交互（execFile，参数数组，不经 shell）
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const ipp = require('./ipp');

const ENV = { ...process.env, LC_ALL: 'C', LANG: 'C' };

// 设置页里的「CUPS 地址」要真的生效：CUPS 命令行认 CUPS_SERVER 环境变量。
// 留空/默认值（本机 socket）时不注入，保持容器内的原有行为不变。
function cupsEnv() {
  try {
    const { cfg } = require('./db');
    const srv = String(cfg().cupsServer || '').trim();
    if (!srv) return ENV;
    if (srv === '127.0.0.1:631' || srv === 'localhost:631') return ENV;
    return { ...ENV, CUPS_SERVER: srv };
  } catch (_) {
    return ENV;
  }
}

function run(cmd, args = [], { timeout = 20000 } = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { env: cupsEnv(), timeout, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({
        ok: !err,
        code: err && typeof err.code === 'number' ? err.code : err ? 1 : 0,
        enoent: !!(err && err.code === 'ENOENT'),
        stdout: String(stdout || ''),
        stderr: String(stderr || ''),
        error: err ? err.message : ''
      });
    });
  });
}

const missing = (name) => name === 'ENOENT';

// ---------- 服务状态 ----------
async function status() {
  const r = await run('lpstat', ['-r'], { timeout: 5000 });
  const text = (r.stdout + r.stderr).trim();
  if (r.ok && /is running/i.test(text)) return { running: true, message: 'CUPS 服务运行中' };
  if (missing(r.code)) return { running: false, message: '容器内未找到 lpstat（CUPS 客户端未安装）' };
  return { running: false, message: text || 'CUPS 服务未运行' };
}

// ---------- 打印机 ----------
function parsePrinterBlocks(text) {
  const out = [];
  let cur = null;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '');
    if (/^printer\s+/i.test(line)) {
      const m = line.match(/^printer\s+(\S+)\s+(.*)$/i);
      if (m) {
        cur = { name: m[1], stateLine: m[2], detail: {} };
        out.push(cur);
      }
    } else if (cur && /^\s+\S/.test(line)) {
      const idx = line.indexOf(':');
      if (idx > 0) cur.detail[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
    }
  }
  return out;
}

function parseState(stateLine) {
  const s = String(stateLine || '');
  let state = 'idle';
  if (/now printing/i.test(s)) state = 'printing';
  else if (/^disabled/i.test(s) || /disabled since/i.test(s)) state = 'stopped';
  else if (/is idle/i.test(s)) state = 'idle';
  const enabled = !/^disabled/i.test(s) && !/disabled since/i.test(s);
  return { state, enabled };
}

async function listPrinters() {
  const [p, v, d] = await Promise.all([
    run('lpstat', ['-p']),
    run('lpstat', ['-v']),
    run('lpstat', ['-d'], { timeout: 5000 })
  ]);
  if (p.enoent || missing(p.code)) {
    return { ok: false, msg: '未安装 CUPS 客户端（lpstat），无法管理打印机', printers: [], default: '' };
  }
  // lpstat 失败说明根本没连上 CUPS（地址配错 / cupsd 没起）。这时不能回「ok:true + 0 台打印机」，
  // 否则界面和接口都会说「打印机不存在」，运维很难看出真正原因是 CUPS 连不上。
  if (p.code !== 0) {
    const detail = String(p.stderr || p.stdout || p.error || '').trim().split(/\r?\n/)[0];
    // 注意：一个队列都没有时 lpstat 也返回 1，但 stderr 是 "No destinations added."，
    // 这属于「CUPS 正常、只是没有打印机」，不能当成连不上。
    if (/no destinations added/i.test(detail)) {
      return { ok: true, printers: [], default: '', raw: '' };
    }
    return {
      ok: false,
      msg: detail ? `无法连接 CUPS：${detail}` : '无法连接 CUPS，请检查服务地址与 cupsd 状态',
      printers: [], default: ''
    };
  }

  const devices = {};
  for (const line of v.stdout.split(/\r?\n/)) {
    const m = line.match(/^device for (.+?):\s*(.*)$/);
    if (m) devices[m[1]] = m[2];
  }
  const dm = d.stdout.match(/system default destination:\s*(\S+)/i);
  const def = dm ? dm[1] : '';

  const printers = parsePrinterBlocks(p.stdout).map((b) => {
    const st = parseState(b.stateLine);
    const nowPrinting = b.stateLine.match(/now printing\s+(\S+?)\.?\s*$/i);
    return {
      name: b.name,
      state: st.state,
      enabled: st.enabled,
      accepting: !/rejecting/i.test(b.stateLine),
      uri: devices[b.name] || '',
      info: b.detail['description'] || '',
      location: b.detail['location'] || '',
      model: b.detail['interface'] || '',
      connection: b.detail['connection'] || '',
      activeJob: nowPrinting ? nowPrinting[1] : '',
      isDefault: b.name === def,
      stateLine: b.stateLine,
      detail: b.detail
    };
  });

  return { ok: true, printers, default: def, raw: p.stdout };
}

async function printerOptions(name) {
  const r = await run('lpoptions', ['-p', name, '-l']);
  const options = {};
  for (const line of r.stdout.split(/\r?\n/)) {
    const m = line.match(/^(\S+):\s*(.*)$/);
    if (!m) continue;
    const key = m[1].replace(/\/.*$/, '');
    const values = m[2].split(/\s+\*?/).filter(Boolean);
    options[key] = values;
  }
  return { ok: r.ok, options, raw: r.stdout, error: r.stderr };
}

// CUPS / 打印机的原始错误翻成人话 + 可执行建议。
// 典型场景：Canon 部分机型固件把 attributes-natural-language 返回成 "en-"（RFC 8011 只允许
// 2 个字母的语言码），CUPS 的 IPP 校验直接拒收，用户看到的就是一脸懵的 RFC 条文。
function friendlyCupsError(text) {
  const t = String(text || '').trim();
  if (!t) return '操作失败';
  if (/attributes-natural-language|naturalLanguage|RFC ?8011/i.test(t)) {
    return '打印机固件返回了非法的 IPP 语言标记（部分 Canon 机型的固件问题），CUPS 无法与它通信。'
      + '建议：改用 socket://打印机IP:9100 添加（RAW 队列最稳），或在打印机网页里把语言改成英文，或升级打印机固件';
  }
  if (/Unable to connect|Connection refused|timed out|Host is down/i.test(t)) {
    return '连不上打印机：请检查设备 IP、电源与网络（容器需能与打印机所在网段互通）';
  }
  if (/Bad Request|client-error-bad-request/i.test(t)) {
    return '打印机拒绝了请求（可能是固件兼容问题），可尝试改用 socket://打印机IP:9100 添加';
  }
  if (/Unauthorized|Forbidden|client-error-not-authorized/i.test(t)) {
    return '打印机要求认证：请检查 IPP 打印是否需要账号密码（部分机型需在网页里关闭访问控制）';
  }
  return t;
}

function friendlyLpadminError(text) {
  const t = String(text || '');
  if (/attributes-natural-language|naturalLanguage|RFC ?8011/i.test(t)) return friendlyCupsError(t);
  if (/IPP Everywhere driver requires an IPP connection/i.test(t)) {
    return '该设备地址不是 IPP，无法使用 everywhere 免驱驱动，请改用 raw 或选择具体型号驱动';
  }
  if (/Unknown model|Unable to find model/i.test(t)) return '驱动 / 型号不存在，请在驱动列表中重新选择';
  if (/No IPP attributes|Unable to create PPD/i.test(t)) {
    return '打印机没有返回 IPP 属性，可能不支持 IPP Everywhere：请在「驱动库」里选择具体型号驱动，或改用 RAW（socket://IP:9100）';
  }
  if (/already exists/i.test(t)) return '队列名已存在';
  if (/Forbidden|Unauthorized/i.test(t)) return '容器内权限不足，无法写入 CUPS 配置';
  const cleaned = t.split('\n')
    .map((line) => (line.startsWith('lpadmin: ') ? line.slice(9) : line).trim())
    .filter((line) => line && !line.toLowerCase().includes('raw queues are deprecated'));
  return cleaned.join(' ').trim() || '添加失败';
}

async function addPrinter({ name, uri, model = 'everywhere', info = '', location = '', shared = true }) {
  if (!/^[A-Za-z0-9_.-]{1,60}$/.test(name)) return { ok: false, msg: '队列名只能包含字母、数字、下划线、点和中划线' };
  // socket:// usb:// lpd:// 等非 IPP 设备无法使用 IPP Everywhere 免驱驱动，自动退回 raw 队列
  const isIpp = /^(ipp|ipps|dnssd):\/\//i.test(uri);
  let useModel = model;
  let note = '';
  if (useModel === 'everywhere' && !isIpp) {
    useModel = 'raw';
    note = '该地址不是 IPP，已自动使用 RAW 队列';
  }
  // ppd:/abs/path.ppd → 用下载/上传的 PPD 文件建队列（-P），而不是 -m
  const ppdPath = /^ppd:/i.test(String(useModel || '')) ? String(useModel).slice(4) : '';
  const args = ['-p', name, '-E', '-v', uri];
  if (ppdPath) args.push('-P', ppdPath);
  else if (useModel) args.push('-m', useModel);
  if (info) args.push('-D', info);
  if (location) args.push('-L', location);
  args.push('-o', `printer-is-shared=${shared ? 'true' : 'false'}`);
  const r = await run('lpadmin', args, { timeout: 60000 });
  if (!r.ok) return { ok: false, msg: friendlyLpadminError(r.stderr || r.error) };
  await run('cupsaccept', [name]);
  await run('cupsenable', [name]);
  return { ok: true, usedModel: ppdPath ? `ppd:${ppdPath.split('/').pop()}` : useModel, note };
}

async function removePrinter(name) {
  const r = await run('lpadmin', ['-x', name]);
  return { ok: r.ok, msg: r.ok ? '' : friendlyCupsError(r.stderr) };
}

async function setDefault(name) {
  const r = await run('lpadmin', ['-d', name]);
  return { ok: r.ok, msg: r.ok ? '' : friendlyCupsError(r.stderr) };
}

async function pausePrinter(name) {
  const r = await run('cupsdisable', [name]);
  return { ok: r.ok, msg: r.stderr.trim() };
}

async function resumePrinter(name) {
  const [a, b] = await Promise.all([run('cupsenable', [name]), run('cupsaccept', [name])]);
  return { ok: a.ok && b.ok, msg: (a.stderr + b.stderr).trim() };
}

async function rejectJobs(name) {
  const r = await run('cupsreject', ['-r', '维护中', name]);
  return { ok: r.ok, msg: r.stderr.trim() };
}

async function acceptJobs(name) {
  const r = await run('cupsaccept', [name]);
  return { ok: r.ok, msg: r.stderr.trim() };
}

// ---------- 任务 ----------
function parseJobLine(line) {
  // MF650C_IPP-12 user 1024 Thu 21 Oct 2026 10:01:25 AM CST
  const m = line.match(/^(\S+)-(\d+)\s+(\S+)\s+(\d+)\s+(.*)$/);
  if (!m) return null;
  return {
    id: `${m[1]}-${m[2]}`,
    jobNumber: parseInt(m[2], 10),
    printer: m[1],
    user: m[3],
    size: parseInt(m[4], 10),
    submitted: m[5].trim()
  };
}

async function listJobs({ state = 'not-completed' } = {}) {
  const args = state === 'completed' ? ['-W', 'completed', '-o'] : ['-W', state, '-o'];
  const [r, active] = await Promise.all([run('lpstat', args), run('lpstat', ['-p'])]);
  const activeJobs = {};
  for (const b of parsePrinterBlocks(active.stdout)) {
    const m = b.stateLine.match(/now printing\s+(\S+?)\.?\s*$/i);
    if (m) activeJobs[m[1]] = b.name;
  }
  const jobs = r.stdout.split(/\r?\n/).map(parseJobLine).filter(Boolean)
    .map((j) => ({ ...j, state: activeJobs[j.id] ? 'processing' : 'pending' }));
  return { ok: r.ok, jobs };
}

async function cancelJob(id, { purge = false } = {}) {
  // purge=true 时用 cancel -x：把已完成的作业从 CUPS 历史里删掉（不发送到打印机）
  const r = await run('cancel', purge ? ['-x', String(id)] : [String(id)]);
  return { ok: r.ok, msg: r.ok ? '' : friendlyCupsError(r.stderr || r.error) };
}

async function holdJob(id) {
  const r = await run('lp', ['-i', String(id), '-H', 'hold']);
  return { ok: r.ok, msg: r.stderr.trim() };
}

async function releaseJob(id) {
  const r = await run('lp', ['-i', String(id), '-H', 'resume']);
  return { ok: r.ok, msg: r.stderr.trim() };
}

// ---------- 提交打印 ----------
// options: copies, media, sides, color, orientation, pageRanges, numberUp,
//          numberUpLayout, pageBorder, scaling, mediaType, inputSlot, extra (key=value 数组)
function buildPrintArgs(printer, filePath, title, options = {}) {
  const args = ['-d', printer, '-t', title || path.basename(filePath)];
  const copies = Math.min(Math.max(parseInt(options.copies || 1, 10) || 1, 1), 999);
  args.push('-n', String(copies));
  if (options.media) args.push('-o', `media=${options.media}`);
  if (options.sides) args.push('-o', `sides=${options.sides}`);
  if (options.color === 'mono' || options.color === 'monochrome') {
    args.push('-o', 'print-color-mode=monochrome', '-o', 'ColorModel=Gray');
  } else if (options.color === 'color') {
    args.push('-o', 'print-color-mode=color', '-o', 'ColorModel=RGB');
  }
  if (options.orientation === 'landscape') args.push('-o', 'orientation-requested=4');
  else if (options.orientation === 'portrait') args.push('-o', 'orientation-requested=3');
  if (options.pageRanges && /^[0-9,\-\s]+$/.test(options.pageRanges)) {
    args.push('-o', `page-ranges=${options.pageRanges.replace(/\s+/g, '')}`);
  }
  // 页面子集：偶数页倒序靠 page-set + CUPS 的 outputorder 组合近似，
  // 驱动不支持时 CUPS 会忽略，不会报错。
  if (options.pageSet === 'odd' || options.pageSet === 'even') {
    args.push('-o', `page-set=${options.pageSet}`);
  } else if (options.pageSet === 'even-reverse') {
    args.push('-o', 'page-set=even', '-o', 'outputorder=reverse');
  }
  if (options.mirror) args.push('-o', 'mirror=true');
  if (options.numberUp && parseInt(options.numberUp, 10) > 1) {
    args.push('-o', `number-up=${parseInt(options.numberUp, 10)}`);
    if (options.numberUpLayout) args.push('-o', `number-up-layout=${options.numberUpLayout}`);
    if (options.pageBorder) args.push('-o', 'page-border=single');
  }
  if (options.scaling) args.push('-o', `print-scaling=${options.scaling}`);
  if (options.mediaType) args.push('-o', `media-type=${options.mediaType}`);
  if (options.inputSlot) args.push('-o', `InputSlot=${options.inputSlot}`);
  if (options.resolution) args.push('-o', `Resolution=${options.resolution}`);
  if (Array.isArray(options.extra)) {
    for (const kv of options.extra) {
      if (typeof kv === 'string' && /^[A-Za-z0-9_.-]+=[^;|&`$]*$/.test(kv)) args.push('-o', kv);
    }
  }
  args.push(filePath);
  return args;
}

// RAW 直通队列（socket://IP:9100）没有 PPD，CUPS 会把 -o 的驱动选项全部丢掉：
// 彩色、双面、纸盒、分辨率都不生效，打印机按自己的默认设置输出（多数机型默认黑白）。
async function queueInfo(name) {
  const ppd = `/etc/cups/ppd/${String(name || '').replace(/[^A-Za-z0-9_.-]/g, '')}.ppd`;
  let text = '';
  try { text = fs.readFileSync(ppd, 'utf8'); } catch (_) { return { raw: false, hasColor: true, known: false }; }
  const raw = /cups-raw/i.test(text);
  const hasColor = /ColorModel/i.test(text);
  return { raw, hasColor, known: true };
}

async function submitJob({ printer, filePath, title, options }) {
  if (!fs.existsSync(filePath)) return { ok: false, msg: '文件不存在' };
  const args = buildPrintArgs(printer, filePath, title, options);
  const r = await run('lp', args, { timeout: 120000 });
  if (!r.ok) return { ok: false, msg: friendlyCupsError(r.stderr || r.error || '提交失败') };
  const m = r.stdout.match(/request id is (\S+?)(?:\s|$)/i);
  return { ok: true, jobId: m ? m[1].replace(/\(.*$/, '') : '', raw: r.stdout.trim() };
}

// ---------- 打印机详情（驱动可选项 / 耗材 / 纸盒） ----------
// lpoptions -l 的格式：Key/Label: value1 "带 空格的值" *当前值
//
// 驱动上报的选项值大多是英文关键字（Canon / HP 尤其明显，例如 MediaType=Stationery、
// InputSlot=ByPassTray），原样显示在界面上用户看不懂。这里按「选项 → 值 → 中文」映射，
// 认不出的值原样返回，绝不猜。
const OPTION_LABEL_ZH = {
  mediatype: '介质类型', inputslot: '进纸盒', outputbin: '出纸盒', sides: '双面打印',
  printquality: '打印质量', colormodel: '色彩模式', resolution: '分辨率', pagesize: '纸张尺寸',
  pageranges: '页码范围', copies: '份数', orientation: '方向', scaling: '缩放',
  numberup: '每张页数', pageborder: '页面边框', mirror: '镜像打印', pageset: '打印范围',
  outputorder: '输出顺序', 'job-priority': '优先级', fitplot: '缩放以适应',
  'job-sheets': '封页', 'page-set': '打印范围', 'print-content-optimize': '内容优化'
};
const OPTION_VALUE_ZH = {
  MediaType: {
    auto: '自动', stationery: '普通纸', 'stationery-lightweight': '薄纸',
    'stationery-heavyweight': '厚纸', stationerylightweight: '薄纸', stationeryheavyweight: '厚纸',
    plain: '普通纸', normal: '普通纸', 'plain-paper': '普通纸', bond: '债券纸', recycled: '再生纸',
    color: '彩色纸', letterhead: '信笺纸', preprinted: '预印纸', prepunched: '打孔纸',
    envelope: '信封', labels: '标签纸', photographic: '相纸', glossy: '光面纸', matte: '哑光纸',
    semigloss: '半光面纸', thin: '薄纸', thick: '厚纸', cardstock: '卡纸',
    transparency: '透明胶片', cotton: '棉纸', archive: '档案纸', vellum: '牛皮纸',
    heavyweight: '重磅纸', light: '轻磅纸'
  },
  InputSlot: {
    auto: '自动选择', tray1: '纸盒 1', tray2: '纸盒 2', tray3: '纸盒 3', tray4: '纸盒 4',
    bypasstray: '手动进纸槽', bypass: '手动进纸槽', manual: '手动进纸', cassette: '纸盒',
    'multi-purpose': '多功能纸盒', 'mp-tray': '多功能纸盒', envelope: '信封进纸',
    'large-capacity': '大容量纸盒', 'large-capacity-tray': '大容量纸盒',
    'tray-1': '纸盒 1', 'tray-2': '纸盒 2', 'tray-3': '纸盒 3',
    drawer1: '抽屉 1', drawer2: '抽屉 2', top: '上方进纸'
  },
  OutputBin: {
    auto: '自动', top: '上方出纸', 'face-up': '面朝上出纸', 'face-down': '面朝下出纸',
    rear: '后出纸', side: '侧出纸', 'stacker-1': '堆叠器 1', 'mailbox-1': '邮箱 1'
  },
  Sides: {
    'one-sided': '单面', 'two-sided-long-edge': '双面（长边装订）',
    'two-sided-short-edge': '双面（短边装订）', duplex: '双面', simplex: '单面',
    onesided: '单面', twosidedlongedge: '双面（长边装订）', twosidedshortedge: '双面（短边装订）'
  },
  PrintQuality: { draft: '草稿', normal: '普通', high: '高', best: '最佳', quick: '快速', fine: '精细' },
  ColorModel: {
    rgb: '彩色（RGB）', adobergb: '彩色（Adobe RGB）', srgb: '彩色（sRGB）',
    gray: '黑白', gray16: '黑白（16 位灰阶）', grayscale: '黑白', cmyk: '彩色（CMYK）',
    mono: '黑白', color: '彩色'
  },
  Resolution: { '300dpi': '300 dpi', '600dpi': '600 dpi', '1200dpi': '1200 dpi', '2400dpi': '2400 dpi' },
  Orientation: {
    portrait: '纵向', landscape: '横向',
    'reverse-portrait': '反向纵向', 'reverse-landscape': '反向横向'
  }
};

function zhLabel(key, label) {
  const hit = OPTION_LABEL_ZH[String(key || '').toLowerCase()];
  return hit || label;
}

function zhValue(key, value) {
  const map = OPTION_VALUE_ZH[String(key || '')] || OPTION_VALUE_ZH[String(key || '').toLowerCase()];
  if (!map) return value;
  const hit = map[String(value).toLowerCase()];
  return hit || value;
}

function parseLpOptions(text) {
  const out = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z0-9_.-]+)\/([^:]+):\s*(.+)$/);
    if (!m) continue;
    const values = [];
    let current = '';
    const re = /"([^"]*)"|(\S+)/g;
    let t;
    while ((t = re.exec(m[3]))) {
      let v = t[1] !== undefined ? t[1] : t[2];
      const isCur = v.startsWith('*');
      if (isCur) { v = v.slice(1); current = v; }
      if (v) values.push({ value: v, label: zhValue(m[1], v) });
    }
    if (values.length) {
      out.push({
        key: m[1],
        label: zhLabel(m[1], m[2].trim()),
        current: current || values[0].value,
        values
      });
    }
  }
  return out;
}

const DETAIL_ATTRS = [
  'printer-state', 'printer-state-reasons', 'printer-is-accepting-jobs', 'queued-job-count',
  'marker-names', 'marker-levels', 'marker-colors',
  'media-ready', 'media-source-supported', 'media-supported',
  'printer-make-and-model', 'printer-info', 'printer-location'
];

function toArray(v) {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

// 一次拿齐「驱动选项 + 耗材 + 纸盒」，供「发起打印」右栏与参数下拉使用。
// 虚拟打印机（raw 队列）没有后端设备，marker 会是空数组，由前端显示占位文案。
async function printerDetail(name) {
  const enc = encodeURIComponent(name);
  const [optRes, statRes] = await Promise.all([
    run('lpoptions', ['-p', name, '-l'], { timeout: 12000 }),
    run('lpstat', ['-l', '-p', name], { timeout: 8000 })
  ]);

  let attrs = {};
  let ippOk = false;
  try {
    const body = ipp.buildRequest({ uri: `ipp://127.0.0.1:631/printers/${enc}`, requested: DETAIL_ATTRS });
    const r = await ipp.postIpp({ host: '127.0.0.1', port: 631, path: `/printers/${enc}`, body, timeout: 4000 });
    if (r && r.ok) { attrs = r.attrs || {}; ippOk = true; }
  } catch (_) { /* 拿不到就当没有，不影响打印 */ }

  const names = toArray(attrs['marker-names']);
  const levels = toArray(attrs['marker-levels']);
  const colors = toArray(attrs['marker-colors']);
  const markers = names.map((n, i) => ({
    name: String(n),
    // -1/-2 未知、-3 表示该耗材不存在，统一归为 null 交给前端
    level: typeof levels[i] === 'number' && levels[i] >= 0 ? Math.min(levels[i], 100) : null,
    color: /^#?[0-9a-f]{6}$/i.test(String(colors[i] || '')) ? `#${String(colors[i]).replace('#', '')}` : ''
  })).filter((m) => m.name);

  const detail = {};
  for (const line of String(statRes.stdout || '').split(/\r?\n/)) {
    const m = line.match(/^\s+([A-Za-z][A-Za-z ]+?):\s*(.+)$/);
    if (m) detail[m[1].trim().toLowerCase()] = m[2].trim();
  }

  return {
    name,
    options: parseLpOptions(optRes.stdout),
    markers,
    mediaReady: toArray(attrs['media-ready']).map(String),
    mediaSources: toArray(attrs['media-source-supported']).map((v) => zhValue('InputSlot', String(v))),
    state: typeof attrs['printer-state'] === 'number' ? attrs['printer-state'] : null,
    stateReasons: toArray(attrs['printer-state-reasons']).map(String).filter((x) => x && x !== 'none'),
    accepting: attrs['printer-is-accepting-jobs'] === true,
    queuedJobs: typeof attrs['queued-job-count'] === 'number' ? attrs['queued-job-count'] : null,
    model: String(attrs['printer-make-and-model'] || detail['interface'] || ''),
    info: String(attrs['printer-info'] || detail['description'] || ''),
    location: String(attrs['printer-location'] || detail['location'] || ''),
    ipp: ippOk
  };
}

// ---------- 驱动 / 设备 ----------
let modelsCache = { at: 0, list: [] };
async function listModels(query = '') {
  if (!modelsCache.list.length || Date.now() - modelsCache.at > 300000) {
    const r = await run('lpinfo', ['-m'], { timeout: 45000 });
    modelsCache = {
      at: Date.now(),
      list: r.stdout.split(/\r?\n/).filter(Boolean).map((line) => {
        const sp = line.indexOf(' ');
        return sp < 0
          ? { id: line, label: line, driverless: line === 'everywhere' }
          : { id: line.slice(0, sp), label: line.slice(sp + 1).trim(), driverless: line.slice(0, sp) === 'everywhere' };
      })
    };
  }
  const q = String(query || '').toLowerCase();
  const list = q
    ? modelsCache.list.filter((m) => m.id.toLowerCase().includes(q) || m.label.toLowerCase().includes(q))
    : modelsCache.list;
  return { total: modelsCache.list.length, models: list.slice(0, 200) };
}

async function listDevices() {
  const r = await run('lpinfo', ['-v'], { timeout: 30000 });
  // lpinfo -v 除了设备行，还会输出「network ipp」「network beh」这类仅声明后端可用的行，
  // 它们没有 URI，必须过滤掉，否则自动扫描结果里全是垃圾项。
  const devices = [];
  for (const line of r.stdout.split(/\r?\n/)) {
    const m = line.match(/^(direct|network)\s+(\S+)(?:\s+(.*))?$/);
    if (!m) continue;
    const uri = m[2];
    if (!/^(ipp|ipps|dnssd|lpd|socket|usb|smb|http|https|file):\/\//i.test(uri)) continue;
    devices.push({
      class: m[1],
      uri,
      name: m[3] || '',
      driverless: /^(ipp|ipps|dnssd):\/\//i.test(uri)
    });
  }
  return { ok: r.ok, devices };
}

module.exports = {
  run, status, listPrinters, printerOptions, addPrinter, removePrinter, setDefault,
  pausePrinter, resumePrinter, acceptJobs, rejectJobs,
  listJobs, cancelJob, holdJob, releaseJob, submitJob,
  listModels, listDevices, buildPrintArgs, printerDetail, friendlyCupsError, queueInfo,
  zhValue, zhLabel
};
