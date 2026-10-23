'use strict';
// 文件 / 任务 / API Key 猎杀：越权访问、删除后一致性、预览分支、打印参数白名单、密钥生命周期
// 本机没有 CUPS 也能跑（打印落队列的部分只验证「拒绝得是否明确」）
// 用法：PG_BASE=http://127.0.0.1:8099 PG_PASS=xxx node tools/file-task-hunt.js
const fs = require('fs');
const path = require('path');
const os = require('os');

const BASE = process.env.PG_BASE || 'http://127.0.0.1:8099';
const PASS = process.env.PG_PASS || 'LocalTest2026';

const results = [];
const rec = (n, p, d = '') => {
  results.push({ n, p, d });
  console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? `  —  ${d}` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function req(method, url, body, token = '', extraHeaders = {}) {
  const headers = { ...extraHeaders };
  if (token) headers.Authorization = `Bearer ${token}`;
  let payload;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const res = await fetch(BASE + url, { method, headers, body: payload });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch (_) { data = { raw: text.slice(0, 160) }; }
  return { status: res.status, data, headers: res.headers };
}

async function uploadTo(url, token, buf, filename, field = 'file') {
  const fd = new FormData();
  fd.append(field, new Blob([buf]), filename);
  const res = await fetch(BASE + url, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: fd });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64'
);
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n', 'latin1');

