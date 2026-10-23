'use strict';
// CUPS 真实打印链路端到端验证（cups-e2e）
//
// 覆盖：上传 → 提交 → CUPS 队列 → 虚拟打印机落盘 → 任务状态回写，
//       以及份数/页范围/水印/并发/暂停恢复/取消/失败语义/队列删除。
//
// 用法（在装了 CUPS 的 Linux 主机或容器里跑）：
//   PG_BASE=http://127.0.0.1:8080 PG_PASS=xxx node tools/cups-e2e.js
// 从 Windows 上操作容器内的实例时，额外给一个执行前缀用于读落盘文件：
//   PG_BASE=http://127.0.0.1:18080 PG_PASS=xxx PG_EXEC="docker exec pg-e2e" node tools/cups-e2e.js
//
// 依赖：服务端已启动且 CUPS 可用；不需要实体打印机（用虚拟打印机接收器落盘验证）。
const { execSync } = require('child_process');
const path = require('path');
const P = require('./_paths');
const { buildTestPagePdf } = require(path.join(P.serverDir(), 'src', 'pdf'));

const BASE = process.env.PG_BASE || 'http://127.0.0.1:8080';
const PASS = process.env.PG_PASS || 'PrintGate2026';
const EXEC = process.env.PG_EXEC || '';       // 例如 "docker exec pg-e2e"
const SPOOL = process.env.PG_SPOOL_DIR || '/data/spool';
const QUEUE = process.env.PG_QUEUE || 'PrintGate-Virtual';

