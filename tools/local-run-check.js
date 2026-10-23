// 本地实跑：初始化 → 建虚拟打印机 → 打印 → 小程序链路 → 截图
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');

const BASE = 'http://127.0.0.1:8080';
const PASS = process.env.PG_PASS || 'LocalTest2026';
const OUT = require('./_paths').shotsDir();
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
let TOKEN = '';
const rows = [];
const rec = (n, p, d = '') => { rows.push({ n, p, d }); console.log(`${p ? '✔' : '✘'} ${n}${d ? ' — ' + d : ''}`); };

async function req(method, url, body, token = TOKEN) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  let payload;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const res = await fetch(BASE + url, { method, headers, body: payload });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch (_) { data = { raw: text.slice(0, 200) }; }
  return { status: res.status, data };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, timeout = 30000, step = 800) => {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) { const v = await fn(); if (v) return v; await sleep(step); }
  return null;
};
const { buildTestPagePdf } = require(require('./_paths').serverSrcPath('pdf'));

(async () => {
  console.log('=== 1. 服务与初始化 ===');
  let r = await req('GET', '/api/health', undefined, '');
  rec('健康检查', r.status === 200, `v${r.data.version}`);
  r = await req('GET', '/api/public/bootstrap', undefined, '');
  if (r.data.needsSetup) {
    r = await req('POST', '/api/setup', { password: PASS, confirm: PASS }, '');
    rec('初始化管理员密码', r.status === 200, r.data.msg || '');
    TOKEN = r.data.token;
  } else {
    r = await req('POST', '/api/auth/login', { password: PASS }, '');
    rec('登录已有实例', !!r.data.ok, r.data.msg || '');
    TOKEN = r.data.token;
  }
  r = await req('GET', '/api/dashboard');
  rec('读取概览', r.status === 200, `用户 ${r.data.counts.users} · 任务 ${r.data.counts.tasksTotal}`);

  console.log('\n=== 2. 打印机 ===');
  r = await req('GET', '/api/printers');
  rec('CUPS 运行', !!r.data.cups.running, r.data.cups.message);
  if (!(r.data.printers || []).length) {
    r = await req('POST', '/api/printers/virtual', {});
    rec('创建虚拟打印机', !!r.data.ok, r.data.msg || '');
    await sleep(1200);
  }
  r = await req('GET', '/api/printers');
  const vp = (r.data.printers || []).find((p) => p.name === 'PrintGate-Virtual');
  rec('队列就绪', !!vp, vp ? `${vp.name} / ${vp.state}` : '未找到');

  console.log('\n=== 3. 打印链路 ===');
  r = await req('POST', '/api/printers/PrintGate-Virtual/test');
  rec('发送测试页', !!r.data.ok, r.data.msg || '');

  const fd = new FormData();
  fd.append('file', new Blob([buildTestPagePdf({ printer: 'LOCAL', time: new Date().toLocaleString('zh-CN') })], { type: 'application/pdf' }), '本地测试-报价单.pdf');
  r = await req('POST', '/api/files', fd);
  const fileId = r.data.file && r.data.file.id;
  rec('上传中文名 PDF', !!r.data.ok, `${r.data.file && r.data.file.filename} · ${r.data.file && r.data.file.pages} 页`);

  r = await req('POST', '/api/print', {
    fileId, printer: 'PrintGate-Virtual',
    options: { copies: 2, color: 'mono', sides: 'two-sided-long-edge', media: 'A4', numberUp: 2, pageBorder: true }
  });
  const taskId = r.data.taskId;
  rec('提交打印（2 份·双面·2页合1）', !!r.data.ok, `task=${taskId}`);

  const done = await waitFor(async () => {
    const x = await req('GET', `/api/tasks/${taskId}`);
    return x.data.task && ['done', 'failed'].includes(x.data.task.status) ? x.data.task : null;
  }, 40000);
  rec('任务收尾为已完成', done && done.status === 'done', done ? `${done.status} job=${done.jobId}` : '超时');

  await sleep(1500);
  r = await req('GET', '/api/printers/virtual/status');
  rec('虚拟打印机收到数据', (r.data.jobs || []).length >= 2, `${(r.data.jobs || []).length} 个文件`);

  r = await req('GET', '/api/cups/jobs?state=completed');
  rec('CUPS 完成任务可见', (r.data.jobs || []).length >= 2, `${(r.data.jobs || []).length} 条`);

  r = await req('GET', `/api/files/${fileId}/preview`);
  rec('任务预览可用', r.status === 200, `HTTP ${r.status}`);

  console.log('\n=== 4. 小程序链路 ===');
  r = await req('GET', '/api/wechat/config');
  rec('读取接入配置', !!r.data.ok, `bind=${(r.data.config.bindToken || '').slice(0, 8)}…`);
  r = await req('PUT', '/api/wechat/config', {
    appid: 'wx1234567890abcdef', secret: '0123456789abcdef0123456789abcdef',
    baseUrl: 'http://127.0.0.1:8080', adminOpenids: [], approveNewUser: true, enableQrLogin: true, devMode: true
  });
  rec('保存接入参数', !!r.data.ok, r.data.msg || '');

  // 每次用新 openid，保证「未审批」场景可复现
  const probeOpenid = `local_test_${Date.now()}`;
  r = await req('POST', '/api/mp/dev-login', { openid: probeOpenid, nickname: '本地测试' }, '');
  const mpTok = r.data.token;
  rec('模拟微信登录', !!r.data.ok && r.data.user.status === 'pending', `状态 ${r.data.user && r.data.user.status}`);

  r = await req('POST', '/api/mp/files', (() => {
    const f = new FormData();
    f.append('file', new Blob([buildTestPagePdf({ printer: 'MP' })], { type: 'application/pdf' }), '小程序上传.pdf');
    return f;
  })(), mpTok);
  rec('未审批时上传被拦', r.status === 403, `HTTP ${r.status}`);

  r = await req('GET', '/api/users?status=pending');
  const uid = (r.data.users || [])[0] && r.data.users[0].id;
  if (uid) {
    r = await req('POST', `/api/users/${uid}/approve`);
    rec('管理员审批通过', !!r.data.ok);
  }

  r = await req('POST', '/api/mp/files', (() => {
    const f = new FormData();
    f.append('file', new Blob([buildTestPagePdf({ printer: 'MP' })], { type: 'application/pdf' }), '小程序上传.pdf');
    return f;
  })(), mpTok);
  const mpFile = r.data.file && r.data.file.id;
  rec('审批后上传成功', !!r.data.ok, r.data.file && r.data.file.filename);
  r = await req('POST', '/api/mp/print', { fileId: mpFile, printer: 'PrintGate-Virtual', options: { copies: 1 } }, mpTok);
  rec('小程序提交打印', !!r.data.ok, r.data.msg || '');

  console.log('\n=== 5. 审计与安全 ===');
  r = await req('GET', '/api/audit?size=100');
  rec('审计日志有记录', r.data.total > 5, `${r.data.total} 条`);
  const headers = await fetch(BASE + '/');
  rec('安全响应头', !!headers.headers.get('content-security-policy') && !!headers.headers.get('x-content-type-options'));

  // ---------- 截图 ----------
  console.log('\n=== 6. 浏览器实拍 ===');
  const browser = await puppeteer.launch({ executablePath: EDGE, headless: 'new', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 120)); });
  await page.setViewport({ width: 1440, height: 900 });

  await page.goto(BASE, { waitUntil: 'networkidle2' });
  await sleep(700);
  await page.type('input[type=password]', PASS, { delay: 6 });
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find((x) => x.textContent.replace(/\s/g, '') === '登录');
    b && b.click();
  });
  await page.waitForFunction(() => location.hash.includes('dashboard'), { timeout: 12000 }).catch(() => {});
  await sleep(1500);
  await page.screenshot({ path: path.join(OUT, 'run-01-dashboard.png') });
  rec('登录并进入概览', (await page.evaluate(() => location.hash)).includes('dashboard'));

  for (const [hash, name] of [['#/printers', 'run-02-printers'], ['#/wechat', 'run-03-wechat'], ['#/tasks', 'run-04-tasks'], ['#/jobs', 'run-05-jobs']]) {
    await page.evaluate((h) => { location.hash = h; }, hash);
    await sleep(1400);
    await page.screenshot({ path: path.join(OUT, `${name}.png`) });
  }
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });
  await page.evaluate(() => { location.hash = '#/wechat'; });
  await sleep(1300);
  await page.screenshot({ path: path.join(OUT, 'run-06-wechat-mobile.png') });
  rec('移动端无横向溢出', await page.evaluate(() => document.body.scrollWidth <= window.innerWidth + 2));
  rec('无控制台错误', errs.length === 0, errs.slice(0, 2).join(' | '));
  await browser.close();

  const fail = rows.filter((x) => !x.p);
  console.log(`\n=== ${rows.length - fail.length}/${rows.length} 通过 ===`);
  if (fail.length) fail.forEach((f) => console.log(` - ${f.n}：${f.d}`));
  fs.writeFileSync(path.join(OUT, 'local-run.json'), JSON.stringify(rows, null, 2));
  process.exit(fail.length ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(2); });
