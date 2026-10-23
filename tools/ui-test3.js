// 交互级回归：表单保存、预览、扫描结果一键添加、日志切换、移动端布局
const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');

const BASE = process.env.PG_BASE || 'http://127.0.0.1:8081';
const PASS = process.env.PG_PASS || 'Local2026pass';
const CIDR = process.env.PG_CIDR || '';
const OUT = require('./_paths').shotsDir();
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';

(async () => {
  const browser = await puppeteer.launch({ executablePath: EDGE, headless: 'new', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  const errs = [];
  page.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text().slice(0, 160)); });
  page.on('response', (r) => {
    const u = r.url();
    if (u.startsWith(BASE) && u.includes('/api/') && r.status() >= 400) errs.push(`http ${r.status()} ${u.replace(BASE, '')}`);
  });

  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const ok = (n, p, d = '') => console.log(`${p ? '✔' : '✘'} ${n}${d ? ' — ' + d : ''}`);
  const clickText = async (txt, sel = 'button') => page.evaluate((t, s) => {
    const el = [...document.querySelectorAll(s)].find((x) => x.textContent.replace(/\s/g, '').includes(t.replace(/\s/g, '')));
    if (el) { el.click(); return true; }
    return false;
  }, txt, sel);
  const goto = async (hash) => { await page.evaluate((h) => { location.hash = h; }, hash); await wait(1400); };
  // NaiveUI 的下拉项依赖真实指针事件，element.click() 不会触发 select，需要鼠标坐标点击
  const mouseClickText = async (sel, text) => {
    const h = await page.evaluateHandle((s, t) => {
      const el = [...document.querySelectorAll(s)].find((x) => x.textContent.includes(t));
      return el || null;
    }, sel, text);
    const el = h.asElement();
    if (!el) return false;
    const box = await el.boundingBox();
    if (!box) return false;
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    return true;
  };

  // 登录
  await page.goto(BASE, { waitUntil: 'networkidle2' });
  await wait(800);
  await page.type('input[type=password]', PASS, { delay: 8 });
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find((x) => x.textContent.replace(/\s/g, '') === '登录');
    b && b.click();
  });
  await page.waitForFunction(() => location.hash.includes('dashboard'), { timeout: 12000 }).catch(() => {});
  ok('登录进入后台', (await page.evaluate(() => location.hash)).includes('dashboard'));

  // ---- 打印机：手动添加 + 删除 ----
  await goto('#/printers');
  await clickText('手动添加');
  await wait(900);
  await page.evaluate(() => {
    const setV = (el, v) => {
      el.value = v;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    };
    const inputs = [...document.querySelectorAll('.n-modal input')];
    const nameInput = inputs.find((i) => (i.placeholder || '').includes('Office'));
    const uriInput = inputs.find((i) => (i.placeholder || '').includes('ipp://'));
    if (nameInput) setV(nameInput, 'UI-Added-Queue');
    if (uriInput) setV(uriInput, 'socket://127.0.0.1:9100');
  });
  await clickText('添加并启用');
  await wait(3500);
  let txt = await page.evaluate(() => document.querySelector('.content')?.innerText || '');
  ok('手动添加打印机成功', /UI-Added-Queue/.test(txt), txt.includes('已添加') ? '提示已添加' : '');
  await page.screenshot({ path: path.join(OUT, 'v3-04-printer-added.png') });

  // 重复添加应报错而不是静默覆盖
  await clickText('手动添加');
  await wait(800);
  await page.evaluate(() => {
    const setV = (el, v) => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); };
    const inputs = [...document.querySelectorAll('.n-modal input')];
    const nameInput = inputs.find((i) => (i.placeholder || '').includes('Office'));
    const uriInput = inputs.find((i) => (i.placeholder || '').includes('ipp://'));
    if (nameInput) setV(nameInput, 'UI-Added-Queue');
    if (uriInput) setV(uriInput, 'socket://127.0.0.1:9999');
  });
  await clickText('添加并启用');
  await wait(2000);
  const dupMsg = await page.evaluate(() => document.querySelector('.n-message')?.innerText || '');
  ok('重复队列名给出错误提示', /已存在/.test(dupMsg), dupMsg.replace(/\n/g, ' '));
  await clickText('取消');
  await wait(600);

  // 删除刚才的队列
  const delOk = await page.evaluate(() => {
    const cards = [...document.querySelectorAll('.pcard')];
    const c = cards.find((x) => x.textContent.includes('UI-Added-Queue'));
    if (!c) return false;
    const btn = [...c.querySelectorAll('button')].pop();
    btn && btn.click();
    return true;
  });
  await wait(700);
  const dropClicked = await mouseClickText('.n-dropdown-option', '删除打印机');
  await wait(900);
  const dlgConfirm = await mouseClickText('.n-dialog button', '删除');
  await wait(2400);
  txt = await page.evaluate(() => document.querySelector('.content')?.innerText || '');
  ok('删除打印机', delOk && dropClicked && dlgConfirm && !/UI-Added-Queue/.test(txt));

  // ---- 发起打印（真实上传）→ 任务审批预览 ----
  const pdfPath = path.join(OUT, 'itest.pdf');
  const { buildTestPagePdf } = require(require('./_paths').serverSrcPath('pdf'));
  fs.writeFileSync(pdfPath, buildTestPagePdf({ printer: 'INTERACTION', time: new Date().toISOString() }));
  await goto('#/print');
  const fileInput = await page.$('input[type=file]');
  await fileInput.uploadFile(pdfPath);
  await wait(2200);
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll('button')].find((x) => x.textContent.includes('开始打印'));
    btn && btn.click();
  });
  await wait(3200);
  const sendMsg = await page.evaluate(() => document.querySelector('.n-message')?.innerText || '');
  ok('提交打印成功', /已发送|已提交/.test(sendMsg), sendMsg.replace(/\n/g, ' '));

  await goto('#/tasks');
  await clickText('全部', '.n-radio-button');
  await wait(1800);
  const hasPreview = await clickText('预览');
  await wait(2500);
  const previewOk = await page.evaluate(() => {
    const img = document.querySelector('.n-modal img');
    return img && img.src.startsWith('blob:') && img.complete && img.naturalWidth > 0;
  });
  ok('任务预览渲染 PDF 首页', hasPreview && previewOk);
  await page.screenshot({ path: path.join(OUT, 'v3-05-task-preview.png') });
  await page.keyboard.press('Escape');
  await wait(500);

  // ---- 设置保存与回读 ----
  await goto('#/settings');
  const setCopies = async (n) => {
    await page.evaluate(() => {
      const items = [...document.querySelectorAll('.n-form-item')];
      const it = items.find((x) => x.textContent.includes('单任务最大份数'));
      const input = it?.querySelector('input');
      if (input) { input.focus(); input.select(); }
    });
    await page.keyboard.down('Control'); await page.keyboard.press('A'); await page.keyboard.up('Control');
    await page.keyboard.type(String(n), { delay: 20 });
    await clickText('保存');
    await wait(1800);
  };
  await setCopies(7);
  await page.reload({ waitUntil: 'networkidle2' });
  await wait(1800);
  const copiesVal = await page.evaluate(() => {
    const items = [...document.querySelectorAll('.n-form-item')];
    const it = items.find((x) => x.textContent.includes('单任务最大份数'));
    return it?.querySelector('input')?.value || '';
  });
  ok('设置保存并在刷新后保持', copiesVal === '7', `回读=${copiesVal}`);
  await setCopies(10);

  // ---- 小程序对接：预置白名单与凭据，验证页面保存不会清空既有配置 ----
  await page.evaluate(async () => {
    const token = localStorage.getItem('printgate_token');
    await fetch('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify({
        wxAppid: 'wx1234567890abcdef',
        wxSecret: '0123456789abcdef0123456789abcdef',
        adminOpenids: ['oUITest1234567890abcd', 'oUITest0987654321dcba']
      })
    });
  });
  await goto('#/wechat');
  await wait(800);
  const tagCount = await page.evaluate(() => document.querySelectorAll('.n-dynamic-tags .n-tag').length);
  ok('白名单标签正常回显', tagCount === 2, `${tagCount} 个标签`);
  await clickText('保存接入参数');
  await wait(2000);
  const cfgMsg = await page.evaluate(() => document.querySelector('.n-message')?.innerText || '');
  const cfgApi = await page.evaluate(async () => {
    const r = await fetch('/api/settings', { headers: { Authorization: 'Bearer ' + localStorage.getItem('printgate_token') } });
    return (await r.json()).settings.wechat;
  });
  ok('小程序配置保存成功', /保存/.test(cfgMsg) && cfgApi.adminOpenids === 'oUITest1234567890abcd,oUITest0987654321dcba', cfgApi.adminOpenids);
  ok('密钥仍为掩码且未丢失', cfgApi.wxSecretConfigured && /^\w{4}\*{4}\w{4}$/.test(cfgApi.wxSecret), cfgApi.wxSecret);

  // ---- 日志页切换 ----
  await goto('#/logs');
  await clickText('运行日志', '.n-tabs-tab');
  await wait(1600);
  const logTxt = await page.evaluate(() => document.querySelector('pre.logs')?.innerText || '');
  ok('运行日志可读', logTxt.length > 20, logTxt.slice(0, 40).replace(/\n/g, ' '));
  await clickText('登录尝试', '.n-tabs-tab');
  await wait(1400);
  const attTxt = await page.evaluate(() => document.querySelector('.content')?.innerText || '');
  ok('登录尝试页可切换', /登录尝试|失败/.test(attTxt));

  // ---- 自动扫描：深度扫描 + 一键添加 ----
  if (CIDR) {
    await goto('#/printers');
    await clickText('自动扫描打印机');
    // 打开抽屉会自动起一次快速扫描，等它结束再切深度，否则按钮处于 loading 点不动
    for (let i = 0; i < 25; i++) {
      await wait(1000);
      const busy = await page.evaluate(() => !!document.querySelector('.n-drawer .n-progress'));
      if (!busy) break;
    }
    await clickText('深度扫描', '.n-radio-button');
    await wait(500);
    await page.evaluate((cidr) => {
      const inputs = [...document.querySelectorAll('.n-drawer input')];
      const target = inputs.find((i) => i.placeholder && i.placeholder.includes('/24'));
      if (target) {
        target.value = cidr;
        target.dispatchEvent(new Event('input', { bubbles: true }));
      }
    }, CIDR);
    await wait(400);
    await clickText('开始扫描');
    let found = 0;
    for (let i = 0; i < 30; i++) {
      await wait(1000);
      found = await page.evaluate(() => document.querySelectorAll('.found').length);
      const scanning = await page.evaluate(() => !!document.querySelector('.n-progress'));
      if (found > 0 && !scanning) break;
      if (!scanning && i > 8) break;
    }
    ok('深度扫描发现设备', found > 0, `${found} 个候选`);
    if (found > 0) {
      await page.evaluate(() => {
        const b = [...document.querySelectorAll('.found button')].find((x) => x.textContent.includes('添加'));
        b && b.click();
      });
      await wait(1000);
      await clickText('添加并启用');
      await wait(3500);
      const added = await page.evaluate(() => document.querySelector('.content')?.innerText || '');
      ok('扫描结果一键添加成功', /已添加|队列/.test(added) && !/添加失败/.test(added));
    }
    await page.screenshot({ path: path.join(OUT, 'v3-06-deep-scan.png') });
    await page.keyboard.press('Escape');
    await wait(600);
  }

  // ---- 移动端多页布局 ----
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });
  const overflow = [];
  for (const [h, name] of [['#/printers', '打印机'], ['#/print', '发起打印'], ['#/settings', '设置'], ['#/users', '用户']]) {
    await page.evaluate((x) => { location.hash = x; }, h);
    await wait(1300);
    const bad = await page.evaluate(() => document.body.scrollWidth > window.innerWidth + 2);
    if (bad) overflow.push(name);
    await page.screenshot({ path: path.join(OUT, `v3-mobile-${h.replace('#/', '')}.png`) });
  }
  ok('移动端四页无横向溢出', overflow.length === 0, overflow.join(','));
  await page.setViewport({ width: 1440, height: 900 });

  if (errs.length) {
    console.log('异常记录：');
    [...new Set(errs)].slice(0, 10).forEach((e) => console.log(' -', e));
  } else {
    console.log('无控制台错误、无 4xx/5xx');
  }
  await browser.close();
})().catch((e) => { console.error('FATAL', e); process.exit(2); });
