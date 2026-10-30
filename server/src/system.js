'use strict';
// 系统信息 / 服务状态 / 日志 / 内网穿透配置
const fs = require('fs');
const os = require('os');
const path = require('path');
const cups = require('./cups');
const config = require('./config');
const { cfg } = require('./db');

const LOG_FILES = {
  app: { file: path.join(config.logDir, 'app.log'), label: 'PrintGate 服务日志' },
  frp: { file: path.join(config.logDir, 'frpc.log'), label: 'frp 内网穿透日志' },
  cups: { file: '/var/log/cups/error_log', label: 'CUPS 错误日志' },
  access: { file: '/var/log/cups/access_log', label: 'CUPS 访问日志' }
};

async function diskUsage() {
  try {
    const st = await fs.promises.statfs(config.dataDir);
    const total = st.blocks * st.bsize;
    const free = st.bavail * st.bsize;
    return { total, free, used: total - free };
  } catch (_) {
    return { total: 0, free: 0, used: 0 };
  }
}

async function info() {
  const memTotal = os.totalmem();
  const memFree = os.freemem();
  const disk = await diskUsage();
  return {
    app: 'PrintGate',
    version: config.version,
    node: process.version,
    hostname: os.hostname(),
    platform: `${os.platform()} ${os.release()}`,
    arch: os.arch(),
    uptime: Math.round(process.uptime()),
    osUptime: Math.round(os.uptime()),
    cpu: {
      model: (os.cpus()[0] || {}).model || 'unknown',
      cores: os.cpus().length,
      load: os.loadavg().map((n) => Math.round(n * 100) / 100)
    },
    mem: { total: memTotal, free: memFree, used: memTotal - memFree },
    disk,
    dataDir: config.dataDir,
    time: new Date().toISOString(),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone
  };
}

async function pgrep(pattern) {
  const r = await cups.run('pgrep', ['-f', pattern], { timeout: 4000 });
  return r.ok ? r.stdout.trim().split(/\s+/).filter(Boolean) : [];
}

async function services() {
  const [cupsd, cupsSt, avahi, frpc, scanimage, node] = await Promise.all([
    pgrep('cupsd'),
    cups.status(),
    pgrep('avahi-daemon'),
    pgrep('frpc'),
    pgrep('scanimage|sane'),
    pgrep('node .*src/index.js|node src/index.js')
  ]);
  const c = cfg();
  return [
    { key: 'printgate', name: 'PrintGate 服务', running: true, detail: `PID ${node.join(',') || process.pid}`, canRestart: false },
    { key: 'cups', name: 'CUPS 打印服务', running: cupsSt.running, detail: cupsSt.message, canRestart: true },
    { key: 'avahi', name: 'Avahi/AirPrint 广播', running: avahi.length > 0, detail: avahi.length ? `PID ${avahi.join(',')}` : '未运行（网络打印机发现可能受影响）', canRestart: true, optional: true },
    {
      key: 'frp', name: 'frp 内网穿透', running: frpc.length > 0,
      detail: c.enableFrp ? (frpc.length ? `已连接 ${c.frpServer}:${c.frpPort}` : '已启用但未运行') : '未启用（无需穿透时可忽略）',
      canRestart: true, enabled: c.enableFrp,
      optional: !c.enableFrp   // 未启用属于正常配置，不应显示为故障
    },
    { key: 'scan', name: '扫描组件 (SANE)', running: scanimage.length > 0, detail: scanimage.length ? '扫描进程运行中' : '按需调用（无进程时为空闲）', canRestart: false, optional: true }
  ];
}

function readTail(file, lines = 200) {
  try {
    const st = fs.statSync(file);
    const size = Math.min(st.size, 256 * 1024);
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(size);
    fs.readSync(fd, buf, 0, size, st.size - size);
    fs.closeSync(fd);
    const text = buf.toString('utf8');
    return text.split(/\r?\n/).slice(-lines).join('\n');
  } catch (e) {
    return '';
  }
}

function logs(name, lines = 200) {
  // 不能直接 LOG_FILES[name]：__proto__ / constructor 会命中原型上的东西，
  // 虽然读不到文件，但会返回 200 + 一堆 undefined，看着像成功。
  const meta = Object.prototype.hasOwnProperty.call(LOG_FILES, name) ? LOG_FILES[name] : null;
  if (!meta) return { ok: false, msg: '未知日志' };
  const exists = fs.existsSync(meta.file);
  return {
    ok: true,
    name,
    label: meta.label,
    path: meta.file,
    exists,
    content: exists ? readTail(meta.file, Math.min(Math.max(lines, 20), 2000)) : ''
  };
}

