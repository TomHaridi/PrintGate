'use strict';
// 普通用户注册开关 + 后台添加/删除用户 回归
// 用法：BASE=http://127.0.0.1:8122 node tools/user-admin-test.js
const BASE = process.env.BASE || 'http://127.0.0.1:8122';
const PW = process.env.PW || 'LocalTest2026';
let pass = 0, fail = 0;
const rec = (n, ok, d = '') => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'} | ${n}${d ? ' | ' + d : ''}`); };

const j = async (method, path, body, token) => {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const r = await fetch(BASE + path, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body)
  });
  let d = {}; try { d = await r.json(); } catch (_) {}
  return { status: r.status, d };
};

(async () => {
  let r = await j('POST', '/api/setup', { password: PW, confirm: PW });
  const ADMIN = r.d.token || (await j('POST', '/api/auth/login', { password: PW })).d.token;
  if (!ADMIN) { console.error('取不到管理员令牌'); process.exit(1); }

  // 扫码用例需要二维码票据，而 /auth/qr/create 要求已配置小程序凭据
  await j('PUT', '/api/settings', {
    wxAppid: 'wx0123456789abcdef', wxSecret: 'abcdef0123456789abcdef0123456789'
  }, ADMIN);

  const stamp = Date.now().toString(36);
  const mk = (n) => `o${stamp}_${n}abcdefghij`;

  // ---------- 1) 注册开关：默认开启 ----------
  r = await j('GET', '/api/public/bootstrap');
  rec('默认允许自助注册', r.d.userRegisterEnabled === true, `userRegisterEnabled=${r.d.userRegisterEnabled}`);
  r = await j('GET', '/api/auth/user-entry');
  rec('注册入口默认 enabled', r.d.enabled === true, `enabled=${r.d.enabled}`);

  // 已有用户（先建一个，用于验证关闭后仍可登录）
  const oldOpenid = mk('old');
  const oldUser = await j('POST', '/api/mp/dev-login', { openid: oldOpenid, nickname: '老用户' });
  rec('开启状态下可建号', oldUser.d.ok === true, `id=${oldUser.d.user && oldUser.d.user.id}`);

  // ---------- 2) 关闭注册 ----------
  r = await j('PUT', '/api/settings', { enableUserRegister: false }, ADMIN);
  rec('可关闭自助注册', r.d.ok === true && r.d.settings.security.enableUserRegister === false);

  r = await j('GET', '/api/public/bootstrap');
  rec('bootstrap 同步关闭状态', r.d.userRegisterEnabled === false);

  r = await j('GET', '/api/auth/user-entry');
  rec('注册入口不再发码', r.d.enabled === false && !r.d.qr && /已关闭自助注册/.test(r.d.hint), r.d.hint);

  const newOpenid = mk('new');
  r = await j('POST', '/api/mp/dev-login', { openid: newOpenid, nickname: '新用户' });
  rec('关闭后新微信不能建号', r.status === 403 && r.d.code === 'REGISTER_CLOSED', r.d.msg || '');

  const again = await j('POST', '/api/mp/dev-login', { openid: oldOpenid });
  rec('关闭后老用户仍可登录', again.d.ok === true && again.d.user.id === oldUser.d.user.id, `id=${again.d.user && again.d.user.id}`);

  // 白名单管理员例外：否则关闭注册 + 没绑过管理员 = 谁都进不来
  const wl = mk('wl');
  r = await j('PUT', '/api/settings', { adminOpenids: wl }, ADMIN);
  r = await j('POST', '/api/mp/dev-login', { openid: wl, nickname: '白名单管理员' });
  rec('白名单管理员不注册也能进', r.d.ok === true && r.d.user.role === 'admin', `role=${r.d.user && r.d.user.role}`);
  await j('PUT', '/api/settings', { adminOpenids: '' }, ADMIN);

  // ---------- 3) 后台添加用户 ----------
  r = await j('POST', '/api/users', { nickname: '无 openid' }, ADMIN);
  rec('缺 OpenID 被拒 400', r.status === 400, r.d.msg || '');

  r = await j('POST', '/api/users', { openid: 'bad id!', nickname: 'x' }, ADMIN);
  rec('非法 OpenID 被拒 400', r.status === 400, r.d.msg || '');

  const manualOpenid = mk('manual');
  r = await j('POST', '/api/users', {
    openid: manualOpenid, nickname: '手工添加-张会计', real_name: '张会计', phone: '13800000000',
    role: 'user', status: 'approved', note: '三楼财务'
  }, ADMIN);
  const manual = r.d.user || {};
  rec('添加普通用户成功', r.d.ok === true && manual.role === 'user' && manual.status === 'approved', r.d.msg || '');

  r = await j('POST', '/api/users', { openid: manualOpenid, nickname: '重复' }, ADMIN);
  rec('重复 OpenID 被拒 409', r.status === 409, r.d.msg || '');

  // 关闭注册期间，管理员添加的用户可以正常登录（这是唯一开号路径）
  r = await j('POST', '/api/mp/dev-login', { openid: manualOpenid });
  rec('手工添加的用户在关闭注册时也能登录', r.d.ok === true && r.d.user.id === manual.id && r.d.user.status === 'approved', `id=${r.d.user && r.d.user.id}`);
  rec('登录不会重复建号（仍是同一条记录）', r.d.user.id === manual.id);

  // 添加管理员角色
  const adminOpenid2 = mk('madmin');
  r = await j('POST', '/api/users', { openid: adminOpenid2, nickname: '手工管理员', role: 'admin', status: 'approved' }, ADMIN);
  rec('添加管理员成功', r.d.ok === true && r.d.user.role === 'admin', r.d.msg || '');

  // 添加待审批用户 → 不能扫码
  const pendOpenid = mk('pend');
  r = await j('POST', '/api/users', { openid: pendOpenid, nickname: '待审批', status: 'pending' }, ADMIN);
  const pend = r.d.user || {};
  rec('添加待审批用户成功', r.d.ok === true && pend.status === 'pending');
  const pTok = (await j('POST', '/api/mp/dev-login', { openid: pendOpenid })).d.token;
  const t = (await j('POST', '/api/auth/qr/create', {})).d.ticket;
  r = await j('POST', '/api/mp/qr/scan', { ticket: t }, pTok);
  rec('待审批用户不能扫码登录', r.status === 403, r.d.msg || '');

  // ---------- 4) 删除用户 ----------
  r = await j('DELETE', `/api/users/${pend.id}`, undefined, ADMIN);
  rec('删除用户成功', r.d.ok === true, r.d.msg || '');
  const list = (await j('GET', '/api/users?size=200', undefined, ADMIN)).d.users || [];
  rec('删除后列表不再出现', !list.some((u) => u.id === pend.id));

  // 最后一个管理员不能被删/降级：先只留一个管理员，制造「只剩一个」的局面
  const activeAdmins = list.filter((u) => u.role === 'admin' && u.status === 'approved');
  for (const a of activeAdmins.slice(1)) {
    const rr = await j('POST', `/api/users/${a.id}/demote`, {}, ADMIN);
    if (rr.status !== 200) console.log('  （降级未成功：', rr.d.msg, '）');
  }
  if (activeAdmins.length > 1) {
    const last = (await j('GET', '/api/users?size=200', undefined, ADMIN)).d.users
      .filter((u) => u.role === 'admin' && u.status === 'approved');
    if (last.length === 1) {
      const rr = await j('POST', `/api/users/${last[0].id}/demote`, {}, ADMIN);
      rec('最后一个管理员不可降级', rr.status === 400, rr.d.msg || '');
      const rr2 = await j('POST', `/api/users/${last[0].id}/block`, {}, ADMIN);
      rec('最后一个管理员不可拉黑', rr2.status === 400, rr2.d.msg || '');
    }
  }
  const after = (await j('GET', '/api/users?size=200', undefined, ADMIN)).d.users || [];
  const admins = after.filter((u) => u.role === 'admin' && u.status === 'approved');
  if (admins.length === 1) {
    r = await j('DELETE', `/api/users/${admins[0].id}`, undefined, ADMIN);
    rec('最后一个管理员不可删除', r.status === 400, r.d.msg || '');
  } else {
    console.log('SKIP | 最后一个管理员保护（当前有', admins.length, '个管理员）');
  }

  // ---------- 5) 重新开启注册 ----------
  r = await j('PUT', '/api/settings', { enableUserRegister: true }, ADMIN);
  rec('可重新开启自助注册', r.d.ok === true && r.d.settings.security.enableUserRegister === true);
  r = await j('POST', '/api/mp/dev-login', { openid: mk('back') });
  rec('开启后新微信又能建号', r.d.ok === true);

  console.log(`\n合计 ${pass} 通过 / ${fail} 失败`);
  // 复原：注册开关、审批开关与白名单都还原，避免影响后续套件
  await j('PUT', '/api/settings', {
    enableUserRegister: true, approveNewUser: true, adminOpenids: ''
  }, ADMIN).catch(() => {});

  process.exit(fail ? 1 : 0);
})();
