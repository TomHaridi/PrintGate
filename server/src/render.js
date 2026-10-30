'use strict';
// PDF 生成：文字速印、水印叠加、多图合排（发票 / 身份证）
// 依赖 pdfkit（纯 JS 排版）+ qpdf（把一页水印重复叠加到每一页）
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const PDFDocument = require('pdfkit');
// sharp 是原生模块（libvips）。它加载失败（架构不符、musl 版本不匹配、缺 so）时，
// 过去会让整个进程起不来 —— 表现就是容器崩、反代 502。这里改成软失败：
// 服务照常启动，只有依赖图片的能力返回 503 并给出原因。
let sharp = null;
let sharpLoadError = "";
try {
  sharp = require('sharp');
} catch (e) {
  sharpLoadError = e.message;
  console.error('[render] sharp 加载失败，图片/证件相关功能不可用：', e.message);
}
const sharpReady = () => !!sharp && !sharpLoadError;
const config = require('./config');
const fsutil = require('./fsutil');
const orphans = require('./orphans');

const FONT_CANDIDATES = [
  process.env.PG_CJK_FONT,
  '/usr/share/fonts/printgate/wqy-zenhei.ttf',
  '/usr/share/fonts/truetype/wqy/wqy-zenhei.ttf',
  '/usr/share/fonts/wqy-zenhei/wqy-zenhei.ttf'
].filter(Boolean);

let cachedFont = null;
function cjkFont() {
  if (cachedFont !== null) return cachedFont;
  cachedFont = FONT_CANDIDATES.find((p) => { try { return fs.existsSync(p); } catch (_) { return false; } }) || '';
  return cachedFont;
}

// A4 尺寸（pt），与 CUPS/libpaper 的 210×297mm 对齐
const PAGE = { A4: [595.28, 841.89], A3: [841.89, 1190.55], A5: [419.53, 595.28], Letter: [612, 792], Legal: [612, 1008], B5: [498.9, 708.66] };
function pageSize(media) { return PAGE[media] || PAGE.A4; }

function newDoc(media) {
  const doc = new PDFDocument({ size: pageSize(media), margin: 0, autoFirstPage: true, info: { Producer: 'PrintGate' } });
  const font = cjkFont();
  if (font) { doc.registerFont('cjk', font); doc.font('cjk'); }
  return doc;
}

// pdfkit 解析损坏图片时会在 zlib 回调里抛错，这个错误不会走 doc.on('error')，
// 结果就是 promise 既不 resolve 也不 reject —— 请求一直挂着不返回。
// 所以这里必须自带超时兜底，并且要幂等（finish 与 error 只会结算一次）。
function pipeToFile(doc, outPath, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const ws = fs.createWriteStream(outPath);
    let settled = false;
    const done = (fn, v) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(v);
    };
    const timer = setTimeout(() => done(reject, new Error('PDF 生成超时')), timeoutMs);
    ws.on('finish', () => done(resolve, outPath));
    ws.on('error', (e) => done(reject, e));
    doc.on('error', (e) => done(reject, e));
    doc.pipe(ws);
  });
}

