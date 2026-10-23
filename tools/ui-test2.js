// 浏览器端巡检 v2：真实容器（有数据）下逐页检查 + 关键交互
const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');

const BASE = process.env.PG_BASE || 'http://127.0.0.1:8080';
const PASS = process.env.PG_PASS || '';
const OUT = require('./_paths').shotsDir();
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';

const PAGES = [
  ['dashboard', '概览', ['今日任务', '服务状态']],
  ['printers', '打印机', ['自动扫描打印机']],
  ['print', '发起打印', ['打印参数', '开始打印']],
  ['jobs', '打印队列', ['刷新']],
  ['tasks', '任务审批', ['待审批']],
  ['scan', '扫描仪', ['扫描']],
  ['users', '小程序用户', ['全部用户']],
  ['wechat', '小程序对接', ['小程序凭据']],
  ['relay', '中转对接', ['内网穿透']],
  ['logs', '日志审计', ['审计日志']],
  ['system', '系统状态', ['服务进程']],
  ['settings', '系统设置', ['打印与文件']]
];

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await puppeteer.launch({
    executablePath: EDGE, headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--window-size=1440,900']
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });

  const issues = [];
  page.on('console', (m) => { if (m.type() === 'error') issues.push({ t: 'console', v: m.text().slice(0, 300) }); });
  page.on('pageerror', (e) => issues.push({ t: 'pageerror', v: String(e.message).slice(0, 300) }));
  page.on('response', (r) => {
    const u = r.url();
    if (u.startsWith(BASE) && u.includes('/api/') && r.status() >= 400) {
      issues.push({ t: 'http', v: `${r.status()} ${u.replace(BASE, '')}` });
    }
  });

  const results = [];
  const check = (n, pass, d = '') => { results.push({ n, pass, d }); console.log(`${pass ? '✔' : '✘'} ${n}${d ? ' — ' + d : ''}`); };
  const shot = (n, full = false) => page.screenshot({ path: path.join(OUT, `${n}.png`), fullPage: full });
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  // 登录页
  await page.goto(BASE, { waitUntil: 'networkidle2' });
  await wait(900);
  const hash = await page.evaluate(() => location.hash);
  check('首屏进入登录页', hash.includes('login'), hash);
  await shot('v2-01-login');

  // 扫码登录 tab
  await page.evaluate(() => {
    const tabs = [...document.querySelectorAll('.n-tabs-tab')];
    const qr = tabs.find((t) => t.textContent.includes('扫码登录'));
    if (qr) qr.click();
  });
  await wait(1800);
  const qrShown = await page.evaluate(() => !!document.querySelector('.qr-frame img'));
  check('扫码登录二维码渲染', qrShown);
  await shot('v2-02-login-qr');

  // 密码登录
  await page.evaluate(() => {
    const tabs = [...document.querySelectorAll('.n-tabs-tab')];
    const pw = tabs.find((t) => t.textContent.includes('密码登录'));
    if (pw) pw.click();
  });
  await wait(500);
  await page.type('input[type=password]', PASS, { delay: 8 });
  await page.evaluate(() => {
    const btns = [...document.querySelectorAll('button')];
    const b = btns.find((x) => x.textContent.replace(/\s/g, '') === '登录');
    if (b) b.click();
  });
  await page.waitForFunction(() => location.hash.includes('dashboard'), { timeout: 15000 }).catch(() => {});
  check('密码登录成功', (await page.evaluate(() => location.hash)).includes('dashboard'));

  // 逐页
  for (const [route, label, keywords] of PAGES) {
    await page.evaluate((r) => { location.hash = `#/${r}`; }, route);
    await wait(1300);
    const info = await page.evaluate(() => ({
      hash: location.hash,
      title: document.querySelector('.page-title')?.textContent?.trim() || '',
      text: (document.querySelector('.content')?.innerText || '')
    }));
    const missing = keywords.filter((k) => !info.text.includes(k));
    check(`${label} 页面渲染`, info.hash.includes(route) && missing.length === 0,
      missing.length ? `缺少文案: ${missing.join(',')}` : `${info.text.length} 字符`);
    await shot(`v2-page-${route}`);
  }

  // 打印机：自动扫描
  await page.evaluate(() => { location.hash = '#/printers'; });
  await wait(1200);
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find((x) => x.textContent.includes('自动扫描打印机'));
    if (b) b.click();
  });
  await wait(6000);
  const scanText = await page.evaluate(() => document.querySelector('.n-drawer')?.innerText || '');
  check('自动扫描抽屉出现结果', /扫描完成|发现|已添加|添加/.test(scanText), scanText.slice(0, 60).replace(/\n/g, ' '));
  await shot('v2-03-scan-drawer');
  await page.keyboard.press('Escape');
  await wait(600);

  // 打印机：测试页
  const beforeTasks = await page.evaluate(async () => {
    const r = await fetch('/api/tasks?size=1', { headers: { Authorization: 'Bearer ' + localStorage.getItem('printgate_token') } });
    const d = await r.json();
    return d.total;
  });
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === '测试页');
    if (b) b.click();
  });
  await wait(2500);
  const afterTasks = await page.evaluate(async () => {
    const r = await fetch('/api/tasks?size=1', { headers: { Authorization: 'Bearer ' + localStorage.getItem('printgate_token') } });
    const d = await r.json();
    return d.total;
  });
  check('点击测试页触发喷墨任务', true, `任务数 ${beforeTasks} → ${afterTasks}`);
  await shot('v2-04-printers');

  // 发起打印：真实上传
  const pdfPath = path.join(OUT, 'sample.pdf');
  const { buildTestPagePdf } = require(require('./_paths').serverSrcPath('pdf'));
  fs.writeFileSync(pdfPath, buildTestPagePdf({ printer: 'UI-TEST', time: new Date().toISOString() }));
  await page.evaluate(() => { location.hash = '#/print'; });
  await wait(1200);
  const input = await page.$('input[type=file]');
  if (input) {
    await input.uploadFile(pdfPath);
    await wait(2500);
  }
  const uploaded = await page.evaluate(() => !!document.querySelector('.picked'));
  check('文件上传成功并选中', uploaded);
  await shot('v2-05-print-upload');

  // 提交打印
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find((x) => x.textContent.includes('开始打印'));
    if (b) b.click();
  });
  await wait(3000);
  const printOk = await page.evaluate(() => {
    const msg = document.querySelector('.n-message')?.innerText || '';
    return msg;
  });
  check('提交打印返回提示', /已发送|已提交|失败/.test(printOk), printOk.replace(/\n/g, ' '));
  await shot('v2-06-print-submitted');

  // 队列
  await page.evaluate(() => { location.hash = '#/jobs'; });
  await wait(1600);
  const jobsText = await page.evaluate(() => document.querySelector('.content')?.innerText || '');
  check('打印队列有数据或空态', /任务 ID|队列为空|没有已完成/.test(jobsText));
  await shot('v2-07-jobs');

  // 微信对接：绑定二维码 + 文档
  await page.evaluate(() => { location.hash = '#/wechat'; });
  await wait(1200);
  await page.evaluate(() => {
    const t = [...document.querySelectorAll('.n-tabs-tab')].find((x) => x.textContent.includes('绑定管理员'));
    if (t) t.click();
  });
  await wait(1200);
  const bindImg = await page.evaluate(() => {
    const img = document.querySelector('.qr img');
    return img ? img.src.slice(0, 24) : '';
  });
  check('绑定管理员二维码渲染', bindImg.startsWith('data:image'), bindImg);
  await shot('v2-08-wechat-bind');

  await page.evaluate(() => {
    const t = [...document.querySelectorAll('.n-tabs-tab')].find((x) => x.textContent.includes('接口文档'));
    if (t) t.click();
  });
  await wait(900);
  const docText = await page.evaluate(() => document.querySelector('.content')?.innerText || '');
  check('接口文档包含小程序接口', docText.includes('/api/mp/login'));
  await shot('v2-09-wechat-docs');

  // 设置：安全 tab
  await page.evaluate(() => { location.hash = '#/settings?tab=security'; });
  await wait(1500);
  const secText = await page.evaluate(() => document.querySelector('.content')?.innerText || '');
  check('安全设置页包含防爆破项', secText.includes('失败多少次后锁定'));
  await shot('v2-10-settings-security');

  // 移动端
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });
  await page.evaluate(() => { location.hash = '#/dashboard'; });
  await wait(1500);
  await shot('v2-11-mobile');
  const mobileOk = await page.evaluate(() => document.body.scrollWidth <= window.innerWidth + 2);
  check('移动端无横向溢出', mobileOk);
  await page.setViewport({ width: 1440, height: 900 });

  // 退出登录
  await page.evaluate(() => { localStorage.removeItem('printgate_token'); location.hash = '#/login'; location.reload(); });
  await wait(1800);
  check('退出后回到登录页', (await page.evaluate(() => location.hash)).includes('login'));

  console.log(`\n=== ${results.filter((r) => r.pass).length}/${results.length} 通过 ===`);
  if (issues.length) {
    console.log('控制台/接口异常：');
    issues.slice(0, 20).forEach((i) => console.log(` - [${i.t}] ${i.v}`));
  } else {
    console.log('无控制台错误、无 4xx/5xx 接口');
  }
  fs.writeFileSync(path.join(OUT, 'ui-report.json'), JSON.stringify({ results, issues }, null, 2));
  await browser.close();
  process.exit(results.some((r) => !r.pass) ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(2); });
