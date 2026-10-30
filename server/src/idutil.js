'use strict';
// 路径参数里的 id 只接受纯正整数。
// 不能直接用 parseInt：parseInt("1e9") === 1、"12abc" === 12，
// 会让「改/删 1e9 号用户」这种请求悄悄作用到 1 号用户身上。
function intId(v) {
  const s = String(v == null ? '' : v).trim();
  if (!/^\d{1,15}$/.test(s)) return null;
  const n = Number(s);
  return n > 0 ? n : null;
}

module.exports = { intId };
