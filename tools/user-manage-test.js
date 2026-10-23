'use strict';
// 小程序用户管理回归：申请资料（头像 / 微信号 / 手机号 / 姓名 / 申请说明）
// + 管理端列表 / 搜索 / 详情 / 审批 / 批量 / 改资料 / 删除 / 边界
// 用法：PG_BASE=http://127.0.0.1:8099 PG_PASS=xxx node tools/user-manage-test.js
const fs = require('fs');
const path = require('path');

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
  return { status: res.status, data, headers: res.headers };
}

async function uploadAvatar(token, filePath, filename) {
  const fd = new FormData();
  fd.append('avatar', new Blob([fs.readFileSync(filePath)]), filename);
  const res = await fetch(BASE + '/api/mp/avatar', {
    method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: fd
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

(async () => {
  console.log('=== 0. 准备 ===');
  let r = await req('GET', '/api/public/bootstrap');
  let ADMIN = '';
  if (r.data.needsSetup) {
    r = await req('POST', '/api/setup', { password: PASS, confirm: PASS });
    ADMIN = r.data.token || '';
    rec('初始化管理员', !!ADMIN, r.data.msg || '');
  } else {
    r = await req('POST', '/api/auth/login', { password: PASS });
    ADMIN = r.data.token || '';
    rec('登录管理后台', !!ADMIN, r.data.msg || '');
  }
  if (!ADMIN) process.exit(1);

  console.log('\n=== 1. 用户申请时提交资料 ===');
  const stamp = Date.now().toString(36);
  const profile = {
    openid: `uitest_${stamp}_a`,
    nickname: '张小印',
    wechat_id: 'zhangxiaoyin_2026',
    phone: '13800001111',
    real_name: '张小印',
    apply_note: '三楼财务，需要打印报销单，急'
  };
  r = await req('POST', '/api/mp/dev-login', profile);
  const USER = r.data.token || '';
  const U = r.data.user || {};
  rec('提交申请并拿到令牌', !!USER);
  rec('新用户默认待审批', U.status === 'pending', `status=${U.status}`);
  rec('昵称落库', U.nickname === profile.nickname, U.nickname);
  rec('微信号落库', U.wechat_id === profile.wechat_id, U.wechat_id);
  rec('手机号落库', U.phone === profile.phone, U.phone);
  rec('姓名落库', U.real_name === profile.real_name, U.real_name);
  rec('申请说明落库', U.apply_note === profile.apply_note);

  console.log('\n=== 2. 管理端能看到完整申请资料 ===');
  r = await req('GET', '/api/users?status=pending&q=' + encodeURIComponent(profile.wechat_id), undefined, ADMIN);
  const hit = (r.data.users || []).find((u) => u.openid === profile.openid);
  rec('按微信号搜索命中', !!hit, `返回 ${(r.data.users || []).length} 条`);
  rec('列表带头像字段', hit && 'avatar' in hit === true);
  rec('列表带微信号', hit && hit.wechat_id === profile.wechat_id);
  rec('列表带手机号', hit && hit.phone === profile.phone);
  rec('列表带申请说明', hit && hit.apply_note === profile.apply_note);

  r = await req('GET', '/api/users?status=all&q=' + encodeURIComponent('13800001111'), undefined, ADMIN);
  rec('按手机号搜索命中', (r.data.users || []).some((u) => u.openid === profile.openid));

  r = await req('GET', '/api/users?status=all&q=' + encodeURIComponent('三楼财务'), undefined, ADMIN);
  rec('按申请说明搜索命中', (r.data.users || []).some((u) => u.openid === profile.openid));

  r = await req('GET', `/api/users/${hit ? hit.id : 0}`, undefined, ADMIN);
  rec('用户详情接口', !!r.data.user, `任务 ${(r.data.stats || {}).tasks} · 文件 ${(r.data.stats || {}).files}`);
  rec('详情含资料字段', !!(r.data.user && r.data.user.wechat_id && r.data.user.apply_note));

  console.log('\n=== 3. 头像上传与读取 ===');
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
    'base64'
  );
  const tmp = path.join(require('os').tmpdir(), `pg-avatar-${stamp}.png`);
  fs.writeFileSync(tmp, png);
  r = await uploadAvatar(USER, tmp, 'avatar.png');
  rec('上传头像', !!r.data.ok && !!r.data.user?.avatar, r.data.msg || r.data.raw || '');
  const avatarUrl = r.data.user?.avatar || '';
  rec('头像路径为本站地址', /^\/api\/mp\/avatar\/[a-f0-9]{24}\.png$/.test(avatarUrl), avatarUrl);
  if (avatarUrl) {
    const img = await fetch(BASE + avatarUrl);
    rec('头像可公开读取', img.status === 200 && /image\//.test(img.headers.get('content-type') || ''),
      `${img.status} ${img.headers.get('content-type')}`);
    const bad = await fetch(BASE + '/api/mp/avatar/..%2F..%2Fprintgate.db');
    rec('头像路径穿越被拒', bad.status === 404, `status=${bad.status}`);
  }
  const tmpTxt = path.join(require('os').tmpdir(), `pg-avatar-bad-${stamp}.png`);
  fs.writeFileSync(tmpTxt, 'this is definitely not an image');
  r = await uploadAvatar(USER, tmpTxt, 'evil.png');
  rec('伪装成图片的文件被拒', r.status === 400, r.data.msg || `status=${r.status}`);
  r = await req('GET', '/api/mp/me', undefined, USER);
  rec('失败上传不影响已有头像', r.data.user?.avatar === avatarUrl);

  r = await req('GET', `/api/users/${hit.id}`, undefined, ADMIN);
  rec('管理端读到新头像', r.data.user?.avatar === avatarUrl, r.data.user?.avatar || '(空)');

  console.log('\n=== 4. 用户自助改资料 ===');
  r = await req('PUT', '/api/mp/profile', { wechat_id: 'new_wxid', phone: '13900002222', apply_note: '补充：工号 A1024' }, USER);
  rec('改资料成功', !!r.data.ok, r.data.msg || '');
  rec('微信号已更新', r.data.user?.wechat_id === 'new_wxid', r.data.user?.wechat_id);
  r = await req('PUT', '/api/mp/profile', {}, USER);
  rec('空资料提交被拒', r.status === 400, `status=${r.status}`);
  r = await req('PUT', '/api/mp/profile', { wechat_id: 'x'.repeat(200) }, USER);
  rec('超长微信号被截断', (r.data.user?.wechat_id || '').length === 64, `len=${(r.data.user?.wechat_id || '').length}`);

  console.log('\n=== 5. 审批与状态流转 ===');
  r = await req('GET', '/api/users?status=all&q=' + encodeURIComponent('new_wxid'), undefined, ADMIN);
  const target = (r.data.users || []).find((u) => u.openid === profile.openid) || hit;
  r = await req('POST', `/api/users/${target.id}/approve`, {}, ADMIN);
  rec('授权成功', !!r.data.ok && r.data.user?.status === 'approved', r.data.msg || '');
  rec('记录授权时间', !!r.data.user?.approved_at);
  r = await req('POST', `/api/users/${target.id}/approve`, {}, ADMIN);
  rec('重复授权不报错', r.status === 200, r.data.msg || '');
  r = await req('POST', `/api/users/${target.id}/block`, {}, ADMIN);
  rec('拉黑成功', r.data.user?.status === 'blocked', r.data.msg || '');
  r = await req('POST', `/api/users/${target.id}/unblock`, {}, ADMIN);
  rec('解除拉黑', r.data.user?.status === 'approved', r.data.msg || '');
  r = await req('POST', `/api/users/${target.id}/promote`, {}, ADMIN);
  rec('提权管理员', r.data.user?.role === 'admin', r.data.msg || '');
  r = await req('POST', `/api/users/${target.id}/demote`, {}, ADMIN);
  rec('取消管理员', r.data.user?.role === 'user', r.data.msg || '');

  console.log('\n=== 6. 批量审批 ===');
  const ids = [];
  for (let i = 0; i < 3; i++) {
    const d = await req('POST', '/api/mp/dev-login', { openid: `uitest_${stamp}_b${i}`, nickname: `批量用户${i}` });
    ids.push(d.data.user?.id);
  }
  r = await req('POST', '/api/users/batch', { ids, action: 'approve' }, ADMIN);
  rec('批量通过', r.data.done === 3, `${r.data.msg} (${JSON.stringify(r.data)})`);
  r = await req('POST', '/api/users/batch', { ids: [], action: 'approve' }, ADMIN);
  rec('空 ids 被拒', r.status === 400, `status=${r.status}`);
  r = await req('POST', '/api/users/batch', { ids: [1], action: 'delete' }, ADMIN);
  rec('批量不支持删除', r.status === 400, `status=${r.status}`);

  console.log('\n=== 7. 管理员代改资料 ===');
  r = await req('PUT', `/api/users/${target.id}`, { note: '财务张工', real_name: '张小印(财务)', wechat_id: 'wx_finance' }, ADMIN);
  rec('管理员改资料', !!r.data.ok, r.data.msg || '');
  rec('备注已保存', r.data.user?.note === '财务张工', r.data.user?.note);
  rec('姓名已纠正', r.data.user?.real_name === '张小印(财务)', r.data.user?.real_name);
  r = await req('PUT', `/api/users/${target.id}`, { nickname: '<img src=x onerror=alert(1)>' }, ADMIN);
  rec('XSS 内容按纯文本存储', r.data.user?.nickname === '<img src=x onerror=alert(1)>');
  r = await req('PUT', `/api/users/${target.id}`, { note: 'n'.repeat(500) }, ADMIN);
  rec('超长备注截断到 200', (r.data.user?.note || '').length === 200);
  r = await req('PUT', '/api/users/999999', { note: 'x' }, ADMIN);
  rec('不存在的用户返回 404', r.status === 404, `status=${r.status}`);
  r = await req('POST', '/api/users/999999/approve', {}, ADMIN);
  rec('审批不存在的用户 404', r.status === 404, `status=${r.status}`);
  r = await req('POST', '/api/users/abc/approve', {}, ADMIN);
  rec('非法用户 ID 404', r.status === 404, `status=${r.status}`);

  console.log('\n=== 8. 越权与鉴权 ===');
  r = await req('GET', '/api/users', undefined, '');
  rec('未登录不能看用户列表', r.status === 401, `status=${r.status}`);
  r = await req('GET', '/api/users', undefined, USER);
  rec('小程序令牌不能访问后台用户接口', r.status === 401, `status=${r.status}`);
  r = await req('PUT', '/api/mp/profile', { wechat_id: 'hack' }, '');
  rec('未登录不能改资料', r.status === 401, `status=${r.status}`);
  r = await req('POST', `/api/users/${target.id}/approve`, {}, USER);
  rec('小程序令牌不能审批', r.status === 401, `status=${r.status}`);

  console.log('\n=== 9. 删除清理 ===');
  const before = await fetch(BASE + avatarUrl).catch(() => ({ status: 0 }));
  rec('删除前头像可访问', before.status === 200);
  r = await req('DELETE', `/api/users/${target.id}`, undefined, ADMIN);
  rec('删除用户', !!r.data.ok, r.data.msg || '');
  const after = await fetch(BASE + avatarUrl).catch(() => ({ status: 0 }));
  rec('头像文件随用户删除', after.status === 404, `status=${after.status}`);
  r = await req('GET', `/api/users/${target.id}`, undefined, ADMIN);
  rec('删除后详情 404', r.status === 404, `status=${r.status}`);

  console.log('\n=== 10. 小程序管理台用户接口 ===');
  const adminMp = await req('POST', '/api/mp/dev-login', { openid: `uitest_${stamp}_admin`, nickname: '台长' });
  const ADMIN_MP = adminMp.data.token;
  await req('POST', `/api/users/${adminMp.data.user.id}/promote`, {}, ADMIN);
  r = await req('GET', '/api/mp/admin/users?status=all&q=' + encodeURIComponent('批量'), undefined, ADMIN_MP);
  rec('管理台列表带资料字段', (r.data.users || []).length > 0 && 'wechat_id' in (r.data.users || [])[0]);
  const victim = (r.data.users || [])[0];
  if (victim) {
    r = await req('POST', `/api/mp/admin/users/${victim.id}/reject`, {}, ADMIN_MP);
    rec('管理台拒绝用户', !!r.data.ok, r.data.msg || '');
    r = await req('POST', `/api/mp/admin/users/${victim.id}/delete`, {}, ADMIN_MP);
    rec('管理台删除用户', !!r.data.ok, r.data.msg || '');
    r = await req('GET', `/api/users/${victim.id}`, undefined, ADMIN);
    rec('删除生效（真删不是拉黑）', r.status === 404, `status=${r.status}`);
    r = await req('POST', `/api/mp/admin/users/${adminMp.data.user.id}/block`, {}, ADMIN_MP);
    rec('不能对自己拉黑', r.status === 400, r.data.msg || '');
  }

  const pass = results.filter((x) => x.p).length;
  console.log(`\n===== ${pass}/${results.length} 通过 =====`);
  const failed = results.filter((x) => !x.p);
  if (failed.length) {
    console.log('失败项：');
    for (const f of failed) console.log(`  - ${f.n} ${f.d}`);
    process.exitCode = 1;
  }
})();
