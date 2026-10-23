'use strict';
// 中转向导回归：配置生成 + 语法校验 + 自检 + 单端口隧道实连
// 用法：PG_BASE=http://127.0.0.1:18080 PG_PASS=xxx node tools/relay-test.js
const fs = require('fs');
const path = require('path');

const BASE = process.env.PG_BASE || 'http://127.0.0.1:18080';
const PASS = process.env.PG_PASS || 'Relay2026test';

let TOKEN = '';
const results = [];
const rec = (name, pass, detail = '') => {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  —  ${detail}` : ''}`);
};

async function req(method, url, body, token = TOKEN) {
  const opt = { method, headers: {} };
  if (token) opt.headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) {
    opt.headers['Content-Type'] = 'application/json';
    opt.body = JSON.stringify(body);
  }
  const r = await fetch(`${BASE}${url}`, opt);
  const text = await r.text();
  let data;
  try { data = JSON.parse(text); } catch (_) { data = { raw: text.slice(0, 200) }; }
  return { status: r.status, data };
}

(async () => {
  let r = await req('GET', '/api/public/bootstrap', undefined, '');
  if (r.data.needsSetup) {
    r = await req('POST', '/api/setup', { password: PASS, confirm: PASS }, '');
    TOKEN = r.data.token;
  } else {
    r = await req('POST', '/api/auth/login', { password: PASS }, '');
    TOKEN = r.data.token;
  }
  rec('管理员登录', !!TOKEN);
  if (!TOKEN) process.exit(1);

  console.log('\n== A. 单端口（wss）配置生成 ==');
  r = await req('PUT', '/api/settings', {
    frpMode: 'wss',
    frpDomain: 'print.example.com',
    frpServer: 'print.example.com',
    frpPort: 443,
    frpRemotePort: 18080,
    frpToken: 'token-abcdefghijklmnopqrstuvwxyz-123456',
    relayPublicUrl: 'https://print.example.com',
    enableFrp: true
  });
  rec('保存单端口配置', r.status === 200 && r.data.ok, r.data.msg || JSON.stringify(r.data.errors || ''));

  r = await req('GET', '/api/relay/plan');
  const plan = r.data;
  rec('plan 返回 wss 模式', plan.mode === 'wss', plan.mode);
  rec('frpc 使用 wss 协议', /transport\.protocol = "wss"/.test(plan.frpcToml) && /transport\.tls\.enable = true/.test(plan.frpcToml),
    plan.frpcToml.split('\n').filter((l) => l.includes('transport')).join(' | '));
  rec('frpc 端口指向 443', /serverPort = 443/.test(plan.frpcToml));
  rec('frpc 映射本机服务端口', new RegExp(`localPort = ${plan.localPort}`).test(plan.frpcToml), `localPort=${plan.localPort}`);
  rec('frps 片段绑定 127.0.0.1', /proxyBindAddr = "127\.0\.0\.1"/.test(plan.frpsToml));
  rec('nginx 片段含 /~!frp 转发', /location \/~!frp/.test(plan.nginxSnippet) && /proxy_set_header Upgrade/.test(plan.nginxSnippet));
  rec('nginx 上传上限跟随 maxFileMB', /client_max_body_size \d+m/.test(plan.nginxSnippet),
    (plan.nginxSnippet.match(/client_max_body_size \d+m/) || [])[0] || '');
  rec('nginx 转发到隧道端口', new RegExp(`proxy_pass http://127\\.0\\.0\\.1:${plan.remotePort}`).test(plan.nginxSnippet));

  console.log('\n== B. tcp 模式 ==');
  r = await req('PUT', '/api/settings', { frpMode: 'tcp', frpServer: '1.2.3.4', frpPort: 7000, frpRemotePort: 18081 });
  r = await req('GET', '/api/relay/plan');
  rec('tcp 模式不再带 wss 传输', !/transport\.protocol/.test(r.data.frpcToml), '');
  rec('tcp 模式 frps 允许公网映射', /proxyBindAddr = "0\.0\.0\.0"/.test(r.data.frpsToml));
  rec('tcp 模式 nginx 无 /~!frp', !/location \/~!frp/.test(r.data.nginxSnippet));
  rec('tcp 模式给出端口提示', (r.data.warnings || []).some((w) => w.includes('公网端口')));

  console.log('\n== C. 参数校验 ==');
  r = await req('PUT', '/api/settings', { frpMode: 'ftp' });
  rec('非法模式被拒', r.status === 400, (r.data.errors || []).join(';') || r.data.msg || '');
  r = await req('PUT', '/api/settings', { frpDomain: 'http://bad domain' });
  rec('非法域名被拒', r.status === 400, (r.data.errors || []).join(';') || r.data.msg || '');
  r = await req('PUT', '/api/settings', { frpDomain: 'PRINT.Example.COM' });
  rec('域名大小写归一', r.status === 200 && r.data.settings.relay.frpDomain === 'print.example.com',
    r.data.settings?.relay?.frpDomain || '');

  console.log('\n== D. 自检接口 ==');
  r = await req('POST', '/api/relay/check', {});
  const names = (r.data.checks || []).map((c) => c.name);
  rec('自检返回全部检查项', r.status === 200 && names.length >= 6, names.join(','));
  rec('自检含本机服务与 frp 配置', names.includes('本机服务') && names.includes('frp 配置'));
  const baseCheck = (r.data.checks || []).find((c) => c.name === '对外地址');
  rec('识别非法 BASE（tcp 模式下 BASE 为 https 域名应通过）', !!baseCheck, baseCheck ? String(baseCheck.ok) : '');

  console.log('\n== E. 生成文件落盘 ==');
  const dir = path.join(process.env.PG_DATA_DIR || '', 'frp');
  const file = path.join(dir, 'frpc.toml');
  rec('frpc.toml 已写入', fs.existsSync(file), file);
  if (fs.existsSync(file)) {
    const toml = fs.readFileSync(file, 'utf8');
    rec('落盘内容与接口一致', toml.includes('serverAddr'), toml.split('\n')[0].slice(0, 40));
  }
  rec('enabled 标记为 1', fs.existsSync(path.join(dir, 'enabled')) && fs.readFileSync(path.join(dir, 'enabled'), 'utf8') === '1');

  const fails = results.filter((x) => !x.pass);
  console.log(`\n总计 ${results.length} 项，失败 ${fails.length} 项`);
  if (fails.length) fails.forEach((f) => console.log(' -', f.name, f.detail));
  fs.writeFileSync(require('./_paths').shot('relay-test.json'), JSON.stringify(results, null, 2));
  process.exit(fails.length ? 1 : 0);
})();
