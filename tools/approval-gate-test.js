'use strict';
// 审批闸门回归：未审批不能打印、审批后能打印但仍看不到后台设置
// 用法：BASE=http://127.0.0.1:8125 node tools/approval-gate-test.js
const BASE = process.env.BASE || 'http://127.0.0.1:8125';
const PW = process.env.PW || 'LocalTest2026';
let pass = 0, fail = 0;
const rec = (n, ok, d = '') => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'} | ${n}${d ? ' | ' + d : ''}`); };

const j = async (method, path, body, token) => {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  let payload;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const r = await fetch(BASE + path, { method, headers, body: payload });
  let d = {}; try { d = await r.json(); } catch (_) {}
  return { status: r.status, d };
};

const pdf = () => new Blob([Buffer.from('%PDF-1.4\n% approval gate\n')], { type: 'application/pdf' });
const upload = async (token, name = 'gate.pdf') => {
  const fd = new FormData();
  fd.append('file', pdf(), name);
  return j('POST', '/api/mp/files', fd, token);
};

(async () => {
  let r = await j('POST', '/api/setup', { password: PW, confirm: PW });
  const ADMIN = r.d.token || (await j('POST', '/api/auth/login', { password: PW })).d.token;
  if (!ADMIN) { console.error('取不到管理员令牌'); process.exit(1); }

  // 前置：开注册、开审批（新用户必须等审批）
  await j('PUT', '/api/settings', { enableUserRegister: true, approveNewUser: true }, ADMIN);

  const stamp = Date.now().toString(36);
  const uname = `gate_${stamp}`;
  const pwd = 'Passw0rd123';

  // ---------- 1) 注册后是待审批 ----------
  r = await j('POST', '/api/auth/account/register', { username: uname, password: pwd, confirm: pwd, nickname: '待审用户' });
  const TOK = r.d.token;
  const uid = r.d.user && r.d.user.id;
  rec('注册成功且为待审批', !!(r.d.ok && r.d.user && r.d.user.status === 'pending' && r.d.needApproval === true), `status=${r.d.user && r.d.user.status} msg=${r.d.msg || ''}`);

  r = await j('GET', '/api/mp/me', undefined, TOK);
  rec('门户读到待审批状态', !!(r.d.user && r.d.user.status === 'pending'));

  // ---------- 2) 待审批：打印链路全被拦 ----------
  r = await upload(TOK);
  rec('待审批不能上传文件', r.status === 403 && r.d.code === 'NOT_APPROVED', r.d.msg || `status=${r.status}`);

  r = await j('POST', '/api/mp/print', { fileId: 1, printer: 'X', options: {} }, TOK);
  rec('待审批不能提交打印', r.status === 403 && r.d.code === 'NOT_APPROVED', r.d.msg || `status=${r.status}`);

  r = await j('DELETE', '/api/mp/history', undefined, TOK);
  rec('待审批不能清空历史（同一道闸门）', r.status === 403, `status=${r.status}`);

  // 但仍可以看自己的记录与打印机列表
  r = await j('GET', '/api/mp/tasks', undefined, TOK);
  rec('待审批仍可查看自己的记录', r.status === 200 && Array.isArray(r.d.tasks), `status=${r.status}`);
  r = await j('GET', '/api/mp/printers', undefined, TOK);
  rec('待审批仍可读打印机列表', r.status === 200, `status=${r.status}`);

  // ---------- 3) 管理员审批 ----------
  r = await j('GET', '/api/users?status=pending&size=200', undefined, ADMIN);
  const hit = (r.d.users || []).find((u) => u.id === uid);
  rec('待审批列表能看到该用户', !!hit, `found=${r.d.users ? r.d.users.length : 0}`);
  r = await j('POST', `/api/users/${uid}/approve`, {}, ADMIN);
  rec('管理员放行成功', r.d.ok === true, r.d.msg || '');

  r = await j('GET', '/api/mp/me', undefined, TOK);
  rec('放行后会话立即变成已授权', r.d.user.status === 'approved');

  // ---------- 4) 审批通过：能打印，但仍看不到后台 ----------
  r = await upload(TOK, 'after-approve.pdf');
  rec('审批通过后可以上传', r.status === 200 && r.d.ok === true, r.d.msg || `status=${r.status}`);
  const fileId = r.d.file && r.d.file.id;

  r = await j('POST', '/api/mp/print', { fileId, printer: 'HP_LaserJet_M404', options: { copies: 1 } }, TOK);
  // 本机没 CUPS 时可能是 503/400，但只要不是 NOT_APPROVED 就说明闸门放行了
  rec('审批通过后不再被审批闸门拦', !(r.status === 403 && r.d.code === 'NOT_APPROVED'), `status=${r.status} code=${r.d.code || '-'}`);

  // 打印机「读」是打印工作台必需的（只给队列状态，不含任务数），写操作仍然只有管理员能做
  r = await j('GET', '/api/printers', undefined, TOK);
  rec('工作台可以只读打印机列表', r.status === 200 && Array.isArray(r.d.printers), 'status=' + r.status);
  r = await j('POST', '/api/printers', { name: 'hack', uri: 'ipp://x/y' }, TOK);
  rec('普通用户不能新增打印机', r.status === 401 || r.status === 403, 'status=' + r.status);
  r = await j('GET', '/api/printers/devices', undefined, TOK);
  rec('普通用户不能扫描设备', r.status === 401 || r.status === 403, 'status=' + r.status);

  for (const [label, path] of [
    ['系统设置', '/api/settings'], ['用户管理', '/api/users'], ['审计日志', '/api/audit'],
    ['小程序后台', '/api/mp/admin/overview']
  ]) {
    r = await j('GET', path, undefined, TOK);
    rec('已授权普通用户仍进不了「' + label + '」', r.status === 401 || r.status === 403, 'status=' + r.status);
  }

  // ---------- 5) 被拒绝的用户同样不能打印 ----------
  await j('PUT', '/api/settings', { approveNewUser: true }, ADMIN);
  const uname2 = `rej_${stamp}`;
  r = await j('POST', '/api/auth/account/register', { username: uname2, password: pwd, confirm: pwd });
  const TOK2 = r.d.token;
  const uid2 = r.d.user && r.d.user.id;
  await j('POST', `/api/users/${uid2}/reject`, {}, ADMIN);
  r = await upload(TOK2, 'rejected.pdf');
  rec('被拒绝的用户不能上传', r.status === 403 && r.d.code === 'NOT_APPROVED', r.d.msg || `status=${r.status}`);

  // ---------- 6) 拉黑后直接踢出 ----------
  await j('POST', `/api/users/${uid}/block`, {}, ADMIN);
  r = await j('GET', '/api/mp/me', undefined, TOK);
  rec('被拉黑后会话立即失效', r.status === 401 || r.status === 403, `status=${r.status}`);
  await j('POST', `/api/users/${uid}/unblock`, {}, ADMIN);

  // 复原
  await j('PUT', '/api/settings', { enableUserRegister: true, approveNewUser: true }, ADMIN);

  console.log(`\n合计 ${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})();
