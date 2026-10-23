'use strict';
// 小程序「参数记忆 + 打印机可用性判断」逻辑测试（不涉及 UI，直接跑模块）
// 用法：node tools/mp-prefs-test.js [小程序目录]

const path = require('path');
const ROOT = process.argv[2] || require('path').join(require('./_paths').projectRoot(), 'miniprogram');

// hasMiniprogramGuard
// 交付包允许裁剪小程序源码：缺 miniprogram/ 时直接跳过，别让回归里全是崩溃
if (!require('fs').existsSync(require('path').join(ROOT, 'app.json'))) {
  console.log('跳过：当前包未包含 miniprogram/（小程序源码已裁剪），本检查不适用');
  process.exit(0);
}


// 模拟小程序 Storage API，让模块能在 Node 下直接跑
const store = {};
global.wx = {
  setStorageSync: (k, v) => { store[k] = v; },
  getStorageSync: (k) => (k in store ? store[k] : ''),
  removeStorageSync: (k) => { delete store[k]; }
};

const prefs = require(path.join(ROOT, 'utils/prefs.js'));
const device = require(path.join(ROOT, 'utils/printer.js'));

const results = [];
const rec = (n, p, d = '') => {
  results.push({ n, p, d });
  console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? `  —  ${d}` : ''}`);
};

// ---------- 参数记忆 ----------
console.log('== 参数记忆 ==');
let d = prefs.load();
rec('无存储时返回默认值', d.copies === 1 && d.color === 'mono' && d.media === 'A4', JSON.stringify(d));

prefs.save({ copies: 5, color: 'color', sides: 'two-sided-long-edge', media: 'A3', numberUp: 4, mirror: true });
d = prefs.load();
rec('保存后能读回', d.copies === 5 && d.color === 'color' && d.media === 'A3' && d.numberUp === 4 && d.mirror === true,
  JSON.stringify(d));

// 越界 / 非法值必须被纠正，否则会把脏数据喂给后端
prefs.save({ copies: 999, color: 'rainbow', sides: 'three-sided', media: 'A9', numberUp: 77, mirror: 'yes' });
d = prefs.load();
rec('份数越界被夹到 99', d.copies === 99, String(d.copies));
rec('非法颜色回退黑白', d.color === 'mono', d.color);
rec('非法双面回退单面', d.sides === 'one-sided', d.sides);
rec('非法纸张回退 A4', d.media === 'A4', d.media);
rec('非法每页页数回退 1', d.numberUp === 1, String(d.numberUp));
rec('镜像只接受布尔', d.mirror === true, String(d.mirror));

// 存储被写坏不能崩
store['pg_print_prefs'] = '{{{坏数据';
d = prefs.load();
rec('存储损坏时不崩溃', d && d.copies === 1, JSON.stringify(d));

prefs.save({ copies: 7 });
prefs.clear();
d = prefs.load();
rec('恢复默认后回到初始值', d.copies === 1 && d.color === 'mono', JSON.stringify(d));

// 与网页端保持一致的字段（不含一次性内容）
const keys = Object.keys(prefs.FIELDS).sort().join(',');
rec('只记稳定字段', !keys.includes('pageRanges') && !keys.includes('watermark'), keys);

// ---------- 打印机可用性 ----------
console.log('\n== 打印机可用性 ==');
const list = [
  { name: 'HP-1022', isDefault: true, enabled: false, accepting: true, state: 'stopped' },
  { name: 'PrintGate-Virtual', isDefault: false, enabled: true, accepting: true, state: 'idle' },
  { name: 'Backup', isDefault: false, enabled: true, accepting: false, state: 'idle' }
];

rec('停用队列判定为不可用', device.usable(list[0]) === false);
rec('正常队列判定为可用', device.usable(list[1]) === true);
rec('拒收队列判定为不可用', device.usable(list[2]) === false);
rec('空值不崩', device.usable(null) === false && device.usable(undefined) === false);

rec('默认队列不可用时自动换一台', device.pick(list, 'HP-1022') === 'PrintGate-Virtual', device.pick(list, 'HP-1022'));
rec('默认队列可用时优先用它', device.pick(list, 'PrintGate-Virtual') === 'PrintGate-Virtual');
rec('全不可用时仍有兜底', device.pick([
  { name: 'A', enabled: false }, { name: 'B', accepting: false }
], 'A') === 'A', device.pick([{ name: 'A', enabled: false }, { name: 'B', accepting: false }], 'A'));
rec('空列表返回空串', device.pick([], 'x') === '' && device.pick(null, 'x') === '');

rec('状态文案：停用', device.stateText(list[0]) === '已停用', device.stateText(list[0]));
rec('状态文案：空闲', device.stateText(list[1]) === '空闲就绪', device.stateText(list[1]));
rec('状态文案：打印中', device.stateText({ name: 'x', enabled: true, accepting: true, state: 'printing' }) === '正在打印');

const pass = results.filter((x) => x.p).length;
console.log(`\n=== ${pass}/${results.length} 通过 ===`);
const bad = results.filter((x) => !x.p);
if (bad.length) bad.forEach((b) => console.log(' - ' + b.n + (b.d ? ': ' + b.d : '')));
process.exit(bad.length ? 1 : 0);
