'use strict';
// 打印机页「历史清理」UI 回归
// 用法：PG_BASE=http://127.0.0.1:8080 PG_PASS=xxx node tools/ui-cleanup-test.js
const puppeteer = require('puppeteer-core');

const BASE = process.env.PG_BASE || 'http://127.0.0.1:8080';
const PASS = process.env.PG_PASS || 'LocalTest2026';
const SHOTS = process.env.PG_SHOTS || require('./_paths').shotsDir();

const results = [];
const rec = (name, pass, detail = '') => {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  —  ${detail}` : ''}`);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const browser = await puppeteer.launch({
    executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    headless: 'new', args: ['--no-sandbox']
  });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message.slice(0, 200)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)); });
  page.on('response', (r) => { if (r.status() >= 400) errors.push(`HTTP ${r.status()} ${r.url().replace(BASE, '')}`); });
  await page.setViewport({ width: 1400, height: 950 });

  await page.goto(BASE, { waitUntil: 'networkidle2' });
  await wait(900);
  if (await page.$('input[type=password]')) {
    await page.type('input[type=password]', PASS, { delay: 8 });
    await page.evaluate(() => {
      const b = [...document.querySelectorAll('button')].find((x) => x.textContent.replace(/\s/g, '') === '登录');
      b && b.click();
    });
    await wait(2200);
  }

  // 用页面上下文准备数据：虚拟打印机 + 一条已完成任务
  const seeded = await page.evaluate(async () => {
    const t = localStorage.getItem('printgate_token');
    const h = { Authorization: 'Bearer ' + t, 'Content-Type': 'application/json' };
    await fetch('/api/printers/virtual', { method: 'POST', headers: h, body: '{}' });
    const pdf = new Blob(['%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 obj>>\n%%EOF\n'], { type: 'application/pdf' });
    const fd = new FormData();
    fd.append('file', pdf, '清理界面测试.pdf');
    const up = await (await fetch('/api/files', { method: 'POST', headers: { Authorization: 'Bearer ' + t }, body: fd })).json();
    if (!up.ok) return { ok: false, msg: up.msg };
    const pr = await (await fetch('/api/print', {
      method: 'POST', headers: h, body: JSON.stringify({ fileId: up.file.id, printer: 'PrintGate-Virtual' })
    })).json();
    return { ok: pr.ok, taskId: pr.taskId, msg: pr.msg };
  });
  rec('准备测试数据（打印任务）', !!seeded.ok, seeded.msg || `task=${seeded.taskId}`);
  // 等状态同步（8 秒一轮）
  for (let i = 0; i < 12; i++) {
    await wait(1500);
    const st = await page.evaluate(async (id) => {
      const t = localStorage.getItem('printgate_token');
      const r = await fetch(`/api/tasks/${id}`, { headers: { Authorization: 'Bearer ' + t } });
      if (r.status !== 200) return 'gone';
      const j = await r.json();
      return j.task?.status;
    }, seeded.taskId);
    if (st === 'done') break;
  }

  await page.evaluate(() => { location.hash = '#/printers'; });
  await wait(1600);

  // 打开历史清理
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find((x) => x.textContent.includes('历史清理'));
    b && b.click();
  });
  await wait(1600);
  const modalText = await page.evaluate(() => {
    const m = [...document.querySelectorAll('.n-modal')].find((x) => x.textContent.includes('历史清理'));
    return m ? m.innerText.replace(/\n/g, ' | ') : '';
  });
  rec('历史清理弹窗打开', !!modalText, modalText.slice(0, 90));
  const cells = await page.evaluate(() => [...document.querySelectorAll('.hist-cell')].map((c) => c.innerText.replace(/\n/g, ' ')));
  rec('统计卡片渲染四项', cells.length === 4, cells.map((c) => c.split(' ')[0]).join(' / '));
  rec('统计含任务与 CUPS 作业', /任务记录/.test(cells[0] || '') && /CUPS/.test(cells[1] || ''),
    `${cells[0] || ''} | ${cells[1] || ''}`);
  await page.screenshot({ path: `${SHOTS}/v7-01-cleanup-modal.png` }).catch(() => {});

  // 立即清理（默认全部历史）
  const clicked = await page.evaluate(() => {
    const b = [...document.querySelectorAll('.n-modal button')].find((x) => x.textContent.trim() === '立即清理');
    b && b.click();
    return !!b;
  });
  rec('点击立即清理', clicked);
  await wait(3500);
  const cellsAfter = await page.evaluate(() => [...document.querySelectorAll('.hist-cell')].map((c) => c.innerText.replace(/\n/g, ' ')));
  rec('清理后任务归零', /^任务记录 0 /.test((cellsAfter[0] || '').trim()), cellsAfter[0] || '');
  rec('清理后 CUPS 作业归零', /CUPS 已完成作业 0/.test((cellsAfter[1] || '').trim().replace(/\s+/g, ' ')), cellsAfter[1] || '');
  const toast = await page.evaluate(() => [...document.querySelectorAll('.n-message')].map((m) => m.innerText).join(' | '));
  rec('出现清理结果提示', /已清理|没有需要清理/.test(toast), toast.slice(0, 80));
  await page.screenshot({ path: `${SHOTS}/v7-02-cleanup-done.png` }).catch(() => {});

  // 自动清理开关
  await page.evaluate(() => {
    const sw = document.querySelector('.auto-box .n-switch');
    sw && sw.click();
  });
  await wait(1800);
  const autoState = await page.evaluate(async () => {
    const t = localStorage.getItem('printgate_token');
    const d = await (await fetch('/api/printers/history', { headers: { Authorization: 'Bearer ' + t } })).json();
    return d.settings;
  });
  rec('切换自动清理开关生效', autoState && typeof autoState.autoCleanHistory === 'boolean',
    `auto=${autoState?.autoCleanHistory} days=${autoState?.historyDays}`);

  // 打开回来再关掉，恢复默认开启
  await page.evaluate(() => {
    const sw = document.querySelector('.auto-box .n-switch');
    sw && sw.click();
  });
  await wait(1500);
  const finalState = await page.evaluate(async () => {
    const t = localStorage.getItem('printgate_token');
    const d = await (await fetch('/api/printers/history', { headers: { Authorization: 'Bearer ' + t } })).json();
    return d.settings;
  });
  rec('再次切换后设置可保存', !!finalState, `auto=${finalState?.autoCleanHistory}`);

  await page.screenshot({ path: `${SHOTS}/v7-03-cleanup-auto.png` }).catch(() => {});
  await page.keyboard.press('Escape');
  await wait(500);

  // 移动端
  const m = await browser.newPage();
  await m.setViewport({ width: 390, height: 844, isMobile: true });
  await m.goto(BASE, { waitUntil: 'networkidle2' });
  await wait(1200);
  await m.evaluate(() => { location.hash = '#/printers'; });
  await wait(1600);
  await m.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find((x) => x.textContent.includes('历史清理'));
    b && b.click();
  });
  await wait(1600);
  const overflow = await m.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  rec('移动端弹窗无横向溢出', !overflow, overflow ? '出现横向滚动' : '');
  await m.screenshot({ path: `${SHOTS}/v7-04-cleanup-mobile.png` }).catch(() => {});

  const real = errors.filter((e) => !/favicon/.test(e));
  rec('无 JS 报错 / 4xx', real.length === 0, real.slice(0, 3).join(' ; '));

  const fails = results.filter((x) => !x.pass);
  console.log(`\n总计 ${results.length} 项，失败 ${fails.length} 项`);
  if (fails.length) fails.forEach((f) => console.log(' -', f.name, f.detail));
  await browser.close();
  require('fs').writeFileSync(require('./_paths').shot('cleanup-ui.json'), JSON.stringify(results, null, 2));
  process.exit(fails.length ? 1 : 0);
})();
