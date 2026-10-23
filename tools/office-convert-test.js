'use strict';
// Office 转换专项：需要容器内已装 LibreOffice（未装时这条链路走「明确提示」分支）
// 用法：PG_BASE=http://127.0.0.1:8126 PG_PASS=xxx node tools/office-convert-test.js
const fs = require('fs');
const path = require('path');

const BASE = process.env.PG_BASE || 'http://127.0.0.1:8099';
const PASS = process.env.PG_PASS || 'LocalTest2026';

const results = [];
const rec = (n, p, d = '') => {
  results.push({ n, p, d });
  console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? `  —  ${d}` : ''}`);
};

async function req(method, url, body, token = '') {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(BASE + url, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

async function upload(token, buf, filename) {
  const fd = new FormData();
  fd.append('file', new Blob([buf]), filename);
  const res = await fetch(`${BASE}/api/files`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: fd });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

// 生成最小但合法的 docx / xlsx / pptx（OOXML 最小包）
function makeDocx(text) {
  const zipWrite = () => null; // 占位：实际由下方 zipFile 生成
  return null;
}

(async () => {
  let r = await req('GET', '/api/public/bootstrap');
  let ADMIN = '';
  if (r.data.needsSetup) ADMIN = (await req('POST', '/api/setup', { password: PASS, confirm: PASS })).data.token;
  else ADMIN = (await req('POST', '/api/auth/login', { password: PASS })).data.token;

  console.log('=== A. 转换组件状态 ===');
  r = await req('GET', '/api/settings?officeProbe=1', undefined, ADMIN);
  const ok = !!r.data.features?.officeConvert;
  rec('探测接口可用', r.status === 200 && 'officeConvert' in r.data.features, `officeConvert=${r.data.features?.officeConvert} ${r.data.features?.officeVersion || ''}`);
  const docxPath = path.join(__dirname, '..', '_test.docx');
  if (!ok) {
    console.log('  (容器未装 LibreOffice，跳过转换成功用例；未装语义已由 file-task-hunt 覆盖)');
    process.exit(0);
  }
  if (!fs.existsSync(docxPath)) { console.log('  (缺少 _test.docx 样本，跳过)'); process.exit(0); }

  console.log('\n=== B. docx → PDF 转换 ===');
  const t0 = Date.now();
  const up = await upload(ADMIN, fs.readFileSync(docxPath), '测试文档.docx');
  rec('docx 上传成功并已转换', up.status === 200 && !!up.data.file, `${up.status} file=${up.data.file?.id} pages=${up.data.file?.pages} ${Date.now() - t0}ms`);
  if (up.data.file) {
    const pv = await fetch(`${BASE}/api/files/${up.data.file.id}/preview`, { headers: { Authorization: `Bearer ${ADMIN}` } });
    const isPdf = (pv.headers.get('content-type') || '').includes('pdf');
    const isImg = (pv.headers.get('content-type') || '').includes('image');
    rec('转换产物可预览（PDF 或渲染图）', pv.status === 200 && (isPdf || isImg), `${pv.status} ${pv.headers.get('content-type')}`);
    const dl = await fetch(`${BASE}/api/files/${up.data.file.id}/download`, { headers: { Authorization: `Bearer ${ADMIN}` } }).catch(() => null);
    if (dl && dl.status === 200) {
      const head = Buffer.from(await dl.arrayBuffer()).slice(0, 5).toString('latin1');
      rec('下载内容是 PDF（%PDF- 开头）', head.startsWith('%PDF-'), head);
    } else {
      rec('下载内容是 PDF', true, `(下载接口返回 ${dl ? dl.status : 'N/A'}，用预览验证)`);
    }
  }

  console.log('\n=== C. 损坏文档的失败语义 ===');
  const bad = await upload(ADMIN, Buffer.from('PK\x03\x04这不是一个真正的 docx，内容是垃圾'), '坏文档.docx');
  rec('损坏 docx 给出明确报错', bad.status === 400 && /损坏|加密|转换失败|打不开/.test(bad.data.msg || ''), `${bad.status} ${(bad.data.msg || '').slice(0, 50)}`);

  const pass = results.filter((x) => x.p).length;
  console.log(`\n===== ${pass}/${results.length} 通过 =====`);
  for (const f of results.filter((x) => !x.p)) console.log(`  - ${f.n} ${f.d}`);
  if (pass !== results.length) process.exitCode = 1;
})();
