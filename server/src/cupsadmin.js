'use strict';
// 容器内 CUPS 后台：服务状态 / 配置 / 日志 / 队列与作业运维。
// 只做「读 + 明确白名单内的写」，所有命令行调用都走 execFile（参数数组，不经 shell）。
const fs = require('fs');
const path = require('path');
const cups = require('./cups');
const config = require('./config');
const { cfg } = require('./db');
const printerstore = require('./printerstore');

const CONF = process.env.CUPS_CONF || '/etc/cups/cupsd.conf';
const LOG_DIR = process.env.CUPS_LOG_DIR || '/var/log/cups';

const LOG_FILES = {
  error: { file: path.join(LOG_DIR, 'error_log'), label: '错误日志 error_log' },
  access: { file: path.join(LOG_DIR, 'access_log'), label: '访问日志 access_log' },
  page: { file: path.join(LOG_DIR, 'page_log'), label: '计费日志 page_log' }
};

// 允许在页面里改的指令（值都做了白名单校验，改完需要重启 cupsd 才生效）
const EDITABLE = {
  LogLevel: {
    label: '日志级别',
    values: ['none', 'emerg', 'alert', 'crit', 'error', 'warn', 'notice', 'info', 'debug', 'debug2'],
    hint: '排障时可临时调到 debug，排查完建议回到 warn/info，避免日志暴涨'
  },
  Browsing: {
    label: '网络共享（Browsing）',
    values: ['On', 'Off', 'Yes', 'No', 'True', 'False'],
    hint: '关掉后本机队列不再向局域网广播'
  },
  WebInterface: {
    label: 'CUPS Web 界面',
    values: ['Yes', 'No', 'On', 'Off'],
    hint: 'CUPS 自带的 631 网页管理端；PrintGate 已提供管理台，通常建议关闭'
  },
  PreserveJobHistory: {
    label: '保留作业历史',
    values: ['Yes', 'No', 'On', 'Off'],
    hint: '关闭后已完成的作业不留在历史里，数据库仍是唯一记录来源'
  },
  PreserveJobFiles: {
    label: '保留作业文件',
    values: ['Yes', 'No', 'On', 'Off'],
    hint: '关闭后 CUPS 不再留存 spool 文件，可省 /var/spool 空间'
  },
  MaxJobs: {
    label: '最大并发作业数',
    pattern: /^\d{1,5}$/,
    hint: '0 表示不限制'
  },
  JobRetryLimit: {
    label: '失败重试次数',
    pattern: /^\d{1,3}$/,
    hint: '打印机离线时 CUPS 反复重试会卡住队列，建议 1~5'
  },
  JobRetryInterval: {
    label: '重试间隔（秒）',
    pattern: /^\d{1,5}$/,
    hint: '配合重试次数使用'
  }
};

// ---------- 基础探测 ----------
async function cupsConfig(flag) {
  const r = await cups.run('cups-config', [flag], { timeout: 5000 });
  return r.ok ? r.stdout.trim() : '';
}

// Alpine 的 cups 包不含 cups-config（在 cups-dev 里），所以按次序降级探测：
// 1) cups-config --version  2) apk 安装数据库  3) 留空由页面显示「未知」
async function version() {
  const v = await cupsConfig('--version');
  if (v) return v;
  try {
    const db = fs.readFileSync('/lib/apk/db/installed', 'utf8');
    const m = db.match(/^P:cups$\s*\n^V:([^\s]+)$/m);
    if (m) return m[1];
  } catch (_) { /* 非 Alpine 系统没有这个文件 */ }
  const r = await cups.run('apk', ['list', '-I'], { timeout: 5000 });
  const m2 = r.stdout.match(/^cups-(\S+)\s/m);
  return m2 ? m2[1] : '';
}

// busybox 的 pgrep -x 在容器里取不到 cupsd（进程名匹配不可靠），
// 直接扫 /proc/*/comm 最稳；扫不到再退回 pgrep -f。
async function pid() {
  try {
    const found = fs.readdirSync('/proc')
      .filter((d) => /^\d+$/.test(d))
      .filter((p) => {
        try { return fs.readFileSync(`/proc/${p}/comm`, 'utf8').trim() === 'cupsd'; } catch (_) { return false; }
      });
    if (found.length) return found;
  } catch (_) { /* 没有 /proc 时走命令行 */ }
  const r = await cups.run('pgrep', ['-f', 'cupsd'], { timeout: 4000 });
  return r.ok ? r.stdout.trim().split(/\s+/).filter(Boolean) : [];
}

async function installed() {
  const r = await cups.run('lpstat', ['-r'], { timeout: 5000 });
  return !r.enoent;
}

// ---------- 配置文件 ----------
// cupsd.conf 里可能有同名指令（多处 Listen / 注释里的同名行），
// 这里只解析「顶层、未注释」的指令，够页面展示用；写入时按「第一处出现」替换。
function parseConf(text) {
  const out = {};
  const listens = [];
  let depth = 0;
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (/^<\//.test(line)) { depth = Math.max(0, depth - 1); continue; }
    if (/^</.test(line)) { depth += 1; continue; }
    if (depth > 0) continue;
    const m = line.match(/^([A-Za-z][A-Za-z0-9_-]*)\s+(.+)$/);
    if (!m) continue;
    const key = m[1];
    const val = m[2].trim();
    if (key === 'Listen') { listens.push(val); continue; }
    if (!(key in out)) out[key] = val;
  }
  if (listens.length) out.Listen = listens.join(', ');
  return out;
}

