'use strict';
// 目录自适应：同时支持两种布局，避免脚本写死 ../printgate 导致换目录即崩
//   扁平交付布局：Printgate/{tools,server,web}      ← 交付 zip 解压后的形态
//   开发布局：    <root>/{tools,printgate/server}   ← 旧开发目录形态
const path = require('path');
const fs = require('fs');

const TOOLS = __dirname;
const CANDIDATES = [
  path.join(TOOLS, '..'),
  path.join(TOOLS, '..', 'printgate')
];

function projectRoot() {
  for (const c of CANDIDATES) {
    if (fs.existsSync(path.join(c, 'server', 'src', 'index.js'))) return path.resolve(c);
  }
  return path.resolve(path.join(TOOLS, '..'));
}
function serverDir() { return path.join(projectRoot(), 'server'); }
function serverSrcPath(name) { return path.join(serverDir(), 'src', name); }
function serverModulePath(name) { return path.join(serverDir(), 'node_modules', name); }
function shotsDir() {
  const d = path.join(projectRoot(), '_shots');
  fs.mkdirSync(d, { recursive: true });
  return d;
}
function shot(name) { return path.join(shotsDir(), name); }

// 上传测试用的最小合法 PNG（1x1）。仓库不带二进制夹具，缺失时自动补齐，
// 否则 mp-api-test 之类会因素材缺失直接崩掉。
const STD_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);
function standardPng() {
  const p = shot('p1-standard.png');
  if (!fs.existsSync(p)) fs.writeFileSync(p, STD_PNG);
  return p;
}

module.exports = { projectRoot, serverDir, serverSrcPath, serverModulePath, shotsDir, shot, standardPng };
