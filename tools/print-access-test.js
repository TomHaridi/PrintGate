'use strict';
// 已审批普通用户使用「打印工作台」全部功能的回归（含越权/IDOR 检查）
// 用法：BASE=http://127.0.0.1:8126 node tools/print-access-test.js
const BASE = process.env.BASE || 'http://127.0.0.1:8126';
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

const pdfBlob = (text) => new Blob([Buffer.from(`%PDF-1.4\n% ${text}\n`)], { type: 'application/pdf' });
const upload = async (token, name) => {
  const fd = new FormData();
  fd.append('file', pdfBlob(name), name);
  return j('POST', '/api/files', fd, token);
};

(async () => {
  let r = await j('POST', '/api/setup', { password: PW, confirm: PW });
  const ADMIN = r.d.token || (await j('POST', '/api/auth/login', { password: PW })).d.token;
  if (!ADMIN) { console.error('取不到管理员令牌'); process.exit(1); }

  await j('PUT', '/api/settings', { enableUserRegister: true, approveNewUser: true }, ADMIN);

  const stamp = Date.now().toString(36);
  const uname = `wb_${stamp}`;
  const pwd = 'Passw0rd123';
  r = await j('POST', '/api/auth/account/register', { username: uname, password: pwd, confirm: pwd });
  const TOK = r.d.token;
  const uid = r.d.user && r.d.user.id;

  // ---------- 1) 待审批：工作台全部接口被拒 ----------
  for (const [label, method, path, body] of [
    ['读工作台元信息', 'GET', '/api/print/meta'],
    ['上传文件', 'POST', '/api/files'],
    ['文字速印', 'POST', '/api/print/text', { body: 'hello' }],
    ['任务列表', 'GET', '/api/tasks'],
    ['打印机列表', 'GET', '/api/printers']
  ]) {
    r = method === 'POST' && path === '/api/files'
      ? await upload(TOK, 'pending.pdf')
      : await j(method, path, body, TOK);
    rec(`待审批不能${label}`, r.status === 403 && r.d.code === 'NOT_APPROVED', `status=${r.status} code=${r.d.code || '-'}`);
  }

  // ---------- 2) 管理员放行 ----------
  await j('POST', `/api/users/${uid}/approve`, {}, ADMIN);

  r = await j('GET', '/api/print/meta', undefined, TOK);
  rec('放行后可读工作台元信息', r.d.ok === true && r.d.role === 'user', `role=${r.d.role}`);
  rec('元信息含打印机与限制', Array.isArray(r.d.printers) && typeof r.d.settings.maxCopies === 'number', `printers=${(r.d.printers || []).length}`);

  // ---------- 3) 上传与文件归属 ----------
  r = await upload(TOK, `user-${stamp}.pdf`);
  const userFile = r.d.file && r.d.file.id;
  rec('已审批用户可上传', r.status === 200 && !!userFile, r.d.msg || `id=${userFile}`);

  r = await upload(ADMIN, `admin-${stamp}.pdf`);
  const adminFile = r.d.file && r.d.file.id;
  rec('管理员上传正常', r.status === 200 && !!adminFile);

  r = await j('GET', '/api/files', undefined, TOK);
  const ids = (r.d.files || []).map((f) => f.id);
  rec('用户文件列表只有自己的', ids.includes(userFile) && !ids.includes(adminFile), `user=${userFile} admin=${adminFile} list=${ids.join(',')}`);

  r = await j('GET', '/api/files', undefined, ADMIN);
  const adminIds = (r.d.files || []).map((f) => f.id);
  rec('管理员仍只看到管理端上传（向后兼容）', adminIds.includes(adminFile), `list=${adminIds.join(',')}`);

  // ---------- 4) 越权访问别人的文件 ----------
  r = await j('DELETE', `/api/files/${adminFile}`, undefined, TOK);
  rec('用户删不了管理员的文件', r.status === 404, `status=${r.status}`);
  r = await j('GET', `/api/files/${adminFile}/preview`, undefined, TOK);
  rec('用户预览不了管理员的文件', r.status === 404, `status=${r.status}`);
  r = await j('POST', '/api/print', { fileId: adminFile, printer: 'X', options: {} }, TOK);
  rec('用户打印不了管理员的文件', r.status === 404, `status=${r.status} code=${r.d.code || '-'}`);

  // ---------- 5) 文字速印 / 合排 / 证件 走同一套闸门 ----------
  r = await j('POST', '/api/print/text', { body: '工作台测试\n第二行', title: '备注' }, TOK);
  rec('文字速印不再被审批闸门拦', !(r.status === 403 && r.d.code === 'NOT_APPROVED'), `status=${r.status} msg=${(r.d.msg || '').slice(0, 24)}`);

  r = await j('POST', '/api/print/compose', { fileIds: [userFile], printer: 'X' }, TOK);
  rec('发票合排不再被审批闸门拦', !(r.status === 403 && r.d.code === 'NOT_APPROVED'), `status=${r.status}`);

  r = await j('POST', '/api/print/idcard/auto-crop', { fileId: adminFile }, TOK);
  rec('证件矫正不能拿别人的图', r.status === 404 || r.status === 400, `status=${r.status}`);

  // ---------- 6) 任务列表隔离 ----------
  r = await j('GET', '/api/tasks?size=20', undefined, TOK);
  const tasks = r.d.tasks || r.d.rows || [];
  const leaked = tasks.filter((t) => t.user_id && t.user_id !== uid);
  rec('任务列表只剩自己的', leaked.length === 0, `count=${tasks.length} leaked=${leaked.length}`);

  // ---------- 7) 后台设置仍然进不去 ----------
  for (const [label, path] of [['系统设置', '/api/settings'], ['用户管理', '/api/users'], ['审计日志', '/api/audit']]) {
    r = await j('GET', path, undefined, TOK);
    rec(`工作台用户仍进不了「${label}」`, r.status === 401 || r.status === 403, `status=${r.status}`);
  }

  // ---------- 8) 删自己的文件可以 ----------
  r = await j('DELETE', `/api/files/${userFile}`, undefined, TOK);
  rec('用户可以删自己的文件', r.d.ok === true, r.d.msg || '');

  // 复原
  await j('PUT', '/api/settings', { enableUserRegister: true, approveNewUser: true }, ADMIN);

  console.log(`\n合计 ${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})();
