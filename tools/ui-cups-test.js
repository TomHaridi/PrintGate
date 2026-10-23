'use strict';
// CUPS 后台管理页 UI 巡查：渲染 / 三个页签 / 队列与作业操作 / 无控制台报错
// 用法：PG_BASE=http://127.0.0.1:18092 PG_PASS=CupsTest2026 node tools/ui-cups-test.js
const path = require('path');
const fs = require('fs');
const puppeteer = require(path.join('C:/Users/Administrator/.workbuddy/binaries/node/workspace/node_modules/puppeteer-core'));

const BASE = process.env.PG_BASE || 'http://127.0.0.1:18092';
const PASS = process.env.PG_PASS || 'CupsTest2026';
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const SHOT = require('./_paths').shotsDir();

let pass = 0;
const fails = [];
const rec = (n, p, d = '') => {
  if (p) pass += 1; else fails.push(n);
  console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? '  —  ' + d : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function req(method, url, body, token = '') {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(BASE + url, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

const CLICK = `(t) => {
  const key = String(t).replace(/\\s+/g, '');
  const el = [...document.querySelectorAll('button')].find((b) => b.innerText.replace(/\\s+/g, '').includes(key));
  if (!el) return false;
  el.click();
  return true;
}`;

const TAB = `(t) => {
  const el = [...document.querySelectorAll('.n-tabs-tab')].find((b) => b.innerText.replace(/\\s+/g, '').includes(String(t).replace(/\\s+/g, '')));
  if (!el) return false;
  el.click();
  return true;
}`;

(async () => {
  fs.mkdirSync(SHOT, { recursive: true });
  let r = await req('GET', '/api/public/bootstrap');
  if (r.data.needsSetup) await req('POST', '/api/setup', { password: PASS, confirm: PASS });

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

  console.log('\n=== 1. 侧栏入口 ===');
  const menuHit = await page.evaluate(`(() => {
    const el = [...document.querySelectorAll('.n-menu-item-content')].find((b) => b.innerText.replace(/\\s+/g,'').includes('CUPS'));
    return !!el;
  })()`);
  rec('侧栏出现「CUPS 后台」入口', menuHit, '');
  const gotoMenu = await page.evaluate(`(() => {
    const el = [...document.querySelectorAll('.n-menu-item-content')].find((b) => b.innerText.replace(/\\s+/g,'').includes('CUPS'));
    if (el) { el.click(); return true; } return false;
  })()`);
  await sleep(2500);
  rec('点击入口跳转到 /cups', gotoMenu && page.url().includes('/cups'), page.url().split('#')[1] || '');

  console.log('\n=== 2. 概览页签 ===');
  let txt = await page.evaluate(() => document.body.innerText);
  rec('页面渲染出内容', txt.length > 200, `${txt.length} 字`);
  rec('标题为 CUPS 后台', /CUPS\s*后台/.test(txt), (txt.split('\n')[0] || '').slice(0, 20));
  rec('显示 CUPS 版本', /CUPS\s*版本/.test(txt), (txt.match(/CUPS\s*版本[\s\S]{0,16}/) || [''])[0].replace(/\n/g, ' '));
  rec('显示守护进程 PID', /PID\s*\d+/.test(txt), (txt.match(/PID\s*\d+/) || [''])[0]);
  rec('显示配置文件路径', /\/etc\/cups\/cupsd\.conf/.test(txt), '');
  rec('有队列与作业两个区块', /打印队列/.test(txt) && /未完作业/.test(txt), '');
  await page.screenshot({ path: path.join(SHOT, 'cups-overview.png'), fullPage: true });

  console.log('\n=== 3. 配置页签 ===');
  await page.evaluate(`(${TAB})('配置')`);
  await sleep(1800);
  txt = await page.evaluate(() => document.body.innerText);
  rec('切到配置页签', /常用指令/.test(txt), '');
  rec('列出可编辑指令', /日志级别/.test(txt) && /网络共享/.test(txt), '');
  rec('有配置文件原文区域', /配置文件原文/.test(txt), '');
  const rawLen = await page.evaluate(() => (document.querySelector('pre.logs') || {}).innerText?.length || 0);
  rec('原文区域读到内容', rawLen > 100, `${rawLen} 字`);
  await page.screenshot({ path: path.join(SHOT, 'cups-config.png'), fullPage: true });

  console.log('\n=== 4. 日志页签 ===');
  await page.evaluate(`(${TAB})('日志')`);
  await sleep(1800);
  txt = await page.evaluate(() => document.body.innerText);
  rec('切到日志页签', /CUPS\s*日志/.test(txt), '');
  const logTxt = await page.evaluate(() => (document.querySelector('pre.logs') || {}).innerText || '');
  rec('日志区域有内容或空提示', logTxt.length > 0, `${logTxt.length} 字`);
  await page.screenshot({ path: path.join(SHOT, 'cups-logs.png'), fullPage: true });

  console.log('\n=== 5. 无异常 ===');
  rec('无 5xx 接口响应', bad.length === 0, bad.join(' | '));
  rec('无控制台报错', errors.length === 0, errors.slice(0, 3).join(' | '));

  await browser.close();
  console.log(`\n===== 通过 ${pass} / 失败 ${fails.length} =====`);
  if (fails.length) console.log('失败项：', fails.join(' | '));
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error('脚本异常:', e); process.exit(1); });