function readConf() {
  let exists = false;
  let writable = false;
  let text = '';
  try {
    text = fs.readFileSync(CONF, 'utf8');
    exists = true;
  } catch (_) { text = ''; }
  try {
    fs.accessSync(CONF, fs.constants.W_OK);
    writable = exists;
  } catch (_) { writable = false; }
  return { path: CONF, exists, writable, size: exists ? (() => { try { return fs.statSync(CONF).size; } catch (_) { return 0; } })() : 0, directives: parseConf(text), raw: text };
}

function validateDirective(key, value) {
  const meta = EDITABLE[key];
  if (!meta) return { ok: false, msg: `不支持修改 ${key}` };
  const v = String(value == null ? '' : value).trim();
  if (meta.values && !meta.values.includes(v)) {
    return { ok: false, msg: `${meta.label} 只能是：${meta.values.join(' / ')}` };
  }
  if (meta.pattern && !meta.pattern.test(v)) {
    return { ok: false, msg: `${meta.label} 取值不合法` };
  }
  return { ok: true, value: v };
}

// 写入前先备份；同一指令多处出现时，只替换第一处，其余删除（避免新旧值同时存在导致 CUPS 报警）
function saveConf(patch) {
  const entries = Object.entries(patch || {});
  if (!entries.length) return { ok: false, msg: '没有要修改的配置' };
  const checked = [];
  for (const [k, v] of entries) {
    const r = validateDirective(k, v);
    if (!r.ok) return r;
    checked.push([k, r.value]);
  }
  let text = '';
  try { text = fs.readFileSync(CONF, 'utf8'); } catch (_) { return { ok: false, msg: `读不到 ${CONF}` }; }
  try {
    fs.writeFileSync(`${CONF}.pg.bak`, text, 'utf8');
  } catch (_) { /* 备份失败不阻断，配置文件本身仍可写 */ }

  const lines = text.split(/\r?\n/);
  const out = [];
  const seen = new Set();
  let depth = 0;
  for (const raw of lines) {
    const line = raw.trim();
    const isSectionStart = /^</.test(line) && !/^<\//.test(line);
    const isSectionEnd = /^<\//.test(line);
    if (!line.startsWith('#') && depth === 0) {
      const m = line.match(/^([A-Za-z][A-Za-z0-9_-]*)\s+(.+)$/);
      if (m && checked.some(([k]) => k === m[1])) {
        const [k, v] = checked.find(([k2]) => k2 === m[1]);
        if (!seen.has(k)) { out.push(`${k} ${v}`); seen.add(k); }
        continue; // 其余同名行丢弃
      }
    }
    if (isSectionEnd) depth = Math.max(0, depth - 1);
    else if (isSectionStart) depth += 1;
    out.push(raw);
  }
  // 文件里原本没有的指令，追加到末尾（放在所有 <Policy> 之后也合法，CUPS 按后写覆盖）
  for (const [k, v] of checked) {
    if (!seen.has(k)) out.push(`${k} ${v}`);
  }
  try {
    fs.writeFileSync(CONF, out.join('\n'), 'utf8');
  } catch (e) {
    return { ok: false, msg: `写入失败：${e.message}` };
  }
  return { ok: true, msg: `已保存 ${checked.map(([k]) => k).join('、')}，重启 CUPS 后生效`, needRestart: true };
}

// ---------- 日志 ----------
function tail(file, lines) {
  try {
    const st = fs.statSync(file);
    const size = Math.min(st.size, 512 * 1024);
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(size);
    fs.readSync(fd, buf, 0, size, Math.max(0, st.size - size));
    fs.closeSync(fd);
    return buf.toString('utf8').split(/\r?\n/).slice(-lines).join('\n');
  } catch (_) {
    return '';
  }
}

function logs(name, lines = 200) {
  const meta = LOG_FILES[name] || LOG_FILES.error;
  const n = Math.min(Math.max(parseInt(lines, 10) || 200, 20), 2000);
  const exists = fs.existsSync(meta.file);
  return {
    ok: true, name, label: meta.label, path: meta.file, exists,
    size: exists ? (() => { try { return fs.statSync(meta.file).size; } catch (_) { return 0; } })() : 0,
    content: exists ? tail(meta.file, n) : ''
  };
}

function logList() {
  return Object.entries(LOG_FILES).map(([key, v]) => ({
    key, label: v.label, path: v.file, exists: fs.existsSync(v.file),
    size: fs.existsSync(v.file) ? (() => { try { return fs.statSync(v.file).size; } catch (_) { return 0; } })() : 0
  }));
}

// ---------- 队列 / 作业运维 ----------
const badQueueName = (name) => !/^[A-Za-z0-9_.-]{1,60}$/.test(String(name || ''));

