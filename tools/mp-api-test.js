'use strict';
// 小程序接口契约回归：按小程序实际会发的请求跑一遍全链路
// 用法：PG_BASE=http://127.0.0.1:8080 PG_PASS=xxx node tools/mp-api-test.js
const fs = require('fs');
const path = require('path');

const BASE = process.env.PG_BASE || 'http://127.0.0.1:8080';
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
  if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const res = await fetch(BASE + url, { method, headers, body: payload });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch (_) { data = { raw: text.slice(0, 160) }; }
  return { status: res.status, data };
}

async function upload(token, filePath, filename) {
  const fd = new FormData();
  fd.append('file', new Blob([fs.readFileSync(filePath)]), filename);
  const res = await fetch(BASE + '/api/mp/files', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: fd
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

(async () => {
  const lg = await req('POST', '/api/auth/login', { password: PASS });
  const ADMIN = lg.data.token || '';
  rec('后台管理员登录', !!ADMIN);
  if (!ADMIN) process.exit(1);

  // 打开开发模式，模拟微信登录（真机上是 wx.login + /api/mp/login）
  await req('PUT', '/api/settings', { devMode: true }, ADMIN);
  const dev = await req('POST', '/api/mp/dev-login', { nickname: '小程序用户' });
  const USER = dev.data.token || '';
  rec('小程序登录拿令牌', !!USER);
  rec('新用户默认待审批', dev.data.user?.status === 'pending', `status=${dev.data.user?.status}`);

  console.log('\n== 1. 用户端基础 ==');
  let r = await req('GET', '/api/mp/me', undefined, USER);
  rec('读取我的信息', r.status === 200 && !!r.data.user, `role=${r.data.user?.role}`);
  rec('下发打印限制', !!r.data.config && typeof r.data.config.maxCopies !== 'undefined',
    `maxCopies=${r.data.config?.maxCopies} maxFileMB=${r.data.config?.maxFileMB}`);

  r = await req('GET', '/api/mp/printers', undefined, USER);
  rec('获取打印机列表', r.status === 200 && Array.isArray(r.data.printers), `${(r.data.printers || []).length} 台`);
  const printer = (r.data.printers || [])[0]?.name || '';

  console.log('\n== 2. 待审批限制 ==');
  r = await upload(USER, require('./_paths').standardPng(), '小程序上传.png');
  rec('待审批时上传被拦 403', r.status === 403, `${r.status} ${r.data.msg || ''}`);

  // 管理员放行
  const users = await req('GET', '/api/mp/admin/users?status=pending', undefined, USER);
  rec('非管理员查用户列表 403', users.status === 403, String(users.status));

  // 把自己升级成管理员，才能继续验证管理端
  const bindInfo = await req('GET', '/api/admin/bind/info', undefined, ADMIN);
  const bt = bindInfo.data.token;
  const bind = await req('POST', '/api/mp/bind', { token: bt }, USER);
  rec('绑定码升级管理员', bind.status === 200, bind.data.msg || String(bind.status));

  console.log('\n== 3. 上传与打印 ==');
  r = await upload(USER, require('./_paths').standardPng(), '小程序上传.png');
  rec('审批后上传成功', r.status === 200 && !!r.data.file?.id, `id=${r.data.file?.id}`);
  const fileId = r.data.file?.id;

  r = await req('GET', '/api/mp/files', undefined, USER);
  rec('我的文件列表', r.status === 200 && (r.data.files || []).length > 0, `${(r.data.files || []).length} 个`);

  if (fileId && printer) {
    // 带全部新参数，确认后端接受（水印 / 镜像 / 页面子集 / 每页页数）
    r = await req('POST', '/api/mp/print', {
      fileId, printer,
      options: {
        copies: 2, color: 'mono', sides: 'one-sided', media: 'A4',
        orientation: 'portrait', scaling: 'fit', numberUp: 1,
        pageRanges: '', watermark: '内部资料', mirror: true, pageSet: 'all'
      }
    }, USER);
    rec('提交打印（含水印/镜像）', r.status === 200 && !!r.data.taskId, `task=${r.data.taskId}`);
    const taskId = r.data.taskId;

    r = await req('GET', '/api/mp/tasks', undefined, USER);
    rec('我的任务列表', r.status === 200 && (r.data.tasks || []).length > 0, `${(r.data.tasks || []).length} 条`);
    const mine = (r.data.tasks || [])[0] || {};
    rec('任务存住了水印参数', /内部资料/.test(JSON.stringify(mine.options || {})), JSON.stringify(mine.options || {}).slice(0, 60));

    r = await req('GET', `/api/mp/files/${fileId}/preview`, undefined, USER);
    rec('可预览自己的文件', r.status === 200 || r.status === 415, String(r.status));
    void taskId;
  }

  console.log('\n== 4. 管理员端 ==');
  r = await req('GET', '/api/mp/admin/overview', undefined, USER);
  rec('管理台概览', r.status === 200 && !!r.data.overview,
    `待审用户=${r.data.overview?.pendingUsers} 待审任务=${r.data.overview?.pendingTasks}`);

  r = await req('GET', '/api/mp/admin/users?status=pending', undefined, USER);
  rec('管理员查待审批用户', r.status === 200 && Array.isArray(r.data.users), `${(r.data.users || []).length} 个`);
  const pending = (r.data.users || [])[0];
  if (pending) {
    r = await req('POST', `/api/mp/admin/users/${pending.id}/approve`, {}, USER);
    rec('通过用户审批', r.status === 200, r.data.msg || '');
    r = await req('POST', `/api/mp/admin/users/${pending.id}/block`, {}, USER);
    rec('停用用户', r.status === 200, r.data.msg || '');
  }

  r = await req('GET', '/api/mp/admin/tasks?status=pending', undefined, USER);
  rec('管理员查待审批任务', r.status === 200 && Array.isArray(r.data.tasks), `${(r.data.tasks || []).length} 个`);

  r = await req('GET', '/api/mp/admin/printers', undefined, USER);
  rec('管理员查打印机', r.status === 200 && Array.isArray(r.data.printers), `${(r.data.printers || []).length} 台`);
  const ap = (r.data.printers || [])[0]?.name;
  if (ap) {
    r = await req('POST', `/api/mp/admin/printers/${encodeURIComponent(ap)}/default`, {}, USER);
    rec('设置默认打印机', r.status === 200, r.data.msg || '');
  }

  r = await req('GET', '/api/mp/admin/settings', undefined, USER);
  rec('读取打印设置', r.status === 200 && !!r.data.settings, `maxCopies=${r.data.settings?.maxCopies}`);
  const oldCopies = r.data.settings?.maxCopies;

  r = await req('PUT', '/api/mp/admin/settings', { maxCopies: 7, approveEachJob: false }, USER);
  rec('保存打印设置', r.status === 200, r.data.msg || '');
  r = await req('GET', '/api/mp/admin/settings', undefined, USER);
  rec('设置已生效', r.data.settings?.maxCopies === 7, `maxCopies=${r.data.settings?.maxCopies}（原 ${oldCopies}）`);

  r = await req('PUT', '/api/mp/admin/settings', { maxCopies: 99999 }, USER);
  rec('越界设置被拒 400', r.status === 400, r.data.msg || '');
  await req('PUT', '/api/mp/admin/settings', { maxCopies: oldCopies }, USER);

  console.log('\n== 5. 权限边界 ==');
  const plain = await req('POST', '/api/mp/dev-login', { nickname: '路人甲' });
  const PT = plain.data.token;
  for (const u of ['/api/mp/admin/overview', '/api/mp/admin/users', '/api/mp/admin/printers', '/api/mp/admin/settings']) {
    const rr = await req('GET', u, undefined, PT);
    rec(`普通用户访问 ${u} 被拒`, rr.status === 403, String(rr.status));
  }
  r = await req('PUT', '/api/mp/admin/settings', { maxCopies: 1 }, PT);
  rec('普通用户改设置被拒', r.status === 403, String(r.status));
  r = await req('GET', '/api/mp/printers', undefined, PT);
  rec('普通用户可读打印机（需选队列）', r.status === 200, String(r.status));

  await req('PUT', '/api/settings', { devMode: false }, ADMIN);
  const pass = results.filter((x) => x.p).length;
  console.log(`\n=== ${pass}/${results.length} 通过 ===`);
  const bad = results.filter((x) => !x.p);
  if (bad.length) bad.forEach((b) => console.log(' - ' + b.n + (b.d ? ': ' + b.d : '')));
  process.exit(bad.length ? 1 : 0);
})().catch((e) => { console.error('崩溃:', e.message); process.exit(1); });
