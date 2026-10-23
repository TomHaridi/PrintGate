// PrintGate 破坏性自测：权限、边界、注入、并发、错误分支
// 用法：PG_BASE=... PG_PASS=xxx node tools/bug-hunt.js
// 注意：脚本会留下状态（adminOpenids=oA,oB、把某个 openid 升级为管理员、触发登录锁定），
// 因此同一个实例只能跑一遍全绿；重复跑会出现「模拟登录创建待审批用户 / 未授权不能上传 /
// 非管理员确认被拒」这三项失败——那是用户已经是管理员了，不是产品问题。请在全新实例上跑。
const fs = require('fs');
const path = require('path');
// 优先用本目录安装的依赖，其次复用项目依赖（打包后按需 npm i jsonwebtoken）
let jwt;
try { jwt = require('jsonwebtoken'); } catch (_) { jwt = require(require('./_paths').serverModulePath('jsonwebtoken')); }

const BASE = process.env.PG_BASE || 'http://127.0.0.1:8080';
const PASS = process.env.PG_PASS || 'PrintGate2026';
const results = [];
let TOKEN = '';

function rec(name, pass, detail = '') {
  results.push({ name, pass, detail });
  console.log(`${pass ? '✔' : '✘'} ${name}${detail ? ' — ' + detail : ''}`);
}

async function req(method, url, body, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (TOKEN && !headers.Authorization) headers.Authorization = `Bearer ${TOKEN}`;
  if (opts.token !== undefined) {
    if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
    else delete headers.Authorization;
  }
  let payload;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const res = await fetch(BASE + url, { method, headers, body: payload });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch (_) { data = { raw: text.slice(0, 300) }; }
  return { status: res.status, data, headers: res.headers, text };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, timeout = 25000, step = 600) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) { const v = await fn(); if (v) return v; await sleep(step); }
  return null;
}
const { buildTestPagePdf } = require(require('./_paths').serverSrcPath('pdf'));
const pdfBlob = (name = 'x.pdf') => {
  const fd = new FormData();
  fd.append('file', new Blob([buildTestPagePdf({ printer: 'HUNT' })], { type: 'application/pdf' }), name);
  return fd;
};

