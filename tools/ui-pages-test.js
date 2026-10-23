'use strict';
// 管理台/门户/工作台 页面冒烟：逐个路由打开，抓 JS 报错、白屏、标题缺失
// 用法：BASE=http://127.0.0.1:8137 PW=LocalTest2026 node tools/ui-pages-test.js
const puppeteer = require('C:/Users/Administrator/.workbuddy/binaries/node/workspace/node_modules/puppeteer-core');
const BASE = process.env.BASE || 'http://127.0.0.1:8137';
const PW = process.env.PW || 'LocalTest2026';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const bugs = [];
const rec = (n, ok, d = '') => {
  ok ? pass++ : (fail++, bugs.push(`${n}${d ? ' — ' + d : ''}`));
  console.log(`${ok ? 'PASS' : 'FAIL'} | ${n}${d ? ' | ' + d : ''}`);
};

const ADMIN_PAGES = [
  ['dashboard', '运行概览'], ['printers', '打印机'], ['print', '发起打印'], ['jobs', '打印队列'],
  ['tasks', '任务审批'], ['scan', '扫描仪'], ['users', '小程序用户'], ['wechat', '小程序对接'],
  ['relay', '中转对接'], ['cups', 'CUPS'], ['logs', '日志审计'], ['system', '系统状态'], ['settings', '系统设置']
];

(async () => {
  const b = await puppeteer.launch({
    executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    headless: 'new', args: ['--no-sandbox']
  });

  // ---------- 管理员页面 ----------
  const p = await b.newPage();
  await p.setViewport({ width: 1440, height: 900 });
  const errs = [];
  p.on('pageerror', (e) => errs.push(e.message.slice(0, 140)));
  await p.goto(BASE + '/#/login', { waitUntil: 'networkidle2' });
  await p.evaluate(() => localStorage.removeItem('printgate_token'));
  await p.reload({ waitUntil: 'networkidle2' });
  await sleep(600);
  await p.type('input[type="password"]', PW);
  await Promise.all([p.waitForNavigation({ waitUntil: 'networkidle2' }).catch(() => {}), p.click('.n-button--primary-type')]);
  await sleep(1500);

  for (const [route, want] of ADMIN_PAGES) {
    errs.length = 0;
    await p.goto(`${BASE}/#/${route}`, { waitUntil: 'networkidle2' });
    await sleep(1400);
    const info = await p.evaluate(() => {
      const t = document.querySelector('.page-title');
      const body = document.body.innerText || '';
      return { title: t ? t.innerText.trim() : '', textLen: body.length };
    });
    const ok = !errs.length && info.title.includes(want) && info.textLen > 80;
    rec(`/admin ${route}`, ok, `title=${info.title || '(空)'} len=${info.textLen}${errs.length ? ' err=' + errs[0] : ''}`);
  }

  // ---------- 普通用户：门户 + 工作台 ----------
  const j = async (m, path, body, token) => {
    const h = { 'Content-Type': 'application/json' };
    if (token) h.Authorization = 'Bearer ' + token;
    const r = await fetch(BASE + path, { method: m, headers: h, body: body ? JSON.stringify(body) : undefined });
    return { s: r.status, d: await r.json().catch(() => ({})) };
  };
  const adm = (await j('POST', '/api/auth/login', { password: PW })).d.token;
  const uname = 'ui_' + Date.now().toString(36);
  const reg = await j('POST', '/api/auth/account/register', { username: uname, password: 'Passw0rd123', confirm: 'Passw0rd123', nickname: 'UI 冒烟用户' });
  await j('POST', `/api/users/${reg.d.user.id}/approve`, {}, adm);

  const up = await b.newPage();
  await up.setViewport({ width: 390, height: 844, isMobile: true });
  const uerrs = [];
  up.on('pageerror', (e) => uerrs.push(e.message.slice(0, 140)));
  await up.goto(BASE + '/#/login', { waitUntil: 'networkidle2' });
  await up.evaluate((t) => localStorage.setItem('printgate_token', t), reg.d.token);
  for (const [route, want] of [['portal', '我的打印'], ['workbench', '打印工作台']]) {
    uerrs.length = 0;
    await up.goto(`${BASE}/#/${route}`, { waitUntil: 'networkidle2' });
    await up.reload({ waitUntil: 'networkidle2' });
    await sleep(1800);
    const info = await up.evaluate(() => ({ text: document.body.innerText.slice(0, 120), len: document.body.innerText.length }));
    const ok = !uerrs.length && info.len > 80;
    rec(`/user ${route}`, ok, `len=${info.len}${uerrs.length ? ' err=' + uerrs[0] : ''}`);
  }

  console.log(`\n合计 ${pass} 通过 / ${fail} 失败`);
  if (fail) console.log('失败项:\n - ' + bugs.join('\n - '));
  await b.close();
  process.exit(fail ? 1 : 0);
})();
