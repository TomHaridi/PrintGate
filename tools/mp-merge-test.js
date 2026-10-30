'use strict';
// 多选图片合成多页 PDF（POST /api/mp/files/merge）契约测试
// 用法：PG_BASE=http://127.0.0.1:8160 PG_PASS=LocalTest2026 node tools/mp-merge-test.js
const fs = require('fs');
const path = require('path');
const P = require('./_paths');

const BASE = process.env.PG_BASE || 'http://127.0.0.1:8160';
const PASS = process.env.PG_PASS || 'LocalTest2026';

let pass = 0, fail = 0;
const rec = (n, ok, d = '') => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'} | ${n}${d ? ' | ' + d : ''}`); };

async function req(method, url, body, token) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  let payload;
  if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const res = await fetch(BASE + url, { method, headers, body: payload });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch (_) { data = { raw: text.slice(0, 160) }; }
  return { status: res.status, data };
}

async function upload(token, filePath, filename) {
  const fd = new FormData();
  fd.append('file', new Blob([fs.readFileSync(filePath)]), filename);
  if (filename) fd.append('filename', filename);
  const res = await fetch(BASE + '/api/mp/files', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: fd
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

(async () => {
  const png = P.standardPng();
  const tmpDir = P.shotsDir();
  const pics = [1, 2, 3].map((i) => {
    const p = path.join(tmpDir, `merge-src-${i}.png`);
    fs.writeFileSync(p, fs.readFileSync(png));
    return p;
  });

  // ---- 准备两个用户：dev-login 的第一个是管理员 ----
  const lg = await req('POST', '/api/auth/login', { password: PASS });
  const ADMIN_TOKEN = lg.data.token || '';
  rec('后台管理员登录', !!ADMIN_TOKEN);
  if (!ADMIN_TOKEN) process.exit(1);
  await req('PUT', '/api/settings', { devMode: true }, ADMIN_TOKEN);

  // 每次用随机 openid，保证「未审批」这一步在重复运行时依然成立
  const u1 = await req('POST', '/api/mp/dev-login', { nickname: '合并测试用户B' });
  const UADMIN = u1.data.token || '';
  const u2 = await req('POST', '/api/mp/dev-login', { nickname: '合并测试用户A' });
  const UUSER = u2.data.token || '';
  const uid1 = u1.data.user && u1.data.user.id;
  const uid2 = u2.data.user && u2.data.user.id;
  rec('两个小程序账号拿到令牌', !!UADMIN && !!UUSER, `id=${uid2}`);

  // ---- 未审批时被拦 ----
  let r = await req('POST', '/api/mp/files/merge', { ids: [1] }, UUSER);
  rec('未审批用户不能合成（403）', r.status === 403, `${r.status} ${r.data.msg || ''}`);

  // ---- 审批（走后台管理员接口，不依赖小程序端管理员）----
  await req('POST', `/api/users/${uid1}/approve`, {}, ADMIN_TOKEN);
  r = await req('POST', `/api/users/${uid2}/approve`, {}, ADMIN_TOKEN);
  rec('审批通过', r.status === 200, `${r.status} ${r.data.msg || ''}`);

  // ---- 正常路径：上传 3 张图 → 合成 ----
  const up = [];
  for (const p of pics) {
    const x = await upload(UUSER, p, path.basename(p));
    up.push(x);
  }
  rec('上传 3 张图片', up.every((x) => x.status === 200 && x.data.file && x.data.file.id),
    up.map((x) => x.status).join(','));

  const ids = up.map((x) => x.data.file && x.data.file.id).filter(Boolean);
  r = await req('POST', '/api/mp/files/merge', { ids, filename: '相册多选.pdf' }, UUSER);
  const merged = r.data.file || {};
  rec('合成成功', r.status === 200 && !!merged.id, `${r.status} ${r.data.msg || ''}`);
  rec('页数 = 图片张数', merged.pages === 3, `pages=${merged.pages}`);
  rec('文件名用请求里的名字且扩展名是 .pdf', merged.filename === '相册多选.pdf', merged.filename);
  rec('合成文件有体积', Number(merged.size) > 0, `${merged.size} B`);

  // ---- 列表可见 ----
  r = await req('GET', '/api/mp/files', undefined, UUSER);
  const inList = (r.data.files || []).some((f) => f.id === merged.id);
  rec('合并结果出现在文件列表', inList, `${(r.data.files || []).length} 个文件`);

  // ---- 单张也能用（前端单选走同一条路）----
  r = await req('POST', '/api/mp/files/merge', { ids: [ids[0]] }, UUSER);
  rec('单张合成 = 1 页', r.status === 200 && r.data.file && r.data.file.pages === 1, `pages=${r.data.file && r.data.file.pages}`);

  // ---- 多页预览：合成出来的 PDF 要能翻页（首页/文件页都靠这个看预览）----
  let skipped = 0;
  const preview = async (id, pg) => {
    const res = await fetch(`${BASE}/api/mp/files/${id}/preview?page=${pg}`, {
      headers: { Authorization: `Bearer ${UUSER}` }
    });
    let body = null;
    try { body = await res.json(); } catch (_) {}
    return { status: res.status, total: res.headers.get('x-total-pages'), body };
  };
  for (const pg of [1, 2, 3]) {
    const p = await preview(merged.id, pg);
    // 415 = 本机缺 pdftoppm（Windows 开发机常见），渲染能力缺失不是本次改动的问题
    if (p.status === 415 || (p.status === 500 && /pdftoppm|渲染/.test(JSON.stringify(p.body || {})))) {
      skipped++;
      console.log(`SKIP | 第 ${pg} 页预览（当前环境缺 pdftoppm 渲染器）`);
    } else {
      rec(`第 ${pg} 页可预览`, p.status === 200, `${p.status} total=${p.total}`);
    }
  }
  const over = await preview(merged.id, 4);
  if (over.status === 415 || (over.status === 500 && /pdftoppm|渲染/.test(JSON.stringify(over.body || {})))) {
    skipped++;
    console.log('SKIP | 超出页数返回 404（当前环境缺 pdftoppm 渲染器）');
  } else {
    rec('超出页数返回 404', over.status === 404, `${over.status}`);
  }

  // ---- 边界 ----
  r = await req('POST', '/api/mp/files/merge', { ids: [] }, UUSER);
  rec('空 ids 被拒 400', r.status === 400, `${r.status}`);
  r = await req('POST', '/api/mp/files/merge', {}, UUSER);
  rec('缺 ids 被拒 400', r.status === 400, `${r.status}`);
  r = await req('POST', '/api/mp/files/merge', { ids: [`${ids[0]}`, ids[1], 'x', -3, ids[1]] }, UUSER);
  rec('脏数据被清洗（字符串/负数/重复）', r.status === 200, `${r.status}`);
  r = await req('POST', '/api/mp/files/merge', { ids: Array.from({ length: 21 }, (_, i) => i + 1) }, UUSER);
  rec('超过 20 张被拒 400', r.status === 400, `${r.status} ${r.data.msg || ''}`);

  // ---- 混入非图片 ----
  const pdfPath = path.join(tmpDir, 'merge-not-image.pdf');
  fs.writeFileSync(pdfPath, Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n'));
  const upPdf = await upload(UUSER, pdfPath, 'merge-not-image.pdf');
  if (upPdf.status === 200 && upPdf.data.file) {
    r = await req('POST', '/api/mp/files/merge', { ids: [ids[0], upPdf.data.file.id] }, UUSER);
    rec('混入 PDF 被拒 400', r.status === 400, `${r.status} ${r.data.msg || ''}`);
    await req('DELETE', `/api/mp/files/${upPdf.data.file.id}`, undefined, UUSER);
  } else {
    rec('混入 PDF 被拒 400', false, `PDF 上传失败 ${upPdf.status}`);
  }

  // ---- 越权：别人的图片不能合 ----
  const upOther = await upload(UADMIN, pics[0], 'other.png');
  if (upOther.status === 200 && upOther.data.file) {
    r = await req('POST', '/api/mp/files/merge', { ids: [upOther.data.file.id] }, UUSER);
    rec('不能合并别人的图片（404）', r.status === 404, `${r.status} ${r.data.msg || ''}`);
    await req('DELETE', `/api/mp/files/${upOther.data.file.id}`, undefined, UADMIN);
  } else {
    rec('不能合并别人的图片（404）', false, `管理员上传失败 ${upOther.status}`);
  }

  // ---- 清理 ----
  for (const x of up) {
    if (x.data && x.data.file) await req('DELETE', `/api/mp/files/${x.data.file.id}`, undefined, UUSER);
  }
  if (merged.id) {
    r = await req('DELETE', `/api/mp/files/${merged.id}`, undefined, UUSER);
    rec('合并文件可删除', r.status === 200, `${r.status}`);
  }

  console.log(`\n合计 ${pass} 通过 / ${fail} 失败${skipped ? ` / ${skipped} 跳过` : ''}`);
  process.exit(fail ? 1 : 0);
})();
