'use strict';
// 中转对接向导：生成 frps / nginx / frpc 配置，并提供部署自检
const express = require('express');
const fs = require('fs');
const net = require('net');
const path = require('path');
const config = require('../config');
const system = require('../system');
const cups = require('../cups');
const sec = require('../security');
const { cfg, logAudit } = require('../db');
const { requireAdmin } = require('../middleware');

const router = express.Router();

function isIpv4(h) {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(h);
}

function nginxSnippet(c) {
  const mode = c.frpMode === 'wss' ? 'wss' : 'tcp';
  const domain = c.frpDomain || 'print.example.com';
  const upstream = c.frpRemotePort;
  const frpLocation = mode === 'wss'
    ? `
  # frp 控制通道复用 443（frpc 走 wss，路径固定 /~!frp）
  location /~!frp {
    proxy_pass http://127.0.0.1:7000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_read_timeout 3600s;
  }
`
    : '';
  const listenNote = mode === 'wss'
    ? '# 公网只开 443：网站流量与 frp 控制通道共用同一个端口'
    : '# 公网开 443（网站）与 ' + upstream + '（frp 隧道）；建议安全组只放行这两个端口';
  return `# ${listenNote}
# 保存为 /etc/nginx/conf.d/printgate.conf 后执行 nginx -t && nginx -s reload
server {
  listen 443 ssl;
  http2 on;
  server_name ${domain};

  ssl_certificate     /etc/letsencrypt/live/${domain}/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/${domain}/privkey.pem;

  # 上传上限要比 PrintGate 的"单文件上限"大一点，否则会先被 nginx 拦成 413
  client_max_body_size ${Math.max(16, Number(c.maxFileMB || 20) + 4)}m;
${frpLocation}
  location / {
    proxy_pass http://127.0.0.1:${upstream};
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto https;
    proxy_request_buffering off;
    proxy_read_timeout 120s;
  }
}`;
}

function frpsToml(c) {
  const mode = c.frpMode === 'wss' ? 'wss' : 'tcp';
  return `# 云服务器 /etc/frp/frps.toml
bindPort = 7000
auth.method = "token"
auth.token = "${c.frpToken || '把这里的 token 换成随机长串'}"

# 隧道对端端口：wss 模式下只给本机 nginx 用，公网无法直连
# tcp 模式想让公网直接访问映射端口时改成 "0.0.0.0"
proxyBindAddr = "${mode === 'wss' ? '127.0.0.1' : '0.0.0.0'}"

# 注意：wss 模式下 TLS 在 nginx 终结，frps 保持明文即可，
# 不要加 transport.tls.force = true，否则 nginx 转发过来的连接会被拒。
log.to = "/var/log/frps.log"
log.level = "info"`;
}

router.get('/relay/plan', requireAdmin, (req, res) => {
  const base = cfg();
  // 支持用查询参数预览（表单还没保存时也能看到正确的片段）
  const q = req.query || {};
  const c = {
    ...base,
    frpMode: q.mode === 'wss' ? 'wss' : q.mode === 'tcp' ? 'tcp' : base.frpMode,
    frpDomain: q.domain !== undefined ? String(q.domain) : base.frpDomain,
    frpRemotePort: Number(q.remotePort) > 0 ? Number(q.remotePort) : base.frpRemotePort,
    frpServer: q.server !== undefined ? String(q.server) : base.frpServer,
    frpPort: Number(q.serverPort) > 0 ? Number(q.serverPort) : base.frpPort,
    relayPublicUrl: q.base !== undefined ? String(q.base) : base.relayPublicUrl
  };
  const mode = c.frpMode === 'wss' ? 'wss' : 'tcp';
  const baseUrl = String(c.relayPublicUrl || '').trim();
  const warnings = [];
  if (mode === 'wss') {
    if (!c.frpDomain) warnings.push('还没填域名：小程序访问必须是 https 域名，且要在微信后台加入合法域名。');
    if (Number(c.frpPort) !== 443) warnings.push(`wss 模式建议把「服务端端口」设为 443（当前 ${c.frpPort}），否则 nginx 要监听该端口。`);
    if (c.frpServer && isIpv4(c.frpServer)) warnings.push('wss 模式下「服务端地址」建议填域名：证书按域名签发，填 IP 会校验失败。');
  } else {
    warnings.push('tcp 模式会额外占用一个公网端口（远程端口）；小程序只能走 https 域名，所以仍需 443 反代。');
  }
  if (!baseUrl) warnings.push('还没设置对外访问地址（BASE），小程序无法回连。');
  res.json({
    ok: true,
    mode,
    localPort: config.port,
    remotePort: c.frpRemotePort,
    serverAddr: c.frpServer,
    serverPort: c.frpPort,
    tokenConfigured: !!c.frpToken,
    domain: c.frpDomain,
    baseUrl,
    maxFileMB: c.maxFileMB,
    frpcToml: system.buildFrpToml(c),
    frpsToml: frpsToml(c),
    nginxSnippet: nginxSnippet(c),
    warnings,
    paths: {
      frpc: path.join(config.dataDir, 'frp', 'frpc.toml'),
      enabledFlag: path.join(config.dataDir, 'frp', 'enabled')
    }
  });
});