// 把超长行预先切成短段再交给 pdfkit。
// pdfkit 的换行测量（heightOfString / text）对「单行超长」是接近 O(n²) 的开销：
// 实测一行 5 万字符会把服务堆到 2GB+ 后 OOM 崩溃（容器直接退出），
// 而 5 万字符恰恰是接口自己声明的合法上限。切段后排版效果不变，内存与耗时回到正常水平。
function splitLongLine(line, max = 400) {
  const out = [];
  let rest = line;
  while (rest.length > max) {
    let cut = -1;
    // 优先在空格处断（英文更自然）；中文没有空格，断不掉就硬切（中文可任意位置断行）
    for (let i = max; i > max * 0.6; i--) {
      if (rest[i] === ' ' || rest[i] === '\t') { cut = i + 1; break; }
    }
    if (cut < 0) cut = max;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  out.push(rest);
  return out;
}

// ---------- 文字速印 ----------
// 把一段纯文本排成 PDF：自动换行、按页高自动分页、可选标题与边距
async function textPdf(outPath, { title = '', body = '', fontSize = 12, lineGap = 5, margin = 56, media = 'A4', fontScale = 1 } = {}) {
  const [pw, ph] = pageSize(media);
  const doc = newDoc(media);
  const done = pipeToFile(doc, outPath);
  const fs2 = Math.min(Math.max(Number(fontSize) || 12, 6), 48);
  const lh = fs2 + (Number(lineGap) || 0);
  let y = margin;

  if (title && String(title).trim()) {
    doc.fontSize(Math.min(fs2 * 1.6, 30)).text(String(title).trim(), margin, y, {
      width: pw - margin * 2, align: 'center'
    });
    y = doc.y + lh;
  }

  const rawLines = String(body || '').replace(/\r\n/g, '\n').split('\n');
  // 先切长行：pdfkit 拿到的是一批 ≤400 字符的短段，不会在某一次调用里内存爆炸
  const lines = [];
  for (const l of rawLines) for (const seg of splitLongLine(l)) lines.push(seg);
  doc.fontSize(fs2 * (fontScale || 1));
  for (const line of lines) {
    const text = line === '' ? ' ' : line;
    // 逐行测量：写到页底就换页，保证每页都从页边距开始
    const h = doc.heightOfString(text, { width: pw - margin * 2 });
    if (y + h > ph - margin) {
      doc.addPage({ size: pageSize(media), margin: 0 });
      y = margin;
    }
    doc.text(text, margin, y, { width: pw - margin * 2, lineGap: Number(lineGap) || 0 });
    y = doc.y + 2;
  }
  doc.end();
  await done;
  return outPath;
}

// ---------- 水印 ----------
// 生成一页透明水印（斜向平铺），交给 qpdf --overlay --repeat 铺到源文件的每一页
async function watermarkPdf(outPath, { text = '', opacity = 0.14, fontSize = 34, angle = -32, media = 'A4' } = {}) {
  const [pw, ph] = pageSize(media);
  const doc = newDoc(media);
  const done = pipeToFile(doc, outPath);
  const label = String(text || '').slice(0, 40);
  doc.fillOpacity(Math.min(Math.max(Number(opacity) || 0.14, 0.03), 0.6));
  doc.fontSize(Math.min(Math.max(Number(fontSize) || 34, 12), 80));
  const stepX = Math.max(pw / 2.2, 180);
  const stepY = Math.max(ph / 8, 90);
  for (let row = -1; row < Math.ceil(ph / stepY) + 1; row++) {
    for (let col = -1; col < Math.ceil(pw / stepX) + 1; col++) {
      doc.save();
      doc.translate(col * stepX + 30, row * stepY + 40);
      doc.rotate(Number(angle) || -32);
      doc.text(label, 0, 0, { lineBreak: false });
      doc.restore();
    }
  }
  doc.end();
  await done;
  return outPath;
}

// ---------- 多图合排（发票 / 身份证） ----------
// layout: 'stack'（上下居中，身份证）| 'grid'（等分，发票 2/4 张一页）
async function imagesPdf(outPath, { images = [], layout = 'stack', perPage = 2, media = 'A4', margin = 28, gap = 14, guide = true } = {}) {
  const [pw, ph] = pageSize(media);
  const doc = newDoc(media);
  const done = pipeToFile(doc, outPath);
  const slots = layout === 'grid' ? Math.max(Math.min(Number(perPage) || 2, 6), 1) : images.length || 1;
  const usableW = pw - margin * 2;
  const usableH = ph - margin * 2;
  const rowH = (usableH - gap * (slots - 1)) / slots;

  images.forEach((img, i) => {
    const idx = i % slots;
    if (i > 0 && idx === 0) doc.addPage({ size: pageSize(media), margin: 0 });
    const top = margin + idx * (rowH + gap);
    try {
      doc.image(img, margin, top, { fit: [usableW, rowH], align: 'center', valign: 'center' });
    } catch (_) {
      doc.fontSize(11).text(`（第 ${i + 1} 张图片无法解析）`, margin, top + 10, { width: usableW, align: 'center' });
    }
    // 淡淡的裁切线，方便沿边剪下（单独包一张图时不画）
    if (guide) {
      doc.save().lineWidth(0.4).strokeColor('#cbd5e1')
        .rect(margin, top, usableW, rowH).stroke().restore();
    }
  });
  doc.end();
  await done;
  return outPath;
}

// 图片文件按扩展名判断能否被 pdfkit 直读
// 光看扩展名不够：截断/损坏的图片会让 pdfkit 在 zlib 回调里抛错并让请求挂死，
// 所以合排前真读一遍 —— PNG 解一次 IDAT，JPEG 校验首尾标记
function readableImage(p) {
  try {
    const s = String(p || '');
    if (!/\.(jpe?g|png)$/i.test(s)) return false;
    const buf = fs.readFileSync(s);
    if (buf.length < 64) return false;
    if (/\.png$/i.test(s)) {
      if (!buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return false;
      let off = 8;
      const idat = [];
      while (off + 8 <= buf.length) {
        const len = buf.readUInt32BE(off);
        if (len < 0 || off + 12 + len > buf.length) return false;
        const type = buf.slice(off + 4, off + 8).toString('latin1');
        if (type === 'IDAT') idat.push(buf.slice(off + 8, off + 8 + len));
        if (type === 'IEND') break;
        off += 12 + len;
      }
      if (!idat.length) return false;
      zlib.inflateSync(Buffer.concat(idat)); // 数据损坏时这里会抛
      return true;
    }
    return buf[0] === 0xff && buf[1] === 0xd8 && buf[buf.length - 2] === 0xff && buf[buf.length - 1] === 0xd9;
  } catch (_) {
    return false;
  }
}

// ---------- 叠加水印到已有 PDF ----------
// qpdf 的 overlay 一次性铺完所有页，比在 Node 里逐页合并可靠：
//   qpdf in.pdf out.pdf --overlay wm.pdf --repeat=1-z --
function runQpdf(args, timeout = 60000) {
  return new Promise((resolve) => {
    require('child_process').execFile('qpdf', args, { timeout, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, msg: err ? String(stderr || err.message).trim().slice(0, 300) : '' });
    });
  });
}

