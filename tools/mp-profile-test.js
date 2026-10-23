'use strict';
// 小程序资料链路回归：匿名昵称过滤 / 真实昵称保存 / 头像路径校验
// 用法：BASE=http://127.0.0.1:8098 PG_DEV_MODE=true node tools/mp-profile-test.js
const BASE = process.env.BASE || 'http://127.0.0.1:8098';
const PW = process.env.PW || 'LocalTest2026';
let pass = 0, fail = 0;
const rec = (n, ok, extra = '') => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'} | ${n}${extra ? ' | ' + extra : ''}`); };

const j = async (method, path, body, token) => {
  const r = await fetch(BASE + path, {
    method,
    headers: Object.assign({ 'Content-Type': 'application/json' }, token ? { Authorization: `Bearer ${token}` } : {}),
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  let d = {}; try { d = await r.json(); } catch (_) {}
  return { status: r.status, d };
};

(async () => {
  let r = await j('POST', '/api/setup', { password: PW, confirm: PW });
  if (!r.d.token) r = await j('POST', '/api/auth/login', { password: PW });
  const ADMIN = r.d.token;
  if (!ADMIN) { console.error('取不到管理员令牌'); process.exit(1); }

  // 1) 匿名昵称（微信默认值）不得入库
  const openid = `prof_${Date.now()}`;
  let d = await j('POST', '/api/mp/dev-login', { openid, nickname: '微信用户' });
  rec('匿名昵称「微信用户」被丢弃', (d.d.user.nickname || '') === '', `nickname="${d.d.user.nickname}"`);
  const TOK = d.d.token;

  // 2) 真实昵称（对应「使用微信昵称」后的提交）正常保存
  r = await j('PUT', '/api/mp/profile', { nickname: '打印机小王' }, TOK);
  rec('真实昵称可保存', r.d.ok === true && r.d.user.nickname === '打印机小王', r.d.user && r.d.user.nickname);

  // 3) 再次登录带匿名昵称，不能把已保存的真名冲掉
  d = await j('POST', '/api/mp/dev-login', { openid, nickname: '微信用户' });
  rec('重复登录不覆盖真实昵称', d.d.user.nickname === '打印机小王', `nickname="${d.d.user.nickname}"`);

  // 4) 大小写变体的匿名昵称同样丢弃
  d = await j('POST', '/api/mp/dev-login', { openid: `prof2_${Date.now()}`, nickname: 'WeChat User' });
  rec('匿名昵称「WeChat User」被丢弃', (d.d.user.nickname || '') === '', `nickname="${d.d.user.nickname}"`);

  // 5) 头像只接受本站上传路径（外链/traversal 一律忽略）
  for (const [label, av] of [
    ['外链头像被忽略', 'https://thirdwx.qlogo.cn/mmopen/abc/132'],
    ['javascript: 被忽略', 'javascript:alert(1)'],
    ['穿越路径被忽略', '/api/mp/avatar/../../etc/passwd'],
    ['合法本站路径可保存', '/api/mp/avatar/abcdefabcdefabcdefabcdef.png']
  ]) {
    r = await j('PUT', '/api/mp/profile', { avatar: av }, TOK);
    const got = r.d.user ? r.d.user.avatar : '';
    if (label.includes('合法')) rec(label, got === av, `avatar="${got}"`);
    else rec(label, got !== av, `avatar="${got}"`);
  }

  // 6) 后台用户列表能读到昵称与头像（用白名单 openid 拿到小程序管理员态）
  //    /mp/admin/* 要的是小程序 JWT + 管理员角色，网页端 JWT 进不来
  const adminOpenid = `prof_admin_${Date.now()}`;
  await j('PUT', '/api/wechat/config', { adminOpenids: [adminOpenid] }, ADMIN);
  const mA = (await j('POST', '/api/mp/dev-login', { openid: adminOpenid, nickname: '审批管理员' })).d.token;
  r = await j('GET', `/api/mp/admin/users?status=all&q=${encodeURIComponent('打印机小王')}`, undefined, mA);
  const hit = (r.d.users || [])[0] || {};
  rec('后台可按昵称搜到该用户', /打印机小王/.test(hit.nickname || ''), `found=${r.d.users ? r.d.users.length : 0}`);
  rec('后台返回可用头像字段', hit.avatar !== undefined, `avatar="${hit.avatar}"`);

  console.log(`\n合计 ${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})();
