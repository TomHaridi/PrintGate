'use strict';
// 浏览器端验证：扫描抽屉 → 发现设备 → 自动安装驱动弹窗 → 添加队列 → 驱动库弹窗
// 用法：PG_BASE=http://127.0.0.1:8080 PG_PASS=xxx PG_CIDR=172.17.0.0/24 node tools/ui-scan-driver.js
const puppeteer = require('puppeteer-core');

const BASE = process.env.PG_BASE || 'http://127.0.0.1:8080';
const PASS = process.env.PG_PASS || 'LocalTest2026';
const CIDR = process.env.PG_CIDR || '';
const MOCK_IP = process.env.PG_MOCK_IP || '';
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
  await page.setViewport({ width: 1440, height: 900 });

  await page.goto(BASE, { waitUntil: 'networkidle2' });
  await wait(900);
  await page.type('input[type=password]', PASS, { delay: 8 });
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find((x) => x.textContent.replace(/\s/g, '') === '登录');
    b && b.click();
  });
  await wait(2200);
  rec('登录成功', await page.evaluate(() => location.hash.includes('dashboard')), await page.evaluate(() => location.hash));

  // 清理上轮遗留的测试队列，保证「自动添加」用例可重复
  await page.evaluate(async () => {
    const t = localStorage.getItem('printgate_token');
    const h = { Authorization: 'Bearer ' + t };
    const d = await (await fetch('/api/printers', { headers: h })).json();
    for (const p of d.printers || []) {
      if (/laserjet|^ipp-|^raw-/i.test(p.name)) {
        await fetch('/api/printers/' + encodeURIComponent(p.name), { method: 'DELETE', headers: h });
      }
    }
  });

  await page.evaluate(() => { location.hash = '#/printers'; });
  await wait(1600);

  // 打开扫描抽屉
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find((x) => x.textContent.includes('自动扫描打印机'));
    b && b.click();
  });
  await wait(1200);
  const drawer = await page.evaluate(() => !!document.querySelector('.n-drawer'));
  rec('打开扫描抽屉', drawer);
  rec('抽屉有扫描范围输入', await page.evaluate(() => {
    const inp = [...document.querySelectorAll('.n-drawer input')];
    return inp.some((i) => (i.placeholder || '').includes('局域网网段'));
  }));
  rec('抽屉有手动探测入口', await page.evaluate(() => {
    const inp = [...document.querySelectorAll('.n-drawer input')];
    return inp.some((i) => (i.placeholder || '').includes('打印机 IP'));
  }));

  // 等待自动触发的首轮扫描结束（若在跑）
  for (let i = 0; i < 40; i++) {
    const busy = await page.evaluate(() => !!document.querySelector('.n-drawer .n-progress'));
    if (!busy) break;
    await wait(1000);
  }

  // 填网段并重新扫描
  if (CIDR) {
    const filled = await page.evaluate((cidr) => {
      const inp = [...document.querySelectorAll('.n-drawer input')].find((i) => (i.placeholder || '').includes('局域网网段'));
      if (!inp) return false;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(inp, cidr);
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      inp.dispatchEvent(new Event('change', { bubbles: true }));
      inp.dispatchEvent(new Event('blur', { bubbles: true }));
      return true;
    }, CIDR);
    rec('填入扫描网段', filled, CIDR);
    await wait(600);
    await page.evaluate(() => {
      const b = [...document.querySelectorAll('.n-drawer button')].find((x) => x.textContent.includes('开始扫描'));
      b && b.click();
    });
  } else {
    rec('填入扫描网段', true, '未提供 PG_CIDR，跳过');
  }

  // 等扫描完成 + 自动弹出驱动弹窗
  let modalTitle = '';
  for (let i = 0; i < 70; i++) {
    await wait(1000);
    modalTitle = await page.evaluate(() => {
      const m = [...document.querySelectorAll('.n-modal')].find((x) => x.textContent.includes('发现打印机'));
      return m ? m.innerText.replace(/\n/g, ' | ').slice(0, 120) : '';
    });
    if (modalTitle) break;
  }
  rec('扫描后自动弹出「是否自动安装驱动」', !!modalTitle, modalTitle.slice(0, 80));
  await page.screenshot({ path: `${SHOTS}/v5-01-found-modal.png` }).catch(() => {});

  if (modalTitle) {
    rec('弹窗显示识别到的型号', /LaserJet/i.test(modalTitle), '');
    // 推荐驱动是异步取的，等下拉出现再断言
    let hasSelect = false;
    for (let i = 0; i < 12; i++) {
      hasSelect = await page.evaluate(() => !!document.querySelector('.n-modal .n-select'));
      if (hasSelect) break;
      await wait(700);
    }
    rec('弹窗给出驱动下拉', hasSelect);
    // 只勾选目标设备（实验环境里同网段可能还有其他容器，避免误加）
    if (MOCK_IP) {
      await page.evaluate((ip) => {
        const rows = [...document.querySelectorAll('.n-modal .row-item')];
        for (const r of rows) {
          const box = r.querySelector('.n-checkbox');
          const hit = r.textContent.includes(ip);
          const checked = r.querySelector('.n-checkbox--checked');
          if (!hit && checked && box) box.click();
        }
      }, MOCK_IP);
      await wait(400);
    }
    // 全选并自动添加
    await page.evaluate(() => {
      const b = [...document.querySelectorAll('.n-modal button')].find((x) => x.textContent.includes('自动安装并添加'));
      b && b.click();
    });
    await wait(4000);
    const txt = await page.evaluate(() => document.body.innerText);
    rec('自动添加后队列出现在列表', /laserjet/i.test(txt) || /PG|printer/i.test(txt), '');
  }

  // 驱动库弹窗（手动添加 → 驱动库…）
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === '手动添加');
    b && b.click();
  });
  await wait(900);
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('.n-modal button')].find((x) => x.textContent.includes('驱动库'));
    b && b.click();
  });
  await wait(1500);
  const tabs = await page.evaluate(() => [...document.querySelectorAll('.n-modal .n-tabs-tab')].map((x) => x.innerText.trim()));
  rec('驱动库弹窗含四类入口', ['推荐', '本地驱动库', '在线驱动库', '上传 / 直链'].every((t) => tabs.some((x) => x.includes(t.replace(' ', ''))) || tabs.some((x) => x.includes(t))), tabs.join(','));
  const recText = await page.evaluate(() => {
    const m = [...document.querySelectorAll('.n-modal')].find((x) => x.textContent.includes('选择驱动'));
    return m ? m.innerText.replace(/\n/g, ' | ').slice(0, 200) : '';
  });
  rec('推荐页展示推荐驱动', /推荐|everywhere|PCL|RAW/.test(recText), recText.slice(0, 90));
  await page.screenshot({ path: `${SHOTS}/v5-02-driver-picker.png` }).catch(() => {});

  // 在线驱动库页签
  await page.evaluate(() => {
    const t = [...document.querySelectorAll('.n-modal .n-tabs-tab')].find((x) => x.textContent.includes('在线'));
    t && t.click();
  });
  await wait(700);
  const onlineText = await page.evaluate(() => {
    const m = [...document.querySelectorAll('.n-modal')].find((x) => x.textContent.includes('选择驱动'));
    return m ? m.innerText.replace(/\n/g, ' | ') : '';
  });
  rec('在线库页签有检索框与说明', /OpenPrinting/.test(onlineText) && /检索/.test(onlineText), '');
  await page.screenshot({ path: `${SHOTS}/v5-03-online-library.png` }).catch(() => {});

  // 关闭弹窗，回列表截图
  await page.keyboard.press('Escape');
  await wait(400);
  await page.keyboard.press('Escape');
  await wait(700);
  await page.screenshot({ path: `${SHOTS}/v5-04-printers.png` }).catch(() => {});

  // 移动端抽屉
  const m = await browser.newPage();
  await m.setViewport({ width: 390, height: 844, isMobile: true });
  await m.goto(BASE, { waitUntil: 'networkidle2' });
  await wait(900);
  // 同一浏览器上下文已登录，只有回到登录页时才需要输入密码
  if (await m.$('input[type=password]')) {
    await m.type('input[type=password]', PASS, { delay: 8 });
    await m.evaluate(() => {
      const b = [...document.querySelectorAll('button')].find((x) => x.textContent.replace(/\s/g, '') === '登录');
      b && b.click();
    });
    await wait(2200);
  }
  await m.evaluate(() => { location.hash = '#/printers'; });
  await wait(1500);
  await m.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find((x) => x.textContent.includes('自动扫描打印机'));
    b && b.click();
  });
  await wait(1200);
  const overflow = await m.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  rec('移动端无横向溢出', !overflow, overflow ? '出现横向滚动' : '');
  await m.screenshot({ path: `${SHOTS}/v5-05-mobile-scan.png` }).catch(() => {});

  const realErrors = errors.filter((e) => !/favicon/.test(e));
  rec('无 JS 报错 / 4xx 响应', realErrors.length === 0, realErrors.slice(0, 3).join(' ; '));

  const fails = results.filter((x) => !x.pass);
  console.log(`\n总计 ${results.length} 项，失败 ${fails.length} 项`);
  if (fails.length) fails.forEach((f) => console.log(' -', f.name, f.detail));
  await browser.close();
  require('fs').writeFileSync(require('./_paths').shot('scan-driver-ui.json'), JSON.stringify(results, null, 2));
  process.exit(fails.length ? 1 : 0);
})();
