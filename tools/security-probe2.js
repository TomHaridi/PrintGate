'use strict';
// 第二轮攻击面：API Key 范围、设置边界、日志白名单、任务状态机
// 用法：BASE=http://127.0.0.1:8200 PW=LocalTest2026 node tools/security-probe2.js
const fs = require('fs');

const BASE = process.env.BASE || 'http://127.0.0.1:8200';
const PW = process.env.PW || 'LocalTest2026';
let pass = 0, fail = 0;
const bugs = [];
const rec = (n, ok, d = '') => { ok ? pass++ : (fail++, bugs.push(`${n}${d ? ' — ' + d : ''}`)); console.log(`${ok ? 'PASS' : 'FAIL'} | ${n}${d ? ' | ' + d : ''}`); };

const j = async (m, p, b, t, extra) => {
  const h = Object.assign({}, extra || {});
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
  if (!ADM) process.exit(1);

  // ---------- 1) 设置边界 ----------
  const before = (await j('GET', '/api/settings', undefined, ADM)).d.settings;
  const bad = [
    ['maxFileMB=0', { maxFileMB: 0 }],
    ['maxFileMB=-5', { maxFileMB: -5 }],
    ['maxFileMB=99999', { maxFileMB: 99999 }],
    ['maxCopies=0', { maxCopies: 0 }],
    ['sessionHours=0', { sessionHours: 0 }],
    ['retentionDays=-1', { retentionDays: -1 }],
    ['loginMaxFail=999', { loginMaxFail: 999 }]
  ];
  for (const [name, body] of bad) {
    const r = await j('PUT', '/api/settings', body, ADM);
    rec(`${name} 被拒`, r.s >= 400, `status=${r.s} ${r.d.msg || ''}`);
  }
  const after = (await j('GET', '/api/settings', undefined, ADM)).d.settings;
  rec('非法值没有写进配置', JSON.stringify(before) === JSON.stringify(after), 'settings 被改动了');

  // 合法值能存
  const okSet = await j('PUT', '/api/settings', { maxCopies: 42 }, ADM);
  const now = (await j('GET', '/api/settings', undefined, ADM)).d.settings;
  rec('合法值可以保存', okSet.s === 200 && now.print && now.print.maxCopies === 42, `maxCopies=${now.print && now.print.maxCopies}`);
  await j('PUT', '/api/settings', { maxCopies: before.print.maxCopies }, ADM);

  // ---------- 2) 日志白名单 ----------
  for (const name of ['..%2f..%2fetc%2fpasswd', 'printgate.db', '__proto__', 'constructor']) {
    const r = await j('GET', `/api/system/logs/${name}`, undefined, ADM);
    rec(`日志名 ${decodeURIComponent(name)} 被拦`, r.s === 400 || r.d.ok === false, `status=${r.s}`);
  }
  const logs = await j('GET', '/api/system/logs', undefined, ADM);
  rec('日志列表只含白名单项', Array.isArray(logs.d.logs) && logs.d.logs.every((x) => !String(x.path || '').includes('..')));

  // ---------- 3) API Key 范围 ----------
  const created = await j('POST', '/api/keys', { name: 'probe-key' }, ADM);
  const key = created.d.key || created.d.token;
  rec('创建 API Key', !!key, key ? `${String(key).slice(0, 8)}…` : '');
  if (key) {
    // 正常用途：上传文件（/files 允许 admin 或 key）
    const pdf = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n', 'utf8');
    const fd = new FormData();
    fd.append('file', new Blob([pdf], { type: 'application/pdf' }), 'key-upload.pdf');
    const up = await fetch(BASE + '/api/files', { method: 'POST', headers: { 'x-api-key': key }, body: fd });
    rec('Key 可以上传文件', up.status === 200, `status=${up.status}`);

    // 越权：Key 不能读用户列表 / 改设置 / 管 Key
    for (const [name, m, p] of [
      ['用户列表', 'GET', '/api/users'],
      ['系统设置', 'GET', '/api/settings'],
      ['Key 列表', 'GET', '/api/keys'],
      ['审计日志', 'GET', '/api/audit']
    ]) {
      const r = await j(m, p, undefined, undefined, { 'x-api-key': key });
      rec(`Key 不能访问${name}`, r.s === 401 || r.s === 403, `status=${r.s}`);
    }

    // 伪造 / 吊销
    const fake = await j('GET', '/api/files', undefined, undefined, { 'x-api-key': 'pg_fake_key_123' });
    rec('伪造 Key 被拒', fake.s === 401, `status=${fake.s}`);

    const list = await j('GET', '/api/keys', undefined, ADM);
    const row = (list.d.keys || []).find((k) => k.name === 'probe-key');
    if (row) {
      await j('DELETE', `/api/keys/${row.id}`, undefined, ADM);
      const after = await fetch(BASE + '/api/files', { method: 'POST', headers: { 'x-api-key': key }, body: new FormData() });
      rec('吊销后 Key 立即失效', after.status === 401 || after.status === 403, `status=${after.status}`);
    }
  }

  // ---------- 4) 任务状态机 ----------
  const st = Date.now().toString(36);
  const u = await j('POST', '/api/auth/account/register', { username: 'task_' + st, password: 'Passw0rd123', confirm: 'Passw0rd123' });
  const utok = u.d.token, uid = u.d.user.id;
  await j('POST', `/api/users/${uid}/approve`, {}, ADM);

  const pdf2 = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n', 'utf8');
  const fd2 = new FormData();
  fd2.append('file', new Blob([pdf2], { type: 'application/pdf' }), 'task.pdf');
  const up2 = await fetch(BASE + '/api/mp/files', { method: 'POST', headers: { Authorization: 'Bearer ' + utok }, body: fd2 });
  const fileId = (await up2.json()).file.id;

  // 用一个不存在的打印机入库 pending 任务，直接走 SQL 造状态更稳
  const DatabaseSync = require('node:sqlite').DatabaseSync;
  const dbPath = process.env.PG_DB;
  if (dbPath && fs.existsSync(dbPath)) {
    const db = new DatabaseSync(dbPath);
    const ins = db.prepare("INSERT INTO tasks (user_id, file_id, printer, copies, options_json, status, pages, source, created_at) VALUES (?,?,?,?,?,?,?,?,?)");
    const mk = (status) => Number(ins.run(uid, fileId, 'P', 1, '{}', status, 1, 'web', new Date().toISOString()).lastInsertRowid);
    const tidPending = mk('pending');
    const tidDone = mk('done');

    // 批准两次，第二次应 409（不能重复打印）
    const a1 = await j('POST', `/api/tasks/${tidPending}/approve`, {}, ADM);
    const a2 = await j('POST', `/api/tasks/${tidPending}/approve`, {}, ADM);
    rec('重复批准被拒', a1.s === 200 && (a2.s === 409 || a2.s === 400), `${a1.s}/${a2.s}`);

    // 已完成任务不能取消（这里正是取消顺序的坑：先调 CUPS 再判状态）
    const c1 = await j('POST', `/api/tasks/${tidDone}/cancel`, {}, ADM);
    rec('已完成任务不能取消', c1.s === 409, `status=${c1.s}`);

    // 已完成任务不能重试
    const r1 = await j('POST', `/api/tasks/${tidDone}/retry`, {}, ADM);
    rec('已完成任务不能重试', r1.s === 400, `status=${r1.s}`);

    // 拒绝 → 重试允许
    const tidReject = mk('pending');
    const rj = await j('POST', `/api/tasks/${tidReject}/reject`, { reason: '测试拒绝' }, ADM);
    const rt = await j('POST', `/api/tasks/${tidReject}/retry`, {}, ADM);
    rec('拒绝后可以重试', rj.s === 200 && rt.s === 200, `${rj.s}/${rt.s}`);

    // 拒绝的任务不能再次拒绝
    const rj2 = await j('POST', `/api/tasks/${tidPending}/reject`, {}, ADM);
    rec('已批准的任务不能再拒绝', rj2.s === 400, `status=${rj2.s}`);

    // 不存在的任务
    const nf = await j('POST', '/api/tasks/999999/cancel', {}, ADM);
    rec('不存在任务返回 404', nf.s === 404, `status=${nf.s}`);
    db.close();
  } else {
    console.log('SKIP | 状态机用例需要 PG_DB 指向测试库');
  }

  console.log(`\n合计 ${pass} 通过 / ${fail} 失败`);
  if (fail) console.log('失败项:\n - ' + bugs.join('\n - '));
  process.exit(fail ? 1 : 0);
})();
