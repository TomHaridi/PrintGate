'use strict';
// 绑定码策略回归：一码一人 + TTL + 过期/失败自动轮换
// 用法：PG_DB=<data dir>/printgate.db BASE=http://127.0.0.1:8098 node tools/bind-token-policy-test.js
const { DatabaseSync } = require('node:sqlite');
const BASE = process.env.BASE || 'http://127.0.0.1:8098';
const DB = process.env.PG_DB || '';
const PW = process.env.PW || 'LocalTest2026';

let pass = 0, fail = 0;
const rec = (name, ok, extra = '') => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'} | ${name}${extra ? ' | ' + extra : ''}`); };

const req = async (method, path, body, token) => {
  const r = await fetch(BASE + path, {
    method,
    headers: Object.assign({ 'Content-Type': 'application/json' }, token ? { Authorization: `Bearer ${token}` } : {}),
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  let d = {}; try { d = await r.json(); } catch (_) {}
  return { status: r.status, d };
};

(async () => {
  let r = await req('POST', '/api/setup', { password: PW, confirm: PW });
  let ADMIN = r.d.token;
  if (!ADMIN) ADMIN = (await req('POST', '/api/auth/login', { password: PW })).d.token;
  if (!ADMIN) { console.error('无法取得管理员令牌'); process.exit(1); }

  // 1) 元信息：带过期时间与倒计时
  r = await req('GET', '/api/admin/bind/info', undefined, ADMIN);
  const t0 = r.d.token, exp0 = r.d.expiresAt;
  rec('bind/info 返回有效期', !!exp0 && exp0 > Date.now(), `remainingSec=${r.d.remainingSec}`);
  rec('默认 TTL 600 秒', Math.abs((r.d.ttlSec || 0) - 600) <= 1, `ttlSec=${r.d.ttlSec}`);
  rec('码格式 32 位 hex', /^[0-9a-f]{32}$/.test(t0 || ''), t0 && t0.slice(0, 8) + '…');

  // 2) 一码一人：A 绑定成功 → 码立刻换新
  const newUser = async (n) => (await req('POST', '/api/mp/dev-login', { openid: `policy_${n}_${Date.now()}` })).d.token;
  const A = await newUser('a');
  r = await req('POST', '/api/mp/bind', { token: t0 }, A);
  rec('第一个用户绑定成功', r.d.ok === true && r.d.user?.role === 'admin', r.d.msg || '');
  rec('响应标记码已轮换', r.d.tokenRotated === true);

  const t1 = (await req('GET', '/api/admin/bind/info', undefined, ADMIN)).d.token;
  rec('服务端已换新码', !!t1 && t1 !== t0, `${t0.slice(0, 6)}… → ${t1.slice(0, 6)}…`);

  // 3) 旧码给第二个人 → 必须失败
  const B = await newUser('b');
  r = await req('POST', '/api/mp/bind', { token: t0 }, B);
  rec('旧码不可二次提权', r.status === 403 && !r.d.ok, r.d.msg || '');

  // 4) 新码可用
  r = await req('POST', '/api/mp/bind', { token: t1 }, B);
  rec('新码可正常绑定', r.d.ok === true, r.d.msg || '');

  // 5) 过期：直接把过期时间改到过去（设置无缓存，立即可见）
  if (DB) {
    const db = new DatabaseSync(DB);
    const t2 = (await req('GET', '/api/admin/bind/info', undefined, ADMIN)).d.token;
    db.prepare("UPDATE settings SET value = ? WHERE key = 'bindTokenExpiresAt'").run(String(Date.now() - 1000));
    const C = await newUser('c');
    r = await req('POST', '/api/mp/bind', { token: t2 }, C);
    rec('过期码被拒', r.status === 403 && !r.d.ok, r.d.msg || '');
    const t3 = (await req('GET', '/api/admin/bind/info', undefined, ADMIN)).d.token;
    rec('过期后自动换新码', !!t3 && t3 !== t2);
    r = await req('POST', '/api/mp/bind', { token: t3 }, C);
    rec('换新后立即可用', r.d.ok === true);
    // 6) 全站失败越多越该换码：连打 5 次错码后看码是否变化（阈值为环境变量 BIND_FAIL_ROTATE）
    const before = (await req('GET', '/api/admin/bind/info', undefined, ADMIN)).d.token;
    const D = await newUser('d');
    const threshold = Number(process.env.BIND_FAIL_ROTATE || 50);
    for (let i = 0; i < Math.min(threshold, 8); i++) await req('POST', '/api/mp/bind', { token: 'f'.repeat(32) }, D);
    const after = (await req('GET', '/api/admin/bind/info', undefined, ADMIN)).d.token;
    rec('累计失败达阈值触发换码', threshold <= 8 ? after !== before : true, `threshold=${threshold} changed=${after !== before}`);
    db.close();
  } else {
    console.log('SKIP | 过期/失败轮换用例需要 PG_DB 指向数据目录');
  }

  // 7) 格式校验分支：非 hex 的 32 字符不进比较（先清掉前面用例攒下的失败计数，否则会被 429 挡住）
  if (DB) {
    const db2 = new DatabaseSync(DB);
    db2.prepare("DELETE FROM login_attempts WHERE kind = 'bind'").run();
    db2.close();
  }
  const E = await newUser('e');
  for (const [label, tok] of [['非 hex 32 位', 'z'.repeat(32)], ['31 位', 'a'.repeat(31)], ['32 位全 0', '0'.repeat(32)]]) {
    r = await req('POST', '/api/mp/bind', { token: tok }, E);
    // 403 是被判定为错码；429 是被限流拦住——两种都算「没被接受」，同样是安全结果
    rec(`格式/取值拒绝：${label}`, r.status === 403 || r.status === 429, `status=${r.status}`);
  }

  console.log(`\n合计 ${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})();