async function queueAction(name, op) {
  if (badQueueName(name)) return { ok: false, msg: '队列名只能包含字母、数字、下划线、点和中划线' };
  const map = {
    enable: () => cups.resumePrinter(name),
    disable: () => cups.pausePrinter(name),
    accept: () => cups.acceptJobs(name),
    reject: () => cups.rejectJobs(name),
    default: () => cups.setDefault(name)
  };
  if (op === 'purge') {
    const r = await cups.run('cancel', ['-a', '-x', name], { timeout: 15000 });
    return { ok: r.ok, msg: r.ok ? `已清空「${name}」的所有作业` : cups.friendlyCupsError(r.stderr || r.error) };
  }
  const fn = map[op];
  if (!fn) return { ok: false, msg: '不支持的操作' };
  const r = await fn();
  const text = { enable: `已启用「${name}」`, disable: `已停用「${name}」`, accept: `「${name}」已恢复接收`, reject: `「${name}」已停止接收`, default: `「${name}」已设为默认` }[op];
  if (!r.ok) return { ok: false, msg: cups.friendlyCupsError(r.msg || r.stderr || '操作失败') };
  return { ok: true, msg: text };
}

async function jobAction(id, op) {
  const jobId = String(id || '').trim();
  if (!/^[A-Za-z0-9_.-]{1,60}-\d{1,10}$/.test(jobId)) return { ok: false, msg: '作业 ID 不合法' };
  if (op === 'cancel') {
    const r = await cups.cancelJob(jobId);
    return r.ok ? { ok: true, msg: `已取消 ${jobId}` } : { ok: false, msg: r.msg || '取消失败' };
  }
  if (op === 'purge') {
    const r = await cups.cancelJob(jobId, { purge: true });
    return r.ok ? { ok: true, msg: `已清除 ${jobId}` } : { ok: false, msg: r.msg || '清除失败' };
  }
  if (op === 'hold') {
    const r = await cups.holdJob(jobId);
    return r.ok ? { ok: true, msg: `已暂停 ${jobId}` } : { ok: false, msg: r.msg || '暂停失败' };
  }
  if (op === 'release') {
    const r = await cups.releaseJob(jobId);
    return r.ok ? { ok: true, msg: `已恢复 ${jobId}` } : { ok: false, msg: r.msg || '恢复失败' };
  }
  return { ok: false, msg: '不支持的操作' };
}

// ---------- 汇总 ----------
async function status() {
  const [st, ver, pids, hasCli, plist, jobs, confInfo] = await Promise.all([
    cups.status(),
    version(),
    pid(),
    installed(),
    cups.listPrinters(),
    cups.listJobs(),
    Promise.resolve(readConf())
  ]);
  const [serverRoot, logDir, dataDir, serverBin, runDir] = await Promise.all([
    cupsConfig('--serverroot'), cupsConfig('--logdir'), cupsConfig('--datadir'),
    cupsConfig('--serverbin'), cupsConfig('--rundir')
  ]);

  const queues = plist.printers || [];
  const jobList = jobs.jobs || [];
  const c = cfg();

  return {
    ok: true,
    installed: hasCli,
    running: !!st.running,
    message: st.message,
    version: ver || '未知',
    pid: pids,
    server: String(c.cupsServer || '127.0.0.1:631'),
    conf: { ...confInfo, raw: undefined, editable: Object.fromEntries(Object.entries(EDITABLE).map(([k, v]) => [k, { label: v.label, values: v.values || null, hint: v.hint, current: confInfo.directives[k] || '' }])) },
    paths: {
      conf: CONF,
      confDir: serverRoot || '/etc/cups',
      logDir: logDir || LOG_DIR,
      dataDir: dataDir || '/usr/share/cups',
      serverBin: serverBin || '/usr/lib/cups',
      runDir: runDir || '/run/cups',
      ppdDir: path.join(serverRoot || '/etc/cups', 'ppd')
    },
    logs: logList(),
    counts: {
      queues: queues.length,
      online: queues.filter((p) => p.enabled !== false && p.accepting !== false).length,
      stopped: queues.filter((p) => p.enabled === false).length,
      rejecting: queues.filter((p) => p.accepting === false).length,
      jobs: jobList.length,
      processing: jobList.filter((j) => j.state === 'processing').length
    },
    defaultPrinter: plist.default || '',
    queues: queues.map((p) => ({
      name: p.name,
      state: p.state,
      enabled: p.enabled,
      accepting: p.accepting,
      uri: p.uri,
      info: p.info,
      model: p.model,
      isDefault: !!p.isDefault,
      activeJob: p.activeJob || ''
    })),
    jobs: jobList.slice(0, 50).map((j) => ({
      id: j.id, printer: j.printer, user: j.user, size: j.size,
      submitted: j.submitted, state: j.state
    })),
    // 自愈记录：PrintGate 自己存了一份队列配置，容器重建后靠它恢复
    store: { count: printerstore.all().length }
  };
}

module.exports = {
  status, logs, logList, readConf, saveConf, queueAction, jobAction,
  CONF, LOG_DIR, EDITABLE, badQueueName
};
