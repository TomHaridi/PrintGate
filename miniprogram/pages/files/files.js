// 我的文件：预览 / 去打印 / 删除（卡片风格 + 暗夜）
const api = require('../../services/api');
const { formatSize, formatTime, extOf, fileKind } = require('../../utils/format');

// 微信隐私协议：涉及相册等隐私接口前，必须先让用户同意《用户隐私保护指引》。
// 若小程序后台没有声明「相册（仅写入）」，这里会直接失败 —— 这不是代码能绕过的，
// 只能在 mp 后台补声明；同时我们提供长按图片保存作为兜底路径。
function ensurePrivacy() {
  return new Promise((resolve) => {
    if (!wx.requirePrivacyAuthorize) return resolve(true);
    wx.requirePrivacyAuthorize({
      success: () => resolve(true),
      fail: () => resolve(false)
    });
  });
}

function isPrivacyScopeError(msg) {
  return /privacy agreement|privacy|scope is not declared/i.test(String(msg || ''));
}

// 同上：WXML 不能调用页面方法，这里把展示字段算好
function decorateFile(f) {
  const ext = (extOf(f.filename) || 'bin').toUpperCase();
  return Object.assign({}, f, {
    _name: f.filename || '未命名文件',
    _ext: ext,
    _isImage: fileKind(f.filename) === 'image',
    _size: formatSize(f.size),
    _pages: f.pages ? ` · ${f.pages} 页` : '',
    _time: formatTime(f.created_at)
  });
}

