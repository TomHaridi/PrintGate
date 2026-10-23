'use strict';
// 用户管理深度猎杀：头像安全 / 资料字段健壮性 / 搜索注入 / 批量与分页边界 / 审计去重
// 用法：PG_BASE=http://127.0.0.1:8099 PG_PASS=xxx node tools/user-bug-hunt.js
const fs = require('fs');
const path = require('path');
const os = require('os');

const BASE = process.env.PG_BASE || 'http://127.0.0.1:8099';
const PASS = process.env.PG_PASS || 'LocalTest2026';

const results = [];
const rec = (n, p, d = '') => {
  results.push({ n, p, d });
  console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? `  —  ${d}` : ''}`);
};

async function req(method, url, body, token = '') {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  let payload;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const res = await fetch(BASE + url, { method, headers, body: payload });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch (_) { data = { raw: text.slice(0, 160) }; }
  return { status: res.status, data };
}

async function postFile(url, token, buf, filename, field = 'avatar') {
  const fd = new FormData();
  fd.append(field, new Blob([buf]), filename);
  const res = await fetch(BASE + url, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: fd });
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
    const d = await req('POST', '/api/mp/dev-login', Object.assign({ openid: `bh_${stamp}_${Math.random().toString(36).slice(2, 7)}` }, extra));
    return { token: d.data.token, user: d.data.user };
  };
  const u1 = await mk({ nickname: '猎杀一号', wechat_id: 'bh_wx_1', phone: '13000000001' });
  const USER = u1.token;

  console.log('=== A. 头像安全与边界 ===');
  r = await postFile('/api/mp/avatar', '', PNG, 'a.png');
  rec('未登录上传头像被拒', r.status === 401, `status=${r.status}`);
  r = await postFile('/api/mp/avatar', USER, PNG, 'a.png', 'file');
  rec('字段名不对时拒绝', r.status === 400, r.data.msg || `status=${r.status}`);
  r = await postFile('/api/mp/avatar', USER, Buffer.concat([PNG, Buffer.alloc(6 * 1024 * 1024)]), 'big.png');
  rec('超过 5MB 被拒', r.status === 400, r.data.msg || `status=${r.status}`);
  r = await postFile('/api/mp/avatar', USER, Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'), 'x.png');
  rec('SVG 伪装成 png 被拒', r.status === 400, r.data.msg || `status=${r.status}`);
  r = await postFile('/api/mp/avatar', USER, Buffer.from('MZ\x90\x00 not image'), 'y.png');
  rec('可执行文件被拒', r.status === 400, r.data.msg || `status=${r.status}`);

  let bad = await fetch(BASE + '/api/mp/avatar/....%2Fprintgate.db');
  rec('编码穿越被拒', bad.status === 404, `status=${bad.status}`);
  bad = await fetch(BASE + '/api/mp/avatar/%2e%2e%2f%2e%2e%2fetc%2fpasswd');
  rec('双重编码穿越被拒', bad.status === 404, `status=${bad.status}`);

  // 连续换头像：只保留最后一个文件，旧的要清掉
  const first = await postFile('/api/mp/avatar', USER, PNG, 'a.png');
  const firstUrl = first.data.user?.avatar || '';
  rec('上传头像成功', !!firstUrl, firstUrl);
  await postFile('/api/mp/avatar', USER, PNG, 'b.png');
  await postFile('/api/mp/avatar', USER, PNG, 'c.png');
  const after = await fetch(BASE + firstUrl).catch(() => ({ status: 0 }));
  rec('换头像后旧文件已清理', after.status === 404, `旧头像 status=${after.status}`);
  r = await req('GET', '/api/mp/me', undefined, USER);
  const finalUrl = r.data.user?.avatar || '';
  const ok3 = await fetch(BASE + finalUrl);
  rec('最新头像可访问', ok3.status === 200);

  console.log('\n=== B. 资料字段健壮性 ===');
  r = await req('PUT', '/api/mp/profile', { wechat_id: '' }, USER);
  rec('用户可清空微信号', r.status === 200 && r.data.user?.wechat_id === '', `wechat_id="${r.data.user?.wechat_id}"`);
  r = await req('PUT', '/api/mp/profile', { wechat_id: 'bh_wx_2', phone: '13000000002' }, USER);
  rec('重新填写成功', r.data.user?.wechat_id === 'bh_wx_2');

  // 敏感字段不能自助改
  r = await req('PUT', '/api/mp/profile', { role: 'admin', status: 'approved', openid: 'hacked', id: 1 }, USER);
  rec('敏感字段不在资料白名单内（直接拒绝）', r.status === 400, `status=${r.status} ${r.data.msg || ''}`);
  const me = await req('GET', '/api/mp/me', undefined, USER);
  rec('不能自助提权/改状态', me.data.user?.role === 'user' && me.data.user?.status === 'pending',
    `role=${me.data.user?.role} status=${me.data.user?.status}`);
  rec('不能改自己的 openid', me.data.user?.openid === u1.user.openid);

  r = await req('PUT', `/api/users/${u1.user.id}`, { role: 'admin', status: 'approved', openid: 'x' }, ADMIN);
  rec('管理端改资料不接受越权字段', r.data.user?.role === 'user' && r.data.user?.status === 'pending', `role=${r.data.user?.role} status=${r.data.user?.status}`);

  // 登录时被纠正过的资料不该被空值覆盖
  await req('PUT', `/api/users/${u1.user.id}`, { wechat_id: 'admin_fixed' }, ADMIN);
  const relogin = await req('POST', '/api/mp/dev-login', { openid: u1.user.openid, nickname: '猎杀一号' });
  rec('重新登录不覆盖管理员纠正的资料', relogin.data.user?.wechat_id === 'admin_fixed', relogin.data.user?.wechat_id);

  // 特殊字符
  const weird = '𝄞emoji🎯 <b>粗体</b> "引号" \\反斜杠';
  r = await req('PUT', '/api/mp/profile', { apply_note: weird }, USER);
  rec('emoji / 标签 / 引号按原文存储', r.data.user?.apply_note === weird, (r.data.user?.apply_note || '').slice(0, 30));
  r = await req('PUT', '/api/mp/profile', { nickname: "'; DROP TABLE users; --" }, USER);
  rec('SQL 片段作为文本存储且库还在', r.status === 200 && (await req('GET', '/api/users?status=all&size=1', undefined, ADMIN)).status === 200);

  console.log('\n=== C. 搜索注入与分页边界 ===');
  const total = (await req('GET', '/api/users?status=all&size=1', undefined, ADMIN)).data.total;
  r = await req('GET', '/api/users?status=all&size=200&q=%', undefined, ADMIN);
  rec('搜索 "%" 不当通配符', (r.data.users || []).length < total, `命中 ${(r.data.users || []).length} / 全量 ${total}`);
  r = await req('GET', '/api/users?status=all&size=200&q=%25', undefined, ADMIN);
  rec('搜索字面量 %25 也可用', r.status === 200, `命中 ${(r.data.users || []).length}`);
  r = await req('GET', "/api/users?status=all&q=' OR '1'='1", undefined, ADMIN);
  rec("SQL 片段搜索不泄漏全量", (r.data.users || []).length < total, `命中 ${(r.data.users || []).length}`);
  r = await req('GET', `/api/users?status=all&q=${encodeURIComponent('x'.repeat(500))}`, undefined, ADMIN);
  rec('超长关键词不报错', r.status === 200 && (r.data.users || []).length === 0);

  for (const [q, label] of [['page=0&size=20', 'page=0'], ['page=-3&size=20', 'page 负数'], ['page=9999&size=20', 'page 越界'], ['page=1&size=0', 'size=0'], ['page=1&size=9999', 'size 超上限'], ['page=abc&size=xyz', '非法分页参数']]) {
    r = await req('GET', `/api/users?status=all&${q}`, undefined, ADMIN);
    rec(`分页边界 ${label}`, r.status === 200 && Array.isArray(r.data.users), `返回 ${(r.data.users || []).length} 条`);
  }
  r = await req('GET', '/api/users?status=notastatus', undefined, ADMIN);
  rec('非法状态筛选返回空列表', r.status === 200 && (r.data.users || []).length === 0);

  console.log('\n=== D. 批量与并发 ===');
  const ids = [];
  for (let i = 0; i < 4; i++) ids.push((await mk({ nickname: `批量${i}` })).user.id);
  r = await req('POST', '/api/users/batch', { ids: [...ids, ...ids, 999999, 'abc', null], action: 'approve' }, ADMIN);
  rec('批量通过（去重/忽略无效 id）', r.data.done === 4, JSON.stringify(r.data));
  r = await req('POST', '/api/users/batch', { ids, action: 'approve' }, ADMIN);
  rec('重复批量不再计入', r.data.done === 0 && r.data.skipped === 4, JSON.stringify(r.data));
  r = await req('POST', '/api/users/batch', { ids: 'not-an-array', action: 'approve' }, ADMIN);
  rec('ids 非数组被拒', r.status === 400, `status=${r.status}`);
  r = await req('POST', '/api/users/batch', { ids: [1], action: 'promote' }, ADMIN);
  rec('批量不支持提权', r.status === 400, `status=${r.status}`);
  // 并发同一批
  const conc = await Promise.all(ids.map(() => req('POST', '/api/users/batch', { ids, action: 'block' }, ADMIN)));
  const dones = conc.map((x) => x.data.done);
  rec('并发批量只有一个真正生效', dones.filter((d) => d === 4).length === 1, `done=${JSON.stringify(dones)}`);

  console.log('\n=== E. 审批审计去重 ===');
  const before = (await req('GET', `/api/users/${ids[0]}`, undefined, ADMIN)).data.user;
  await req('POST', `/api/users/${ids[0]}/unblock`, {}, ADMIN);
  const a1 = (await req('GET', '/api/audit?size=200&q=user_unblock', undefined, ADMIN)).data.total || 0;
  await req('POST', `/api/users/${ids[0]}/unblock`, {}, ADMIN);
  await req('POST', `/api/users/${ids[0]}/unblock`, {}, ADMIN);
  const a2 = (await req('GET', '/api/audit?size=200&q=user_unblock', undefined, ADMIN)).data.total || 0;
  rec('重复操作不刷审计', a2 === a1, `${a1} → ${a2}`);
  r = await req('POST', `/api/users/${ids[0]}/approve`, {}, ADMIN);
  rec('审批记录授权人', !!r.data.user?.approved_at, `approved_at=${r.data.user?.approved_at}`);
  r = await req('GET', `/api/users/${ids[0]}`, undefined, ADMIN);
  rec('详情含 approved_by/updated_at', 'approved_by' in r.data.user && 'updated_at' in r.data.user);

  console.log('\n=== F. 小程序管理台边界 ===');
  const adm = await mk({ nickname: '猎杀管理员' });
  await req('POST', `/api/users/${adm.user.id}/promote`, {}, ADMIN);
  r = await req('GET', '/api/mp/admin/users?q=%', undefined, adm.token);
  rec('管理台搜索 % 不当通配符', (r.data.users || []).length < total, `命中 ${(r.data.users || []).length}`);
  r = await req('POST', `/api/mp/admin/users/${adm.user.id}/delete`, {}, adm.token);
  rec('管理台不能删自己', r.status === 400, r.data.msg || `status=${r.status}`);
  r = await req('POST', '/api/mp/admin/users/999999/approve', {}, adm.token);
  rec('管理台审批不存在用户 404', r.status === 404, `status=${r.status}`);
  r = await req('GET', '/api/mp/admin/users', undefined, USER);
  rec('普通用户不能访问管理台列表', r.status === 403, `status=${r.status}`);

  console.log('\n=== G. 用户台账导出 ===');
  const csvRes = await fetch(`${BASE}/api/users/export?status=all`, { headers: { Authorization: `Bearer ${ADMIN}` } });
  const csv = await csvRes.text();
  const lines = csv.split('\r\n');
  rec('导出返回 CSV', csvRes.status === 200 && /text\/csv/.test(csvRes.headers.get('content-type') || ''), `${lines.length} 行`);
  rec('表头含微信号等字段', /微信号/.test(lines[0]) && /申请说明/.test(lines[0]) && /OpenID/.test(lines[0]), lines[0].slice(0, 60));
  // fetch 解码 UTF-8 会自动吃掉 BOM，要看原始字节
  const bomBuf = Buffer.from(await (await fetch(`${BASE}/api/users/export?status=all`, { headers: { Authorization: `Bearer ${ADMIN}` } })).arrayBuffer());
  rec('带 BOM（Excel 中文不乱码）', bomBuf[0] === 0xef && bomBuf[1] === 0xbb && bomBuf[2] === 0xbf,
    bomBuf.slice(0, 3).toString('hex'));
  await req('PUT', '/api/mp/profile', { apply_note: '=cmd|calc!A1' }, USER);
  const csv2 = await (await fetch(`${BASE}/api/users/export?status=all`, { headers: { Authorization: `Bearer ${ADMIN}` } })).text();
  rec('CSV 公式注入被中和', /'=cmd/.test(csv2));
  const noAuth = await fetch(`${BASE}/api/users/export`);
  rec('未登录不能导出', noAuth.status === 401, `status=${noAuth.status}`);
  const byStatus = await (await fetch(`${BASE}/api/users/export?status=pending`, { headers: { Authorization: `Bearer ${ADMIN}` } })).text();
  rec('按状态筛选导出', byStatus.split('\r\n').length <= lines.length, `${byStatus.split('\r\n').length} 行`);

  console.log('\n=== H. 收尾 ===');
  r = await req('GET', '/api/health');
  rec('服务仍健康', r.status === 200);

  const pass = results.filter((x) => x.p).length;
  console.log(`\n===== ${pass}/${results.length} 通过 =====`);
  const failed = results.filter((x) => !x.p);
  if (failed.length) {
    console.log('失败项：');
    for (const f of failed) console.log(`  - ${f.n} ${f.d}`);
    process.exitCode = 1;
  }
})();
