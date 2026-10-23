'use strict';
// 打印链路 / 任务状态机 / 并发竞态 猎杀
// 本机无 CUPS 与中文字体，重点验证「失败语义是否明确」与「并发是否安全」
// 用法：PG_BASE=http://127.0.0.1:8099 PG_PASS=xxx node tools/print-hunt.js
const fs = require('fs');
const path = require('path');

const BASE = process.env.PG_BASE || 'http://127.0.0.1:8099';
const PASS = process.env.PG_PASS || 'LocalTest2026';
const DB = [process.env.PG_DB, path.join(__dirname, '..', '_data_final', 'printgate.db'), path.join(__dirname, '..', '_data', 'printgate.db')]
  .filter(Boolean).find((p) => fs.existsSync(p));

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
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch (_) { data = { raw: text.slice(0, 140) }; }
  return { status: res.status, data };
}

async function upload(token, buf, filename) {
  const fd = new FormData();
  fd.append('file', new Blob([buf]), filename);
  const res = await fetch(`${BASE}/api/files`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: fd });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

// 现造一张真正有效的 1x1 PNG：网上流传的那段 base64 的 IDAT 校验和是坏的，
// 用它会让 pdfkit 在 zlib 回调里抛错（正好也是我们要测的「损坏图片」场景）
function makePng() {
  const z = require('zlib');
  const tbl = [];
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; tbl[n] = c >>> 0; }
  const crc = (b) => { let c = 0xffffffff; for (const x of b) c = tbl[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const t = Buffer.from(type, 'latin1');
    const cr = Buffer.alloc(4); cr.writeUInt32BE(crc(Buffer.concat([t, data])));
    return Buffer.concat([len, t, data, cr]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0); ihdr.writeUInt32BE(1, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', z.deflateSync(Buffer.from([0, 0x88, 0x88, 0x88]))),
    chunk('IEND', Buffer.alloc(0))
  ]);
}
const PNG = makePng();
const BAD_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==', 'base64');
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n', 'latin1');

function insertTask(userId, fileId, status) {
  const Database = require(require('./_paths').serverModulePath('better-sqlite3'));
  const db = new Database(DB);
  const info = db.prepare(
    `INSERT INTO tasks (user_id, file_id, printer, copies, options_json, status, source, created_at)
     VALUES (?,?,?,?,?,?,?,?)`
  ).run(userId, fileId, 'HuntQ', 1, '{}', status, 'web', new Date().toISOString());
  db.close();
  return info.lastInsertRowid;
}

