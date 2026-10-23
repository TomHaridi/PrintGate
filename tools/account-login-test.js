'use strict';
// 普通用户「账号 + 密码」注册/登录 回归
// 用法：BASE=http://127.0.0.1:8124 node tools/account-login-test.js
const BASE = process.env.BASE || 'http://127.0.0.1:8124';
const PW = process.env.PW || 'LocalTest2026';
let pass = 0, fail = 0;
const rec = (n, ok, d = '') => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'} | ${n}${d ? ' | ' + d : ''}`); };

const j = async (method, path, body, token) => {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const r = await fetch(BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  let d = {}; try { d = await r.json(); } catch (_) {}
  return { status: r.status, d };
};

(async () => {
  let r = await j('POST', '/api/setup', { password: PW, confirm: PW });
  const ADMIN = r.d.token || (await j('POST', '/api/auth/login', { password: PW })).d.token;
  if (!ADMIN) { console.error('取不到管理员令牌'); process.exit(1); }

  const stamp = Date.now().toString(36);
  const uname = `user_${stamp}`;
  const pwd = 'Passw0rd123';

  // 前置：开注册、关审批（注册即用）；配好小程序凭据供扫码用例
  await j('PUT', '/api/settings', {
    enableUserRegister: true, approveNewUser: false,
    wxAppid: 'wx0123456789abcdef', wxSecret: 'abcdef0123456789abcdef0123456789'
  }, ADMIN);

  // ---------- 1) 注册 ----------
  r = await j('POST', '/api/auth/account/register', { username: uname, password: pwd, confirm: pwd, nickname: '张会计' });
  rec('账号注册成功', r.d.ok === true && !!r.d.token, r.d.msg || '');
  const uid = r.d.user && r.d.user.id;
  rec('返回用户带 username', r.d.user && r.d.user.username === uname, `username=${r.d.user && r.d.user.username}`);
  rec('关闭审批时直接 approved', r.d.user && r.d.user.status === 'approved', `status=${r.d.user && r.d.user.status}`);

  r = await j('POST', '/api/auth/account/register', { username: uname, password: pwd, confirm: pwd });
  rec('重复用户名被拒 409', r.status === 409, r.d.msg || '');

  r = await j('POST', '/api/auth/account/register', { username: 'ab', password: pwd, confirm: pwd });
  rec('用户名过短被拒 400', r.status === 400, r.d.msg || '');

  r = await j('POST', '/api/auth/account/register', { username: `x_${stamp}`, password: '12345678', confirm: '12345678' });
  rec('纯数字密码被拒 400', r.status === 400, r.d.msg || '');

  r = await j('POST', '/api/auth/account/register', { username: `y_${stamp}`, password: pwd, confirm: 'other1234' });
  rec('两次密码不一致被拒 400', r.status === 400, r.d.msg || '');

  // ---------- 2) 登录 ----------
  r = await j('POST', '/api/auth/account/login', { username: uname.toUpperCase(), password: pwd });
  rec('用户名大小写不敏感、可登录', r.d.ok === true && !!r.d.token, r.d.msg || '');
  const TOK = r.d.token;

  r = await j('POST', '/api/auth/account/login', { username: uname, password: 'wrong-pass1' });
  rec('密码错误被拒 403', r.status === 403, r.d.msg || '');

  r = await j('POST', '/api/auth/account/login', { username: `ghost_${stamp}`, password: pwd });
  rec('不存在的用户同样返回 403（不泄露用户名）', r.status === 403, r.d.msg || '');

  // ---------- 3) 账号会话能用门户、进不了管理接口 ----------
  r = await j('GET', '/api/auth/whoami', undefined, TOK);
  rec('whoami 识别为普通用户', r.d.role === 'user', `role=${r.d.role}`);
  r = await j('GET', '/api/mp/me', undefined, TOK);
  rec('门户可读自己的信息', r.d.ok === true && r.d.user.username === uname, `username=${r.d.user && r.d.user.username}`);
  r = await j('GET', '/api/users', undefined, TOK);
  rec('账号用户进不了用户管理', r.status === 401 || r.status === 403, `status=${r.status}`);

  // ---------- 4) 待审批语义 ----------
  await j('PUT', '/api/settings', { approveNewUser: true }, ADMIN);
  const uname2 = `pend_${stamp}`;
  r = await j('POST', '/api/auth/account/register', { username: uname2, password: pwd, confirm: pwd });
  rec('开启审批后注册为 pending', r.d.user && r.d.user.status === 'pending' && r.d.needApproval === true, `status=${r.d.user && r.d.user.status}`);
  const pendTok = r.d.token;
  const t = (await j('POST', '/api/auth/qr/create', {})).d.ticket;
  r = await j('POST', '/api/mp/qr/scan', { ticket: t }, pendTok);
  rec('待审批账号不能扫码登录网页', r.status === 403, r.d.msg || '');

  // ---------- 5) 管理员添加账号用户 ----------
  const uname3 = `adm_${stamp}`;
  r = await j('POST', '/api/users', { mode: 'account', username: uname3, password: pwd, nickname: '手工账号', role: 'user', status: 'approved' }, ADMIN);
  rec('后台可用账号方式添加用户', r.d.ok === true && r.d.user.username === uname3, r.d.msg || '');
  r = await j('POST', '/api/auth/account/login', { username: uname3, password: pwd });
  rec('后台添加的账号可直接登录', r.d.ok === true, r.d.msg || '');
  r = await j('POST', '/api/users', { mode: 'account', username: uname3, password: pwd }, ADMIN);
  rec('重复账号被拒 409', r.status === 409, r.d.msg || '');

  // ---------- 6) 改密码 ----------
  const tok3 = (await j('POST', '/api/auth/account/login', { username: uname3, password: pwd })).d.token;
  r = await j('POST', '/api/auth/account/password', { oldPassword: 'bad-pass1', newPassword: 'NewPassw0rd', confirm: 'NewPassw0rd' }, tok3);
  rec('旧密码错误时改密被拒', r.status === 403, r.d.msg || '');
  r = await j('POST', '/api/auth/account/password', { oldPassword: pwd, newPassword: 'NewPassw0rd', confirm: 'NewPassw0rd' }, tok3);
  rec('账号自助改密成功', r.d.ok === true, r.d.msg || '');
  r = await j('POST', '/api/auth/account/login', { username: uname3, password: 'NewPassw0rd' });
  rec('新密码可登录', r.d.ok === true);

  // ---------- 7) 被拉黑后立即失效 ----------
  const list = (await j('GET', '/api/users?size=200', undefined, ADMIN)).d.users || [];
  const target = list.find((u) => u.username === uname3);
  if (target) {
    await j('POST', `/api/users/${target.id}/block`, {}, ADMIN);
    r = await j('POST', '/api/auth/account/login', { username: uname3, password: 'NewPassw0rd' });
    rec('被拉黑的账号不能登录', r.status === 403 && r.d.code === 'BLOCKED', r.d.msg || '');
    r = await j('GET', '/api/auth/whoami', undefined, tok3);
    rec('被拉黑后旧会话立即 403', r.status === 403, `status=${r.status}`);
    await j('POST', `/api/users/${target.id}/unblock`, {}, ADMIN);
  } else {
    rec('被拉黑的账号不能登录', false, '未找到测试账号');
  }

  // ---------- 8) 关闭注册 ----------
  await j('PUT', '/api/settings', { enableUserRegister: false }, ADMIN);
  r = await j('POST', '/api/auth/account/register', { username: `closed_${stamp}`, password: pwd, confirm: pwd });
  rec('关闭注册后不能新注册', r.status === 403 && r.d.code === 'REGISTER_CLOSED', r.d.msg || '');
  r = await j('POST', '/api/auth/account/login', { username: uname, password: pwd });
  rec('关闭注册后老账号仍能登录', r.d.ok === true);
  r = await j('GET', '/api/auth/account/policy');
  rec('policy 接口同步注册开关', r.d.registerEnabled === false);

  // 复原
  await j('PUT', '/api/settings', { enableUserRegister: true, approveNewUser: true, adminOpenids: '' }, ADMIN);

  console.log(`\n合计 ${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})();
