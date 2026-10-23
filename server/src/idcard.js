'use strict';
// 身份证自动矫正识别切割：从随手拍的照片里找出身份证，旋转摆正并裁掉背景。
// 纯 sharp（预编译，含 linuxmusl-arm64）+ 自研连通域 / 主轴算法，不依赖 OpenCV/ImageMagick。
//
// 算法：
//   1. 缩略 + 灰度，Otsu 阈值二值化（亮/暗两种极性都试）；
//   2. 形态学闭运算（膨胀→腐蚀）填掉卡片内部文字、人像等形成的洞，让卡片变成实心块；
//   3. 连通域分析取面积最大、宽高比最接近身份证(≈1.586)的区域；
//   4. 对前景像素做 PCA 求主轴方向（长边），得到摆正角 a（限制在 [-45°, 45°]）；
//   5. 把区域外接框四角按「与 sharp rotate(a) 相同的旋转」变换，取外接矩形，映射回原图；
//   6. 原图 rotate(a) 后 extract 出身份证区域，四周内缩去毛刺，输出 PNG。
let sharp = null;
let sharpLoadError = "";
try {
  sharp = require('sharp');
} catch (e) {
  sharpLoadError = e.message;
  console.error('[idcard] sharp 加载失败，证件矫正不可用：', e.message);
}
const sharpReady = () => !!sharp && !sharpLoadError;

const CARD_RATIO = 85.6 / 54; // ≈1.585
const RATIO_LO = 1.25;
const RATIO_HI = 2.2;

function otsuThreshold(hist, total) {
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0, wB = 0, maxVar = 0, thresh = 127;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > maxVar) { maxVar = between; thresh = t; }
  }
  return thresh;
}

// 形态学：3x3 结构元素膨胀 / 腐蚀
function dilate(src, W, H) {
  const out = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let v = 0;
      for (let dy = -1; dy <= 1 && !v; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
          if (src[ny * W + nx]) { v = 1; break; }
        }
      }
      out[y * W + x] = v;
    }
  }
  return out;
}

function erode(src, W, H) {
  const out = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let v = 1;
      for (let dy = -1; dy <= 1 && v; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) { v = 0; break; }
          if (!src[ny * W + nx]) { v = 0; break; }
        }
      }
      out[y * W + x] = v;
    }
  }
  return out;
}

// 闭运算（膨胀 r 次 → 腐蚀 r 次）：填掉卡片内部文字/人像形成的洞，让卡片变实心块
function closeMask(src, W, H, r) {
  if (r <= 0) return src;
  let c = src;
  for (let i = 0; i < r; i++) c = dilate(c, W, H);
  for (let i = 0; i < r; i++) c = erode(c, W, H);
  return c;
}

// BFS 找连通前景块，返回 {minX,minY,maxX,maxY,area,borderTouch,w,h}
function largestComponents(mask, W, H, { topK = 8, borderBand = 0 } = {}) {
  const visited = new Uint8Array(W * H);
  const comps = [];
  const inBorder = (x, y) => borderBand > 0 && (x < borderBand || y < borderBand || x >= W - borderBand || y >= H - borderBand);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const idx = y * W + x;
      if (!mask[idx] || visited[idx]) continue;
      const q = [idx];
      visited[idx] = 1;
      let head = 0, area = 0, minX = x, minY = y, maxX = x, maxY = y, borderTouch = 0;
      while (head < q.length) {
        const cur = q[head++];
        const cx = cur % W, cy = (cur / W) | 0;
        area++;
        if (cx < minX) minX = cx; if (cx > maxX) maxX = cx;
        if (cy < minY) minY = cy; if (cy > maxY) maxY = cy;
        if (inBorder(cx, cy)) borderTouch++;
        const nb = [cur - 1, cur + 1, cur - W, cur + W];
        for (const n of nb) {
          if (n < 0 || n >= W * H) continue;
          if (n === cur - 1 && cx === 0) continue;
          if (n === cur + 1 && cx === W - 1) continue;
          if (visited[n] || !mask[n]) continue;
          visited[n] = 1;
          q.push(n);
        }
      }
      if (area < 64) continue;
      comps.push({ minX, minY, maxX, maxY, area, borderTouch, w: maxX - minX + 1, h: maxY - minY + 1 });
    }
  }
  comps.sort((a, b) => b.area - a.area);
  return comps.slice(0, topK);
}

