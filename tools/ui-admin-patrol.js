'use strict';
// 管理端交互巡查：登录页 / 日志审计 / 系统状态 / 小程序对接 / 系统设置 的按钮级操作
// 每个页面都实际点一遍，收集控制台错误与 4xx/5xx
// 用法：PG_BASE=http://127.0.0.1:8099 PG_PASS=xxx node tools/ui-admin-patrol.js
const path = require('path');
const fs = require('fs');
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
// 按钮文案里可能有空格（如「登 录」），比对前先压掉空白
const clickText = (t) => {
  const key = String(t).replace(/\s+/g, '');
  return [...document.querySelectorAll('button')].find((b) => b.innerText.replace(/\s+/g, '').includes(key));
};

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
  // 登录阶段会故意输错一次密码（服务端按设计返回 403），这段时间的登录失败不计入问题
  let loginPhase = true;
  page.on('response', (res) => {
    const u = res.url();
    if (u.includes('/api/') && res.status() >= 400) {
      bad.push({ text: `${res.status()} ${u.replace(BASE, '')}`, phase: loginPhase ? 'login' : 'app' });
    }
  });

  // 清掉历史失败记录，避免上一轮测试留下的锁定影响本轮登录
  await req('DELETE', '/api/security/attempts', undefined, ADMIN);

  console.log('=== 1. 登录页（未登录态） ===');
  await page.goto(`${BASE}/#/login`, { waitUntil: 'networkidle2' });
  await page.evaluate(() => localStorage.removeItem('printgate_token'));
  await page.reload({ waitUntil: 'networkidle2' });
  await sleep(1200);
  let txt = await page.evaluate(() => document.body.innerText);
  rec('登录页渲染', /登录/.test(txt), txt.split('\n')[0] || '');
  await page.type('input[type="password"]', 'wrong-password');
  await page.evaluate(`(${clickText})('登录').click()`);
  await sleep(1500);
  txt = await page.evaluate(() => document.body.innerText);
  const errShown = await page.evaluate(() => {
    const alert = document.querySelector('.n-alert');
    return alert ? alert.innerText.slice(0, 60) : '';
  });
  rec('错误密码弹出错误提示', !!errShown && !/^使用部署时/.test(errShown), errShown || '(无提示)');
  const qrTab = await page.evaluate(() => /扫码/.test(document.body.innerText));
  rec('登录页含扫码入口', qrTab);
  await page.screenshot({ path: path.join(SHOT, 'patrol-login.png') });

  console.log('\n=== 2. 登录并进入后台 ===');
  await page.type('input[type="password"]', '');
  await page.evaluate(() => {
    const i = document.querySelector('input[type="password"]');
    i.value = '';
    i.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.type('input[type="password"]', PASS);
  await page.evaluate(`(${clickText})('登录').click()`);
  await sleep(2000);
  rec('正确密码可登录', !page.url().includes('/login'), page.url().split('#')[1] || '');
  loginPhase = false;

  console.log('\n=== 3. 日志审计（三个 Tab） ===');
  await page.goto(`${BASE}/#/logs`, { waitUntil: 'networkidle2' });
  await sleep(1500);
  txt = await page.evaluate(() => document.body.innerText);
  rec('审计页渲染', /审计|日志/.test(txt));
  for (const tab of ['审计日志', '运行日志', '登录尝试']) {
    const clicked = await page.evaluate((t) => {
      const el = [...document.querySelectorAll('.n-tabs-tab, .n-tab, .n-radio-button, button')]
        .find((b) => b.innerText.replace(/\s+/g, '').includes(t.replace(/\s+/g, '')));
      if (el) { el.click(); return true; }
      return false;
    }, tab);
    await sleep(1400);
    const shown = await page.evaluate((t) => {
      const panes = [...document.querySelectorAll('.n-tab-pane')];
      const active = panes.find((p) => p.style.display !== 'none' && p.offsetParent !== null);
      return { text: (active ? active.innerText : document.body.innerText).slice(0, 120), len: (active ? active.innerText : '').length };
    }, tab);
    rec(`切换到「${tab}」有内容`, clicked && (shown.len > 20 || /暂无|没有|—/.test(shown.text)),
      `${shown.len} 字：${shown.text.split('\n')[0] || ''}`);
  }
  await page.screenshot({ path: path.join(SHOT, 'patrol-logs.png'), fullPage: true });

  console.log('\n=== 4. 系统状态页 ===');
  await page.goto(`${BASE}/#/system`, { waitUntil: 'networkidle2' });
  await sleep(1500);
  txt = await page.evaluate(() => document.body.innerText);
  rec('系统页渲染', /系统|运行/.test(txt));
  const refreshed = await page.evaluate(`(${clickText})('刷新') ? true : false`);
  if (refreshed) await page.evaluate(`(${clickText})('刷新').click()`);
  await sleep(1500);
  rec('刷新按钮可用', refreshed);

  console.log('\n=== 4b. 任务审批页：提交者头像与微信号 ===');
  await page.goto(`${BASE}/#/tasks`, { waitUntil: 'networkidle2' });
  await sleep(1500);
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll('.n-radio-button')].find((b) => b.innerText.trim() === '全部');
    if (btn) btn.click();
  });
  await sleep(1500);
  const whoCount = await page.evaluate(() => document.querySelectorAll('.who-av').length);
  rec('任务行显示提交者头像', whoCount > 0, `${whoCount} 个`);
  if (whoCount) {
    await page.hover('.who-name');
    await sleep(900);
    const pop = await page.evaluate(() => {
      const p = document.querySelector('.who-pop');
      return p ? p.innerText : '';
    });
    rec('悬停显示微信号 / 手机号', /微信号/.test(pop) && /手机号/.test(pop), pop.replace(/\n/g, ' | ').slice(0, 60));
    // 点「查看用户资料」应跳到用户页并直接打开该用户的抽屉
    await page.evaluate(() => {
      const b = [...document.querySelectorAll('.who-pop button')].find((x) => x.innerText.includes('查看用户资料'));
      if (b) b.click();
    });
    await sleep(1500);
    const jumped = await page.evaluate(() => ({
      url: location.hash,
      drawer: !!document.querySelector('.n-drawer') && /微信号|申请说明/.test((document.querySelector('.n-drawer') || {}).innerText || '')
    }));
    rec('跳转用户页并打开资料抽屉', jumped.url.includes('uid=') && jumped.drawer, jumped.url);
  }
  await page.screenshot({ path: path.join(SHOT, 'patrol-tasks.png'), fullPage: true });

  console.log('\n=== 5. 小程序对接页：保存与重新生成 ===');
  await page.goto(`${BASE}/#/wechat`, { waitUntil: 'networkidle2' });
  await sleep(1800);
  txt = await page.evaluate(() => document.body.innerText);
  rec('对接页渲染', /小程序|AppID|绑定/.test(txt));
  const before = await req('GET', '/api/wechat/config', undefined, ADMIN);
  const saved = await page.evaluate(`(${clickText})('保存') ? ((${clickText})('保存')).click() || true : false`);
  await sleep(1800);
  const after = await req('GET', '/api/wechat/config', undefined, ADMIN);
  rec('保存配置不报错', !!saved && JSON.stringify(before.data) === JSON.stringify(after.data),
    `${JSON.stringify(before.data).slice(0, 60)}`);
  const regen = await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find((x) => /重新生成|重新获取|重置/.test(x.innerText));
    if (!b) return false;
    b.click();
    return true;
  });
  if (regen) {
    await sleep(600);
    await page.evaluate(() => {
      const b = [...document.querySelectorAll('.n-dialog button, .n-modal button')].find((x) => /确定|确认|重新/.test(x.innerText));
      if (b) b.click();
    });
  }
  await sleep(1500);
  const after2 = await req('GET', '/api/wechat/config', undefined, ADMIN);
  rec('重新生成绑定码生效', !regen || (after2.data.bindToken || after2.data.config?.bindToken || '') !== (before.data.bindToken || before.data.config?.bindToken || ''),
    regen ? '已触发' : '（未找到按钮）');
  await page.screenshot({ path: path.join(SHOT, 'patrol-wechat.png'), fullPage: true });

  console.log('\n=== 6. 系统设置：改份数上限并回读 ===');
  await page.goto(`${BASE}/#/settings`, { waitUntil: 'networkidle2' });
  await sleep(1800);
  // 直接定位「单任务最大份数」，别改到 CUPS 地址（那一项现在会校验格式）
  const setValue = await page.evaluate(() => {
    const items = [...document.querySelectorAll('.n-form-item')];
    const target = items.find((it) => it.innerText.includes('份数'));
    if (!target) return false;
    const input = target.querySelector('input');
    if (!input) return false;
    input.focus();
    return true;
  });
  if (setValue) {
    await page.keyboard.down('Control'); await page.keyboard.press('KeyA'); await page.keyboard.up('Control');
    await page.keyboard.type('7');
    await page.keyboard.press('Tab');
  }
  await sleep(600);
  await page.evaluate(`(${clickText})('保存') ? ((${clickText})('保存')).click() : null`);
  await sleep(2000);
  const cfg = await req('GET', '/api/settings', undefined, ADMIN);
  const copies = cfg.data?.settings?.print?.maxCopies;
  rec('设置保存后服务端可读回', copies === 7, `maxCopies=${copies}`);
  const toastOk = await page.evaluate(() => /成功|已保存/.test(document.body.innerText));
  rec('保存有成功提示且无报错弹窗', toastOk);
  await page.screenshot({ path: path.join(SHOT, 'patrol-settings.png'), fullPage: true });

  console.log('\n=== 7. 收尾检查 ===');
  const realBad = bad.filter((b) => !(b.phase === 'login' && b.text.includes('/api/auth/login')));
  rec('无 4xx/5xx（登录故意输错除外）', realBad.length === 0, realBad.map((b) => b.text).slice(0, 4).join(' | '));
  const realErrors = errors.filter((e) => !/favicon|ERR_|Failed to load resource/.test(e));
  rec('无控制台错误', realErrors.length === 0, realErrors.slice(0, 3).join(' | '));

  await browser.close();
  const pass = results.filter((x) => x.p).length;
  console.log(`\n===== ${pass}/${results.length} 通过 =====`);
  for (const f of results.filter((x) => !x.p)) console.log(`  - ${f.n} ${f.d}`);
  if (pass !== results.length) process.exitCode = 1;
})();
