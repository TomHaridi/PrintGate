'use strict';
// 会话 / 令牌 / 锁定 专项：改密后旧令牌是否失效、伪造与过期令牌、越权、锁定与恢复
// 锁定用例会真的锁住一段时间，放在最后跑，并在结束时清空失败记录
// 用法：PG_BASE=http://127.0.0.1:8099 PG_PASS=xxx node tools/session-hunt.js
const BASE = process.env.PG_BASE || 'http://127.0.0.1:8099';
const PASS = process.env.PG_PASS || 'LocalTest2026';

const results = [];
const rec = (n, p, d = '') => {
  results.push({ n, p, d });
  console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? `  —  ${d}` : ''}`);
};

async function req(method, url, body, token = '', extra = {}) {
  const headers = { ...extra };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(BASE + url, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch (_) { data = { raw: text.slice(0, 140) }; }
  return { status: res.status, data };
}

(async () => {
  let r = await req('GET', '/api/public/bootstrap');
  let ADMIN = '';
  if (r.data.needsSetup) ADMIN = (await req('POST', '/api/setup', { password: PASS, confirm: PASS })).data.token;
  else ADMIN = (await req('POST', '/api/auth/login', { password: PASS })).data.token;
  if (!ADMIN) { console.log('无法登录'); process.exit(1); }
  await req('DELETE', '/api/security/attempts', undefined, ADMIN); // 从干净状态开始

  console.log('=== A. 令牌可用性与越权 ===');
  r = await req('GET', '/api/auth/me', undefined, ADMIN);
  rec('有效令牌可用', r.status === 200, JSON.stringify(r.data.user || {}).slice(0, 40));

  const junk = [
    ['空令牌', ''],
    ['随机字符串', 'abc.def.ghi'],
    ['篡改签名', ADMIN.slice(0, -3) + 'xxx'],
    ['去掉 Bearer 前缀内容', 'Bearer'],
    ['超长令牌', 'x'.repeat(4000)]
  ];
  for (const [label, tok] of junk) {
    r = await req('GET', '/api/users', undefined, tok);
    rec(`${label}被拒`, r.status === 401, `status=${r.status}`);
  }

  // 小程序令牌不能访问管理端接口（反之亦然）
  let USER = '';
  for (let i = 0; i < 5; i++) {
    const d = await req('POST', '/api/mp/dev-login', { openid: `sess_${Date.now().toString(36)}${i}` });
    if (d.data && d.data.token) { USER = d.data.token; break; }
    await new Promise((s) => setTimeout(s, 2500));
  }
  if (USER) {
    r = await req('GET', '/api/users', undefined, USER);
    rec('小程序令牌不能看用户列表', r.status === 401, `status=${r.status}`);
    r = await req('GET', '/api/settings', undefined, USER);
    rec('小程序令牌不能读设置', r.status === 401, `status=${r.status}`);
    r = await req('GET', '/api/mp/me', undefined, ADMIN);
    rec('后台令牌不能当小程序身份', r.status === 401, `status=${r.status}`);
  }

  console.log('\n=== B. 改密后会话失效（authEpoch） ===');
  const before = ADMIN;
  r = await req('POST', '/api/auth/password', { oldPassword: PASS, newPassword: 'NewPass2026!', confirm: 'NewPass2026!' }, ADMIN);
  rec('改密成功', r.status === 200, `${r.status} ${r.data.msg || ''}`);
  r = await req('GET', '/api/users', undefined, before);
  rec('旧令牌立即失效', r.status === 401, `status=${r.status}`);
  const reLogin = await req('POST', '/api/auth/login', { password: 'NewPass2026!' });
  rec('新密码可登录', !!reLogin.data.token, `${reLogin.status}`);
  const NEW = reLogin.data.token || '';
  r = await req('GET', '/api/users', undefined, NEW);
  rec('新令牌可用', r.status === 200, `status=${r.status}`);
  // 改回原密码，方便后续回归脚本继续跑
  await req('POST', '/api/auth/password', { oldPassword: 'NewPass2026!', newPassword: PASS, confirm: PASS }, NEW);
  const back = await req('POST', '/api/auth/login', { password: PASS });
  rec('密码已改回（不影响后续用例）', !!back.data.token);
  const ADMIN2 = back.data.token || '';

  console.log('\n=== C. 会话有效期参数 ===');
  r = await req('PUT', '/api/settings', { sessionHours: 0 }, ADMIN2);
  rec('登录有效期 0 小时被拒', r.status === 400, r.data.msg || `status=${r.status}`);
  r = await req('PUT', '/api/settings', { sessionHours: 99999 }, ADMIN2);
  rec('登录有效期过大被拒', r.status === 400, r.data.msg || '');
  r = await req('PUT', '/api/settings', { sessionHours: 24 }, ADMIN2);
  rec('合法有效期可保存', r.status === 200, r.data.msg || '');

  console.log('\n=== D. 登录锁定与恢复（放在最后） ===');
  const st = await req('GET', '/api/settings', undefined, ADMIN2);
  const maxFail = st.data.settings?.security?.loginMaxFail || 5;
  let locked = false;
  for (let i = 0; i < maxFail + 1; i++) {
    const x = await req('POST', '/api/auth/login', { password: `wrong-${i}` });
    if (x.status === 403 && /锁定/.test(x.data.msg || '')) { locked = true; break; }
  }
  rec('连续输错触发锁定', locked, `上限 ${maxFail} 次`);
  if (locked) {
    const ok = await req('POST', '/api/auth/login', { password: PASS });
    rec('锁定期间正确密码也被拒', ok.status === 403 || ok.status === 429, `${ok.status} ${(ok.data.msg || '').slice(0, 30)}`);
    r = await req('GET', '/api/security/attempts', undefined, ADMIN2);
    rec('可查到失败记录', r.status === 200, `${(r.data.attempts || []).length} 条`);
    r = await req('DELETE', '/api/security/attempts', undefined, ADMIN2);
    rec('清空失败记录', r.status === 200, r.data.msg || '');
    const again = await req('POST', '/api/auth/login', { password: PASS });
    rec('清空后可正常登录', !!again.data.token, `${again.status}`);
  }
  r = await req('GET', '/api/security/attempts', undefined, '');
  rec('登录记录需鉴权', r.status === 401, `status=${r.status}`);

  const pass = results.filter((x) => x.p).length;
  console.log(`\n===== ${pass}/${results.length} 通过 =====`);
  for (const f of results.filter((x) => !x.p)) console.log(`  - ${f.n} ${f.d}`);
  if (pass !== results.length) process.exitCode = 1;
})();