Page({
  data: {
    dark: false,
    primaryStyle: '',
    files: [],
    loading: true,
    delTarget: null,
    delVisible: false,
    previewingId: '',      // 正在预览的文件 id（加载态）
    previewPath: '',       // 预览图临时路径
    previewPage: 1,        // 多页文档当前页
    previewTotal: 0,       // 总页数（服务端 files.pages）
    previewFile: null,     // 当前预览的文件对象
    previewVisible: false, // 预览弹层
    previewErr: '',
    previewMime: ''
  },

  onShow() {
    const app = getApp();
    this.setData({ dark: app.isDark(), primaryStyle: app.primaryStyle() });
    if (!app.globalData.token) {
      wx.reLaunch({ url: '/pages/login/login' });
      return;
    }
    this.loadFiles();
  },

  onPullDownRefresh() {
    this.loadFiles().finally(() => wx.stopPullDownRefresh());
  },

  loadFiles() {
    this.setData({ loading: true });
    return api.myFiles().then((res) => {
      this.setData({ files: (res.files || []).map(decorateFile), loading: false });
    }).catch((e) => {
      this.setData({ loading: false });
      wx.showToast({ title: e.message || '加载失败', icon: 'none' });
    });
  },

  // 预览：服务端 preview 接口返回图片（原图或首页渲染 PNG），统一用图片预览
  previewFile(e) {
    const id = e.currentTarget.dataset.id;
    const file = this.data.files.find((f) => String(f.id) === String(id));
    if (!file) return;
    this.setData({ previewingId: String(id), previewPath: '', previewFile: file, previewVisible: true, previewErr: '', previewPage: 1, previewTotal: Number(file.pages) || 0 });
    this.fetchPreview(file);
  },

  // 拉取预览图（失败可重试）
  fetchPreview(file, page) {
    if (!file) return;
    const p = page || this.data.previewPage || 1;
    this.setData({ previewingId: String(file.id), previewErr: '', previewPage: p });
    api.downloadFileDetailed(file.id, p).then((r) => {
      this.setData({ previewingId: '', previewPath: r.path, previewMime: r.contentType || '' });
    }).catch((err) => {
      this.setData({ previewingId: '', previewErr: err.message || '预览失败' });
    });
  },

  // 多页 PDF 翻页：服务端按 ?page=N 逐页渲染
  prevPage() {
    const p = (this.data.previewPage || 1) - 1;
    if (p < 1) return;
    this.fetchPreview(this.data.previewFile, p);
  },

  nextPage() {
    const total = this.data.previewTotal || 0;
    const p = (this.data.previewPage || 1) + 1;
    if (total && p > total) return;
    this.fetchPreview(this.data.previewFile, p);
  },

  retryPreview() {
    if (this.data.previewFile) this.fetchPreview(this.data.previewFile);
  },

  closePreview() {
    this.setData({ previewVisible: false, previewPath: '', previewFile: null, previewErr: '', previewingId: '', previewMime: '', previewPage: 1, previewTotal: 0 });
  },

  // 相册后缀：优先用服务端返回的 Content-Type，退化为文件名后缀，最后按 PNG（服务端渲染预览）
  albumExt(mime, filename) {
    const m = String(mime || '').toLowerCase();
    if (m === 'image/jpeg' || m === 'image/jpg') return 'jpg';
    if (m === 'image/png') return 'png';
    if (m === 'image/gif') return 'gif';
    if (m === 'image/webp') return 'webp';
    const mm = String(filename || '').toLowerCase().match(/\.(jpe?g|png|gif|webp|bmp)$/);
    return mm ? mm[1].replace('jpeg', 'jpg') : 'png';
  },

  // 保存预览图到相册
  // 关键点：wx.downloadFile 的临时路径没有扩展名，saveImageToPhotosAlbum 会报「无法识别文件类型」，
  // 所以先按内容类型复制成一个带后缀的本地文件，存完再删掉。
  async savePreview() {
    const p = this.data.previewPath;
    if (!p) { wx.showToast({ title: '预览尚未就绪', icon: 'none' }); return; }

    // 0) 隐私协议：没同意过就先弹官方授权框
    const priv = await ensurePrivacy();
    if (!priv) {
      wx.showModal({
        title: '需要隐私授权',
        content: '保存到相册属于隐私接口，需先同意《用户隐私保护指引》。也可以直接长按图片保存。',
        showCancel: false
      });
      return;
    }

    // 1) 相册权限：之前点过拒绝就直接引导去设置，别等接口报错
    const setting = await new Promise((resolve) => {
      wx.getSetting({ success: (r) => resolve(r.authSetting || {}), fail: () => resolve({}) });
    });
    if (setting['scope.writePhotosAlbum'] === false) {
      wx.showModal({
        title: '需要相册权限',
        content: '保存图片需要「添加到相册」权限，去设置里打开即可',
        confirmText: '去设置',
        success: (r) => { if (r.confirm) wx.openSetting(); }
      });
      return;
    }

    const ext = this.albumExt(this.data.previewMime, this.data.previewFile && this.data.previewFile.filename);
    const dest = `${wx.env.USER_DATA_PATH}/pg_save_${Date.now()}.${ext}`;
    const fs = wx.getFileSystemManager();

    wx.showLoading({ title: '保存中', mask: true });
    try {
      await new Promise((resolve, reject) => {
        fs.copyFile({ srcPath: p, destPath: dest, success: resolve, fail: reject });
      });
    } catch (e) {
      wx.hideLoading();
      wx.showToast({ title: '保存失败：写入临时文件失败', icon: 'none' });
      return;
    }

    wx.saveImageToPhotosAlbum({
      filePath: dest,
      success: () => {
        wx.hideLoading();
        wx.showToast({ title: '已保存到相册', icon: 'success' });
      },
      fail: (err) => {
        wx.hideLoading();
        const msg = (err && err.errMsg) || '';
        if (/auth deny|auth denied|authorize no response|deny/i.test(msg)) {
          wx.showModal({
            title: '需要相册权限',
            content: '请在设置中允许保存图片到相册',
            confirmText: '去设置',
            success: (r) => { if (r.confirm) wx.openSetting(); }
          });
          return;
        }
        // 后台没声明相册权限时，微信会直接拒绝，代码侧无解——给出可执行的修复路径
        if (isPrivacyScopeError(msg)) {
          wx.showModal({
            title: '相册权限未声明',
            content: '小程序后台的《用户隐私保护指引》还没声明「相册（仅写入）」。\n可先长按图片保存；管理员需在 mp.weixin.qq.com → 设置 → 服务内容声明 → 用户隐私保护指引 中勾选相册并发布。',
            showCancel: false
          });
          return;
        }
        // 把系统原文带出来，方便定位是格式、空间还是别的问题
        wx.showModal({ title: '保存失败', content: msg || '未知错误', showCancel: false });
      },
      complete: () => { try { fs.unlink({ filePath: dest, fail: () => {} }); } catch (_) {} }
    });
  },

  // 带到打印页
  toPrint(e) {
    const id = e.currentTarget.dataset.id;
    const file = this.data.files.find((f) => String(f.id) === String(id));
    if (!file) return;
    getApp().setPendingFile(file);
    wx.switchTab({ url: '/pages/index/index' });
  },

  // 删除二次确认
  askDelete(e) {
    const id = e.currentTarget.dataset.id;
    const file = this.data.files.find((f) => String(f.id) === String(id));
    if (!file) return;
    this.setData({ delTarget: file, delVisible: true });
  },

  onDelCancel() {
    this.setData({ delVisible: false, delTarget: null });
  },

  onDelOk() {
    const file = this.data.delTarget;
    this.setData({ delVisible: false, delTarget: null });
    if (!file) return;
    api.deleteFile(file.id).then(() => {
      wx.showToast({ title: '已删除', icon: 'success' });
      this.loadFiles();
    }).catch((e) => {
      wx.showToast({ title: e.message || '删除失败', icon: 'none' });
    });
  },

  goUpload() {
    wx.switchTab({ url: '/pages/index/index' });
  },

  // ---------- 视图辅助 ----------
  extText(f) { return (extOf(f.filename) || 'bin').toUpperCase(); },
  sizeText(f) { return formatSize(f.size); },
  timeText(f) { return formatTime(f.created_at); },
  pagesText(f) { return f.pages ? ` · ${f.pages} 页` : ''; },
  isImage(f) { return fileKind(f.filename) === 'image'; },
  isImagePreview() {
    const f = this.data.previewFile;
    return f ? fileKind(f.filename) === 'image' : false;
  },
  // 预览弹层 catchtap 阻止冒泡用
  noop() {}
});
