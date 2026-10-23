'use strict';
// 身份证自动矫正 / 拼接预览 / 打印提交 的端到端验证（打容器实例）
// 需要 sharp 生成合成测试图（旋转 15° 的"身份证"），运行前把 NODE_PATH 指向含 sharp 的 node_modules：
//   NODE_PATH=C:/Users/Administrator/.workbuddy/binaries/node/workspace/node_modules \
//   PG_BASE=http://127.0.0.1:18093 PG_PASS=xxx node tools/idcard-test.js
const path = require('path');
const fs = require('fs');
const sharp = require('sharp');

const BASE = process.env.PG_BASE || 'http://127.0.0.1:18093';
const PASS = process.env.PG_PASS || 'Fix6Test2026';
const SHOT = require('./_paths').shotsDir();

let pass = 0;
const fails = [];
function rec(name, ok, detail) {
  if (ok) { pass += 1; console.log(`  ✅ ${name}${detail ? '  — ' + detail : ''}`); }
  else { fails.push(name); console.log(`  ❌ ${name}  ${detail || ''}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function j(m, u, b, t, isForm) {
  const h = {};
  if (t) h.Authorization = 'Bearer ' + t;
  let body;
  if (isForm) body = b;
  else if (b !== undefined && m !== 'GET') { h['Content-Type'] = 'application/json'; body = JSON.stringify(b); }
  const r = await fetch(BASE + u, { method: m, headers: h, body, signal: AbortSignal.timeout(120000) });
  const ct = r.headers.get('content-type') || '';
  const d = ct.includes('application/json') ? await r.json().catch(() => null) : null;
  return { s: r.status, d, blob: !ct.includes('application/json') ? Buffer.from(await r.arrayBuffer()) : null };
}

async function upload(buf, name, type, token) {
  const fd = new FormData();
  fd.append('file', new Blob([buf], { type }), name);
  const r = await fetch(BASE + '/api/files', { method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: fd });
  return { s: r.status, d: await r.json().catch(() => ({})) };
}

// 合成一张"身份证"：白底卡片 + 左上角色块 + 人像块 + 几行细文字（不横贯），整体旋转 angle 度后放到深灰背景上
async function synthCard(label, accent, angle) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="378">
    <rect width="600" height="378" rx="18" fill="#fdfdfd" stroke="#c8ccd4" stroke-width="3"/>
    <rect x="24" y="24" width="88" height="76" fill="${accent}" opacity="0.92"/>
    <rect x="24" y="110" width="150" height="190" rx="8" fill="#e2e5ea"/>
    <rect x="196" y="30" width="360" height="16" rx="6" fill="#8b95a5"/>
    <rect x="196" y="58" width="300" height="12" rx="6" fill="#b6bdc8"/>
    <rect x="196" y="110" width="380" height="12" rx="6" fill="#b6bdc8"/>
    <rect x="196" y="132" width="340" height="12" rx="6" fill="#b6bdc8"/>
    <rect x="196" y="154" width="360" height="12" rx="6" fill="#b6bdc8"/>
    <rect x="196" y="176" width="280" height="12" rx="6" fill="#b6bdc8"/>
    <rect x="24" y="316" width="552" height="38" rx="6" fill="#eef0f4"/>
    <text x="132" y="72" font-family="Arial" font-size="30" fill="#ffffff">${label}</text>
  </svg>`;
  const card = await sharp(Buffer.from(svg)).png().toBuffer();
  const rotated = await sharp(card).rotate(angle, { background: { r: 46, g: 46, b: 50, alpha: 1 } }).toBuffer();
  return sharp({ create: { width: 900, height: 700, channels: 3, background: { r: 46, g: 46, b: 50 } } })
    .composite([{ input: rotated, gravity: 'center' }])
    .jpeg({ quality: 92 })
    .toBuffer();
}

(async () => {
  fs.mkdirSync(SHOT, { recursive: true });
  console.log('目标:', BASE);
  console.log('\n=== [0] 登录 ===');
  let r = await j('GET', '/api/public/bootstrap');
  if (r.d && r.d.needsSetup) await j('POST', '/api/setup', { password: PASS, confirm: PASS });
  const lg = await j('POST', '/api/auth/login', { password: PASS });
  rec('管理员登录', lg.s === 200 && !!(lg.d || {}).token, `status=${lg.s}`);
  const T = (lg.d || {}).token;
  if (!T) { console.log('拿不到令牌，终止'); process.exit(1); }

  console.log('\n=== [1] 合成并上传正反面 ===');
  const frontBuf = await synthCard('FRONT', '#2b6cb0', 15);
  const backBuf = await synthCard('BACK', '#c53030', -12);
  const upF = await upload(frontBuf, 'front.jpg', 'image/jpeg', T);
  rec('上传人像面', upF.s === 200 && !!(upF.d.file || {}).id, `id=${(upF.d.file || {}).id}`);
  const upB = await upload(backBuf, 'back.jpg', 'image/jpeg', T);
  rec('上传国徽面', upB.s === 200 && !!(upB.d.file || {}).id, `id=${(upB.d.file || {}).id}`);
  const fid = (upF.d.file || {}).id, bid = (upB.d.file || {}).id;
  if (!fid || !bid) { console.log('上传失败，终止'); process.exit(1); }

  console.log('\n=== [2] 自动矫正识别切割 ===');
  const cropF = await j('POST', '/api/print/idcard/auto-crop', { fileId: fid }, T);
  rec('人像面矫正成功', cropF.s === 200 && (cropF.d || {}).ok, `angle=${(cropF.d || {}).angle}°`);
  // 接口返回的是「摆正角」（把 +15° 倾斜的图摆正需要转 -15°）
  rec('人像面摆正角接近 -15°', Math.abs((cropF.d || {}).angle + 15) <= 8, `angle=${(cropF.d || {}).angle}°`);
  const cropB = await j('POST', '/api/print/idcard/auto-crop', { fileId: bid }, T);
  rec('国徽面矫正成功', cropB.s === 200 && (cropB.d || {}).ok, `angle=${(cropB.d || {}).angle}°`);
  rec('国徽面摆正角接近 +12°', Math.abs((cropB.d || {}).angle - 12) <= 8, `angle=${(cropB.d || {}).angle}°`);
  const cidF = (cropF.d || {}).file?.id, cidB = (cropB.d || {}).file?.id;
  if (cidF) {
    const pv = await j('GET', `/api/files/${cidF}/preview`, null, T);
    const dim = pv.blob ? await sharp(pv.blob).metadata().catch(() => null) : null;
    rec('矫正后宽高比接近身份证 1.586', dim && Math.abs(dim.width / dim.height - 1.586) < 0.25,
      dim ? `${dim.width}x${dim.height} → ${(dim.width / dim.height).toFixed(3)}` : '尺寸读取失败');
  }

  console.log('\n=== [3] 拼接实时预览（可调大小/方向） ===');
  const prev = await j('POST', '/api/print/idcard/preview', {
    media: 'A4',
    front: { fileId: fid, rotate: 0, scale: 1 },
    back: { fileId: bid, rotate: 90, scale: 0.8 }
  }, T);
  rec('拼接预览返回 PNG', prev.s === 200 && prev.blob && prev.blob.length > 1000, `status=${prev.s} ${(prev.blob ? prev.blob.length : 0)}B`);
  if (prev.blob) {
    const dim = await sharp(prev.blob).metadata().catch(() => null);
    rec('预览为竖版 A4 比例', dim && dim.height > dim.width, dim ? `${dim.width}x${dim.height}` : '');
    fs.writeFileSync(path.join(SHOT, 'idcard-compose-preview.png'), prev.blob);
  }

  console.log('\n=== [4] 打印提交 ===');
  const sub = await j('POST', '/api/print/idcard', {
    media: 'A4',
    front: { fileId: fid, rotate: 0, scale: 1 },
    back: { fileId: bid, rotate: 90, scale: 0.8 }
  }, T);
  rec('身份证合排提交成功（落库，不直接打印）', sub.s === 200 && (sub.d || {}).ok && (sub.d.file || {}).id, `file=${(sub.d.file || {}).id}`);

  console.log('\n=== [5] 参数校验 ===');
  const badRot = await j('POST', '/api/print/idcard/preview', {
    front: { fileId: fid, rotate: 123, scale: 1 }
  }, T);
  rec('非法旋转角被归一（不 500）', badRot.s === 200, `status=${badRot.s}`);
  const badScale = await j('POST', '/api/print/idcard', {
    front: { fileId: fid, rotate: 0, scale: 99 }
  }, T);
  rec('非法缩放被夹取到上限（不 500）', badScale.s === 200, `status=${badScale.s}`);
  const none = await j('POST', '/api/print/idcard/preview', {}, T);
  rec('空提交返回 400', none.s === 400, `status=${none.s}`);

  console.log(`\n===== 通过 ${pass} / 失败 ${fails.length} =====`);
  if (fails.length) console.log('失败项：', fails.join(' | '));
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error('脚本异常:', e); process.exit(1); });