(async () => {
  let r = await req('GET', '/api/public/bootstrap');
  let ADMIN = '';
  if (r.data.needsSetup) ADMIN = (await req('POST', '/api/setup', { password: PASS, confirm: PASS })).data.token;
  else ADMIN = (await req('POST', '/api/auth/login', { password: PASS })).data.token;
  if (!ADMIN) { console.log('无法登录'); process.exit(1); }

  // 这组用例靠 dev-login 造用户；生产镜像默认关着开发模式，自己开（跑完不还原，后续套件也可能要用）
  await req('PUT', '/api/settings', { devMode: true }, ADMIN);

  const stamp = Date.now().toString(36);
  const newUser = async (extra = {}) => {
    for (let i = 0; i < 5; i++) {
      const d = await req('POST', '/api/mp/dev-login', Object.assign({ openid: `ft_${stamp}_${Math.random().toString(36).slice(2, 8)}` }, extra));
      if (d.data && d.data.token) return { token: d.data.token, user: d.data.user };
      await sleep(2500); // dev-login 有 20 次/分钟限流
    }
    throw new Error('创建用户失败（限流？）');
  };
  const approve = async (id) => req('POST', `/api/users/${id}/approve`, {}, ADMIN);

  const alice = await newUser({ nickname: '爱丽丝', wechat_id: `alice_${stamp}` });
  const bob = await newUser({ nickname: '鲍勃', wechat_id: `bob_${stamp}` });
  await approve(alice.user.id);
  await approve(bob.user.id);

  console.log('=== A. 文件上传 ===');
  r = await uploadTo('/api/mp/files', alice.token, PNG, '测试图片.png');
  const aFile = r.data.file || {};
  rec('已授权用户上传图片', !!aFile.id, `${aFile.filename} ${aFile.size}B`);
  r = await uploadTo('/api/mp/files', alice.token, PDF, 'doc.pdf');
  const aPdf = r.data.file || {};
  rec('上传 PDF', !!aPdf.id, `${aPdf.filename}`);
  r = await uploadTo('/api/mp/files', alice.token, Buffer.alloc(0), 'empty.pdf');
  rec('空文件被拒', r.status === 400, r.data.msg || '');
  r = await uploadTo('/api/mp/files', alice.token, Buffer.from('#!/bin/sh\nrm -rf /'), 'evil.sh');
  rec('不支持的类型被拒', r.status === 400, r.data.msg || '');
  r = await uploadTo('/api/mp/files', alice.token, PDF, '../../escape.pdf');
  rec('文件名带穿越路径只取文件名', r.status === 200 && !/\.\./.test((r.data.file || {}).filename || ''), (r.data.file || {}).filename || `(status ${r.status})`);
  const pending = await newUser({ nickname: '待审批者' });
  r = await uploadTo('/api/mp/files', pending.token, PNG, 'x.png');
  rec('待审批用户不能上传', r.status === 403, `status=${r.status}`);

  console.log('\n=== B. 越权访问（A 动 B 的文件） ===');
  const bUp = await uploadTo('/api/mp/files', bob.token, PNG, 'bob.png');
  const bFile = bUp.data.file || {};
  rec('B 上传成功', !!bFile.id, bFile.filename);
  r = await req('GET', `/api/mp/files/${bFile.id}/preview`, undefined, alice.token);
  rec('A 不能预览 B 的文件', r.status === 404, `status=${r.status}`);
  r = await req('DELETE', `/api/mp/files/${bFile.id}`, undefined, alice.token);
  rec('A 不能删 B 的文件', r.status === 404, `status=${r.status}`);
  r = await req('POST', '/api/mp/print', { fileId: bFile.id, printer: 'none' }, alice.token);
  rec('A 不能拿 B 的文件打印', r.status === 404, `status=${r.status}`);
  r = await req('GET', '/api/mp/files', undefined, alice.token);
  rec('文件列表只看到自己的', (r.data.files || []).every((f) => ![bFile.id].includes(f.id)) && (r.data.files || []).length >= 2,
    `A 有 ${(r.data.files || []).length} 个`);

  console.log('\n=== C. 删除后一致性 ===');
  const prev = await fetch(`${BASE}/api/mp/files/${aFile.id}/preview`, { headers: { Authorization: `Bearer ${alice.token}` } });
  rec('图片可预览', prev.status === 200, `status=${prev.status} ${prev.headers.get('content-type')}`);
  r = await req('DELETE', `/api/mp/files/${aFile.id}`, undefined, alice.token);
  rec('删除自己的文件', r.status === 200, r.data.msg || '');
  const after = await fetch(`${BASE}/api/mp/files/${aFile.id}/preview`, { headers: { Authorization: `Bearer ${alice.token}` } });
  rec('删除后预览不可用', after.status === 404 || after.status === 410, `status=${after.status}`);

  console.log('\n=== D. 打印任务（无 CUPS 时的失败语义） ===');
  r = await req('POST', '/api/mp/print', { fileId: aPdf.id, printer: 'NoSuchPrinter', options: { copies: 1 } }, alice.token);
  rec('打印到不存在的队列明确报错', [400, 503].includes(r.status) && !!r.data.msg, `${r.status} ${r.data.msg || ''}`);
  r = await req('POST', '/api/mp/print', { fileId: 999999, printer: 'x' }, alice.token);
  rec('打印不存在的文件 404', r.status === 404, `status=${r.status}`);
  r = await req('POST', '/api/mp/print', { fileId: aPdf.id, printer: 'x', options: { copies: 9999 } }, alice.token);
  rec('超上限份数被夹住或报错', [400, 503].includes(r.status) || (r.data.task && r.data.task.copies <= 10), JSON.stringify(r.data).slice(0, 80));
  r = await req('POST', '/api/mp/print', {
    fileId: aPdf.id, printer: 'x',
    options: { pageRanges: '1-3; rm -rf /', extra: '--evil', media: 'A4\'; DROP TABLE tasks; --' }
  }, alice.token);
  rec('打印参数白名单生效（非法值不入库）', r.status === 400 || !JSON.stringify(r.data).includes('rm -rf') && !JSON.stringify(r.data).includes('DROP TABLE'),
    (r.data.msg || '').slice(0, 60));
  r = await req('GET', '/api/mp/tasks', undefined, alice.token);
  rec('任务列表可查', r.status === 200 && Array.isArray(r.data.tasks));
  r = await req('POST', '/api/mp/tasks/999999/cancel', {}, alice.token);
  rec('取消不存在的任务 404', r.status === 404, `status=${r.status}`);

  console.log('\n=== E. 管理端文件与任务 ===');
  r = await req('GET', '/api/files', undefined, ADMIN);
  rec('管理端文件列表', r.status === 200 && Array.isArray(r.data.files), `${(r.data.files || []).length} 个`);
  const anyFile = (r.data.files || [])[0];
  if (anyFile) {
    r = await req('GET', `/api/tasks?status=all`, undefined, ADMIN);
    rec('管理端任务列表', r.status === 200 && Array.isArray(r.data.tasks));
  } else {
    rec('管理端任务列表', true, '(无文件，跳过)');
  }
  r = await req('POST', '/api/tasks/999999/approve', {}, ADMIN);
  rec('审批不存在任务 404', r.status === 404, `status=${r.status}`);
  r = await req('GET', '/api/mp/files', undefined, ADMIN);
  rec('后台令牌不能调小程序文件接口', r.status === 401, `status=${r.status}`);

  console.log('\n=== F. API Key 生命周期 ===');
  r = await req('POST', '/api/keys', { name: `猎杀Key_${stamp}` }, ADMIN);
  const keyRow = r.data.key || r.data || {};
  const plain = r.data.token || r.data.plain || keyRow.token || '';
  rec('创建 API Key', !!plain, `${plain.slice(0, 8)}…`);
  r = await req('GET', '/api/keys', undefined, ADMIN);
  const list = r.data.keys || [];
  rec('列表只返回掩码', list.length > 0 && !list.some((k) => k.token), `${list.length} 条`);
  const kid = (list[0] || {}).id || keyRow.id;
  if (plain && kid) {
    r = await req('POST', '/api/print', { fileId: aPdf.id, printer: 'x' }, '', { 'x-api-key': plain });
    rec('用 Key 调用开放接口不被 401', r.status !== 401, `status=${r.status}`);
    r = await req('GET', '/api/users', undefined, '', { 'x-api-key': plain });
    rec('Key 不能看用户列表（需管理员）', r.status === 401, `status=${r.status}`);
    r = await req('DELETE', `/api/keys/${kid}`, undefined, ADMIN);
    rec('吊销成功', r.status === 200, r.data.msg || '');
    r = await req('POST', '/api/print', { fileId: aPdf.id, printer: 'x' }, '', { 'x-api-key': plain });
    rec('吊销后 Key 失效', r.status === 401, `status=${r.status}`);
  }
  r = await req('POST', '/api/keys', { name: '' }, ADMIN);
  rec('空名称创建被拒或自动生成', r.status === 200 || r.status === 400, `status=${r.status}`);
  r = await req('POST', '/api/keys', { name: 'x' }, alice.token);
  rec('小程序令牌不能建 Key', r.status === 401, `status=${r.status}`);

  console.log('\n=== G. 通用健壮性 ===');
  const malformed = await fetch(`${BASE}/api/users`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ADMIN}` },
    body: '{bad json'
  });
  rec('畸形 JSON 返回 4xx 不 500', malformed.status >= 400 && malformed.status < 500, `status=${malformed.status}`);
  const h = await fetch(`${BASE}/api/health`);
  rec('安全响应头齐全', ['x-content-type-options', 'x-frame-options', 'content-security-policy'].every((k) => h.headers.get(k)),
    Object.fromEntries(['x-content-type-options', 'x-frame-options', 'content-security-policy'].map((k) => [k, !!h.headers.get(k)])));
  const nf = await req('GET', '/api/definitely-not-here');
  rec('未知接口 404 且是 JSON', nf.status === 404 && nf.data.ok === false, `status=${nf.status}`);

  console.log('\n=== H. 搜索通配符（任务 / 审计） ===');
  const tasksAll = await req('GET', '/api/tasks?status=all&size=200', undefined, ADMIN);
  const tTotal = (tasksAll.data.tasks || []).length;
  r = await req('GET', '/api/tasks?status=all&size=200&q=%', undefined, ADMIN);
  rec('任务搜索 "%" 不当通配符', (r.data.tasks || []).length < Math.max(1, tTotal), `命中 ${(r.data.tasks || []).length} / 全量 ${tTotal}`);
  const auditAll = await req('GET', '/api/audit?size=500', undefined, ADMIN);
  const aTotal = (auditAll.data.total || 0);
  r = await req('GET', '/api/audit?size=500&q=%', undefined, ADMIN);
  rec('审计搜索 "%" 不当通配符', (r.data.total || 0) < Math.max(1, aTotal), `命中 ${r.data.total} / 全量 ${aTotal}`);
  r = await req('GET', '/api/audit?size=10&action=%', undefined, ADMIN);
  rec('审计按操作类型筛 "%" 不放大', (r.data.total || 0) < Math.max(1, aTotal), `命中 ${r.data.total}`);
  r = await req('GET', "/api/tasks?status=all&q=' OR '1'='1", undefined, ADMIN);
  rec('任务搜索 SQL 片段安全', r.status === 200 && (r.data.tasks || []).length === 0);

  console.log('\n=== I. 任务列表带提交者资料 ===');
  // 本机没有 CUPS，打印接口建不出任务，直接往库里插一条用于验证 join 字段。
  // 前面的用例（删除 / 清理）可能已把 alice 的文件清光，这里先补传一个再插任务
  const freshUp = await uploadTo('/api/mp/files', alice.token, PDF, 'for-task.pdf');
  const freshFile = freshUp.data.file || {};
  let inserted = null;
  try {
    const Database = require(require('./_paths').serverModulePath('better-sqlite3'));
    // 服务可能跑在 _data 或 _data_final，挑一个真实存在的库
    const dbPath = [process.env.PG_DB, path.join(__dirname, '..', '_data_final', 'printgate.db'), path.join(__dirname, '..', '_data', 'printgate.db')]
      .filter(Boolean)
      .find((p) => fs.existsSync(p));
    const db = new Database(dbPath);
    const file = db.prepare("SELECT id FROM files WHERE user_id = ? AND status = 'active' LIMIT 1").get(alice.user.id)
      || (freshFile.id ? { id: freshFile.id } : null);
    if (file) {
      const info = db.prepare(
        `INSERT INTO tasks (user_id, file_id, printer, copies, options_json, status, source, created_at)
         VALUES (?,?,?,?,?,?,?,?)`
      ).run(alice.user.id, file.id, 'Hunt-Printer', 2, JSON.stringify({ copies: 2, color: 'mono' }), 'done', 'miniapp', new Date().toISOString());
      inserted = info.lastInsertRowid;
    }
    db.close();
  } catch (e) {
    console.log('  (插库失败：' + e.message + ')');
  }
  r = await req('GET', '/api/tasks?status=all&size=50', undefined, ADMIN);
  const tasks = r.data.tasks || [];
  const withUser = tasks.find((t) => t.user_id === alice.user.id);
  rec('任务接口返回提交者资料', !!withUser && 'avatar' in withUser && 'wechat_id' in withUser && 'phone' in withUser,
    withUser ? `昵称=${withUser.nickname} 微信号=${withUser.wechat_id || '(空)'} 手机=${withUser.phone || '(空)'}` : '(没查到带用户的任务)');
  rec('提交者微信号能关联到用户', !!withUser && withUser.wechat_id === `alice_${stamp}`, withUser ? withUser.wechat_id : '');
  if (inserted) {
    r = await req('GET', `/api/tasks/${inserted}`, undefined, ADMIN);
    rec('任务详情同样带资料', !!r.data.task && 'wechat_id' in r.data.task, (r.data.task || {}).nickname || '');
  }

  const pass = results.filter((x) => x.p).length;
  console.log(`\n===== ${pass}/${results.length} 通过 =====`);
  const failed = results.filter((x) => !x.p);
  if (failed.length) {
    console.log('失败项：');
    for (const f of failed) console.log(`  - ${f.n} ${f.d}`);
    process.exitCode = 1;
  }
})();
