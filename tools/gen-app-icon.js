#!/usr/bin/env node
/**
 * 用一张源图生成 iOS AppIcon 全套尺寸 + Android 启动图标 + App 内 logo。
 *
 * 用法：node tools/gen-app-icon.js <源图路径>
 * 源图要求：正方形，≥1024×1024，不带透明通道（App Store 不收带 alpha 的图标）
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const APP = path.join(ROOT, 'app');

function sharpOf() {
  // sharp 装在 server/node_modules 里，直接 require 会找不到
  const candidates = [
    path.join(ROOT, 'server', 'node_modules', 'sharp'),
    'sharp',
  ];
  for (const c of candidates) {
    try {
      return require(c);
    } catch (_) { /* 继续试下一个 */ }
  }
  throw new Error('找不到 sharp，请先在 server 目录 npm i');
}

// iOS 需要的尺寸（文件名与 Contents.json 一一对应）
const IOS = [
  ['Icon-App-20x20@1x.png', 20],
  ['Icon-App-20x20@2x.png', 40],
  ['Icon-App-20x20@3x.png', 60],
  ['Icon-App-29x29@1x.png', 29],
  ['Icon-App-29x29@2x.png', 58],
  ['Icon-App-29x29@3x.png', 87],
  ['Icon-App-40x40@1x.png', 40],
  ['Icon-App-40x40@2x.png', 80],
  ['Icon-App-40x40@3x.png', 120],
  ['Icon-App-60x60@2x.png', 120],
  ['Icon-App-60x60@3x.png', 180],
  ['Icon-App-76x76@1x.png', 76],
  ['Icon-App-76x76@2x.png', 152],
  ['Icon-App-83.5x83.5@2x.png', 167],
  ['Icon-App-1024x1024@1x.png', 1024],
];

const ANDROID = [
  ['mipmap-mdpi', 48],
  ['mipmap-hdpi', 72],
  ['mipmap-xhdpi', 96],
  ['mipmap-xxhdpi', 144],
  ['mipmap-xxxhdpi', 192],
];

async function main() {
  const src = process.argv[2];
  if (!src || !fs.existsSync(src)) {
    console.error('用法：node tools/gen-app-icon.js <源图路径>');
    process.exit(1);
  }
  const sharp = sharpOf();

  const meta = await sharp(src).metadata();
  console.log(`源图 ${meta.width}×${meta.height} ${meta.format}`);
  if (Math.abs((meta.width || 0) - (meta.height || 0)) > 2) {
    console.warn('⚠️ 源图不是正方形，会按 cover 居中裁切');
  }

  const iconDir = path.join(APP, 'ios', 'Runner', 'Assets.xcassets', 'AppIcon.appiconset');
  fs.mkdirSync(iconDir, { recursive: true });

  for (const [name, size] of IOS) {
    await sharp(src)
      .resize(size, size, { fit: 'cover', position: 'centre' })
      .flatten({ background: '#0C8B80' }) // iOS 图标不能带 alpha
      .png({ compressionLevel: 9 })
      .toFile(path.join(iconDir, name));
  }
  console.log(`✓ iOS AppIcon ${IOS.length} 个尺寸`);

  for (const [dir, size] of ANDROID) {
    const out = path.join(APP, 'android', 'app', 'src', 'main', 'res', dir, 'ic_launcher.png');
    if (!fs.existsSync(path.dirname(out))) continue;
    await sharp(src)
      .resize(size, size, { fit: 'cover', position: 'centre' })
      .flatten({ background: '#0C8B80' })
      .png({ compressionLevel: 9 })
      .toFile(out);
  }
  console.log('✓ Android 启动图标 5 个尺寸');

  // App 内用的 logo（登录页 / 地址页），带圆角交给 Widget 处理，这里只出方图
  const assetDir = path.join(APP, 'assets');
  fs.mkdirSync(assetDir, { recursive: true });
  await sharp(src)
    .resize(512, 512, { fit: 'cover', position: 'centre' })
    .png({ compressionLevel: 9 })
    .toFile(path.join(assetDir, 'logo.png'));
  console.log('✓ app/assets/logo.png (512×512)');
}

main().catch((e) => {
  console.error('✗', e.message);
  process.exit(1);
});