function pickCard(comps, W, H, { ratioLo = RATIO_LO, ratioHi = RATIO_HI } = {}) {
  let best = null, bestScore = -Infinity;
  for (const c of comps) {
    if (c.w < 20 || c.h < 20) continue;
    // 接近铺满全图的块是背景（深色桌面/整面纸），排除
    if (c.w > W * 0.94 && c.h > H * 0.94) continue;
    const ratio = c.w / c.h;
    if (ratio < ratioLo || ratio > ratioHi) continue;
    if (c.borderTouch > c.area * 0.4) continue;
    if (c.area < W * H * 0.03) continue;
    const ratioPenalty = Math.abs(Math.log(ratio) - Math.log(CARD_RATIO));
    const areaScore = Math.log(c.area);
    const score = areaScore - ratioPenalty * 8 - (c.borderTouch / c.area) * 6;
    if (score > bestScore) { bestScore = score; best = c; }
  }
  return best;
}

function principalAngle(mask, W, H, card) {
  let sx = 0, sy = 0, n = 0;
  for (let y = card.minY; y <= card.maxY; y++) {
    for (let x = card.minX; x <= card.maxX; x++) {
      if (!mask[y * W + x]) continue;
      sx += x; sy += y; n++;
    }
  }
  if (n < 16) return 0;
  const mx = sx / n, my = sy / n;
  let sxx = 0, syy = 0, sxy = 0;
  for (let y = card.minY; y <= card.maxY; y++) {
    for (let x = card.minX; x <= card.maxX; x++) {
      if (!mask[y * W + x]) continue;
      const dx = x - mx, dy = y - my;
      sxx += dx * dx; syy += dy * dy; sxy += dx * dy;
    }
  }
  const theta = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  let deg = (theta * 180) / Math.PI;
  while (deg > 45) deg -= 90;
  while (deg < -45) deg += 90;
  return deg;
}

// sharp rotate(a) 顺时针为正；这里用「视觉顺时针」的坐标变换已不再需要，
// 摆正改走「先 rotate 整图、再二次检测轴对齐框」的两步法，更稳。

// 灰度图最外一圈像素均值，作为旋转时的背景填充色（避免纯黑边干扰二次检测）
function edgeMean(gray, W, H) {
  let s = 0, n = 0;
  for (let x = 0; x < W; x++) { s += gray[x]; s += gray[(H - 1) * W + x]; n += 2; }
  for (let y = 1; y < H - 1; y++) { s += gray[y * W]; s += gray[y * W + W - 1]; n += 2; }
  return n ? Math.round(s / n) : 0;
}

