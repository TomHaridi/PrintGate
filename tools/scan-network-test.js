'use strict';
// 网络扫描仪链路回归：eSCL 探测、airscan.conf 读写、接口行为
// 用法：BASE=http://127.0.0.1:8164 PG_DIR=/tmp/pg-scan node tools/scan-network-test.js
const http = require('http');
const fs = require('fs');
const path = require('path');

const BASE = process.env.BASE || 'http://127.0.0.1:8164';
const PW = process.env.PW || 'LocalTest2026';
const PG_DIR = process.env.PG_DIR || 'C:/Users/Administrator/AppData/Local/Temp/pg-scan';

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
  // 1) 起一个假的 eSCL 一体机
  const MOCK_PORT = 9111;
  const mock = http.createServer((req, res) => {
    if (req.url.startsWith('/eSCL/ScannerCapabilities')) {
      res.writeHead(200, { 'Content-Type': 'text/xml' });
      res.end(`<?xml version="1.0"?><scan:ScannerCapabilities xmlns:scan="http://schemas.hp.com/imaging/escl/2011/05/03" xmlns:pwg="http://www.pwg.org/schemas/2010/12/sm">
        <pwg:MakeAndModel>HP OfficeJet Pro 9010</pwg:MakeAndModel></scan:ScannerCapabilities>`);
      return;
    }
    res.writeHead(404); res.end('no');
  });
  await new Promise((r) => mock.listen(MOCK_PORT, '127.0.0.1', r));
  rec('假 eSCL 设备已启动', true, `127.0.0.1:${MOCK_PORT}`);

  const ADM = (await j('POST', '/api/auth/login', { password: PW })).d.token;
  rec('管理员登录', !!ADM);
  if (!ADM) { mock.close(); process.exit(1); }

  // 2) 初始状态
  let r = await j('GET', '/api/scanners/network', undefined, ADM);
  rec('网络扫描仪列表可读', r.s === 200 && Array.isArray(r.d.devices), `devices=${(r.d.devices || []).length}`);
  rec('返回容器网络信息', !!(r.d.network && r.d.network.advice), r.d.network ? `bridged=${r.d.network.bridged}` : '');

  // 3) 探测：非法地址
  r = await j('POST', '/api/scanners/network/probe', { host: 'not a host!!' }, ADM);
  rec('非法地址被拒', r.s === 400 || r.d.ok === false, `status=${r.s}`);

  // 4) 探测：不存在的地址
  r = await j('POST', '/api/scanners/network/probe', { host: '127.0.0.1:9', }, ADM);
  rec('无响应地址给出明确提示', r.d.ok === false && /eSCL|响应|连不上/.test(r.d.msg || ''), (r.d.msg || '').slice(0, 40));

  // 5) 探测：真实假设备
  r = await j('POST', '/api/scanners/network/probe', { host: `127.0.0.1:${MOCK_PORT}` }, ADM);
  rec('探测到 eSCL 设备', r.d.ok === true && r.d.protocol === 'eSCL', `model=${r.d.model || '-'}`);
  rec('解析出型号', /OfficeJet/.test(r.d.model || ''), r.d.model || '(空)');

  // 6) 添加设备（会写 airscan.conf）
  r = await j('POST', '/api/scanners/network', { name: 'office-jet', host: `127.0.0.1:${MOCK_PORT}` }, ADM);
  rec('添加网络扫描仪', r.s === 200 && r.d.ok === true, r.d.msg || '');
  const confPath = path.join(PG_DIR, 'sane.d', 'airscan.conf');
  const conf = fs.existsSync(confPath) ? fs.readFileSync(confPath, 'utf8') : '';
  rec('airscan.conf 已落盘', conf.includes('[devices]') && conf.includes('office-jet'), confPath);
  rec('conf 里的地址正确', conf.includes(`http://127.0.0.1:${MOCK_PORT}`), conf.split('\n').filter((l) => l.includes('office-jet'))[0] || '');

  // 7) 重复添加同名不产生重复项
  await j('POST', '/api/scanners/network', { name: 'office-jet', host: `127.0.0.1:${MOCK_PORT}` }, ADM);
  r = await j('GET', '/api/scanners/network', undefined, ADM);
  const dup = (r.d.devices || []).filter((d) => d.name === 'office-jet').length;
  rec('同名设备不会重复', dup === 1, `出现 ${dup} 次`);

  // 8) 添加时探测失败要拦住
  r = await j('POST', '/api/scanners/network', { name: 'ghost', host: '127.0.0.1:9' }, ADM);
  rec('探测不通的设备拒绝写入', r.s === 400 && r.d.ok === false, r.d.msg ? '已拒绝' : '');
  r = await j('GET', '/api/scanners/network', undefined, ADM);
  rec('拒绝后 conf 未污染', !(r.d.devices || []).some((d) => d.name === 'ghost'));

  // 9) 诊断接口
  r = await j('GET', '/api/scanners/diag', undefined, ADM);
  rec('diag 带 airscan 段', !!(r.d.airscan && r.d.airscan.conf), r.d.airscan ? r.d.airscan.conf : '');
  rec('diag 带网络判断', !!(r.d.network && typeof r.d.network.bridged === 'boolean'), r.d.network ? r.d.network.advice.slice(0, 40) : '');
  rec('diag 返回扫描仪枚举结果', Array.isArray(r.d.devices), `devices=${(r.d.devices || []).length}`);

  // 10) 删除
  r = await j('DELETE', '/api/scanners/network/office-jet', undefined, ADM);
  rec('删除网络扫描仪', r.s === 200 && r.d.ok === true, r.d.msg || '');
  const conf2 = fs.existsSync(confPath) ? fs.readFileSync(confPath, 'utf8') : '';
  rec('conf 中已移除', !conf2.includes('office-jet'));

  // 11) 权限：普通用户不能动
  const wx = await j('POST', '/api/mp/dev-login', { openid: 'scan_' + Date.now().toString(36), nickname: '扫描测试' });
  r = await j('GET', '/api/scanners/network', undefined, wx.d.token);
  rec('普通用户不能读网络扫描仪配置', r.s === 401 || r.s === 403, `status=${r.s}`);
  r = await j('POST', '/api/scanners/network', { name: 'x', host: '1.2.3.4' }, wx.d.token);
  rec('普通用户不能添加设备', r.s === 401 || r.s === 403, `status=${r.s}`);

  mock.close();
  console.log(`\n合计 ${pass} 通过 / ${fail} 失败`);
  if (fail) console.log('失败项:\n - ' + bugs.join('\n - '));
  process.exit(fail ? 1 : 0);
})();
