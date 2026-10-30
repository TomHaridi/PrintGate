// 服务地址本地存取（Storage 优先，其次 config/index.js 环境矩阵）
const envMatrix = require('../config/index');

const BASE_KEY = 'pg_base_url';
const HIST_KEY = 'pg_base_urls';   // 最近用过的地址（去重、最多 5 个）
const HIST_MAX = 5;

// 开发者工具里用 127.0.0.1 默认值方便联调；真机上这个地址永远连不上，
// 拿它当默认只会让用户看到「连不上」，所以真机默认留空、引导去扫描或填写。
function isDevtools() {
  try {
    return String(wx.getSystemInfoSync().platform || '').toLowerCase() === 'devtools';
  } catch (_) {
    return false;
  }
}

function normalize(url) {
  let v = String(url || '').trim().replace(/\/+$/, '');
  if (!v) return '';
  if (!/^https?:\/\//i.test(v)) {
    // 局域网 / 本机补 http，公网域名补 https
    v = /^(localhost|127\.|192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/i.test(v) ? `http://${v}` : `https://${v}`;
  }
  return v;
}

function getBaseUrl() {
  let v = '';
  try { v = wx.getStorageSync(BASE_KEY) || ''; } catch (_) {}
  const fallback = isDevtools() ? (envMatrix.env.baseUrl || '') : '';
  return String(v || fallback).replace(/\/+$/, '');
}

function getHistory() {
  try {
    const list = wx.getStorageSync(HIST_KEY);
    return Array.isArray(list) ? list.filter((x) => typeof x === 'string' && x) : [];
  } catch (_) {
    return [];
  }
}

// 记住一个可用地址（登录成功、扫描命中、手动保存都会调）
function setBaseUrl(url) {
  const v = String(url || '').replace(/\/+$/, '');
  try {
    wx.setStorageSync(BASE_KEY, v);
    if (v) {
      const list = getHistory().filter((x) => x !== v);
      list.unshift(v);
      wx.setStorageSync(HIST_KEY, list.slice(0, HIST_MAX));
    }
  } catch (_) {}
  return v;
}

function removeHistory(url) {
  try { wx.setStorageSync(HIST_KEY, getHistory().filter((x) => x !== url)); } catch (_) {}
}

function clearBaseUrl() {
  try { wx.removeStorageSync(BASE_KEY); } catch (_) {}
}

module.exports = {
  getBaseUrl, setBaseUrl, clearBaseUrl, getHistory, removeHistory, normalize, isDevtools,
  ENVS: envMatrix.ENVS
};
