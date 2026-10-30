'use strict';
// 后端攻击面探测：越权(IDOR)、输入边界、路径穿越、畸形请求、并发竞态
// 用法：BASE=http://127.0.0.1:8160 PW=LocalTest2026 node tools/backend-probe.js
const BASE = process.env.BASE || 'http://127.0.0.1:8160';
const PW = process.env.PW || 'LocalTest2026';
let pass = 0, fail = 0;
const bugs = [];
const rec = (n, ok, d = '') => { ok ? pass++ : (fail++, bugs.push(`${n}${d ? ' — ' + d : ''}`)); console.log(`${ok ? 'PASS' : 'FAIL'} | ${n}${d ? ' | ' + d : ''}`); };

const j = async (m, p, b, t, raw) => {
  const h = {};
  if (t) h.Authorization = 'Bearer ' + t;
  if (b !== undefined && !raw) h['Content-Type'] = 'application/json';
  if (raw) h['Content-Type'] = 'application/json';
  const r = await fetch(BASE + p, { method: m, headers: h, body: b === undefined ? undefined : (raw ? b : JSON.stringify(b)) });
  const txt = await r.text();
  let d = {};
  try { d = JSON.parse(txt); } catch (_) {}
  return { s: r.status, d, txt };
};

const upload = async (token, buf, filename, type) => {
  const fd = new FormData();
  fd.append('file', new Blob([buf], { type }), filename);
  const r = await fetch(BASE + '/api/mp/files', { method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: fd });
  let d = {};
  try { d = await r.json(); } catch (_) {}
  return { s: r.status, d };
};

async function adminToken() {
  for (let i = 0; i < 4; i++) {
    const r = await j('POST', '/api/auth/login', { password: PW });
    if (r.s !== 429 && r.d.token) return r.d.token;
    await new Promise((res) => setTimeout(res, 16000));
  }
  return '';
}

