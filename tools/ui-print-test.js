'use strict';
// 「发起打印」页回归：四种模式、打印参数、预览、记录、移动端
// 用法：PG_BASE=http://127.0.0.1:8080 PG_PASS=xxx node tools/ui-print-test.js
const path = require('path');
const fs = require('fs');
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

// 测试素材：登录后用页面截图生成，避免手工 base64 出错
let imgA = '';
let imgB = '';

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const browser = await puppeteer.launch({ executablePath: EDGE, headless: 'new', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push('js: ' + e.message.slice(0, 160)));
  page.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text().slice(0, 160)); });
  page.on('response', (r) => {
    const u = r.url();
    if (u.startsWith(BASE) && u.includes('/api/') && r.status() >= 400) errs.push(`http ${r.status()} ${u.replace(BASE, '')}`);
  });
  await page.setViewport({ width: 1440, height: 1200 });

  // 登录
  await page.goto(BASE, { waitUntil: 'networkidle2' });
  await W(900);
  const pw = await page.$('input[type=password]');
  if (pw) {
    await pw.type(PASS, { delay: 8 });
    await page.evaluate(() => {
      const b = [...document.querySelectorAll('button')].find((x) => x.textContent.replace(/\s/g, '') === '登录');
      b && b.click();
    });
    await page.waitForFunction(() => location.hash.includes('dashboard'), { timeout: 15000 }).catch(() => {});
  }
  rec('登录进入后台', (await page.evaluate(() => location.hash)).includes('dashboard'));

  // 用真实截图当上传素材（手工 base64 很容易拼出损坏的 PNG）
  imgA = path.join(SHOTS, '_tmp_inv_a.png');
  imgB = path.join(SHOTS, '_tmp_inv_b.png');
  fs.writeFileSync(imgA, await page.screenshot({ clip: { x: 0, y: 0, width: 220, height: 160 } }));
  fs.writeFileSync(imgB, await page.screenshot({ clip: { x: 220, y: 0, width: 220, height: 160 } }));

  // 固定投到虚拟打印机：真实设备可能不在线，用虚拟队列才能端到端验证落盘结果
  await page.evaluate(async () => {
    const t = localStorage.getItem('printgate_token');
    const h = { Authorization: 'Bearer ' + t, 'Content-Type': 'application/json' };
    await fetch('/api/printers/virtual', { method: 'POST', headers: h, body: '{}' });
    await fetch('/api/printers/PrintGate-Virtual/default', { method: 'POST', headers: h });
  });
  await W(1200);

  await page.evaluate(() => { location.hash = '#/print'; });
  await W(2200);

  // ---- 结构 ----
  const struct = await page.evaluate(() => {
    const txt = document.body.innerText;
    const tabs = [...document.querySelectorAll('.mt-item')].map((x) => x.innerText.trim());
    return {
      tabs,
      hasHead: txt.includes('目标打印机') && txt.includes('CUPS'),
      hasParams: txt.includes('颜色模式') && txt.includes('双面打印') && txt.includes('份数'),
      hasAdv: txt.includes('高级选项') && txt.includes('水印文字') && txt.includes('页面子集'),
      hasRight: txt.includes('预览') && txt.includes('打印记录') && txt.includes('打印机状态'),
      submitBtn: !!findBtn(),
      printerOptions: document.querySelectorAll('.n-base-selection').length
    };
    function findBtn() {
      return [...document.querySelectorAll('button')].find((x) => x.textContent.includes('开始打印'));
    }
  });
  rec('四个模式标签齐全', struct.tabs.length === 4 && struct.tabs.some((t) => t.includes('标准打印')) && struct.tabs.some((t) => t.includes('身份证')), struct.tabs.join('/'));
  rec('顶部目标打印机与 CUPS 状态', struct.hasHead);
  rec('打印参数区完整', struct.hasParams);
  rec('高级选项含页面子集与水印', struct.hasAdv);
  rec('右栏预览/记录/状态三块齐全', struct.hasRight);
  rec('开始打印按钮存在', struct.submitBtn);

  // 未选文件时按钮禁用
  const disabledNoFile = await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find((x) => x.textContent.includes('开始打印'));
    return b ? b.disabled || b.classList.contains('n-button--disabled') : null;
  });
  rec('没选文件时开始打印不可点', disabledNoFile === true, String(disabledNoFile));

  // ---- 标准打印：上传 + 预览 + 提交 ----
  const beforeCount = await page.evaluate(() => document.querySelectorAll('.rec').length);
  const fileInput = await page.$('input[type=file]');
  if (fileInput) {
    await fileInput.uploadFile(imgA);
    await W(2600);
  }
  const picked = await page.evaluate(() => !!document.querySelector('.picked'));
  rec('上传后显示已选文件', picked);
  const previewShown = await page.evaluate(() => !!document.querySelector('.preview img'));
  rec('上传后出现预览图', previewShown);

  await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find((x) => x.textContent.includes('开始打印'));
    b && b.click();
  });
  await W(2600);
  const afterCount = await page.evaluate(() => document.querySelectorAll('.rec').length);
  const msgText = await page.evaluate(() => document.querySelector('.n-message')?.innerText || '');
  rec('标准打印提交成功', /已发送|已提交/.test(msgText), msgText.slice(0, 40) || `记录 ${beforeCount}→${afterCount}`);

  // ---- 高级参数交互 ----
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('.subset .n-radio-button')].find((x) => x.textContent.includes('奇数页'));
    b && b.click();
  });
  await W(400);
  const subsetOn = await page.evaluate(() =>
    [...document.querySelectorAll('.subset .n-radio-button')].some((x) => x.classList.contains('n-radio-button--checked') && x.textContent.includes('奇数页')));
  rec('页面子集可切换为奇数页', subsetOn);

  const mirrorOk = await page.evaluate(() => {
    const cb = [...document.querySelectorAll('.n-checkbox')].find((x) => x.textContent.includes('镜像'));
    if (!cb) return false;
    cb.querySelector('.n-checkbox__input')?.click() || cb.click();
    return true;
  });
  await W(300);
  const mirrorChecked = await page.evaluate(() =>
    !!document.querySelector('.n-checkbox.n-checkbox--checked'));
  rec('镜像打印可勾选', mirrorOk && mirrorChecked);

  const wmInput = await page.evaluateHandle(() => {
    const items = [...document.querySelectorAll('.n-form-item')];
    const it = items.find((x) => x.textContent.includes('水印文字'));
    return it ? it.querySelector('input') : null;
  });
  const wmEl = wmInput.asElement();
  if (wmEl) { await wmEl.click(); await wmEl.type('内部资料', { delay: 15 }); }
  await W(300);
  const wmVal = wmEl ? await page.evaluate((el) => el.value, wmEl) : '';
  rec('水印文字可输入', wmVal === '内部资料', wmVal);

  await page.screenshot({ path: path.join(SHOTS, 'p8-advanced.png') });

  // ---- 文字速印 ----
  await page.evaluate(() => {
    const t = [...document.querySelectorAll('.mt-item')].find((x) => x.textContent.includes('文字速印'));
    t && t.click();
  });
  await W(700);
  const hasTextForm = await page.evaluate(() => !!document.querySelector('textarea'));
  rec('文字速印有正文输入框', hasTextForm);
  const ta = await page.$('textarea');
  if (ta) {
    await ta.click();
    await ta.type('文字速印自动化测试：中文内容 ABC 123。', { delay: 6 });
  }
  await W(400);
  const textBtnOn = await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find((x) => x.textContent.includes('开始打印'));
    return b ? !(b.disabled || b.classList.contains('n-button--disabled')) : false;
  });
  rec('输入文字后按钮可用', textBtnOn);
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find((x) => x.textContent.includes('开始打印'));
    b && b.click();
  });
  await W(3000);
  const textMsg = await page.evaluate(() => document.querySelector('.n-message')?.innerText || '');
  rec('文字速印提交成功', /已发送|已提交/.test(textMsg), textMsg.slice(0, 40));
  await page.screenshot({ path: path.join(SHOTS, 'p9-text.png') });

  // ---- 发票打印（多图合排） ----
  await page.evaluate(() => {
    const t = [...document.querySelectorAll('.mt-item')].find((x) => x.textContent.includes('发票'));
    t && t.click();
  });
  await W(700);
  const invInput = await page.$('input[type=file][multiple]');
  rec('发票模式上传框支持多选', !!invInput);
  if (invInput) {
    await invInput.uploadFile(imgA, imgB);
    await W(3000);
  }
  const thumbCount = await page.evaluate(() => document.querySelectorAll('.thumb').length);
  rec('多图上传后有缩略图', thumbCount === 2, `${thumbCount} 张`);
  const perPage = await page.evaluate(() => document.body.innerText.includes('每页张数'));
  rec('发票模式有每页张数设置', perPage);
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find((x) => x.textContent.includes('开始打印'));
    b && b.click();
  });
  await W(3200);
  const invMsg = await page.evaluate(() => document.querySelector('.n-message')?.innerText || '');
  rec('发票合排提交成功', /已发送|已提交/.test(invMsg), invMsg.slice(0, 40));
  await page.screenshot({ path: path.join(SHOTS, 'p10-invoice.png') });

  // ---- 身份证打印 ----
  await page.evaluate(() => {
    const t = [...document.querySelectorAll('.mt-item')].find((x) => x.textContent.includes('身份证'));
    t && t.click();
  });
  await W(700);
  const slots = await page.evaluate(() => document.querySelectorAll('.idcard-slot').length);
  rec('身份证模式有正反两个槽位', slots === 2, `${slots} 个`);
  const idInputHandle = await page.$('input[type=file][accept=".jpg,.jpeg,.png"]');
  if (idInputHandle) {
    // 点击槽位打开文件框（隐藏 input 由槽位 click 触发，这里直接塞文件）
    await page.evaluate(() => {
      const s = document.querySelector('.idcard-slot');
      s && s.click();
    });
    await W(300);
    await idInputHandle.uploadFile(imgA);
    await W(2600);
  }
  const idShown = await page.evaluate(() => !!document.querySelector('.idcard-slot img'));
  rec('身份证上传后显示缩略图', idShown);
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find((x) => x.textContent.includes('开始打印'));
    b && b.click();
  });
  await W(3000);
  const idMsg = await page.evaluate(() => document.querySelector('.n-message')?.innerText || '');
  rec('身份证合排提交成功', /已发送|已提交/.test(idMsg), idMsg.slice(0, 40));
  await page.screenshot({ path: path.join(SHOTS, 'p11-idcard.png') });

  // ---- 打印机状态区 ----
  const stat = await page.evaluate(() => {
    const txt = document.body.innerText;
    return {
      hasMarker: txt.includes('墨盒信息'),
      hasTray: txt.includes('纸盒信息'),
      hasQueue: txt.includes('队列任务数')
    };
  });
  rec('打印机状态含墨盒/纸盒/队列', stat.hasMarker && stat.hasTray && stat.hasQueue);

  // ---- 移动端 ----
  await page.setViewport({ width: 390, height: 844 });
  await W(900);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  rec('移动端无横向溢出', overflow <= 2, `溢出 ${overflow}px`);
  await page.screenshot({ path: path.join(SHOTS, 'p12-mobile.png') });

  // ---- 控制台 ----
  const realErrs = [...new Set(errs)].filter((e) => !/favicon/.test(e));
  rec('无 JS 报错 / 4xx', realErrs.length === 0, realErrs.slice(0, 3).join(' | '));

  // 清理本次跑测试产生的文件，避免界面上堆满 _tmp_inv_*.png / *合排.pdf
  try {
    const cleaned = await page.evaluate(async () => {
      const t = localStorage.getItem('printgate_token');
      const h = { Authorization: 'Bearer ' + t };
      const r = await fetch('/api/files', { headers: h }).then((x) => x.json()).catch(() => ({}));
      let n = 0;
      for (const f of (r.files || [])) {
        if (/^_tmp_inv_|^发票合排\.pdf$|^身份证合排\.pdf$|^文字速印\.pdf$/.test(f.filename)) {
          const d = await fetch('/api/files/' + f.id, { method: 'DELETE', headers: h }).catch(() => null);
          if (d && d.ok) n++;
        }
      }
      return n;
    });
    if (cleaned) console.log(`（已清理测试文件 ${cleaned} 个）`);
  } catch (_) { /* 清理失败不影响结论 */ }

  await browser.close();
  try { fs.unlinkSync(imgA); fs.unlinkSync(imgB); } catch (_) {}

  const pass = results.filter((r) => r.pass).length;
  console.log(`\n总计 ${results.length} 项，失败 ${results.length - pass} 项`);
  if (pass !== results.length) {
    results.filter((r) => !r.pass).forEach((r) => console.log(' - ' + r.name + (r.detail ? ': ' + r.detail : '')));
  }
  process.exit(pass === results.length ? 0 : 1);
})().catch((e) => { console.error('崩溃:', e.message); process.exit(1); });
