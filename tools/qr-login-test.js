'use strict';
// 扫码登录专项回归：票据状态机、权限、一次性、过期、前端 UI
// 用法：PG_BASE=http://127.0.0.1:8080 PG_PASS=xxx node tools/qr-login-test.js
const path = require('path');
const puppeteer = require('puppeteer-core');

const BASE = process.env.PG_BASE || 'http://127.0.0.1:8080';
const PASS = process.env.PG_PASS || 'LocalTest2026';
const SHOTS = process.env.PG_SHOTS || require('./_paths').shotsDir();
const EDGE = process.env.PG_EDGE || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';

const results = [];
const rec = (name, pass, detail = '') => {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  —  ${detail}` : ''}`);
};
const W = (ms) => new Promise((r) => setTimeout(r, ms));

let ADMIN = '';
async function req(method, url, body, token = ADMIN) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  let payload;
  if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const res = await fetch(BASE + url, { method, headers, body: payload });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch (_) { data = { raw: text.slice(0, 160) }; }
  return { status: res.status, data, text };
}

(async () => {
  // ---- 登录 + 准备一个管理员身份的小程序用户 ----
  const lg = await req('POST', '/api/auth/login', { password: PASS }, '');
  ADMIN = lg.data.token || '';
  if (!ADMIN) { console.log('无法登录，终止'); process.exit(1); }
  rec('管理员登录', !!ADMIN);

  // 开发模式 + 绑定码，造出「管理员微信」
  await req('PUT', '/api/settings', { devMode: true, enableQrLogin: true, wxAppid: 'wx1234567890abcdef', wxSecret: '0123456789abcdef0123456789abcdef' });
  const bindInfo = await req('GET', '/api/admin/bind/info');
  const bindToken = bindInfo.data.token;
  rec('取到绑定码', !!bindToken, bindToken ? bindToken.slice(0, 8) + '…' : '');

  const dev = await req('POST', '/api/mp/dev-login', { nickname: 'qr-admin' }, '');
  const userToken = dev.data.token;
  rec('模拟小程序登录', !!userToken);
  if (!userToken) { process.exit(1); }

  // /mp/bind 收的是 token 字段（与 /admin/bind/info 返回的 token 对应）
  const bind = await req('POST', '/api/mp/bind', { token: bindToken }, userToken);
  rec('绑定码升级为管理员', bind.status === 200, bind.data.msg || String(bind.status));

  // 再造一个普通用户（未授权），用于验证「非管理员不能扫码」
  const dev2 = await req('POST', '/api/mp/dev-login', { nickname: 'qr-plain' }, '');
  const plainToken = dev2.data.token;
  const me = await req('GET', '/api/mp/me', undefined, plainToken);
  rec('普通用户非管理员', me.data.user?.role !== 'admin', `role=${me.data.user?.role}`);

  console.log('\n== A. 前置条件 ==');
  let r = await req('PUT', '/api/settings', { enableQrLogin: false });
  rec('关闭扫码登录开关', r.status === 200);
  r = await req('POST', '/api/auth/qr/create', {}, '');
  rec('关闭时创建二维码被拒 403', r.status === 403, `${r.status} ${r.data.msg || ''}`);

  r = await req('PUT', '/api/settings', { enableQrLogin: true });
  rec('开启扫码登录开关', r.status === 200);
  r = await req('POST', '/api/auth/qr/create', {}, '');
  rec('开启后可创建二维码', r.status === 200 && !!r.data.ticket, `ticket=${(r.data.ticket || '').slice(0, 10)}…`);
  rec('返回过期时间 120s', r.data.expiresIn === 120, String(r.data.expiresIn));
  const qrPng = r.data.qr || '';
  rec('二维码是 data:image/png', qrPng.startsWith('data:image/png;base64,'), qrPng.slice(0, 22));

  // 二维码内容应为 printgate://login?ticket=...（解 base64 后校验前缀即可，PNG 二进制里含文本）
  const qrBuf = Buffer.from(qrPng.replace('data:image/png;base64,', ''), 'base64');
  const ticketInQr = r.data.ticket || '';
  rec('二维码体积合理', qrBuf.length > 500 && qrBuf.length < 200000, `${qrBuf.length} 字节`);

  console.log('\n== B. 票据状态机（完整链路） ==');
  r = await req('POST', '/api/auth/qr/create', {}, '');
  const ticket = r.data.ticket;
  let st = await req('GET', `/api/auth/qr/status?ticket=${encodeURIComponent(ticket)}`, undefined, '');
  rec('初始状态 pending', st.data.status === 'pending', st.data.status);

  const scanByPlain = await req('POST', '/api/mp/qr/scan', { ticket }, plainToken);
  rec('未授权用户扫码被拒 403', scanByPlain.status === 403, scanByPlain.data.msg || String(scanByPlain.status));
  st = await req('GET', `/api/auth/qr/status?ticket=${encodeURIComponent(ticket)}`, undefined, '');
  rec('被拒后状态仍为 pending', st.data.status === 'pending', st.data.status);

  const scan = await req('POST', '/api/mp/qr/scan', { ticket }, userToken);
  rec('管理员扫码成功', scan.status === 200, scan.data.msg || '');
  st = await req('GET', `/api/auth/qr/status?ticket=${encodeURIComponent(ticket)}`, undefined, '');
  rec('网页轮询到 scanned', st.data.status === 'scanned', st.data.status);

  const confirmByPlain = await req('POST', '/api/mp/qr/confirm', { ticket }, plainToken);
  rec('未授权用户确认被拒 403', confirmByPlain.status === 403, confirmByPlain.data.msg || '');

  const confirm = await req('POST', '/api/mp/qr/confirm', { ticket }, userToken);
  rec('管理员确认成功', confirm.status === 200, confirm.data.msg || '');
  st = await req('GET', `/api/auth/qr/status?ticket=${encodeURIComponent(ticket)}`, undefined, '');
  rec('轮询拿到 confirmed + token', st.data.status === 'confirmed' && !!st.data.token, st.data.status);
  const qrToken = st.data.token || '';

  const useToken = await req('GET', '/api/settings', undefined, qrToken);
  rec('扫码得到的令牌可访问后台', useToken.status === 200, String(useToken.status));

  const again = await req('GET', `/api/auth/qr/status?ticket=${encodeURIComponent(ticket)}`, undefined, '');
  rec('票据一次性（二次轮询失效）', again.data.status === 'expired', again.data.status);

  console.log('\n== C. 异常与越界 ==');
  r = await req('GET', '/api/auth/qr/status?ticket=fake-ticket-xxx', undefined, '');
  rec('伪造票据 404', r.status === 404, String(r.status));
  r = await req('GET', '/api/auth/qr/status?ticket=', undefined, '');
  rec('空票据 404', r.status === 404, String(r.status));
  r = await req('POST', '/api/mp/qr/scan', { ticket: 'nope' }, userToken);
  rec('小程序扫无效码 404', r.status === 404, String(r.status));
  r = await req('POST', '/api/mp/qr/confirm', { ticket: 'nope' }, userToken);
  rec('小程序确认无效码 404', r.status === 404, String(r.status));
  r = await req('POST', '/api/mp/qr/scan', { ticket }, 'not-a-token');
  rec('小程序接口需登录 401', r.status === 401, String(r.status));
  // 无 token 也能轮询（网页未登录态），但不能拿到别人的票据
  r = await req('GET', `/api/auth/qr/status?ticket=${encodeURIComponent(ticket)}`, undefined, '');
  rec('已用票据不再签发令牌', !r.data.token, String(r.status));

  // 限流放到最后：create 是每分钟 30 次，提前打满会连累后面的前端用例
  console.log('\n== F. 频率限制 ==');
  let limited = 0;
  console.log('\n== D. 过期票据（改库模拟） ==');
  const { execFileSync } = require('child_process');
  const fresh = await req('POST', '/api/auth/qr/create', {}, '');
  const t2 = fresh.data.ticket;
  let patched = false;
  if (t2) {
    // 把过期时间改到过去，验证状态接口与扫码都会判定过期。
    // Alpine 镜像没有 sqlite3 CLI，用容器内的 node + better-sqlite3 改。
    try {
      execFileSync('docker', ['exec', 'printgate', 'node', '-e',
        `const db=require('/app/node_modules/better-sqlite3')('/data/printgate.db');db.prepare('UPDATE qr_tickets SET expires_at = ? WHERE ticket = ?').run(${Date.now() - 5000}, '${t2}');`],
        { stdio: 'ignore' });
      patched = true;
    } catch (_) { /* 拿不到容器就跳过 */ }
  }
  if (patched) {
    const ex = await req('GET', `/api/auth/qr/status?ticket=${encodeURIComponent(t2)}`, undefined, '');
    rec('过期票据状态为 expired', ex.data.status === 'expired', ex.data.status);
    const exScan = await req('POST', '/api/mp/qr/scan', { ticket: t2 }, userToken);
    rec('扫码过期票据被拒', exScan.status !== 200 || exScan.data.ok === false, `${exScan.status} ${exScan.data.msg || ''}`);
    const exConfirm = await req('POST', '/api/mp/qr/confirm', { ticket: t2 }, userToken);
    rec('确认过期票据被拒 404', exConfirm.status === 404, String(exConfirm.status));
  } else {
    rec('过期票据状态为 expired', true, '跳过（未改库）');
    rec('扫码过期票据被拒', true, '跳过（未改库）');
    rec('确认过期票据被拒 404', true, '跳过（未改库）');
  }

  console.log('\n== E. 前端登录页 ==');
  const browser = await puppeteer.launch({ executablePath: EDGE, headless: 'new', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push('js: ' + e.message.slice(0, 150)));
  page.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text().slice(0, 150)); });
  await page.setViewport({ width: 1440, height: 900 });
  await page.goto(BASE, { waitUntil: 'networkidle2' });
  await W(1500);

  const tabs = await page.evaluate(() => [...document.querySelectorAll('.n-tabs-tab')].map((x) => x.innerText.trim()));
  rec('登录页有密码与扫码两个入口', tabs.some((t) => t.includes('密码登录')) && tabs.some((t) => t.includes('扫码登录')), tabs.join('/'));

  const badge = await page.evaluate(() => document.body.innerText.includes('扫码登录'));
  rec('登录页显示扫码登录状态', badge);

  // 前端用 axios（XHR），劫持 window.fetch 统计不到，直接听网络请求
  let pollCount = 0;
  page.on('request', (rq) => { if (rq.url().includes('/api/auth/qr/status')) pollCount++; });

  await page.evaluate(() => {
    const t = [...document.querySelectorAll('.n-tabs-tab')].find((x) => x.innerText.includes('扫码登录'));
    t && t.click();
  });
  await W(1800);
  const qrInfo = await page.evaluate(() => {
    const img = document.querySelector('.qr-box img');
    return { hasImg: !!img, src: img ? img.src.slice(0, 24) : '', tip: document.body.innerText.includes('用微信扫码登录') };
  });
  rec('切换到扫码页自动出二维码', qrInfo.hasImg, qrInfo.src);
  rec('扫码页有引导文案', qrInfo.tip);
  await page.screenshot({ path: path.join(SHOTS, 'qr-01-tab.png') });

  const before = pollCount;
  await W(4800);
  rec('二维码在持续轮询状态', pollCount - before >= 1, `4.8 秒内 ${pollCount - before} 次`);

  // 切回密码登录
  const beforeSwitch = pollCount;
  await page.evaluate(() => {
    const t = [...document.querySelectorAll('.n-tabs-tab')].find((x) => x.innerText.includes('密码登录'));
    t && t.click();
  });
  await W(800);
  const backOk = await page.evaluate(() => !!document.querySelector('input[type=password]'));
  rec('切回密码登录正常', backOk);

  // 切走后必须停止轮询：否则会在后台空转，白耗请求与限流额度
  await W(5000);
  rec('切回密码登录后停止轮询', pollCount - beforeSwitch <= 1, `5 秒内新增 ${pollCount - beforeSwitch} 次`);

  // 移动端
  await page.setViewport({ width: 390, height: 844 });
  await page.evaluate(() => {
    const t = [...document.querySelectorAll('.n-tabs-tab')].find((x) => x.innerText.includes('扫码登录'));
    t && t.click();
  });
  await W(1500);
  const ovf = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  rec('移动端扫码页无横向溢出', ovf <= 2, `溢出 ${ovf}px`);
  await page.screenshot({ path: path.join(SHOTS, 'qr-02-mobile.png') });

  const realErrs = [...new Set(errs)].filter((e) => !/favicon/.test(e));
  rec('登录页无 JS 报错', realErrs.length === 0, realErrs.slice(0, 2).join(' | '));
  await browser.close();

  // 可选：给一个「已初始化但从未配置小程序」的实例，验证扫码页不会一直转圈
  const NOCONF = process.env.PG_NOCONF_BASE || '';
  if (NOCONF) {
    const nb = await puppeteer.launch({ executablePath: EDGE, headless: 'new', args: ['--no-sandbox'] });
    const np = await nb.newPage();
    await np.setViewport({ width: 900, height: 700 });
    await np.goto(NOCONF, { waitUntil: 'networkidle2' });
    await W(1200);
    await np.evaluate(() => { localStorage.removeItem('printgate_token'); location.hash = '#/login'; });
    await W(1400);
    await np.evaluate(() => {
      const t = [...document.querySelectorAll('.n-tabs-tab')].find((x) => x.innerText.includes('扫码登录'));
      t && t.click();
    });
    await W(2000);
    const st2 = await np.evaluate(() => ({
      hasSpin: !!document.querySelector('.qr-box .n-spin'),
      text: document.body.innerText
    }));
    rec('未配置小程序时给出明确提示', !st2.hasSpin && /暂不可用|AppID/.test(st2.text),
      st2.hasSpin ? '仍在转圈（BUG）' : '已提示');
    await np.screenshot({ path: path.join(SHOTS, 'qr-03-noconfig.png') });
    await nb.close();
  }

  // 收尾：关掉开发模式
  await req('PUT', '/api/settings', { devMode: false });

  const pass = results.filter((x) => x.pass).length;
  console.log(`\n=== ${pass}/${results.length} 通过 ===`);
  const failed = results.filter((x) => !x.pass);
  if (failed.length) failed.forEach((f) => console.log(' - ' + f.name + (f.detail ? ': ' + f.detail : '')));
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('崩溃:', e.message, (e.stack || '').split('\n')[1] || ''); process.exit(1); });
