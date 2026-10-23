'use strict';
// 历史清理回归：统计、手动清理、保护进行中任务、参数校验、自动清理
// 用法：PG_BASE=http://127.0.0.1:8080 PG_PASS=xxx node tools/cleanup-test.js
const fs = require('fs');

const BASE = process.env.PG_BASE || 'http://127.0.0.1:8080';
const PASS = process.env.PG_PASS || 'Cleanup2026test';
const AUTO_WAIT = Number(process.env.PG_AUTO_WAIT || 0); // >0 时验证定时清理

let TOKEN = '';
const results = [];
const rec = (name, pass, detail = '') => {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  —  ${detail}` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function req(method, url, body, token = TOKEN) {
  const opt = { method, headers: {} };
  if (token) opt.headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) {
    opt.headers['Content-Type'] = 'application/json';
    opt.body = JSON.stringify(body);
  }
  const r = await fetch(`${BASE}${url}`, opt);
  const text = await r.text();
  let data;
  try { data = JSON.parse(text); } catch (_) { data = { raw: text.slice(0, 200) }; }
  return { status: r.status, data };
}

function pdfBytes() {
  return Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 595 842]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n');
}

async function upload(name) {
  const fd = new FormData();
  fd.append('file', new Blob([pdfBytes()], { type: 'application/pdf' }), name);
  const r = await fetch(`${BASE}/api/files`, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}` }, body: fd });
  return { status: r.status, data: await r.json().catch(() => ({})) };
}

