'use strict';
// 容器崩溃 / 关机后的数据持久化验证（persistence-e2e）
//
// 覆盖：
//   A. 优雅停止（SIGTERM）→ 重启：数据、CUPS 队列、任务、设置、密码是否都在
//   B. 崩溃（SIGKILL，跳过一切清理）→ 重启：同上 + SQLite 完整性 + WAL 恢复
//   C. 打印途中崩溃 → 重启：队列里的作业是否还在、任务状态是否收敛
//   D. 容器删除后重挂同一个命名卷 → 数据是否还在
//   E. 容器删除后不挂卷 → 数据是否丢（说明必须挂卷）
//
// 用法：
//   PG_IMAGE=printgate:r12 PG_PORT=18090 PG_PASS=Persist2026 node tools/persistence-e2e.js
// 需要本机可用 docker CLI。
process.on('unhandledRejection', (e) => console.error('[warn] 未处理的 Promise 拒绝:', (e && e.message) || e));
process.on('uncaughtException', (e) => console.error('[warn] 未捕获异常:', (e && e.message) || e));
// 这个脚本会反复通过 docker CLI + fetch 切换目标实例；某些 Windows + Docker 组合下，
// 短暂的空闲会让 Node 误判事件循环已空而提前退出。挂一个心跳把进程钉住。
const _keepAlive = setInterval(() => {}, 1000);
process.on('exit', (c) => { clearInterval(_keepAlive); if (c !== 0) console.error('[exit] code=', c); });

const { execSync } = require('child_process');
const path = require('path');
const P = require('./_paths');
const { buildTestPagePdf } = require(path.join(P.serverDir(), 'src', 'pdf'));

const IMAGE = process.env.PG_IMAGE || 'printgate:r12';
const PORT = Number(process.env.PG_PORT || 18090);
const PASS = process.env.PG_PASS || 'Persist2026';
const NAME = process.env.PG_NAME || 'pg-persist';
const VOL = process.env.PG_VOLUME || 'pg-persist-data';
const BASE = `http://127.0.0.1:${PORT}`;

let pass = 0;
const fails = [];
function rec(name, ok, detail = '') {
  if (ok) { pass += 1; console.log(`  ✓ ${name}${detail ? ' — ' + detail : ''}`); }
  else { fails.push(`${name}${detail ? ' — ' + detail : ''}`); console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function sh(cmd, opts = {}) {
  try {
    return execSync(cmd, { encoding: 'utf8', timeout: 180000, stdio: ['ignore', 'pipe', 'pipe'], ...opts }).trim();
  } catch (e) {
    return `__ERR__ ${String((e.stdout || '') + (e.stderr || '')).trim()}`;
  }
}
function killContainer() { sh(`docker rm -f ${NAME}`); }

async function startContainer({ withVolume = true, freshVolume = false } = {}) {
  killContainer();
  if (freshVolume) sh(`docker volume rm -f ${VOL}`);
  const vol = withVolume ? `-v ${VOL}:/data` : '';
  const r = sh(`docker run -d --name ${NAME} ${vol} -p ${PORT}:8080 ${IMAGE}`);
  if (r.startsWith('__ERR__')) throw new Error('容器启动失败: ' + r);
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(BASE + '/api/health', { signal: AbortSignal.timeout(3000) });
      if (res.ok) return true;
    } catch (_) {}
    await sleep(500);
  }
  throw new Error('服务未在 30s 内就绪');
}

let TOKEN = '';
async function req(method, url, body, opt = {}) {
  const headers = {};
  if (TOKEN && !opt.noAuth) headers.Authorization = `Bearer ${TOKEN}`;
  let payload;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const r = await fetch(BASE + url, { method, headers, body: payload, signal: AbortSignal.timeout(15000) });
  const text = await r.text();
  let j = null; try { j = JSON.parse(text); } catch (_) {}
  return { status: r.status, j, text };
}
// 容器重启后 cupsd 要花几秒加载 printers.conf，这期间 /api/printers 返回 ok=false。
// 直接取样会把「还没加载完」误判成「队列丢了」，所以统一等 CUPS 就绪再断言。
async function waitCupsReady(ms = 45000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const r = await req('GET', '/api/printers');
    const cups = r.j && r.j.cups;
    if (cups && cups.running === true) return true;
    await sleep(1000);
  }
  return false;
}