async function applyWatermark(srcPdf, outPdf, { text = '', opacity = 0.14, fontSize = 34, angle = -32, media = 'A4' } = {}) {
  const label = String(text || '').trim();
  if (!label) return { ok: false, msg: '水印文字为空' };
  if (!cjkFont()) return { ok: false, msg: '镜像缺少中文字体，无法生成水印' };
  const wm = `${outPdf}.wm.pdf`;
  try {
    await watermarkPdf(wm, { text: label, opacity, fontSize, angle, media });
    const r = await runQpdf([srcPdf, outPdf, '--overlay', wm, '--repeat=1-z', '--']);
    return r.ok ? { ok: true, path: outPdf } : { ok: false, msg: `水印叠加失败：${r.msg}` };
  } finally {
    // 水印中间文件无 DB 记录，删不掉就是泄漏：登记 orphans 让清理任务重试
    const ok = await fsutil.safeUnlink(wm, { label: '水印中间文件' });
    if (!ok) orphans.add(wm);
  }
}

// ---------- 身份证拼接（正反各占半页，支持每张独立旋转 / 缩放） ----------
// card = { path, rotate(0|90|180|270), scale(0.3~3) }；path 为空时画占位提示
const clamp = (v, lo, hi) => Math.min(Math.max(Number(v) || 1, lo), hi);

async function drawCard(doc, card, x, y, w, h) {
  if (!card || !card.path) {
    doc.fontSize(11).fillColor('#94a3b8').text('（未上传这一面）', x, y + h / 2 - 8, { width: w, align: 'center' });
    return;
  }
  let iw = 0, ih = 0;
  try {
    const meta = await sharp(card.path).metadata();
    iw = meta.width || 0; ih = meta.height || 0;
  } catch (_) { /* 读不到尺寸就走 pdfkit 兜底 fit */ }
  if (!iw || !ih) { try { doc.image(card.path, x, y, { fit: [w, h] }); } catch (_) {} return; }

  const rotate = [0, 90, 180, 270].includes(Number(card.rotate)) ? Number(card.rotate) : 0;
  const scale = clamp(card.scale, 0.3, 3);
  const swapped = rotate === 90 || rotate === 270;
  const dw = swapped ? ih : iw;
  const dh = swapped ? iw : ih;
  const fit = Math.min(w / dw, h / dh);
  const outW = dw * fit * scale;
  const outH = dh * fit * scale;
  const cx = x + w / 2, cy = y + h / 2;
  doc.save();
  doc.translate(cx, cy);
  if (rotate) doc.rotate(rotate);
  try {
    doc.image(card.path, -outW / 2, -outH / 2, { width: outW, height: outH });
  } catch (_) {
    doc.fontSize(11).fillColor('#94a3b8').text('（图片无法解析）', -outW / 2, -8, { width: outW, align: 'center' });
  }
  doc.restore();
}

async function idcardPdf(outPath, { front = null, back = null, media = 'A4', margin = 36, gap = 18, guide = true } = {}) {
  if (!sharpReady()) throw new Error('图片处理组件（sharp）不可用：' + sharpLoadError);
  const [pw, ph] = pageSize(media);
  const doc = newDoc(media);
  const done = pipeToFile(doc, outPath);
  const usableW = pw - margin * 2;
  const usableH = ph - margin * 2;
  const slotH = (usableH - gap) / 2;
  const slots = [
    { card: front, top: margin, label: '正面' },
    { card: back, top: margin + slotH + gap, label: '反面' }
  ];
  for (const s of slots) {
    if (guide) {
      doc.save().lineWidth(0.4).strokeColor('#cbd5e1').rect(margin, s.top, usableW, slotH).stroke().restore();
    }
    await drawCard(doc, s.card, margin, s.top, usableW, slotH);
  }
  doc.end();
  await done;
  return outPath;
}

// 非 JPG/PNG（webp / heic / gif / bmp）pdfkit 吃不下，先用 sharp 转成 PNG 再进 PDF。
// sharp 不可用时返回 false，由调用方给出「请改用 JPG/PNG」的提示，而不是整条请求 500。
async function toPng(src, out) {
  if (!sharpReady()) return false;
  try {
    await sharp(src, { failOn: 'none' }).rotate().png().toFile(out);
    return fs.existsSync(out);
  } catch (_) {
    return false;
  }
}

module.exports = { textPdf, watermarkPdf, imagesPdf, applyWatermark, cjkFont, readableImage, toPng, pageSize, PAGE, idcardPdf, sharpReady, sharpError: () => sharpLoadError };