(async () => {
  let r = await req('GET', '/api/public/bootstrap', undefined, '');
  if (r.data.needsSetup) {
    r = await req('POST', '/api/setup', { password: PASS, confirm: PASS }, '');
    TOKEN = r.data.token;
  } else {
    r = await req('POST', '/api/auth/login', { password: PASS }, '');
    TOKEN = r.data.token;
  }
  rec('管理员登录', !!TOKEN, r.data.msg || '');
  if (!TOKEN) process.exit(1);

  // 准备：确保有虚拟打印机与已完成任务
  r = await req('POST', '/api/printers/virtual', {});
  rec('虚拟打印机就绪', r.status === 200, r.data.msg || '');
  await sleep(1200);

  const up1 = await upload('历史清理测试-1.pdf');
  rec('上传测试文件', up1.status === 200 && !!up1.data.file?.id, up1.data.file?.filename || '');
  const t1 = await req('POST', '/api/print', { fileId: up1.data.file.id, printer: 'PrintGate-Virtual' });
  rec('提交打印', t1.status === 200, t1.data.msg || '');
  // 等状态同步器把 printing 收尾为 done（每 8 秒）
  for (let i = 0; i < 12; i++) {
    await sleep(1500);
    const d = await req('GET', `/api/tasks/${t1.data.taskId}`);
    if (d.data.task?.status === 'done') break;
  }

  console.log('\n== A. 统计 ==');
  r = await req('GET', '/api/printers/history');
  const s1 = r.data.stats;
  rec('统计接口可用', r.status === 200 && !!s1, `任务 ${s1?.tasks?.total} 条 / 完成 ${s1?.tasks?.finished}`);
  rec('统计含 CUPS 已完成作业', s1.cups.completed >= 1, `${s1.cups.completed} 个`);
  rec('统计含落盘文件', s1.spool.count >= 1, `${s1.spool.count} 个 / ${s1.spool.bytes} B`);
  rec('统计含源文件与扫描件', s1.files.count >= 1 && s1.scans.count >= 0,
    `文件 ${s1.files.count} / 扫描 ${s1.scans.count}`);

  console.log('\n== B. 保护进行中任务 ==');
  await req('PUT', '/api/settings', { approveEachJob: true });
  const up2 = await upload('待审批-不要删.pdf');
  const t2 = await req('POST', '/api/print', { fileId: up2.data.file.id, printer: 'PrintGate-Virtual' });
  rec('创建待审批任务', t2.status === 200 && !!t2.data.taskId, t2.data.msg || '');

  r = await req('POST', '/api/printers/history/clean', { days: 0, targets: ['tasks', 'cups', 'spool', 'files', 'scans'] });
  rec('全部历史清理成功', r.status === 200 && r.data.ok, r.data.msg || '');
  rec('清理结果含任务数', typeof r.data.result?.tasks?.removed === 'number', `移除 ${r.data.result?.tasks?.removed} 条`);

  const d2 = await req('GET', `/api/tasks/${t2.data.taskId}`);
  rec('待审批任务未被删除', d2.status === 200 && d2.data.task?.status === 'pending', d2.data.task?.status || `HTTP ${d2.status}`);
  const pv2 = await req('GET', `/api/files/${up2.data.file.id}/preview`);
  rec('待审批任务的源文件仍可预览', pv2.status === 200, String(pv2.status));
  const d1 = await req('GET', `/api/tasks/${t1.data.taskId}`);
  rec('已完成任务已清理', d1.status === 404, String(d1.status));

  r = await req('GET', '/api/printers/history');
  rec('CUPS 已完成作业已清空', r.data.stats.cups.completed === 0, `${r.data.stats.cups.completed} 个`);
  rec('落盘文件已清空', r.data.stats.spool.count === 0, `${r.data.stats.spool.count} 个`);
  rec('保留中的任务计入 active', r.data.stats.tasks.active === 1, `${r.data.stats.tasks.active} 条`);
  rec('清理后仍有审计记录', !!r.data.stats.lastCleanup, r.data.stats.lastCleanup?.detail || '');

  // 复原：批准并结束该任务，避免影响后续用例
  await req('POST', `/api/tasks/${t2.data.taskId}/approve`);
  await sleep(4000);

  console.log('\n== C. 参数校验 ==');
  r = await req('POST', '/api/printers/history/clean', { days: -1 });
  rec('负数天数被拒', r.status === 400, r.data.msg || '');
  r = await req('POST', '/api/printers/history/clean', { days: 1, targets: ['nope'] });
  rec('未知清理项被拒', r.status === 400, r.data.msg || '');
  r = await req('POST', '/api/printers/history/clean', { days: 3, targets: ['tasks'] });
  rec('只清任务时不误删文件', r.status === 200, r.data.msg || '');

  console.log('\n== C2. 范围隔离 / 幂等 / 并发 ==');
  // 关掉逐单审批，让任务直接完成，才能验证「清任务但保留 CUPS 历史」等隔离行为
  await req('PUT', '/api/settings', { approveEachJob: false });
  const tmpIds = [];
  for (let i = 0; i < 3; i++) {
    const up = await upload(`隔离测试-${i}.pdf`);
    const t = await req('POST', '/api/print', { fileId: up.data.file.id, printer: 'PrintGate-Virtual' });
    if (t.data.taskId) tmpIds.push(t.data.taskId);
  }
  for (let i = 0; i < 14; i++) {
    await sleep(1500);
    const d = await req('GET', `/api/tasks/${tmpIds[0]}`);
    if (d.data.task?.status === 'done') break;
  }
  const beforeCups = (await req('GET', '/api/printers/history')).data.stats.cups.completed;
  rec('准备：任务完成且 CUPS 有历史', beforeCups >= 1, `CUPS ${beforeCups} 个`);

  r = await req('POST', '/api/printers/history/clean', { days: 0, targets: ['tasks'] });
  const afterTasks = await req('GET', '/api/printers/history');
  rec('只清任务：任务记录减少', (r.data.result?.tasks?.removed || 0) >= 1, r.data.msg || '');
  rec('只清任务：CUPS 历史保留', afterTasks.data.stats.cups.completed >= 1, `${afterTasks.data.stats.cups.completed} 个`);

  r = await req('POST', '/api/printers/history/clean', { days: 0, targets: ['cups'] });
  const afterCups = await req('GET', '/api/printers/history');
  rec('只清 CUPS：作业清空', (r.data.result?.cups?.removed || 0) >= 1 && afterCups.data.stats.cups.completed === 0,
    `${r.data.result?.cups?.removed} 个 → ${afterCups.data.stats.cups.completed}`);

  const again = await req('POST', '/api/printers/history/clean', { days: 0, targets: ['tasks', 'cups'] });
  rec('重复清理幂等（返回 0 条）',
    again.status === 200 && (again.data.result.tasks?.removed || 0) === 0 && (again.data.result.cups?.removed || 0) === 0,
    again.data.msg || '');

  const upC = await upload('并发测试.pdf');
  await req('POST', '/api/print', { fileId: upC.data.file.id, printer: 'PrintGate-Virtual' });
  for (let i = 0; i < 12; i++) {
    await sleep(1200);
    const d = await req('GET', '/api/tasks?status=all&size=8');
    const t = (d.data.tasks || []).find((x) => x.filename === '并发测试.pdf');
    if (t && t.status === 'done') break;
  }
  const trio = await Promise.all([
    req('POST', '/api/printers/history/clean', { days: 0, targets: ['tasks', 'cups', 'spool'] }),
    req('POST', '/api/printers/history/clean', { days: 0, targets: ['tasks', 'cups', 'spool'] }),
    req('POST', '/api/printers/history/clean', { days: 0, targets: ['tasks', 'cups', 'spool'] })
  ]);
  rec('并发清理不报错', trio.every((x) => x.status === 200), trio.map((x) => x.status).join('/'));
  const sum = trio.reduce((a, x) => a + (x.data.result?.tasks?.removed || 0), 0);
  rec('并发清理不重复计数', sum >= 1 && sum <= 3, `合计移除 ${sum} 条（实际 1 条）`);

  console.log('\n== C3. CUPS 历史尊重保留天数 ==');
  const upD = await upload('保留天数测试.pdf');
  const tD = await req('POST', '/api/print', { fileId: upD.data.file.id, printer: 'PrintGate-Virtual' });
  for (let i = 0; i < 12; i++) {
    await sleep(1200);
    const d = await req('GET', `/api/tasks/${tD.data.taskId}`);
    if (d.data.task?.status === 'done') break;
  }
  const cupsBefore = (await req('GET', '/api/printers/history')).data.stats.cups.completed;
  r = await req('POST', '/api/printers/history/clean', { days: 1, targets: ['cups'] });
  const cupsAfter1 = (await req('GET', '/api/printers/history')).data.stats.cups.completed;
  rec('保留 1 天时不动新作业', (r.data.result?.cups?.removed || 0) === 0 && cupsAfter1 === cupsBefore,
    `${cupsBefore} → ${cupsAfter1}（removed ${r.data.result?.cups?.removed}）`);

  r = await req('POST', '/api/printers/history/clean', { days: 0, targets: ['cups'] });
  const cupsAfter0 = (await req('GET', '/api/printers/history')).data.stats.cups.completed;
  rec('清理全部历史时才清空 CUPS', (r.data.result?.cups?.removed || 0) >= 1 && cupsAfter0 === 0,
    `removed ${r.data.result?.cups?.removed} → ${cupsAfter0}`);

  console.log('\n== D. 自动清理设置 ==');
  r = await req('PUT', '/api/printers/history/auto', { autoCleanHistory: true, historyDays: 7 });
  rec('保存自动清理设置', r.status === 200 && r.data.settings.historyDays === 7,
    `auto=${r.data.settings?.autoCleanHistory} days=${r.data.settings?.historyDays}`);
  r = await req('GET', '/api/printers/history');
  rec('设置可回读', r.data.settings.historyDays === 7 && r.data.settings.autoCleanHistory === true);
  r = await req('PUT', '/api/printers/history/auto', { historyDays: 99999 });
  rec('越界天数被拒', r.status === 400, r.data.msg || '');
  r = await req('PUT', '/api/printers/history/auto', {});
  rec('空设置被拒', r.status === 400, r.data.msg || '');
  r = await req('PUT', '/api/settings', { historyDays: 0, autoCleanHistory: false });
  rec('设置页也能改（historyDays=0）', r.status === 200 && r.data.settings.history.historyDays === 0,
    `historyDays=${r.data.settings?.history?.historyDays}`);

  if (AUTO_WAIT > 0) {
    console.log('\n== E. 定时自动清理 ==');
    // 先关掉逐单审批，让任务能直接完成（自动清理只处理已结束任务）
    await req('PUT', '/api/settings', { approveEachJob: false });
    await req('PUT', '/api/printers/history/auto', { autoCleanHistory: false, historyDays: 0 });
    const up3 = await upload('自动清理-禁用时保留.pdf');
    const t3 = await req('POST', '/api/print', { fileId: up3.data.file.id, printer: 'PrintGate-Virtual' });
    let d = null;
    for (let i = 0; i < 12; i++) {
      await sleep(1500);
      d = await req('GET', `/api/tasks/${t3.data.taskId}`);
      if (d.data.task?.status === 'done') break;
    }
    rec('用例任务已完成', d.data.task?.status === 'done', d.data.task?.status || '');
    await sleep(Math.min(8000, AUTO_WAIT * 2));
    d = await req('GET', `/api/tasks/${t3.data.taskId}`);
    rec('关闭自动清理时任务保留', d.status === 200, d.data.task?.status || `HTTP ${d.status}`);

    await req('PUT', '/api/printers/history/auto', { autoCleanHistory: true, historyDays: 0 });
    let gone = false;
    for (let i = 0; i < Math.ceil(AUTO_WAIT / 2); i++) {
      await sleep(2000);
      d = await req('GET', `/api/tasks/${t3.data.taskId}`);
      if (d.status === 404) { gone = true; break; }
    }
    rec('开启后由定时任务自动清理', gone, gone ? '任务已被自动删除' : `仍在（${d.data.task?.status || d.status}）`);
    // 审计在整轮清理结束时写入（CUPS 逐条 purge 有耗时），这里轮询等它落库
    let hasAuto = false;
    for (let i = 0; i < 6; i++) {
      const audit = await req('GET', '/api/audit?size=50');
      hasAuto = (audit.data.logs || []).some((l) => l.action === 'auto_cleanup');
      if (hasAuto) break;
      await sleep(1000);
    }
    rec('自动清理写入审计', hasAuto);
  }

  const fails = results.filter((x) => !x.pass);
  console.log(`\n总计 ${results.length} 项，失败 ${fails.length} 项`);
  if (fails.length) fails.forEach((f) => console.log(' -', f.name, f.detail));
  fs.writeFileSync(require('./_paths').shot('cleanup-test.json'), JSON.stringify(results, null, 2));
  process.exit(fails.length ? 1 : 0);
})();
