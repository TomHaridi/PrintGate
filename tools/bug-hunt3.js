'use strict';
// PrintGate 深度猎杀：配置注入 / 令牌安全 / 参数模糊 / 并发一致性 / 权限边界
// 用法：PG_BASE=http://127.0.0.1:8080 PG_PASS=xxx node tools/bug-hunt3.js
const BASE = process.env.PG_BASE || 'http://127.0.0.1:8080';
const PASS = process.env.PG_PASS || 'LocalTest2026';

const NL = String.fromCharCode(10);
const TAB = String.fromCharCode(9);
const CR = String.fromCharCode(13);
const QUOTE = String.fromCharCode(34);

let TOKEN = '';
const results = [];
const rec = (name, pass, detail = '') => {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  —  ${detail}` : ''}`);
};

async function req(method, url, body, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (TOKEN && !headers.Authorization && opts.anonymous !== true) headers.Authorization = `Bearer ${TOKEN}`;
  let payload;
  if (body !== undefined) {
    // FormData 必须让 fetch 自己生成 multipart boundary，不能塞 application/json
    if (body instanceof FormData) payload = body;
    else { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  }
  const res = await fetch(BASE + url, { method, headers, body: payload });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch (_) { data = { raw: text.slice(0, 200) }; }
  return { status: res.status, data, text };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 取服务端实际生成的 frpc 配置全文，靠它验证注入有没有落进配置
async function frpPreview() {
  const r = await req('GET', '/api/relay/plan');
  return r.data.frpcToml || JSON.stringify(r.data);
}

(async () => {
  const boot = await req('GET', '/api/public/bootstrap', undefined, { anonymous: true });
  if (boot.data.needsSetup) {
    const st = await req('POST', '/api/setup', { password: PASS, confirm: PASS });
    TOKEN = st.data.token || '';
  } else {
    const lg = await req('POST', '/api/auth/login', { password: PASS });
    TOKEN = lg.data.token || '';
  }
  if (!TOKEN) { console.log('无法登录，终止'); process.exit(1); }

  console.log(NL + '== A. 生成配置注入（frpc.toml / nginx） ==');
  const injects = [
    ['Token 闭合引号注入 proxies', { frpToken: 'evil' + QUOTE + NL + '[[proxies]]' + NL + 'name = ' + QUOTE + 'injected' + QUOTE + NL + 'remotePort = 19999' + NL + 'x = ' + QUOTE }],
    ['Token 含换行', { frpToken: 'abc' + NL + 'log.level = "debug"' }],
    ['Token 含回车', { frpToken: 'abc' + CR + 'localPort = 9999' }],
    ['服务端地址闭合引号', { frpServer: '1.2.3.4' + QUOTE + NL + '[[proxies]]' + NL + 'remotePort = 19998' + NL + 'y = ' + QUOTE }],
    ['服务端地址含制表符', { frpServer: '1.2.3.4' + TAB + '#' }],
    ['域名注入 nginx 指令', { frpDomain: 'a.com' + NL + 'location /evil { }' }],
    ['对外地址含换行', { relayPublicUrl: 'https://a.com' + NL + 'evil' }],
    ['对外地址含引号', { relayPublicUrl: 'https://a.com' + QUOTE + 'onerror' }]
  ];
  for (const [name, body] of injects) {
    const r = await req('PUT', '/api/settings', body);
    rec(`${name}被拒`, r.status === 400, `${r.status} ${r.data.msg || ''}`.slice(0, 80));
  }

  const okReq = await req('PUT', '/api/settings', {
    frpToken: 'token-abcdefghijklmnopqrstuvwxyz-123456',
    frpServer: 'frp.example.com',
    frpDomain: 'print.example.com',
    relayPublicUrl: 'https://print.example.com',
    frpMode: 'wss'
  });
  rec('合法 frp 参数可保存', okReq.status === 200, `${okReq.status}`.slice(0, 60));
  const preview = await frpPreview();
  const proxyCount = (preview.match(/\[\[proxies\]\]/g) || []).length;
  rec('配置含且只含一个 proxies 节点', proxyCount === 1, `实际 ${proxyCount} 个`);
  rec('配置无注入残留', !/injected|debug|localPort = 9999/.test(preview), '干净');

  console.log(NL + '== B. 令牌安全 ==');
  const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const noneTok = `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ role: 'admin', scope: 'admin', ep: 1 })}.`;
  let r = await req('GET', '/api/settings', undefined, { headers: { Authorization: `Bearer ${noneTok}` } });
  rec('alg=none 伪造被拒', r.status === 401, String(r.status));
  const parts = String(TOKEN).split('.');
  if (parts.length === 3) {
    const forged = `${b64({ role: 'admin', scope: 'admin', ep: 999 })}.${parts[2]}`;
    r = await req('GET', '/api/settings', undefined, { headers: { Authorization: `Bearer ${forged}` } });
    rec('篡改角色/纪元的令牌被拒', r.status === 401, String(r.status));
  }
  for (const [label, hv] of [['空令牌', 'Bearer '], ['垃圾令牌', 'Bearer aaa.bbb.ccc']]) {
    r = await req('GET', '/api/settings', undefined, { headers: { Authorization: hv } });
    rec(`${label}被拒`, r.status === 401, String(r.status));
  }
  r = await req('GET', '/api/settings', undefined, { anonymous: true });
  rec('无令牌被拒', r.status === 401, String(r.status));

  await require('./bug-hunt3-part2.js')({ req, rec, sleep, TOKEN, NL, CR, QUOTE, results, BASE });
})().catch((e) => { console.error('崩溃:', e && e.message, (e && e.stack || '').split(NL)[1] || ''); process.exit(1); });
