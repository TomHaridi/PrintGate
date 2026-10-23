'use strict';
// 绑定码安全补充验证：403来源 / 待审用户可用性 / 精确锁定阈值 / 重生成失效 / TRUST_PROXY 绕过
const BASE = process.env.BASE || 'http://127.0.0.1:8098';
const PW = 'LocalTest2026';
const hex = (n) => require('crypto').randomBytes(n).toString('hex');

const j = async (path, opt = {}) => {
  const r = await fetch(BASE + path, {
    method: opt.method || 'POST',
    headers: Object.assign({ 'Content-Type': 'application/json' }, opt.headers || {}),
    body: opt.body === undefined ? undefined : JSON.stringify(opt.body)
  });
  let d = {}; try { d = await r.json(); } catch (_) {}
  return { status: r.status, d };
};

(async () => {
  let r = await j('/api/setup', { body: { password: PW, confirm: PW } });
  const admin = r.d.token;
  if (!admin) { // 已初始化则登录
    r = await j('/api/auth/login', { body: { password: PW } });
    var adminTok = r.d.token;
  } else var adminTok = admin;
  const H = { Authorization: `Bearer ${adminTok}` };
  const realToken = (await j('/api/admin/bind/info', { method: 'GET', headers: H })).d.token;

  // A) 无令牌调用：真实状态码与信息
  r = await j('/api/mp/bind', { body: { token: realToken } });
  console.log(`A 无令牌: status=${r.status} msg=${r.d.msg} code=${r.d.code || '-'}  ← 正确码在未登录时是否被消费: ${r.d.ok ? '是(危险)' : '否'}`);

  // B) 待审批/被拒用户能否尝试绑定（只需登录态即可）
  const pending = (await j('/api/mp/dev-login', { body: { openid: 'pending_user_01' } })).d.token;
  r = await j('/api/mp/bind', { body: { token: realToken }, headers: { Authorization: `Bearer ${pending}` } });
  console.log(`B 待审用户绑定: status=${r.status} ok=${r.d.ok} role=${r.d.user?.role} status_=${r.d.user?.status} msg=${r.d.msg}`);

  // C) 旧码在「重新生成」后是否立刻失效
  const newTok = (await j('/api/admin/bind/regenerate', { headers: H })).d.token;
  r = await j('/api/mp/bind', { body: { token: realToken }, headers: { Authorization: `Bearer ${pending}` } });
  console.log(`C 重生成后旧码: status=${r.status} ok=${r.d.ok} msg=${r.d.msg}  (新码前8位 ${newTok.slice(0, 8)}…)`);

  // D) 精确锁定阈值：新 server / 干净 IP 下逐次记录
  const atk = (await j('/api/mp/dev-login', { body: { openid: 'atk_brute_01' } })).d.token;
  const seq = [];
  for (let i = 1; i <= 8; i++) {
    const rr = await j('/api/mp/bind', { body: { token: hex(16) }, headers: { Authorization: `Bearer ${atk}` } });
    seq.push(`${i}:${rr.status}${rr.d.code ? '/' + rr.d.code : ''}`);
  }
  console.log('D 错误码连击序列:', seq.join(' '));

  // E) 锁定期内正确码：被拒（跨用户共享同一 IP 锁）
  const other = (await j('/api/mp/dev-login', { body: { openid: 'innocent_01' } })).d.token;
  r = await j('/api/mp/bind', { body: { token: newTok }, headers: { Authorization: `Bearer ${other}` } });
  console.log(`E 他人携带正确码、锁定期内: status=${r.status} code=${r.d.code || '-'} msg=${r.d.msg}`);

  // F) 绑定码长度/字符集是否被校验（弱格式防御）
  r = await j('/api/mp/bind', { body: { token: 'x' }, headers: { Authorization: `Bearer ${other}` } });
  console.log(`F 超短码: status=${r.status} msg=${r.d.msg}`);
  r = await j('/api/mp/bind', { body: { token: realToken + '\u0000' }, headers: { Authorization: `Bearer ${other}` } });
  console.log(`F 尾部NUL注入: status=${r.status} msg=${r.d.msg}`);
  r = await j('/api/mp/bind', { body: { token: { $ne: null } }, headers: { Authorization: `Bearer ${other}` } });
  console.log(`F 对象注入($ne): status=${r.status} msg=${r.d.msg}`);
})();
