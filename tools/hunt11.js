'use strict';
// 第十一轮定向测试：验证两个真实修复
//   A) 审计日志无限增长 → 手动/自动清理现可裁剪 audit 表（默认保留 180 天）
//   B) 扫描并发锁缺失 → 已有扫描进行中时再次启动返回 409
//
// 用法：node tools/hunt11.js
// 依赖：server 模块（better-sqlite3 等已 npm install），本地 8098 服务已启动并加载新代码。
const path = require('path');

const BASE = process.env.PG_BASE || 'http://127.0.0.1:8098';
const PASS = process.env.PG_PASS || 'LocalTest2026';

const root = path.resolve(__dirname, '..');
const sec = require(path.join(root, 'server/src/security'));
const dbMod = require(path.join(root, 'server/src/db'));
const db = dbMod.db;

// 直写管理员密码（与服务端共用同一 settings，登录即可拿到合法 JWT）
sec.setAdminPassword(PASS);

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  \u2713 ${name} ${extra}`); }
  else { fail++; console.log(`  \u2717 ${name} ${extra}`); }
};
const api = async (method, p, body) => {
  const r = await fetch(BASE + '/api' + p, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + TOKEN },
    body: body ? JSON.stringify(body) : undefined
  });
  let j = null; try { j = await r.json(); } catch (_) {}
  return { status: r.status, j };
};

let TOKEN = '';

(async () => {
  // 拿到合法令牌
  const lr = await fetch(BASE + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: PASS })
  });
  const lj = await lr.json().catch(() => ({}));
  if (!lj.ok) { console.error('登录失败:', lj); process.exit(2); }
  TOKEN = lj.token;

  // 清理上一次残留的测试行，保证幂等
  db.prepare("DELETE FROM audit WHERE action IN ('hunt11_old','hunt11_recent')").run();

  console.log('=== [A] 审计日志无限增长修复 ===');
  const oldTs = new Date(Date.now() - 400 * 86400000).toISOString();
  const recentTs = new Date(Date.now() - 1 * 86400000).toISOString();
  for (let i = 0; i < 5; i++) db.prepare("INSERT INTO audit (actor,action,detail,ip,created_at) VALUES ('system','hunt11_old','', '', ?)").run(oldTs);
  for (let i = 0; i < 3; i++) db.prepare("INSERT INTO audit (actor,action,detail,ip,created_at) VALUES ('system','hunt11_recent','', '', ?)").run(recentTs);
  ok('插入测试审计数据', db.prepare("SELECT COUNT(*) c FROM audit WHERE action='hunt11_old'").get().c === 5
    && db.prepare("SELECT COUNT(*) c FROM audit WHERE action='hunt11_recent'").get().c === 3,
    `old=${db.prepare("SELECT COUNT(*) c FROM audit WHERE action='hunt11_old'").get().c} recent=${db.prepare("SELECT COUNT(*) c FROM audit WHERE action='hunt11_recent'").get().c}`);

  // 手动清理：保留全部历史(days=3650)，仅裁剪 180 天前的审计
  const r = await api('POST', '/printers/history/clean', { days: 3650, targets: ['files'], auditDays: 180 });
  ok('clean 接口 200', r.status === 200 && r.j && r.j.ok === true, `status=${r.status} msg=${r.j && r.j.msg}`);
  ok('180 天前审计被裁剪', db.prepare("SELECT COUNT(*) c FROM audit WHERE action='hunt11_old'").get().c === 0,
    `left=${db.prepare("SELECT COUNT(*) c FROM audit WHERE action='hunt11_old'").get().c}`);
  ok('近期审计被保留', db.prepare("SELECT COUNT(*) c FROM audit WHERE action='hunt11_recent'").get().c === 3,
    `left=${db.prepare("SELECT COUNT(*) c FROM audit WHERE action='hunt11_recent'").get().c}`);

  // auditDays=0 不应裁剪
  const before = db.prepare("SELECT COUNT(*) c FROM audit WHERE action='hunt11_recent'").get().c;
  const r2 = await api('POST', '/printers/history/clean', { days: 3650, targets: ['files'], auditDays: 0 });
  ok('auditDays=0 不裁剪审计', r2.status === 200 && db.prepare("SELECT COUNT(*) c FROM audit WHERE action='hunt11_recent'").get().c === before);

  // 清理本次测试行
  db.prepare("DELETE FROM audit WHERE action IN ('hunt11_old','hunt11_recent')").run();

  console.log('=== [B] 扫描并发锁修复 ===');
  // 带一个不可达的 /32 地址，强制扫描保持 running 状态约 0.9s，便于稳定触发并发锁
  const PROBE_CIDR = '10.255.255.1/32';
  // 并发发起两次启动，第二次应命中 409（已有扫描进行中）
  const [a, b] = await Promise.all([
    api('POST', '/printers/discover/start', { mode: 'quick', cidr: PROBE_CIDR }),
    api('POST', '/printers/discover/start', { mode: 'quick', cidr: PROBE_CIDR })
  ]);
  const codes = [a.status, b.status];
  const ids = [a.j && a.j.id, b.j && b.j.id];
  ok('并发启动至少一次 409（锁生效）', codes.includes(409), `codes=${codes}`);
  ok('至少一次 200（成功启动）', codes.includes(200), `codes=${codes}`);
  const startedId = ids.find((x, i) => codes[i] === 200);

  if (startedId) {
    let done = false;
    for (let i = 0; i < 40; i++) {
      const s = await api('GET', `/printers/discover/${startedId}`);
      if (s.j && s.j.status && s.j.status !== 'running') { done = true; break; }
      await new Promise((r) => setTimeout(r, 500));
    }
    const c = await api('POST', '/printers/discover/start', { mode: 'quick' });
    ok('上一次完成后可再次启动', c.status === 200, `status=${c.status} prevDone=${done}`);
  } else {
    ok('上一次完成后可再次启动', false, '未捕获到成功启动的会话');
  }

  console.log(`\n结果：通过 ${pass} / 失败 ${fail}`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('hunt11 异常:', e); process.exit(2); });
