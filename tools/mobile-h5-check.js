/**
 * 移动端 H5 界面自检：用无头浏览器跑一遍登录 → 选文件 → 上传 → 各 Tab，
 * 每步截图，并把控制台错误收集出来。
 *
 * 用法：BASE=http://127.0.0.1:8180 PG_USER=testuser PG_PASS=Test123456 \
 *        NODE_PATH=<puppeteer-core 所在> node tools/mobile-h5-check.js
 */
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');

const BASE = process.env.BASE || 'http://127.0.0.1:8180';
const USER = process.env.PG_USER || 'testuser';
const PASS = process.env.PG_PASS || 'Test123456';
const OUT = process.env.SHOT_DIR || 'C:/tmp/mobile-shots';
const BROWSER = process.env.CHROME ||
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';

const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await puppeteer.launch({
    executablePath: BROWSER,
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage']
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });

  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));

  const shot = async (name) => {
    await new Promise((r) => setTimeout(r, 350));
    await page.screenshot({ path: path.join(OUT, name + '.png') });
    console.log('  截图', name + '.png');
  };

  console.log('1) 打开', BASE + '/m/');
  await page.goto(BASE + '/m/', { waitUntil: 'networkidle2' });
  await page.waitForSelector('#login:not(.hidden)', { timeout: 8000 });
  await shot('01-login');

  console.log('2) 登录');
  await page.type('#lg-user', USER);
  await page.type('#lg-pass', PASS);
  await page.click('#lg-submit');
  await page.waitForSelector('#app:not(.hidden)', { timeout: 10000 });
  await shot('02-print');

  console.log('3) 高级设置展开');
  await page.click('#toggle-adv');
  await shot('03-advanced');
  await page.click('#toggle-adv');

  console.log('4) 上传两张图片（应自动合成多页 PDF）');
  const tmp = path.join(OUT, 'a.png');
  fs.writeFileSync(path.join(OUT, 'a.png'), PNG_1x1);
  fs.writeFileSync(path.join(OUT, 'b.png'), PNG_1x1);
  const input = await page.$('#file-input');
  await input.uploadFile(path.join(OUT, 'a.png'), path.join(OUT, 'b.png'));
  await page.waitForSelector('#pick-file:not(.hidden)', { timeout: 20000 });
  const name = await page.$eval('#file-name', (el) => el.textContent);
  const sub = await page.$eval('#file-sub', (el) => el.textContent);
  console.log('   文件卡:', name, '|', sub);
  // 预览是异步渲染的（qemu 下要 1-2 秒），等缩略图真的画出来再截图
  try {
    await page.waitForFunction(() => {
      const img = document.querySelector('#thumb-img');
      return img && img.src && img.naturalWidth > 0;
    }, { timeout: 15000 });
    console.log('   缩略图已渲染');
  } catch (_) {
    console.log('   缩略图未渲染（服务端缺渲染器时会走占位）');
  }
  await shot('04-uploaded');

  console.log('5) 文件 / 记录 / 我的');
  for (const tab of ['files', 'tasks', 'me']) {
    await page.click(`.tabbar button[data-tab="${tab}"]`);
    await new Promise((r) => setTimeout(r, 700));
    await shot('05-' + tab);
  }

  console.log('6) 取消 / 返回打印页');
  await page.click('.tabbar button[data-tab="print"]');
  await shot('06-back-to-print');

  await browser.close();

  if (errors.length) {
    console.log('\n控制台错误 ' + errors.length + ' 条：');
    errors.slice(0, 10).forEach((e) => console.log('  - ' + e));
    process.exitCode = 1;
  } else {
    console.log('\n控制台无错误');
  }
})().catch((e) => {
  console.error('FAIL:', e.message);
  process.exit(1);
});
