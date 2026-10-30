// 本地排版合成：文字速印 / 发票合排 / 身份证正反合排
// 后端 render.js 的 textPdf/imagesPdf/idcardPdf 是 requireAdmin 接口，小程序 token 不认，
// 故在端上用 canvas 完成同款排版，导出图片后走 /api/mp/files + /api/mp/print，后端零改动。

// A4 比例（210×297mm），canvas 用像素，只保证纵横比与后端一致
const MEDIA_RATIO = { A4: 210 / 297, A3: 297 / 420, A5: 148 / 210, Letter: 216 / 279, Legal: 216 / 356, B5: 176 / 250 };

function ratioOf(media) { return MEDIA_RATIO[media] || MEDIA_RATIO.A4; }

// 画布物理尺寸：宽固定 1240px（约 300dpi A4 宽），高按纸张比例
function pagePx(media) {
  const W = 1240;
  const H = Math.round(W / ratioOf(media));
  return { W, H };
}

// 离线画布（页面可声明多个 canvas 或复用一个离屏 canvas）
function getCtx(canvasId, comp, W, H) {
  return new Promise((resolve, reject) => {
    comp.createSelectorQuery()
      .select(canvasId)
      .fields({ node: true, size: true })
      .exec((res) => {
        if (!res || !res[0] || !res[0].node) return reject(new Error('canvas 不可用'));
        const canvas = res[0].node;
        const dpr = (typeof wx !== 'undefined' && wx.getSystemInfoSync && wx.getSystemInfoSync().pixelRatio) || 2;
        canvas.width = W * dpr;
        canvas.height = H * dpr;
        const ctx = canvas.getContext('2d');
        ctx.scale(dpr, dpr);
        resolve({ canvas, ctx, W, H });
      });
  });
}

function loadImage(ctx, src) {
  return new Promise((resolve, reject) => {
    const img = ctx.createImage();
    img.onload = () => resolve(img);
    img.onerror = (e) => reject(e);
    img.src = src;
  });
}

// 文字自动换行（近似测量：CJK 按字符宽、ASCII 按 0.55 字符宽）
function wrapText(ctx, text, fontSize, maxWidth) {
  const lines = [];
  for (const raw of String(text || '').replace(/\r\n/g, '\n').split('\n')) {
    if (raw === '') { lines.push(''); continue; }
    let line = '';
    for (const ch of raw) {
      const w = /[^\x00-\xff]/.test(ch) ? fontSize : fontSize * 0.55;
      const test = line + ch;
      if (ctx.measureText(test).width > maxWidth && line) { lines.push(line); line = ch; }
      else line = test;
    }
    lines.push(line);
  }
  return lines;
}

// 图片按比例缩放居中绘制进指定矩形（cover 模式，身份证/发票都裁切居中）
function drawCover(ctx, img, x, y, w, h, rotate = 0) {
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  ctx.translate(x + w / 2, y + h / 2);
  if (rotate) ctx.rotate((rotate * Math.PI) / 180);
  const iw = img.width || 1, ih = img.height || 1;
  let dw = w, dh = h;
  if (rotate === 90 || rotate === 270) { dw = h; dh = w; }
  const scale = Math.max(dw / iw, dh / ih);
  ctx.drawImage(img, -iw * scale / 2, -ih * scale / 2, iw * scale, ih * scale);
  ctx.restore();
}

// 导出 canvas 为临时 PNG
function exportPng(canvas, W, H) {
  return new Promise((resolve, reject) => {
    wx.canvasToTempFilePath({
      canvas,
      x: 0, y: 0, width: W, height: H,
      destWidth: W, destHeight: H,
      fileType: 'png',
      success: (res) => resolve(res.tempFilePath),
      fail: reject
    });
  });
}

module.exports = { ratioOf, pagePx, getCtx, loadImage, wrapText, drawCover, exportPng };
