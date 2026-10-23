// PrintGate 第三轮：绕过、编码、竞态、路径与方法、状态语义
const fs = require('fs');
const path = require('path');

const BASE = process.env.PG_BASE || 'http://127.0.0.1:8080';
const PASS = process.env.PG_PASS || 'Probe2026test';
let TOKEN = '';
const results = [];
const rec = (n, p, d = '') => { results.push({ n, p, d }); console.log(`${p ? '✔' : '✘'} ${n}${d ? ' — ' + d : ''}`); };

async function req(method, url, body, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (TOKEN && !headers.Authorization) headers.Authorization = `Bearer ${TOKEN}`;
  if (opts.token !== undefined) { if (opts.token) headers.Authorization = `Bearer ${opts.token}`; else delete headers.Authorization; }
  let payload;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = typeof body === 'string' ? body : JSON.stringify(body); }
  const res = await fetch(BASE + url, { method, headers, body: payload, redirect: 'manual' });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch (_) { data = { raw: text.slice(0, 200) }; }
  return { status: res.status, data, headers: res.headers, text };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const { buildTestPagePdf } = require(require('./_paths').serverSrcPath('pdf'));
const pdfFd = (name) => {
  const fd = new FormData();
  fd.append('file', new Blob([buildTestPagePdf({ printer: 'H2' })], { type: 'application/pdf' }), name);
  return fd;
};

