'use strict';
// 小程序 ↔ 后端 契约测试：把小程序里每一个接口调用真打一遍后端，404 就是「对不上」
// 用法：BASE=http://127.0.0.1:8133 PW=LocalTest2026 node tools/mp-contract-test.js
const BASE = process.env.BASE || 'http://127.0.0.1:8133';
const PW = process.env.PW || 'LocalTest2026';
let pass = 0, fail = 0;
const rec = (name, ok, detail = '') => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'} | ${name}${detail ? ' | ' + detail : ''}`); };

async function req(method, path, body, token, isForm) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  let payload;
  if (isForm) payload = body;
  else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const r = await fetch(BASE + path, { method, headers, body: payload });
  const raw = await r.clone().text();
  let d = {};
  try { d = JSON.parse(raw); } catch (_) {}
  return { status: r.status, d, missing: r.status === 404 && /接口不存在/.test(raw) };
}

(async () => {
  let r = await req('POST', '/api/setup', { password: PW, confirm: PW });
  const ADMIN = r.d.token || (await req('POST', '/api/auth/login', { password: PW })).d.token;
  rec('管理员登录', !!ADMIN);

  // ---------- 小程序登录（dev 模式）----------
  const openid = 'mp_contract_' + Date.now().toString(36);
  r = await req('POST', '/api/mp/dev-login', { openid, nickname: '契约测试' });
  const U = r.d.token;
  rec('mp/dev-login', r.status === 200 && !!U, `status=${r.status}`);
  const uid = r.d.user && r.d.user.id;

  // ---------- 普通用户接口（待审批状态也要能读）----------
  const userCalls = [
    ['GET', '/api/mp/me', undefined],
    ['GET', '/api/mp/version', undefined],
    ['GET', '/api/mp/printers', undefined],
    ['GET', '/api/mp/files', undefined],
    ['GET', '/api/mp/tasks', undefined],
    ['PUT', '/api/mp/profile', { nickname: '契约测试改名' }],
    ['POST', '/api/mp/qr/scan', { ticket: 'invalid-ticket' }],
    ['POST', '/api/mp/qr/confirm', { ticket: 'invalid-ticket' }],
    ['POST', '/api/mp/bind', { token: '000000' }]
  ];
  for (const [m, p, b] of userCalls) {
    r = await req(m, p, b, U);
    rec(`用户 ${m} ${p}`, !r.missing, `status=${r.status}${r.d.msg ? ' ' + r.d.msg : ''}`);
  }

  // 上传在待审批时应 403 NOT_APPROVED（小程序据此提示）
  let fd = new FormData();
  fd.append('file', new Blob([Buffer.from('%PDF-1.4\n% contract\n')], { type: 'application/pdf' }), 'contract.pdf');
  r = await req('POST', '/api/mp/files', fd, U, true);
  rec('待审批上传被拒且带 NOT_APPROVED', r.status === 403 && r.d.code === 'NOT_APPROVED', `status=${r.status} code=${r.d.code || '-'}`);

  // ---------- 管理员放行 ----------
  r = await req('POST', `/api/users/${uid}/approve`, {}, ADMIN);
  rec('后台放行', r.d.ok === true, r.d.msg || '');

  // 放行后上传/打印
  fd = new FormData();
  fd.append('file', new Blob([Buffer.from('%PDF-1.4\n% contract after\n')], { type: 'application/pdf' }), 'after.pdf');
  r = await req('POST', '/api/mp/files', fd, U, true);
  const fileId = r.d.file && r.d.file.id;
  rec('放行后上传成功', r.status === 200 && !!fileId, `id=${fileId}`);
  r = await req('POST', '/api/mp/print', { fileId, printer: 'HP_LaserJet_M404', options: { copies: 1 } }, U);
  rec('放行后提交打印不再被审批拦', !(r.status === 403 && r.d.code === 'NOT_APPROVED'), `status=${r.status}`);

  // ---------- 小程序管理端接口（把管理员绑成管理员）----------
  // 让管理员 openid 具备管理权限：直接改库比走绑定码更稳
  r = await req('POST', '/api/mp/dev-login', { openid: 'mp_admin_' + Date.now().toString(36), nickname: '管理员' });
  const ADMIN_MP = r.d.token;
  const adminUid = r.d.user && r.d.user.id;
  rec('管理员身份登录小程序', !!ADMIN_MP, `uid=${adminUid}`);
  // 用后台接口把该账号提升为管理员（真实流程里是绑定码/后台指定）
  r = await req('POST', `/api/users/${adminUid}/promote`, {}, ADMIN);
  rec('后台提升为管理员', r.d.ok === true, r.d.msg || '');

  const adminCalls = [
    ['GET', '/api/mp/admin/overview', undefined],
    ['GET', '/api/mp/admin/users', undefined],
    ['GET', '/api/mp/admin/tasks', undefined],
    ['GET', '/api/mp/admin/printers', undefined],
    ['GET', '/api/mp/admin/settings', undefined],
    ['PUT', '/api/mp/admin/settings', {}],
    ['POST', `/api/mp/admin/users/${uid}/approve`, {}],
    ['POST', `/api/mp/admin/tasks/1/approve`, {}],
    ['POST', '/api/mp/admin/printers/HP_LaserJet_M404/pause', {}],
    ['POST', '/api/mp/admin/tasks/cleanup', {}]
  ];
  for (const [m, p, b] of adminCalls) {
    r = await req(m, p, b, ADMIN_MP);
    rec(`管理端 ${m} ${p}`, !r.missing, `status=${r.status}${r.d.msg ? ' ' + r.d.msg : ''}`);
  }

  console.log(`\n合计 ${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})();
