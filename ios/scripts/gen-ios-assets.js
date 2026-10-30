#!/usr/bin/env node
/**
 * 生成 iOS 工程需要的图片资源：
 *   App/Assets.xcassets/AppIcon.appiconset/*  —— 应用图标（必须不带透明通道，系统自己切圆角）
 *   App/Assets.xcassets/Logo.imageset/Logo.png —— 设置页里显示的 logo（带圆角）
 *   App/Assets.xcassets/AccentColor.colorset
 *   App/Assets.xcassets/LaunchBackground.colorset
 *
 * 图标源用设计稿原图（裁正方形、不切角），与小程序 logo 同一套素材：
 *   tools/assets/logo-source.jpg
 *
 * 用法：NODE_PATH=<sharp 所在> node ios/scripts/gen-ios-assets.js
 */
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const ROOT = path.join(__dirname, '..', '..');
const SRC = path.join(ROOT, 'tools', 'assets', 'logo-source.jpg');
const ROUNDED = path.join(ROOT, 'miniprogram', 'images', 'logo.png');
const ASSETS = path.join(__dirname, '..', 'App', 'Assets.xcassets');

// iPhone 图标：点阵尺寸 + 倍数
const ICONS = [
  { size: 20, scales: [2, 3] },
  { size: 29, scales: [2, 3] },
  { size: 40, scales: [2, 3] },
  { size: 60, scales: [2, 3] },
  { size: 1024, scales: [1], marketing: true }
];

function writeJSON(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + '\n');
}

async function cropSquare() {
  const { data, info } = await sharp(SRC).raw().toBuffer({ resolveWithObject: true });
  const { width: W, height: H, channels: C } = info;
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
  const side = Math.floor(Math.min(W, H, cx * 2, cy * 2, (W - cx) * 2, (H - cy) * 2));
  return { left: Math.round(cx - side / 2), top: Math.round(cy - side / 2), side };
}

(async () => {
  const box = await cropSquare();
  const base = await sharp(SRC)
    .extract({ left: box.left, top: box.top, width: box.side, height: box.side })
    .png()
    .toBuffer();

  // AppIcon
  const iconDir = path.join(ASSETS, 'AppIcon.appiconset');
  fs.rmSync(iconDir, { recursive: true, force: true });
  fs.mkdirSync(iconDir, { recursive: true });

  const images = [];
  let count = 0;
  for (const group of ICONS) {
    const scales = group.scales;
    for (const scale of scales) {
      const px = group.size * scale;
      const name = `icon-${group.size}x${group.size}@${scale}x.png`;
      // 图标不能有透明通道，否则 App Store 校验不过、桌面也会发黑
      await sharp(base)
        .resize(px, px, { kernel: 'lanczos3' })
        .flatten({ background: '#0B3B38' })
        .removeAlpha()
        .png({ compressionLevel: 9 })
        .toFile(path.join(iconDir, name));
      count++;
      if (group.marketing) {
        images.push({ filename: name, idiom: 'ios-marketing', scale: '1x', size: `${group.size}x${group.size}` });
      } else {
        images.push({ filename: name, idiom: 'iphone', scale: `${scale}x`, size: `${group.size}x${group.size}` });
      }
    }
  }
  writeJSON(path.join(iconDir, 'Contents.json'), {
    images,
    info: { author: 'xcode', version: 1 }
  });

  // Logo（带圆角，给设置页用）
  const logoDir = path.join(ASSETS, 'Logo.imageset');
  fs.mkdirSync(logoDir, { recursive: true });
  if (fs.existsSync(ROUNDED)) {
    fs.copyFileSync(ROUNDED, path.join(logoDir, 'Logo.png'));
  }
  writeJSON(path.join(logoDir, 'Contents.json'), {
    images: [{ filename: 'Logo.png', idiom: 'universal', scale: '1x' }],
    info: { author: 'xcode', version: 1 }
  });

  // 主题色 / 启动背景
  writeJSON(path.join(ASSETS, 'AccentColor.colorset', 'Contents.json'), {
    colors: [{
      color: {
        'color-space': 'srgb',
        components: { red: '0.047', green: '0.545', blue: '0.502', alpha: '1.000' }
      },
      idiom: 'universal'
    }],
    info: { author: 'xcode', version: 1 }
  });

  writeJSON(path.join(ASSETS, 'LaunchBackground.colorset', 'Contents.json'), {
    colors: [
      {
        color: {
          'color-space': 'srgb',
          components: { red: '1.000', green: '1.000', blue: '1.000', alpha: '1.000' }
        },
        idiom: 'universal'
      },
      {
        appearances: [{ appearance: 'luminosity', value: 'dark' }],
        color: {
          'color-space': 'srgb',
          components: { red: '0.047', green: '0.078', blue: '0.071', alpha: '1.000' }
        },
        idiom: 'universal'
      }
    ],
    info: { author: 'xcode', version: 1 }
  });

  writeJSON(path.join(ASSETS, 'Contents.json'), { info: { author: 'xcode', version: 1 } });

  console.log(`裁切 ${box.side}×${box.side}（左上 ${box.left},${box.top}）`);
  console.log(`生成图标 ${count} 个 + Logo + 颜色集 → ${path.relative(ROOT, ASSETS)}`);
})();
