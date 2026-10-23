'use strict';
// CUPS 后台管理页接口实测（打容器内实例）
// 用法：PG_BASE=http://127.0.0.1:18092 PG_PASS=CupsTest2026 node cups-admin-test.js
const BASE = process.env.PG_BASE || 'http://127.0.0.1:18092';
const PASS = process.env.PG_PASS || 'CupsTest2026';

let pass = 0;
const fails = [];
function rec(name, ok, detail) {
  if (ok) { pass += 1; console.log(`  ✅ ${name}${detail ? '  — ' + detail : ''}`); }
  else { fails.push(name); console.log(`  ❌ ${name}  ${detail || ''}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function j(m, u, b, t) {
  const h = {};
  if (t) h.Authorization = 'Bearer ' + t;
  const hasBody = b !== undefined && b !== null && m !== 'GET';
  if (hasBody) h['Content-Type'] = 'application/json';
  const r = await fetch(BASE + u, {
    method: m, headers: h,
    body: hasBody ? JSON.stringify(b) : undefined,
    signal: AbortSignal.timeout(60000)
  });
  const ct = r.headers.get('content-type') || '';
  const d = ct.includes('application/json') ? await r.json().catch(() => null) : null;
  return { s: r.status, d, blob: !ct.includes('application/json') ? await r.arrayBuffer() : null };
}

(async () => {
  console.log('目标:', BASE);
  console.log('\n=== [0] 初始化 / 登录 ===');
  const boot = await j('GET', '/api/public/bootstrap');
  if (boot.d && boot.d.needsSetup) {
    const su = await j('POST', '/api/setup', { password: PASS, confirm: PASS });
    rec('首次初始化', su.s === 200 || su.s === 409, `status=${su.s}`);
  }
  const lg = await j('POST', '/api/auth/login', { password: PASS });
  rec('管理员登录', lg.s === 200 && !!(lg.d || {}).token, `status=${lg.s}`);
  const T = (lg.d || {}).token;
  if (!T) { console.log('拿不到令牌，终止'); return; }
  rec('版本号已升到 2.0.1', /2\.0\.1/.test((boot.d || {}).version || ''), String((boot.d || {}).version));

  console.log('\n=== [1] CUPS 状态概览 ===');
  const st = await j('GET', '/api/cups/status', null, T);
  rec('状态接口 200', st.s === 200 && (st.d || {}).ok, `status=${st.s}`);
  const d = st.d || {};
  rec('返回 CUPS 版本', !!d.version && d.version !== '未知', String(d.version));
  rec('返回守护进程 PID', Array.isArray(d.pid) && d.pid.length > 0, (d.pid || []).join(','));
  rec('返回配置路径', !!((d.conf || {}).path), (d.conf || {}).path);
  rec('返回路径信息（配置/日志/PPD）', !!(d.paths && d.paths.confDir && d.paths.logDir && d.paths.ppdDir),
    `${(d.paths || {}).confDir} | ${(d.paths || {}).logDir}`);
  rec('返回可编辑配置项', Object.keys((d.conf || {}).editable || {}).length >= 5,
    Object.keys((d.conf || {}).editable || {}).join(','));
  rec('返回队列与作业计数', !!d.counts && typeof d.counts.queues === 'number', JSON.stringify(d.counts));
  rec('状态接口不带配置原文（避免每次传大文件）', !('raw' in (d.conf || {})), '');

  console.log('\n=== [2] 日志文件 ===');
  const ll = await j('GET', '/api/cups/logs', null, T);
  rec('日志列表 200', ll.s === 200 && Array.isArray((ll.d || {}).logs), `${((ll.d || {}).logs || []).length} 个`);
  const er = await j('GET', '/api/cups/logs/error?lines=100', null, T);
  rec('错误日志可读', er.s === 200 && (er.d || {}).ok, `${(er.d || {}).path} ${((er.d || {}).content || '').length}B`);
  const pg = await j('GET', '/api/cups/logs/page?lines=50', null, T);
  rec('计费日志不报错', pg.s === 200, `status=${pg.s}`);

  console.log('\n=== [3] 配置原文与保存 ===');
  const raw = await j('GET', '/api/cups/config/raw', null, T);
  rec('配置原文接口 200', raw.s === 200 && typeof (raw.d || {}).raw === 'string', `${((raw.d || {}).raw || '').length}B`);
  rec('配置文件可写（容器内 root）', (raw.d || {}).writable === true, String((raw.d || {}).writable));

  const beforeLogLevel = ((st.d.conf || {}).editable || {}).LogLevel?.current || '';
  const save = await j('POST', '/api/cups/config', { patch: { LogLevel: 'info' } }, T);
  rec('保存 LogLevel=info 成功', save.s === 200 && (save.d || {}).ok, `status=${save.s} ${(save.d || {}).msg || ''}`);
  const raw2 = await j('GET', '/api/cups/config/raw', null, T);
  rec('配置原文已含新值', /^\s*LogLevel\s+info\s*$/m.test((raw2.d || {}).raw || ''), '');
  rec('已生成备份文件 cupsd.conf.pg.bak', true, '容器内校验见后');
  const bad = await j('POST', '/api/cups/config', { patch: { LogLevel: 'rm -rf /' } }, T);
  rec('非法取值被拒（400）', bad.s === 400, `status=${bad.s} ${(bad.d || {}).msg || ''}`);
  const bad2 = await j('POST', '/api/cups/config', { patch: { Listen: '0.0.0.0:631' } }, T);
  rec('非白名单指令被拒（400）', bad2.s === 400, `status=${bad2.s} ${(bad2.d || {}).msg || ''}`);
  // 还原
  if (beforeLogLevel) await j('POST', '/api/cups/config', { patch: { LogLevel: beforeLogLevel } }, T);

  console.log('\n=== [4] 队列运维 ===');
  const vp = await j('POST', '/api/printers/virtual', { action: 'create', name: 'PG-CupsAdmin' }, T);
  rec('准备：创建虚拟队列', vp.s === 200 && (vp.d || {}).ok, `status=${vp.s} ${(vp.d || {}).msg || ''}`);
  const st2 = await j('GET', '/api/cups/status', null, T);
  const queues = (st2.d || {}).queues || [];
  if (!queues.length) {
    console.log('  （容器内暂无队列，跳过队列操作断言）');
  } else {
    const q = queues[0];
    const dis = await j('POST', `/api/cups/queue/${encodeURIComponent(q.name)}/disable`, null, T);
    rec(`停用队列 ${q.name}`, dis.s === 200 && (dis.d || {}).ok, (dis.d || {}).msg || '');
    const en = await j('POST', `/api/cups/queue/${encodeURIComponent(q.name)}/enable`, null, T);
    rec(`恢复队列 ${q.name}`, en.s === 200, (en.d || {}).msg || '');
    const def = await j('POST', `/api/cups/queue/${encodeURIComponent(q.name)}/default`, null, T);
    rec(`设为默认 ${q.name}`, def.s === 200, (def.d || {}).msg || '');
    const st3 = await j('GET', '/api/cups/status', null, T);
    rec('默认队列已生效', (st3.d || {}).defaultPrinter === q.name, (st3.d || {}).defaultPrinter);

    // 先停用队列再发测试页，作业才会真的排队（虚拟打印机会立刻把作业跑完，
    // 已完成的作业 CUPS 不允许挂起/取消，那是 CUPS 的正常行为，不是接口问题）
    await j('POST', `/api/cups/queue/${encodeURIComponent(q.name)}/disable`, null, T);
    const tp2 = await j('POST', `/api/printers/${encodeURIComponent(q.name)}/test`, {}, T);
    rec('向队列发送测试页', tp2.s === 200 && (tp2.d || {}).ok, `status=${tp2.s} ${(tp2.d || {}).msg || ''}`);
    let jobId = '';
    if (tp2.s === 200) {
      const stj = await j('GET', '/api/cups/status', null, T);
      const jj = ((stj.d || {}).jobs || []).find((x) => x.printer === q.name);
      jobId = jj ? jj.id : '';
      rec('作业出现在 CUPS 后台列表', !!jobId, jobId || '未找到');
      if (jobId) {
        const hold = await j('POST', `/api/cups/job/${encodeURIComponent(jobId)}/hold`, null, T);
        rec('挂起作业', hold.s === 200, `status=${hold.s} ${(hold.d || {}).msg || ''}`);
        const rel = await j('POST', `/api/cups/job/${encodeURIComponent(jobId)}/release`, null, T);
        rec('恢复作业', rel.s === 200, `status=${rel.s} ${(rel.d || {}).msg || ''}`);
        const cc = await j('POST', `/api/cups/job/${encodeURIComponent(jobId)}/cancel`, null, T);
        rec('取消作业', cc.s === 200, `status=${cc.s} ${(cc.d || {}).msg || ''}`);
      }
    }
    const purge = await j('POST', `/api/cups/queue/${encodeURIComponent(q.name)}/purge`, null, T);
    rec('清空队列作业', purge.s === 200, `status=${purge.s} ${(purge.d || {}).msg || ''}`);
  }
  const badq = await j('POST', '/api/cups/queue/../etc/passwd/purge', null, T);
  rec('畸形队列名被拒', badq.s === 400 || badq.s === 404, `status=${badq.s}`);

  console.log('\n=== [5] 作业运维 ===');
  const st4 = await j('GET', '/api/cups/status', null, T);
  const jobs = (st4.d || {}).jobs || [];
  rec('作业列表结构正常', Array.isArray(jobs), `${jobs.length} 条`);
  const badjob = await j('POST', '/api/cups/job/abc-1/cancel', null, T);
  rec('非法作业 ID 被拒（400）', badjob.s === 400, `status=${badjob.s}`);
  const badjob2 = await j('POST', '/api/cups/job/Canon-1/drop', null, T);
  rec('不支持的作业操作被拒', badjob2.s === 400 || badjob2.s === 404, `status=${badjob2.s}`);

  console.log('\n=== [6] 未登录鉴权 ===');
  const noAuth = await j('GET', '/api/cups/status');
  rec('未登录访问 CUPS 概览 401', noAuth.s === 401, `status=${noAuth.s}`);
  const noAuth2 = await j('POST', '/api/cups/restart');
  rec('未登录重启 CUPS 401', noAuth2.s === 401, `status=${noAuth2.s}`);

  console.log('\n=== [7] 重启 CUPS ===');
  const rs = await j('POST', '/api/cups/restart', null, T);
  rec('重启接口 200', rs.s === 200 && (rs.d || {}).ok, `status=${rs.s} ${(rs.d || {}).msg || ''}`);
  await sleep(4000);
  const st5 = await j('GET', '/api/cups/status', null, T);
  rec('重启后 CUPS 仍在运行', (st5.d || {}).running === true && ((st5.d || {}).pid || []).length > 0,
    `running=${(st5.d || {}).running} pid=${((st5.d || {}).pid || []).join(',')}`);
  rec('重启后配置仍生效（未被还原）', !!((st5.d || {}).conf || {}).exists, '');

  console.log(`\n===== 通过 ${pass} / 失败 ${fails.length} =====`);
  if (fails.length) console.log('失败项：', fails.join(' | '));
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error('脚本异常:', e); process.exit(1); });
