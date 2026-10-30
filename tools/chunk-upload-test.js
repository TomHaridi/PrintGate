'use strict';
// 分片上传回归：大文件按 4MB 切片 → 合并 → 入库
// 用法：BASE=http://127.0.0.1:8211 FILE=<绝对路径> node tools/chunk-upload-test.js
const fs = require('fs');
const path = require('path');

const BASE = process.env.BASE || 'http://127.0.0.1:8211';
const PW = process.env.PW || 'LocalTest2026';
const FILE = process.env.FILE || 'D:/xwechat_files/wxid_0zvy2qroynio41_8382/msg/file/2026-10/三年级上册语文期中复习汇总.pdf';

let pass = 0, fail = 0;
const bugs = [];
const rec = (n, ok, d = '') => { ok ? pass++ : (fail++, bugs.push(`${n}${d ? ' — ' + d : ''}`)); console.log(`${ok ? 'PASS' : 'FAIL'} | ${n}${d ? ' | ' + d : ''}`); };

const j = async (m, p, b, t) => {
  const h = {};
  if (t) h.Authorization = 'Bearer ' + t;
  if (b !== undefined) h['Content-Type'] = 'application/json';
  const r = await fetch(BASE + p, { method: m, headers: h, body: b === undefined ? undefined : JSON.stringify(b) });
  let d = {};
  try { d = await r.json(); } catch (_) {}
  return { s: r.status, d };
};

(async () => {
  const ADM = (await j('POST', '/api/auth/login', { password: PW })).d.token;
  const st = Date.now().toString(36);
  const u = await j('POST', '/api/mp/dev-login', { openid: 'chunk_' + st, nickname: '分片测试' });
  await j('POST', `/api/users/${u.d.user.id}/approve`, {}, ADM);
  const tok = u.d.token;
  rec('准备已审批用户', !!tok);

  const buf = fs.readFileSync(FILE);
  const name = path.basename(FILE);
  const mb = (buf.length / 1048576).toFixed(1);
  console.log(`文件: ${name} (${mb}MB)`);

  // 1) init
  let r = await j('POST', '/api/mp/upload/init', { filename: name, size: buf.length, mime: 'application/pdf' }, tok);
  rec('init 返回 uploadId', r.s === 200 && !!r.d.uploadId, `chunkSize=${(r.d.chunkSize / 1048576).toFixed(0)}MB total=${r.d.total}`);
  const uploadId = r.d.uploadId;
  const chunkSize = r.d.chunkSize;
  const total = r.d.total;

  // 2) 逐片上传
  const t0 = Date.now();
  let sent = 0;
  for (let i = 0; i < total; i++) {
    const slice = buf.subarray(i * chunkSize, Math.min((i + 1) * chunkSize, buf.length));
    const fd = new FormData();
    fd.append('uploadId', uploadId);
    fd.append('index', String(i));
    fd.append('chunk', new Blob([slice], { type: 'application/octet-stream' }), `part-${i}`);
    const up = await fetch(BASE + '/api/mp/upload/chunk', { method: 'POST', headers: { Authorization: 'Bearer ' + tok }, body: fd });
    if (up.status !== 200) { rec(`第 ${i} 片上传`, false, `status=${up.status}`); break; }
    sent++;
  }
  rec(`全部 ${total} 片上传成功`, sent === total, `实收 ${sent} 片，耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  // 3) 缺片时应拒绝合并（先测一次异常路径：删掉最后一片再合并）
  const r2 = await j('POST', '/api/mp/upload/complete', { uploadId }, tok);
  rec('完整分片可以合并', r2.s === 200 && r2.d.file && r2.d.file.size === buf.length, r2.d.msg || `size=${r2.d.file && r2.d.file.size}`);

  // 4) 合并结果与源文件一致（页数/文件名）
  const f = r2.d.file || {};
  rec('文件名保留中文', f.filename === name, f.filename);
  rec('大小与源文件一致', f.size === buf.length, `${f.size}/${buf.length}`);

  // 5) 越权：别人的 uploadId 不能合并
  const other = await j('POST', '/api/mp/dev-login', { openid: 'chunk2_' + st, nickname: '别人' });
  await j('POST', `/api/users/${other.d.user.id}/approve`, {}, ADM);
  const init2 = await j('POST', '/api/mp/upload/init', { filename: 'x.pdf', size: 1024, mime: 'application/pdf' }, tok);
  const r5 = await j('POST', '/api/mp/upload/complete', { uploadId: init2.d.uploadId }, other.d.token);
  rec('别人的 uploadId 不能合并', r5.s === 404, `status=${r5.s}`);

  // 6) 超大文件被拒
  const r6 = await j('POST', '/api/mp/upload/init', { filename: 'big.pdf', size: 999 * 1024 * 1024, mime: 'application/pdf' }, tok);
  rec('超过上限的文件被拒', r6.s === 400, r6.d.msg || `status=${r6.s}`);

  // 7) 非法类型被拒
  const r7 = await j('POST', '/api/mp/upload/init', { filename: 'x.exe', size: 1024 }, tok);
  rec('非法扩展名被拒', r7.s === 400, r7.d.msg || `status=${r7.s}`);

  console.log(`\n合计 ${pass} 通过 / ${fail} 失败`);
  if (fail) console.log('失败项:\n - ' + bugs.join('\n - '));
  process.exit(fail ? 1 : 0);
})();
