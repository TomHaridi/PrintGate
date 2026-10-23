'use strict';
// 头像上传回归：微信临时文件常常没有扩展名，服务端必须按内容判定类型
// 用法：BASE=http://127.0.0.1:8141 PW=LocalTest2026 node tools/avatar-test.js
const BASE = process.env.BASE || 'http://127.0.0.1:8141';
const PW = process.env.PW || 'LocalTest2026';
let pass = 0, fail = 0;
const bugs = [];
const rec = (n, ok, d = '') => { ok ? pass++ : (fail++, bugs.push(n + (d ? ' — ' + d : ''))); console.log(`${ok ? 'PASS' : 'FAIL'} | ${n}${d ? ' | ' + d : ''}`); };

const JPEG = Buffer.from('ffd8ffe000104a46494600010100000100010000ffdb004300' + '00'.repeat(60) + 'ffd9', 'hex');
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000000020001e221bc330000000049454e44ae426082', 'hex');

const j = async (m, p, b, t) => {
  const h = {};
  if (t) h.Authorization = 'Bearer ' + t;
  if (b !== undefined) h['Content-Type'] = 'application/json';
  const r = await fetch(BASE + p, { method: m, headers: h, body: b === undefined ? undefined : JSON.stringify(b) });
  let d = {};
  try { d = await r.json(); } catch (_) {}
  return { s: r.status, d };
};

const upload = async (token, buf, filename, type = 'application/octet-stream') => {
  const fd = new FormData();
  fd.append('avatar', new Blob([buf], { type }), filename);
  const r = await fetch(BASE + '/api/mp/avatar', { method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: fd });
  let d = {};
  try { d = await r.json(); } catch (_) {}
  return { s: r.status, d };
};

(async () => {
  const ADM = (await j('POST', '/api/auth/login', { password: PW })).d.token;
  rec('管理员登录', !!ADM);
  const st = Date.now().toString(36);
  let r = await j('POST', '/api/mp/dev-login', { openid: 'av_' + st, nickname: '头像测试' });
  const tok = r.d.token;
  if (!tok) { console.log('dev-login 失败:', r.s, r.d.msg); process.exit(1); }

  const cases = [
    ['无扩展名 + JPEG（微信常见）', JPEG, 'file'],
    ['.jpeg 名 + JPEG 内容', JPEG, 'tmp.jpeg'],
    ['.png 名 + PNG 内容', PNG, 'a.png'],
    ['.png 名但 JPEG 内容（扩展名撒谎）', JPEG, 'fake.png']
  ];
  for (const [name, buf, fname] of cases) {
    r = await upload(tok, buf, fname);
    const url = r.d.user && r.d.user.avatar;
    if (!url) { rec(name, false, `上传失败 ${r.s} ${r.d.msg || ''}`); continue; }
    const g = await fetch(BASE + url);
    const ct = g.headers.get('content-type') || '';
    const bytes = Buffer.from(await g.arrayBuffer());
    const isJpeg = bytes[0] === 0xff && bytes[1] === 0xd8;
    const isPng = bytes.subarray(0, 4).toString('hex') === '89504e47';
    const mimeOk = (ct.includes('png') && isPng) || (ct.includes('jpeg') && isJpeg);
    rec(name, r.s === 200 && g.status === 200 && mimeOk, `url=${url.split('/').pop()} ct=${ct}`);
  }

  // 非图片必须拒绝
  r = await upload(tok, Buffer.from('hello world'), 'a.txt', 'text/plain');
  rec('非图片被拒绝', r.s === 400, `${r.s} ${r.d.msg || ''}`);
  // 超大文件（>5MB）必须拒绝
  r = await upload(tok, Buffer.alloc(6 * 1024 * 1024, 0x41), 'big.png', 'image/png');
  rec('超过 5MB 被拒绝', r.s === 400, `${r.s} ${r.d.msg || ''}`);
  // 未登录不能上传
  r = await upload('', PNG, 'a.png');
  rec('未登录上传被拒', r.s === 401, `status=${r.s}`);

  // 换头像后旧文件被清理
  const before = (await j('GET', '/api/mp/me', undefined, tok)).d.user.avatar;
  await upload(tok, PNG, 'b.png');
  const after = (await j('GET', '/api/mp/me', undefined, tok)).d.user.avatar;
  rec('换头像地址会变（前端能刷新）', before && after && before !== after, `${before} → ${after}`);
  const old = await fetch(BASE + before);
  rec('旧头像文件已清理（404）', old.status === 404, `status=${old.status}`);

  console.log(`\n合计 ${pass} 通过 / ${fail} 失败`);
  if (fail) console.log('失败项:\n - ' + bugs.join('\n - '));
  process.exit(fail ? 1 : 0);
})();
