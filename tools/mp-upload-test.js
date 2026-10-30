'use strict';
// 小程序上传类型识别：微信真机的临时文件名常常没有扩展名（tmp_xxx），
// 这里验证「按文件头认类型」与「展示名纠偏」不会再把普通用户的上传打成 400。
// 用法：PG_BASE=http://127.0.0.1:8161 PG_PASS=LocalTest2026 node tools/mp-upload-test.js
const BASE = process.env.PG_BASE || 'http://127.0.0.1:8161';
const PASS = process.env.PG_PASS || 'LocalTest2026';

let pass = 0, fail = 0;
const rec = (n, ok, d = '') => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'} | ${n}${d ? ' | ' + d : ''}`); };

const j = async (m, p, b, t) => {
  const h = {}; if (t) h.Authorization = 'Bearer ' + t;
  if (b !== undefined) h['Content-Type'] = 'application/json';
  const r = await fetch(BASE + p, { method: m, headers: h, body: b === undefined ? undefined : JSON.stringify(b) });
  return { s: r.status, d: await r.json().catch(() => ({})) };
};

async function up(token, buf, oname, hint) {
  const fd = new FormData();
  fd.append('file', new Blob([buf]), oname);
  if (hint !== undefined && hint !== null) fd.append('filename', hint);
  const r = await fetch(BASE + '/api/mp/files', { method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: fd });
  return { s: r.status, d: await r.json().catch(() => ({})) };
}

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00,
  0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xd9]);
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n');

(async () => {
  const lg = await j('POST', '/api/auth/login', { password: PASS });
  const ADMIN = lg.d.token;
  if (!ADMIN) { console.error('无法登录后台'); process.exit(1); }
  await j('PUT', '/api/settings', { devMode: true }, ADMIN);
  const dl = await j('POST', '/api/mp/dev-login', { nickname: '上传类型测试' });
  const U = dl.d.token, uid = dl.d.user.id;

  let r = await up(U, PNG, 'tmp_abc.png', '图片.png');
  rec('未审批上传被拦（403）', r.s === 403, `${r.s}`);
  await j('POST', `/api/users/${uid}/approve`, {}, ADMIN);

  // —— 真机最常见的三种：无扩展名 / 扩展名与内容不符 / 有扩展名 ——
  r = await up(U, PNG, 'tmp_abc123', '图片-1.jpg');
  rec('无扩展名的图片能上传', r.s === 200, `${r.s} ${r.d.msg || ''}`);
  rec('无扩展名图片按内容认成 .png', /\.png$/.test((r.d.file || {}).filename || ''), (r.d.file || {}).filename);

  r = await up(U, PNG, 'tmp_def456', '');          // 连展示名都没有
  rec('无扩展名且无展示名也能上传', r.s === 200, `${r.s} ${r.d.msg || ''}`);
  rec('没展示名时用原文件名 + 真实扩展名', /^tmp_def456\.png$/.test((r.d.file || {}).filename || ''), (r.d.file || {}).filename);

  r = await up(U, JPG, 'tmp_ghi789', '照片.jpg');
  rec('JPEG 无扩展名识别为 .jpg', r.s === 200 && /\.jpg$/.test((r.d.file || {}).filename || ''), `${r.s} ${(r.d.file || {}).filename}`);

  r = await up(U, PNG, 'tmp_x.jpg', '相册图.jpg');   // 名字说 jpg，实际是 png
  rec('扩展名与内容不符时按内容纠正', r.s === 200 && /\.png$/.test((r.d.file || {}).filename || ''),
    `${r.s} ${(r.d.file || {}).filename}`);

  r = await up(U, PDF, 'tmp_pdf001', '文档.pdf');
  rec('PDF 无扩展名也能上传', r.s === 200 && /\.pdf$/.test((r.d.file || {}).filename || ''), `${r.s} ${(r.d.file || {}).filename}`);

  // —— 关键回归：无扩展名上传后，磁盘名必须被纠正成真实类型 ——
  // 否则 merge / 预览按 storage_path 后缀判类型时会把 .bin 当成非图片（多选合成直接 400）
  const m1 = await up(U, PNG, 'tmp_wx_a', '图片-1.png');
  const m2 = await up(U, PNG, 'tmp_wx_b', '图片-2.png');
  rec('两张无扩展名图片都上传成功', m1.s === 200 && m2.s === 200,
    `${m1.s}/${m2.s} ${(m1.d.file || {}).filename}/${(m2.d.file || {}).filename}`);
  r = await j('POST', '/api/mp/files/merge',
    { ids: [m1.d.file.id, m2.d.file.id], filename: '图片合并.pdf' }, U);
  rec('无扩展名图片能合成多页 PDF', r.s === 200 && r.d.file && r.d.file.pages === 2,
    `${r.s} pages=${r.d.file && r.d.file.pages} ${r.d.msg || ''}`);

  // 预览也按 storage_path 后缀判类型：磁盘名是 .bin 就会去走 PDF 渲染，图和打印都废
  const pv = await fetch(`${BASE}/api/files/${m1.d.file.id}/preview`, { headers: { Authorization: 'Bearer ' + U } });
  rec('无扩展名图片能直接预览（原图直出）', pv.status === 200 && /image/.test(pv.headers.get('content-type') || ''),
    `${pv.status} ${pv.headers.get('content-type')}`);

  // —— 安全兜底：伪装仍然要拦 ——
  r = await up(U, Buffer.from('<html><script>alert(1)</script></html>'), 'evil.pdf', 'evil.pdf');
  rec('HTML 冒充 PDF 被拒 400', r.s === 400, `${r.s} ${r.d.msg || ''}`);

  r = await up(U, Buffer.from(''), 'empty.png', 'empty.png');
  rec('空文件被拒 400', r.s === 400, `${r.s} ${r.d.msg || ''}`);

  r = await up(U, Buffer.from('随便一段文本内容'), 'note.xyz', 'note.xyz');
  rec('不支持的扩展名被拒且提示带名字', r.s === 400 && /xyz/.test(r.d.msg || ''), `${r.s} ${r.d.msg || ''}`);

  // —— 清理 ——
  const list = await j('GET', '/api/mp/files', undefined, U);
  for (const f of (list.d.files || [])) await j('DELETE', `/api/mp/files/${f.id}`, undefined, U);

  console.log(`\n合计 ${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})();
