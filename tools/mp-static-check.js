'use strict';
// 小程序静态一致性检查：WXML 事件 ↔ JS 方法、api.* ↔ 导出、图片/组件路径是否存在
// 用法：MP_DIR=<小程序目录> node tools/mp-static-check.js
const fs = require('fs');
const path = require('path');

// 小程序目录：优先 env，其次自动挑 mp56 下最新的「Printgate-小程序端-*」，
// 免掉每次打包后路径写死导致「检查跑的是上一版」这种假通过。
function resolveRoot() {
  if (process.env.MP_DIR) return process.env.MP_DIR;
  const base = process.env.MP_ROOT || 'C:/Users/Administrator/AppData/Local/Temp/mp56';
  try {
    const dirs = fs.readdirSync(base)
      .filter((n) => n.startsWith('Printgate-小程序端'))
      .map((n) => ({ n, t: fs.statSync(path.join(base, n)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    if (dirs.length) return path.join(base, dirs[0].n);
  } catch (_) { /* 目录不存在就让它报错，比静默用错目录好 */ }
  return base;
}

const ROOT = resolveRoot();
let pass = 0, fail = 0;
const bugs = [];
const rec = (n, ok, d = '') => { ok ? pass++ : (fail++, bugs.push(`${n}${d ? ' — ' + d : ''}`)); console.log(`${ok ? 'PASS' : 'FAIL'} | ${n}${d ? ' | ' + d : ''}`); };
const read = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const exists = (p) => fs.existsSync(p);

// ---------- 1) app.json 页面与组件 ----------
const appJson = JSON.parse(read(path.join(ROOT, 'app.json')));
for (const pg of appJson.pages) {
  const base = path.join(ROOT, pg);
  rec(`页面文件 ${pg}`, exists(base + '.js') && exists(base + '.wxml'), exists(base + '.json') ? '' : '缺 .json');
}

// subpackages
const subs = appJson.subpackages || appJson.subPackages || [];
for (const sp of subs) {
  for (const pg of sp.pages) {
    const full = path.join(ROOT, sp.root, pg);
    rec(`分包页面 ${sp.root}/${pg}`, exists(full + '.js') && exists(full + '.wxml'));
  }
}

// ---------- 2) usingComponents 路径 ----------
const allJsons = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.json')) allJsons.push(p);
  }
})(ROOT);

for (const jf of allJsons) {
  let j;
  try { j = JSON.parse(read(jf)); } catch (e) { rec(`JSON 解析 ${path.relative(ROOT, jf)}`, false, e.message.slice(0, 60)); continue; }
  const uc = j.usingComponents || {};
  for (const [name, rel] of Object.entries(uc)) {
    const target = rel.startsWith('/') ? path.join(ROOT, rel) : path.resolve(path.dirname(jf), rel);
    const ok = exists(target + '.js') || exists(target + '.wxml');
    if (!ok) rec(`组件 ${path.relative(ROOT, jf)} → ${name}`, false, rel);
  }
}

// ---------- 3) WXML 事件 → JS 方法 ----------
function collectMethods(jsPath) {
  const src = read(jsPath);
  const names = new Set();
  // 方法简写：  name(args) {   /  async name(  /  name: function
  const re1 = /^\s{2}(?:async\s+)?([A-Za-z_$][\w$]*)\s*\(/gm;
  let m;
  while ((m = re1.exec(src))) names.add(m[1]);
  const re2 = /^\s{2}([A-Za-z_$][\w$]*)\s*:\s*(?:async\s*)?function/gm;
  while ((m = re2.exec(src))) names.add(m[1]);
  const re3 = /^\s{2}([A-Za-z_$][\w$]*)\s*:\s*(?:async\s*)?\(/gm;
  while ((m = re3.exec(src))) names.add(m[1]);
  return names;
}

const wxmls = [];
(function walk2(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk2(p);
    else if (e.name.endsWith('.wxml') && !p.includes('components')) wxmls.push(p);
  }
})(ROOT);

for (const wf of wxmls) {
  const jsFile = wf.replace(/\.wxml$/, '.js');
  if (!exists(jsFile)) { rec(`缺少同名 JS ${path.relative(ROOT, wf)}`, false); continue; }
  const methods = collectMethods(jsFile);
  const src = read(wf);
  const re = /\b(?:bind|catch)(?::)?(tap|input|change|confirm|blur|focus|submit|scroll|longpress|longtap|touchstart|touchend)\s*=\s*"([^"{}]+)"/g;
  const missing = new Set();
  let m;
  while ((m = re.exec(src))) {
    const fn = m[2].trim();
    if (!fn || fn.includes('(')) continue;
    if (!methods.has(fn)) missing.add(fn);
  }
  rec(`事件方法 ${path.relative(ROOT, wf)}`, missing.size === 0, [...missing].join(', '));
}

