'use strict';
// 扫码绑定链路回归：票据生成/越权/过期/合并/解绑
// 用法：BASE=http://127.0.0.1:8137 PW=LocalTest2026 node tools/bind-flow-test.js
const BASE = process.env.BASE || 'http://127.0.0.1:8137';
const PW = process.env.PW || 'LocalTest2026';
let pass = 0, fail = 0;
const bugs = [];
const rec = (n, ok, d = '') => {
  ok ? pass++ : (fail++, bugs.push(`${n}${d ? ' — ' + d : ''}`));
  console.log(`${ok ? 'PASS' : 'FAIL'} | ${n}${d ? ' | ' + d : ''}`);
};

const j = async (m, p, b, t) => {
  const h = {};
  if (t) h.Authorization = 'Bearer ' + t;
  if (b !== undefined) h['Content-Type'] = 'application/json';
  const r = await fetch(BASE + p, { method: m, headers: h, body: b === undefined ? undefined : JSON.stringify(b) });
  const raw = await r.text();
  let d = {};
  try { d = JSON.parse(raw); } catch (_) {}
  return { s: r.status, d, raw };
};

// dev-login 有 20 次/分钟限流；测试连跑时撞到 429 就等一会儿重试
const devLogin = async (body) => {
  for (let i = 0; i < 4; i++) {
    const r = await j('POST', '/api/mp/dev-login', body);
    if (r.s !== 429) return r;
    await new Promise((res) => setTimeout(res, 20000));
  }
  return { s: 429, d: { msg: "dev-login 被限流" } };
};

