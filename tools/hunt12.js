'use strict';
// 上线前验收：授权矩阵 / 输入校验 / 健壮性（hunt12）
// 用法：PG_BASE=http://127.0.0.1:8098 PG_PASS=LocalTest2026 node tools/hunt12.js
// 设计要点：
//   1) 自动扫描 server/src/routes/*.js 里的路由声明，逐个打「无令牌 / 普通用户令牌」，
//      任何返回 2xx 的受保护接口都视为越权（漏鉴权是上线级事故，必须机器兜住）
//   2) 校验本轮修复：设备 URI 不允许 file://、队列名白名单、掩码 AppSecret 回存、目录包含判断
//   3) 健壮性：404/413/畸形 JSON/未知方法 都必须是 JSON 且不 5xx
const fs = require('fs');
const path = require('path');
const P = require('./_paths');

const BASE = process.env.PG_BASE || 'http://127.0.0.1:8098';
const PASS = process.env.PG_PASS || 'LocalTest2026';

let pass = 0;
const fails = [];
function rec(name, ok, detail = '') {
  if (ok) { pass += 1; console.log(`  ✓ ${name}${detail ? ' — ' + detail : ''}`); }
  else { fails.push(`${name}${detail ? ' — ' + detail : ''}`); console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

async function req(method, url, body, token, raw) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  let payload;
  if (raw !== undefined) { headers['Content-Type'] = 'application/json'; payload = raw; }
  else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const r = await fetch(BASE + url, { method, headers, body: payload });
  const text = await r.text();
  let j = null;
  try { j = JSON.parse(text); } catch (_) {}
  return { status: r.status, j, text, headers: r.headers };
}

// 只读探测：给每条路由按语义挑一个安全的 HTTP 方法（不改状态）
const ROUTE_METHOD = { get: 'GET', post: 'POST', put: 'PUT', delete: 'DELETE', patch: 'PATCH' };
// 无鉴权的公开接口（登录、初始化、健康检查、小程序登录、版本号）
const PUBLIC = new Set([
  '/auth/login', '/setup', '/public/bootstrap', '/mp/login', '/mp/dev-login', '/mp/version',
  '/auth/qr/create', '/auth/qr/status', '/mp/avatar/:name', '/auth/logout'
]);

function collectRoutes() {
  const dir = path.join(P.serverDir(), 'src', 'routes');
  const out = [];
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.js'))) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    const re = /router\.(get|post|put|delete|patch)\(\s*'([^']+)'/g;
    let m;
    while ((m = re.exec(src))) {
      // 取声明后的中间件链，用来区分「仅管理员」和「小程序用户可用」
      const tail = src.slice(m.index, m.index + 300);
      const adminOnly = /requireAdmin|requireMiniAdmin/.test(tail);
      out.push({ method: ROUTE_METHOD[m[1]], path: m[2], file: f, adminOnly });
    }
  }
  return out;
}

(async () => {
  console.log('=== [0] 登录与身份 ===');
  const login = await req('POST', '/api/auth/login', { password: PASS });
  rec('管理员登录', login.status === 200 && !!login.j?.token, `status=${login.status}`);
  const ADMIN = login.j && login.j.token;

  let dev = await req('POST', '/api/mp/dev-login', { openid: 'hunt12_user', nickname: '验收用户' });
  let devToggled = false;
  if (!dev.j || !dev.j.token) {
    // 生产镜像默认不开开发模式；验收需要「普通用户令牌」，临时打开、结束后还原
    const on = await req('PUT', '/api/settings', { devMode: true }, ADMIN);
    if (on.status === 200) {
      devToggled = true;
      dev = await req('POST', '/api/mp/dev-login', { openid: 'hunt12_user', nickname: '验收用户' });
    }
  }
  rec('普通用户登录（开发模式模拟）', dev.status === 200 && !!dev.j?.token,
    devToggled ? `status=${dev.status}（临时开启 devMode）` : `status=${dev.status}`);
  const USER = dev.j && dev.j.token;
  if (!USER) console.warn('警告：拿不到普通用户令牌，涉及「普通用户越权」的检查会被跳过');

  console.log('\n=== [A] 授权矩阵：受保护接口不得对匿名/普通用户放行 ===');
  const routes = collectRoutes();
  console.log(`  扫描到 ${routes.length} 条路由声明`);
  const leaks = [];
  const userLeaks = [];
  const skipped = [];
  for (const r of routes) {
    if (PUBLIC.has(r.path)) { skipped.push(r.path); continue; }
    // 参数占位：数字型用 1，:name 用占位合法名
    const url = '/api' + r.path.replace(/:[A-Za-z]+(\([^)]*\))?/g, (mm) => (r.path.includes(':name') && mm.startsWith(':name') ? 'hunt12-noqueue' : '1'));
    let resp;
    try { resp = await req(r.method, url, r.method === 'GET' ? undefined : {}); } catch (e) { continue; }
    // 无令牌：401/403/404/400 都可接受（404 用于「不存在」，但绝不能 2xx）
    if (resp.status < 300) leaks.push(`${r.method} ${r.path} → ${resp.status}`);
    // 只有「管理员专属」路由才要求普通用户令牌被拒；/mp/* 本就该允许普通小程序用户访问
    if (!r.adminOnly) continue;
    let resp2;
    try { resp2 = await req(r.method, url, r.method === 'GET' ? undefined : {}, USER); } catch (e) { continue; }
    if (resp2.status < 300) userLeaks.push(`${r.method} ${r.path} → ${resp2.status}`);
  }
  rec('无令牌访问受保护接口全部被拒', leaks.length === 0, leaks.slice(0, 5).join(' | ') || `${routes.length - skipped.length} 条路由`);
  rec('普通用户令牌访问管理接口全部被拒', userLeaks.length === 0, userLeaks.slice(0, 5).join(' | '));

  console.log('\n=== [B] 本轮修复验证 ===');
  // B1 file:// 设备地址必须被拒（否则等于开放的任意文件写）
  const fileUri = await req('POST', '/api/printers', { name: 'hunt12-queue', uri: 'file:///tmp/hunt12.out' }, ADMIN);
  rec('设备地址 file:// 被拒', fileUri.status === 400, `status=${fileUri.status} msg=${(fileUri.j || {}).msg || ''}`);
  const okUri = await req('POST', '/api/printers', { name: 'hunt12-queue', uri: 'ipp://127.0.0.1:631/ipp/print' }, ADMIN);
  rec('合法 ipp:// 通过校验（失败点应是有无 CUPS，不是校验）', okUri.status !== 400 || !/标准 URI|队列名/.test((okUri.j || {}).msg || ''),
    `status=${okUri.status} msg=${(okUri.j || {}).msg || ''}`);

  // B2 队列名白名单：以 '-' 开头的名字会被 lpadmin 当成开关
  for (const bad of ['-h', 'a b', '../etc']) {
    const r = await req('POST', `/api/printers/${encodeURIComponent(bad)}/default`, {}, ADMIN);
    rec(`畸形队列名被拒：${bad}`, r.status === 400, `status=${r.status}`);
  }

  // B3 掩码 AppSecret 回存不得 400（页面保存的核心回归）
  const before = await req('GET', '/api/wechat/config', undefined, ADMIN);
  const beforeSecret = before.j?.config?.secret || '';
  const maskedSave = await req('PUT', '/api/wechat/config', { secret: beforeSecret || 'abcd****wxyz' }, ADMIN);
  rec('掩码 AppSecret 原样回存成功', maskedSave.status === 200, `status=${maskedSave.status} ${(maskedSave.j || {}).msg || ''}`);

  // B4 目录包含判断：同前缀兄弟目录不算「在目录内」
  const fsutil = require(path.join(P.serverDir(), 'src', 'fsutil'));
  const dataDir = path.join(P.projectRoot(), '_hunt12');
  rec('isInside 识别同前缀兄弟目录', fsutil.isInside('/data/avatar', '/data/avatar-evil/x.png') === false, '');
  rec('isInside 识别真实子路径', fsutil.isInside('/data/avatar', '/data/avatar/x.png') === true, '');
  rec('isInside 拒绝 .. 穿越', fsutil.isInside('/data/avatar', '/data/avatar/../../etc/passwd') === false, '');
  // 驱动删除穿越
  const drvDel = await req('DELETE', '/api/drivers/stored/' + encodeURIComponent('ppd:' + path.join(P.serverDir(), 'package.json')), undefined, ADMIN);
  rec('驱动删除拒绝目录外路径', drvDel.status === 400, `status=${drvDel.status}`);

  console.log('\n=== [C] 健壮性 ===');
  const unknown = await req('GET', '/api/hunt12-not-exist', undefined, ADMIN);
  rec('未知接口返回 JSON 404', unknown.status === 404 && unknown.j && unknown.j.ok === false, `status=${unknown.status}`);
  const deep = await req('GET', '/#/tasks');
  rec('SPA 深链返回 HTML', deep.status === 200 && /<div id="app"|<!doctype html>/i.test(deep.text), `status=${deep.status}`);
  const malformed = await req('POST', '/api/auth/login', undefined, undefined, '{"password": ');
  rec('畸形 JSON 返回 400 而非 500', malformed.status >= 400 && malformed.status < 500, `status=${malformed.status}`);
  const big = await req('POST', '/api/auth/login', { password: 'x'.repeat(3 * 1024 * 1024) }, undefined);
  rec('超大请求体被拒（413/400）', big.status === 413 || big.status === 400, `status=${big.status}`);
  const noAuthz = await req('GET', '/api/tasks', undefined, 'not-a-real-token');
  rec('伪造令牌被拒', noAuthz.status === 401, `status=${noAuthz.status}`);

  console.log('\n=== [D] 越权读：普通用户不得读到他人数据 ===');
  const otherFiles = await req('GET', '/api/files', undefined, USER);
  rec('普通用户不能读管理端文件列表', otherFiles.status === 401 || otherFiles.status === 403, `status=${otherFiles.status}`);
  const otherTask = await req('GET', '/api/tasks/1', undefined, USER);
  rec('普通用户不能读任务详情', otherTask.status === 401 || otherTask.status === 403, `status=${otherTask.status}`);
  const mpOther = await req('GET', '/api/mp/files/1/preview', undefined, USER);
  rec('普通用户不能预览他人文件', mpOther.status === 403 || mpOther.status === 404, `status=${mpOther.status}`);

  if (devToggled) {
    await req('PUT', '/api/settings', { devMode: false }, ADMIN);
    console.log('（已还原 devMode=false）');
  }

  console.log(`\n===== 通过 ${pass} / 失败 ${fails.length} =====`);
  if (fails.length) {
    console.log('失败项：');
    for (const f of fails) console.log('  - ' + f);
  }
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error('FATAL', e.message); process.exit(2); });
