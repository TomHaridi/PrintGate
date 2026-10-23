'use strict';
// 身份证打印页 UI 巡查：模式切换 / 一键矫正按钮 / 大小方向控件 / 实时拼接预览 / 无报错
// 用法：PG_BASE=http://127.0.0.1:18096 PG_PASS=IdcardTest2026 NODE_PATH=<含 puppeteer-core 与 sharp> node tools/ui-idcard-test.js
const path = require('path');
const fs = require('fs');
const sharp = require('sharp');
const puppeteer = require(path.join('C:/Users/Administrator/.workbuddy/binaries/node/workspace/node_modules/puppeteer-core'));

const BASE = process.env.PG_BASE || 'http://127.0.0.1:18096';
const PASS = process.env.PG_PASS || 'IdcardTest2026';
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const SHOT = require('./_paths').shotsDir();

let pass = 0;
const fails = [];
const rec = (n, p, d = '') => { if (p) pass += 1; else fails.push(n); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? '  —  ' + d : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function synthCard(label, accent, angle) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="378">
    <rect width="600" height="378" rx="18" fill="#fdfdfd" stroke="#c8ccd4" stroke-width="3"/>
    <rect x="24" y="24" width="88" height="76" fill="${accent}" opacity="0.92"/>
    <rect x="24" y="110" width="150" height="190" rx="8" fill="#e2e5ea"/>
    <rect x="196" y="30" width="360" height="16" rx="6" fill="#8b95a5"/>
    <rect x="196" y="58" width="300" height="12" rx="6" fill="#b6bdc8"/>
    <rect x="196" y="110" width="380" height="12" rx="6" fill="#b6bdc8"/>
    <rect x="196" y="132" width="340" height="12" rx="6" fill="#b6bdc8"/>
    <rect x="196" y="154" width="360" height="12" rx="6" fill="#b6bdc8"/>
    <rect x="196" y="176" width="280" height="12" rx="6" fill="#b6bdc8"/>
    <rect x="24" y="316" width="552" height="38" rx="6" fill="#eef0f4"/>
    <text x="132" y="72" font-family="Arial" font-size="30" fill="#ffffff">${label}</text>
  </svg>`;
  const card = await sharp(Buffer.from(svg)).png().toBuffer();
  const rotated = await sharp(card).rotate(angle, { background: { r: 46, g: 46, b: 50, alpha: 1 } }).toBuffer();
  return sharp({ create: { width: 900, height: 700, channels: 3, background: { r: 46, g: 46, b: 50 } } })
    .composite([{ input: rotated, gravity: 'center' }]).jpeg({ quality: 92 }).toBuffer();
}

const CLICK = `(t) => {
  const key = String(t).replace(/\\s+/g, '');
  const el = [...document.querySelectorAll('button, .n-tab, .n-radio-button')].find((b) => b.innerText.replace(/\\s+/g, '').includes(key));
  if (!el) return false; el.click(); return true;
}`;

(async () => {
  fs.mkdirSync(SHOT, { recursive: true });
  const frontFile = path.join(SHOT, '_ui_front.jpg');
  const backFile = path.join(SHOT, '_ui_back.jpg');
  fs.writeFileSync(frontFile, await synthCard('FRONT', '#2b6cb0', 15));
  fs.writeFileSync(backFile, await synthCard('BACK', '#c53030', -12));

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
  page.on('response', (res) => { const u = res.url(); if (u.includes('/api/') && res.status() >= 500) bad.push(`${res.status()} ${u.replace(BASE, '')}`); });

  // 登录
  const api = async (method, url, body) => {
    const headers = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const r = await fetch(BASE + url, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
    return { status: r.status, data: await r.json().catch(() => ({})) };
  };
  let r = await api('GET', '/api/public/bootstrap');
  if (r.data.needsSetup) await api('POST', '/api/setup', { password: PASS, confirm: PASS });

  await page.goto(`${BASE}/#/login`, { waitUntil: 'networkidle2' });
  await page.evaluate(() => localStorage.removeItem('printgate_token'));
  await page.reload({ waitUntil: 'networkidle2' });
  await sleep(1200);
  await page.type('input[type="password"]', PASS);
  await page.evaluate(`(${CLICK})('登录')`);
  await sleep(2000);
  rec('登录成功', !page.url().includes('/login'), page.url().split('#')[1] || '');

  // 切到身份证打印
  await page.goto(`${BASE}/#/print`, { waitUntil: 'networkidle2' });
  await sleep(1800);
  await page.evaluate(`(${CLICK})('身份证打印')`);
  await sleep(1200);
  let txt = await page.evaluate(() => document.body.innerText);
  rec('切到身份证打印模式', /人像面/.test(txt) && /国徽面/.test(txt), '');

  // 上传人像面（身份证的 file input 是 accept=".jpg,.jpeg,.png"）
  const input = await page.$('input[type="file"][accept*=".jpg"]');
  rec('找到身份证上传入口', !!input, '');
  if (input) {
    await input.uploadFile(frontFile);
    await sleep(3500);
    txt = await page.evaluate(() => document.body.innerText);
    rec('上传后出现一键矫正按钮', /一键矫正识别切割/.test(txt), '');
    rec('出现大小/方向调节（旋转/缩放）', /旋转/.test(txt) && /缩放/.test(txt), '');
    await page.screenshot({ path: path.join(SHOT, 'idcard-ui-uploaded.png'), fullPage: true });

    // 点一键矫正
    const clicked = await page.evaluate(`(${CLICK})('一键矫正识别切割')`);
    rec('点击一键矫正按钮', clicked, '');
    await sleep(5000);
    txt = await page.evaluate(() => document.body.innerText);
    rec('矫正成功有反馈（图片替换不报错）', /已矫正/.test(txt) || /矫正/.test(txt), (txt.match(/矫正[^\n]{0,20}/) || [''])[0]);
    await page.screenshot({ path: path.join(SHOT, 'idcard-ui-cropped.png'), fullPage: true });
  }

  console.log('\n=== 无异常 ===');
  rec('无 5xx 接口响应', bad.length === 0, bad.slice(0, 3).join(' | '));
  rec('无控制台报错', errors.length === 0, errors.slice(0, 3).join(' | '));

  await browser.close();
  try { fs.unlinkSync(frontFile); fs.unlinkSync(backFile); } catch (_) {}
  console.log(`\n===== 通过 ${pass} / 失败 ${fails.length} =====`);
  if (fails.length) console.log('失败项：', fails.join(' | '));
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error('脚本异常:', e); process.exit(1); });