(async () => {
  const ADM = (await j('POST', '/api/auth/login', { password: PW })).d.token;
  rec('管理员登录', !!ADM);

  const stamp = Date.now().toString(36);
  // 目标账号：账号密码用户（后台"已有账号"）
  const uname = 'bt_' + stamp;
  const target = await j('POST', '/api/auth/account/register', { username: uname, password: 'Passw0rd123', confirm: 'Passw0rd123', nickname: '绑定目标' });
  const tid = target.d.user.id;
  await j('POST', `/api/users/${tid}/approve`, {}, ADM);

  // 微信账号先建好：dev-login 有 20 次/分钟限流，避免中途 429 把断言带偏
  const wxA = await devLogin({ openid: 'wx_bt_a_' + stamp, nickname: '微信甲' });
  const wxP = await devLogin({ openid: 'wx_bt_p_' + stamp, nickname: '待审批甲' });
  rec('准备微信账号', !!wxA.d.token && !!wxP.d.token, `a=${wxA.s} p=${wxP.s}`);

  // ---------- 票据生成 ----------
  let r = await j('POST', `/api/users/${tid}/bind-qr`, {}, ADM);
  rec('生成绑定二维码', r.s === 200 && !!r.d.ticket && String(r.d.qr).startsWith('data:image/'), `qr 长度 ${(r.d.qr || '').length}`);
  const t1 = r.d.ticket;

  // 重复生成：旧票应作废
  r = await j('POST', `/api/users/${tid}/bind-qr`, {}, ADM);
  const t2 = r.d.ticket;
  rec('重复生成会换新票', t1 !== t2);

  // 旧票作废（用微信账号试旧票）
  await j('POST', `/api/users/${wxA.d.user.id}/approve`, {}, ADM);
  r = await j('POST', '/api/mp/bind-user', { ticket: t1 }, wxA.d.token);
  rec('旧票已作废', r.s === 404 || r.s === 409 || r.s === 410, `status=${r.s} ${r.d.msg || ''}`);

  // ---------- 越权 ----------
  r = await j('POST', `/api/users/${tid}/bind-qr`, {}, wxA.d.token);
  rec('普通用户不能生成绑定码', r.s === 401 || r.s === 403, `status=${r.s}`);
  r = await j('GET', `/api/users/${tid}/bind-status`, undefined, wxA.d.token);
  rec('普通用户不能看绑定状态', r.s === 401 || r.s === 403, `status=${r.s}`);
  r = await j('POST', `/api/users/${tid}/unbind-wechat`, {}, wxA.d.token);
  rec('普通用户不能解绑', r.s === 401 || r.s === 403, `status=${r.s}`);

  // ---------- 未审批不能绑 ----------
  r = await j('POST', '/api/mp/bind-user', { ticket: t2 }, wxP.d.token);
  rec('未审批用户不能绑定', r.s === 403 && r.d.code === 'NOT_APPROVED', `status=${r.s} ${r.d.code || ''}`);

  // ---------- 管理员账号不能绑 ----------
  const plain = await j('POST', '/api/auth/account/register', { username: 'adm_' + stamp, password: 'Passw0rd123', confirm: 'Passw0rd123' });
  await j('POST', `/api/users/${plain.d.user.id}/promote`, {}, ADM);
  r = await j('POST', `/api/users/${plain.d.user.id}/bind-qr`, {}, ADM);
  rec('管理员账号不生成绑定码', r.s === 400, `status=${r.s} ${r.d.msg || ''}`);

  // ---------- 管理员账号不能绑到普通用户（否则源账号被删、管理员权限丢失） ----------
  const wxAdmin = await devLogin({ openid: 'wx_bt_adm_' + stamp, nickname: '管理员微信' });
  await j('POST', `/api/users/${wxAdmin.d.user.id}/promote`, {}, ADM);
  // 用独立目标账号做探测，别把主流程要用的票顶掉
  const probe = await j('POST', '/api/auth/account/register', { username: 'probe_' + stamp, password: 'Passw0rd123', confirm: 'Passw0rd123' });
  await j('POST', `/api/users/${probe.d.user.id}/approve`, {}, ADM);
  r = await j('POST', `/api/users/${probe.d.user.id}/bind-qr`, {}, ADM);
  const adminTicket = r.d.ticket;
  r = await j('POST', '/api/mp/bind-user', { ticket: adminTicket }, wxAdmin.d.token);
  rec('管理员不能扫码绑定到普通用户', r.s === 400, `status=${r.s} ${r.d.msg || ''} | admin=${wxAdmin.d.user && wxAdmin.d.user.status}/${wxAdmin.d.user && wxAdmin.d.user.role}`);
  const stillAdmin = await j('GET', '/api/mp/me', undefined, wxAdmin.d.token);
  rec('拦截后管理员账号仍在', stillAdmin.s === 200 && stillAdmin.d.user.role === 'admin');

  // ---------- 正常绑定 + 数据迁移 ----------
  // 先用微信账号传一个文件，验证迁移
  await j('POST', `/api/users/${wxA.d.user.id}/approve`, {}, ADM);
  const fd = new FormData();
  fd.append('file', new Blob([Buffer.from('%PDF-1.4\n% bind migrate\n')], { type: 'application/pdf' }), 'migrate.pdf');
  const up = await fetch(BASE + '/api/mp/files', { method: 'POST', headers: { Authorization: 'Bearer ' + wxA.d.token }, body: fd });
  const upJson = await up.json().catch(() => ({}));
  rec('微信账号先上传一个文件', up.status === 200 && !!upJson.file, `status=${up.status}`);

  r = await j('POST', '/api/mp/bind-user', { ticket: t2 }, wxA.d.token);
  rec('审批后绑定成功', r.s === 200 && r.d.user && r.d.user.id === tid, `status=${r.s} ${r.d.msg || ''}`);
  const TOK2 = r.d.token;

  r = await j('GET', '/api/mp/me', undefined, TOK2);
  rec('新令牌指向目标账号', r.d.user && r.d.user.id === tid);
  r = await j('GET', '/api/mp/me', undefined, wxA.d.token);
  rec('旧令牌立即失效', r.s === 401, `status=${r.s}`);

  r = await j('GET', '/api/mp/files', undefined, TOK2);
  const files = (r.d.files || []).map((f) => f.filename);
  rec('上传文件已迁移到目标账号', files.includes('migrate.pdf'), `files=${files.join(',')}`);

  // ---------- 已绑定后不能再绑 ----------
  r = await j('POST', `/api/users/${tid}/bind-qr`, {}, ADM);
  rec('已绑定账号不再发码', r.s === 409, `status=${r.s} ${r.d.msg || ''}`);

  // ---------- 解绑 ----------
  r = await j('POST', `/api/users/${tid}/unbind-wechat`, {}, ADM);
  rec('解绑成功', r.s === 200, r.d.msg || '');
  r = await j('POST', '/api/auth/account/login', { username: uname, password: 'Passw0rd123' });
  rec('解绑后账号密码仍可登录', r.s === 200, `status=${r.s}`);
  // 解绑后同一微信再登录，应回到原账号而不是新建（曾是个真 bug：历史会变孤儿）
  const relogin = await devLogin({ openid: 'wx_bt_a_' + stamp, nickname: '微信甲' });
  rec('解绑后同微信登录回到原账号', relogin.d.user && relogin.d.user.id === tid, `uid=${relogin.d.user && relogin.d.user.id} 期望 ${tid}`);
  // 上一句 relogin 已把 openid 恢复到该账号，所以这里再解绑一次应当成功；
  // 紧接着第二次才应该提示「本来就没绑定」
  r = await j('POST', `/api/users/${tid}/unbind-wechat`, {}, ADM);
  rec('恢复后可再次解绑', r.s === 200, `status=${r.s}`);
  r = await j('POST', `/api/users/${tid}/bind-qr`, {}, ADM);
  rec('解绑后可再生成绑定码', r.s === 200, `status=${r.s}`);
  await j('POST', `/api/users/${tid}/unbind-wechat`, {}, ADM);
  r = await j('POST', `/api/users/${tid}/unbind-wechat`, {}, ADM);
  rec('未绑定账号解绑给出明确提示', r.s === 400, `status=${r.s} ${r.d.msg || ''}`);

  console.log(`\n合计 ${pass} 通过 / ${fail} 失败`);
  if (fail) console.log('失败项:\n - ' + bugs.join('\n - '));
  process.exit(fail ? 1 : 0);
})();
