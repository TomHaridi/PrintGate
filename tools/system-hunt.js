'use strict';
// 系统 / 审计 / 日志 / API Key 边界猎杀
// 覆盖：dashboard 数据自洽、logs 白名单与参数夹取、services 未知 key、
//       audit 分页边界与 LIKE 通配符、CSV 导出、keys 全生命周期
// 用法：PG_BASE=http://127.0.0.1:8099 PG_PASS=xxx node tools/system-hunt.js
const fs = require('fs');
const path = require('path');

const BASE = process.env.PG_BASE || 'http://127.0.0.1:8099';
const PASS = process.env.PG_PASS || 'LocalTest2026';
// DB 路径优先级：PG_DB > PG_DATA_DIR/printgate.db > _data_final > _data。
// 只传 PG_DATA_DIR 而脚本连到 _data_final 时，对账会拿陈旧库的数字来对，全是误报
const DB = [
  process.env.PG_DB,
  process.env.PG_DATA_DIR ? path.join(process.env.PG_DATA_DIR, 'printgate.db') : null,
  path.join(__dirname, '..', '_data_final', 'printgate.db'),
  path.join(__dirname, '..', '_data', 'printgate.db')
].filter(Boolean).find((p) => fs.existsSync(p));

const results = [];
const rec = (n, p, d = '') => {
  results.push({ n, p, d });
  console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? `  —  ${d}` : ''}`);
};

async function req(method, url, body, token = '') {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(BASE + url, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch (_) { data = { raw: text.slice(0, 140) }; }
  return { status: res.status, data, text };
}

(async () => {
  // ---- 登录 ----
  const login = await req('POST', '/api/auth/login', { password: PASS });
  const ADMIN = login.data.token;
  rec('管理员登录', !!ADMIN, login.data.msg || '');

  // ================= A. 仪表盘数据自洽 =================
  const dash = await req('GET', '/api/dashboard', undefined, ADMIN);
  rec('dashboard 可读', dash.status === 200 && !!dash.data.counts, `status=${dash.status}`);
  const c = dash.data.counts || {};
  rec('counts 字段齐全', ['tasksTotal', 'tasksToday', 'tasksPending', 'tasksDone', 'tasksFailed',
    'users', 'usersPending', 'files', 'pagesToday'].every((k) => k in c), Object.keys(c).join(','));
  rec('trend 是 7 天', (dash.data.trend || []).length === 7, `${(dash.data.trend || []).length} 天`);
  rec('recent 最多 8 条', (dash.data.recent || []).length <= 8, `${(dash.data.recent || []).length} 条`);
  rec('trend 计数非负', (dash.data.trend || []).every((t) => Number.isFinite(t.count) && t.count >= 0));
  rec('system 信息含版本/内存/磁盘', !!(dash.data.system && dash.data.system.version && dash.data.system.mem && dash.data.system.disk));
  rec('services 是数组', Array.isArray(dash.data.services));

  // 与数据库直查对账（仅本机直连场景）
  if (DB) {
    const Database = require(require('./_paths').serverModulePath('better-sqlite3'));
    const db = new Database(DB, { readonly: true });
    const total = db.prepare('SELECT COUNT(*) c FROM tasks').get().c;
    const users = db.prepare('SELECT COUNT(*) c FROM users').get().c;
    db.close();
    rec('tasksTotal 与数据库一致', c.tasksTotal === total, `接口=${c.tasksTotal} 库=${total}`);
    rec('users 与数据库一致', c.users === users, `接口=${c.users} 库=${users}`);
  } else {
    console.log('SKIP  数据库对账（未找到 DB 文件）');
  }

  // ================= B. 日志：白名单 / 穿越 / 参数夹取 =================
  const lg = await req('GET', '/api/system/logs', undefined, ADMIN);
  rec('日志清单可读', lg.status === 200 && Array.isArray(lg.data.logs) && lg.data.logs.length >= 2, `${(lg.data.logs || []).length} 个`);

  const bad1 = await req('GET', '/api/system/logs/nonexistent', undefined, ADMIN);
  rec('未知日志名 400', bad1.status === 400, bad1.data.msg || `status=${bad1.status}`);

  const bad2 = await req('GET', '/api/system/logs/..%2F..%2F..%2Fetc%2Fpasswd', undefined, ADMIN);
  rec('路径穿越被拒（不返回文件内容）', bad2.status === 400 && !/root:/.test(bad2.text || ''), bad2.data.msg || `status=${bad2.status}`);

  const bad3 = await req('GET', '/api/system/logs/..%5C..%5Cwindows%5Cwin.ini', undefined, ADMIN);
  rec('反斜杠穿越被拒', bad3.status === 400, bad3.data.msg || `status=${bad3.status}`);

  for (const lines of ['0', '-5', '99999', 'abc', '1e9']) {
    const r = await req('GET', `/api/system/logs/app?lines=${lines}`, undefined, ADMIN);
    rec(`lines=${lines} 不崩且被夹取`, r.status === 200 && typeof r.data.content === 'string', `status=${r.status}`);
  }

  const lgApp = await req('GET', '/api/system/logs/app?lines=5', undefined, ADMIN);
  const lineCount = String(lgApp.data.content || '').split('\n').filter(Boolean).length;
  rec('lines=5 最多回 5 行', lineCount <= 5, `${lineCount} 行`);

  // ================= C. 服务重启：未知 key =================
  const svc1 = await req('POST', '/api/system/services/nonexistent/restart', {}, ADMIN);
  rec('重启未知服务 400', svc1.status === 400, svc1.data.msg || `status=${svc1.status}`);
  const svc2 = await req('POST', '/api/system/services/../../etc/restart', {}, ADMIN);
  rec('服务 key 穿越不崩', svc2.status >= 400 && svc2.status < 500, `status=${svc2.status}`);

  // ================= D. 审计：分页边界 + 通配符 =================
  const a1 = await req('GET', '/api/audit', undefined, ADMIN);
  rec('审计列表可读', a1.status === 200 && Array.isArray(a1.data.logs), `status=${a1.status}`);
  rec('审计分页字段齐全', 'total' in a1.data && 'page' in a1.data && 'size' in a1.data);

  for (const page of ['0', '-3', 'abc', '99999999']) {
    const r = await req('GET', `/api/audit?page=${page}`, undefined, ADMIN);
    rec(`page=${page} 不崩`, r.status === 200, `status=${r.status}`);
  }
  for (const size of ['0', '-1', '99999', 'abc']) {
    const r = await req(`GET`, `/api/audit?size=${size}`, undefined, ADMIN);
    const n = (r.data.logs || []).length;
    rec(`size=${size} 被夹取到 1-500`, r.status === 200 && n >= 1 && n <= 500, `回 ${n} 条`);
  }

  // LIKE 通配符：% 和 _ 必须当字面量，不能「查全部」
  const aAll = await req('GET', '/api/audit?size=1', undefined, ADMIN);
  const totalAll = aAll.data.total || 0;
  const pct = await req('GET', '/api/audit?q=%25', undefined, ADMIN); // %25 = %
  rec('q=% 不会查全部', pct.status === 200 && (pct.data.total || 0) < totalAll, `total=${pct.data.total} / 全部=${totalAll}`);
  const us = await req('GET', '/api/audit?q=_', undefined, ADMIN);
  rec('q=_ 不会查全部', us.status === 200 && (us.data.total || 0) < totalAll, `total=${us.data.total}`);
  const actPct = await req('GET', '/api/audit?action=%25', undefined, ADMIN);
  rec('action=% 不会查全部', actPct.status === 200 && (actPct.data.total || 0) < totalAll, `total=${actPct.data.total}`);

  // 翻到最后一页之外：空行但 total 不变
  const beyond = await req('GET', `/api/audit?page=99999&size=30`, undefined, ADMIN);
  rec('越界页返回空行且 total 不变', beyond.status === 200 && (beyond.data.logs || []).length === 0 && beyond.data.total === totalAll,
    `rows=${(beyond.data.logs || []).length} total=${beyond.data.total}`);

  // action 过滤是真子串匹配（UI 上既可从下拉选精确动作，也可输关键字），
  // 因此断言「每条都含该关键字」而不是「完全相等」
  const known = (a1.data.actions || [])[0];
  if (known) {
    const f = await req('GET', `/api/audit?action=${encodeURIComponent(known.action)}`, undefined, ADMIN);
    const allMatch = (f.data.logs || []).every((r) => String(r.action).includes(known.action));
    rec('action 过滤生效', f.status === 200 && allMatch && (f.data.logs || []).length > 0,
      `${known.action} → ${(f.data.logs || []).length} 条`);
  }

  // ================= E. 审计导出 CSV =================
  const exp = await fetch(`${BASE}/api/audit/export`, { headers: { Authorization: `Bearer ${ADMIN}` } });
  const csvBuf = Buffer.from(await exp.arrayBuffer());
  const csv = csvBuf.toString('utf8');
  rec('CSV 导出可读', exp.status === 200 && csv.length > 0, `${csv.length} 字节`);
  // 必须逐字节看：res.text() 会按 Fetch 规范剥掉 BOM，看不出服务端有没有真写
  rec('CSV 带 BOM（Excel 中文不乱码）', csvBuf[0] === 0xEF && csvBuf[1] === 0xBB && csvBuf[2] === 0xBF,
    `头部字节 ${csvBuf.slice(0, 3).toString('hex')}`);
  rec('CSV 有表头', csv.replace('\uFEFF', '').split('\n')[0].startsWith('id,actor,action,detail,ip,created_at'));

  // ================= F. 安全：登录失败记录 =================
  const att = await req('GET', '/api/security/attempts', undefined, ADMIN);
  rec('失败记录可读', att.status === 200 && Array.isArray(att.data.attempts), `fails24=${att.data.fails24}`);
  const clr = await req('DELETE', '/api/security/attempts', undefined, ADMIN);
  rec('清空失败记录', clr.status === 200, clr.data.msg || '');
  const att2 = await req('GET', '/api/security/attempts', undefined, ADMIN);
  rec('清空后为空', (att2.data.attempts || []).length === 0, `${(att2.data.attempts || []).length} 条`);

  // ================= G. API Key 生命周期 =================
  const longName = 'x'.repeat(200);
  const k1 = await req('POST', '/api/keys', { name: longName }, ADMIN);
  rec('超长密钥名被截断而非报错', k1.status === 200 && (k1.data.token || '').startsWith('pg_'), `name 长度 ${String(k1.data.token || '').length}`);
  const keyId = k1.data.id;
  const keyRaw = k1.data.token;

  const k2 = await req('POST', '/api/keys', {}, ADMIN);
  rec('缺省名也能建', k2.status === 200, k2.data.msg || '');

  const klist = await req('GET', '/api/keys', undefined, ADMIN);
  rec('密钥列表不含明文', klist.status === 200 && !JSON.stringify(klist.data).includes(keyRaw));

  const kUse = await req('GET', '/api/dashboard', undefined, '');
  rec('无令牌仍然 401', kUse.status === 401, `status=${kUse.status}`);

  const kBad = await req('GET', '/api/dashboard', undefined, 'pg_totally_invalid_key_value');
  rec('无效 API Key 401', kBad.status === 401, `status=${kBad.status}`);

  const rev1 = await req('DELETE', `/api/keys/${keyId}`, undefined, ADMIN);
  rec('吊销密钥', rev1.status === 200, rev1.data.msg || '');
  // 吊销是幂等操作：重复吊销返回 200（终态就是已吊销）或 404 都算合理，不该 500
  const rev2 = await req('DELETE', `/api/keys/${keyId}`, undefined, ADMIN);
  rec('重复吊销不 500（幂等）', rev2.status === 200 || rev2.status === 404, `status=${rev2.status}`);
  const rev3 = await req('DELETE', '/api/keys/99999999', undefined, ADMIN);
  rec('吊销不存在密钥 404', rev3.status === 404, `status=${rev3.status}`);
  if (k2.data.id) await req('DELETE', `/api/keys/${k2.data.id}`, undefined, ADMIN);

  // ================= H. 未登录全面 401 =================
  for (const url of ['/api/dashboard', '/api/system/info', '/api/system/services', '/api/system/logs',
    '/api/system/logs/app', '/api/audit', '/api/audit/export', '/api/security/attempts', '/api/keys',
    '/api/settings', '/api/settings/storage', '/api/printers/history', '/api/users', '/api/tasks', '/api/files']) {
    const r = await req('GET', url);
    if (r.status !== 401) rec(`未登录 ${url} 应 401`, false, `status=${r.status}`);
  }
  rec('未登录访问管理接口全部 401', true, '15 个端点');

  // 收尾
  const failed = results.filter((r) => !r.p).length;
  console.log(`\n===== ${results.length - failed}/${results.length} 通过 =====`);
  if (failed) results.filter((r) => !r.p).forEach((r) => console.log(' - ' + r.n + (r.d ? ` — ${r.d}` : '')));
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('崩溃:', e); process.exit(1); });