function logList() {
  return Object.entries(LOG_FILES).map(([key, v]) => ({
    key, label: v.label, path: v.file, exists: fs.existsSync(v.file),
    size: fs.existsSync(v.file) ? fs.statSync(v.file).size : 0
  }));
}

async function restartService(key) {
  if (key === 'cups') {
    const before = await pgrep('cupsd');
    await cups.run('pkill', ['-x', 'cupsd'], { timeout: 5000 });
    // 容器里由 entrypoint 守护进程拉起；裸机部署没有守护，杀完就永久没了 —— 这里自己兜一下
    for (let i = 0; i < 10; i++) {
      await new Promise((r) => setTimeout(r, 300));
      const now = await pgrep('cupsd');
      if (now.length) return { ok: true, msg: before.length ? 'CUPS 已重启' : 'CUPS 已启动' };
    }
    const started = await cups.run('cupsd', [], { timeout: 5000 }).catch(() => null);
    await new Promise((r) => setTimeout(r, 800));
    const alive = await pgrep('cupsd');
    if (alive.length) return { ok: true, msg: 'CUPS 已重新拉起' };
    return { ok: false, msg: `CUPS 未能重启${started && started.stderr ? '：' + started.stderr.slice(0, 120) : ''}，请手动检查 cupsd` };
  }
  if (key === 'avahi') {
    await cups.run('pkill', ['-x', 'avahi-daemon'], { timeout: 5000 });
    return { ok: true, msg: 'Avahi 已重启' };
  }
  if (key === 'frp') {
    writeFrpFiles();
    await cups.run('pkill', ['-x', 'frpc'], { timeout: 5000 });
    return { ok: true, msg: 'frp 配置已重新生成，守护进程将自动重启客户端' };
  }
  return { ok: false, msg: '不支持重启该服务' };
}

// frpc 配置由 entrypoint 的守护循环读取 /data/frp/frpc.toml 决定是否启动
// tcp 模式：云端用独立端口（remotePort）直接映射；wss 模式：复用 443，经 nginx 的 /~!frp 转发到 frps
// TOML basic string 转义：防止服务端地址/Token 里的引号或换行截断配置、注入额外 [[proxies]]。
// frp 会把 remotePort 等字段暴露到公网，配置注入等同于把任意内网端口转发出去，必须转义。
function tomlStr(v) {
  const s = String(v == null ? '' : v);
  return s.replace(/[\x00-\x1f\x7f\\"]/g, (ch) => {
    if (ch === '\\') return '\\\\';
    if (ch === '"') return '\\"';
    if (ch === '\n') return '\\n';
    if (ch === '\r') return '\\r';
    if (ch === '\t') return '\\t';
    return '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0');
  });
}

function buildFrpToml(c = cfg()) {
  const mode = c.frpMode === 'wss' ? 'wss' : 'tcp';
  const lines = [
    '# 由 PrintGate 自动生成，请勿手工编辑',
    `serverAddr = "${tomlStr(c.frpServer)}"`,
    `serverPort = ${c.frpPort}`,
    'auth.method = "token"',
    `auth.token = "${tomlStr(c.frpToken)}"`,
    `log.to = "${tomlStr(path.join(config.logDir, 'frpc.log'))}"`,
    'log.level = "info"'
  ];
  if (mode === 'wss') {
    lines.push('transport.protocol = "wss"');
    lines.push('transport.tls.enable = true');
    lines.push('transport.poolCount = 5');
  }
  lines.push('');
  lines.push('[[proxies]]');
  lines.push('name = "printgate-web"');
  lines.push('type = "tcp"');
  lines.push('localIP = "127.0.0.1"');
  lines.push(`localPort = ${config.port}`);
  lines.push(`remotePort = ${c.frpRemotePort}`);
  return `${lines.join('\n')}\n`;
}

function writeFrpFiles() {
  const c = cfg();
  const dir = path.join(config.dataDir, 'frp');
  fs.mkdirSync(dir, { recursive: true });
  const toml = buildFrpToml(c);
  fs.writeFileSync(path.join(dir, 'frpc.toml'), toml, 'utf8');
  fs.writeFileSync(path.join(dir, 'enabled'), c.enableFrp ? '1' : '0', 'utf8');
  return toml;
}

module.exports = { info, services, logs, logList, restartService, writeFrpFiles, buildFrpToml, diskUsage, pgrep };
