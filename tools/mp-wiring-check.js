'use strict';
// 小程序接线静态检查：抓「改一面漏三面」类的 bug
//  1. wxml 里用了 van-xxx / 自定义组件，但页面 json 没注册
//  2. 页面 js 调了 api.xxx()，但 api.js 没导出
//  3. app.json 注册了不存在的页面；磁盘上有页面但没注册
//  4. 页面漏了 theme.apply / themeVars 接线（主题会失效）
//  5. tabBar（含自定义）指向的页面不存在
// 用法：node tools/mp-wiring-check.js [小程序目录]
const fs = require('fs');
const path = require('path');

const ROOT = process.argv[2] || path.join(require('./_paths').projectRoot(), 'miniprogram');

// hasMiniprogramGuard
// 交付包允许裁剪小程序源码：缺 miniprogram/ 时直接跳过，别让回归里全是崩溃
if (!require('fs').existsSync(require('path').join(ROOT, 'app.json'))) {
  console.log('跳过：当前包未包含 miniprogram/（小程序源码已裁剪），本检查不适用');
  process.exit(0);
}

// app.json 里全是正斜杠，磁盘路径在 Windows 上是反斜杠，统一 normalize
const norm = (p) => p.split(path.sep).join('/');
const problems = [];
const add = (msg) => problems.push(msg);

function walk(dir, out = []) {
  for (const f of fs.readdirSync(dir)) {
    if (f === 'node_modules' || f === 'miniprogram_npm') continue;
    const p = path.join(dir, f);
    const st = fs.statSync(p);
    if (st.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const appJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'app.json'), 'utf8'));
const registered = new Set(appJson.pages || []);
const subRoots = (appJson.subpackages || []).map((s) => s.root);
for (const s of appJson.subpackages || []) for (const p of s.pages || []) registered.add(`${s.root}/${p}`);

// ---------- 1+2+4：逐页面检查 ----------
const apiSrc = fs.readFileSync(path.join(ROOT, 'services', 'api.js'), 'utf8');
const apiExports = new Set([...apiSrc.matchAll(/const (\w+)\s*=/g)].map((m) => m[1]));

let pageCount = 0;
for (const rel of registered) {
  // app.json 里的 'pages/index/index'：目录是 pages/index，文件是 index.js/.wxml/.json
  const base = path.basename(rel);
  const dir = path.join(ROOT, path.dirname(rel));
  const jsFile = path.join(dir, `${base}.js`);
  const wxmlFile = path.join(dir, `${base}.wxml`);
  const jsonFile = path.join(dir, `${base}.json`);
  if (!fs.existsSync(jsFile) || !fs.existsSync(wxmlFile)) {
    add(`app.json 注册了 ${rel}，但缺少 ${path.basename(rel)}.js/.wxml`);
    continue;
  }
  pageCount++;
  const pageJson = fs.existsSync(jsonFile) ? JSON.parse(fs.readFileSync(jsonFile, 'utf8')) : {};
  const using = pageJson.usingComponents || {};
  const wxml = fs.readFileSync(wxmlFile, 'utf8');
  const js = fs.readFileSync(jsFile, 'utf8');

  // 1) 组件注册：wxml 里出现的标签都要能注册（van-* 或自定义组件）
  const tags = new Set();
  for (const m of wxml.matchAll(/<([a-z][a-z0-9-]*)/gi)) tags.add(m[1].toLowerCase());
  const builtin = new Set(['view', 'text', 'image', 'button', 'input', 'textarea', 'block', 'scroll-view',
    'swiper', 'swiper-item', 'icon', 'rich-text', 'progress', 'switch', 'checkbox', 'radio', 'picker',
    'slider', 'navigator', 'form', 'label', 'canvas', 'map', 'video', 'audio', 'camera', 'live-player',
    'live-pusher', 'web-view', 'ad', 'official-account', 'open-data', 'functional-page-navigator',
    'share-element', 'page-container', 'match-media', 'navigation-bar', 'page-meta']);
  for (const t of tags) {
    if (builtin.has(t)) continue;
    if (t.startsWith('van-') || t.includes('-')) {
      // 自定义组件（如 custom-tab-bar）或 van 组件：必须注册
      if (!using[t]) add(`${rel}: wxml 用了 <${t}> 但 ${path.basename(rel)}.json 未注册`);
    }
  }

  // 2) api 调用存在性
  const apiReqs = [...js.matchAll(/api\.(\w+)\(/g)].map((m) => m[1]);
  for (const fn of new Set(apiReqs)) {
    if (!apiExports.has(fn)) add(`${rel}: 调用了 api.${fn}()，但 services/api.js 未导出`);
  }
  // 页面 require 的 util 文件存在
  for (const m of js.matchAll(/require\('(\.[^']+)'\)/g)) {
    const rp = path.resolve(dir, m[1]);
    const cand = [rp, `${rp}.js`, path.join(rp, 'index.js')];
    if (!cand.some((c) => fs.existsSync(c))) add(`${rel}: require('${m[1]}') 指向不存在的文件`);
  }

  // 4) 主题接线（登录页等全屏页也应有；自定义 tabBar 页面除外——它自带）
  if (!js.includes('theme.apply')) add(`${rel}: 未调用 theme.apply(this)（主题色/深色模式在该页不生效）`);
  if (!wxml.includes('themeVars')) add(`${rel}: wxml 根节点未绑定 themeVars`);
}

// ---------- 3) 磁盘上有页面但没注册 ----------
const pageDirs = [];
for (const base of ['pages', ...subRoots.map((r) => norm(path.join(r, 'pages')))]) {
  const abs = path.join(ROOT, base);
  if (!fs.existsSync(abs)) continue;
  for (const d of fs.readdirSync(abs)) {
    const pd = path.join(abs, d);
    if (fs.statSync(pd).isDirectory() && fs.existsSync(path.join(pd, `${d}.js`))) {
      pageDirs.push(norm(`${base}/${d}/${d}`));
    }
  }
}
for (const pd of pageDirs) {
  if (!registered.has(pd)) add(`磁盘页面 ${pd} 未在 app.json 注册（入口丢了就会变成死页面）`);
}

// ---------- 5) tabBar 指向存在 ----------
for (const item of (appJson.tabBar || {}).list || []) {
  if (!registered.has(item.pagePath)) add(`tabBar 指向 ${item.pagePath}，但该页未注册`);
}

// ---------- 汇总 ----------
console.log(`检查 ${pageCount} 个已注册页面 + ${pageDirs.length} 个磁盘页面目录`);
if (problems.length) {
  console.log(`发现 ${problems.length} 个接线问题：`);
  for (const p of problems) console.log(`  ✗ ${p}`);
  process.exit(1);
} else {
  console.log('接线完整：组件注册 / api 导出 / 页面注册 / 主题接线 / tabBar 全部一致');
}