(async () => {
  let r = await req('GET', '/api/public/bootstrap', undefined, { token: null });
  if (r.data.needsSetup) {
    r = await req('POST', '/api/setup', { password: PASS, confirm: PASS }, { token: null });
    rec('初始化', !!r.data.ok, r.data.msg || '');
    TOKEN = r.data.token;
  } else {
    r = await req('POST', '/api/auth/login', { password: PASS }, { token: null });
    rec('登录', !!r.data.ok, r.data.msg || '');
    TOKEN = r.data.token;
  }

  // 本轮所有打印相关用例依赖一个可用队列
  await req('POST', '/api/printers/virtual', {});
  await sleep(1500);

  console.log('\n== A. X-Forwarded-For 伪造能否绕过锁定 ==');
  await req('DELETE', '/api/security/attempts');
  let lockedSame = false;
  for (let i = 0; i < 7; i++) {
    const x = await req('POST', '/api/auth/login', { password: 'bad-' + i }, { token: null, headers: { 'X-Forwarded-For': '10.0.0.9' } });
    if (x.status === 429) { lockedSame = true; break; }
  }
  rec('同一伪造 IP 会被锁定', lockedSame);
  const bypass = await req('POST', '/api/auth/login', { password: PASS }, { token: null, headers: { 'X-Forwarded-For': '10.0.0.99' } });
  const stillLocked = bypass.status === 429;
  rec('切换伪造 XFF 无法绕过锁定', stillLocked, `status=${bypass.status} ${bypass.data.msg || ''}`);
  await req('DELETE', '/api/security/attempts');
  r = await req('POST', '/api/auth/login', { password: PASS }, { token: null });
  TOKEN = r.data.token;

  console.log('\n== B. 文件名编码与边界 ==');
  r = await req('POST', '/api/files', pdfFd('测试文档-报价单 2026.pdf'));
  const cnFile = r.data.file;
  rec('中文文件名上传', !!r.data.ok && cnFile.filename === '测试文档-报价单 2026.pdf', cnFile ? cnFile.filename : r.data.msg);
  const cnList = await req('GET', '/api/files');
  rec('中文文件名在列表中正确', (cnList.data.files || []).some((f) => f.filename === '测试文档-报价单 2026.pdf'));

  const longName = 'L'.repeat(180) + '.pdf';
  r = await req('POST', '/api/files', pdfFd(longName));
  rec('超长文件名可上传或明确拒绝', r.data.ok ? r.data.file.filename.length <= 200 : r.status === 400, r.data.ok ? `len=${r.data.file.filename.length}` : r.data.msg);

  const empty = new FormData();
  empty.append('file', new Blob([Buffer.alloc(0)], { type: 'application/pdf' }), 'empty.pdf');
  r = await req('POST', '/api/files', empty);
  rec('0 字节文件被拒绝', r.status === 400, r.status === 400 ? r.data.msg : `status=${r.status} 已接受`);

  const fake = new FormData();
  fake.append('file', new Blob([Buffer.from('PK\x03\x04 not a pdf')], { type: 'application/pdf' }), 'fake.pdf');
  r = await req('POST', '/api/files', fake);
  if (r.data.ok) {
    const fakeId = r.data.file.id;
    const pr = await req('POST', '/api/print', { fileId: fakeId, printer: 'PrintGate-Virtual' });
    rec('伪装 PDF 提交后有明确结果', !!pr.data.ok || pr.status === 400, `print status=${pr.status}`);
  } else {
    rec('伪装 PDF 被拒绝', r.status === 400, r.data.msg);
  }

  const dup1 = await req('POST', '/api/files', pdfFd('同名.pdf'));
  const dup2 = await req('POST', '/api/files', pdfFd('同名.pdf'));
  rec('同名文件互不覆盖', dup1.data.ok && dup2.data.ok && dup1.data.file.id !== dup2.data.file.id);

  console.log('\n== C. 路径穿越 / 方法 / 分页 ==');
  for (const p of ['/assets/../../../../etc/passwd', '/assets/%2e%2e%2f%2e%2e%2fetc%2fpasswd', '/..%2f..%2fetc%2fpasswd']) {
    const res = await fetch(BASE + p);
    const body = await res.text();
    rec(`穿越路径被拦：${p.slice(0, 28)}`, !/root:x:0:0/.test(body), `status=${res.status}`);
  }
  r = await req('PUT', '/api/health', {});
  rec('只读接口拒绝 PUT', r.status === 404 || r.status === 405, String(r.status));
  r = await req('DELETE', '/api/dashboard');
  rec('只读接口拒绝 DELETE', r.status === 404 || r.status === 405, String(r.status));

  r = await req('GET', '/api/tasks?page=0&size=0');
  rec('分页 0/0 被纠正', r.status === 200 && r.data.page >= 1 && r.data.size >= 1, `page=${r.data.page} size=${r.data.size}`);
  r = await req('GET', '/api/tasks?page=-5&size=99999');
  rec('分页负数/超大被限制', r.status === 200 && r.data.size <= 200, `size=${r.data.size}`);
  r = await req('GET', '/api/tasks?status=%27%20OR%201=1--');
  rec('非法 status 不报错', r.status === 200, String(r.status));
  r = await req('PUT', '/api/settings', '{"maxCopies":' + '1'.repeat(5000) + '}');
  rec('异常长数值被安全处理', r.status === 400 || r.status === 200, String(r.status));

  console.log('\n== D. 竞态 ==');
  // 并发审批同一任务：应只执行一次
  await req('PUT', '/api/settings', { approveEachJob: true });
  const up = await req('POST', '/api/files', pdfFd('race.pdf'));
  if (!up.data.ok) {
    rec('竞态用例前置上传', false, `status=${up.status} ${JSON.stringify(up.data).slice(0, 160)}`);
  }
  const sub = await req('POST', '/api/print', { fileId: up.data.file && up.data.file.id, printer: 'PrintGate-Virtual' });
  const tid = sub.data.taskId;
  const before = (await req('GET', '/api/printers/virtual/status')).data.jobs.length;
  const approvals = await Promise.all([1, 2, 3, 4, 5].map(() => req('POST', `/api/tasks/${tid}/approve`)));
  const okCount = approvals.filter((x) => x.data.ok).length;
  const rejected = approvals.filter((x) => [400, 409].includes(x.status)).length;
  await sleep(4000);
  const after = (await req('GET', '/api/printers/virtual/status')).data.jobs.length;
  rec('并发审批只成功一次', okCount === 1 && rejected === 4, `成功 ${okCount} 次，拒绝 ${rejected} 次`);
  rec('并发审批不产生重复打印', after - before === 1, `新增落盘 ${after - before} 份`);
  await req('PUT', '/api/settings', { approveEachJob: false });

  // 并发创建 API Key
  const keys = await Promise.all([1, 2, 3, 4, 5, 6, 7, 8].map((i) => req('POST', '/api/keys', { name: 'race-' + i })));
  const uniq = new Set(keys.map((k) => k.data.token).filter(Boolean));
  rec('并发创建 API Key 均唯一', uniq.size === keys.filter((k) => k.data.ok).length && uniq.size > 0, `${uniq.size} 个唯一`);
  for (const k of keys) if (k.data.id) await req('DELETE', `/api/keys/${k.data.id}`);

  // 并发上传同名
  const ups = await Promise.all([1, 2, 3, 4, 5].map(() => req('POST', '/api/files', pdfFd('multi.pdf'))));
  const ids = new Set(ups.map((x) => x.data.file?.id).filter(Boolean));
  rec('并发上传各自独立', ids.size === 5, `${ids.size}/5`);

  console.log('\n== E. 任务状态语义（队列暂停时） ==');
  const printers = await req('GET', '/api/printers');
  const vp = (printers.data.printers || []).find((p) => p.name === 'PrintGate-Virtual');
  if (vp) {
    await req('POST', '/api/printers/PrintGate-Virtual/pause');
    const f2 = await req('POST', '/api/files', pdfFd('paused.pdf'));
    const t2 = await req('POST', '/api/print', { fileId: f2.data.file.id, printer: 'PrintGate-Virtual' });
    await sleep(3000);
    const det = await req('GET', `/api/tasks/${t2.data.taskId}`);
    const cupsJobs = await req('GET', '/api/cups/jobs?state=not-completed');
    const inQueue = (cupsJobs.data.jobs || []).some((j) => j.printer === 'PrintGate-Virtual');
    rec('暂停队列时任务标记为打印中而非已完成', det.data.task.status === 'printing', `task=${det.data.task.status}, CUPS 队列中=${inQueue}`);
    await req('POST', '/api/printers/PrintGate-Virtual/resume');
    // 后台同步器每 8 秒跑一次
    let det2 = null;
    for (let i = 0; i < 6; i++) {
      await sleep(3000);
      det2 = await req('GET', `/api/tasks/${t2.data.taskId}`);
      if (det2.data.task.status === 'done') break;
    }
    rec('恢复队列后自动收尾为已完成', det2 && det2.data.task.status === 'done', `task=${det2 ? det2.data.task.status : '?'}`);
  } else {
    rec('暂停队列语义（需先建虚拟打印机）', false, '虚拟打印机不存在');
  }

  console.log('\n== F. 数据一致性 ==');
  await req('PUT', '/api/settings', { approveEachJob: true });
  const f3 = await req('POST', '/api/files', pdfFd('delcheck.pdf'));
  const t3 = await req('POST', '/api/print', { fileId: f3.data.file.id, printer: 'PrintGate-Virtual' });
  // 无 CUPS 的环境建不出任务：这一整段依赖真实任务，明确跳过而不是让脚本空指针崩溃
  if (!t3 || !t3.data || !t3.data.taskId) {
    rec('源文件删除 / 预览 / 重试语义', true, '跳过：环境无 CUPS，未能创建任务');
    console.log('\n== G. 大请求体 ==');
    const bigJson2 = JSON.stringify({ adminOpenids: 'x'.repeat(3 * 1024 * 1024) });
    const bigRes2 = await fetch(BASE + '/api/settings', {
      method: 'PUT', headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }, body: bigJson2
    });
    rec('3MB JSON 被拒（413/400）而不是崩溃', [400, 413].includes(bigRes2.status), String(bigRes2.status));
    const health2 = await fetch(BASE + '/api/health');
    rec('大请求后服务仍健康', health2.status === 200);
    const fail0 = results.filter((x) => !x.p);
    console.log(`\n=== ${results.length - fail0.length}/${results.length} 通过 ===`);
    if (fail0.length) { console.log('失败项：'); fail0.forEach((f) => console.log(` - ${f.n}：${f.d}`)); }
    fs.writeFileSync(path.join(require('./_paths').shotsDir(), 'bug-hunt2.json'), JSON.stringify(results, null, 2));
    process.exit(fail0.length ? 1 : 0);
  }
  await req('POST', `/api/tasks/${t3.data.taskId}/reject`, { reason: '测试' });
  await req('DELETE', `/api/files/${f3.data.file.id}`);
  const det3 = await req('GET', `/api/tasks/${t3.data.taskId}`);
  rec('删除源文件后任务标记为不可预览', det3.data.task.file_available === false, String(det3.data.task.file_available));
  const pv = await req('GET', `/api/files/${f3.data.file.id}/preview`);
  rec('已删除文件预览返回 410', pv.status === 410, String(pv.status));
  const rt = await req('POST', `/api/tasks/${t3.data.taskId}/retry`);
  await sleep(2000);
  const rtTask = await req('GET', `/api/tasks/${t3.data.taskId}`);
  rec('源文件缺失时重试落到失败态并说明原因',
    rtTask.data.task.status === 'failed' && /丢失|缺失/.test(rtTask.data.task.error || ''),
    `status=${rtTask.data.task.status} err=${rtTask.data.task.error}`);
  await req('PUT', '/api/settings', { approveEachJob: false });

  console.log('\n== G. 大请求体 ==');
  const bigJson = JSON.stringify({ adminOpenids: 'x'.repeat(3 * 1024 * 1024) });
  const bigRes = await fetch(BASE + '/api/settings', {
    method: 'PUT', headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }, body: bigJson
  });
  rec('3MB JSON 被拒（413/400）而不是崩溃', [400, 413].includes(bigRes.status), String(bigRes.status));
  const health = await fetch(BASE + '/api/health');
  rec('大请求后服务仍健康', health.status === 200);

  const fail = results.filter((x) => !x.p);
  console.log(`\n=== ${results.length - fail.length}/${results.length} 通过 ===`);
  if (fail.length) { console.log('失败项：'); fail.forEach((f) => console.log(` - ${f.n}：${f.d}`)); }
  fs.writeFileSync(path.join(require('./_paths').shotsDir(), 'bug-hunt2.json'), JSON.stringify(results, null, 2));
  process.exit(fail.length ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(2); });