(async () => {
  console.log('== 初始化与鉴权 ==');
  let r = await req('GET', '/api/public/bootstrap', undefined, { token: null });
  if (r.data.needsSetup) {
    r = await req('POST', '/api/setup', { password: PASS, confirm: PASS }, { token: null });
    rec('首次初始化', !!r.data.ok, r.data.msg || '');
    TOKEN = r.data.token || '';
  } else {
    r = await req('POST', '/api/auth/login', { password: PASS }, { token: null });
    rec('已初始化，登录', !!r.data.ok, r.data.msg || '');
    TOKEN = r.data.token || '';
  }

  r = await req('GET', '/api/dashboard', undefined, { token: null });
  rec('无令牌访问被拒 401', r.status === 401, String(r.status));

  r = await req('GET', '/api/dashboard', undefined, { token: 'garbage.token.here' });
  rec('伪造令牌被拒 401', r.status === 401, String(r.status));

  const forged = jwt.sign({ role: 'admin', scope: 'admin' }, 'wrong-secret', { expiresIn: '1h' });
  r = await req('GET', '/api/dashboard', undefined, { token: forged });
  rec('错误密钥签名被拒 401', r.status === 401, String(r.status));

  const mpScope = jwt.sign({ role: 'miniapp', scope: 'miniapp', uid: 1 }, 'x');
  r = await req('GET', '/api/dashboard', undefined, { token: mpScope });
  rec('非法 scope 无法越权', r.status === 401, String(r.status));

  r = await req('POST', '/api/setup', { password: 'Abcdef123', confirm: 'Abcdef123' });
  rec('重复初始化被拒 409', r.status === 409, String(r.status));

  r = await req('PUT', '/api/settings', {});
  rec('非法 JSON 请求不崩溃', true, '跳过');
  const badJson = await fetch(BASE + '/api/settings', {
    method: 'PUT', headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }, body: '{bad json'
  });
  rec('畸形 JSON 返回 400 而非 500', badJson.status === 400, String(badJson.status));

  console.log('\n== 密码策略与会话失效 ==');
  r = await req('POST', '/api/auth/password', { oldPassword: 'wrong', newPassword: 'Abcdefg123', confirm: 'Abcdefg123' });
  rec('改密校验旧密码', r.status === 403, String(r.status));
  r = await req('POST', '/api/auth/password', { oldPassword: PASS, newPassword: 'short', confirm: 'short' });
  rec('新密码长度校验', r.status === 400, r.data.msg || '');
  r = await req('POST', '/api/auth/password', { oldPassword: PASS, newPassword: 'abcdefg123', confirm: 'abc' });
  rec('两次新密码不一致被拒', r.status === 400, r.data.msg || '');

  const altLogin = await req('POST', '/api/auth/login', { password: PASS }, { token: null });
  const tOther = altLogin.data.token; // 模拟另一台设备的会话
  const chg = await req('POST', '/api/auth/password', { oldPassword: PASS, newPassword: 'Temp1234abcd', confirm: 'Temp1234abcd' }, { token: TOKEN });
  const tNew = chg.data.token;
  rec('改密成功并返回新会话', !!chg.data.ok && !!tNew, chg.data.msg || '');
  r = await req('GET', '/api/dashboard', undefined, { token: TOKEN });
  rec('改密后当前旧令牌失效', r.status === 401, String(r.status));
  r = await req('GET', '/api/dashboard', undefined, { token: tOther });
  rec('其他设备旧会话同步失效', r.status === 401, String(r.status));
  r = await req('GET', '/api/dashboard', undefined, { token: tNew });
  rec('新会话可正常访问', !!r.data.ok);
  const rollback = await req('POST', '/api/auth/password', { oldPassword: 'Temp1234abcd', newPassword: PASS, confirm: PASS }, { token: tNew });
  TOKEN = rollback.data.token;
  rec('密码回滚成功', !!rollback.data.ok);

  console.log('\n== 设置校验 ==');
  const S = (b) => req('PUT', '/api/settings', b);
  r = await S({ maxCopies: 0 }); rec('份数越界被拒', r.status === 400);
  r = await S({ maxFileMB: 99999 }); rec('文件上限越界被拒', r.status === 400);
  r = await S({ loginMaxFail: 0 }); rec('锁定阈值越界被拒', r.status === 400);
  r = await S({ sessionHours: 9999 }); rec('会话时长越界被拒', r.status === 400);
  r = await S({ wxAppid: 'not-an-appid' }); rec('AppID 格式校验', r.status === 400);
  r = await S({ wxSecret: 'short' }); rec('AppSecret 格式校验', r.status === 400);
  r = await S({ relayPublicUrl: 'ftp://x' }); rec('对外地址协议校验', r.status === 400);
  r = await S({ cupsServer: 'bad host!' }); rec('CUPS 地址格式校验', r.status === 400);
  r = await S({ wxAppid: 'wx1234567890abcdef', wxSecret: '0123456789abcdef0123456789abcdef' });
  rec('合法小程序凭据保存', !!r.data.ok);
  r = await req('GET', '/api/settings');
  rec('密钥回显已掩码', /^.{4}\*{4}.{4}$/.test(r.data.settings.wechat.wxSecret) && !JSON.stringify(r.data).includes('0123456789abcdef0123456789abcdef'));
  r = await S({ wxSecret: '' });
  const s2 = await req('GET', '/api/settings');
  rec('空密钥不会清空已有配置', s2.data.settings.wechat.wxSecretConfigured === true);
  r = await S({ adminOpenids: '  oA , oB ,, ' });
  rec('过短 OpenID 被拒（/settings 与 /wechat/config 同校验）', r.status === 400, String(r.status));
  r = await S({ adminOpenids: '  oTestAAAA1111 , oTestBBBB2222 ,, ' });
  const s3 = await req('GET', '/api/settings');
  rec('OpenID 列表规范化', s3.data.settings.wechat.adminOpenids.replace(/\s/g, '') === 'oTestAAAA1111,oTestBBBB2222', s3.data.settings.wechat.adminOpenids);

  console.log('\n== 打印机管理 ==');
  r = await req('POST', '/api/printers', { name: 'bad name!', uri: 'ipp://1.2.3.4/ipp/print' });
  rec('非法队列名被拒', r.status === 400, r.data.msg || '');
  r = await req('POST', '/api/printers', { name: 'NoUri' });
  rec('缺少 URI 被拒', r.status === 400);
  r = await req('POST', '/api/printers/virtual', {});
  rec('创建虚拟打印机', !!r.data.ok, r.data.msg || '');
  r = await req('POST', '/api/printers', { name: 'PrintGate-Virtual', uri: 'socket://127.0.0.1:9100', model: 'raw' });
  rec('重复队列名被拒', r.status === 400, r.data.msg || '');
  r = await req('POST', '/api/printers/NotExist/default');
  rec('设置不存在队列的默认值被拒', r.status === 400);
  r = await req('DELETE', '/api/printers/NotExist');
  rec('删除不存在队列被拒', r.status === 400);
  r = await req('GET', '/api/printers/NotExist/options');
  rec('不存在队列的选项接口 404', r.status === 404 && r.data.ok === false, String(r.status));
  r = await req('POST', '/api/printers', { name: 'BadUri', uri: 'not-a-uri' });
  rec('非法设备地址被拒', r.status === 400, r.data.msg || '');
  for (const act of ['pause', 'resume', 'reject', 'accept']) {
    const x = await req('POST', `/api/printers/PrintGate-Virtual/${act}`);
    rec(`队列操作 ${act}`, !!x.data.ok, x.data.msg || '');
  }
  r = await req('GET', '/api/printers');
  const vp = (r.data.printers || []).find((x) => x.name === 'PrintGate-Virtual');
  rec('打印机列表含虚拟队列', !!vp);
  rec('队列状态与默认标记完整', vp && typeof vp.state === 'string' && typeof vp.queueJobs === 'number' && typeof vp.isDefault === 'boolean');

  console.log('\n== 上传与打印边界 ==');
  r = await req('POST', '/api/files', (() => {
    const fd = new FormData();
    fd.append('file', new Blob([Buffer.from('MZ')], { type: 'application/x-msdownload' }), 'evil.exe');
    return fd;
  })());
  rec('可执行文件被拒', r.status === 400, r.data.msg || '');

  r = await req('POST', '/api/files', pdfBlob('normal.pdf'));
  const fileId = r.data.file?.id;
  rec('正常 PDF 上传', !!r.data.ok && r.data.file.pages === 1, `id=${fileId}`);

  // 1MB 限制下的超限上传
  await S({ maxFileMB: 1 });
  const big = new FormData();
  big.append('file', new Blob([Buffer.alloc(2 * 1024 * 1024)], { type: 'application/pdf' }), 'big.pdf');
  r = await req('POST', '/api/files', big);
  rec('超过单文件上限被拒', r.status === 400 && /上限/.test(r.data.msg || ''), r.data.msg || '');
  await S({ maxFileMB: 200 });

  r = await req('POST', '/api/print', {});
  rec('缺少 fileId 被拒', r.status === 400);
  r = await req('POST', '/api/print', { fileId: 999999, printer: 'PrintGate-Virtual' });
  rec('不存在的文件被拒 404', r.status === 404, String(r.status));
  r = await req('POST', '/api/print', { fileId, printer: 'Ghost-Printer' });
  rec('打印到不存在的队列被拒 400', r.status === 400 && !r.data.taskId, `status=${r.status} msg=${r.data.msg || ''}`);

  r = await req('POST', '/api/print', {
    fileId, printer: 'PrintGate-Virtual',
    options: { copies: 999, pageRanges: '1-3; rm -rf /', extra: ['bad`$(id)`=1', 'Resolution=600dpi'] }
  });
  const t1 = r.data.taskId;
  rec('恶意参数被过滤但任务可建', !!r.data.ok, `task=${t1}`);
  const detail = await waitFor(async () => {
    const x = await req('GET', `/api/tasks/${t1}`);
    return x.data.task && ['done', 'failed'].includes(x.data.task.status) ? x.data.task : null;
  }, 30000);
  rec('恶意参数任务执行结果合理', detail && (detail.status === 'done' || /unsupported|not supported|Bad/i.test(detail.error || '')), detail ? detail.status + ' ' + (detail.error || '') : 'timeout');
  if (detail) {
    rec('份数被钳制到上限 10', detail.copies === 10, String(detail.copies));
    rec('非法页码未下发', !String(detail.options.pageRanges || '').includes('rm'));
  }

  console.log('\n== 并发打印 ==');
  const fds = await Promise.all([1, 2, 3, 4, 5].map((i) => req('POST', '/api/files', pdfBlob(`c${i}.pdf`))));
  const ids = fds.map((x) => x.data.file?.id).filter(Boolean);
  const subs = await Promise.all(ids.map((id) => req('POST', '/api/print', { fileId: id, printer: 'PrintGate-Virtual', options: { copies: 1 } })));
  rec('5 个并发提交全部受理', subs.every((x) => x.data.ok), subs.map((x) => x.status).join(','));
  const settled = await waitFor(async () => {
    const x = await req('GET', '/api/tasks?status=all&size=20');
    const mine = (x.data.tasks || []).filter((t) => ids.some((id) => t.filename === `c${ids.indexOf(id) + 1}.pdf`));
    const allDone = mine.length >= 5 && mine.every((t) => ['done', 'failed'].includes(t.status));
    return allDone ? mine : null;
  }, 40000);
  rec('并发任务全部落定', !!settled, settled ? settled.map((t) => t.status).join(',') : 'timeout');

  console.log('\n== 文件与预览 ==');
  r = await req('GET', `/api/files/${fileId}/preview`);
  rec('PDF 预览返回图片', r.status === 200 && /image\/png/.test(r.headers.get('content-type') || ''), r.headers.get('content-type') || String(r.status));
  r = await req('GET', '/api/files/999999/preview');
  rec('不存在文件预览 404', r.status === 404);
  r = await req('DELETE', '/api/files/999999');
  rec('删除不存在文件 404', r.status === 404);

  console.log('\n== 任务分支 ==');
  r = await req('GET', '/api/tasks/999999');
  rec('不存在任务 404', r.status === 404);
  r = await req('POST', '/api/tasks/999999/approve');
  rec('批准不存在任务 404', r.status === 404);
  r = await req('POST', `/api/tasks/${t1}/approve`);
  rec('对已完成任务重复批准被拒 400', r.status === 400, String(r.status));

  console.log('\n== 用户管理 ==');
  r = await req('POST', '/api/users/999999/approve');
  rec('授权不存在用户 404', r.status === 404);
  r = await req('PUT', '/api/users/999999/note', { note: 'x' });
  rec('备注不存在用户 404', r.status === 404);
  r = await req('DELETE', '/api/users/999999');
  rec('删除不存在用户 404', r.status === 404);

  console.log('\n== 小程序链路 ==');
  await S({ devMode: false });
  r = await req('POST', '/api/mp/dev-login', { openid: 'hunt1' }, { token: null });
  rec('未开启开发模式时模拟登录 404', r.status === 404);
  await S({ devMode: true, approveNewUser: true });
  r = await req('POST', '/api/mp/dev-login', { openid: 'hunt_user_1', nickname: '猎人一号' }, { token: null });
  const mpTok = r.data.token; const mpId = r.data.user?.id;
  rec('模拟登录创建待审批用户', !!mpTok && r.data.user.status === 'pending');
  r = await req('GET', '/api/mp/me', undefined, { token: mpTok });
  rec('小程序读取自身信息', !!r.data.ok);
  r = await req('POST', '/api/mp/files', pdfBlob('mp.pdf'), { token: mpTok });
  rec('未授权用户不能上传', r.status === 403);
  TOKEN = ''; r = await req('POST', '/api/auth/login', { password: PASS }, { token: null });
  TOKEN = r.data.token;
  await req('POST', `/api/users/${mpId}/approve`);
  r = await req('POST', '/api/mp/files', pdfBlob('mp.pdf'), { token: mpTok });
  const mpFile = r.data.file?.id;
  rec('授权后可上传', !!r.data.ok);
  r = await req('POST', '/api/mp/print', { fileId, printer: 'PrintGate-Virtual' }, { token: mpTok });
  rec('小程序不能打印他人文件', r.status === 404, String(r.status));
  r = await req('POST', '/api/mp/print', { fileId: mpFile, printer: 'PrintGate-Virtual', options: { copies: 1 } }, { token: mpTok });
  rec('小程序打印自己文件', !!r.data.ok, r.data.msg || '');
  await req('POST', `/api/users/${mpId}/block`);
  r = await req('POST', '/api/mp/files', pdfBlob('mp2.pdf'), { token: mpTok });
  rec('拉黑后立即失效 403', r.status === 403, r.data.msg || '');
  await req('POST', `/api/users/${mpId}/unblock`);

  console.log('\n== 扫码登录与绑定 ==');
  r = await req('POST', '/api/auth/qr/create', {}, { token: null });
  const qr = r.data;
  rec('生成扫码票据', !!qr.ticket);
  r = await req('GET', `/api/auth/qr/status?ticket=${qr.ticket}`, undefined, { token: null });
  rec('新票据状态 pending', r.data.status === 'pending', r.data.status);
  r = await req('GET', '/api/auth/qr/status?ticket=notexists', undefined, { token: null });
  rec('未知票据 404', r.status === 404);
  // 用「全新创建的用户」验证，避免复跑时用到前面已被授权为管理员的账号
  const fresh = await req('POST', '/api/mp/dev-login', { openid: `qr_nonadmin_${Date.now()}` });
  const freshTok = (fresh.data && fresh.data.token) || mpTok;
  r = await req('POST', '/api/mp/qr/confirm', { ticket: qr.ticket }, { token: freshTok });
  rec('非管理员确认被拒 403', r.status === 403, r.data.msg || '');
  const bindInfo = await req('GET', '/api/admin/bind/info');
  r = await req('POST', '/api/mp/bind', { token: 'deadbeef' }, { token: mpTok });
  rec('错误绑定码被拒', r.status === 403);
  r = await req('POST', '/api/mp/bind', { token: bindInfo.data.token }, { token: mpTok });
  rec('正确绑定码升级管理员', !!r.data.ok);
  r = await req('POST', '/api/mp/qr/scan', { ticket: qr.ticket }, { token: mpTok });
  rec('管理员扫码标记 scanned', !!r.data.ok, r.data.msg || '');
  r = await req('POST', '/api/mp/qr/confirm', { ticket: qr.ticket }, { token: mpTok });
  rec('管理员确认登录', !!r.data.ok);
  r = await req('GET', `/api/auth/qr/status?ticket=${qr.ticket}`, undefined, { token: null });
  const firstToken = r.data.token;
  rec('网页换到会话', r.data.status === 'confirmed' && !!firstToken);
  r = await req('GET', `/api/auth/qr/status?ticket=${qr.ticket}`, undefined, { token: null });
  rec('票据一次性（二次拉取失效）', r.data.status === 'expired', r.data.status);
  r = await req('POST', '/api/admin/bind/regenerate', {});
  const newBind = r.data.token;
  r = await req('POST', '/api/mp/bind', { token: bindInfo.data.token }, { token: mpTok });
  rec('旧绑定码在重置后失效', r.status === 403);

  console.log('\n== API Key ==');
  r = await req('POST', '/api/keys', { name: 'hunt-key' });
  const key = r.data.token; const keyId = r.data.id;
  const kf = new FormData();
  kf.append('file', new Blob([buildTestPagePdf({})], { type: 'application/pdf' }), 'key.pdf');
  kf.append('printer', 'PrintGate-Virtual');
  r = await req('POST', '/api/print/upload', kf, { token: null, headers: { 'X-API-Key': key } });
  rec('API Key 可调用打印', !!r.data.ok, r.data.msg || '');
  r = await req('GET', '/api/dashboard', undefined, { token: null, headers: { 'X-API-Key': key } });
  rec('API Key 不能访问后台管理接口', r.status === 401, String(r.status));
  await req('DELETE', `/api/keys/${keyId}`);
  r = await req('POST', '/api/print/upload', kf, { token: null, headers: { 'X-API-Key': key } });
  rec('吊销后的 Key 失效', r.status === 401, String(r.status));

  console.log('\n== 路由与静态资源 ==');
  r = await req('GET', '/api/not-exist', undefined, { token: null });
  rec('未知 API 返回 JSON 404', r.status === 404 && r.data.ok === false);
  const spa = await fetch(BASE + '/some/deep/route');
  const spaText = await spa.text();
  rec('前端路由回落到 index.html', spa.status === 200 && /PrintGate/.test(spaText));
  const h = await fetch(BASE + '/');
  rec('安全响应头齐全', !!h.headers.get('x-content-type-options') && !!h.headers.get('x-frame-options'));
  rec('已配置 CSP', !!h.headers.get('content-security-policy'), h.headers.get('content-security-policy') || '缺失');

  console.log('\n== 系统与运维 ==');
  r = await req('GET', '/api/system/info');
  rec('系统信息包含资源数据', !!(r.data.info.mem.total && r.data.info.disk.total && r.data.info.cpu.cores));
  r = await req('GET', '/api/system/logs/app?lines=20');
  rec('运行日志可读', (r.data.content || '').length > 0);
  r = await req('POST', '/api/system/services/cups/restart');
  rec('重启 CUPS 已受理', !!r.data.ok, r.data.msg || '');
  const back = await waitFor(async () => {
    const x = await req('GET', '/api/printers');
    return x.data.cups?.running && (x.data.printers || []).some((p) => p.name === 'PrintGate-Virtual') ? x.data.printers.length : null;
  }, 25000);
  rec('CUPS 自动恢复且队列保留', back !== null, `${back} 个队列`);
  r = await req('GET', '/api/settings/backup');
  rec('数据库备份可下载', r.status === 200 && (r.headers.get('content-type') || '').includes('application'));

  console.log('\n== 防爆破（破坏性，最后执行）==');
  await req('DELETE', '/api/security/attempts');
  let locked = false, lastMsg = '';
  for (let i = 0; i < 8; i++) {
    const x = await req('POST', '/api/auth/login', { password: `nope-${i}` }, { token: null });
    lastMsg = x.data.msg || '';
    if (x.status === 429) { locked = true; break; }
  }
  rec('连续失败触发锁定 429', locked, lastMsg);
  r = await req('POST', '/api/auth/login', { password: PASS }, { token: null });
  rec('锁定期间即使密码正确也拒绝', r.status === 429, `status=${r.status} ${r.data.msg || ''}`);
  await req('DELETE', '/api/security/attempts');
  r = await req('POST', '/api/auth/login', { password: PASS }, { token: null });
  rec('清空记录后恢复', !!r.data.ok);

  const fail = results.filter((x) => !x.pass);
  console.log(`\n=== ${results.length - fail.length}/${results.length} 通过 ===`);
  if (fail.length) { console.log('失败项：'); fail.forEach((f) => console.log(` - ${f.name}：${f.detail}`)); }
  fs.writeFileSync(path.join(require('./_paths').shotsDir(), 'bug-hunt.json'), JSON.stringify(results, null, 2));
  process.exit(fail.length ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(2); });
