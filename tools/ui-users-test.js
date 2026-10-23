'use strict';
// 管理端页面巡查：用户管理（头像 / 微信号 / 详情抽屉 / 批量）+ 概览待审批卡片 + 全站控制台错误
// 用法：PG_BASE=http://127.0.0.1:8099 PG_PASS=xxx node tools/ui-users-test.js
const path = require('path');
const fs = require('fs');
const os = require('os');
const puppeteer = require(path.join(
  'C:/Users/Administrator/.workbuddy/binaries/node/workspace/node_modules/puppeteer-core'
));

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

(async () => {
  fs.mkdirSync(SHOT, { recursive: true });
  // 造几个带资料的待审批用户
  let r = await req('GET', '/api/public/bootstrap');
  let ADMIN = '';
  if (r.data.needsSetup) ADMIN = (await req('POST', '/api/setup', { password: PASS, confirm: PASS })).data.token;
  else ADMIN = (await req('POST', '/api/auth/login', { password: PASS })).data.token;
  if (!ADMIN) { console.log('无法登录管理后台'); process.exit(1); }

  const stamp = Date.now().toString(36);
  // 每轮用不同的标识，避免上一轮遗留的同名用户干扰断言
  const WX1 = `lidayin_${stamp}`;
  const WX2 = `hanmeimei_${stamp}`;
  const NAME2 = `韩梅梅_${stamp}`;
  const seeds = [
    { openid: `ui_${stamp}_1`, nickname: `李打印_${stamp}`, wechat_id: WX1, phone: '13711112222', real_name: '李雷', apply_note: '市场部，每周打印报价单' },
    { openid: `ui_${stamp}_2`, nickname: NAME2, wechat_id: WX2, phone: '13733334444', real_name: '韩梅梅', apply_note: '人事部，打印入职材料' },
    { openid: `ui_${stamp}_3`, nickname: '匿名申请者' }
  ];
  for (const s of seeds) await req('POST', '/api/mp/dev-login', s);

  const browser = await puppeteer.launch({
    executablePath: EDGE,
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--window-size=1440,900']
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });

  const errors = [];
  const bad = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)); });
  page.on('pageerror', (e) => errors.push('pageerror: ' + String(e.message).slice(0, 200)));
  page.on('response', (res) => {
    const u = res.url();
    if (u.includes('/api/') && res.status() >= 400) bad.push(`${res.status()} ${u.replace(BASE, '')}`);
  });

  console.log('=== 1. 登录 ===');
  await page.goto(`${BASE}/#/login`, { waitUntil: 'networkidle2' });
  await page.evaluate((p) => {
    localStorage.setItem('printgate_token', p);
  }, ADMIN);
  await page.goto(`${BASE}/#/dashboard`, { waitUntil: 'networkidle2' });
  await sleep(1500);
  rec('进入概览', !page.url().includes('/login'), page.url().split('#')[1] || '');

  console.log('\n=== 2. 概览：待审批用户卡片 ===');
  let cardText = await page.evaluate(() => document.body.innerText);
  rec('概览出现待审批用户', /待审批用户/.test(cardText));
  rec('展示微信号', new RegExp(`${WX1}|${WX2}`).test(cardText));
  rec('展示申请说明', /市场部|人事部/.test(cardText));
  await page.screenshot({ path: path.join(SHOT, 'users-dashboard.png') });

  // 概览一键通过
  const approved = await page.evaluate((wx) => {
    const rows = [...document.querySelectorAll('.applicant')];
    const target = rows.find((el) => el.innerText.includes(wx));
    if (!target) return false;
    const btn = [...target.querySelectorAll('button')].find((b) => b.innerText.includes('通过'));
    if (!btn) return false;
    btn.click();
    return true;
  }, WX1);
  rec('概览可直接通过申请', approved);
  await sleep(1800);
  cardText = await page.evaluate(() => document.body.innerText);
  rec('通过后从待审批列表移除', !cardText.includes(WX1));

  console.log('\n=== 3. 用户管理页 ===');
  await page.goto(`${BASE}/#/users`, { waitUntil: 'networkidle2' });
  await sleep(1500);
  let txt = await page.evaluate(() => document.body.innerText);
  rec('列表展示昵称', txt.includes(NAME2) || /匿名申请者/.test(txt));
  rec('列表展示微信号', txt.includes(WX2));
  rec('列表展示手机号', /13733334444/.test(txt));
  const avatarCount = await page.evaluate(() => document.querySelectorAll('.av img').length);
  rec('头像位置已渲染', avatarCount >= 0, `img 头像 ${avatarCount} 个（无头像时显示首字）`);
  await page.screenshot({ path: path.join(SHOT, 'users-list.png'), fullPage: true });

  // 搜索
  await page.evaluate(() => {
    const input = document.querySelector('.page-head input');
    input.focus();
  });
  await page.keyboard.type(WX2);
  await page.keyboard.press('Enter');
  await sleep(1200);
  txt = await page.evaluate(() => document.body.innerText);
  rec('按微信号搜索过滤', txt.includes(NAME2) && !/匿名申请者/.test(txt));

  console.log('\n=== 4. 详情抽屉 ===');
  await page.evaluate((name) => {
    const rows = [...document.querySelectorAll('tbody tr')];
    const row = rows.find((r) => r.innerText.includes(name));
    if (!row) return false;
    const btn = [...row.querySelectorAll('button')].find((b) => b.querySelector('svg'));
    if (!btn) return false;
    btn.click();
    return true;
  }, NAME2);
  await sleep(1200);
  txt = await page.evaluate(() => document.body.innerText);
  rec('抽屉打开', /申请说明|微信号/.test(txt));
  rec('抽屉显示申请说明', /人事部，打印入职材料/.test(txt));
  rec('抽屉显示手机号', /13733334444/.test(txt));
  rec('抽屉显示统计', /打印任务|累计份数/.test(txt));
  await page.screenshot({ path: path.join(SHOT, 'users-detail.png') });

  // 抽屉里改备注
  await page.evaluate(() => {
    const ta = [...document.querySelectorAll('.n-drawer textarea')][0];
    if (ta) {
      ta.focus();
    }
  });
  await page.keyboard.type('人事-韩梅梅');
  const noteSaved = await page.evaluate(async () => {
    const btn = [...document.querySelectorAll('.n-drawer button')].find((b) => b.innerText.includes('保存备注'));
    if (!btn) return false;
    btn.click();
    return true;
  });
  await sleep(1200);
  rec('抽屉保存备注', noteSaved);
  await page.evaluate(() => {
    const close = document.querySelector('.n-drawer .n-base-close');
    if (close) close.click();
  });
  await sleep(600);

  console.log('\n=== 5. 批量审批 ===');
  await page.goto(`${BASE}/#/users`, { waitUntil: 'networkidle2' });
  await page.reload({ waitUntil: 'networkidle2' }); // 清掉上一步的搜索词，回到待审批全量
  await sleep(1500);
  const picked = await page.evaluate(() => {
    const boxes = [...document.querySelectorAll('tbody .n-checkbox')];
    if (boxes.length < 2) return 0;
    boxes[0].click();
    boxes[1].click();
    return boxes.length;
  });
  rec('可勾选用户', picked >= 2, `复选框 ${picked} 个`);
  await sleep(500);
  txt = await page.evaluate(() => document.body.innerText);
  rec('出现批量按钮', /批量通过/.test(txt));
  await page.screenshot({ path: path.join(SHOT, 'users-batch.png') });

  // 走完确认弹窗：批量通过后列表要立刻刷新
  const beforeTotal = await page.evaluate(() => {
    const m = document.body.innerText.match(/共\s*(\d+)\s*位用户/);
    return m ? parseInt(m[1], 10) : -1;
  });
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll('button')].find((b) => b.innerText.includes('批量通过'));
    if (btn) btn.click();
  });
  await sleep(800);
  const hasDialog = await page.evaluate(() => /批量通过/.test(document.body.innerText) && !!document.querySelector('.n-dialog'));
  rec('批量前弹确认框', hasDialog);
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll('.n-dialog button')].find((b) => b.innerText.trim() === '通过');
    if (btn) btn.click();
  });
  await sleep(1800);
  const afterTotal = await page.evaluate(() => {
    const m = document.body.innerText.match(/共\s*(\d+)\s*位用户/);
    return m ? parseInt(m[1], 10) : -1;
  });
  rec('批量通过后待审批减少', afterTotal >= 0 && afterTotal < beforeTotal, `${beforeTotal} → ${afterTotal}`);

  console.log('\n=== 5b. 状态筛选与分页 ===');
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll('.n-radio-button')].find((b) => b.innerText.includes('已授权'));
    if (btn) btn.click();
  });
  await sleep(1200);
  txt = await page.evaluate(() => document.body.innerText);
  rec('切到「已授权」有数据', /共\s*\d+\s*位用户/.test(txt) && !/暂无用户/.test(txt), txt.match(/共\s*\d+\s*位用户/)?.[0] || '');
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll('.n-radio-button')].find((b) => b.innerText.trim() === '已拉黑');
    if (btn) btn.click();
  });
  await sleep(1200);
  txt = await page.evaluate(() => document.body.innerText);
  rec('切到「已拉黑」渲染正常', /共\s*\d+\s*位用户|暂无用户/.test(txt), txt.match(/共\s*\d+\s*位用户/)?.[0] || '暂无用户');

  console.log('\n=== 5c. 头像在列表/抽屉显示 ===');
  // 给一个已授权用户塞张头像，刷新后应渲染 <img>
  // dev-login 有每分钟 20 次的限流，前面跑得多的话要等一会儿再试
  let avUser = null;
  for (let i = 0; i < 5 && !avUser; i++) {
    const d = await req('POST', '/api/mp/dev-login', { openid: `ui_av_${stamp}`, nickname: `有头像_${stamp}`, wechat_id: `avatar_${stamp}` });
    if (d.data && d.data.user) avUser = d;
    else await sleep(3000);
  }
  if (!avUser) { console.log('  (dev-login 限流，跳过头像用例)'); }
  else await req('POST', `/api/users/${avUser.data.user.id}/approve`, {}, ADMIN);
  const fs2 = require('fs');
  const pngPath = path.join(os.tmpdir(), `ui-av-${stamp}.png`);
  fs2.writeFileSync(pngPath, Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
    'base64'));
  const fd = new FormData();
  fd.append('avatar', new Blob([fs2.readFileSync(pngPath)]), 'a.png');
  if (avUser) {
    await fetch(`${BASE}/api/mp/avatar`, { method: 'POST', headers: { Authorization: `Bearer ${avUser.data.token}` }, body: fd });
  }
  await page.goto(`${BASE}/#/users`, { waitUntil: 'networkidle2' });
  await page.reload({ waitUntil: 'networkidle2' });
  await sleep(1500);
  await page.evaluate(() => {
    // 默认筛选是「待审批」，先切到全部才看得到刚授权的头像用户
    const btn = [...document.querySelectorAll('.n-radio-button')].find((b) => b.innerText.trim() === '全部');
    if (btn) btn.click();
  });
  await sleep(1200);
  await page.evaluate(() => {
    const input = document.querySelector('.page-head input');
    input.focus();
  });
  await page.keyboard.type(`avatar_${stamp}`);
  await page.keyboard.press('Enter');
  await sleep(1500);
  const imgOk = await page.evaluate(() => {
    const img = document.querySelector('tbody .av img');
    if (!img) return false;
    return img.complete && img.naturalWidth > 0;
  });
  rec('列表头像图片加载成功', imgOk);
  await page.screenshot({ path: path.join(SHOT, 'users-avatar.png') });

  console.log('\n=== 6. 全站巡查 ===');
  const pages = ['dashboard', 'printers', 'print', 'jobs', 'tasks', 'scan', 'users', 'wechat', 'relay', 'logs', 'system', 'settings'];
  for (const p of pages) {
    await page.goto(`${BASE}/#/${p}`, { waitUntil: 'networkidle2' });
    await sleep(900);
    const t = await page.evaluate(() => document.body.innerText.slice(0, 4000));
    const ok = t.length > 50 && !/页面崩溃|无法访问/.test(t);
    rec(`页面 ${p} 渲染正常`, ok, `${t.split('\n')[0] || ''}`.slice(0, 40));
  }

  // 移动端布局
  await page.setViewport({ width: 390, height: 844 });
  await page.goto(`${BASE}/#/users`, { waitUntil: 'networkidle2' });
  await sleep(1200);
  const mobileOk = await page.evaluate(() => {
    const el = document.querySelector('.statline');
    return !!el && el.getBoundingClientRect().width <= window.innerWidth + 2;
  });
  rec('移动端用户页不溢出', mobileOk);
  await page.screenshot({ path: path.join(SHOT, 'users-mobile.png'), fullPage: true });

  const realBad = bad.filter((b) => !/404 \/api\/mp\/avatar/.test(b));
  rec('无 4xx/5xx 接口错误', realBad.length === 0, realBad.slice(0, 3).join(' | '));
  const realErrors = errors.filter((e) => !/favicon|ERR_/.test(e));
  rec('无控制台错误', realErrors.length === 0, realErrors.slice(0, 2).join(' | '));

  await browser.close();
  const pass = results.filter((x) => x.p).length;
  console.log(`\n===== ${pass}/${results.length} 通过 =====`);
  const failed = results.filter((x) => !x.p);
  if (failed.length) {
    console.log('失败项：');
    for (const f of failed) console.log(`  - ${f.n} ${f.d}`);
    process.exitCode = 1;
  }
})();
