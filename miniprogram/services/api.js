// 全部服务端接口集中在这里，页面不直接拼 URL
// 对应 PrintGate 后端 /api/mp/* 路由（后端未做任何改动）
const { request, upload, download, downloadDetailed } = require('../utils/request');

// ---------- 登录与账户 ----------
const login = (code, profile = {}) =>
  request({ url: '/api/mp/login', method: 'POST', data: Object.assign({ code }, profile) });
const devLogin = (openid, nickname) =>
  request({ url: '/api/mp/dev-login', method: 'POST', data: { openid, nickname } });
const me = () => request({ url: '/api/mp/me' });
const saveProfile = (data) => request({ url: '/api/mp/profile', method: 'PUT', data });
const uploadAvatar = (filePath) => upload(filePath, { name: 'avatar', url: '/api/mp/avatar' });
const version = () => request({ url: '/api/mp/version' });

// 绑定管理员：扫后台「微信对接」页的绑定码
const bindAdmin = (token) => request({ url: '/api/mp/bind', method: 'POST', data: { token } });
// 扫码绑定：把当前微信绑到后台指定的「普通用户」账号（后台 → 用户 → 扫码绑定 生成二维码）
const bindUser = (ticket) => request({ url: '/api/mp/bind-user', method: 'POST', data: { ticket } });

// 扫码登录网页后台
const qrScan = (ticket) => request({ url: '/api/mp/qr/scan', method: 'POST', data: { ticket } });
const qrConfirm = (ticket) => request({ url: '/api/mp/qr/confirm', method: 'POST', data: { ticket } });

// ---------- 打印机 ----------
const printers = () => request({ url: '/api/mp/printers' });

// ---------- 文件 ----------
// 微信 wx.uploadFile 单次上传有上限（约 10MB），19MB 的 PDF 会直接失败。
// 超过 8MB 走分片：init → 每片 4MB → complete，服务端拼回后进入原有入库流程。
const CHUNK_LIMIT = 8 * 1024 * 1024;

function readChunk(filePath, position, length) {
  const fsm = wx.getFileSystemManager();
  const ab = new ArrayBuffer(length);
  const fd = fsm.openSync({ filePath, flag: 'r' });
  try {
    fsm.readSync({ fd, arrayBuffer: ab, position, length });
  } finally {
    try { fsm.closeSync({ fd }); } catch (_) {}
  }
  return ab;
}

async function uploadChunked(filePath, { filename, size, mime = '', onProgress } = {}) {
  const fsm = wx.getFileSystemManager();
  const name = filename || String(filePath).split('/').pop() || 'upload.bin';
  const init = await request({ url: '/api/mp/upload/init', method: 'POST', data: { filename: name, size, mime } });
  const { uploadId, chunkSize, total } = init;
  const tmp = `${wx.env.USER_DATA_PATH}/pg_chunk.part`;
  try {
    for (let i = 0; i < total; i++) {
      const offset = i * chunkSize;
      const len = Math.min(chunkSize, size - offset);
      fsm.writeFileSync(tmp, readChunk(filePath, offset, len));
      await upload(tmp, { name: 'chunk', url: '/api/mp/upload/chunk', formData: { uploadId, index: i } });
      if (onProgress) onProgress(Math.round(((i + 1) / total) * 100));
    }
    return await request({ url: '/api/mp/upload/complete', method: 'POST', data: { uploadId } });
  } catch (e) {
    request({ url: `/api/mp/upload/${uploadId}`, method: 'DELETE' }).catch(() => {});
    throw e;
  } finally {
    try { fsm.unlinkSync(tmp); } catch (_) {}
  }
}

// 统一入口：小文件直传，大文件分片；直传失败且体积偏大时兜底再走分片
async function uploadFile(filePath, formData = {}, opts = {}) {
  const size = Number(opts.size || 0);
  const meta = { filename: opts.filename, size, mime: opts.mime || '', onProgress: opts.onProgress };
  if (size > CHUNK_LIMIT) return uploadChunked(filePath, meta);
  // 直传也要把展示名带上：微信给的临时名是 tmp_xxx，不带的话打印记录里就是一串乱码
  const fd = Object.assign({}, formData);
  if (opts.filename && !fd.filename) fd.filename = opts.filename;
  try {
    return await upload(filePath, { name: 'file', url: '/api/mp/files', formData: fd });
  } catch (e) {
    if (size > 4 * 1024 * 1024 && (e.code === 'NETWORK' || /上传失败/.test(e.message || ''))) {
      return uploadChunked(filePath, meta);
    }
    throw e;
  }
}
// 多张图片 → 一份多页 PDF（相册/聊天多选后收口，每张独占一页）
const mergeImages = (ids, filename) =>
  request({ url: '/api/mp/files/merge', method: 'POST', data: { ids, filename } });
const myFiles = () => request({ url: '/api/mp/files' });
const deleteFile = (id) => request({ url: `/api/mp/files/${id}`, method: 'DELETE' });
// 预览图 / 原文件下载（带令牌，落临时文件）
const downloadFileDetailed = (id, page = 1) => downloadDetailed(`/api/mp/files/${id}/preview?page=${page || 1}`);
const downloadFile = (id, page = 1) => download(`/api/mp/files/${id}/preview?page=${page || 1}`);
const previewUrl = (id, page = 1) => `/api/mp/files/${id}/preview?page=${page || 1}`;

// ---------- 打印 ----------
const print = (fileId, printer, options) =>
  request({ url: '/api/mp/print', method: 'POST', data: { fileId, printer, options } });
const myTasks = () => request({ url: '/api/mp/tasks' });
const cancelTask = (id) => request({ url: `/api/mp/tasks/${id}/cancel`, method: 'POST' });

// ---------- 管理员端（小程序管理台） ----------
const adminOverview = () => request({ url: '/api/mp/admin/overview' });
const adminUsers = (status = 'all', q = '') => request({ url: '/api/mp/admin/users', data: { status, q } });
const adminUserAction = (id, action) =>
  request({ url: `/api/mp/admin/users/${id}/${action}`, method: 'POST' });
const adminTasks = (status = 'pending') => request({ url: '/api/mp/admin/tasks', data: { status } });
const adminTaskAction = (id, action) =>
  request({ url: `/api/mp/admin/tasks/${id}/${action}`, method: 'POST' });
// 清除已结束的打印历史（可传 status 限定，不传清全部已结束）
const adminTaskCleanup = (status) =>
  request({ url: '/api/mp/admin/tasks/cleanup', method: 'POST', data: status ? { status } : {} });
const adminPrinters = () => request({ url: '/api/mp/admin/printers' });
const adminPrinterAction = (name, action) =>
  request({ url: `/api/mp/admin/printers/${encodeURIComponent(name)}/${action}`, method: 'POST' });
const adminSettings = () => request({ url: '/api/mp/admin/settings' });
const adminSaveSettings = (data) => request({ url: '/api/mp/admin/settings', method: 'PUT', data });

module.exports = {
  bindUser,
  login, devLogin, me, saveProfile, uploadAvatar, version, bindAdmin, qrScan, qrConfirm,
  printers,
  uploadFile, uploadChunked, mergeImages, myFiles, deleteFile, downloadFile, downloadFileDetailed, previewUrl,
  print, myTasks, cancelTask,
  adminOverview, adminUsers, adminUserAction, adminTasks, adminTaskAction, adminTaskCleanup,
  adminPrinters, adminPrinterAction, adminSettings, adminSaveSettings
};
