'use strict';
// 前后端契约检查（小程序 ↔ 服务端）：
//  1. 小程序提交的资料字段是否都在服务端白名单里（拼错就会被静默丢弃，资料永远存不进去）
//  2. 小程序读取的资料字段服务端是否真的会返回
//  3. 小程序调用的路由是否都存在（复用 route-audit 的结论由 CI 侧跑，这里只看字段）
// 用法：node tools/mp-contract-check.js
const fs = require('fs');
const path = require('path');

const ROOT = require('./_paths').projectRoot();
const MP = path.join(ROOT, 'miniprogram');

// hasMiniprogramGuard
// 交付包允许裁剪小程序源码：缺 miniprogram/ 时直接跳过，别让回归里全是崩溃
if (!require('fs').existsSync(require('path').join(MP, 'app.json'))) {
  console.log('跳过：当前包未包含 miniprogram/（小程序源码已裁剪），本检查不适用');
  process.exit(0);
}

const results = [];
const rec = (n, p, d = '') => {
  results.push({ n, p, d });
  console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? `  —  ${d}` : ''}`);
};

const read = (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '');

// 服务端资料白名单
const mpSrc = read(path.join(ROOT, 'server', 'src', 'routes', 'mp.js'));
const whitelistBlock = /const PROFILE_FIELDS = \[([\s\S]*?)\];/.exec(mpSrc) || [];
const whitelist = [...String(whitelistBlock[1] || '').matchAll(/\[\s*'([a-z_]+)'/g)].map((m) => m[1]);
rec('解析到服务端资料白名单', whitelist.length > 0, whitelist.join(','));

// 小程序 login / profile 提交的字段
const submitKeys = (file) => {
  const src = read(file);
  const keys = new Set();
  // form.xxx 赋值 与 对象字面量里的 key
  for (const m of src.matchAll(/^\s{4,}([a-z_]+):\s*(?:this\.data\.|(?:e\.detail|u\.))/gm)) keys.add(m[1]);
  for (const m of src.matchAll(/([a-z_]+):\s*this\.data\.[a-z_]+/g)) keys.add(m[1]);
  return [...keys];
};

const CANDIDATES = ['nickname', 'wechat_id', 'phone', 'real_name', 'apply_note', 'avatar'];
for (const [label, file] of [
  ['登录页', path.join(MP, 'pages', 'login', 'login.js')],
  ['资料页', path.join(MP, 'pages', 'profile', 'profile.js')]
]) {
  const keys = submitKeys(file).filter((k) => /^(nickname|nick|wechat|phone|real|apply|avatar|name)/.test(k));
  const unknown = keys.filter((k) => !whitelist.includes(k) && !CANDIDATES.includes(k));
  rec(`${label}提交字段无拼错`, unknown.length === 0, keys.join(',') + (unknown.length ? ` ← 可疑：${unknown.join(',')}` : ''));
}

// 关键字段必须被提交（否则管理端看不到）
const loginSrc = read(path.join(MP, 'pages', 'login', 'login.js'));
for (const k of ['nickname', 'wechat_id', 'phone', 'apply_note']) {
  rec(`登录页会提交 ${k}`, new RegExp(`${k}:`).test(loginSrc), '');
}

// 小程序读取字段 → 服务端返回
const profileSrc = read(path.join(MP, 'pages', 'profile', 'profile.js'));
const used = ['nickname', 'wechat_id', 'phone', 'real_name', 'apply_note', 'avatar'].filter((k) => (profileSrc.match(new RegExp(k, 'g')) || []).length > 0);
const puMatch = /function publicUser[\s\S]*?\n}/.exec(read(path.join(ROOT, 'server', 'src', 'middleware.js')));
const publicUserBlock = puMatch ? puMatch[0] : '';
rec('小程序用到的资料字段服务端都会返回',
  used.every((k) => publicUserBlock.includes(k)),
  used.join(','));

// 头像上传字段名必须与 multer 一致
const apiSrc = read(path.join(MP, 'services', 'api.js'));
const fieldName = /upload\([^)]*\{\s*name:\s*'([^']+)'/.exec(apiSrc);
// 服务端头像上传用的是 print.js 导出的 uploadMiddleware('avatar')，字段名写死在 mp.js 的路由里
const serverField = /uploadMiddleware\('([^']+)'\)/.exec(mpSrc)
  || /avatarUpload = multer\(\{[\s\S]*?\}\)\.single\('([^']+)'\)/.exec(mpSrc);
rec('头像上传字段名前后端一致', !!fieldName && !!serverField && fieldName[1] === serverField[1],
  `小程序=${fieldName ? fieldName[1] : '?'} 服务端=${serverField ? serverField[1] : '?'}`);

// 小程序「我的资料」入口必须已在 app.json / mine 页里挂上
const appJson = JSON.parse(read(path.join(MP, 'app.json')) || '{}');
const mineSrc = read(path.join(MP, 'pages', 'mine', 'mine.js'));
const hasProfilePage = JSON.stringify(appJson).includes('pages/profile/profile');
rec('资料页已在 app.json 注册', hasProfilePage, hasProfilePage ? '' : '缺少 pages/profile/profile');
rec('「我的」页有资料入口', /profile/.test(mineSrc), '');

// WXML 结构（用现成的检查器逻辑：这里只确认关键文件存在且非空）
for (const f of ['pages/profile/profile.wxml', 'pages/profile/profile.js', 'pages/profile/profile.json']) {
  const p = path.join(MP, f);
  rec(`${f} 存在且非空`, fs.existsSync(p) && read(p).trim().length > 10, `${fs.existsSync(p) ? read(p).length + ' 字节' : '缺失'}`);
}

const pass = results.filter((x) => x.p).length;
console.log(`\n===== ${pass}/${results.length} 通过 =====`);
for (const f of results.filter((x) => !x.p)) console.log(`  - ${f.n} ${f.d}`);
if (pass !== results.length) process.exitCode = 1;