async function autoCrop(inputPath, { maxDim = 1100, padRatio = 0.02, borderBand = 3 } = {}) {
  if (!sharpReady()) return { ok: false, msg: '图片处理组件（sharp）不可用：' + sharpLoadError };
  const meta = await sharp(inputPath).metadata();
  const iw = meta.width, ih = meta.height;
  if (!iw || !ih || iw < 40 || ih < 40) return { ok: false, msg: '图片无效或尺寸过小' };

  // ---------- 第一次检测：定位卡片 + 估算倾斜角 ----------
  const scale1 = Math.min(1, maxDim / Math.max(iw, ih));
  const W1 = Math.max(1, Math.round(iw * scale1));
  const H1 = Math.max(1, Math.round(ih * scale1));
  const g1 = await sharp(inputPath).resize(W1, H1).greyscale().raw().toBuffer({ resolveWithObject: true });
  const gray1 = g1.data, gW1 = g1.info.width, gH1 = g1.info.height;
  const hist1 = new Uint32Array(256);
  for (let i = 0; i < gray1.length; i++) hist1[gray1[i]]++;
  const thresh1 = otsuThreshold(hist1, gray1.length);
  const light1 = new Uint8Array(gW1 * gH1), dark1 = new Uint8Array(gW1 * gH1);
  for (let i = 0; i < gray1.length; i++) { light1[i] = gray1[i] >= thresh1 ? 1 : 0; dark1[i] = gray1[i] < thresh1 ? 1 : 0; }
  const r1 = Math.max(1, Math.round(Math.min(gW1, gH1) * 0.008));
  const lc1 = closeMask(light1, gW1, gH1, r1);
  const dc1 = closeMask(dark1, gW1, gH1, r1);
  let first = null;
  for (const [mask, tag] of [[lc1, 'light'], [dc1, 'dark']]) {
    // 第一次检测卡片可能倾斜较大，轴对齐框宽高比会失真，故放宽范围，只负责「定位 + 估倾斜角」
    const card = pickCard(largestComponents(mask, gW1, gH1, { topK: 8, borderBand }), gW1, gH1, { ratioLo: 0.8, ratioHi: 3.0 });
    if (!card) continue;
    const score = Math.abs(Math.log(card.w / card.h) - Math.log(CARD_RATIO));
    if (!first || score < first.score) first = { card, score, tag, mask };
  }
  if (!first) {
    return {
      ok: false,
      msg: '未识别到身份证轮廓。请让身份证完整入镜、四边留一点空隙，并尽量放在对比明显的背景上（深色桌面或白纸）。'
    };
  }
  const tilt = principalAngle(first.mask, gW1, gH1, first.card); // 视觉顺时针为正的倾斜角

  // ---------- 摆正整图 ----------
  const bg = edgeMean(gray1, gW1, gH1);
  const upright = await sharp(inputPath)
    .rotate(-tilt, { background: { r: bg, g: bg, b: bg } })
    .toBuffer();

  // ---------- 二次检测：摆正后卡片轴对齐，直接取精确外接框 ----------
  const m2 = await sharp(upright).metadata();
  const iw2 = m2.width, ih2 = m2.height;
  const scale2 = Math.min(1, maxDim / Math.max(iw2, ih2));
  const W2 = Math.max(1, Math.round(iw2 * scale2));
  const H2 = Math.max(1, Math.round(ih2 * scale2));
  const g2 = await sharp(upright).resize(W2, H2).greyscale().raw().toBuffer({ resolveWithObject: true });
  const gray2 = g2.data, gW2 = g2.info.width, gH2 = g2.info.height;
  const hist2 = new Uint32Array(256);
  for (let i = 0; i < gray2.length; i++) hist2[gray2[i]]++;
  const thresh2 = otsuThreshold(hist2, gray2.length);
  const light2 = new Uint8Array(gW2 * gH2), dark2 = new Uint8Array(gW2 * gH2);
  for (let i = 0; i < gray2.length; i++) { light2[i] = gray2[i] >= thresh2 ? 1 : 0; dark2[i] = gray2[i] < thresh2 ? 1 : 0; }
  const r2 = Math.max(1, Math.round(Math.min(gW2, gH2) * 0.008));
  const lc2 = closeMask(light2, gW2, gH2, r2);
  const dc2 = closeMask(dark2, gW2, gH2, r2);
  let second = null;
  for (const [mask, tag] of [[lc2, 'light'], [dc2, 'dark']]) {
    const card = pickCard(largestComponents(mask, gW2, gH2, { topK: 8, borderBand }), gW2, gH2);
    if (!card) continue;
    const score = Math.abs(Math.log(card.w / card.h) - Math.log(CARD_RATIO));
    if (!second || score < second.score) second = { card, score, tag };
  }
  if (!second) return { ok: false, msg: '摆正后仍未能定位身份证，请重拍或换个背景' };

  const c = second.card;
  const padX = c.w * padRatio, padY = c.h * padRatio;
  const left = Math.max(0, Math.round((c.minX + padX) / scale2));
  const top = Math.max(0, Math.round((c.minY + padY) / scale2));
  const width = Math.min(iw2 - left, Math.round((c.w - padX * 2) / scale2));
  const height = Math.min(ih2 - top, Math.round((c.h - padY * 2) / scale2));
  if (width < 16 || height < 16) return { ok: false, msg: '切割区域越界，请重新拍摄' };

  const out = await sharp(upright).extract({ left, top, width, height }).png().toBuffer();
  return { ok: true, buffer: out, angle: -tilt, box: { left, top, width, height } };
}

module.exports = { autoCrop, CARD_RATIO };
