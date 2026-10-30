#!/usr/bin/env node
/**
 * 用设计稿图片生成小程序 logo（v5.20 起使用）
 *
 * 源图：tools/assets/logo-source.jpg（用户提供的 985×903 设计稿）
 * 处理：
 *   1. 按白色图案的包围盒居中裁成正方形（原图 985×903，上下更紧，裁 843×843 正好对称）
 *   2. 缩放到 512×512
 *   3. 加圆角 alpha（r ≈ 13%，比 app icon 的 22.7% 小 —— 图案里的白圈离边很近，
 *      圆角再大会在四个斜角处切到白圈）
 *   4. 另出一份「不切角」的正方形，供微信公众平台上传小程序头像（那边自己会做圆角/圆形裁切）
 *
 * 用法：
 *   NODE_PATH=<sharp 所在 node_modules> node tools/mp-logo-from-image.js
 */
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(__dirname, 'assets', 'logo-source.jpg');
const OUT_LOGO = path.join(ROOT, 'miniprogram', 'images', 'logo.png');
const OUT_AVATAR = path.join(ROOT, '..', 'Printgate-小程序头像-512.png');

const SIZE = 384;              // 登录页 200rpx×3 倍屏 = 300px，384 足够
const AVATAR_SIZE = 512;       // 小程序头像单独出大图
const CORNER_RATIO = 0.13; // 圆角半径 / 边长

(async () => {
  if (!fs.existsSync(SRC)) {
    console.error(`缺少源图：${SRC}`);
    process.exit(1);
  }

  const { data, info } = await sharp(SRC).raw().toBuffer({ resolveWithObject: true });
  const { width: W, height: H, channels: C } = info;

  // 找白色图案的包围盒，用它定位视觉中心（比整张图的几何中心更准）
  let minX = W, minY = H, maxX = 0, maxY = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * C;
      if (data[i] > 200 && data[i + 1] > 200 && data[i + 2] > 200) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;

  // 能塞下的最大正方形（保证中心不变、不越界）
  const side = Math.floor(Math.min(W, H, cx * 2, cy * 2, (W - cx) * 2, (H - cy) * 2));
  const left = Math.round(cx - side / 2);
  const top = Math.round(cy - side / 2);

  const square = await sharp(SRC)
    .extract({ left, top, width: side, height: side })
    .resize(AVATAR_SIZE, AVATAR_SIZE, { kernel: 'lanczos3' })
    .png()
    .toBuffer();

  // 包内用的版本：384 + PNG 调色板量化（原图是 JPEG，带噪点，不量化会有 240KB）
  const packed = await sharp(square)
    .resize(SIZE, SIZE, { kernel: 'lanczos3' })
    .png({ compressionLevel: 9, palette: true, quality: 92, effort: 10 })
    .toBuffer();

  const r = Math.round(SIZE * CORNER_RATIO);
  const mask = Buffer.from(
    `<svg width="${SIZE}" height="${SIZE}"><rect x="0" y="0" width="${SIZE}" height="${SIZE}" rx="${r}" ry="${r}" fill="#fff"/></svg>`
  );
  const rounded = await sharp(packed)
    .composite([{ input: mask, blend: 'dest-in' }])
    .png({ compressionLevel: 9, palette: true, quality: 92, effort: 10 })
    .toBuffer();

  fs.writeFileSync(OUT_LOGO, rounded);
  fs.writeFileSync(OUT_AVATAR, square);

  console.log(`裁剪 ${side}×${side}（中心 ${cx},${cy}）→ ${SIZE}×${SIZE}，圆角 ${r}px`);
  console.log(`logo   ${OUT_LOGO}  ${(rounded.length / 1024).toFixed(1)} KB`);
  console.log(`头像   ${OUT_AVATAR}  ${(square.length / 1024).toFixed(1)} KB`);
})();
