'use strict';
// 中转向导 UI 回归：五步流程、配置片段、自检、截图
// 用法：PG_BASE=http://127.0.0.1:8080 PG_PASS=xxx node tools/ui-relay-test.js
// 注意：要在「已初始化且从未填过 frp 服务端/Token」的实例上跑。
// 向导第 3 步的「缺少服务端/Token 时拦截下一步」依赖空配置，
// 实例里一旦存过 frpServer/frpToken（空串在设置接口里代表「不修改」），这项就会失去前提。
const puppeteer = require('puppeteer-core');

const BASE = process.env.PG_BASE || 'http://127.0.0.1:8080';
const PASS = process.env.PG_PASS || 'LocalTest2026';
const SHOTS = process.env.PG_SHOTS || require('./_paths').shotsDir();

const results = [];
const rec = (name, pass, detail = '') => {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  —  ${detail}` : ''}`);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function setInput(page, selectorText, value) {
  return page.evaluate((sel, v) => {
    const inputs = [...document.querySelectorAll('.n-input input')];
    const el = inputs.find((i) => (i.placeholder || '').includes(sel));
    if (!el) return false;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('blur', { bubbles: true }));
    return true;
  }, selectorText, value);
}

(async () => {
  const browser = await puppeteer.launch({
    executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    headless: 'new', args: ['--no-sandbox']
  });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message.slice(0, 200)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)); });
  page.on('response', (r) => { if (r.status() >= 400) errors.push(`HTTP ${r.status()} ${r.url().replace(BASE, '')}`); });
  await page.setViewport({ width: 1440, height: 950 });

  await page.goto(BASE, { waitUntil: 'networkidle2' });
  await wait(900);
  if (await page.$('input[type=password]')) {
    await page.type('input[type=password]', PASS, { delay: 8 });
    await page.evaluate(() => {
      const b = [...document.querySelectorAll('button')].find((x) => x.textContent.replace(/\s/g, '') === '登录');
      b && b.click();
    });
    await wait(2200);
  }
  await page.evaluate(() => { location.hash = '#/relay'; });
  await wait(1600);

  const stepTitles = await page.evaluate(() => [...document.querySelectorAll('.n-steps .n-step')].map((x) => x.innerText.replace(/\n/g, ' ')));
  rec('五步向导渲染', stepTitles.length === 5, stepTitles.map((t) => t.split(' ')[0]).join(' → '));
  rec('步骤 1 出现模式卡片', await page.evaluate(() => document.querySelectorAll('.mode-card').length === 2));
  await page.screenshot({ path: `${SHOTS}/v6-01-relay-step1.png` }).catch(() => {});

  // 选单端口
  await page.evaluate(() => {
    const c = [...document.querySelectorAll('.mode-card')].find((x) => x.textContent.includes('单端口 443'));
    c && c.click();
  });
  await wait(700);
  rec('单端口卡片选中', await page.evaluate(() =>
    [...document.querySelectorAll('.mode-card')].some((x) => x.classList.contains('on') && x.textContent.includes('单端口'))));

  // 第 2 步
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('.wizard-foot button')].find((x) => x.textContent.includes('下一步'));
    b && b.click();
  });
  await wait(700);
  const filled = await setInput(page, 'print.example.com', 'print.mydomain.com');
  await wait(600);
  const baseVal = await page.evaluate(() => {
    const i = [...document.querySelectorAll('.n-input input')].find((x) => (x.placeholder || '').includes('https://print'));
    return i ? i.value : '';
  });
  rec('填域名后 BASE 自动补全', filled && baseVal === 'https://print.mydomain.com', baseVal);
  await page.screenshot({ path: `${SHOTS}/v6-02-relay-step2.png` }).catch(() => {});

  // 第 3 步
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('.wizard-foot button')].find((x) => x.textContent.includes('下一步'));
    b && b.click();
  });
  await wait(1600);
  const frpsCode = await page.evaluate(() => {
    const pre = [...document.querySelectorAll('pre.code')].map((p) => p.innerText).join('\n');
    return pre;
  });
  rec('第 3 步展示 frps.toml', /bindPort = 7000/.test(frpsCode) && /auth.token/.test(frpsCode), '');
  rec('wss 模式 frps 绑定 127.0.0.1', /proxyBindAddr = "127\.0\.0\.1"/.test(frpsCode));
  rec('frps 片段提醒不要开 tls.force', /不要加 transport\.tls\.force/.test(frpsCode));

  // 必填校验：没填服务端与 Token 时不应进入下一步
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('.wizard-foot button')].find((x) => x.textContent.includes('下一步'));
    b && b.click();
  });
  await wait(900);
  const stillStep3 = await page.evaluate(() => !document.body.innerText.includes('② 云服务器上的 nginx 配置'));
  rec('缺少服务端/Token 时拦截下一步', stillStep3);

  await setInput(page, 'print.example.com', 'print.mydomain.com');
  await setInput(page, '建议 32 位以上随机串', 'relay-ui-token-1234567890abcdef');
  await wait(600);
  await page.screenshot({ path: `${SHOTS}/v6-03-relay-step3.png` }).catch(() => {});

  // 第 4 步
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('.wizard-foot button')].find((x) => x.textContent.includes('下一步'));
    b && b.click();
  });
  await wait(1600);
  const nginxCode = await page.evaluate(() => [...document.querySelectorAll('pre.code')].map((p) => p.innerText).join('\n'));
  rec('第 4 步展示 nginx 片段', /listen 443 ssl/.test(nginxCode), '');
  rec('nginx 含 /~!frp 转发', /location \/~!frp/.test(nginxCode) && /Upgrade \$http_upgrade/.test(nginxCode));
  rec('nginx 含上传上限', /client_max_body_size/.test(nginxCode));
  await page.screenshot({ path: `${SHOTS}/v6-04-relay-step4.png` }).catch(() => {});

  // 第 5 步：自检
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('.wizard-foot button')].find((x) => x.textContent.includes('下一步'));
    b && b.click();
  });
  // 自检包含公网回连，最坏要等 DNS/连接超时，这里轮询等结果
  let checkNames = [];
  for (let i = 0; i < 24; i++) {
    await wait(1000);
    checkNames = await page.evaluate(() => [...document.querySelectorAll('.check-item .ck-name')].map((x) => x.innerText.split('\n')[0]));
    if (checkNames.length >= 5) break;
  }
  rec('第 5 步自动跑自检', checkNames.length >= 5, checkNames.join(' | ').slice(0, 120));
  rec('自检含公网回连项', checkNames.some((n) => n.includes('公网回连')));
  await page.screenshot({ path: `${SHOTS}/v6-05-relay-step5.png` }).catch(() => {});

  // 移动端
  const m = await browser.newPage();
  await m.setViewport({ width: 390, height: 844, isMobile: true });
  await m.goto(BASE, { waitUntil: 'networkidle2' });
  await wait(1000);
  await m.evaluate(() => { location.hash = '#/relay'; });
  await wait(1600);
  const overflow = await m.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  rec('移动端无横向溢出', !overflow, overflow ? '出现横向滚动' : '');
  await m.screenshot({ path: `${SHOTS}/v6-06-relay-mobile.png` }).catch(() => {});

  const real = errors.filter((e) => !/favicon/.test(e));
  rec('无 JS 报错 / 4xx', real.length === 0, real.slice(0, 3).join(' ; '));

  const fails = results.filter((x) => !x.pass);
  console.log(`\n总计 ${results.length} 项，失败 ${fails.length} 项`);
  if (fails.length) fails.forEach((f) => console.log(' -', f.name, f.detail));
  await browser.close();
  require('fs').writeFileSync(require('./_paths').shot('relay-ui.json'), JSON.stringify(results, null, 2));
  process.exit(fails.length ? 1 : 0);
})();
