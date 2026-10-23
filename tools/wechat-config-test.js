// 小程序接入页（统一参数）验证：布局、保存回读、校验、清除密钥、绑定码、其它页收敛
const fs = require('fs');
const path = require('path');

const BASE = process.env.PG_BASE || 'http://127.0.0.1:8080';
const PASS = process.env.PG_PASS || '';
const OUT = require('./_paths').shotsDir();
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';

let TOKEN = '';
const results = [];
const rec = (n, p, d = '') => { results.push({ n, p, d }); console.log(`${p ? '✔' : '✘'} ${n}${d ? ' — ' + d : ''}`); };

async function req(method, url, body, token = TOKEN) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  let payload;
  if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const res = await fetch(BASE + url, { method, headers, body: payload });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch (_) { data = { raw: text.slice(0, 160) }; }
  return { status: res.status, data };
}

(async () => {
  // ---------- 接口层 ----------
  let r = await req('GET', '/api/wechat/config', undefined, '');
  rec('未授权读取接入配置 401', r.status === 401, String(r.status));

  r = await req('POST', '/api/auth/login', { password: PASS }, '');
  TOKEN = r.data.token || '';
  rec('登录', !!TOKEN, r.data.msg || '');

  r = await req('GET', '/api/wechat/config');
  const c0 = r.data.config || {};
  rec('读取聚合配置', r.data.ok && 'bindToken' in c0 && 'stats' in c0, `appid=${c0.appid || '空'}`);

  r = await req('PUT', '/api/wechat/config', { appid: 'not-an-appid' });
  rec('AppID 格式校验 400', r.status === 400, r.data.msg || '');
  r = await req('PUT', '/api/wechat/config', { baseUrl: 'ftp://x' });
  rec('接入地址协议校验 400', r.status === 400, r.data.msg || '');
  r = await req('PUT', '/api/wechat/config', { secret: 'short' });
  rec('AppSecret 长度校验 400', r.status === 400, r.data.msg || '');
  r = await req('PUT', '/api/wechat/config', { adminOpenids: ['x'] });
  rec('可疑 OpenID 被拒', r.status === 400, r.data.msg || '');

  r = await req('PUT', '/api/wechat/config', {
    appid: 'wx1234567890abcdef', secret: '0123456789abcdef0123456789abcdef',
    baseUrl: 'http://127.0.0.1:9090/', adminOpenids: ['oTestABC123456789', 'oTestDEF123456789'],
    approveNewUser: true, enableQrLogin: true, devMode: false
  });
  const c1 = r.data.config || {};
  rec('保存一组完整接入参数', r.data.ok, r.data.msg || '');
  rec('接入地址去掉尾斜杠', c1.baseUrl === 'http://127.0.0.1:9090', c1.baseUrl);
  rec('OpenID 数组正确回读', Array.isArray(c1.adminOpenids) && c1.adminOpenids.length === 2, JSON.stringify(c1.adminOpenids));
  rec('密钥只回掩码', /^\w{4}\*{4}\w{4}$/.test(c1.secret || ''), c1.secret);
  rec('与旧设置接口一致', (await req('GET', '/api/settings')).data.settings.relay.relayPublicUrl === 'http://127.0.0.1:9090');

  r = await req('PUT', '/api/wechat/config', { secret: '' });
  rec('空密钥不会误清空', r.data.config.secretConfigured === true);
  r = await req('PUT', '/api/wechat/config', { secret: '', clearSecret: true });
  rec('显式清除密钥生效', r.data.config.secretConfigured === false);
  r = await req('PUT', '/api/wechat/config', { secret: '0123456789abcdef0123456789abcdef' });
  rec('重新写入密钥', r.data.config.secretConfigured === true);

  const bindBefore = (await req('GET', '/api/wechat/config')).data.config.bindToken;
  r = await req('POST', '/api/wechat/bind-token');
  rec('重置绑定码', r.data.ok && r.data.bindToken !== bindBefore && /^data:image\/png/.test(r.data.bindQr || ''));

  // ---------- 浏览器层 ----------
  const browser = await require('puppeteer-core').launch({ executablePath: EDGE, headless: 'new', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 1000 });
  const errs = [];
  page.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text().slice(0, 160)); });
  const wait = (ms) => new Promise((res) => setTimeout(res, ms));

  await page.goto(BASE, { waitUntil: 'networkidle2' });
  await wait(700);
  if ((await page.evaluate(() => location.hash)).includes('login')) {
    await page.type('input[type=password]', PASS, { delay: 6 });
    await page.evaluate(() => {
      const b = [...document.querySelectorAll('button')].find((x) => x.textContent.replace(/\s/g, '') === '登录');
      b && b.click();
    });
    await page.waitForFunction(() => location.hash.includes('dashboard'), { timeout: 12000 }).catch(() => {});
    await wait(1200);
  }

  await page.evaluate(() => { location.hash = '#/wechat'; });
  await wait(1800);

  const layout = await page.evaluate(() => ({
    overview: document.querySelectorAll('.overview .ov').length,
    switches: document.querySelectorAll('.switches .sw').length,
    hasQr: !!document.querySelector('.qr img'),
    hasSteps: document.querySelectorAll('.n-step').length,
    hasDocs: /接口一览/.test(document.querySelector('.content').innerText),
    baseShown: (document.querySelector('.ov-value') || {}).textContent || ''
  }));
  rec('概览条 4 个指标', layout.overview === 4, String(layout.overview));
  rec('三个策略开关', layout.switches === 3, String(layout.switches));
  rec('绑定二维码渲染', layout.hasQr);
  rec('接入步骤 4 步', layout.hasSteps === 4, String(layout.hasSteps));
  rec('接口文档同屏', layout.hasDocs);
  await page.screenshot({ path: path.join(OUT, 'v4-01-wechat.png'), fullPage: false });

  // 表单保存：改接入地址 + 加一个 OpenID
  const savedOk = await page.evaluate(async () => {
    const setVal = (el, v) => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); };
    const items = [...document.querySelectorAll('.n-form-item')];
    const baseItem = items.find((x) => x.textContent.includes('接入地址'));
    const input = baseItem?.querySelector('input');
    if (input) setVal(input, 'https://print.example.com');
    const btn = [...document.querySelectorAll('button')].find((x) => x.textContent.includes('保存接入参数'));
    btn && btn.click();
    await new Promise((r) => setTimeout(r, 1800));
    const res = await fetch('/api/wechat/config', { headers: { Authorization: 'Bearer ' + localStorage.getItem('printgate_token') } });
    return (await res.json()).config;
  });
  rec('界面保存接入地址生效', savedOk.baseUrl === 'https://print.example.com', savedOk.baseUrl);
  rec('保存后密钥未丢失', savedOk.secretConfigured === true);

  // 开发模式开关 → 出现风险提示
  await page.evaluate(() => {
    const sw = [...document.querySelectorAll('.switches .sw')].find((x) => x.textContent.includes('开发模式'));
    const btn = sw?.querySelector('.n-switch');
    btn && btn.click();
  });
  await wait(900);
  const devWarn = await page.evaluate(() => /开发模式已开启/.test(document.querySelector('.content').innerText));
  rec('开启开发模式出现风险提示', devWarn);
  // 关掉并保存
  await page.evaluate(async () => {
    const sw = [...document.querySelectorAll('.switches .sw')].find((x) => x.textContent.includes('开发模式'));
    const btn = sw?.querySelector('.n-switch');
    if (btn && btn.getAttribute('aria-checked') === 'true') btn.click();
    await new Promise((r) => setTimeout(r, 400));
    const save = [...document.querySelectorAll('button')].find((x) => x.textContent.includes('保存接入参数'));
    save && save.click();
  });
  await wait(1600);

  // 设置页：小程序 tab 不再重复表单
  await page.evaluate(() => { location.hash = '#/settings?tab=wechat'; });
  await wait(1600);
  const settingsTab = await page.evaluate(() => {
    const txt = document.querySelector('.content').innerText;
    const appidInput = [...document.querySelectorAll('.n-form-item')].some((x) => x.textContent.includes('AppID') && x.querySelector('input:not([disabled])'));
    return { txt, appidInput };
  });
  rec('设置页引导文案存在', /统一收到「小程序对接」页维护/.test(settingsTab.txt));
  rec('设置页不再有可编辑 AppID', settingsTab.appidInput === false);
  await page.screenshot({ path: path.join(OUT, 'v4-02-settings-wechat.png') });

  // 中转页：BASE 只读（在向导第 2 步，逐步前进直到该字段出现，避免依赖起始步骤）
  await page.evaluate(() => { location.hash = '#/relay'; });
  await wait(1800);
  for (let i = 0; i < 4; i++) {
    const hasBase = await page.evaluate(() =>
      [...document.querySelectorAll('.n-form-item')].some((x) => x.textContent.includes('对外访问地址')));
    if (hasBase) break;
    await page.evaluate(() => {
      const b = [...document.querySelectorAll('.wizard-foot button')].find((x) => x.textContent.includes('下一步'));
      b && b.click();
    });
    await wait(900);
  }
  const relayBase = await page.evaluate(() => {
    const items = [...document.querySelectorAll('.n-form-item')];
    const it = items.find((x) => x.textContent.includes('对外访问地址'));
    const input = it?.querySelector('input');
    return { disabled: input ? input.disabled : null, value: input ? input.value : '' };
  });
  rec('中转页 BASE 只读', relayBase.disabled === true, `value=${relayBase.value}`);
  await page.screenshot({ path: path.join(OUT, 'v4-03-relay.png') });

  // 移动端小程序页
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });
  await page.evaluate(() => { location.hash = '#/wechat'; });
  await wait(1500);
  const overflow = await page.evaluate(() => document.body.scrollWidth > window.innerWidth + 2);
  rec('移动端小程序页无横向溢出', !overflow);
  await page.screenshot({ path: path.join(OUT, 'v4-04-wechat-mobile.png') });
  await page.setViewport({ width: 1440, height: 900 });

  rec('无控制台错误', errs.filter((e) => !/400 \(Bad Request\)/.test(e)).length === 0, errs.slice(0, 3).join(' | '));

  await browser.close();

  const fail = results.filter((x) => !x.p);
  console.log(`\n=== ${results.length - fail.length}/${results.length} 通过 ===`);
  if (fail.length) { console.log('失败项：'); fail.forEach((f) => console.log(` - ${f.n}：${f.d}`)); }
  fs.writeFileSync(path.join(OUT, 'wechat-ui.json'), JSON.stringify(results, null, 2));
  process.exit(fail.length ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(2); });
