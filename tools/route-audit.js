'use strict';
// 前后端接口对账：前端调用的每个 /api 路径，服务端是否真有对应路由
// 用法：node tools/route-audit.js
const fs = require('fs');
const path = require('path');

const ROOT = require('./_paths').projectRoot();
const webSrc = path.join(ROOT, 'web', 'src');
const routesDir = path.join(ROOT, 'server', 'src', 'routes');
const mpSrc = path.join(ROOT, 'miniprogram');
const mpAdmin = path.join(ROOT, 'miniprogram', 'packageAdmin');

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f);
    const st = fs.statSync(p);
    if (st.isDirectory()) { if (!['node_modules', 'miniprogram_npm'].includes(f)) walk(p, out); }
    else if (/\.(vue|js)$/.test(f)) out.push(p);
  }
  return out;
}

// ---------- 服务端路由 ----------
const serverRoutes = [];
for (const f of fs.readdirSync(routesDir)) {
  const src = fs.readFileSync(path.join(routesDir, f), 'utf8');
  const re = /router\.(get|post|put|delete)\(\s*['"`]([^'"`]+)['"`]/g;
  let m;
  while ((m = re.exec(src))) {
    serverRoutes.push({ method: m[1].toUpperCase(), path: m[2], file: f });
  }
}
// index.js 里还有 /api/health
serverRoutes.push({ method: 'GET', path: '/api/health', file: 'index.js' });

function toRegex(p) {
  // :action(approve|reject|...) 这类带约束的片段，对账时按「任意一段」处理即可
  const body = p
    .replace(/:([A-Za-z0-9_]+)\([^)]*\)/g, '[^/]+')
    .replace(/:([A-Za-z0-9_]+)/g, '[^/]+');
  return new RegExp('^' + body + '$');
}
const compiled = serverRoutes.map((r) => ({ ...r, re: toRegex(r.path) }));

function findRoute(method, url) {
  const clean = url.split('?')[0].replace(/\/+$/, '') || '/';
  return compiled.find((r) => r.re.test(clean) && (r.method === method || r.method === 'ALL'));
}

// ---------- 前端调用 ----------
const calls = [];
const files = [...walk(webSrc), ...walk(mpSrc), ...walk(mpAdmin)];
for (const f of files) {
  const src = fs.readFileSync(f, 'utf8');
  // api.get(`/users?status=${x}`) / request({ url: '/api/mp/me', method: 'POST' })
  let m;
  const re1 = /api\.(get|post|put|delete)\(\s*[`'"]([^`'"]+)[`'"]/g;
  while ((m = re1.exec(src))) calls.push({ file: f, method: m[1].toUpperCase(), url: m[2] });
  const re2 = /url:\s*[`'"]([^`'"]+)[`'"],\s*method:\s*['"`]([A-Z]+)['"`]/g;
  while ((m = re2.exec(src))) calls.push({ file: f, method: m[2], url: m[1] });
  // upload(...) 默认就是 POST
  const re4 = /upload\(([\s\S]{0,200}?)\)/g;
  while ((m = re4.exec(src))) {
    const um = /url:\s*[`'"]([^`'"]+)[`'"]/.exec(m[1]);
    if (um) calls.push({ file: f, method: 'POST', url: um[1] });
  }
  const re3 = /url:\s*[`'"]([^`'"]+)[`'"]/g;
  const declared = new Set(calls.filter((c) => c.file === f).map((c) => c.url));
  while ((m = re3.exec(src))) {
    const url = m[1];
    if (url.startsWith('/api/') && !declared.has(url)) calls.push({ file: f, method: 'GET', url });
  }
}

const missing = [];
const seen = new Set();
for (const c of calls) {
  // 动态片段用普通 token 代替，才能匹配 :id / :action(xxx) 之类的约束路由
  const url = c.url.replace(/\$\{[^}]+\}/g, 'x').replace(/^\/api(?=\/)/, '');
  const key = `${c.method} ${url}`;
  if (seen.has(key)) continue;
  seen.add(key);
  if (!findRoute(c.method, url)) missing.push({ ...c, url });
}

console.log(`前端调用 ${seen.size} 个接口，服务端路由 ${serverRoutes.length} 条`);
if (!missing.length) {
  console.log('✔ 全部接口都有对应路由');
} else {
  console.log(`✘ ${missing.length} 个调用找不到路由：`);
  for (const m of missing) console.log(`  ${m.method} ${m.url}  ← ${path.relative(ROOT, m.file)}`);
}

// 反向：定义了但前端/小程序都没用到的（仅供参考）
const used = new Set([...seen].map((s) => s.split(' ')[1]));
const unused = serverRoutes.filter((r) => {
  const norm = r.path;
  return !norm.includes(':') && ![...used].some((u) => findRoute(r.method, u) && findRoute(r.method, u).path === norm);
});
if (unused.length) {
  console.log(`\n（参考）${unused.length} 条路由前端未直接调用：`);
  for (const u of unused.slice(0, 20)) console.log(`  ${u.method} ${u.path}  [${u.file}]`);
}
process.exitCode = missing.length ? 1 : 0;
