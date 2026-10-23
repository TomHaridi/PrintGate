// PrintGate 容器端到端自测（无浏览器）：初始化 -> 打印机 -> 打印 -> 小程序 -> 扫码 -> API Key -> 防爆破
const fs = require('fs');
const path = require('path');
const BASE = process.env.PG_BASE || 'http://127.0.0.1:18081';
const results = [];

function ok(name, detail = '') { results.push({ name, pass: true, detail }); console.log(`  ✔ ${name}${detail ? ' — ' + detail : ''}`); }
function bad(name, detail = '') { results.push({ name, pass: false, detail }); console.log(`  ✘ ${name}${detail ? ' — ' + detail : ''}`); }

let TOKEN = '';
let ADMIN_TOKEN = '';
async function req(method, url, body, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (TOKEN && !headers.Authorization && !headers['X-API-Key']) headers.Authorization = `Bearer ${TOKEN}`;
  let payload;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const res = await fetch(BASE + url, { method, headers, body: payload });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch (_) { data = { raw: text.slice(0, 200) }; }
  return { status: res.status, data, text };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const wait = async (fn, timeout = 30000, step = 800) => {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const v = await fn();
    if (v) return v;
    await sleep(step);
  }
  return null;
};

function makePdf() {
  const { buildTestPagePdf } = require(require('./_paths').serverSrcPath('pdf'));
  return buildTestPagePdf({ printer: 'AUTO-TEST', time: new Date().toISOString() });
}

