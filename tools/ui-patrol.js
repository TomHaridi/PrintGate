'use strict';
// PrintGate 全站浏览器巡检：逐个页面打开，收集 console/HTTP 错误，截图留证
// 用法：PG_BASE=http://127.0.0.1:8080 PG_PASS=xxx node tools/ui-patrol.js
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');

const BASE = process.env.PG_BASE || 'http://127.0.0.1:8080';
const PASS = process.env.PG_PASS || 'LocalTest2026';
const SHOTS = process.env.PG_SHOTS || require('./_paths').shotsDir() + '/ui-patrol';
const EDGE = process.env.PG_EDGE || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';

const PAGES = [
  { hash: '#/dashboard', name: '概览', expect: ['打印机', '任务'] },
  { hash: '#/printers', name: '打印机', expect: ['历史清理'] },
  { hash: '#/print', name: '发起打印', expect: ['文件', '打印'] },
  { hash: '#/jobs', name: '打印队列', expect: ['队列'] },
  { hash: '#/tasks', name: '任务审批', expect: ['任务'] },
  { hash: '#/scan', name: '扫描仪', expect: ['扫描'] },
  { hash: '#/users', name: '小程序用户', expect: ['用户'] },
  { hash: '#/wechat', name: '小程序对接', expect: ['小程序'] },
  { hash: '#/relay', name: '中转对接', expect: ['中转'] },
  { hash: '#/logs', name: '日志审计', expect: ['日志'] },
  { hash: '#/system', name: '系统状态', expect: ['CUPS'] },
  { hash: '#/settings', name: '系统设置', expect: ['设置'] }
];

const results = [];
const rec = (name, pass, detail = '') => {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  —  ${detail}` : ''}`);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const browser = await puppeteer.launch({
    executablePath: EDGE, headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage']
  });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(`[js] ${e.message.slice(0, 180)}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`[console] ${m.text().slice(0, 180)}`); });
  page.on('response', (r) => {
    if (r.status() >= 400) errors.push(`[http ${r.status()}] ${r.url().replace(BASE, '')}`);
  });
  await page.setViewport({ width: 1440, height: 960 });

  // 登录
  await page.goto(BASE + '/', { waitUntil: 'networkidle2' });
  await wait(1200);
  const needLogin = await page.$('input[type="password"]');
  if (needLogin) {
    await needLogin.type(PASS, { delay: 12 });
    const btn = await page.$('button');
    if (btn) await btn.click();
    await wait(1800);
    console.log('  · 已登录，URL=' + page.url().replace(BASE, ''));
  }
  await page.screenshot({ path: path.join(SHOTS, '00-login.png') });

  for (const p of PAGES) {
    const before = errors.length;
    await page.goto(BASE + '/' + p.hash, { waitUntil: 'networkidle2' });
    await wait(1300);
    const text = await page.evaluate(() => document.body.innerText || '');
    const missing = p.expect.filter((k) => !text.includes(k));
    const fresh = errors.slice(before);
    // 页面级 JS 异常才算失败；HTTP 4xx 单独记录（部分是业务鉴权/空数据导致）
    const jsErrors = fresh.filter((e) => e.startsWith('[js]') || e.startsWith('[console]'));
    const httpErrors = fresh.filter((e) => e.startsWith('[http'));
    const pass = missing.length === 0 && jsErrors.length === 0;
    rec(`页面 ${p.name}`, pass,
      [missing.length ? `缺关键词:${missing.join('/')}` : '',
       jsErrors.length ? `JS错误:${jsErrors[0]}` : '',
       httpErrors.length ? `HTTP:${httpErrors.slice(0, 2).join(' | ')}` : '']
        .filter(Boolean).join('  ') || '正常');
    await page.screenshot({ path: path.join(SHOTS, `${p.hash.replace('#/', '')}.png`), fullPage: false });
  }

  // 侧边栏完整性
  await page.goto(BASE + '/#/dashboard', { waitUntil: 'networkidle2' });
  await wait(1000);
  const navs = await page.evaluate(() => {
    const els = document.querySelectorAll('a, .n-menu-item-content, [role="menuitem"]');
    return Array.from(els).map((e) => (e.innerText || '').trim()).filter(Boolean);
  });
  const wantNavs = ['概览', '打印机', '发起打印', '打印队列', '任务审批', '扫描仪', '小程序用户', '小程序对接', '中转对接', '日志审计', '系统状态', '系统设置'];
  const missNav = wantNavs.filter((n) => !navs.some((x) => x.includes(n)));
  rec('侧边栏 12 项齐全', missNav.length === 0, missNav.length ? `缺少:${missNav.join(',')}` : '齐全');

  // 布局溢出检查
  const overflow = await page.evaluate(() => {
    const de = document.documentElement;
    return { sw: de.scrollWidth, cw: de.clientWidth };
  });
  rec('无横向溢出', overflow.sw - overflow.cw <= 2, `scroll=${overflow.sw} client=${overflow.cw}`);

  await browser.close();

  const pass = results.filter((r) => r.pass).length;
  console.log(`\n=== ${pass}/${results.length} 通过 ===`);
  if (errors.length) {
    console.log('\n--- 全部错误明细 ---');
    [...new Set(errors)].slice(0, 25).forEach((e) => console.log('  ' + e));
  }
  fs.writeFileSync(path.join(SHOTS, '../ui-patrol.json'), JSON.stringify({ results, errors: [...new Set(errors)] }, null, 2));
  process.exit(pass === results.length ? 0 : 1);
})().catch((e) => { console.error('巡检崩溃:', e.message); process.exit(1); });