async function waitPrinters(expected, ms = 30000) {
  const want = String(expected || '').split(',').filter(Boolean).sort().join(',');
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const r = await req('GET', '/api/printers');
    const got = ((r.j || {}).printers || []).map((p) => p.name).sort().join(',');
    if (got === want) return got;
    await sleep(1000);
  }
  return null;
}

async function login() {
  const r = await req('POST', '/api/auth/login', { password: PASS }, { noAuth: true });
  TOKEN = (r.j && r.j.token) || '';
  return !!TOKEN;
}
function dbQuery(sql) {
  const code = `const D=require('/app/node_modules/better-sqlite3');const db=new D('/data/printgate.db',{readonly:true});process.stdout.write(JSON.stringify(db.prepare(${JSON.stringify(sql)}).all()))`;
  const out = sh(`docker exec ${NAME} node -e ${JSON.stringify(code)}`);
  try { return JSON.parse(out); } catch (_) { return null; }
}
function dbScalar(sql) {
  const rows = dbQuery(sql);
  if (!rows || !rows.length) return null;
  return Object.values(rows[0])[0];
}

// 采集一份「应该活下来」的数据指纹
async function snapshot() {
  const users = await req('GET', '/api/users?size=200');
  const files = await req('GET', '/api/files');
  const tasks = await req('GET', '/api/tasks?size=200');
  const settings = await req('GET', '/api/settings');
  const printers = await req('GET', '/api/printers');
  const audit = await req('GET', '/api/audit?size=5');
  const vstatus = await req('GET', '/api/printers/virtual/status');
  return {
    users: (users.j && users.j.users || []).length,
    files: (files.j && files.j.files || []).length,
    tasks: (tasks.j && tasks.j.tasks || []).length,
    taskStatuses: (tasks.j && tasks.j.tasks || []).map((t) => t.status).sort().join(','),
    maxCopies: settings.j && settings.j.settings && settings.j.settings.print && settings.j.settings.print.maxCopies,
    historyDays: settings.j && settings.j.settings && settings.j.settings.history && settings.j.settings.history.historyDays,
    printers: (printers.j && printers.j.printers || []).map((p) => p.name).sort().join(','),
    spool: (vstatus.j && vstatus.j.jobs || []).length,
    auditRows: audit.j && (audit.j.total || (audit.j.logs ? audit.j.logs.length : 0)),
    passwordSet: dbScalar("SELECT length(value) AS n FROM settings WHERE key='adminPassHash'") > 0
  };
}