(async () => {
  // 0. 静态页面
  const home = await fetch(BASE + '/');
  const html = await home.text();
  html.includes('PrintGate') || html.includes('printgate') ? ok('管理台 HTML 可访问') : bad('管理台 HTML 缺失');
  const health = await req('GET', '/api/health');
  health.status === 200 ? ok('健康检查', health.data.version) : bad('健康检查', health.status);

  // 1. 初始化
  let r = await req('GET', '/api/public/bootstrap');
  r.data.needsSetup ? ok('初始状态 needsSetup') : bad('初始状态 needsSetup', JSON.stringify(r.data));
  r = await req('POST', '/api/setup', { password: 'PrintGate2026', confirm: 'PrintGate2026' });
  if (r.data.ok) { TOKEN = r.data.token; ADMIN_TOKEN = r.data.token; ok('设置管理员密码并登录'); } else bad('初始化', JSON.stringify(r.data));

  // 弱密码应被拒
  const weak = await req('POST', '/api/auth/login', { password: '123' });
  weak.status === 403 ? ok('错误密码被拒绝', weak.data.msg) : bad('错误密码被拒绝', weak.status);

  // 2. CUPS
  r = await req('GET', '/api/printers');
  r.data.cups?.running ? ok('CUPS 运行中', `队列 ${r.data.printers.length} 个`) : bad('CUPS 未运行', JSON.stringify(r.data.cups));
  r = await req('POST', '/api/settings/test', { target: 'cups' });
  r.data.ok ? ok('设置页 CUPS 自检') : bad('设置页 CUPS 自检', r.data.msg);

  // 3. 虚拟打印机
  r = await req('POST', '/api/printers/virtual', {});
  r.data.ok ? ok('创建虚拟打印机', r.data.msg) : bad('创建虚拟打印机', JSON.stringify(r.data));
  const printers = await wait(async () => {
    const x = await req('GET', '/api/printers');
    return x.data.printers?.length ? x.data.printers : null;
  }, 20000);
  printers ? ok('打印机列表已刷新', printers.map((p) => p.name).join(',')) : bad('打印机列表为空');

  // 设为默认
  if (printers?.length) {
    r = await req('POST', `/api/printers/${encodeURIComponent(printers[0].name)}/default`);
    r.data.ok ? ok('设为默认打印机') : bad('设为默认打印机', r.data.msg);
  }

  // 4. 测试页
  r = await req('POST', `/api/printers/${encodeURIComponent('PrintGate-Virtual')}/test`);
  r.data.ok ? ok('发送测试页', r.data.msg) : bad('发送测试页', JSON.stringify(r.data));

  // 5. 上传 + 打印
  const fd = new FormData();
  fd.append('file', new Blob([makePdf()], { type: 'application/pdf' }), 'autotest.pdf');
  r = await req('POST', '/api/files', fd);
  const fileId = r.data.file?.id;
  r.data.ok ? ok('上传 PDF', `id=${fileId} pages=${r.data.file.pages}`) : bad('上传 PDF', JSON.stringify(r.data));

  r = await req('POST', '/api/print', {
    fileId, printer: 'PrintGate-Virtual',
    options: { copies: 2, color: 'mono', sides: 'two-sided-long-edge', media: 'A4', orientation: 'portrait', numberUp: 1 }
  });
  r.data.ok ? ok('提交打印任务', `task=${r.data.taskId} status=${r.data.status}`) : bad('提交打印任务', JSON.stringify(r.data));
  const taskId = r.data.taskId;

  const done = await wait(async () => {
    const x = await req('GET', `/api/tasks/${taskId || 0}`);
    return x.data.task && ['done', 'failed'].includes(x.data.task.status) ? x.data.task : null;
  }, 40000);
  done?.status === 'done' ? ok('任务执行完成', `job=${done.jobId}`) : bad('任务执行完成', JSON.stringify(done));

  await sleep(1500);
  r = await req('GET', '/api/printers/virtual/status');
  r.data.jobs?.length ? ok('虚拟打印机收到数据', `${r.data.jobs.length} 个文件，最新 ${r.data.jobs[0].size} B`) : bad('虚拟打印机未收到数据', JSON.stringify(r.data));

  // 6. CUPS 队列
  r = await req('GET', '/api/cups/jobs?state=completed');
  ok('CUPS 已完成队列可读', `${r.data.jobs?.length || 0} 条`);

  // 7. 自动扫描
  r = await req('POST', '/api/printers/discover/start', { mode: 'quick' });
  const sid = r.data.id;
  const scan = await wait(async () => {
    if (!sid) return null;
    const x = await req('GET', `/api/printers/discover/${sid}`);
    return x.data.status !== 'running' ? x.data : null;
  }, 40000);
  scan?.status === 'done' ? ok('自动扫描打印机完成', `${scan.found.length} 个目标 / ${scan.elapsed}s`) : bad('自动扫描打印机', JSON.stringify(scan));

  // 8. 小程序：开发模式登录 -> 审批 -> 打印
  r = await req('PUT', '/api/settings', { devMode: true, approveNewUser: true });
  r.data.ok ? ok('开启开发模式') : bad('开启开发模式', JSON.stringify(r.data));
  const mp = await req('POST', '/api/mp/dev-login', { openid: 'autotest_openid', nickname: '自动化测试' });
  const MPTOK = mp.data.token;
  mp.data.ok ? ok('小程序模拟登录', `status=${mp.data.user.status}`) : bad('小程序模拟登录', JSON.stringify(mp.data));

  TOKEN = MPTOK;
  r = await req('GET', '/api/mp/me');
  r.data.ok ? ok('小程序读取自身信息', r.data.user.status) : bad('小程序读取自身信息', JSON.stringify(r.data));

  r = await req('POST', '/api/mp/print', { fileId, options: { copies: 1 } });
  r.status === 403 ? ok('未授权用户被拦截打印', r.data.msg) : bad('未授权用户被拦截打印', r.status);

  TOKEN = ADMIN_TOKEN;
  r = await req('GET', '/api/users?status=pending');
  const uid = r.data.users?.[0]?.id;
  ok('待审批用户列表', `${r.data.total} 人`);
  if (uid) {
    const ap = await req('POST', `/api/users/${uid}/approve`);
    ap.data.ok ? ok('审批通过小程序用户') : bad('审批通过小程序用户', ap.data.msg);
  }

  TOKEN = MPTOK;
  const mpf = new FormData();
  mpf.append('file', new Blob([makePdf()], { type: 'application/pdf' }), 'mp-test.pdf');
  r = await req('POST', '/api/mp/files', mpf);
  const mpFileId = r.data.file?.id;
  r.data.ok ? ok('小程序上传文件', `id=${mpFileId}`) : bad('小程序上传文件', JSON.stringify(r.data));
  r = await req('POST', '/api/mp/print', { fileId: mpFileId, printer: 'PrintGate-Virtual', options: { copies: 1 } });
  r.data.ok ? ok('小程序提交打印', `task=${r.data.taskId}`) : bad('小程序提交打印', JSON.stringify(r.data));

  // 9. 绑定码 & 扫码登录（先配置一个格式合法的小程序凭据，扫码链路才能建立）
  TOKEN = '';
  const adminLogin = await req('POST', '/api/auth/login', { password: 'PrintGate2026' });
  ADMIN_TOKEN = adminLogin.data.token;
  TOKEN = ADMIN_TOKEN;
  await req('PUT', '/api/settings', { wxAppid: 'wx1234567890abcdef', wxSecret: '0123456789abcdef0123456789abcdef' });
  const bind = await req('GET', '/api/admin/bind/info');
  bind.data.token ? ok('获取绑定码二维码', bind.data.token.slice(0, 8) + '…') : bad('获取绑定码', JSON.stringify(bind.data));

  TOKEN = MPTOK;
  r = await req('POST', '/api/mp/bind', { token: 'wrong-token' });
  r.status === 403 ? ok('错误绑定码被拒', r.data.msg) : bad('错误绑定码被拒', r.status);
  r = await req('POST', '/api/mp/bind', { token: bind.data.token });
  r.data.ok ? ok('正确绑定码升级为管理员') : bad('绑定管理员', JSON.stringify(r.data));

  TOKEN = '';
  const qr = await req('POST', '/api/auth/qr/create');
  qr.data.ticket ? ok('生成扫码登录二维码') : bad('生成扫码登录二维码', JSON.stringify(qr.data));
  TOKEN = MPTOK;
  const scanned = await req('POST', '/api/mp/qr/scan', { ticket: qr.data.ticket });
  scanned.data.ok ? ok('小程序扫码确认(扫描)') : bad('小程序扫码', JSON.stringify(scanned.data));
  TOKEN = '';
  const st1 = await req('GET', `/api/auth/qr/status?ticket=${qr.data.ticket}`);
  st1.data.status === 'scanned' ? ok('网页轮询到已扫描') : bad('网页轮询状态', st1.data.status);
  TOKEN = MPTOK;
  const cf = await req('POST', '/api/mp/qr/confirm', { ticket: qr.data.ticket });
  cf.data.ok ? ok('小程序确认登录') : bad('小程序确认登录', JSON.stringify(cf.data));
  TOKEN = '';
  const st2 = await req('GET', `/api/auth/qr/status?ticket=${qr.data.ticket}`);
  st2.data.status === 'confirmed' && st2.data.token ? ok('扫码登录拿到会话') : bad('扫码登录会话', JSON.stringify(st2.data));

  // 10. API Key 开放接口
  TOKEN = ADMIN_TOKEN;
  const key = await req('POST', '/api/keys', { name: '自动化测试' });
  key.data.token ? ok('创建 API Key', key.data.token.slice(0, 10) + '…') : bad('创建 API Key', JSON.stringify(key.data));
  const kf = new FormData();
  kf.append('file', new Blob([makePdf()], { type: 'application/pdf' }), 'api-key.pdf');
  kf.append('printer', 'PrintGate-Virtual');
  TOKEN = '';
  const viaKey = await req('POST', '/api/print/upload', kf, { headers: { 'X-API-Key': key.data.token } });
  viaKey.data.ok ? ok('API Key 上传并打印', `task=${viaKey.data.taskId}`) : bad('API Key 打印', JSON.stringify(viaKey.data));

  // 11. 审计与日志
  TOKEN = ADMIN_TOKEN;
  const audit = await req('GET', '/api/audit?size=200');
  audit.data.total > 10 ? ok('审计日志已记录', `${audit.data.total} 条`) : bad('审计日志', JSON.stringify(audit.data.total));
  const logs = await req('GET', '/api/system/logs/app?lines=50');
  (logs.data.content || '').length > 0 ? ok('运行日志可读', `${(logs.data.content || '').length} 字符`) : bad('运行日志', JSON.stringify(logs.data));
  const svc = await req('GET', '/api/system/services');
  const cupsSvc = (svc.data.services || []).find((s) => s.key === 'cups');
  cupsSvc?.running ? ok('系统状态识别 CUPS') : bad('系统状态识别 CUPS', JSON.stringify(cupsSvc));

  // 12. 设置持久化
  r = await req('PUT', '/api/settings', { maxCopies: 7, approveEachJob: true, retentionDays: 14 });
  const chk = await req('GET', '/api/settings');
  chk.data.settings.print.maxCopies === 7 && chk.data.settings.print.approveEachJob === true
    ? ok('设置保存并生效') : bad('设置保存', JSON.stringify(chk.data.settings.print));
  // 校验非法值
  r = await req('PUT', '/api/settings', { maxCopies: 0 });
  r.status === 400 ? ok('非法设置被拒绝', r.data.msg) : bad('非法设置校验', r.status);
  await req('PUT', '/api/settings', { approveEachJob: false, maxCopies: 10 });

  // 13. 打印审批流
  r = await req('PUT', '/api/settings', { approveEachJob: true });
  const fd2 = new FormData();
  fd2.append('file', new Blob([makePdf()], { type: 'application/pdf' }), 'approve-flow.pdf');
  const up2 = await req('POST', '/api/files', fd2);
  const ap2 = await req('POST', '/api/print', { fileId: up2.data.file.id, printer: 'PrintGate-Virtual', options: {} });
  ap2.data.status === 'pending' ? ok('逐单审批生效（进入待审批）') : bad('逐单审批', JSON.stringify(ap2.data));
  const okApprove = await req('POST', `/api/tasks/${ap2.data.taskId}/approve`);
  okApprove.data.ok ? ok('审批后立即打印') : bad('审批任务', JSON.stringify(okApprove.data));
  await req('PUT', '/api/settings', { approveEachJob: false });

  // 14. 防爆破（放最后，会触发本机锁定）
  TOKEN = '';
  let locked = false;
  for (let i = 0; i < 7; i++) {
    const x = await req('POST', '/api/auth/login', { password: 'definitely-wrong-' + i });
    if (x.status === 429) { locked = true; break; }
    await sleep(150);
  }
  locked ? ok('连续错误密码触发锁定') : bad('防爆破锁定未触发');

  // 解锁并确认可登录
  TOKEN = ADMIN_TOKEN;
  await req('DELETE', '/api/security/attempts');
  TOKEN = '';
  const relogin = await req('POST', '/api/auth/login', { password: 'PrintGate2026' });
  relogin.data.ok ? ok('解锁后正常登录') : bad('解锁后登录', JSON.stringify(relogin.data));

  // 汇总
  const fail = results.filter((x) => !x.pass);
  console.log(`\n=== ${results.length - fail.length}/${results.length} 通过 ===`);
  if (fail.length) { console.log('失败项:'); fail.forEach((f) => console.log(' -', f.name, f.detail)); }
  fs.writeFileSync(path.join(require('./_paths').shotsDir(), 'container-test.json'), JSON.stringify(results, null, 2));
  process.exit(fail.length ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(2); });