// ---------- 4) api.* 调用 → 导出 ----------
const apiSrc = read(path.join(ROOT, 'services/api.js'));
const exportBlock = apiSrc.slice(apiSrc.indexOf('module.exports'));
const exported = new Set((exportBlock.match(/[A-Za-z_$][\w$]*/g) || []));

const jsFiles = [];
(function walk3(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk3(p);
    else if (e.name.endsWith('.js')) jsFiles.push(p);
  }
})(ROOT);

const usedApi = new Map();
for (const jf of jsFiles) {
  const src = read(jf);
  const re = /\bapi\.([A-Za-z_$][\w$]*)\s*\(/g;
  let m;
  while ((m = re.exec(src))) {
    const fn = m[1];
    if (!usedApi.has(fn)) usedApi.set(fn, new Set());
    usedApi.get(fn).add(path.relative(ROOT, jf));
  }
}
const missingApi = [...usedApi.entries()].filter(([fn]) => !exported.has(fn));
rec('api.* 全部有导出', missingApi.length === 0, missingApi.map(([fn, files]) => `${fn} (${[...files].join(',')})`).join('; '));

// ---------- 4.5) WXML 里不能调用页面方法 ----------
// {{fn(item)}} 这种写法 WeChat 不执行，只会渲染成空 —— 文件名/状态/时间空白就是这个原因
function collectPageMethods(jsPath) {
  const src = read(jsPath);
  const names = new Set();
  const re = new RegExp("^\\s{2}(?:async\\s+)?([A-Za-z_$][\\w$]*)\\s*\\(", "gm");
  let m;
  while ((m = re.exec(src))) names.add(m[1]);
  return names;
}

{
  const offenders = [];
  const BUILTIN = new Set(["wx", "require", "getApp", "getCurrentPages", "Math", "JSON", "String", "Number",
    "Boolean", "parseInt", "parseFloat", "Date", "Array", "Object", "encodeURIComponent", "decodeURIComponent"]);
  for (const wf of wxmls) {
    const jsFile = wf.replace(/\.wxml$/, '.js');
    if (!exists(jsFile)) continue;
    const methods = collectPageMethods(jsFile);
    if (!methods.size) continue;
    const src = read(wf);
    const re = new RegExp("\\{\\{[^}]*?\\b([A-Za-z_$][\\w$]*)\\s*\\(", "g");
    let m;
    while ((m = re.exec(src))) {
      const fn = m[1];
      if (BUILTIN.has(fn)) continue;
      if (!methods.has(fn)) continue;   // 只报「确实是页面方法」的调用
      offenders.push(path.relative(ROOT, wf) + " → " + fn + "()");
    }
  }
  rec("WXML 不用页面方法（函数调用）", offenders.length === 0, offenders.slice(0, 6).join("; "));
}

// ---------- 5) 图片/资源引用 ----------
const imgRe = /(?:src|iconPath|selectedIconPath)\s*=\s*"(\/[^"{}]+\.(?:png|jpg|jpeg|gif|svg|webp))"/g;
const missingImgs = new Set();
for (const wf of wxmls) {
  const src = read(wf);
  let m;
  while ((m = imgRe.exec(src))) {
    const rel = m[1].replace(/^\//, '');
    if (!exists(path.join(ROOT, rel))) missingImgs.add(`${m[1]} @${path.relative(ROOT, wf)}`);
  }
}
// tabBar 图标
for (const it of (appJson.tabBar && appJson.tabBar.list) || []) {
  for (const k of ['iconPath', 'selectedIconPath']) {
    if (it[k] && !exists(path.join(ROOT, it[k]))) missingImgs.add(`${it[k]} @app.json tabBar`);
  }
}
rec('图片资源全部存在', missingImgs.size === 0, [...missingImgs].slice(0, 6).join('; '));

// ---------- 6) 页面 onLoad 里用到的 api 是否 await 正确（粗查未捕获 Promise）----------
const uncaught = [];
for (const jf of jsFiles) {
  const src = read(jf);
  if (/api\.[A-Za-z_$][\w$]*\([^)]*\)\s*;/.test(src) && !/await|\.then|catch/.test(src)) uncaught.push(path.relative(ROOT, jf));
}
rec('无未处理的上游 Promise', uncaught.length === 0, uncaught.join(', '));

console.log(`\n合计 ${pass} 通过 / ${fail} 失败`);
if (fail) console.log('失败项:\n - ' + bugs.join('\n - '));
process.exit(fail ? 1 : 0);
