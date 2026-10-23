'use strict';
// 生成 GitHub README 用的界面截图（真实运行实例 + 真实数据）
// 用法：PG_BASE=http://127.0.0.1:8120 node tools/readme-shots.js
const path = require('path');
const fs = require('fs');
const puppeteer = require('C:/Users/Administrator/.workbuddy/binaries/node/workspace/node_modules/puppeteer-core');

const BASE = process.env.PG_BASE || 'http://127.0.0.1:8120';
const PASS = process.env.PG_PASS || 'LocalTest2026';
const EDGE = process.env.PG_EDGE || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const OUT = path.join(__dirname, '..', 'docs', 'screenshots');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const req = async (method, url, body, token) => {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  let payload;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const r = await fetch(BASE + url, { method, headers, body: payload });
  return { status: r.status, data: await r.json().catch(() => ({})) };
};

// 生成「色块 + 姓氏」头像，比纯色块更像真实头像，也不依赖外部图片
function initialsPng(hex, ch) {
  const sharp = require('C:/Users/Administrator/.workbuddy/binaries/node/workspace/node_modules/sharp');
  const svg = Buffer.from(
    `<svg width="200" height="200" xmlns="http://www.w3.org/2000/svg">` +
    `<rect width="200" height="200" fill="${hex}"/>` +
    `<text x="100" y="134" font-size="96" fill="#ffffff" text-anchor="middle" font-family="sans-serif">${ch}</text>` +
    `</svg>`
  );
  return sharp(svg).png().toBuffer();
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });

  let r = await req('GET', '/api/public/bootstrap');
  const ADMIN = r.data.needsSetup
    ? (await req('POST', '/api/setup', { password: PASS, confirm: PASS })).data.token
    : (await req('POST', '/api/auth/login', { password: PASS })).data.token;
  if (!ADMIN) { console.error('登录失败'); process.exit(1); }

  // 造点数据：接入参数、若干小程序用户（带头像昵称）、一个打印任务记录
  await req('PUT', '/api/settings', {
    devMode: true, approveNewUser: false, enableQrLogin: true, enablePasswordLogin: true,
    wxAppid: 'wx8f2c1a9d4b6e7f03', wxSecret: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
    defaultPrinter: 'HP_LaserJet_M404'
  }, ADMIN);

  const people = [
    ['财务-李敏', '4C7CF3', '李', 'limin_office'],
    ['运营-王浩', 'E8833A', '王', 'wanghao_ops'],
    ['设计-陈曦', '34A853', '陈', 'chenxi_design'],
    ['行政-赵倩', '9B51E0', '赵', 'zhaoqian_hr']
  ];
  const users = [];
  for (const [nick, color, initial, openid] of people) {
    const d = (await req('POST', '/api/mp/dev-login', { openid, nickname: nick })).data;
    if (!d.token) continue;
    const fd = new FormData();
    fd.append('avatar', new Blob([await initialsPng('#' + color, initial)], { type: 'image/png' }), 'a.png');
    await req('POST', '/api/mp/avatar', fd, d.token);
    users.push({ nick, token: d.token });
  }

  // 兜底：把历史遗留的待审批测试用户一并放行，截图里不该出现"等待审批"横幅
  const list = (await req('GET', '/api/users?size=200', undefined, ADMIN)).data.users || [];
  for (const u of list) {
    if (u.status === 'pending') await req('POST', `/api/users/${u.id}/approve`, {}, ADMIN);
  }

  // 普通用户门户需要有文件与记录：上传一个 PDF
  const pdf = Buffer.from(
    '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n' +
    '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 595 842]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj\n' +
    '4 0 obj<</Length 74>>stream\nBT /F1 24 Tf 72 760 Td (2026 Q3 Expense Report) Tj ET\nendstream endobj\n' +
    '5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n', 'latin1');
  const fd2 = new FormData();
  fd2.append('file', new Blob([pdf], { type: 'application/pdf' }), '报销单-2026Q3.pdf');
  const up = await req('POST', '/api/mp/files', fd2, users[0].token);
  if (up.data.file) {
    await req('POST', '/api/mp/print', {
      fileId: up.data.file.id, printer: 'HP_LaserJet_M404',
      options: { copies: 1, color: 'mono', sides: 'one-sided', media: 'A4', orientation: 'portrait' }
    }, users[0].token).catch(() => {});
  }
  // 再补一条历史（不同文件名）
  const fd3 = new FormData();
  fd3.append('file', new Blob([pdf], { type: 'application/pdf' }), '会议纪要-1023.pdf');
  const up2 = await req('POST', '/api/mp/files', fd3, users[0].token);
  if (up2.data.file) {
    await req('POST', '/api/mp/print', {
      fileId: up2.data.file.id, printer: 'HP_LaserJet_M404',
      options: { copies: 2, color: 'mono', sides: 'two-sided-long-edge', media: 'A4', orientation: 'portrait' }
    }, users[0].token).catch(() => {});
  }

  // 截图前关掉开发模式：/mp/dev-login 的告警不该出现在 README 里
  await req('PUT', '/api/settings', { devMode: false }, ADMIN);

  const browser = await puppeteer.launch({
    executablePath: EDGE,
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--force-device-scale-factor=1']
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1.5 });

  const shot = async (name) => {
    await sleep(900);
    await page.screenshot({ path: path.join(OUT, name), type: 'png' });
    console.log('已保存', name);
  };

  // 登录页
  await page.goto(`${BASE}/#/login`, { waitUntil: 'networkidle2' });
  await page.evaluate((p) => localStorage.removeItem('printgate_token'), null);
  await page.reload({ waitUntil: 'networkidle2' });
  await sleep(600);
  await shot('login.png');

  // 管理员登录
  await page.type('input[type="password"]', PASS);
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'networkidle2' }).catch(() => {}),
    page.click('.n-button--primary-type')
  ]);
  await sleep(1500);
  await shot('dashboard.png');

  for (const [hash, name] of [['#/print', 'print.png'], ['#/users', 'users.png'], ['#/wechat', 'wechat.png'], ['#/cups', 'cups.png']]) {
    await page.goto(`${BASE}/${hash}`, { waitUntil: 'networkidle2' });
    await sleep(1200);
    if (name === 'users.png') {
      // 默认停在「待审批」空列表，切到「全部」才看得到真实用户
      await page.evaluate(() => {
        const btn = [...document.querySelectorAll('.n-radio-button')].find((el) => el.textContent.trim().startsWith('全部'));
        if (btn) btn.click();
      });
      await sleep(900);
    }
    await shot(name);
  }

  // 普通用户门户：换成小程序用户令牌（whoami 会识别为普通用户并自动跳到 /portal）
  const uTok = users[0] && users[0].token;
  if (uTok) {
    // 换令牌必须整页重载：只改 hash 不会重新 bootstrap，SPA 里还留着管理员会话
    await page.evaluate((t) => localStorage.setItem('printgate_token', t), uTok);
    await page.goto(`${BASE}/#/portal`, { waitUntil: 'networkidle2' });
    await page.reload({ waitUntil: 'networkidle2' });
    await sleep(1800);
    await shot('portal.png');
    await page.goto(`${BASE}/#/dashboard`, { waitUntil: 'networkidle2' });
    await sleep(1200);
    console.log('普通用户访问 /dashboard 当前路径 =', await page.evaluate(() => location.hash));
  }

  await browser.close();
  console.log('完成，输出目录：', OUT);
})().catch((e) => { console.error(e); process.exit(1); });