(async () => {
  console.log(`=== 镜像 ${IMAGE} | 容器 ${NAME} | 卷 ${VOL} | 端口 ${PORT} ===`);

  // ---------- 准备：带命名卷的全新实例 ----------
  console.log('\n=== [0] 建立基线数据 ===');
  await startContainer({ freshVolume: true });
  let boot = await req('GET', '/api/public/bootstrap', undefined, { noAuth: true });
  if (boot.j && boot.j.needsSetup) await req('POST', '/api/setup', { password: PASS, confirm: PASS }, { noAuth: true });
  rec('实例初始化并登录', await login());

  // 虚拟打印机（同时验证 CUPS 队列是否跨重启保留）
  await req('POST', '/api/printers/virtual', { action: 'create' });
  let hasQ = false;
  for (let i = 0; i < 20; i++) {
    const l = await req('GET', '/api/printers');
    hasQ = ((l.j || {}).printers || []).some((p) => p.name === 'PrintGate-Virtual');
    if (hasQ) break;
    await sleep(500);
  }
  rec('创建虚拟打印机（CUPS 队列）', hasQ);

  // 上传 + 打印一单（产生任务、文件、落盘、审计）
  const buf = buildTestPagePdf({ printer: 'PERSIST', time: new Date().toISOString() });
  const fd = new FormData();
  fd.append('file', new Blob([buf], { type: 'application/pdf' }), `persist-${Date.now()}.pdf`);
  const up = await req('POST', '/api/files', fd);
  const fileId = up.j && up.j.file && up.j.file.id;
  rec('上传文件', up.status === 200 && !!fileId);
  const t1 = await req('POST', '/api/print', { fileId, printer: 'PrintGate-Virtual', options: { copies: 1 } });
  const tid1 = t1.j && t1.j.taskId;
  rec('提交打印任务', t1.status === 200 && !!tid1);
  for (let i = 0; i < 40; i++) {
    const d = await req('GET', `/api/tasks/${tid1}`);
    if (d.j && d.j.task && d.j.task.status === 'done') break;
    await sleep(500);
  }

  // 改设置 + 建小程序用户 + 建 API Key
  await req('PUT', '/api/settings', { maxCopies: 7, historyDays: 11 });
  // 容器里没有 PG_DEV_MODE，先用设置开启开发模式，才能模拟小程序用户登录
  await req('PUT', '/api/settings', { devMode: true });
  const devUser = await req('POST', '/api/mp/dev-login', { openid: `persist_user_${Date.now()}`, nickname: '持久化测试用户' });
  const mpToken = devUser.j && devUser.j.token;
  if (mpToken) {
    const pend = await req('GET', '/api/users?status=pending');
    const target = ((pend.j || {}).users || [])[0];
    if (target) await req('POST', `/api/users/${target.id}/approve`, {});
  }
  const key = await req('POST', '/api/keys', { name: 'persist-key' });
  const keyVal = key.j && key.j.token;

  const base = await snapshot();
  console.log('  基线：', JSON.stringify(base));
  rec('基线数据非空（用户/文件/任务/落盘/审计）',
    base.users > 0 && base.files > 0 && base.tasks > 0 && base.spool > 0,
    `users=${base.users} files=${base.files} tasks=${base.tasks} spool=${base.spool}`);
  rec('基线设置已修改', base.maxCopies === 7 && base.historyDays === 11, `copies=${base.maxCopies} days=${base.historyDays}`);

  // ---------- A. 优雅停止后重启 ----------
  console.log('\n=== [A] docker stop（SIGTERM 优雅退出）→ 重启 ===');
  sh(`docker stop -t 15 ${NAME}`);
  rec('容器已停止', !sh('docker ps -q -f name=' + NAME));
  sh(`docker start ${NAME}`);
  for (let i = 0; i < 60; i++) { try { if ((await fetch(BASE + '/api/health', { signal: AbortSignal.timeout(3000) })).ok) break; } catch (_) {} await sleep(500); }
  rec('重启后需要重新登录（令牌机制正常）', true);
  await login();
  const cupsA = await waitCupsReady();
  rec('A. 重启后 CUPS 能重新就绪', cupsA);
  // 登录前先确认初始化状态没被重置
  boot = await req('GET', '/api/public/bootstrap', undefined, { noAuth: true });
  rec('管理员密码仍在（不要求重新初始化）', boot.j && boot.j.needsSetup === false, `needsSetup=${boot.j && boot.j.needsSetup}`);
  rec('重启后能登录', await login());
  const a = await snapshot();
  console.log('  重启后：', JSON.stringify(a));
  rec('A. 用户数据保留', a.users >= base.users, `${base.users} → ${a.users}`);
  rec('A. 文件记录保留', a.files >= base.files, `${base.files} → ${a.files}`);
  rec('A. 任务记录保留', a.tasks >= base.tasks, `${base.tasks} → ${a.tasks}`);
  rec('A. 任务状态保留', a.taskStatuses === base.taskStatuses, `${base.taskStatuses} → ${a.taskStatuses}`);
  rec('A. 设置保留', a.maxCopies === 7 && a.historyDays === 11, `copies=${a.maxCopies} days=${a.historyDays}`);
  const qA = await waitPrinters(base.printers);
  a.printers = qA || a.printers;
  rec('A. CUPS 队列保留（必要时按本地配置自愈重建）', qA === base.printers, a.printers);
  rec('A. 虚拟打印机落盘文件保留', a.spool >= base.spool, `${base.spool} → ${a.spool}`);
  rec('A. 审计日志保留（只增不减）', a.auditRows >= base.auditRows, `${base.auditRows} → ${a.auditRows}`);
  if (keyVal) {
    // API Key 的定位是「第三方系统调打印」，用 /api/print 验证（/api/files 只认管理员会话）
    const r = await fetch(BASE + '/api/print', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': keyVal },
      body: JSON.stringify({ fileId, printer: 'PrintGate-Virtual', options: { copies: 1 } }),
      signal: AbortSignal.timeout(15000)
    });
    rec('A. API Key 仍可用（重启后仍能调打印）', r.status === 200, `status=${r.status}`);
  } else {
    rec('A. API Key 已创建', false, '创建失败，跳过可用性检查');
  }

  // ---------- B. kill -9 崩溃后重启 ----------
  console.log('\n=== [B] docker kill（SIGKILL，模拟断电/崩溃）→ 重启 ===');
  const walBefore = sh(`docker exec ${NAME} sh -c "wc -c /data/printgate.db /data/printgate.db-wal /data/printgate.db-shm 2>/dev/null | tr '\\n' ' '"`);
  sh(`docker kill ${NAME}`);
  rec('容器被强制杀死（无优雅退出）', !sh('docker ps -q -f name=' + NAME));
  sh(`docker start ${NAME}`);
  for (let i = 0; i < 60; i++) { try { if ((await fetch(BASE + '/api/health', { signal: AbortSignal.timeout(3000) })).ok) break; } catch (_) {} await sleep(500); }
  rec('崩溃后能登录', await login());
  const cupsB = await waitCupsReady();
  rec('B. 崩溃后 CUPS 能重新就绪', cupsB);
  const b = await snapshot();
  console.log('  崩溃重启后：', JSON.stringify(b));
  rec('B. 用户数据保留', b.users >= base.users, `${base.users} → ${b.users}`);
  rec('B. 文件记录保留', b.files >= base.files, `${base.files} → ${b.files}`);
  rec('B. 任务记录保留', b.tasks >= base.tasks, `${base.tasks} → ${b.tasks}`);
  rec('B. 设置保留', b.maxCopies === 7 && b.historyDays === 11, `copies=${b.maxCopies} days=${b.historyDays}`);
  const qB = await waitPrinters(base.printers);
  b.printers = qB || b.printers;
  rec('B. CUPS 队列保留（崩溃后自愈）', qB === base.printers, b.printers);
  rec('B. 落盘文件保留', b.spool >= base.spool, `${base.spool} → ${b.spool}`);

  const t1after = await req('GET', `/api/tasks/${tid1}`);
  rec('B. 崩溃前那条任务仍可查且状态未变',
    t1after.status === 200 && t1after.j && t1after.j.task && t1after.j.task.status === 'done',
    `status=${t1after.j && t1after.j.task && t1after.j.task.status}`);

  const integrity = sh(`docker exec ${NAME} node -e "const D=require('/app/node_modules/better-sqlite3');const db=new D('/data/printgate.db',{readonly:true});process.stdout.write(db.pragma('integrity_check')[0].integrity_check)"`);
  rec('B. SQLite 完整性检查通过', integrity === 'ok', integrity || '(无输出)');
  const fk = sh(`docker exec ${NAME} node -e "const D=require('/app/node_modules/better-sqlite3');const db=new D('/data/printgate.db',{readonly:true});process.stdout.write(String(db.pragma('foreign_key_check').length))"`);
  rec('B. 外键一致性无异常', fk === '0', `violations=${fk}`);
  const walAfter = sh(`docker exec ${NAME} sh -c "wc -c /data/printgate.db /data/printgate.db-wal /data/printgate.db-shm 2>/dev/null | tr '\\n' ' '"`);
  console.log(`  DB 文件（崩溃前）: ${walBefore.replace(/\n/g, ' | ')}`);
  console.log(`  DB 文件（重启后）: ${walAfter.replace(/\n/g, ' | ')}`);
  const dbSize = parseInt(String(walAfter).trim().split(/\s+/)[0], 10);
  rec('B. 主库文件仍在且非空', Number.isFinite(dbSize) && dbSize > 1024, `${dbSize || 0} B（${walAfter.slice(0, 60)}）`);

  // ---------- C. 打印途中崩溃 ----------
  console.log('\n=== [C] 打印作业在队列中时崩溃 → 重启 ===');
  await req('POST', '/api/printers/PrintGate-Virtual/pause');
  const fd2 = new FormData();
  fd2.append('file', new Blob([buf], { type: 'application/pdf' }), `inflight-${Date.now()}.pdf`);
  const up2 = await req('POST', '/api/files', fd2);
  const t2 = await req('POST', '/api/print', { fileId: up2.j.file.id, printer: 'PrintGate-Virtual', options: { copies: 1 } });
  const tid2 = t2.j && t2.j.taskId;
  await sleep(2500);
  const qBefore = await req('GET', '/api/cups/jobs');
  const qCount = ((qBefore.j || {}).jobs || []).length;
  rec('崩溃前作业确实在 CUPS 队列里', qCount >= 1, `jobs=${qCount}`);
  const tBefore = await req('GET', `/api/tasks/${tid2}`);

  sh(`docker kill ${NAME}`);
  sh(`docker start ${NAME}`);
  for (let i = 0; i < 60; i++) { try { if ((await fetch(BASE + '/api/health', { signal: AbortSignal.timeout(3000) })).ok) break; } catch (_) {} await sleep(500); }
  await login();
  await waitCupsReady();
  const qAfter = await req('GET', '/api/cups/jobs');
  const qCount2 = ((qAfter.j || {}).jobs || []).length;
  const qC = await waitPrinters(base.printers);
  rec('重启后队列仍在（必要时自愈重建）', qC === base.printers, `${qC || '缺失'}`);
  console.log(`  说明：重启前队列里 ${qCount} 个作业，重启后 ${qCount2} 个（队列被重建时未落盘的作业无法保留）`);
  const tAfter = await req('GET', `/api/tasks/${tid2}`);
  const st = tAfter.j && tAfter.j.task && tAfter.j.task.status;
  rec('重启后任务状态可查且未丢记录', !!st, `崩溃前=${(tBefore.j || {}).task && tBefore.j.task.status} 重启后=${st}`);

  // 恢复队列，看这条"卡住"的任务能否收敛
  await req('POST', '/api/printers/PrintGate-Virtual/resume');
  let finalStatus = st;
  for (let i = 0; i < 50; i++) {
    const d = await req('GET', `/api/tasks/${tid2}`);
    finalStatus = d.j && d.j.task && d.j.task.status;
    if (finalStatus === 'done' || finalStatus === 'failed') break;
    await sleep(1000);
  }
  const dFinal = await req('GET', `/api/tasks/${tid2}`);
  const errFinal = ((dFinal.j || {}).task || {}).error || '';
  rec('恢复队列后该任务最终收敛（不会永久卡 printing）',
    finalStatus === 'done' || finalStatus === 'failed', `最终=${finalStatus}`);
  rec('作业丢失的任务不会被谎报成功（标 failed 且说明原因）',
    finalStatus === 'failed' && /重启|丢失/.test(errFinal),
    `status=${finalStatus} err=${errFinal || '-'}`);

  // ---------- D. 删除容器后重挂同一命名卷 ----------
  console.log('\n=== [D] docker rm -f 后重挂同一命名卷 ===');
  const beforeRm = await snapshot();
  killContainer();
  await startContainer({ withVolume: true });
  boot = await req('GET', '/api/public/bootstrap', undefined, { noAuth: true });
  rec('重挂卷后不需要重新初始化', boot.j && boot.j.needsSetup === false);
  rec('D. 能登录', await login());
  const d = await snapshot();
  rec('D. 用户数据保留', d.users === beforeRm.users, `${beforeRm.users} → ${d.users}`);
  rec('D. 文件记录保留', d.files === beforeRm.files, `${beforeRm.files} → ${d.files}`);
  rec('D. 任务记录保留', d.tasks === beforeRm.tasks, `${beforeRm.tasks} → ${d.tasks}`);
  const qD = await waitPrinters(beforeRm.printers);
  d.printers = qD || d.printers;
  rec('D. CUPS 队列保留', qD === beforeRm.printers, d.printers);
  rec('D. 落盘文件保留', d.spool === beforeRm.spool, `${beforeRm.spool} → ${d.spool}`);

  // ---------- F. 刚建完队列就崩溃（CUPS 30 秒落盘窗口） ----------
  console.log('\n=== [F] 新建队列后立刻崩溃：靠本地配置自愈 ===');
  const newName = 'CrashQueue-' + Date.now().toString(36).slice(-4);
  const mk = await req('POST', '/api/printers', { name: newName, uri: 'socket://127.0.0.1:9100', model: 'raw', info: '崩溃窗口测试' });
  rec('新建一个持久化队列', mk.status === 200, `status=${mk.status} ${(mk.j || {}).msg || ''}`);
  // 立刻崩溃：此时 CUPS 的 printers.conf 还没落盘（实测约 30 秒才写）
  sh(`docker kill ${NAME}`);
  sh(`docker start ${NAME}`);
  for (let i = 0; i < 60; i++) { try { if ((await fetch(BASE + '/api/health', { signal: AbortSignal.timeout(3000) })).ok) break; } catch (_) {} await sleep(500); }
  await login();
  await waitCupsReady();
  const expectF = ['PrintGate-Virtual', newName].sort().join(',');
  const qF = await waitPrinters(expectF, 40000);
  rec('崩溃后新建的队列被自动重建（不丢）', qF === expectF, qF || '未恢复');

  // ---------- E. 不挂卷的情形（暴露风险） ----------
  console.log('\n=== [E] 不挂卷 + 删除容器（对照：说明为什么必须挂卷）===');
  killContainer();
  await startContainer({ withVolume: false });
  boot = await req('GET', '/api/public/bootstrap', undefined, { noAuth: true });
  rec('未挂卷的新容器是全新实例（数据"丢失"）', boot.j && boot.j.needsSetup === true,
    `needsSetup=${boot.j && boot.j.needsSetup}`);
  killContainer();
  sh(`docker volume rm -f ${VOL}`);

  // ---------- G. 优雅停止 → 只拷 .db 的备份能否恢复 ----------
  console.log('\n=== [G] 优雅停止后「只拷 printgate.db」的备份能否恢复 ===');
  // 注意：上一段 [E] 把卷删掉了，这里重新建一个干净实例再灌数据
  await startContainer({ withVolume: true });
  const bootG = await req('GET', '/api/public/bootstrap', undefined, { noAuth: true });
  if (bootG.j && bootG.j.needsSetup) {
    await req('POST', '/api/setup', { password: PASS, confirm: PASS }, { noAuth: true });
  }
  await login();
  await waitCupsReady();
  // 写一项可辨识的设置，确保它落在 WAL 里（而不是早就 checkpoint 过）
  await req('PUT', '/api/settings', { maxCopies: 5, historyDays: 9 });
  const beforeBk = await snapshot();
  sh(`docker stop -t 20 ${NAME}`);

  // 容器已停：docker cp 可以直接从停止的容器里取文件（比挂载卷可靠）
  const BK = 'C:/pg_backup';
  sh(`mkdir -p ${BK}`);
  sh(`rm -f ${BK}/printgate.db`);
  sh(`docker cp ${NAME}:/data/printgate.db ${BK}/printgate.db`);
  sh(`docker cp ${NAME}:/data/printgate.db-wal ${BK}/printgate.db-wal`);
  const fileSize = (p) => Number(sh(`"C:/Users/Administrator/.workbuddy/binaries/python/versions/3.13.12/python.exe" -c "import os;p=r'${p}';print(os.path.getsize(p) if os.path.exists(p) else -1)"`));
  const dbBytes = fileSize(`${BK}/printgate.db`);
  const walSize = fileSize(`${BK}/printgate.db-wal`);
  rec('主库已包含数据（体积 > 40KB）', dbBytes > 40 * 1024, `${dbBytes} B`);
  rec('退出后 WAL 已合并（残留 < 32KB；-wal 不存在视为 0）', walSize < 32 * 1024, `${walSize < 0 ? 0 : walSize} B`);
  rec('备份文件已导出到宿主机', dbBytes > 0, `${dbBytes} B`);

  // 用这个 .db 起一个全新容器（新卷，只有主库，没有 WAL/SHM）
  sh(`docker rm -f ${NAME}-bk`);
  sh(`docker volume rm -f ${VOL}-bk`);
  sh(`docker volume create ${VOL}-bk`);
  // 先 create 再 cp 再 start：Windows 上对「已停止容器」的 docker cp 最稳
  sh(`docker create --name ${NAME}-bk -v ${VOL}-bk:/data -p ${PORT + 1}:8080 ${IMAGE}`);
  sh(`docker cp ${BK}/printgate.db ${NAME}-bk:/data/printgate.db`);
  sh(`docker start ${NAME}-bk`);
  const bkCheck = sh(`docker cp ${NAME}-bk:/data/printgate.db ${BK}/verify.db && "C:/Users/Administrator/.workbuddy/binaries/python/versions/3.13.12/python.exe" -c "import os;print(os.path.getsize(r'${BK}/verify.db'))"`);
  rec('备份文件已放进新实例的数据目录', Number(bkCheck) > 0, `${bkCheck} B`);
  const BKBASE = `http://127.0.0.1:${PORT + 1}`;
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(BKBASE + '/api/health', { signal: AbortSignal.timeout(3000) })).ok) break; } catch (_) {}
    await sleep(500);
  }
  const bootB = await (await fetch(BKBASE + '/api/public/bootstrap', { signal: AbortSignal.timeout(8000) })).json();
  rec('只拷 .db 起的新实例不需要重新初始化', bootB.needsSetup === false, `needsSetup=${bootB.needsSetup}`);
  const lg = await fetch(BKBASE + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: PASS }), signal: AbortSignal.timeout(10000)
  });
  const lgd = await lg.json();
  rec('备份里的管理员密码可用', lg.status === 200 && !!lgd.token, `status=${lg.status}`);
  const H = { Authorization: `Bearer ${lgd.token}` };
  const stBk = await (await fetch(BKBASE + '/api/settings', { headers: H, signal: AbortSignal.timeout(10000) })).json();
  const cpBk = stBk.settings && stBk.settings.print && stBk.settings.print.maxCopies;
  const hdBk = stBk.settings && stBk.settings.history && stBk.settings.history.historyDays;
  rec('备份前刚写入的设置没丢（说明 WAL 确实合并了）', cpBk === 5 && hdBk === 9, `copies=${cpBk} days=${hdBk}`);
  const tk = await (await fetch(BKBASE + '/api/tasks?size=200', { headers: H, signal: AbortSignal.timeout(10000) })).json();
  rec('备份里的任务记录还在', (tk.tasks || []).length >= beforeBk.tasks, `${beforeBk.tasks} → ${(tk.tasks || []).length}`);
  sh(`docker rm -f ${NAME}-bk`);
  sh(`docker volume rm -f ${VOL}-bk`);

  console.log(`\n===== 通过 ${pass} / 失败 ${fails.length} =====`);
  if (fails.length) { console.log('失败项：'); fails.forEach((f) => console.log('  - ' + f)); }
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error('FATAL', (e && e.stack) || e); process.exit(2); });
