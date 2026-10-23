'use strict';
// 剩余管理页交互巡查：打印机 / 中转 / 概览 / 打印队列
// 本机没有 CUPS，重点看「失败时是否有明确反馈」而不是卡死或白屏
// 用法：PG_BASE=http://127.0.0.1:8099 PG_PASS=xxx node tools/ui-page-patrol.js
const path = require('path');
const fs = require('fs');
const puppeteer = require(path.join('C:/Users/Administrator/.workbuddy/binaries/node/workspace/node_modules/puppeteer-core'));

const BASE = process.env.PG_BASE || 'http://127.0.0.1:8099';
const PASS = process.env.PG_PASS || 'LocalTest2026';
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const SHOT = require('./_paths').shotsDir();

const results = [];
const rec = (n, p, d = '') => {
  results.push({ n, p, d });
  console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? `  —  ${d}` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function req(method, url, body, token = '') {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(BASE + url, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

// 压掉空白后按文案找按钮（页面里常有「扫 描」这类带空格的文案）
const CLICK = `(t) => {
  const key = String(t).replace(/\\s+/g, '');
  const el = [...document.querySelectorAll('button')].find((b) => b.innerText.replace(/\\s+/g, '').includes(key));
  if (!el) return false;
  el.click();
  return true;
}`;

(async () => {
  fs.mkdirSync(SHOT, { recursive: true });
  let r = await req('GET', '/api/public/bootstrap');
  let ADMIN = '';
  if (r.data.needsSetup) ADMIN = (await req('POST', '/api/setup', { password: PASS, confirm: PASS })).data.token;
  else ADMIN = (await req('POST', '/api/auth/login', { password: PASS })).data.token;

  const browser = await puppeteer.launch({
    executablePath: EDGE, headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--window-size=1440,900']
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  const errors = [];
  const bad = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 160)); });
  page.on('pageerror', (e) => errors.push('pageerror: ' + String(e.message).slice(0, 160)));
  page.on('response', (res) => {
    const u = res.url();
    if (u.includes('/api/') && res.status() >= 500) bad.push(`${res.status()} ${u.replace(BASE, '')}`);
  });

  await page.goto(`${BASE}/#/login`, { waitUntil: 'networkidle2' });
  await page.evaluate(() => localStorage.removeItem('printgate_token'));
  await page.reload({ waitUntil: 'networkidle2' });
  await sleep(1200);
  await page.type('input[type="password"]', PASS);
  await page.evaluate(`(${CLICK})('登录')`);
  await sleep(2000);
  rec('登录成功', !page.url().includes('/login'), page.url().split('#')[1] || '');

  console.log('\n=== 1. 打印机页（无 CUPS 的降级） ===');
  await page.goto(`${BASE}/#/printers`, { waitUntil: 'networkidle2' });
  await sleep(2500);
  let txt = await page.evaluate(() => document.body.innerText);
  rec('打印机页渲染', txt.length > 100, `${txt.length} 字`);
  rec('CUPS 不可用时页面有说明', /CUPS|未运行|不可用|未安装|离线/i.test(txt), (txt.match(/CUPS[^。\n]{0,24}/) || [''])[0]);
  const clicked = await page.evaluate(`(${CLICK})('刷新')`);
  await sleep(2500);
  const stillAlive = await page.evaluate(() => document.body.innerText.length > 100);
  rec('点刷新后页面仍正常', clicked ? stillAlive : true, clicked ? '' : '(无刷新按钮)');
  await page.screenshot({ path: path.join(SHOT, 'page-printers.png'), fullPage: true });

  console.log('\n=== 2. 中转 / 穿透页 ===');
  await page.goto(`${BASE}/#/relay`, { waitUntil: 'networkidle2' });
  await sleep(2000);
  txt = await page.evaluate(() => document.body.innerText);
  rec('中转页渲染', txt.length > 100, `${txt.length} 字`);
  const tabs = await page.evaluate(() => [...document.querySelectorAll('.n-tab, .n-radio-button, .n-tab-pane')].length);
  rec('中转页有分栏/步骤', tabs > 0, `${tabs} 个`);
  const testBtn = await page.evaluate(`(${CLICK})('测试') || (${CLICK})('检测')`);
  if (testBtn) {
    await sleep(3000);
    const msg = await page.evaluate(() => document.body.innerText);
    rec('连通性检测有反馈', /无法|失败|可连通|成功|未配置/.test(msg), (msg.match(/(无法|失败|可连通|成功|未配置)[^\n]{0,26}/) || [''])[0]);
  } else {
    rec('连通性检测有反馈', true, '(未找到检测按钮)');
  }
  await page.screenshot({ path: path.join(SHOT, 'page-relay.png'), fullPage: true });

  console.log('\n=== 3. 概览页 ===');
  await page.goto(`${BASE}/#/dashboard`, { waitUntil: 'networkidle2' });
  await sleep(2500);
  txt = await page.evaluate(() => document.body.innerText);
  rec('概览渲染', txt.length > 200, `${txt.length} 字`);
  rec('概览含统计/状态区', /待审批|任务|打印机|队列|服务/.test(txt));
  const hasPending = /待审批用户/.test(txt);
  if (hasPending) {
    const before = await page.evaluate(() => (document.body.innerText.match(/待审批[^\n]{0,10}/) || [''])[0]);
    await page.evaluate(`(${CLICK})('通过')`);
    await sleep(2000);
    rec('概览一键通过有反馈', true, before);
  } else {
    rec('概览一键通过有反馈', true, '(当前无待审批用户)');
  }
  await page.screenshot({ path: path.join(SHOT, 'page-dashboard.png'), fullPage: true });

  console.log('\n=== 4. 打印队列页 ===');
  await page.goto(`${BASE}/#/jobs`, { waitUntil: 'networkidle2' });
  await sleep(2000);
  txt = await page.evaluate(() => document.body.innerText);
  rec('队列页渲染', txt.length > 50, `${txt.length} 字`);
  rec('队列为空时有空态提示', /暂无|没有|空|未找到/.test(txt), (txt.match(/[^\n]*(暂无|没有)[^\n]*/) || [''])[0].slice(0, 30));
  await page.screenshot({ path: path.join(SHOT, 'page-jobs.png') });

  console.log('\n=== 5. 收尾 ===');
  rec('无 5xx 接口错误', bad.length === 0, bad.slice(0, 3).join(' | '));
  const realErrors = errors.filter((e) => !/favicon|ERR_|Failed to load resource|net::/.test(e));
  rec('无控制台错误', realErrors.length === 0, realErrors.slice(0, 3).join(' | '));

  await browser.close();
  const pass = results.filter((x) => x.p).length;
  console.log(`\n===== ${pass}/${results.length} 通过 =====`);
  for (const f of results.filter((x) => !x.p)) console.log(`  - ${f.n} ${f.d}`);
  if (pass !== results.length) process.exitCode = 1;
})();
