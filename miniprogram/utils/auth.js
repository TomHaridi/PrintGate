// 登录令牌存取 + 微信登录换 token
const TOKEN_KEY = 'pg_token';

function getToken() {
  try { return wx.getStorageSync(TOKEN_KEY) || ''; } catch (_) { return ''; }
}

function setToken(token) {
  try { wx.setStorageSync(TOKEN_KEY, token || ''); } catch (_) {}
}

function clearToken() {
  try { wx.removeStorageSync(TOKEN_KEY); } catch (_) {}
}

// wx.login 拿 code → /api/mp/login 换 token 与用户信息
// profile: 可选，登录时顺带提交昵称等资料（后端只补空，不覆盖）
function wxLogin(profile = {}) {
  return new Promise((resolve, reject) => {
    wx.login({
      success: (r) => {
        if (!r.code) return reject(new Error('微信登录失败，请重试'));
        const api = require('../services/api');
        api.login(r.code, profile).then(resolve).catch(reject);
      },
      fail: () => reject(new Error('微信登录失败，请检查网络'))
    });
  });
}

// 开发模式模拟登录（需后台开启「开发模式」，本地联调用）
function devLogin(openid, nickname) {
  const api = require('../services/api');
  return api.devLogin(openid, nickname);
}

module.exports = { getToken, setToken, clearToken, wxLogin, devLogin };
