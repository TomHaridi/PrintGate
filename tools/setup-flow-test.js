// 首次部署：通过浏览器完成初始化向导，验证弱密码拦截、成功跳转与后台可用性
const puppeteer = require('puppeteer-core');
const path = require('path');
const BASE = process.env.PG_BASE || 'http://127.0.0.1:8081';
const OUT = require('./_paths').shotsDir();
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';

(async () => {
  const browser = await puppeteer.launch({
    executablePath: EDGE, headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage']
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 200)); });
  // 记下具体是哪个接口返回 4xx/5xx，否则只看到「Failed to load resource」没法定位
  page.on('response', (r) => {
    // 弱密码那一步本就要 400，属预期拒绝，不计入错误
    if (r.url().includes('/api/setup')) return;
    if (r.status() >= 400 && r.url().includes('/api/')) errs.push(`${r.status()} ${r.request().method()} ${r.url().replace(BASE, '')}`);
  });

  const ok = (n, p, d = '') => console.log(`${p ? '✔' : '✘'} ${n}${d ? ' — ' + d : ''}`);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  await page.goto(BASE, { waitUntil: 'networkidle2' });
  await wait(900);
  ok('首屏进入初始化向导', (await page.evaluate(() => location.hash)).includes('setup'));
  await page.screenshot({ path: path.join(OUT, 'v3-01-setup.png') });

  // 弱密码：直接点提交应给出提示
  const inputs = await page.$$('input[type=password]');
  await inputs[0].type('short', { delay: 10 });
  await inputs[1].type('short', { delay: 10 });
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find((x) => x.textContent.includes('完成初始化'));
    b && b.click();
  });
  await wait(1200);
  const weakMsg = await page.evaluate(() => document.querySelector('.n-message')?.innerText || '');
  ok('弱密码被拦截并提示', /至少 8 位|字母和数字/.test(weakMsg), weakMsg.replace(/\n/g, ' '));
  ok('仍停留在初始化页', (await page.evaluate(() => location.hash)).includes('setup'));

  // 清空后输入合规密码
  await page.evaluate(() => document.querySelectorAll('input[type=password]').forEach((i) => {
    i.value = '';
    i.dispatchEvent(new Event('input', { bubbles: true }));
  }));
  const inputs2 = await page.$$('input[type=password]');
  await inputs2[0].type('Local2026pass', { delay: 8 });
  await inputs2[1].type('Local2026pass', { delay: 8 });
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find((x) => x.textContent.includes('完成初始化'));
    b && b.click();
  });
  await page.waitForFunction(() => location.hash.includes('dashboard'), { timeout: 15000 }).catch(() => {});
  ok('初始化完成并进入后台', (await page.evaluate(() => location.hash)).includes('dashboard'));
  await wait(1500);
  await page.screenshot({ path: path.join(OUT, 'v3-02-after-setup.png') });

  // 首次进入应提示添加打印机 / 小程序未配置
  const dash = await page.evaluate(() => document.querySelector('.content')?.innerText || '');
  ok('概览显示空态与引导', /今日打印任务|服务状态/.test(dash));
  const side = await page.evaluate(() => document.querySelector('.sider-foot')?.innerText || '');
  ok('侧栏状态提示 CUPS/小程序', /CUPS/.test(side) && /小程序/.test(side), side.replace(/\n/g, ' '));

  // 未添加打印机时去发起打印页，应提示先添加
  await page.evaluate(() => { location.hash = '#/print'; });
  await wait(1400);
  const printTxt = await page.evaluate(() => document.querySelector('.content')?.innerText || '');
  ok('无打印机时发起打印页给出提示', /还没有可用打印机/.test(printTxt));

  // 创建虚拟打印机后即可打印
  await page.evaluate(() => { location.hash = '#/printers'; });
  await wait(1200);
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find((x) => x.textContent.includes('创建虚拟打印机'));
    b && b.click();
  });
  await wait(4000);
  const pTxt = await page.evaluate(() => document.querySelector('.content')?.innerText || '');
  ok('一键创建虚拟打印机成功', /PrintGate-Virtual/.test(pTxt), pTxt.slice(0, 60).replace(/\n/g, ' '));
  await page.screenshot({ path: path.join(OUT, 'v3-03-virtual-printer.png') });

  // 刷新后仍保持登录（token 持久化）
  await page.reload({ waitUntil: 'networkidle2' });
  await wait(1500);
  ok('刷新后保持登录态', !(await page.evaluate(() => location.hash)).includes('login'));

  // 退出登录
  await page.evaluate(() => { localStorage.removeItem('printgate_token'); location.hash = '#/login'; });
  await wait(1200);
  ok('退出后回到登录页', (await page.evaluate(() => location.hash)).includes('login'));

  // 用新密码重新登录
  await page.type('input[type=password]', 'Local2026pass', { delay: 8 });
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find((x) => x.textContent.replace(/\s/g, '') === '登录');
    b && b.click();
  });
  await page.waitForFunction(() => location.hash.includes('dashboard'), { timeout: 12000 }).catch(() => {});
  ok('新密码可登录', (await page.evaluate(() => location.hash)).includes('dashboard'));

  if (errs.length) {
    console.log('控制台错误：');
    [...new Set(errs)].slice(0, 8).forEach((e) => console.log(' -', e));
  } else {
    console.log('无控制台错误');
  }
  await browser.close();
})().catch((e) => { console.error('FATAL', e); process.exit(2); });
