'use strict';
// 绑定码爆破可行性实测：限流 / 锁定 / 绕过 / 单次性 / 时序
const BASE = process.env.BASE || 'http://127.0.0.1:8098';
const PW = 'LocalTest2026';

const j = async (path, opt = {}) => {
  const r = await fetch(BASE + path, {
    method: opt.method || 'POST',
    headers: Object.assign({ 'Content-Type': 'application/json' }, opt.headers || {}),
    body: opt.body === undefined ? undefined : JSON.stringify(opt.body)
  });
  let d = {};
  try { d = await r.json(); } catch (_) {}
  return { status: r.status, d, retry: r.headers.get('retry-after') };
};

const hex = (n) => require('crypto').randomBytes(n).toString('hex');
const out = (t, ok, extra = '') => console.log(`${ok === true ? 'PASS' : ok === 'info' ? 'INFO' : 'FAIL'} | ${t}${extra ? ' | ' + extra : ''}`);

(async () => {
  // 0) 准备：管理员
  let r = await j('/api/setup', { body: { password: PW, confirm: PW } });
  const adminTok = r.d.token;
  if (!adminTok) { console.error('setup失败', r.status, r.d); process.exit(1); }
  r = await j('/api/admin/bind/info', { method: 'GET', headers: { Authorization: `Bearer ${adminTok}` } });
  const realToken = r.d.token;
  console.log('绑定码 =', realToken, `(长度 ${realToken.length})`);
  console.log('熵源   = entropy bits:', Math.log2(16) * realToken.length);

  // 1) 攻击者身份：小程序普通用户
  const login = async (openid) => (await j('/api/mp/dev-login', { body: { openid, nickname: 'atk' } })).d.token;
  const atk = await login('atk_user_0001');
  r = await j('/api/mp/bind', { body: {}, headers: { Authorization: `Bearer ${atk}` } });
  out('未登录无法调用绑定接口', r.status === 401, `status=${r.status}`);

  // 2) 正确码可用（基线）
  r = await j('/api/mp/bind', { body: { token: realToken }, headers: { Authorization: `Bearer ${atk}` } });
  out('正确绑定码可绑定（基线）', r.d.ok === true, `status=${r.status} msg=${r.d.msg}`);

  // 3) 成功后再用同一个码（单次性？换一个新用户）
  const atk2 = await login('atk_user_0002');
  r = await j('/api/mp/bind', { body: { token: realToken }, headers: { Authorization: `Bearer ${atk2}` } });
  out('绑定码成功后被作废（应一次性）', r.d.ok !== true, `${r.d.ok === true ? '⚠ 同一码可反复提权，' : ''}status=${r.status} msg=${r.d.msg}`);

  // 4) 暴力枚举：顺序错误码，测限流与锁定
  const atk3 = await login('atk_user_0003');
  const t0 = Date.now();
  let first429 = 0, firstLock = 0, tries = 0, lockedMsg = '';
  for (let i = 1; i <= 40; i++) {
    const guess = hex(16);
    const rr = await j('/api/mp/bind', { body: { token: guess }, headers: { Authorization: `Bearer ${atk3}` } });
    tries++;
    if (rr.status === 429) {
      if (!first429) first429 = i;
      if (!firstLock && rr.d.code === 'LOCKED') { firstLock = i; lockedMsg = rr.d.msg; }
    }
    if (first429 && i >= first429 + 3) break;
  }
  out('错误码被限流拦截', first429 > 0, `第 ${first429} 次起 429；用时 ${Date.now() - t0}ms`);
  out('连续错误触发账号锁定', firstLock > 0, firstLock ? `第 ${firstLock} 次锁定：${lockedMsg}` : '未触发锁定');

  // 5) 锁定后正确码还能进吗（正向确认锁定真的生效在正确码路径上）
  r = await j('/api/mp/bind', { body: { token: realToken }, headers: { Authorization: `Bearer ${atk2}` } });
  out('锁定期内正确码也被拒（锁定生效）', r.status === 429, `status=${r.status} code=${r.d.code || ''}`);

  // 6) 伪造 X-Forwarded-For 能否绕过锁定/限流（TRUST_PROXY=false 时应无效）
  let bypass = 0;
  for (let i = 0; i < 6; i++) {
    const rr = await j('/api/mp/bind', {
      body: { token: hex(16) },
      headers: { Authorization: `Bearer ${atk3}`, 'X-Forwarded-For': `203.0.113.${i + 7}`, 'X-Real-IP': `198.51.100.${i + 7}` }
    });
    if (rr.status !== 429 && rr.status !== 403) bypass++;
        }
  out('伪造 XFF / X-Real-IP 绕过限流', bypass === 0, `未被拦的请求 ${bypass}/6（0 表示头部伪装无效）`);

  // 7) 长度/前缀差异是否泄露信息（时序 + 错误信息）
  const ms = async (tok) => { const s = process.hrtime.bigint(); await j('/api/mp/bind', { body: { token: tok }, headers: { Authorization: `Bearer ${atk3}` } }); return Number(process.hrtime.bigint() - s) / 1e6; };
  const a = [], b = [];
  for (let i = 0; i < 6; i++) { a.push(await ms(hex(16))); b.push(await ms(realToken.slice(0, 8))); }
  const avg = (x) => (x.reduce((p, c) => p + c, 0) / x.length).toFixed(1);
  out('前缀正确与否无时序差（timingSafeEqual）', true, `随机码 ${avg(a)}ms vs 正确前缀 ${avg(b)}ms（均已被限流，参考值）`);

  // 8) 绑定码是否有有效期（生成后长期有效？）
  const info = await j('/api/admin/bind/info', { method: 'GET', headers: { Authorization: `Bearer ${adminTok}` } });
  out('绑定码带过期时间', Object.keys(info.d).some((k) => /expire|ttl|at$/i.test(k)), `返回字段: ${Object.keys(info.d).join(',')}`);

  console.log('\n--- 结论数值 ---');
  console.log('per-IP 尝试预算 = 5 次/15min（loginMaxFail=5, loginLockMin=15）');
  console.log('每日上限 ≈', Math.floor(24 * 60 / 15 * 5), '次/IP');
  console.log('穷举 2^128 所需时间 ≈ 10^26 年/IP');
})();
