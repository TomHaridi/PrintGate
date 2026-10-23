'use strict';
// 普通用户门户 / 角色分流 / 密码登录开关 回归
// 用法：BASE=http://127.0.0.1:8098 node tools/user-portal-test.js
const BASE = process.env.BASE || 'http://127.0.0.1:8098';
const PW = process.env.PW || 'LocalTest2026';
let pass = 0, fail = 0;
const rec = (n, ok, extra = '') => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'} | ${n}${extra ? ' | ' + extra : ''}`); };

const j = async (method, path, body, token, raw = false) => {
  const opt = { method, headers: {} };
  if (token) opt.headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) {
    if (body instanceof FormData) opt.body = body;
    else { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
  }
  const r = await fetch(BASE + path, opt);
  if (raw) return { status: r.status, buffer: Buffer.from(await r.arrayBuffer()) };
  let d = {}; try { d = await r.json(); } catch (_) {}
  return { status: r.status, d };
};

(async () => {
  let r = await j('POST', '/api/setup', { password: PW, confirm: PW });
  const ADMIN = r.d.token || (await j('POST', '/api/auth/login', { password: PW })).d.token;
  if (!ADMIN) { console.error('取不到管理员令牌'); process.exit(1); }

  // 前置：开扫码登录、关掉新用户审批（新用户直接 approved）、配好小程序凭据
  r = await j('PUT', '/api/settings', {
    enableQrLogin: true, enablePasswordLogin: true, approveNewUser: false,
    wxAppid: 'wx0123456789abcdef', wxSecret: 'abcdef0123456789abcdef0123456789'
  }, ADMIN);
  rec('前置设置保存成功', r.d.ok === true, r.d.msg || '');

  const newUser = async (openid, nickname) => (await j('POST', '/api/mp/dev-login', { openid, nickname })).d;

  // ---------- 1) 普通用户扫码登录 ----------
  let u = await newUser(`portal_user_${Date.now()}`, '普通用户甲');
  rec('普通用户登录即已授权', u.user.status === 'approved', `status=${u.user.status}`);
  const TOK = u.token;

  r = await j('POST', '/api/auth/qr/create', {});
  const ticket = r.d.ticket;
  rec('二维码票据创建成功', !!ticket, r.d.msg || '');

  r = await j('POST', '/api/mp/qr/scan', { ticket }, TOK);
  rec('普通用户可扫码（不再限管理员）', r.d.ok === true, r.d.msg || '');
  r = await j('POST', '/api/mp/qr/confirm', { ticket }, TOK);
  rec('普通用户可确认登录', r.d.ok === true, r.d.msg || '');

  r = await j('GET', `/api/auth/qr/status?ticket=${encodeURIComponent(ticket)}`);
  rec('网页换到用户会话', r.d.status === 'confirmed' && r.d.role === 'user' && !!r.d.token, `role=${r.d.role}`);
  const USER_WEB = r.d.token;

  r = await j('GET', '/api/auth/whoami', undefined, USER_WEB);
  rec('whoami 识别为普通用户', r.d.ok === true && r.d.role === 'user', `role=${r.d.role}`);

  // ---------- 2) 权限边界：只能打印 / 历史 ----------
  r = await j('GET', '/api/mp/me', undefined, USER_WEB);
  rec('门户可读自己的会话信息', r.d.ok === true, `nickname=${r.d.user && r.d.user.nickname}`);
  r = await j('GET', '/api/mp/printers', undefined, USER_WEB);
  rec('门户可读打印机列表', r.d.ok === true, `count=${(r.d.printers || []).length}`);
  r = await j('GET', '/api/mp/tasks', undefined, USER_WEB);
  rec('门户可读自己的打印记录', r.d.ok === true, `count=${(r.d.tasks || []).length}`);

  for (const [label, path] of [
    ['用户管理', '/api/users'], ['系统设置', '/api/settings'], ['审计日志', '/api/audit'],
    ['打印机管理', '/api/mp/admin/printers'], ['小程序后台概览', '/api/mp/admin/overview']
  ]) {
    r = await j('GET', path, undefined, USER_WEB);
    rec(`普通用户进不了「${label}」`, r.status === 401 || r.status === 403, `status=${r.status}`);
  }

  // ---------- 3) 上传 + 一键清空历史 ----------
  const fd = new FormData();
  fd.append('file', new Blob([Buffer.from('%PDF-1.4\n% test\n')], { type: 'application/pdf' }), 'portal-test.pdf');
  r = await j('POST', '/api/mp/files', fd, USER_WEB);
  const fileId = r.d.file && r.d.file.id;
  rec('门户可上传文件', !!fileId, r.d.msg || `id=${fileId}`);

  r = await j('DELETE', '/api/mp/history', undefined, USER_WEB);
  rec('一键清空历史可用', r.d.ok === true, r.d.msg || '');
  r = await j('GET', '/api/mp/files', undefined, USER_WEB);
  rec('清空后自己的文件列表为空', (r.d.files || []).length === 0, `left=${(r.d.files || []).length}`);

  // 别人的文件不能被清：再建一个用户上传后，用甲清空不应影响乙
  const u2 = await newUser(`portal_other_${Date.now()}`, '普通用户乙');
  const fd2 = new FormData();
  fd2.append('file', new Blob([Buffer.from('%PDF-1.4\n% b\n')], { type: 'application/pdf' }), 'other.pdf');
  const up2 = await j('POST', '/api/mp/files', fd2, u2.token);
  await j('DELETE', '/api/mp/history', undefined, USER_WEB);
  r = await j('GET', '/api/mp/files', undefined, u2.token);
  rec('清空只影响自己（不误删他人文件）', (r.d.files || []).length === 1, `other left=${(r.d.files || []).length}`);

  // ---------- 4) 未授权 / 被拉黑不能扫码 ----------
  const pend = await j('POST', '/api/mp/dev-login', { openid: `pend_${Date.now()}`, nickname: '待审' });
  // 造一个待审用户：先开审批再建号
  await j('PUT', '/api/settings', { approveNewUser: true }, ADMIN);
  const pend2 = await j('POST', '/api/mp/dev-login', { openid: `pend2_${Date.now()}`, nickname: '待审乙' });
  r = await j('POST', '/api/auth/qr/create', {});
  const t2 = r.d.ticket;
  r = await j('POST', '/api/mp/qr/scan', { ticket: t2 }, pend2.d.token);
  rec('待审批用户不能扫码登录', r.status === 403, r.d.msg || '');
  await j('PUT', '/api/settings', { approveNewUser: false }, ADMIN);

  // 拉黑后会话立即失效
  const victim = await newUser(`block_${Date.now()}`, '要被拉黑');
  const allUsers = await j('GET', '/api/users?size=200', undefined, ADMIN);
  const list = (allUsers.d.users || allUsers.d.rows || []);
  const target = list.find((x) => x.openid === victim.user.openid) || {};
  if (target.id) {
    r = await j('POST', `/api/users/${target.id}/block`, {}, ADMIN);
    rec('管理员一键拉黑生效', r.d.ok === true, r.d.msg || '');
    r = await j('GET', '/api/auth/whoami', undefined, victim.token);
    rec('被拉黑用户会话立即失效', r.status === 403, `status=${r.status}`);
    r = await j('POST', '/api/mp/qr/scan', { ticket: (await j('POST', '/api/auth/qr/create', {})).d.ticket }, victim.token);
    rec('被拉黑用户不能扫码', r.status === 403 || r.status === 401, `status=${r.status}`);
    await j('POST', `/api/users/${target.id}/unblock`, {}, ADMIN);
  } else {
    rec('管理员一键拉黑生效', false, '未能定位测试用户');
  }

  // ---------- 5) 管理员扫码仍是管理会话 ----------
  const adminOpenid = `admin_qr_${Date.now()}`;
  await j('PUT', '/api/settings', { adminOpenids: adminOpenid }, ADMIN);
  const mA = (await j('POST', '/api/mp/dev-login', { openid: adminOpenid, nickname: '管理微信' })).d.token;
  const tk = (await j('POST', '/api/auth/qr/create', {})).d.ticket;
  await j('POST', '/api/mp/qr/scan', { ticket: tk }, mA);
  await j('POST', '/api/mp/qr/confirm', { ticket: tk }, mA);
  r = await j('GET', `/api/auth/qr/status?ticket=${encodeURIComponent(tk)}`);
  rec('管理员扫码拿到管理会话', r.d.role === 'admin' && !!r.d.token, `role=${r.d.role}`);
  r = await j('GET', '/api/users?size=5', undefined, r.d.token);
  rec('管理会话可进管理接口', r.status === 200 && r.d.ok === true, `status=${r.status}`);

  // ---------- 6) 密码登录开关 ----------
  r = await j('PUT', '/api/settings', { enablePasswordLogin: false }, ADMIN);
  rec('可关闭密码登录', r.d.ok === true && r.d.settings?.security?.enablePasswordLogin === false);
  r = await j('POST', '/api/auth/login', { password: PW });
  rec('关闭后密码登录被拒', r.status === 403 && r.d.code === 'PASSWORD_LOGIN_DISABLED', r.d.msg || '');
  r = await j('GET', '/api/public/bootstrap');
  rec('引导信息同步密码登录状态', r.d.passwordLoginEnabled === false);
  r = await j('PUT', '/api/settings', { enableQrLogin: false }, ADMIN);
  rec('两个登录方式不能同时关闭', r.status === 400, r.d.msg || '');
  r = await j('PUT', '/api/settings', { enablePasswordLogin: true, enableQrLogin: true }, ADMIN);
  rec('可恢复两种登录', r.d.ok === true && r.d.settings?.security?.enablePasswordLogin === true);

  // ---------- 7) 隐藏详细打印设置 ----------
  r = await j('PUT', '/api/settings', { hideUserAdvanced: true }, ADMIN);
  rec('可开启「隐藏普通用户详细设置」', r.d.ok === true && r.d.settings?.security?.hideUserAdvanced === true);
  r = await j('GET', '/api/mp/me', undefined, USER_WEB);
  rec('门户收到 advancedPrint=false', r.d.config?.advancedPrint === false, `advancedPrint=${r.d.config?.advancedPrint}`);
  await j('PUT', '/api/settings', { hideUserAdvanced: false, adminOpenids: '' }, ADMIN);
  r = await j('GET', '/api/mp/me', undefined, USER_WEB);
  rec('关掉后恢复详细设置', r.d.config?.advancedPrint === true);

  console.log(`\n合计 ${pass} 通过 / ${fail} 失败`);
  // 复原全局设置：本套件为造「已授权用户」会临时关审批，不还原会污染后续套件
  await j('PUT', '/api/settings', {
    approveNewUser: true, hideUserAdvanced: false,
    enablePasswordLogin: true, enableQrLogin: true, adminOpenids: ''
  }, ADMIN).catch(() => {});

  process.exit(fail ? 1 : 0);
})();