(async () => {
  const ADM = await adminToken();
  rec('管理员登录', !!ADM);

  const st = Date.now().toString(36);
  // 两个已审批用户
  const mk = async (tag) => {
    const r = await j('POST', '/api/mp/dev-login', { openid: `${tag}_${st}`, nickname: tag });
    await j('POST', `/api/users/${r.d.user.id}/approve`, {}, ADM);
    return { tok: r.d.token, uid: r.d.user.id };
  };
  const A = await mk('alice');
  const B = await mk('bob');
  rec('准备两个用户', !!A.tok && !!B.tok);

  // ---------- 1) IDOR：跨用户访问文件/任务 ----------
  const pdf = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n', 'utf8');
  let r = await upload(A.tok, pdf, 'alice.pdf', 'application/pdf');
  const aFile = r.d.file && r.d.file.id;
  rec('A 上传文件', !!aFile, `id=${aFile}`);

  r = await j('GET', `/api/mp/files/${aFile}/preview`, undefined, B.tok);
  rec('B 不能预览 A 的文件', r.s === 404 || r.s === 403, `status=${r.s}`);
  r = await j('DELETE', `/api/mp/files/${aFile}`, undefined, B.tok);
  rec('B 不能删除 A 的文件', r.s === 404 || r.s === 403, `status=${r.s}`);
  r = await j('GET', '/api/mp/files', undefined, B.tok);
  rec('B 的文件列表不含 A 的文件', !(r.d.files || []).some((f) => String(f.id) === String(aFile)));

  r = await j('POST', '/api/mp/print', { fileId: aFile, printer: 'X', options: { copies: 1 } }, B.tok);
  rec('B 不能用 A 的文件打印', r.s >= 400, `status=${r.s} ${r.d.msg || ''}`);
  r = await j('POST', '/api/mp/tasks/999999/cancel', {}, B.tok);
  rec('取消不存在的任务被拒', r.s >= 400, `status=${r.s}`);

  // ---------- 2) 畸形 token ----------
  for (const [name, tok] of [['空 token', ''], ['乱码 token', 'abc.def.ghi'], ['改签名', (A.tok || '').slice(0, -4) + 'AAAA']]) {
    r = await j('GET', '/api/mp/me', undefined, tok);
    rec(`${name} 被拒`, r.s === 401, `status=${r.s}`);
  }
  // 小程序 token 冒充管理员
  r = await j('GET', '/api/users', undefined, A.tok);
  rec('小程序 token 不能访问后台接口', r.s === 401 || r.s === 403, `status=${r.s}`);

  // ---------- 3) 打印参数边界 ----------
  const bad = [
    ['copies=0', { copies: 0 }],
    ['copies=-1', { copies: -1 }],
    ['copies=100000', { copies: 100000 }],
    ['copies="abc"', { copies: 'abc' }],
    ['options=null', null],
    ['options=[]', []]
  ];
  // 说明：本机没有 CUPS，503 会先于参数校验返回；这里只断言"不 500、不挂住"。
  // 有 CUPS 的环境（容器）里 400/503 都算通过，参数非法时必须是 400。
  for (const [name, opt] of bad) {
    r = await j('POST', '/api/mp/print', { fileId: aFile, printer: 'HP', options: opt }, A.tok);
    const okStatus = r.s === 400 || r.s === 503;
    rec(`打印参数 ${name} 不产生 500`, okStatus, `status=${r.s} ${r.d.msg || ''}`);
  }
  r = await j('POST', '/api/mp/print', { fileId: aFile, printer: '不存在的打印机', options: { copies: 1 } }, A.tok);
  rec('不存在的打印机被拒', r.s >= 400, `status=${r.s} ${r.d.msg || ''}`);
  r = await j('POST', '/api/mp/print', { fileId: 'abc', printer: 'HP', options: { copies: 1 } }, A.tok);
  rec('非法 fileId 被拒', r.s >= 400 && r.s < 500, `status=${r.s}`);

  // ---------- 4) 上传边界 ----------
  r = await upload(A.tok, Buffer.alloc(0), 'empty.pdf', 'application/pdf');
  rec('空文件被拒', r.s >= 400, `status=${r.s} ${r.d.msg || ''}`);
  r = await upload(A.tok, Buffer.from('<html><script>alert(1)</script></html>'), 'evil.pdf', 'application/pdf');
  rec('伪装扩展名的 HTML 被拒', r.s >= 400, `status=${r.s} ${r.d.msg || ''}`);

  // ---------- 5) 资料字段边界 ----------
  r = await j('PUT', '/api/mp/profile', { nickname: 'x'.repeat(500) }, A.tok);
  const nick = (r.d.user && r.d.user.nickname) || '';
  rec('超长昵称被截断', r.s === 200 && nick.length <= 64, `len=${nick.length}`);
  r = await j('PUT', '/api/mp/profile', { avatar: 'https://evil.example.com/a.png' }, A.tok);
  const av = (r.d.user && r.d.user.avatar) || '';
  rec('外链头像被拒', !av.includes('evil.example.com'), `avatar=${av || '(空)'}`);

  // ---------- 6) 路径穿越 / 非法 id ----------
  for (const p of ['/api/mp/avatar/..%2f..%2fpackage.json', '/api/mp/avatar/abc', '/api/mp/avatar/%2e%2e%2fprintgate.db']) {
    r = await j('GET', p);
    rec(`路径穿越 ${p.slice(18)} 被拒`, r.s === 404, `status=${r.s}`);
  }
  for (const id of ['abc', '-1', '1e9', '0']) {
    r = await j('GET', `/api/users/${id}`, undefined, ADM);
    rec(`非法用户 id ${id}`, r.s >= 400 && r.s < 500, `status=${r.s}`);
  }

  // 1e9 / 12abc 这类"能被 parseInt 糊弄过去"的 id 必须拒绝（否则会操作到别的用户）
  for (const id of ['1e9', '12abc', '1.9']) {
    r = await j('GET', `/api/users/${id}`, undefined, ADM);
    rec(`id 伪装 ${id} 被拒`, r.s === 404 || r.s === 400, `status=${r.s}`);
  }

  // ---------- 7) 畸形 JSON / 超大体积 ----------
  r = await j('POST', '/api/auth/login', '{"password":', undefined, true);
  rec('畸形 JSON 不返回 500', r.s >= 400 && r.s < 500, `status=${r.s}`);
  r = await j('POST', '/api/auth/login', null);
  rec('空 body 不返回 500', r.s >= 400 && r.s < 500, `status=${r.s}`);
  r = await j('POST', '/api/auth/login', [1, 2, 3]);
  rec('数组 body 不返回 500', r.s >= 400 && r.s < 500, `status=${r.s}`);

  // ---------- 8) 并发：同一任务重复审批 ----------
  const t2 = await j('POST', '/api/mp/print', { fileId: aFile, printer: 'HP', options: { copies: 1 } }, A.tok);
  const tid = t2.d.task && t2.d.task.id;
  if (tid) {
    const [x, y] = await Promise.all([
      j('POST', `/api/users/${A.uid}/approve`, {}, ADM),
      j('POST', `/api/users/${A.uid}/approve`, {}, ADM)
    ]);
    rec('并发审批用户不产生 500', x.s < 500 && y.s < 500, `${x.s}/${y.s}`);
    const [c1, c2] = await Promise.all([
      j('POST', `/api/mp/tasks/${tid}/cancel`, {}, A.tok),
      j('POST', `/api/mp/tasks/${tid}/cancel`, {}, A.tok)
    ]);
    const okCount = [c1, c2].filter((z) => z.s === 200).length;
    rec('并发取消同一任务只成功一次', okCount <= 1, `成功 ${okCount} 次 (${c1.s}/${c2.s})`);
  }

  // ---------- 9) 限流：连续登录失败 ----------
  let limited = false;
  for (let i = 0; i < 30; i++) {
    const z = await j('POST', '/api/auth/login', { password: 'wrong-' + i });
    if (z.s === 429) { limited = true; break; }
  }
  rec('连续错误密码触发限流', limited, '30 次内未触发');

  console.log(`\n合计 ${pass} 通过 / ${fail} 失败`);
  if (fail) console.log('失败项:\n - ' + bugs.join('\n - '));
  process.exit(fail ? 1 : 0);
})();
