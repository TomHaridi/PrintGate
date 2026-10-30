// 请求封装：统一 token、401 处理、业务错误归一化
// 注意：这里绝不能在模块顶层 `const app = getApp()` —— 模块首次求值若早于 App()
// 注册完成，app 会被永久捕获成 undefined，之后所有请求都误报「未配置服务地址」，
// 而页面里运行时 getApp() 又能读到地址，出现「有地址却提示未配置」的自相矛盾。
const { getBaseUrl } = require('./config');

// 业务错误：带 code（NOT_ADMIN / NOT_APPROVED / UNAUTHORIZED），页面可据此分流
function bizError(msg, code, status) {
  return Object.assign(new Error(msg || '请求失败'), { code: code || '', status: status || 0, biz: true });
}

// 401 只处理一次：多个并发请求同时过期时，避免重复 toast / reLaunch
let handling401 = false;
function handleUnauthorized() {
  const app = getApp();
  app && app.logout && app.logout();
  if (handling401) return;
  handling401 = true;
  const pages = getCurrentPages();
  const cur = pages[pages.length - 1] || {};
  if (cur.route !== 'pages/login/login') {
    wx.showToast({ title: '登录已失效，请重新进入', icon: 'none' });
    setTimeout(() => {
      handling401 = false;
      wx.reLaunch({ url: '/pages/login/login' });
    }, 600);
  } else {
    handling401 = false;
  }
}

// 取当前服务地址：globalData 优先，Storage/config 兜底，并自愈 globalData。
// 三份来源必须收敛成同一个值，否则会出现「页面上显示有地址、请求层却说没配」的分裂。
function currentBase() {
  let app = null;
  try { app = getApp() || null; } catch (_) { app = null; }
  const fromApp = (app && app.globalData && app.globalData.baseUrl) || '';
  if (fromApp) return fromApp;
  const fromStorage = getBaseUrl();
  if (fromStorage && app && app.globalData) {
    app.globalData.baseUrl = fromStorage; // 自愈：把兜底值同步回全局，后续读取一致
  }
  return fromStorage;
}

function ensureBase() {
  const base = currentBase();
  if (!base) {
    throw bizError('请先在「我的 → 服务地址」配置 PrintGate 服务端地址', 'NO_BASE');
  }
  return base;
}

// 运行时取 token：与 currentBase 同理，不能在模块顶层捕获 app
function tokenNow() {
  let app = null;
  try { app = getApp() || null; } catch (_) { app = null; }
  return (app && app.globalData && app.globalData.token) || '';
}

function request({ url, method = 'GET', data = {}, header = {}, timeout = 30000 }) {
  let base;
  try { base = ensureBase(); } catch (e) { return Promise.reject(e); }
  const token = tokenNow();
  return new Promise((resolve, reject) => {
    wx.request({
      url: `${base}${url}`,
      method,
      data,
      timeout,
      header: {
        'Content-Type': 'application/json',
        Authorization: token ? `Bearer ${token}` : '',
        ...header
      },
      success(res) {
        const body = (res.data && typeof res.data === 'object') ? res.data : {};
        if (res.statusCode === 401) {
          handleUnauthorized();
          return reject(bizError('登录已失效', body.code || 'UNAUTHORIZED', 401));
        }
        if (res.statusCode >= 200 && res.statusCode < 300 && body.ok !== false) {
          return resolve(body);
        }
        return reject(bizError(body.msg || `请求失败(${res.statusCode})`, body.code || '', res.statusCode));
      },
      fail(err) {
        const msg = (err && err.errMsg && /timeout/.test(err.errMsg))
          ? '网络超时，请检查服务地址或网络'
          : '网络异常，请检查服务地址或网络';
        reject(bizError(msg, 'NETWORK', 0));
      }
    });
  });
}

// 上传（multipart）：content-type 交给微信填 boundary
function upload(filePath, { name = 'file', formData = {}, url = '/api/mp/files' } = {}) {
  let base;
  try { base = ensureBase(); } catch (e) { return Promise.reject(e); }
  const token = tokenNow();
  return new Promise((resolve, reject) => {
    wx.uploadFile({
      url: `${base}${url}`,
      filePath,
      name,
      formData,
      timeout: 120000,
      header: { Authorization: token ? `Bearer ${token}` : '' },
      success(res) {
        let body = {};
        try { body = JSON.parse(res.data || '{}'); } catch (_) { body = {}; }
        if (res.statusCode === 401) {
          handleUnauthorized();
          return reject(bizError('登录已失效', body.code || 'UNAUTHORIZED', 401));
        }
        if (res.statusCode >= 200 && res.statusCode < 300 && body.ok !== false) {
          return resolve(body);
        }
        return reject(bizError(body.msg || `上传失败(${res.statusCode})`, body.code || '', res.statusCode));
      },
      fail(err) {
        reject(bizError((err && err.errMsg && /timeout/.test(err.errMsg)) ? '上传超时，请检查网络' : '上传失败，请检查网络', 'NETWORK', 0));
      }
    });
  });
}

// 下载需要令牌的资源（文件预览 / 头像）：落到临时文件，返回本地路径 + 内容类型。
// 相册保存必须知道真实类型：wx.downloadFile 的临时路径没有扩展名，
// wx.saveImageToPhotosAlbum 会因为「无法识别文件类型」直接失败。
function downloadDetailed(path) {
  let base;
  try { base = ensureBase(); } catch (e) { return Promise.reject(e); }
  const token = tokenNow();
  const url = /^https?:/.test(path) ? path : `${base}${path}`;
  return new Promise((resolve, reject) => {
    wx.downloadFile({
      url,
      timeout: 60000,
      header: { Authorization: token ? `Bearer ${token}` : '' },
      success(res) {
        if (res.statusCode === 401) {
          handleUnauthorized();
          return reject(bizError('登录已失效', 'UNAUTHORIZED', 401));
        }
        if (res.statusCode >= 200 && res.statusCode < 300 && res.tempFilePath) {
          const h = res.header || {};
          const ct = h['Content-Type'] || h['content-type'] || '';
          return resolve({ path: res.tempFilePath, contentType: String(ct).split(';')[0].trim() });
        }
        if (res.statusCode === 410) return reject(bizError('源文件已清理，无法预览', 'GONE', 410));
        if (res.statusCode === 404) return reject(bizError('文件不存在或已删除', 'NOT_FOUND', 404));
        return reject(bizError(`下载失败(${res.statusCode})`, '', res.statusCode));
      },
      fail() { reject(bizError('下载失败，请检查网络', 'NETWORK', 0)); }
    });
  });
}

// 老接口：只要路径（预览、头像等场景）
function download(path) {
  return downloadDetailed(path).then((r) => r.path);
}

module.exports = {
  downloadDetailed, request, upload, download, bizError };
