'use strict';
// 竞态专项：并发换头像、并发改资料、并发审批与删除、大数据量分页
// 用法：PG_BASE=http://127.0.0.1:8099 PG_PASS=xxx node tools/race-hunt.js
const fsSync = require('fs');
const path = require('path');
const BASE = process.env.PG_BASE || 'http://127.0.0.1:8099';
const PASS = process.env.PG_PASS || 'LocalTest2026';

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
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

async function newUser(extra = {}) {
  for (let i = 0; i < 4; i++) {
    const d = await req('POST', '/api/mp/dev-login', Object.assign({ openid: `race_${Date.now().toString(36)}_${i}` }, extra));
    if (d.data && d.data.token) return { token: d.data.token, user: d.data.user };
    await sleep(12000); // 限流窗口 60s
  }
  throw new Error('创建用户失败（限流）');
}

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==', 'base64');

(async () => {
  let r = await req('GET', '/api/public/bootstrap');
  let ADMIN = '';
  if (r.data.needsSetup) ADMIN = (await req('POST', '/api/setup', { password: PASS, confirm: PASS })).data.token;
  else ADMIN = (await req('POST', '/api/auth/login', { password: PASS })).data.token;
  if (!ADMIN) { console.log('无法登录'); process.exit(1); }

  console.log('=== A. 并发换头像（会不会裂图） ===');
  const u = await newUser({ nickname: '竞态用户', wechat_id: 'race_wx' });
  await req('POST', `/api/users/${u.user.id}/approve`, {}, ADMIN);
  const up = async (n) => {
    const fd = new FormData();
    fd.append('avatar', new Blob([PNG]), `a${n}.png`);
    const res = await fetch(`${BASE}/api/mp/avatar`, { method: 'POST', headers: { Authorization: `Bearer ${u.token}` }, body: fd });
    return res.json().catch(() => ({}));
  };
  await up(0); // 先有一个基线头像
  const outs = await Promise.all([up(1), up(2), up(3)]);
  rec('并发换头像都返回成功', outs.every((x) => x.user && x.user.avatar), outs.map((x) => (x.user || {}).avatar ? 'ok' : 'fail').join(','));
  await sleep(600);
  const me = await req('GET', '/api/mp/me', undefined, u.token);
  const cur = me.data.user?.avatar || '';
  rec('最终头像字段有值', !!cur, cur);
  const chk = cur ? await fetch(BASE + cur) : { status: 0 };
  rec('最终头像可访问（未裂图）', chk.status === 200, `status=${chk.status}`);

  console.log('\n=== B. 并发改资料（不同字段互相覆盖？） ===');
  const u2 = await newUser({ nickname: '并发资料' });
  await req('POST', `/api/users/${u2.user.id}/approve`, {}, ADMIN);
  await Promise.all([
    req('PUT', '/api/mp/profile', { wechat_id: 'race_a' }, u2.token),
    req('PUT', '/api/mp/profile', { phone: '13800001111' }, u2.token),
    req('PUT', '/api/mp/profile', { apply_note: '并发备注' }, u2.token)
  ]);
  await sleep(500);
  const me2 = await req('GET', '/api/mp/me', undefined, u2.token);
  rec('并发写入的三个字段都在', me2.data.user?.wechat_id === 'race_a' && me2.data.user?.phone === '13800001111' && /并发备注/.test(me2.data.user?.apply_note || ''),
    `wx=${me2.data.user?.wechat_id} phone=${me2.data.user?.phone} note=${me2.data.user?.apply_note}`);

  console.log('\n=== C. 并发审批 + 删除 ===');
  const u3 = await newUser({ nickname: '审批删除' });
  const mix = await Promise.all([
    req('POST', `/api/users/${u3.user.id}/approve`, {}, ADMIN),
    req('POST', `/api/users/${u3.user.id}/approve`, {}, ADMIN),
    req('GET', `/api/users/${u3.user.id}`, undefined, ADMIN)
  ]);
  rec('审批与查询并发不报错', mix.every((x) => x.status < 500), mix.map((x) => x.status).join(','));
  const del = await Promise.all([
    req('DELETE', `/api/users/${u3.user.id}`, undefined, ADMIN),
    req('POST', `/api/users/${u3.user.id}/approve`, {}, ADMIN)
  ]);
  rec('删除与审批并发不 500', del.every((x) => x.status < 500), del.map((x) => x.status).join(','));
  const gone = await req('GET', `/api/users/${u3.user.id}`, undefined, ADMIN);
  rec('删除后查不到', gone.status === 404, `status=${gone.status}`);

  console.log('\n=== D. 大数据量（分页 / 搜索 / 导出） ===');
  if (process.env.PG_BIG === '1') {
    // 直接灌库，绕开 dev-login 的 20 次/分钟限流（只对本地库有效）
    let inserted = 0;
    try {
      const Database = require(require('./_paths').serverModulePath('better-sqlite3'));
      const dbPath = [process.env.PG_DB, path.join(__dirname, '..', '_data_final', 'printgate.db'), path.join(__dirname, '..', '_data', 'printgate.db')]
        .filter(Boolean).find((p) => fsSync.existsSync(p));
      const db = new Database(dbPath);
      const ins = db.prepare("INSERT INTO users (openid, nickname, wechat_id, phone, role, status, created_at) VALUES (?,?,?,?, 'user', 'pending', ?)");
      const now = new Date().toISOString();
      for (let i = 0; i < 200; i++) {
        ins.run(`big_${Date.now().toString(36)}_${i}`, `压测${i}`, `big_wx_${i}`, `139${String(i).padStart(8, '0')}`, now);
        inserted++;
      }
      db.close();
    } catch (e) { console.log('  (灌库失败：' + e.message + ')'); }
    console.log(`  已灌入 ${inserted} 个用户`);
    await sleep(500);
    r = await req('GET', '/api/users?status=all&size=20&page=6', undefined, ADMIN);
    rec('第 6 页有数据', r.status === 200 && (r.data.users || []).length > 0, `${(r.data.users || []).length} 条 / 共 ${r.data.total}`);
    r = await req('GET', '/api/users?status=all&size=200&q=big_wx_1', undefined, ADMIN);
    rec('大数据量下搜索可用', r.status === 200 && (r.data.users || []).length > 0, `${(r.data.users || []).length} 条`);
    const t0 = Date.now();
    const exp = await fetch(`${BASE}/api/users/export?status=all`, { headers: { Authorization: `Bearer ${ADMIN}` } });
    const csv = await exp.text();
    rec('导出大数据量 CSV', exp.status === 200 && csv.split('\r\n').length > 50, `${csv.split('\r\n').length} 行，${Date.now() - t0}ms`);
  } else {
    console.log('  (跳过：需要 PG_BIG=1 才会灌 200 个用户)');
  }

  const pass = results.filter((x) => x.p).length;
  console.log(`\n===== ${pass}/${results.length} 通过 =====`);
  for (const f of results.filter((x) => !x.p)) console.log(`  - ${f.n} ${f.d}`);
  if (pass !== results.length) process.exitCode = 1;
})();
