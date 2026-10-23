'use strict';
// 扫描链路专项：组件缺失 / 未挂载 USB / 无驱动 三种情况是否都给出可执行的提示
// 本机（Windows）没有 sane，正好覆盖「未安装」这一支；容器内跑会覆盖另外两支
// 用法：PG_BASE=http://127.0.0.1:8099 PG_PASS=xxx node tools/scan-hunt.js
const BASE = process.env.PG_BASE || 'http://127.0.0.1:8099';
const PASS = process.env.PG_PASS || 'LocalTest2026';

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

(async () => {
  let r = await req('GET', '/api/public/bootstrap');
  let ADMIN = '';
  if (r.data.needsSetup) ADMIN = (await req('POST', '/api/setup', { password: PASS, confirm: PASS })).data.token;
  else ADMIN = (await req('POST', '/api/auth/login', { password: PASS })).data.token;
  if (!ADMIN) { console.log('无法登录'); process.exit(1); }

  console.log('=== A. 扫描仪列表语义 ===');
  r = await req('GET', '/api/scanners', undefined, ADMIN);
  rec('扫描接口不 500', r.status === 200, `status=${r.status}`);
  rec('返回 sane 安装状态字段', 'sane' in r.data, `sane=${r.data.sane}`);
  if (r.data.sane === false) {
    rec('未安装时提示可执行', /sane|scanimage|community/i.test(r.data.msg || ''), (r.data.msg || '').slice(0, 60));
  } else {
    rec('已安装时给出设备数', Array.isArray(r.data.devices), `${(r.data.devices || []).length} 台`);
    if (!(r.data.devices || []).length) {
      rec('无设备时提示挂载方式', /usb|network_mode|网段|驱动/i.test(r.data.msg || ''), (r.data.msg || '').slice(0, 60));
    }
  }

  console.log('\n=== B. 诊断接口 ===');
  r = await req('GET', '/api/scanners/diag', undefined, ADMIN);
  rec('诊断接口可用', r.status === 200 && 'saneInstalled' in r.data, `saneInstalled=${r.data.saneInstalled}`);
  rec('给出三条排障指引', !!(r.data.hints && r.data.hints.install && r.data.hints.usb && r.data.hints.network),
    JSON.stringify(r.data.hints || {}).slice(0, 70));
  rec('USB 层探测结果可读', Array.isArray(r.data.usb), `${(r.data.usb || []).length} 个`);
  rec('诊断信息不外泄系统路径', !JSON.stringify(r.data).includes('/etc/shadow'), '');
  r = await req('GET', '/api/scanners/diag', undefined, '');
  rec('诊断需鉴权', r.status === 401, `status=${r.status}`);

  console.log('\n=== C. 扫描请求的边界 ===');
  r = await req('POST', '/api/scanners/scan', { device: 'made-up-device' }, ADMIN);
  rec('未识别设备不能扫描', r.status === 400 && /重新检测|不是已识别/.test(r.data.msg || ''), r.data.msg || `status=${r.status}`);
  r = await req('POST', '/api/scanners/scan', {}, ADMIN);
  rec('缺 device 被拒', r.status === 400, r.data.msg || `status=${r.status}`);
  r = await req('POST', '/api/scanners/scan', { device: 'x', resolution: 99999, pages: 999 }, ADMIN);
  rec('极端参数不崩', [400, 500].includes(r.status) === false ? true : r.status === 400, `status=${r.status}`);
  // 编码过的 ../ 也要挡住（设备名最终会进 argv）
  r = await req('GET', '/api/scanners/' + encodeURIComponent('../../etc/passwd') + '/options', undefined, ADMIN);
  rec('设备名穿越被拒', r.status === 400 || r.status === 404, `status=${r.status} ${r.data.msg || ''}`);
  r = await req('GET', '/api/scanners/' + encodeURIComponent('x; rm -rf /') + '/options', undefined, ADMIN);
  rec('设备名含 shell 元字符被拒', r.status === 400, `status=${r.status} ${r.data.msg || ''}`);
  r = await req('POST', '/api/scanners/scan', { device: 'x`id`' }, ADMIN);
  rec('扫描设备名反引号被拒', r.status === 400, r.data.msg || `status=${r.status}`);

  console.log('\n=== D. 扫描记录 ===');
  r = await req('GET', '/api/scanners', undefined, ADMIN);
  rec('记录列表可读', Array.isArray(r.data.records), `${(r.data.records || []).length} 条`);
  r = await req('DELETE', '/api/scanners/records/999999', undefined, ADMIN);
  rec('删除不存在记录 404', r.status === 404, `status=${r.status}`);
  r = await req('GET', '/api/scanners/records/999999/download', undefined, ADMIN);
  rec('下载不存在记录 404', r.status === 404, `status=${r.status}`);
  r = await req('GET', '/api/scanners', undefined, '');
  rec('未登录不能看扫描仪', r.status === 401, `status=${r.status}`);

  const pass = results.filter((x) => x.p).length;
  console.log(`\n===== ${pass}/${results.length} 通过 =====`);
  for (const f of results.filter((x) => !x.p)) console.log(`  - ${f.n} ${f.d}`);
  if (pass !== results.length) process.exitCode = 1;
})();
