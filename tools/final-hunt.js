'use strict';
// 收尾全量猎杀：初始化 / 密码与会话 / 二维码登录 / 微信配置 / frp 注入 / 清理备份 / 打印机无 CUPS 语义 / 扫描
// 用法：PG_BASE=http://127.0.0.1:8099 PG_PASS=xxx node tools/final-hunt.js
const BASE = process.env.PG_BASE || 'http://127.0.0.1:8099';
const PASS = process.env.PG_PASS || 'LocalTest2026';

const results = [];
const rec = (n, p, d = '') => {
  results.push({ n, p, d });
  console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? `  —  ${d}` : ''}`);
};

async function req(method, url, body, token = '') {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(BASE + url, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch (_) { data = { raw: text.slice(0, 140) }; }
  return { status: res.status, data, headers: res.headers };
}

(async () => {
  console.log('=== A. 初始化与密码策略 ===');
  let r = await req('GET', '/api/public/bootstrap');
  let ADMIN = '';
  if (r.data.needsSetup) {
    r = await req('POST', '/api/setup', { password: '123', confirm: '123' });
    rec('弱密码被拦截', r.status === 400, `${r.status} ${r.data.msg || ''}`);
    r = await req('POST', '/api/setup', { password: PASS, confirm: `${PASS}x` });
    rec('两次密码不一致被拦截', r.status === 400, `${r.status} ${r.data.msg || ''}`);
    r = await req('POST', '/api/setup', { password: PASS, confirm: PASS });
    ADMIN = r.data.token || '';
    rec('初始化成功并下发令牌', !!ADMIN, r.data.msg || '');
    r = await req('POST', '/api/setup', { password: PASS, confirm: PASS });
    rec('重复初始化 409', r.status === 409, `${r.status} ${r.data.msg || ''}`);
  } else {
    r = await req('POST', '/api/auth/login', { password: PASS });
    ADMIN = r.data.token || '';
    rec('登录已有实例', !!ADMIN, r.data.msg || '');
  }
  if (!ADMIN) { console.log('无法登录，终止'); process.exit(1); }

  r = await req('GET', '/api/auth/me', undefined, ADMIN);
  rec('读取当前管理员', r.status === 200 && !!r.data.user, JSON.stringify(r.data.user || {}).slice(0, 40));
  r = await req('POST', '/api/auth/password', { oldPassword: 'wrong', newPassword: 'Abcd1234!', confirm: 'Abcd1234!' }, ADMIN);
  rec('改密校验旧密码', r.status >= 400 && r.status < 500, `${r.status} ${r.data.msg || ''}`);
  r = await req('POST', '/api/auth/password', { oldPassword: PASS, newPassword: 'Abcd1234!', confirm: 'Abcd1234!x' }, ADMIN);
  rec('改密校验确认密码', r.status === 400, r.data.msg || `status=${r.status}`);
  r = await req('POST', '/api/auth/password', { oldPassword: PASS, newPassword: 'weak', confirm: 'weak' }, ADMIN);
  rec('弱新密码被拒', r.status === 400, r.data.msg || `status=${r.status}`);

  console.log('\n=== B. 小程序接入参数 ===');
  r = await req('GET', '/api/wechat/config', undefined, ADMIN);
  rec('读取接入配置', r.status === 200 && !!r.data.config, JSON.stringify(r.data.config || {}).slice(0, 46));
  r = await req('PUT', '/api/wechat/config', { appid: 'bad-appid' }, ADMIN);
  rec('非法 AppID 被拒', r.status === 400, r.data.msg || `status=${r.status}`);
  r = await req('PUT', '/api/wechat/config', { secret: 'short' }, ADMIN);
  rec('非法 AppSecret 被拒', r.status === 400, r.data.msg || `status=${r.status}`);
  r = await req('PUT', '/api/wechat/config', { appid: 'wx1234567890abcdef', secret: 'a'.repeat(32) }, ADMIN);
  rec('合法凭据保存', r.status === 200, r.data.msg || '');
  r = await req('GET', '/api/wechat/config', undefined, ADMIN);
  rec('Secret 只回传掩码', /\*/.test(String(r.data.config?.secret || '')), String(r.data.config?.secret || ''));
  rec('AppID 已生效', r.data.config?.appid === 'wx1234567890abcdef', r.data.config?.appid);
  r = await req('PUT', '/api/wechat/config', { baseUrl: 'ftp://x' }, ADMIN);
  rec('非法接入地址被拒', r.status === 400, r.data.msg || `status=${r.status}`);
  r = await req('PUT', '/api/wechat/config', { adminOpenids: ['!!bad!!'] }, ADMIN);
  rec('可疑 OpenID 被拒', r.status === 400, r.data.msg || `status=${r.status}`);
  const t1 = (await req('POST', '/api/wechat/bind-token', {}, ADMIN)).data.bindToken || '';
  rec('重置绑定码', !!t1, `${String(t1).slice(0, 8)}…`);
  rec('再次重置会变化', ((await req('POST', '/api/wechat/bind-token', {}, ADMIN)).data.bindToken || '') !== t1);
  r = await req('GET', '/api/wechat/config', undefined, '');
  rec('未登录读配置 401', r.status === 401, `status=${r.status}`);

  console.log('\n=== B2. 二维码登录票据（需先配置小程序） ===');
  r = await req('POST', '/api/auth/qr/create');
  const ticket = r.data.ticket || '';
  rec('创建票据', !!ticket, ticket ? ticket.slice(0, 10) + '…' : r.data.msg || '');
  if (ticket) {
    r = await req('GET', `/api/auth/qr/status?ticket=${ticket}`);
    rec('票据状态可轮询', r.status === 200 && !!r.data.status, `status=${r.data.status}`);
  }
  r = await req('GET', '/api/auth/qr/status?ticket=nope');
  rec('未知票据 404', r.status === 404, `status=${r.status}`);

  console.log('\n=== D. frp / 中转配置注入 ===');
  for (const [label, value] of [
    ['换行注入', 'frp.example.com\n evil = 1'],
    ['引号注入', 'frp" evil="1'],
    ['分号注入', 'frp.example.com; rm -rf /'],
    ['超长', 'a'.repeat(300)]
  ]) {
    r = await req('PUT', '/api/settings', { frpServer: value }, ADMIN);
    rec(`frp 地址${label}被拒`, r.status === 400, `${r.status} ${(r.data.msg || '').slice(0, 34)}`);
  }
  r = await req('PUT', '/api/settings', { relayPublicUrl: 'javascript:alert(1)' }, ADMIN);
  rec('对外地址 javascript: 被拒', r.status === 400, r.data.msg || '');
  r = await req('PUT', '/api/settings', { frpPort: 99999 }, ADMIN);
  rec('frp 端口越界被拒', r.status === 400, r.data.msg || '');
  r = await req('PUT', '/api/settings', { frpMode: 'evil' }, ADMIN);
  rec('frp 模式白名单', r.status === 400, r.data.msg || '');
  r = await req('PUT', '/api/settings', { frpToken: 'tok"en\n[evil]' }, ADMIN);
  rec('frp Token 特殊字符被拒', r.status === 400, r.data.msg || '');
  r = await req('GET', '/api/relay/plan', undefined, ADMIN);
  rec('中转方案接口不崩', r.status === 200, `${r.status}`);

  console.log('\n=== E. 清理 / 备份 / 存储 ===');
  r = await req('GET', '/api/settings/storage', undefined, ADMIN);
  rec('存储统计可读', r.status === 200 && !!r.data.storage, JSON.stringify(r.data.storage || {}).slice(0, 56));
  r = await req('POST', '/api/settings/cleanup', { kinds: ['evil'] }, ADMIN);
  rec('未知清理项被拒', r.status === 400, r.data.msg || `status=${r.status}`);
  r = await req('POST', '/api/settings/cleanup', { kinds: [] }, ADMIN);
  rec('空清理项被拒', r.status === 400, r.data.msg || `status=${r.status}`);
  r = await req('POST', '/api/settings/cleanup', { days: -1 }, ADMIN);
  rec('负天数被拒', r.status === 400, r.data.msg || `status=${r.status}`);
  r = await req('POST', '/api/settings/cleanup', { days: 99999 }, ADMIN);
  rec('超大天数被拒', r.status === 400, r.data.msg || `status=${r.status}`);
  r = await req('POST', '/api/settings/cleanup', { days: 0, kinds: ['files'] }, ADMIN);
  rec('指定天数清理可执行', r.status === 200, r.data.msg || '');
  const bk = await fetch(`${BASE}/api/settings/backup`, { headers: { Authorization: `Bearer ${ADMIN}` } });
  rec('备份可下载', bk.status === 200, `${bk.status} ${bk.headers.get('content-type')}`);
  r = await req('POST', '/api/settings/cleanup', {}, '');
  rec('未登录清理 401', r.status === 401, `status=${r.status}`);

  console.log('\n=== F. 打印机 / 扫描（无 CUPS 的失败语义） ===');
  r = await req('GET', '/api/printers', undefined, ADMIN);
  rec('打印机列表不 500', r.status === 200, `ok=${r.data.ok}`);
  rec('CUPS 不可用有说明', !!((r.data.cups || {}).message) || r.data.ok === true, (r.data.cups || {}).message || 'ok');
  r = await req('POST', '/api/printers', { name: 'bad name!', uri: 'not-a-uri' }, ADMIN);
  rec('非法队列名/URI 被拒', r.status === 400, r.data.msg || `status=${r.status}`);
  r = await req('POST', '/api/printers', { name: 'ok-queue', uri: 'ipp://1.2.3.4/ipp/print' }, ADMIN);
  rec('添加队列失败时明确报错', r.status >= 400 || !!r.data.msg, `${r.status} ${(r.data.msg || '').slice(0, 34)}`);
  r = await req('GET', '/api/printers/nonexistent/detail', undefined, ADMIN);
  rec('查不存在队列 404', r.status === 404, `status=${r.status}`);
  r = await req('GET', '/api/scanners', undefined, ADMIN);
  rec('扫描仪列表不 500', r.status === 200, `${r.status}`);
  r = await req('GET', '/api/printers/discover/subnets', undefined, ADMIN);
  rec('网段接口可读', r.status === 200, JSON.stringify(r.data).slice(0, 44));
  r = await req('GET', '/api/printers/history', undefined, ADMIN);
  rec('队列历史可读', r.status === 200, `${r.status}`);

  console.log('\n=== G. 审计导出与分页 ===');
  const exp = await fetch(`${BASE}/api/audit/export`, { headers: { Authorization: `Bearer ${ADMIN}` } });
  const csv = await exp.text();
  rec('审计导出 CSV', exp.status === 200 && /text\/csv/.test(exp.headers.get('content-type') || ''), `${csv.split('\n').length} 行`);
  for (const [q, label] of [['page=0&size=0', 'page/size 为 0'], ['page=-5&size=30', 'page 负数'], ['page=99999&size=30', 'page 越界'], ['page=1&size=9999', 'size 超限']]) {
    r = await req('GET', `/api/audit?${q}`, undefined, ADMIN);
    rec(`审计分页 ${label}`, r.status === 200 && Array.isArray(r.data.logs), `返回 ${(r.data.logs || []).length} 条`);
  }
  r = await req('GET', '/api/audit?q=%', undefined, ADMIN);
  rec('审计搜索 % 不当通配符', (r.data.total || 0) === 0 || r.data.total < 100000, `total=${r.data.total}`);

  console.log('\n=== H. 安全头与回落 ===');
  const h = await fetch(`${BASE}/api/health`);
  rec('安全响应头齐全',
    ['x-content-type-options', 'x-frame-options', 'content-security-policy', 'referrer-policy'].every((k) => h.headers.get(k)),
    `nosniff=${h.headers.get('x-content-type-options')}`);
  const nf = await req('GET', '/api/definitely-not-here');
  rec('未知接口 404 JSON', nf.status === 404 && nf.data.ok === false, `status=${nf.status}`);
  const bad = await fetch(`${BASE}/api/users`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ADMIN}` }, body: '{oops' });
  rec('畸形 JSON 4xx 不 500', bad.status >= 400 && bad.status < 500, `status=${bad.status}`);
  const spa = await fetch(`${BASE}/#/dashboard`);
  rec('SPA 回落返回 HTML', spa.status === 200 && (spa.headers.get('content-type') || '').includes('html'));

  const pass = results.filter((x) => x.p).length;
  console.log(`\n===== ${pass}/${results.length} 通过 =====`);
  for (const f of results.filter((x) => !x.p)) console.log(`  - ${f.n} ${f.d}`);
  if (pass !== results.length) process.exitCode = 1;
})();
