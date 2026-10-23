'use strict';
// 文件泄漏专项：小程序上传的文件能否被「猜到 / 绕过 / 越权 / 残留」拿到
// 用法：PG_BASE=http://127.0.0.1:8099 PG_PASS=xxx node tools/file-leak-hunt.js
const fs = require('fs');
const path = require('path');

const BASE = process.env.PG_BASE || 'http://127.0.0.1:8099';
const PASS = process.env.PG_PASS || 'LocalTest2026';
const DATA_DIR = process.env.PG_DATA_DIR || path.join(__dirname, '..', '_data_final');

const results = [];
const rec = (n, p, d = '') => {
  results.push({ n, p, d });
  console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? `  —  ${d}` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function req(method, url, body, token = '') {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(BASE + url, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch (_) { data = { raw: text.slice(0, 120) }; }
  return { status: res.status, data, headers: res.headers };
}

async function upload(token, buf, filename) {
  const fd = new FormData();
  fd.append('file', new Blob([buf]), filename);
  const res = await fetch(`${BASE}/api/mp/files`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: fd });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64'
);

(async () => {
  let r = await req('GET', '/api/public/bootstrap');
  let ADMIN = '';
  if (r.data.needsSetup) ADMIN = (await req('POST', '/api/setup', { password: PASS, confirm: PASS })).data.token;
  else ADMIN = (await req('POST', '/api/auth/login', { password: PASS })).data.token;
  if (!ADMIN) { console.log('无法登录'); process.exit(1); }

  const stamp = Date.now().toString(36);
  const mk = async (extra = {}) => {
    for (let i = 0; i < 5; i++) {
      const d = await req('POST', '/api/mp/dev-login', Object.assign({ openid: `leak_${stamp}_${Math.random().toString(36).slice(2, 8)}` }, extra));
      if (d.data && d.data.token) return { token: d.data.token, user: d.data.user };
      await sleep(2500);
    }
    throw new Error('创建用户失败');
  };
  const alice = await mk({ nickname: '泄漏测试A', wechat_id: `leaka_${stamp}` });
  const bob = await mk({ nickname: '泄漏测试B' });
  await req('POST', `/api/users/${alice.user.id}/approve`, {}, ADMIN);
  await req('POST', `/api/users/${bob.user.id}/approve`, {}, ADMIN);

  const filesDir = path.join(DATA_DIR, 'files');
  const listDir = () => (fs.existsSync(filesDir) ? fs.readdirSync(filesDir) : []);

  console.log('=== A. 文件是否落在 Web 可直连目录 ===');
  const dirBefore = new Set(listDir());
  const up = await upload(alice.token, PNG, '机密文档.png');
  const f = up.data.file || {};
  rec('上传成功', !!f.id, `${f.filename} ${f.size}B`);
  rec('落盘目录不在 webRoot', !fs.existsSync(path.join(require('./_paths').serverDir(), 'public', 'files')), 'server/public/files 不存在');
  // 用上传前后的目录差集确定落盘名，避免把上一轮残留的文件当成这次的
  const stored = listDir().find((n) => !dirBefore.has(n));
  rec('落盘文件名是随机名（非原始名）', !!stored && !/机密|[\u4e00-\u9fa5]/.test(stored), stored ? stored.slice(0, 24) + '…' : '(未取到)');
  // 直接猜 URL 能不能拿到
  if (stored) {
    for (const p of [`/files/${stored}`, `/uploads/${stored}`, `/data/files/${stored}`, `/api/files/${stored}`]) {
      const res = await fetch(BASE + p);
      const body = await res.text();
      const leaked = res.status === 200 && !body.includes('<!DOCTYPE html>');
      rec(`直连 ${p} 拿不到文件`, !leaked, `status=${res.status}`);
    }
  }

  console.log('\n=== B. 越权：ID 枚举 / 跨用户 ===');
  let leakedCount = 0;
  for (const id of [f.id - 1, f.id + 1, 1, 2, 9999]) {
    if (!id || id < 0) continue;
    const res = await fetch(`${BASE}/api/mp/files/${id}/preview`, { headers: { Authorization: `Bearer ${bob.token}` } });
    if (res.status === 200) leakedCount++;
  }
  rec('B 枚举邻近 ID 拿不到 A 的文件', leakedCount === 0, `泄漏 ${leakedCount} 次`);
  const bobUp = await upload(bob.token, PNG, 'bob-secret.png');
  let bLeak = await fetch(`${BASE}/api/mp/files/${bobUp.data.file.id}/preview`, { headers: { Authorization: `Bearer ${alice.token}` } });
  rec('A 直取 B 的文件 404', bLeak.status === 404, `status=${bLeak.status}`);
  bLeak = await fetch(`${BASE}/api/files/${bobUp.data.file.id}/preview`, { headers: { Authorization: `Bearer ${alice.token}` } });
  rec('A 用管理端预览接口越权 401', bLeak.status === 401, `status=${bLeak.status}`);
  const noToken = await fetch(`${BASE}/api/mp/files/${f.id}/preview`);
  rec('无令牌预览 401', noToken.status === 401, `status=${noToken.status}`);
  r = await req('GET', '/api/mp/files', undefined, bob.token);
  rec('文件列表互不串号', (r.data.files || []).every((x) => x.id !== f.id), `B 看到 ${(r.data.files || []).length} 个`);

  console.log('\n=== C. 删除后是否真的从磁盘清掉 ===');
  const before = listDir().length;
  r = await req('DELETE', `/api/mp/files/${f.id}`, undefined, alice.token);
  rec('删除接口返回成功', r.status === 200, r.data.msg || '');
  const after = listDir();
  // 直接看那个随机名文件还在不在磁盘上，光比数量会被别的用户文件干扰
  rec('原文件已从磁盘移除', !!stored && !fs.existsSync(path.join(filesDir, stored)),
    stored ? `${stored.slice(0, 16)}… ${fs.existsSync(path.join(filesDir, stored)) ? '仍在' : '已删'}` : '(无落盘名)');
  const prev = await fetch(`${BASE}/api/mp/files/${f.id}/preview`, { headers: { Authorization: `Bearer ${alice.token}` } });
  rec('删除后预览 404/410', prev.status === 404 || prev.status === 410, `status=${prev.status}`);

  console.log('\n=== D. 用户被删除时文件是否连带清理 ===');
  const carol = await mk({ nickname: '待删除C' });
  await req('POST', `/api/users/${carol.user.id}/approve`, {}, ADMIN);
  const cUp = await upload(carol.token, PNG, 'carol.png');
  const cId = cUp.data.file.id;
  const beforeDel = fs.existsSync(filesDir) ? fs.readdirSync(filesDir).length : 0;
  r = await req('DELETE', `/api/users/${carol.user.id}`, undefined, ADMIN);
  rec('删除用户', r.status === 200, r.data.msg || '');
  const afterDel = fs.existsSync(filesDir) ? fs.readdirSync(filesDir).length : 0;
  rec('用户文件随账号删除', afterDel < beforeDel, `${beforeDel} → ${afterDel}`);
  const gone = await fetch(`${BASE}/api/files/${cId}/preview`, { headers: { Authorization: `Bearer ${ADMIN}` } });
  rec('管理端也无法预览已删文件', gone.status === 404 || gone.status === 410, `status=${gone.status}`);

  console.log('\n=== E. 头像文件可猜测性 ===');
  const avDir = path.join(DATA_DIR, 'avatars');
  const avatars = fs.existsSync(avDir) ? fs.readdirSync(avDir) : [];
  rec('头像文件名随机 24 位 hex', avatars.length === 0 || avatars.every((n) => /^[a-f0-9]{24}\.(png|jpg|jpeg|gif|webp)$/.test(n)),
    avatars.slice(0, 2).join(',') || '(暂无)');
  r = await req('GET', '/api/mp/avatar/000000000000000000000000.png');
  rec('猜测不存在的头像 404', r.status === 404, `status=${r.status}`);
  const dirList = await fetch(`${BASE}/api/mp/avatar/`);
  rec('头像目录不可列举', dirList.status !== 200, `status=${dirList.status}`);

  console.log('\n=== F. 响应头与内容安全 ===');
  const up2 = await upload(bob.token, PNG, 'header.png');
  const pv = await fetch(`${BASE}/api/mp/files/${up2.data.file.id}/preview`, { headers: { Authorization: `Bearer ${bob.token}` } });
  rec('预览带 nosniff', pv.headers.get('x-content-type-options') === 'nosniff', pv.headers.get('x-content-type-options') || '(无)');
  rec('预览带 CSP', !!pv.headers.get('content-security-policy'));
  rec('预览不缓存到共享缓存', /private|no-store/.test(pv.headers.get('cache-control') || ''), pv.headers.get('cache-control') || '(无)');

  console.log('\n=== F2. 保留期清理是否物理删除 ===');
  // 清理接口按服务端的「保留天数」策略执行（请求体里的 days 不生效），
  // 所以把这条文件的时间戳改到 10 天前，再触发清理，看是否真的从磁盘删掉
  const dirBefore2 = new Set(listDir());
  const keepUp = await upload(bob.token, PNG, 'old-file.png');
  const keepId = keepUp.data.file.id;
  const keepStored = listDir().find((n) => !dirBefore2.has(n));
  rec('取到本次落盘文件', !!keepStored, keepStored ? keepStored.slice(0, 16) + '…' : '(无)');
  let aged = false;
  try {
    const Database = require(require('./_paths').serverModulePath('better-sqlite3'));
    const db = new Database(path.join(DATA_DIR, 'printgate.db'));
    db.prepare('UPDATE files SET created_at = ? WHERE id = ?')
      .run(new Date(Date.now() - 40 * 86400000).toISOString(), keepId); // 超过默认 30 天保留期
    db.close();
    aged = true;
  } catch (e) { console.log('  (改时间戳失败：' + e.message + ')'); }
  if (aged) {
    r = await req('POST', '/api/settings/cleanup', {}, ADMIN);
    rec('清理执行成功', r.status === 200, r.data.msg || '');
    const stillThere = keepStored ? fs.existsSync(path.join(filesDir, keepStored)) : false;
    rec('过期文件被物理删除', !!keepStored && !stillThere, keepStored ? `${keepStored.slice(0, 16)}… ${stillThere ? '仍在' : '已删'}` : '');
    const pv2 = await fetch(`${BASE}/api/files/${keepId}/preview`, { headers: { Authorization: `Bearer ${ADMIN}` } });
    rec('清理后管理端预览 410', pv2.status === 404 || pv2.status === 410, `status=${pv2.status}`);
  }

  console.log('\n=== G. 敏感接口不能匿名拿到数据 ===');
  for (const [u, label] of [
    ['/api/settings/backup', '数据库备份'],
    ['/api/users/export', '用户导出'],
    ['/api/audit/export', '审计导出'],
    ['/api/files', '文件列表'],
    ['/api/keys', 'API Key 列表']
  ]) {
    const res = await fetch(BASE + u);
    rec(`${label} 需鉴权`, res.status === 401, `status=${res.status}`);
  }

  const pass = results.filter((x) => x.p).length;
  console.log(`\n===== ${pass}/${results.length} 通过 =====`);
  for (const f2 of results.filter((x) => !x.p)) console.log(`  - ${f2.n} ${f2.d}`);
  if (pass !== results.length) process.exitCode = 1;
})();