function tcpProbe(host, port, timeout = 4000) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    let done = false;
    const finish = (ok, msg) => {
      if (done) return;
      done = true;
      sock.destroy();
      resolve({ ok, msg });
    };
    sock.setTimeout(timeout);
    sock.once('connect', () => finish(true, '可连通'));
    sock.once('timeout', () => finish(false, `连接 ${host}:${port} 超时`));
    sock.once('error', (e) => finish(false, `${host}:${port} 不可达（${e.code || e.message}）`));
    sock.connect(port, host);
  });
}

router.post('/relay/check', requireAdmin, async (req, res) => {
  const saved = cfg();
  // 支持传入表单里的最新值：还没保存也能按「即将生效的配置」自检
  const b = req.body || {};
  const c = {
    ...saved,
    frpMode: b.mode === 'wss' ? 'wss' : b.mode === 'tcp' ? 'tcp' : saved.frpMode,
    frpDomain: b.domain !== undefined ? String(b.domain) : saved.frpDomain,
    frpServer: b.server !== undefined ? String(b.server) : saved.frpServer,
    frpPort: Number(b.serverPort) > 0 ? Number(b.serverPort) : saved.frpPort,
    frpRemotePort: Number(b.remotePort) > 0 ? Number(b.remotePort) : saved.frpRemotePort,
    relayPublicUrl: b.base !== undefined ? String(b.base) : saved.relayPublicUrl
  };
  const mode = c.frpMode === 'wss' ? 'wss' : 'tcp';
  const checks = [];
  const push = (name, ok, detail, hint = '') => checks.push({ name, ok, detail, hint });

  // 1. 本机服务
  let localOk = false;
  try {
    const r = await fetch(`http://127.0.0.1:${config.port}/api/health`, { signal: AbortSignal.timeout(4000) });
    const j = await r.json().catch(() => ({}));
    localOk = r.ok && j.ok;
    push('本机服务', localOk, localOk ? `127.0.0.1:${config.port} 正常（v${j.version || '?'}）` : `HTTP ${r.status}`);
  } catch (e) {
    push('本机服务', false, e.message, '容器是否健康？可在「系统状态」查看');
  }

  // 2. 打印链路
  const printers = await cups.listPrinters();
  const ready = (printers.printers || []).filter((p) => p.enabled);
  push('打印机就绪', ready.length > 0,
    ready.length ? `${ready.length} 台可用（${ready.slice(0, 3).map((p) => p.name).join(', ')}）` : '还没有可用打印机',
    '先在「打印机」页添加并启用一台');

  // 2.5 frpc 二进制是否存在（默认镜像为减小攻击面已移除 frp，见 Dockerfile 的 WITH_FRP）
  const frpcProbe = await cups.run('frpc', ['-v'], { timeout: 5000 }).catch(() => ({ ok: false, stdout: '' }));
  const hasFrpc = !!(frpcProbe.ok || /\d+\.\d+/.test(String(frpcProbe.stdout || '')));
  push('frp 客户端二进制', hasFrpc,
    hasFrpc ? (String(frpcProbe.stdout || '').trim().split(String.fromCharCode(10))[0] || '已安装') : '当前镜像未包含 frpc',
    hasFrpc ? '' : '需要内网穿透时：用 --build-arg WITH_FRP=1 重建镜像，或把官方 frpc 二进制挂到 /usr/local/bin/frpc');

  // 3. frp 配置语法（用 frpc verify 实测）
  const confPath = path.join(config.dataDir, 'frp', 'frpc.toml');
  if (!hasFrpc) {
    push('frp 配置', false, '未安装 frpc，无法校验配置', '先补齐 frpc 二进制再自检');
  } else if (!fs.existsSync(confPath)) {
    push('frp 配置', false, '尚未生成 frpc.toml', '完成第 3 步并保存后自动生成');
  } else {
    const v = await cups.run('frpc', ['verify', '-c', confPath], { timeout: 8000 });
    push('frp 配置', v.ok, (v.ok ? 'frpc.toml 语法正确' : (v.stderr || v.stdout || '校验失败').trim().slice(0, 200)),
      v.ok ? '' : '检查服务端地址/端口/Token 是否符合示例');
  }

  // 4. frpc 进程
  const pg = await system.pgrep('frpc');
  push('frp 客户端', pg.length > 0,
    pg.length ? `运行中（PID ${pg.join(',')}）` : '未运行',
    pg.length ? '' : '确认已勾选「启用 frp」并保存；日志在「日志审计 → frp」');

  // 5. 服务端可达性
  if (c.frpServer) {
    const probe = await tcpProbe(c.frpServer, Number(c.frpPort));
    push('服务端可达', probe.ok, `${c.frpServer}:${c.frpPort} ${probe.msg}`,
      probe.ok ? '' : '检查云服务器安全组、frps 是否启动、域名解析');
  } else {
    push('服务端可达', false, '未填写服务端地址');
  }

  // 6. 对外地址合规（小程序强要求）
  const base = String(c.relayPublicUrl || '').trim();
  if (!base) {
    push('对外地址', false, '未设置 BASE', '填 https://你的域名（不能带端口、不能用 IP）');
  } else {
    let u = null;
    try { u = new URL(base); } catch (_) {}
    if (!u) {
      push('对外地址', false, `无法解析：${base}`);
    } else {
      const isHttps = u.protocol === 'https:';
      const hostOk = !isIpv4(u.hostname) && u.hostname !== 'localhost';
      const portOk = !u.port || u.port === '443';
      const ok = isHttps && hostOk && portOk;
      push('对外地址', ok,
        `${base}（${isHttps ? 'https' : '非 https'}${portOk ? '' : '，带非 443 端口'}${hostOk ? '' : '，是 IP/localhost'}）`,
        ok ? '' : '微信小程序只接受 https + 已备案域名 + 443');
    }
  }

  // 7. 公网回连（云 → 隧道 → 本机）
  if (base && /^https:\/\//i.test(base)) {
    try {
      const r = await fetch(`${base.replace(/\/+$/, '')}/api/health`, { signal: AbortSignal.timeout(8000) });
      const j = await r.json().catch(() => ({}));
      push('公网回连', r.ok && j.ok, r.ok ? `${base}/api/health 正常` : `HTTP ${r.status}`,
        r.ok ? '' : '检查 nginx 反代是否指向隧道端口、frpc 是否在线');
    } catch (e) {
      push('公网回连', false, `请求失败：${e.message}`,
        '域名解析 / 证书 / nginx / 隧道 任一环节未就绪都会失败');
    }
  }

  // 8. 上传上限对齐
  const maxMb = Number(c.maxFileMB || 20);
  push('上传上限', true, `PrintGate 单文件 ${maxMb} MB；nginx 片段里 client_max_body_size 已设为 ${Math.max(16, maxMb + 4)}m`,
    '两处不一致时，大文件会先被 nginx 413 拦掉');

  // 9. 模式提示
  if (mode === 'wss') {
    push('单端口模式', c.frpDomain && Number(c.frpPort) === 443,
      `wss 复用 443（域名 ${c.frpDomain || '未填'}，端口 ${c.frpPort}）`,
      '服务端端口需为 443，且 nginx 必须有 /~!frp 转发');
  }

  logAudit('relay_check', `ok=${checks.filter((x) => x.ok).length}/${checks.length}`, sec.clientIp(req), 'admin');
  res.json({ ok: true, checks, passed: checks.filter((x) => x.ok).length, total: checks.length });
});

router.post('/relay/restart', requireAdmin, async (req, res) => {
  const r = await system.restartService('frp');
  logAudit('relay_restart', r.msg || '', sec.clientIp(req), 'admin');
  res.json(r);
});

module.exports = router;
