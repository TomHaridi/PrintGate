'use strict';
// 密码与令牌失效回归：改密/重置后旧会话必须立即失效
// 用法：BASE=http://127.0.0.1:8153 PW=LocalTest2026 node tools/password-test.js
const BASE = process.env.BASE || 'http://127.0.0.1:8153';
const PW = process.env.PW || 'LocalTest2026';
let pass = 0, fail = 0;
const bugs = [];
const rec = (n, ok, d = '') => { ok ? pass++ : (fail++, bugs.push(n + (d ? ' — ' + d : ''))); console.log(`${ok ? 'PASS' : 'FAIL'} | ${n}${d ? ' | ' + d : ''}`); };

const j = async (m, p, b, t) => {
  const h = {};
  if (t) h.Authorization = 'Bearer ' + t;
  if (b !== undefined) h['Content-Type'] = 'application/json';
  const r = await fetch(BASE + p, { method: m, headers: h, body: b === undefined ? undefined : JSON.stringify(b) });
  let d = {};
  try { d = await r.json(); } catch (_) {}
  return { s: r.status, d };
};

(async () => {
  const ADM = (await j('POST', '/api/auth/login', { password: PW })).d.token;
  rec('管理员登录', !!ADM);

  const st = Date.now().toString(36);
  const uname = 'pw_' + st;
  const reg = await j('POST', '/api/auth/account/register', { username: uname, password: 'Passw0rd123', confirm: 'Passw0rd123', nickname: '密码测试' });
  const tok = reg.d.token, uid = reg.d.user.id;
  rec('注册并拿到令牌', !!tok);
  await j('POST', `/api/users/${uid}/approve`, {}, ADM);

  rec('改密前旧令牌可用', (await j('GET', '/api/mp/me', undefined, tok)).s === 200);

  // 旧密码错 → 403
  let r = await j('POST', '/api/auth/account/password', { oldPassword: 'WrongPass1', newPassword: 'NewPass456' }, tok);
  rec('旧密码不正确被拒', r.s === 403, `status=${r.s}`);
  // 弱密码 → 400
  r = await j('POST', '/api/auth/account/password', { oldPassword: 'Passw0rd123', newPassword: 'short' }, tok);
  rec('弱密码被拒', r.s === 400, `status=${r.s} ${r.d.msg || ''}`);

  // 正常改密
  r = await j('POST', '/api/auth/account/password', { oldPassword: 'Passw0rd123', newPassword: 'NewPass456' }, tok);
  rec('改密成功', r.s === 200, r.d.msg || '');
  rec('改密返回新令牌', !!r.d.token);
  const tok2 = r.d.token;

  rec('改密后旧令牌立即失效', (await j('GET', '/api/mp/me', undefined, tok)).s === 401);
  r = await j('GET', '/api/mp/me', undefined, tok);
  rec('失效原因标记 TOKEN_STALE', r.d.code === 'TOKEN_STALE', `code=${r.d.code || '-'}`);
  rec('新令牌可用', (await j('GET', '/api/mp/me', undefined, tok2)).s === 200);

  // 旧密码不能登录，新密码可以
  rec('旧密码登录失败', (await j('POST', '/api/auth/account/login', { username: uname, password: 'Passw0rd123' })).s !== 200);
  rec('新密码登录成功', (await j('POST', '/api/auth/account/login', { username: uname, password: 'NewPass456' })).s === 200);

  // 管理员重置
  r = await j('POST', `/api/users/${uid}/reset-password`, {}, ADM);
  rec('管理员重置密码', r.s === 200 && !!r.d.password, `生成 ${r.d.password ? '成功' : '失败'}`);
  const gen = r.d.password;
  rec('重置后上一条令牌失效', (await j('GET', '/api/mp/me', undefined, tok2)).s === 401);
  rec('重置生成的密码可登录', (await j('POST', '/api/auth/account/login', { username: uname, password: gen })).s === 200);

  // 指定密码重置
  r = await j('POST', `/api/users/${uid}/reset-password`, { password: 'Manual12345' }, ADM);
  rec('指定密码重置', r.s === 200 && r.d.generated === false, `status=${r.s}`);
  rec('指定密码可登录', (await j('POST', '/api/auth/account/login', { username: uname, password: 'Manual12345' })).s === 200);

  // 管理员账号不可被重置
  const adm = await j('POST', '/api/auth/account/register', { username: 'adm_' + st, password: 'Passw0rd123', confirm: 'Passw0rd123' });
  await j('POST', `/api/users/${adm.d.user.id}/promote`, {}, ADM);
  r = await j('POST', `/api/users/${adm.d.user.id}/reset-password`, {}, ADM);
  rec('管理员账号不可重置', r.s === 400, `status=${r.s} ${r.d.msg || ''}`);

  // 普通用户不能调重置接口
  r = await j('POST', `/api/users/${uid}/reset-password`, {}, tok2);
  rec('普通用户不能重置他人密码', r.s === 401 || r.s === 403, `status=${r.s}`);

  console.log(`\n合计 ${pass} 通过 / ${fail} 失败`);
  if (fail) console.log('失败项:\n - ' + bugs.join('\n - '));
  process.exit(fail ? 1 : 0);
})();