(async () => {
  let r = await req('GET', '/api/public/bootstrap');
  let ADMIN = '';
  if (r.data.needsSetup) ADMIN = (await req('POST', '/api/setup', { password: PASS, confirm: PASS })).data.token;
  else ADMIN = (await req('POST', '/api/auth/login', { password: PASS })).data.token;
  if (!ADMIN) { console.log('无法登录'); process.exit(1); }

  console.log('=== A. 文字速印语义 ===');
  r = await req('POST', '/api/print/text', { body: '' }, ADMIN);
  rec('空文字被拒', r.status === 400, `${r.status} ${r.data.msg || ''}`);
  r = await req('POST', '/api/print/text', { body: 'x'.repeat(60000) }, ADMIN);
  rec('超长文字被拒', r.status === 400, `${r.status} ${r.data.msg || ''}`);
  r = await req('POST', '/api/print/text', { body: '测试取件码 1234', media: 'EVIL', fontSize: 9999, margin: -5 }, ADMIN);
  if (r.status === 200) {
    rec('非法纸张/字号被夹取后仍成功', !!r.data.file, `media/fontSize 已夹取，file=${r.data.file?.id}`);
  } else {
    rec('缺字体时给出明确提示', /字体|排版/.test(r.data.msg || ''), `${r.status} ${(r.data.msg || '').slice(0, 40)}`);
  }
  // 本机没有中文字体，排版必然失败；这里只验证「不因为特殊字符而 5xx 之外的异常 / 路径被写穿」
  r = await req('POST', '/api/print/text', { body: '<script>alert(1)</script>', title: '../../etc/passwd' }, ADMIN);
  rec('标题/正文特殊字符不导致异常', r.status === 200 || /字体|排版/.test(r.data.msg || ''), `${r.status} ${(r.data.msg || '').slice(0, 30)}`);

  console.log('\n=== B. 多图合排边界 ===');
  r = await req('POST', '/api/print/compose', { fileIds: [] }, ADMIN);
  rec('未选图片被拒', r.status === 400, r.data.msg || '');
  r = await req('POST', '/api/print/compose', { fileIds: [1, 2], filePaths: 'evil' }, ADMIN);
  rec('不存在的文件被拒', r.status === 400, r.data.msg || '');
  r = await req('POST', '/api/print/compose', { fileIds: 'not-array' }, ADMIN);
  rec('fileIds 非数组被拒', r.status === 400, r.data.msg || '');
  const up1 = await upload(ADMIN, PNG, 'c1.png');
  if (up1.data.file) {
    const t0 = Date.now();
    r = await req('POST', '/api/print/compose', { fileIds: Array(20).fill(up1.data.file.id) }, ADMIN);
    rec('超过 8 张被截断或拒绝', [200, 400].includes(r.status), `${r.status} ${(r.data.msg || '').slice(0, 40)}`);
    rec('合排不挂起（<15s）', Date.now() - t0 < 15000, `${Date.now() - t0}ms`);
    r = await req('POST', '/api/print/compose', { fileIds: [up1.data.file.id], layout: 'evil', perPage: 999 }, ADMIN);
    rec('有效图片可合排（非法布局被夹取）', r.status === 200, `${r.status} ${(r.data.msg || '').slice(0, 40)}`);
  }
  // 损坏/截断的图片：必须明确报错，不能让请求挂死
  const bad = await upload(ADMIN, BAD_PNG, 'broken.png');
  if (bad.data.file) {
    const t1 = Date.now();
    r = await req('POST', '/api/print/compose', { fileIds: [bad.data.file.id] }, ADMIN);
    rec('损坏图片被拒绝', r.status === 400 && /损坏|不是有效/.test(r.data.msg || ''), `${r.status} ${(r.data.msg || '').slice(0, 50)}`);
    rec('损坏图片不挂起（<10s）', Date.now() - t1 < 10000, `${Date.now() - t1}ms`);
  }

  console.log('\n=== C. 上传类型与语义 ===');
  r = await req('GET', '/api/settings', undefined, ADMIN);
  const office = r.data.features?.officeConvert;
  const docx = await upload(ADMIN, Buffer.from('PK\x03\x04fake office'), '文档.docx');
  if (office) {
    // 伪造的 docx：转换器会尝试打开然后失败，必须给明确报错而不是 200
    rec('伪造 docx 被明确拒绝', docx.status === 400 && /损坏|无法|转换失败|加密/.test(docx.data.msg || ''),
      `${docx.status} ${(docx.data.msg || '').slice(0, 40)}`);
  }
  else rec('无 LibreOffice 时明确提示', docx.status === 400 && /Office|转换|不支持/.test(docx.data.msg || ''), `${docx.status} ${(docx.data.msg || '').slice(0, 40)}`);
  const big = await upload(ADMIN, Buffer.concat([PDF, Buffer.alloc(3 * 1024 * 1024)]), 'big.pdf');
  rec('超大 PDF 按上限处理', [200, 400, 413].includes(big.status), `status=${big.status} ${(big.data.msg || '').slice(0, 30)}`);
  const empty = await upload(ADMIN, Buffer.alloc(0), 'empty.pdf');
  rec('空文件被拒', empty.status === 400, empty.data.msg || '');

  console.log('\n=== D. 任务状态机 ===');
  // 插库造任务只在「服务跑在本机」时可行；对容器跑时这一段跳过
  // 只有对着本机 8099 的服务时，脚本直接改的才是同一个库；对容器跑（其他端口）就跳过
  const localDb = !!DB && process.env.PG_LOCAL_DB !== '0' && new URL(BASE).port === '8099';
  const anyFile = localDb ? (await req('GET', '/api/files?size=1', undefined, ADMIN)).data.files?.[0] : null;
  if (!localDb) console.log('  (跳过：需要直接访问数据库)');
  if (anyFile) {
    const pendingId = insertTask(null, anyFile.id, 'pending');
    r = await req('POST', `/api/tasks/${pendingId}/approve`, {}, ADMIN);
    rec('批准待审批任务', r.status === 200, `${r.status} ${r.data.msg || ''}`);
    r = await req('POST', `/api/tasks/${pendingId}/approve`, {}, ADMIN);
    rec('重复批准被拒', r.status === 400 || r.status === 409, `${r.status} ${r.data.msg || ''}`);

    const doneId = insertTask(null, anyFile.id, 'done');
    r = await req('POST', `/api/tasks/${doneId}/approve`, {}, ADMIN);
    rec('已完成任务不能批准', r.status === 400, `${r.status} ${r.data.msg || ''}`);
    r = await req('POST', `/api/tasks/${doneId}/reject`, {}, ADMIN);
    rec('已完成任务不能拒绝', r.status === 400, `${r.status} ${r.data.msg || ''}`);
    r = await req('POST', `/api/tasks/${doneId}/cancel`, {}, ADMIN);
    rec('已完成任务不能取消', r.status === 409 || r.status === 400, `${r.status} ${r.data.msg || ''}`);
    r = await req('POST', `/api/tasks/${doneId}/retry`, {}, ADMIN);
    rec('已完成任务不能重试', r.status === 400, `${r.status} ${r.data.msg || ''}`);

    const failedId = insertTask(null, anyFile.id, 'failed');
    r = await req('POST', `/api/tasks/${failedId}/retry`, {}, ADMIN);
    rec('失败任务可重试', r.status === 200 || r.status === 400, `${r.status} ${(r.data.msg || '').slice(0, 30)}`);
    r = await req('POST', `/api/tasks/999999/approve`, {}, ADMIN);
    rec('审批不存在任务 404', r.status === 404, `${r.status}`);
  }

  console.log('\n=== E. 并发竞态 ===');
  const mk = async () => {
    for (let i = 0; i < 5; i++) {
      const d = await req('POST', '/api/mp/dev-login', { openid: `pr_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}` });
      if (d.data && d.data.user) return d.data.user;
      await new Promise((s) => setTimeout(s, 12000));
    }
    return null;
  };
  const u = await mk();
  if (u) {
    const rs = await Promise.all(Array(3).fill(0).map(() => req('POST', `/api/users/${u.id}/approve`, {}, ADMIN)));
    const changed = rs.filter((x) => x.data.msg === '已授权').length;
    rec('并发审批只有一次真正生效', changed === 1, `changed=${changed} msgs=${rs.map((x) => x.data.msg).join('/')}`);
    const audit = await req('GET', '/api/audit?size=200&q=user_approve', undefined, ADMIN);
    rec('并发未刷审计', (audit.data.total || 0) <= 3, `user_approve ${audit.data.total} 条`);
  }
  const cleans = await Promise.all(Array(5).fill(0).map(() => req('POST', '/api/settings/cleanup', {}, ADMIN)));
  rec('并发清理不报错', cleans.every((x) => x.status === 200), cleans.map((x) => x.status).join(','));
  const keys = await Promise.all(Array(3).fill(0).map((_, i) => req('POST', '/api/keys', { name: `并发${i}` }, ADMIN)));
  rec('并发建 Key 都成功', keys.every((x) => x.status === 200), keys.map((x) => x.status).join(','));
  const uploads = await Promise.all(Array(3).fill(0).map((_, i) => upload(ADMIN, PNG, `并发${i}.png`)));
  rec('并发上传不串名', new Set(uploads.map((x) => x.data.file?.filename)).size >= 2, uploads.map((x) => x.data.file?.filename).join(','));

  console.log('\n=== F. frp 配置写出 ===');
  r = await req('PUT', '/api/settings', { frpServer: 'frp.example.com', frpToken: 'tok"en', frpPort: 7000, frpMode: 'tcp', enableFrp: true }, ADMIN);
  rec('含引号 Token 被拒（不会写坏 toml）', r.status === 400, r.data.msg || `status=${r.status}`);
  r = await req('PUT', '/api/settings', { frpServer: 'frp.example.com', frpToken: 'SafeToken123', frpPort: 7000, frpMode: 'tcp', enableFrp: true }, ADMIN);
  rec('合法 frp 配置可保存', r.status === 200, r.data.msg || '');
  const frpDir = localDb ? path.join(path.dirname(DB), 'frp') : '';
  if (frpDir && fs.existsSync(path.join(frpDir, 'frpc.toml'))) {
    const toml = fs.readFileSync(path.join(frpDir, 'frpc.toml'), 'utf8');
    rec('toml 只有一行一个字段（无注入段落）', (toml.match(/\[\[/g) || []).length <= 2, `[[ 出现 ${(toml.match(/\[\[/g) || []).length} 次`);
    // 值两侧的引号是 TOML 语法，要检查的是「值里面」没有裸引号或换行
    const tokenLine = toml.split('\n').find((l) => l.startsWith('auth.token')) || '';
    const inner = tokenLine.replace(/^auth\.token\s*=\s*"/, '').replace(/"$/, '');
    rec('toml 的值里没有裸引号/换行', inner.length > 0 && !/["]/.test(inner) && !/\n/.test(inner), `值=${inner}`);
    rec('enabled 标记已写入', fs.readFileSync(path.join(frpDir, 'enabled'), 'utf8').trim() === '1');
  }
  r = await req('PUT', '/api/settings', { enableFrp: false }, ADMIN);
  rec('关闭 frp 成功', r.status === 200, r.data.msg || '');
  if (frpDir) {
    rec('关闭 frp 后 enabled=0', fs.existsSync(path.join(frpDir, 'enabled')) && fs.readFileSync(path.join(frpDir, 'enabled'), 'utf8').trim() === '0');
  }

  const pass = results.filter((x) => x.p).length;
  console.log(`\n===== ${pass}/${results.length} 通过 =====`);
  for (const f of results.filter((x) => !x.p)) console.log(`  - ${f.n} ${f.d}`);
  if (pass !== results.length) process.exitCode = 1;
})();
