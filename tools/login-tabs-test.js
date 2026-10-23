'use strict';
// 登录页三个入口（密码 / 扫码 / 普通用户注册）+ 密码登录开关生效性回归
// 用法：PG_BASE=http://127.0.0.1:8121 node tools/login-tabs-test.js
const path = require('path');
const puppeteer = require('C:/Users/Administrator/.workbuddy/binaries/node/workspace/node_modules/puppeteer-core');

const BASE = process.env.PG_BASE || 'http://127.0.0.1:8121';
const PASS = process.env.PG_PASS || 'LocalTest2026';
const EDGE = process.env.PG_EDGE || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const rec = (n, ok, d = '') => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  —  ' + d : ''}`); };

const req = async (method, url, body, token) => {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const r = await fetch(BASE + url, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  return { status: r.status, data: await r.json().catch(() => ({})) };
};

(async () => {
  let r = await req('GET', '/api/public/bootstrap');
  const ADMIN = r.data.needsSetup
    ? (await req('POST', '/api/setup', { password: PASS, confirm: PASS })).data.token
    : (await req('POST', '/api/auth/login', { password: PASS })).data.token;
  if (!ADMIN) { console.error('无法登录'); process.exit(1); }

  // ---------- 接口层：注册入口 ----------
  r = await req('GET', '/api/auth/user-entry');
  rec('注册入口接口可用', r.status === 200 && r.data.ok === true, `configured=${r.data.configured}`);
  rec('未配置小程序时给出文字指引', r.data.configured === false ? /配置小程序/.test(r.data.hint) : true, r.data.hint);

  // 配置假凭据后应走微信接口并优雅降级（假 appid 必然失败，但接口本身不能报错）
  await req('PUT', '/api/settings', { wxAppid: 'wx0123456789abcdef', wxSecret: 'abcdef0123456789abcdef0123456789' }, ADMIN);
  r = await req('GET', '/api/auth/user-entry');
  rec('微信接口失败时降级为文字指引', r.status === 200 && r.data.ok === true && !r.data.qr && /失败|搜索/.test(r.data.hint), r.data.hint.slice(0, 40));

  const browser = await puppeteer.launch({
    executablePath: EDGE, headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage']
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));

  // na-tabs 里混着一个空壳节点（滚动/占位），过滤掉再断言
  const tabs = async () => page.evaluate(() =>
    [...document.querySelectorAll('.n-tabs-tab')].map((t) => t.textContent.trim()).filter(Boolean));

  await page.goto(`${BASE}/#/login`, { waitUntil: 'networkidle2' });
  await page.evaluate(() => localStorage.removeItem('printgate_token'));
  await page.reload({ waitUntil: 'networkidle2' });
  await sleep(900);

  let t = await tabs();
  rec('未登录默认三个入口', t.length === 3 && t.includes('密码登录') && t.includes('扫码登录') && t.includes('普通用户'), t.join(' / '));

  // 切到「普通用户」Tab：先是账号密码登录表单，点「立即注册」才切到注册表单
  await page.evaluate(() => {
    const el = [...document.querySelectorAll('.n-tabs-tab')].find((x) => x.textContent.trim() === '普通用户');
    if (el) el.click();
  });
  await sleep(800);
  let txt = await page.evaluate(() => document.body.innerText);
  rec('普通用户 Tab 是账号密码登录', txt.includes('立即注册') || txt.includes('还没有账号'), txt.split(String.fromCharCode(10)).find((l) => l.includes('账号')) || '');

  await page.evaluate(() => {
    const btn = [...document.querySelectorAll('.n-button')].find((x) => x.textContent.includes('立即注册'));
    if (btn) btn.click();
  });
  await sleep(700);
  txt = await page.evaluate(() => document.body.innerText);
  const inputs = await page.evaluate(() => [...document.querySelectorAll('input')].map((i) => i.placeholder));
  rec('可切到注册表单（用户名/密码/确认）',
    txt.includes('注册并登录') && inputs.some((x) => x.includes('用户名')) && inputs.some((x) => x.includes('确认密码')),
    inputs.join(' | ').slice(0, 80));

  // ---------- 关键回归：管理员关掉密码登录后，登录页要立刻只剩扫码/注册 ----------
  await req('PUT', '/api/settings', { enablePasswordLogin: false }, ADMIN);
  await page.reload({ waitUntil: 'networkidle2' });
  await sleep(1200);
  t = await tabs();
  rec('关闭密码登录后登录页不再显示密码入口', !t.includes('密码登录'), t.join(' / '));
  const hasPwdInput = await page.evaluate(() => !!document.querySelector('input[type="password"]'));
  rec('密码输入框已隐藏', hasPwdInput === false);

  // 恢复后再确认能回来
  await req('PUT', '/api/settings', { enablePasswordLogin: true }, ADMIN);
  await page.reload({ waitUntil: 'networkidle2' });
  await sleep(1000);
  t = await tabs();
  rec('重新打开后密码入口恢复', t.includes('密码登录'), t.join(' / '));

  rec('登录页无 JS 报错', errors.length === 0, errors.slice(0, 2).join(' | '));

  // 截图（给 README / 测试报告留证）
  const shot = path.join(__dirname, '..', '_shots', 'login-tabs.png');
  await page.screenshot({ path: shot });
  console.log('截图：', shot);

  await browser.close();
  console.log(`\n合计 ${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
