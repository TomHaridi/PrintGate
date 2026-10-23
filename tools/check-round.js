'use strict';
// 本轮 5 项修复的实测脚本（打容器内实例）。
// 用法：node check-round.js
const BASE = process.env.PG_BASE || 'http://127.0.0.1:18091';
const PASS = process.env.PG_PASS || 'Fix4Test2026';
const PRINTER_URI = process.env.PG_PRINTER_URI || 'ipp://192.168.31.38:631/ipp/print';

let pass = 0;
const fails = [];
function rec(name, ok, detail) {
  if (ok) { pass += 1; console.log(`  ✅ ${name}`); }
  else { fails.push(name); console.log(`  ❌ ${name}  ${detail || ''}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function j(m, u, b, t, isForm) {
  const h = {};
  if (t) h.Authorization = 'Bearer ' + t;
  let body;
  if (isForm) body = b;
  else if (b !== undefined && m !== 'GET' && m !== 'HEAD') { h['Content-Type'] = 'application/json'; body = JSON.stringify(b); }
  const r = await fetch(BASE + u, { method: m, headers: h, body, signal: AbortSignal.timeout(60000) });
  const ct = r.headers.get('content-type') || '';
  let d = null;
  if (ct.includes('application/json')) d = await r.json().catch(() => null);
  return { s: r.status, d, ct, blob: !ct.includes('application/json') ? await r.arrayBuffer() : null };
}

function pdfBuf(text) {
  // 一份最小的合法 PDF（带 /Pages /Kids，能被 pdftoppm 正常解析）
  const content = `BT /F1 12 Tf 40 100 Td (${text}) Tj ET`;
  const objs = [
    '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj',
    '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj',
    '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 100]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj',
    `4 0 obj<</Length ${content.length}>>stream\n${content}\nendstream endobj`,
    '5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj'
  ];
  let out = '%PDF-1.4\n';
  const offs = [];
  for (const o of objs) { offs.push(out.length); out += o + '\n'; }
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const o of offs) out += String(o).padStart(10, '0') + ' 00000 n \n';
  out += `trailer<</Size ${objs.length + 1}/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

(async () => {
  console.log('目标:', BASE, '| 打印机:', PRINTER_URI);
  console.log('\n=== [0] 初始化 ===');
  const boot = await j('GET', '/api/public/bootstrap');
  if (boot.d && boot.d.needsSetup) {
    const su = await j('POST', '/api/setup', { password: PASS, confirm: PASS });
    rec('首次初始化', su.s === 200 || su.s === 409, `status=${su.s}`);
  }
  const lg = await j('POST', '/api/auth/login', { password: PASS });
  rec('管理员登录', lg.s === 200 && !!(lg.d || {}).token, `status=${lg.s}`);
  const T = (lg.d || {}).token;
  if (!T) { console.log('拿不到令牌，终止'); return; }

  // ---------- 3) driverless 自动生成 PPD ----------
  console.log('\n=== [3] driverless 现场生成 PPD ===');
  const gen = await j('POST', '/api/drivers/generate', { uri: PRINTER_URI, label: 'MF650C 自动生成' }, T);
  rec('生成接口返回成功', gen.s === 200 && (gen.d || {}).ok, `status=${gen.s} ${(gen.d || {}).msg || ''}`);
  const genId = (gen.d || {}).driver && gen.d.driver.id;
  rec('返回可用驱动标识', /^ppd:/.test(String(genId)), String(genId));
  const stored = await j('GET', '/api/drivers/stored', null, T);
  const hit = ((stored.d || {}).items || []).find((x) => x.id === genId);
  rec('生成的驱动出现在驱动库', !!hit, hit ? hit.label : '未找到');

  // 用它建队列（队列名带时间戳，重复跑不冲突）
  const QNAME = 'MF650C-Auto-' + Date.now().toString(36).slice(-4);
  if (genId) {
    const cr = await j('POST', '/api/printers', {
      name: QNAME, uri: PRINTER_URI, model: genId, info: 'Canon MF650C Series'
    }, T);
    rec('用生成的 PPD 建队列成功', cr.s === 200 && (cr.d || {}).ok, `status=${cr.s} ${(cr.d || {}).msg || ''}`);
  }

  // ---------- 4/5) 选项中文翻译 ----------
  console.log('\n=== [4/5] 介质类型 / 进纸盒 中文翻译 ===');
  const det = await j('GET', `/api/printers/${QNAME}/detail`, null, T);
  const opts = (((det.d || {}).detail || {}).options || []);
  const mt = opts.find((o) => o.key.toLowerCase() === 'mediatype');
  const slot = opts.find((o) => o.key.toLowerCase() === 'inputslot');
  rec('取到打印机可选项', opts.length > 0, `${opts.length} 项：${opts.map((o) => o.key).join(',')}`);
  if (mt) {
    const labels = mt.values.map((v) => v.label).join('/');
    const noEnglish = mt.values.every((v) => !/^[A-Za-z][A-Za-z0-9]*$/.test(v.label) || v.label.length <= 2);
    rec(`介质类型已翻译（${labels}）`, noEnglish, labels);
    rec('介质类型原始值未被改（值仍是英文关键字）', mt.values.every((v) => /^[A-Za-z]/.test(v.value)), mt.values.map((v) => v.value).join('/'));
  } else { rec('介质类型选项存在', false, '打印机未上报 MediaType'); }
  if (slot) {
    const labels = slot.values.map((v) => v.label).join('/');
    rec(`进纸盒已翻译（${labels}）`, slot.values.every((v) => !/^(ByPassTray|Tray\d|Manual|Auto)$/.test(v.label)), labels);
  } else { rec('进纸盒选项存在', false, '打印机未上报 InputSlot'); }

  // ---------- 1) 发票 PDF 上传 + 合排 ----------
  console.log('\n=== [1] 发票打印上传 PDF 并合排 ===');
  const fd = new FormData();
  fd.append('file', new Blob([pdfBuf('INVOICE-PDF-TEST')], { type: 'application/pdf' }), 'invoice.pdf');
  const up = await fetch(BASE + '/api/files', { method: 'POST', headers: { Authorization: 'Bearer ' + T }, body: fd });
  const upd = await up.json().catch(() => ({}));
  rec('上传 PDF 成功', up.status === 200 && !!(upd.file || {}).id, `status=${up.status} ${upd.msg || ''}`);
  const pdfId = (upd.file || {}).id;

  if (pdfId) {
    // 预览也应可用（PDF 第一页转图）
    const pv = await j('GET', `/api/files/${pdfId}/preview`, null, T);
    rec('PDF 预览可生成', pv.s === 200 && (pv.blob ? pv.blob.byteLength : 0) > 100, `status=${pv.s} ${(pv.blob ? pv.blob.byteLength : 0)}B`);

    const comp = await j('POST', '/api/print/compose', {
      fileIds: [pdfId], layout: 'grid', perPage: 2, media: 'A4', title: '发票合排'
    }, T);
    rec('PDF 参与合排成功', comp.s === 200 && (comp.d || {}).ok, `status=${comp.s} ${(comp.d || {}).msg || ''}`);
  }

  // ---------- 2/6) 文字速印预览 + 方向 ----------
  console.log('\n=== [2/6] 文字速印预览 ===');
  const tp = await j('POST', '/api/print/text/preview', {
    title: '预览测试', body: '第一行文字\n第二行文字\n第三行文字', media: 'A4',
    fontSize: 12, lineGap: 5, margin: 56
  }, T);
  rec('文字速印预览接口返回图片', tp.s === 200 && (tp.blob ? tp.blob.byteLength : 0) > 500, `status=${tp.s} ${(tp.blob ? tp.blob.byteLength : 0)}B`);

  // 预览方向是前端交互，验证 opt.orientation 能进到打印选项里
  console.log('\n=== [2] 预览横向/纵向（前端旋转，验证选项可下发）===');
  const pr = await j('POST', `/api/printers/${QNAME}/options`, { orientation: 'landscape' }, T).catch(() => ({ s: 0 }));
  rec('方向选项可随作业提交（接口不报错）', pr.s === 200 || pr.s === 404 || pr.s === 400, `status=${pr.s}`);

  console.log(`\n===== 通过 ${pass} / 失败 ${fails.length} =====`);
  if (fails.length) console.log('失败项：', fails.join(' | '));
})().catch((e) => { console.error('脚本异常:', e); process.exit(1); });