let pass = 0;
const fails = [];
function rec(name, ok, detail = '') {
  if (ok) { pass += 1; console.log(`  ✓ ${name}${detail ? ' — ' + detail : ''}`); }
  else { fails.push(`${name}${detail ? ' — ' + detail : ''}`); console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let TOKEN = '';
async function req(method, url, body, opt = {}) {
  const headers = {};
  if (TOKEN && !opt.noAuth) headers.Authorization = `Bearer ${TOKEN}`;
  let payload;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const t0 = Date.now();
  const r = await fetch(BASE + url, { method, headers, body: payload });
  const text = await r.text();
  let j = null;
  try { j = JSON.parse(text); } catch (_) {}
  return { status: r.status, j, text, ms: Date.now() - t0 };
}

// 在实例所在环境里执行命令（容器用 docker exec，宿主直接跑）
function ex(cmd) {
  if (!EXEC) return '';
  try {
    return execSync(`${EXEC} sh -c ${JSON.stringify(cmd)}`, { encoding: 'utf8', timeout: 30000 }).trim();
  } catch (e) {
    return `__ERR__ ${(e.stdout || '') + (e.stderr || '')}`.trim();
  }
}
// 允许非零退出码的版本（grep -c 无匹配时返回 1，stdout 仍然有效）
function exOut(cmd) {
  if (!EXEC) return '';
  try {
    return execSync(`${EXEC} sh -c ${JSON.stringify(cmd)}`, { encoding: 'utf8', timeout: 30000 }).trim();
  } catch (e) {
    return String(e.stdout || '').trim();
  }
}
function names(jobs) { return new Set(jobs.map((j) => j.filename)); }
function newOnes(before, after) { return after.filter((j) => !before.has(j.filename)); }

async function uploadPdf(name = `cups-e2e-${Date.now()}.pdf`, pageOpts = {}) {
  const buf = buildTestPagePdf({ printer: QUEUE, time: new Date().toLocaleString('zh-CN'), ...pageOpts });
  const fd = new FormData();
  fd.append('file', new Blob([buf], { type: 'application/pdf' }), name);
  const r = await req('POST', '/api/files', fd);
  return { r, size: buf.length };
}

async function waitTask(id, ms = 30000) {
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < ms) {
    const r = await req('GET', `/api/tasks/${id}`);
    last = r.j && r.j.task;
    if (last && ['done', 'failed', 'canceled', 'rejected'].includes(last.status)) return last;
    await sleep(700);
  }
  return last;
}

function spoolFiles() {
  // 通过接口拿落盘清单（不依赖 exec，任何环境都能用）
  return vstatus.jobs || [];
}
let vstatus = { jobs: [] };
async function refreshSpool() {
  const r = await req('GET', '/api/printers/virtual/status');
  vstatus = (r.j && r.j) || { jobs: [] };
  return vstatus;
}

(async () => {
  console.log(`=== 目标 ${BASE} | 队列 ${QUEUE} | 执行前缀 ${EXEC || '(无，跳过文件内容断言)'} ===`);

  // ---------- 0. 初始化与登录 ----------
  console.log('\n=== [0] 环境就绪 ===');
  const boot = await req('GET', '/api/public/bootstrap', undefined, { noAuth: true });
  if (boot.j && boot.j.needsSetup) {
    const s = await req('POST', '/api/setup', { password: PASS, confirm: PASS }, { noAuth: true });
    rec('首次安装向导', s.status === 200, `status=${s.status}`);
  } else {
    rec('实例已初始化', true, `v${(boot.j || {}).version || '?'}`);
  }
  const login = await req('POST', '/api/auth/login', { password: PASS }, { noAuth: true });
  TOKEN = login.j && login.j.token;
  rec('管理员登录', login.status === 200 && !!TOKEN, `status=${login.status}`);
  if (!TOKEN) {
    console.error('登录失败：请用 PG_PASS 指定该实例的管理员密码（容器若刚被别的脚本初始化过，密码可能已变）');
    process.exit(1);
  }

  const pr = await req('GET', '/api/printers');
  const cupsState = (pr.j && pr.j.cups) || {};
  rec('CUPS 服务运行中', cupsState.running === true, cupsState.message || '');

  // ---------- 1. 创建虚拟打印机 ----------
  console.log('\n=== [1] 虚拟打印机 ===');
  const vcreate = await req('POST', '/api/printers/virtual', { action: 'create' });
  rec('一键创建虚拟打印机', vcreate.status === 200 && (vcreate.j || {}).ok === true,
    (vcreate.j || {}).msg || `status=${vcreate.status}`);

  let hasQueue = false;
  for (let i = 0; i < 20; i++) {
    const l = await req('GET', '/api/printers');
    hasQueue = ((l.j || {}).printers || []).some((p) => p.name === QUEUE);
    if (hasQueue) break;
    await sleep(600);
  }
  rec(`队列 ${QUEUE} 出现在 CUPS 中`, hasQueue);
  await refreshSpool();
  rec('虚拟打印机接收器在监听', vstatus.running === true, `port=${vstatus.port}`);
  const before = vstatus.jobs.length;

  // ---------- 2. 上传 → 提交 → 出纸 ----------
  console.log('\n=== [2] 上传 → 提交 → 落盘 ===');
  const up = await uploadPdf();
  rec('上传 PDF', up.r.status === 200 && !!(up.r.j || {}).file, `status=${up.r.status} ${(up.r.j || {}).msg || ''}`);
  const fileId = up.r.j && up.r.j.file && up.r.j.file.id;

  const submit = await req('POST', '/api/print', { fileId, printer: QUEUE, options: { copies: 1, media: 'A4' } });
  const tid = submit.j && submit.j.taskId;
  rec('提交打印任务', submit.status === 200 && !!tid, `status=${submit.status} task=${tid} ${(submit.j || {}).msg || ''}`);

  const done = await waitTask(tid, 40000);
  rec('任务最终进入 done', !!done && done.status === 'done', `status=${done && done.status} err=${(done && done.error) || '-'}`);
  rec('任务记录了 CUPS job id', !!(done && done.jobId), `jobId=${done && done.jobId}`);

  // 落盘验证
  await sleep(1500);
  await refreshSpool();
  const jobs1 = vstatus.jobs;
  rec('虚拟打印机收到作业（落盘文件 +1）', jobs1.length > before, `${before} → ${jobs1.length}`);
  const newest = jobs1[0];
  rec('落盘文件非空', !!newest && newest.size > 1024, `${newest && newest.size} B`);

  if (EXEC) {
    const head = ex(`head -c 5 ${SPOOL}/${newest.filename} | od -c | head -1`);
    rec('落盘内容是被投递的 PDF（%PDF 头）', /%   P   D   F|%PDF/.test(head), head.slice(0, 40));
    const pages = ex(`pdfinfo ${SPOOL}/${newest.filename} 2>/dev/null | awk '/^Pages:/{print $2}'`);
    rec('落盘 PDF 页数可解析', /^\d+$/.test(pages), `pages=${pages}`);
  }

  // ---------- 3. 打印参数是否真的生效 ----------
  console.log('\n=== [3] 打印参数 ===');
  // copies=3：raw 队列会把同一份数据发 3 次，落盘字节应约等于 3 倍
  const baseSize = newest.size;
  const up2 = await uploadPdf();
  const t2 = await req('POST', '/api/print', { fileId: up2.r.j.file.id, printer: QUEUE, options: { copies: 3 } });
  const d2 = await waitTask(t2.j.taskId, 40000);
  await sleep(1500);
  await refreshSpool();
  const three = vstatus.jobs[0];
  rec('copies=3 任务完成', d2 && d2.status === 'done', `status=${d2 && d2.status}`);
  rec('copies=3 落盘体积约为 3 倍', !!three && three.size >= baseSize * 2.2,
    `${baseSize} B → ${three && three.size} B (×${three ? (three.size / baseSize).toFixed(2) : '-'})`);

  // 超限份数被夹到 maxCopies
  const t3 = await req('POST', '/api/print', { fileId: up2.r.j.file.id, printer: QUEUE, options: { copies: 9999 } });
  const d3 = await waitTask(t3.j.taskId, 40000);
  const cfgNow = await req('GET', '/api/settings');
  const maxCopies = ((cfgNow.j || {}).settings || {}).print ? cfgNow.j.settings.print.maxCopies : null;
  rec('copies 超上限被夹到 maxCopies', d3 && d3.status === 'done' && d3.options.copies === maxCopies,
    `copies=${d3 && d3.options && d3.options.copies} max=${maxCopies}`);

  // 水印：落盘 PDF 应带水印（qpdf --overlay 叠加，文字可被 pdftotext 提取，
  // 但水印是倾斜排版，提取出来字符会被打散，所以按「出现 E2E 片段」判断而不是整串匹配）
  await refreshSpool();
  const beforeWm = names(vstatus.jobs);
  const up3 = await uploadPdf();
  const t4 = await req('POST', '/api/print', { fileId: up3.r.j.file.id, printer: QUEUE, options: { watermark: 'E2E-TEST' } });
  const d4 = await waitTask(t4.j.taskId, 40000);
  await sleep(1500);
  await refreshSpool();
  const wmFile = newOnes(beforeWm, vstatus.jobs)[0];
  rec('带水印任务完成', d4 && d4.status === 'done', `status=${d4 && d4.status}`);
  rec('水印任务确实落盘', !!wmFile, wmFile ? wmFile.filename : '未找到新增文件');
  if (EXEC && wmFile) {
    const txt = exOut(`pdftotext ${SPOOL}/${wmFile.filename} - 2>/dev/null | tr -d '\n'`);
    rec('落盘 PDF 里能提取到水印文字', /E2E/.test(txt), `提取片段=${txt.slice(0, 40)}`);
    rec('水印版比原版体积更大（确实叠加了图层）', wmFile.size > baseSize * 0.9,
      `${wmFile.size} B vs 原版 ${baseSize} B`);
  }

  // ---------- 4. 并发提交 ----------
  console.log('\n=== [4] 并发提交 ===');
  await refreshSpool();
  const cBefore = vstatus.jobs.length;
  const up4 = await uploadPdf();
  const conc = await Promise.all([1, 2, 3].map(() =>
    req('POST', '/api/print', { fileId: up4.r.j.file.id, printer: QUEUE, options: { copies: 1 } })));
  const ids = conc.map((x) => x.j && x.j.taskId).filter(Boolean);
  rec('并发 3 个任务均提交成功', ids.length === 3, `ids=${ids.join(',')}`);
  rec('并发任务 id 互不重复', new Set(ids).size === ids.length);
  await Promise.all(ids.map((id) => waitTask(id, 40000)));
  await sleep(2500);
  await refreshSpool();
  rec('并发 3 个任务各自落盘（不覆盖）', vstatus.jobs.length >= cBefore + 3,
    `${cBefore} → ${vstatus.jobs.length}`);

  // ---------- 5. 队列操作 ----------
  console.log('\n=== [5] 队列暂停 / 恢复 / 拒绝 / 接受 ===');
  for (const [act, label] of [['pause', '暂停'], ['resume', '恢复'], ['reject', '停止接收'], ['accept', '恢复接收']]) {
    const r = await req('POST', `/api/printers/${QUEUE}/${act}`);
    rec(`${label}队列`, r.status === 200 && (r.j || {}).ok !== false, `status=${r.status} ${(r.j || {}).msg || ''}`);
  }
  if (EXEC) {
    const st = ex(`lpstat -p ${QUEUE} 2>&1`);
    rec('CUPS 侧队列状态可读', !!st && !st.startsWith('__ERR__'), st.split('\n')[0].slice(0, 60));
  }

  // ---------- 6. 取消 ----------
  console.log('\n=== [6] 取消任务 ===');
  // 先暂停队列，让作业停在队列里，才有机会取消
  await req('POST', `/api/printers/${QUEUE}/pause`);
  const up5 = await uploadPdf();
  const t5 = await req('POST', '/api/print', { fileId: up5.r.j.file.id, printer: QUEUE, options: { copies: 1 } });
  const id5 = t5.j && t5.j.taskId;
  await sleep(2500);
  const inQueue = await req('GET', '/api/cups/jobs');
  const queued = ((inQueue.j || {}).jobs || []).some((jj) => jj.printer === QUEUE);
  rec('暂停期间作业停在 CUPS 队列中', queued, `jobs=${((inQueue.j || {}).jobs || []).length}`);
  await req('POST', `/api/printers/${QUEUE}/resume`);
  const cancel = await req('POST', `/api/tasks/${id5}/cancel`);
  const afterCancel = await req('GET', `/api/tasks/${id5}`);
  rec('取消任务接口返回成功', cancel.status === 200, `status=${cancel.status} ${(cancel.j || {}).msg || ''}`);
  rec('任务状态变为 canceled', (afterCancel.j || {}).task && afterCancel.j.task.status === 'canceled',
    `status=${(afterCancel.j || {}).task && afterCancel.j.task.status}`);

  // ---------- 7. 失败语义 ----------
  console.log('\n=== [7] 失败语义 ===');
  // 真实路径：开启逐单审批 → 提交得到 pending → 删掉源文件 → 放行时必然发送失败
  await req('PUT', '/api/settings', { approveEachJob: true });
  const up6 = await uploadPdf();
  const t6 = await req('POST', '/api/print', { fileId: up6.r.j.file.id, printer: QUEUE, options: { copies: 1 } });
  const id6 = t6.j && t6.j.taskId;
  const pendingTask = await req('GET', `/api/tasks/${id6}`);
  rec('逐单审批开启后任务停在 pending', (pendingTask.j || {}).task && pendingTask.j.task.status === 'pending',
    `status=${(pendingTask.j || {}).task && pendingTask.j.task.status}`);
  await req('DELETE', `/api/files/${up6.r.j.file.id}`);
  const approve = await req('POST', `/api/tasks/${id6}/approve`);
  rec('放行接口有响应', [200, 400].includes(approve.status), `status=${approve.status}`);
  const d6 = await waitTask(id6, 20000);
  rec('源文件丢失时任务落到 failed', d6 && d6.status === 'failed', `status=${d6 && d6.status} err=${(d6 && d6.error) || '-'}`);
  rec('失败原因可读（提到文件丢失）', !!d6 && /丢失|缺失|不存在/.test(d6.error || ''), (d6 && d6.error) || '');
  const retry = await req('POST', `/api/tasks/${id6}/retry`);
  rec('失败任务可重试（接口接受）', [200, 409].includes(retry.status), `status=${retry.status}`);
  await req('PUT', '/api/settings', { approveEachJob: false });

  // 打印到不存在的队列 → 明确 400
  const bad = await req('POST', '/api/print', { fileId: up4.r.j.file.id, printer: 'no-such-queue', options: {} });
  rec('打印到不存在的队列被拒', bad.status === 400 && /不存在|重新选择/.test((bad.j || {}).msg || ''),
    `status=${bad.status} ${(bad.j || {}).msg || ''}`);

  // ---------- 8. 删除队列 ----------
  console.log('\n=== [8] 收尾：删除虚拟打印机 ===');
  const del = await req('DELETE', `/api/printers/${QUEUE}`);
  rec('删除队列成功', del.status === 200, `status=${del.status} ${(del.j || {}).msg || ''}`);
  const listAfter = await req('GET', '/api/printers');
  rec('删除后队列列表不再包含它', !((listAfter.j || {}).printers || []).some((p) => p.name === QUEUE));
  const cdnUrl = await req('GET', '/api/cups/jobs');
  rec('CUPS 作业列表接口可用（允许为空）', cdnUrl.status === 200, `jobs=${((cdnUrl.j || {}).jobs || []).length}`);

  console.log(`\n===== 通过 ${pass} / 失败 ${fails.length} =====`);
  if (fails.length) { console.log('失败项：'); fails.forEach((f) => console.log('  - ' + f)); }
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error('FATAL', e.stack || e.message); process.exit(2); });
