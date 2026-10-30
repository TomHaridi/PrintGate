'use strict';
// 服务地址记忆 + 局域网扫描的纯逻辑测试（mock wx.request / storage，不需要微信环境）
// 用法：node tools/mp-lanscan-test.js
const path = require('path');

// ---- mock wx ----
const store = {};
let hitBases = new Set();
let requestCount = 0;
let requestDelay = 0;

global.wx = {
  getStorageSync: (k) => (k in store ? store[k] : ''),
  setStorageSync: (k, v) => { store[k] = v; },
  removeStorageSync: (k) => { delete store[k]; },
  getSystemInfoSync: () => ({ platform: 'devtools' }),
  request({ url, success, fail }) {
    requestCount++;
    const base = String(url).replace('/api/health', '');
    const done = () => {
      if (hitBases.has(base)) success({ statusCode: 200, data: { ok: true, app: 'PrintGate', version: '2.4.22' } });
      else fail({ errMsg: 'request:fail' });
    };
    if (requestDelay) setTimeout(done, requestDelay); else setImmediate(done);
  }
};

const cfg = require(path.join(__dirname, '..', 'miniprogram', 'utils', 'config.js'));
const lanscan = require(path.join(__dirname, '..', 'miniprogram', 'utils', 'lanscan.js'));

let pass = 0, fail = 0;
const rec = (n, ok, d = '') => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'} | ${n}${d ? ' | ' + d : ''}`); };

(async () => {
  // ---------- 地址规范化 ----------
  const cases = [
    ['192.168.1.10:8080', 'http://192.168.1.10:8080', '局域网补 http'],
    ['10.0.0.5:8080', 'http://10.0.0.5:8080', '10 段补 http'],
    ['print.example.com', 'https://print.example.com', '公网补 https'],
    ['https://a.com///', 'https://a.com', '去尾斜杠'],
    ['', '', '空返回空']
  ];
  for (const [inp, want, desc] of cases) {
    rec(desc, cfg.normalize(inp) === want, `${JSON.stringify(inp)} → ${JSON.stringify(cfg.normalize(inp))}`);
  }

  // ---------- 历史地址 ----------
  cfg.setBaseUrl('http://192.168.1.100:8080');
  rec('保存后能读回', cfg.getBaseUrl() === 'http://192.168.1.100:8080', cfg.getBaseUrl());
  cfg.setBaseUrl('http://192.168.1.101:8080');
  cfg.setBaseUrl('http://192.168.1.100:8080');   // 重复 → 提到最前
  const h = cfg.getHistory();
  rec('历史去重且最新在前', h[0] === 'http://192.168.1.100:8080' && h.length === 2, h.join(' , '));

  for (let i = 0; i < 8; i++) cfg.setBaseUrl(`http://10.0.0.${i + 1}:8080`);
  rec('历史最多 5 条', cfg.getHistory().length === 5, `${cfg.getHistory().length} 条`);

  cfg.removeHistory('http://10.0.0.8:8080');
  rec('可单条删除', !cfg.getHistory().includes('http://10.0.0.8:8080'));

  // 真机（非 devtools）没有 storage 时不回落 127.0.0.1
  for (const k of Object.keys(store)) delete store[k];
  wx.getSystemInfoSync = () => ({ platform: 'android' });
  rec('真机无存储时地址为空（不回落 127.0.0.1）', cfg.getBaseUrl() === '', `"${cfg.getBaseUrl()}"`);
  wx.getSystemInfoSync = () => ({ platform: 'devtools' });
  rec('开发者工具回落默认地址', /127\.0\.0\.1/.test(cfg.getBaseUrl()), cfg.getBaseUrl());

  // ---------- 扫描 ----------
  const cand = lanscan.candidates();
  rec('候选地址数量合理（100~400）', cand.length > 100 && cand.length < 400, `${cand.length} 个`);
  rec('候选都带协议与端口', cand.every((u) => /^https?:\/\/[\d.]+:\d+$/.test(u)));
  rec('指定网段时扫 254 个', lanscan.candidates('192.168.1.').length === 254);

  hitBases = new Set(['http://192.168.1.100:8080']);
  let progressHits = 0, foundHits = 0;
  const r = await lanscan.scan({
    concurrency: 8,
    onProgress: () => { progressHits++; },
    onFound: () => { foundHits++; }
  });
  rec('能扫到目标服务', r.found.length === 1 && r.found[0].base === 'http://192.168.1.100:8080',
    JSON.stringify(r.found.map((x) => x.base)));
  rec('带回服务端版本', r.found[0] && r.found[0].version === '2.4.22', r.found[0] && r.found[0].version);
  rec('扫描过程有进度回调', progressHits > 0, `${progressHits} 次`);
  rec('命中只回调一次', foundHits === 1, `${foundHits} 次`);

  // 无命中
  hitBases = new Set();
  const r2 = await lanscan.scan({ concurrency: 8 });
  rec('无命中时返回空列表', r2.found.length === 0 && r2.total === cand.length, `total=${r2.total}`);

  // 中止：shouldStop 立刻返回 → 不应该再打满所有请求
  requestCount = 0;
  const r3 = await lanscan.scan({ concurrency: 4, shouldStop: () => true });
  rec('可中止（停止后不再发请求）', r3.found.length === 0 && requestCount === 0, `${requestCount} 次请求`);

  // 慢请求下也只在超时内结束（这里只验证并发生效：延迟 30ms 时总耗时远小于串行）
  requestDelay = 20;
  const t0 = Date.now();
  await lanscan.scan({ concurrency: 12 });
  const ms = Date.now() - t0;
  rec('并发生效（242 个请求明显快于串行）', ms < cand.length * 20 * 0.5, `${ms}ms / 串行约 ${cand.length * 20}ms`);
  requestDelay = 0;

  console.log(`\n合计 ${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})();
