'use strict';
// 补充：TRUST_PROXY 场景下的头部伪装绕过 + 输入格式边界（需干净实例）
const BASE = process.env.BASE || 'http://127.0.0.1:8100';
const PW = 'LocalTest2026';
const hex = (n) => require('crypto').randomBytes(n).toString('hex');
const j = async (p, o = {}) => {
  const r = await fetch(BASE + p, {
    method: o.method || 'POST',
    headers: Object.assign({ 'Content-Type': 'application/json' }, o.headers || {}),
    body: o.body === undefined ? undefined : JSON.stringify(o.body)
  });
  let d = {}; try { d = await r.json(); } catch (_) {}
  return { status: r.status, d };
};

(async () => {
  let r = await j('/api/setup', { body: { password: PW, confirm: PW } });
  const adminTok = r.d.token || (await j('/api/auth/login', { body: { password: PW } })).d.token;
  const H = { Authorization: `Bearer ${adminTok}` };
  const real = (await j('/api/admin/bind/info', { method: 'GET', headers: H })).d.token;
  const atk = (await j('/api/mp/dev-login', { body: { openid: 'spoof_user_01' } })).d.token;
  const A = { Authorization: `Bearer ${atk}` };

  // 1) TRUST_PROXY=true 时，伪造 XFF 每次换 IP → 锁定是否还能生效
  const seq = [];
  for (let i = 0; i < 10; i++) {
    const rr = await j('/api/mp/bind', {
      body: { token: hex(16) },
      headers: { ...A, 'X-Forwarded-For': `198.51.100.${i + 1}` }
    });
    seq.push(`${i + 1}:${rr.status}${rr.d.code ? '/' + rr.d.code : ''}`);
  }
  const blocked = seq.filter((s) => s.includes('429')).length;
  console.log(`1 TRUST_PROXY=true 下换 XFF 连打 10 次: ${seq.join(' ')}`);
  console.log(`  → 被拦次数 ${blocked}/10，${blocked === 0 ? '⚠ 完全可绕过（限流形同虚设）' : '仍有限制'}`);

  // 2) 锁被绕过时，正确码仍可提权（说明绕过=实际可利用）
  r = await j('/api/mp/bind', { body: { token: real }, headers: { ...A, 'X-Forwarded-For': '198.51.100.200' } });
  console.log(`2 绕过限流后正确码: status=${r.status} ok=${r.d.ok}`);

  // 3) 输入格式边界（干净 IP：随机 XFF 各自独立计数）
  for (const [label, tok] of [
    ['空串', ''],
    ['超短', 'x'],
    ['超长(4096)', 'a'.repeat(4096)],
    ['大小写变体(正确码转大写)', real.toUpperCase()],
    ['尾部空格', real + '   '],
    ['尾部NUL', real + '\u0000'],
    ['对象注入', { $ne: null }],
    ['数组注入', [real]],
    ['十六进制转Base64', Buffer.from(real, 'hex').toString('base64')]
  ]) {
    const rr = await j('/api/mp/bind', { body: { token: tok }, headers: { ...A, 'X-Forwarded-For': `192.0.2.${Math.floor(Math.random() * 200) + 1}` } });
    console.log(`3 ${label}: status=${rr.status} ok=${rr.d.ok}`);
  }
})();
