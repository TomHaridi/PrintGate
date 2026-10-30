'use strict';
// 探测增强回归：端口判定、多路径、401 视为命中、强制添加
// 用法：BASE=http://127.0.0.1:8170 PG_DIR=/tmp/pg-force node tools/scan-probe-test.js
const http = require('http');
const net = require('net');
const fs = require('fs');

const BASE = process.env.BASE || 'http://127.0.0.1:8170';
const PW = process.env.PW || 'LocalTest2026';
const PG_DIR = process.env.PG_DIR || 'C:/Users/Administrator/AppData/Local/Temp/pg-force';

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
  rec('管理员登录', !!ADM);
  if (!ADM) process.exit(1);

  // 场景 A：端口全关（不可达）
  let r = await j('POST', '/api/scanners/network/probe', { host: '127.0.0.1:9' }, ADM);
  rec('不可达 → reason=unreachable', r.d.ok === false && r.d.reason === 'unreachable', `reason=${r.d.reason} open=${JSON.stringify(r.d.open)}`);
  rec('不可达时给出可执行提示', /IP|开机|防火墙/.test(r.d.msg || ''));
  rec('不可达时也允许强制添加', r.d.canForce === true);

  // 场景 B：只有 9100 开着（像只支持私有协议的打印机）
  const raw = net.createServer((s) => s.end());
  await new Promise((res) => raw.listen(9100, '127.0.0.1', res));
  r = await j('POST', '/api/scanners/network/probe', { host: '127.0.0.1' }, ADM);
  rec('有 9100 无 eSCL → reason=not-escl', r.d.ok === false && r.d.reason === 'not-escl', `reason=${r.d.reason} open=${(r.d.open || []).join(',')}`);
  rec('提示里给出「强制添加」出路', /强制添加/.test(r.d.msg || ''), (r.d.msg || '').slice(0, 30));
  rec('返回端口探测结果', Array.isArray(r.d.ports) && r.d.ports.some((x) => x.port === 9100 && x.ok));
  raw.close();

  // 场景 C：eSCL 需要认证（401）—— 应视为命中
  const auth = http.createServer((req, res) => {
    if (req.url.startsWith('/eSCL/')) { res.writeHead(401); res.end('auth'); return; }
    res.writeHead(404); res.end();
  });
  await new Promise((res) => auth.listen(9201, '127.0.0.1', res));
  r = await j('POST', '/api/scanners/network/probe', { host: '127.0.0.1:9201' }, ADM);
  rec('401 视为命中 eSCL', r.d.ok === true && r.d.auth === true, `ok=${r.d.ok} auth=${r.d.auth} hit=${r.d.hitUrl || ''}`);
  auth.close();

  // 场景 D：路径不在第一个（/eSCL 直接给 capabilities）
  const alt = http.createServer((req, res) => {
    if (req.url === '/eSCL') {
      res.writeHead(200, { 'Content-Type': 'text/xml' });
      res.end('<?xml version="1.0"?><scan:ScannerCapabilities xmlns:scan="x" xmlns:pwg="y"><pwg:MakeAndModel>Brother MFC-L2700</pwg:MakeAndModel></scan:ScannerCapabilities>');
      return;
    }
    res.writeHead(404); res.end();
  });
  await new Promise((res) => alt.listen(9202, '127.0.0.1', res));
  r = await j('POST', '/api/scanners/network/probe', { host: '127.0.0.1:9202' }, ADM);
  rec('能命中非常规路径', r.d.ok === true && /Brother/.test(r.d.model || ''), `hit=${r.d.hitUrl} model=${r.d.model}`);
  rec('记录探测明细', Array.isArray(r.d.steps) && r.d.steps.length >= 2, `steps=${(r.d.steps || []).length}`);
  alt.close();

  // 场景 E：强制添加不可达地址（探测失败仍写入）
  const conf = `${PG_DIR}/sane.d/airscan.conf`;
  r = await j('POST', '/api/scanners/network', { name: 'legacy-mfp', host: '127.0.0.1:9', force: true }, ADM);
  rec('强制添加成功', r.s === 200 && r.d.ok === true, r.d.msg || '');
  const text = fs.existsSync(conf) ? fs.readFileSync(conf, 'utf8') : '';
  rec('强制添加后 conf 已写入', /legacy-mfp/.test(text), text.split('\n').filter((l) => l.includes('legacy')).join(''));

  // 场景 F：不带 force 时仍然拒绝
  r = await j('POST', '/api/scanners/network', { name: 'should-fail', host: '127.0.0.1:9' }, ADM);
  rec('不强制时拒绝写入', r.s === 400 && r.d.canForce === true);

  // 清理
  await j('DELETE', '/api/scanners/network/legacy-mfp', undefined, ADM);

  console.log(`\n合计 ${pass} 通过 / ${fail} 失败`);
  if (fail) console.log('失败项:\n - ' + bugs.join('\n - '));
  process.exit(fail ? 1 : 0);
})();
