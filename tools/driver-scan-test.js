'use strict';
// 扫描 + 驱动中心回归测试
// 用法：PG_BASE=http://127.0.0.1:8080 PG_PASS=xxx PG_MOCK_IP=172.17.0.x node tools/driver-scan-test.js
const fs = require('fs');
const os = require('os');
const path = require('path');

const BASE = process.env.PG_BASE || 'http://127.0.0.1:8080';
const PASS = process.env.PG_PASS || 'LocalTest2026';
const MOCK_IP = process.env.PG_MOCK_IP || '';

let TOKEN = '';
const results = [];
const rec = (name, pass, detail = '') => {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  —  ${detail}` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function req(method, url, body, { raw = false, token = TOKEN } = {}) {
  const opt = { method, headers: {} };
  if (token) opt.headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) {
    if (raw) { opt.body = body; } else {
      opt.headers['Content-Type'] = 'application/json';
      opt.body = JSON.stringify(body);
    }
  }
  const r = await fetch(`${BASE}${url}`, opt);
  const text = await r.text();
  let data;
  try { data = JSON.parse(text); } catch (_) { data = { raw: text.slice(0, 200) }; }
  return { status: r.status, data };
}

function ppdText(model = 'PrintGate Test Printer') {
  return [
    '*PPD-Adobe: "4.3"',
    `*Manufacturer: "PrintGate"`,
    `*ModelName: "${model}"`,
    '*ShortNickName: "PrintGate Test"',
    '*NickName: "PrintGate Test Printer"',
    '*PCFileName: "pgtest.ppd"',
    '*cupsFilter: "application/vnd.cups-raster 0 rastertopdf"',
    '*OpenUI *PageSize: PickOne',
    '*DefaultPageSize: A4',
    '*PageSize A4/A4: "<</PageSize[595 842]>>setpagedevice"',
    '*CloseUI: *PageSize',
    '*DefaultResolution: 300dpi',
    '*Resolution 300dpi/300 DPI: "<</HWResolution[300 300]>>setpagedevice"'
  ].join('\n');
}

async function uploadPpd(text, filename) {
  const fd = new FormData();
  fd.append('file', new Blob([text], { type: 'application/vnd.cups-ppd' }), filename);
  const r = await fetch(`${BASE}/api/drivers/upload`, {
    method: 'POST', headers: { Authorization: `Bearer ${TOKEN}` }, body: fd
  });
  return { status: r.status, data: await r.json().catch(() => ({})) };
}

(async () => {
  console.log(`== 目标 ${BASE} ==`);

  // 0. 初始化 / 登录
  let r = await req('GET', '/api/public/bootstrap', undefined, { token: null });
  if (r.data.needsSetup) {
    r = await req('POST', '/api/setup', { password: PASS, confirm: PASS }, { token: null });
    TOKEN = r.data.token;
    rec('初始化并登录', !!TOKEN, '首次部署');
  } else {
    r = await req('POST', '/api/auth/login', { password: PASS }, { token: null });
    TOKEN = r.data.token;
    rec('管理员登录', !!TOKEN, r.data.msg || '');
  }
  if (!TOKEN) process.exit(1);

  console.log('\n== A. 本地驱动库 ==');
  r = await req('GET', '/api/drivers?q=');
  const ids = (r.data.items || []).map((x) => x.id);
  rec('驱动列表包含 everywhere / raw', ids.includes('everywhere') && ids.includes('raw'), `${ids.length} 项`);
  r = await req('GET', '/api/drivers?q=laserjet');
  rec('按型号搜索本地驱动', r.status === 200 && Array.isArray(r.data.items), `${(r.data.items || []).length} 项`);

  console.log('\n== B. 驱动推荐 ==');
  r = await req('POST', '/api/drivers/recommend', {
    uri: 'socket://192.168.1.50:9100', kind: 'socket',
    model: 'HP LaserJet 1022', deviceId: 'MFG:HP;MDL:HP LaserJet 1022;CMD:PCL5C,PCLXL;'
  });
  rec('PCL 设备推荐到 PCL 通用/同名驱动', !!r.data.id && /pxl|gener|HP/i.test(`${r.data.id} ${r.data.label}`),
    `${r.data.id} / ${r.data.label}`);
  r = await req('POST', '/api/drivers/recommend', {
    uri: 'ipp://192.168.1.60:631/ipp/print', kind: 'ipp',
    model: 'Brother HL-L2350DW', deviceId: '', driverless: true, formats: ['image/pwg-raster', 'application/pdf']
  });
  rec('支持 PWG 的 IPP 设备推荐 everywhere', r.data.id === 'everywhere', `${r.data.id} / ${r.data.label}`);
  r = await req('POST', '/api/drivers/recommend', { uri: 'socket://10.0.0.9:9100', kind: 'socket', model: '' });
  rec('信息不足时兜底 raw', r.data.id === 'raw', `${r.data.id} / ${r.data.label}`);

  console.log('\n== C. 上传驱动并建队列 ==');
  r = await uploadPpd(ppdText(), 'pg-test.ppd');
  const uploaded = r.data.driver;
  rec('上传 PPD 成功', r.status === 200 && !!uploaded?.id, uploaded?.label || r.data.msg);
  r = await uploadPpd('hello, not a ppd', 'bad.txt');
  rec('非 PPD 文件被拒', r.status === 400, r.data.msg || String(r.status));
  r = await uploadPpd(ppdText(), 'pg-test.zip');
  rec('伪装扩展名的文本仍能识别为 PPD', r.status === 200, r.data.msg || '');

  if (uploaded?.id) {
    r = await req('POST', '/api/printers', {
      name: 'PG-Test-PPD', uri: 'socket://127.0.0.1:9100', model: uploaded.id, info: 'PPD 测试'
    });
    rec('用导入的 PPD 建队列', r.status === 200, r.data.msg || '');
    r = await req('GET', '/api/printers');
    const q = (r.data.printers || []).find((p) => p.name === 'PG-Test-PPD');
    rec('队列出现在列表中', !!q, q ? q.uri : '');
    await req('DELETE', '/api/printers/PG-Test-PPD');
  }
  r = await req('POST', '/api/printers', { name: 'PG-Bad-Model', uri: 'socket://127.0.0.1:9100', model: '/etc/passwd' });
  rec('非法驱动标识被拒', r.status === 400, r.data.msg || '');

  console.log('\n== D. 在线驱动库 ==');
  r = await req('GET', '/api/drivers/online/vendors');
  const vendors = r.data.vendors || [];
  rec('在线驱动库厂商列表', vendors.length > 0, `${vendors.length} 个厂商：${vendors.slice(0, 6).join(',')}`);
  r = await req('GET', '/api/drivers/online/search?q=officejet&vendor=HP');
  const items = r.data.items || [];
  rec('在线按型号检索', items.length > 0, `${items.length} 个结果${items[0] ? `，首个 ${items[0].file}` : ''}`);
  r = await req('GET', '/api/drivers/online/search?q=&vendor=HP');
  rec('只选厂商时列出全部机型', r.status === 200 && (r.data.items || []).length > 0,
    `${(r.data.items || []).length} 项`);
  r = await req('GET', '/api/drivers/online/search?q=&vendor=');
  rec('空关键词且无厂商时给出提示', r.status === 400, r.data.msg || '');
  if (items.length) {
    r = await req('POST', '/api/drivers/online/install', { url: items[0].url, name: items[0].name });
    rec('在线导入驱动', r.status === 200 && !!r.data.driver, r.data.msg || r.data.driver?.label || '');
    if (r.data.driver?.id) await req('DELETE', `/api/drivers/stored/${encodeURIComponent(r.data.driver.id)}`);
  }
  r = await req('POST', '/api/drivers/online/install', { url: 'https://evil.example.com/x.ppd' });
  rec('非官方在线地址被拒', r.status === 400, r.data.msg || '');

  console.log('\n== E. 下载防护 ==');
  r = await req('POST', '/api/drivers/download', { url: 'http://127.0.0.1:8080/api/health' });
  rec('内网地址下载被拒（SSRF）', r.status === 400, r.data.msg || '');
  r = await req('POST', '/api/drivers/download', { url: 'file:///etc/passwd' });
  rec('非 http 协议被拒', r.status === 400, r.data.msg || '');

  console.log('\n== F. 扫描 ==');
  r = await req('GET', '/api/printers/discover/subnets');
  rec('返回本机网段与常用网段', (r.data.subnets || []).length > 0 && (r.data.commonCidrs || []).length > 0,
    `本机 ${(r.data.subnets || []).map((s) => s.cidr).join(',')}｜常用 ${(r.data.commonCidrs || []).length} 个`);
  r = await req('POST', '/api/printers/discover/cidr', { cidr: 'not-a-cidr' });
  rec('非法网段被拒', r.status === 400, r.data.msg || '');
  r = await req('POST', '/api/printers/discover/cidr', { cidr: '192.168.77.0/24' });
  rec('保存扫描网段', r.status === 200 && r.data.cidr === '192.168.77.0/24', r.data.cidr || '');

  r = await req('POST', '/api/printers/discover/probe', { host: '!!!' });
  rec('非法探测地址被拒', r.status === 400, r.data.msg || '');

  if (MOCK_IP) {
    r = await req('POST', '/api/printers/discover/probe', { host: MOCK_IP });
    const dev = r.data.device;
    rec('手动探测识别真实 IPP 设备', r.status === 200 && !!dev, dev ? `${dev.uri} | ${dev.model}` : r.data.msg);
    if (dev) {
      rec('探测结果带型号', /LaserJet/i.test(dev.model || ''), dev.model || '');
      rec('探测命中 /ipp/print 路径', dev.pathConfidence === 'confirmed', dev.pathConfidence || '');
      rec('探测结果含 RAW 备选地址', (dev.altUris || []).some((u) => u.startsWith('socket://')),
        (dev.altUris || []).join(', '));
    }

    const cidr = `${MOCK_IP.split('.').slice(0, 3).join('.')}.0/24`;
    r = await req('POST', '/api/printers/discover/start', { mode: 'deep', cidr });
    const sid = r.data.id;
    rec('启动深度扫描', !!sid, cidr);
    let sess = null;
    for (let i = 0; i < 60; i++) {
      await sleep(1000);
      const d = await req('GET', `/api/printers/discover/${sid}`);
      sess = d.data;
      if (sess.status !== 'running') break;
    }
    rec('扫描完成', sess && sess.status === 'done', sess ? sess.stage : '');
    const hit = (sess?.found || []).find((f) => f.host === MOCK_IP);
    rec('扫描发现假打印机', !!hit, hit ? `${hit.kind} ${hit.uri}` : `未命中，共 ${(sess?.found || []).length} 条`);
    if (hit) {
      rec('扫描结果含真实型号', /LaserJet/i.test(hit.model || ''), hit.model || '');
      rec('扫描结果无重复条目', (sess.found || []).filter((f) => f.host === MOCK_IP).length === 1, '按 host 合并');
      const d = await req('POST', '/api/drivers/recommend', {
        uri: hit.uri, kind: hit.kind, model: hit.model, deviceId: hit.deviceId,
        formats: hit.formats || [], driverless: !!hit.driverless
      });
      rec('对扫描结果给出推荐驱动', !!d.data.id, `${d.data.id} / ${d.data.label}`);
    }
  } else {
    rec('扫描用例（需要 PG_MOCK_IP）', true, '已跳过');
  }

  console.log('\n== G. 移动端/兼容性接口 ==');
  r = await req('GET', '/api/printers/models?q=laser');
  rec('驱动型号接口可用', r.status === 200 && Array.isArray(r.data.models), `${(r.data.models || []).length} 项`);

  const fails = results.filter((x) => !x.pass);
  console.log(`\n总计 ${results.length} 项，失败 ${fails.length} 项`);
  if (fails.length) fails.forEach((f) => console.log(' -', f.name, f.detail));
  fs.writeFileSync(path.join(require('./_paths').shotsDir(), 'driver-scan.json'), JSON.stringify(results, null, 2));
  process.exit(fails.length ? 1 : 0);
})();
