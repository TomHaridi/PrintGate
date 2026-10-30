// 端上合成图（文字/发票/身份证）上传时带可读文件名：验证服务端只认名字、不认类型
// 覆盖：正常中文名 / 无后缀 / 类型不符 / 路径穿越 / 空名字 / 分片上传
const B = process.env.BASE || 'http://127.0.0.1:8220';
const PW = process.env.PG_PASS || 'LocalTest2026';

let pass = 0, fail = 0;
const rec = (name, ok, detail = '') => {
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'} | ${name}${detail ? ' | ' + detail : ''}`);
};

const j = async (m, p, b, t) => {
  const h = {};
  if (t) h.Authorization = 'Bearer ' + t;
  if (b !== undefined) h['Content-Type'] = 'application/json';
  const r = await fetch(B + p, { method: m, headers: h, body: b === undefined ? undefined : JSON.stringify(b) });
  return { s: r.status, d: await r.json().catch(() => ({})) };
};

// 最小合法 PNG（1x1）
const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489' +
  '0000000a49444154789c6360000000020001e221bc330000000049454e44ae426082', 'hex');

async function mkUser(nick) {
  const st = Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
  const u = await j('POST', '/api/auth/account/register', {
    username: 'fn_' + st, password: 'Passw0rd123', confirm: 'Passw0rd123', nickname: nick
  });
  const adm = (await j('POST', '/api/auth/login', { password: PW })).d.token;
  await j('POST', '/api/users/' + u.d.user.id + '/approve', {}, adm);
  return u.d.token;
}

async function uploadAs(token, filename, mime = 'image/png') {
  const fd = new FormData();
  fd.append('file', new Blob([PNG], { type: mime }), 'tmp_wxfile_001.png');
  if (filename !== undefined) fd.append('filename', filename);
  const r = await fetch(B + '/api/mp/files', {
    method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: fd
  });
  return { s: r.status, d: await r.json().catch(() => ({})) };
}

(async () => {
  const tok = await mkUser('名字测试');

  // 1) 正常中文名
  const a = await uploadAs(tok, '文字速印.png');
  rec('中文名生效', a.s === 200 && a.d.file && a.d.file.filename === '文字速印.png', JSON.stringify(a.d.file && a.d.file.filename));

  // 2) 不带名字 → 保持上传原名
  const b = await uploadAs(tok, undefined);
  rec('不传名字保持原名', b.s === 200 && /^tmp_/.test(b.d.file.filename), b.d.file && b.d.file.filename);

  // 3) 没后缀 → 补真实后缀
  const c = await uploadAs(tok, '发票合排');
  rec('无后缀补 .png', c.s === 200 && c.d.file.filename === '发票合排.png', c.d.file && c.d.file.filename);

  // 4) 类型不符（想改名成 pdf）→ 强制回真实后缀
  const d = await uploadAs(tok, '发票合排.pdf');
  rec('改后缀不生效（仍是 png）', d.s === 200 && /\.png$/.test(d.d.file.filename), d.d.file && d.d.file.filename);

  // 5) 路径穿越 → 只留基名
  const e = await uploadAs(tok, '../../etc/passwd');
  rec('路径穿越被削平', e.s === 200 && !e.d.file.filename.includes('/') && !e.d.file.filename.includes('..'), e.d.file && e.d.file.filename);

  // 6) 空名字 / 纯空格 → 忽略
  const f = await uploadAs(tok, '   ');
  rec('空白名字被忽略', f.s === 200 && /^tmp_/.test(f.d.file.filename), f.d.file && f.d.file.filename);

  // 7) 分片上传仍然按 init 的 filename 存
  const init = await j('POST', '/api/mp/upload/init', { filename: '身份证合排.png', size: PNG.length, mime: 'image/png' }, tok);
  rec('分片 init 成功', init.s === 200 && !!init.d.uploadId, init.d.msg || '');
  if (init.d.uploadId) {
    const fd = new FormData();
    fd.append('chunk', new Blob([PNG], { type: 'image/png' }), 'chunk');
    fd.append('uploadId', init.d.uploadId);
    fd.append('index', '0');
    const up = await fetch(B + '/api/mp/upload/chunk', { method: 'POST', headers: { Authorization: 'Bearer ' + tok }, body: fd });
    rec('分片上传成功', up.status === 200, String(up.status));
    const done = await j('POST', '/api/mp/upload/complete', { uploadId: init.d.uploadId }, tok);
    rec('分片合并保留文件名', done.s === 200 && done.d.file && done.d.file.filename === '身份证合排.png', done.d.file && done.d.file.filename);
  }

  // 8) 列表里能看到新名字（打印记录读的就是这个字段）
  const list = await j('GET', '/api/mp/files', undefined, tok);
  const names = (list.d.files || []).map((x) => x.filename);
  rec('文件列表用可读名', names.includes('文字速印.png'), names.slice(0, 3).join(','));

  console.log(`\n合计 ${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('异常:', e); process.exit(1); });
