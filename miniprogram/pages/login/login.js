// 登录页：wx.login 静默换 token，失败可重试；支持开发模式登录
// 服务地址配置做成登录页内的弹层：连不上后端多半是地址不对，未登录时也必须能改。
// 原先跳「我的」页的写法是死的——那页没有 token 会立刻 reLaunch 回本页。
const { wxLogin, devLogin } = require('../../utils/auth');
const api = require('../../services/api');
const cfg = require('../../utils/config');
const lanscan = require('../../utils/lanscan');

Page({
  data: {
    loading: true,
    error: '',
    dark: false,
    primaryStyle: '',
    currentBase: '',   // 当前生效的服务地址，失败时展示，方便确认在连哪里
    showBase: false,
    baseInput: '',
    // 局域网扫描
    scanning: false,
    scanDone: 0,
    scanTotal: 0,
    scanList: [],       // [{ base, version }]
    scanFinished: false,
    scanPrefix: '',
    // 最近用过的地址
    history: [],
    // 登录后补齐头像/昵称（微信自 2022-10-25 起不再允许静默获取，只能用官方填写能力）
    needProfile: false,
    tempAvatar: '',     // chooseAvatar 得到的临时图片
    avatarPreview: '',  // 本地预览
    nickDraft: '',
    savingProfile: false
  },

  onLoad() {
    const app = getApp();
    this.setData({
      dark: app.isDark(),
      primaryStyle: app.primaryStyle(),
      currentBase: app.globalData.baseUrl || ''
    });
    const goHome = () => {
      if (app.globalData.token && app.globalData.user) {
        wx.switchTab({ url: '/pages/index/index' });
        return true;
      }
      return false;
    };
    if (goHome()) return;
    // 等待 app.onLaunch 的登录态恢复，避免重复登录
    const ready = app.globalData.loginReady || Promise.resolve(null);
    ready.then(() => {
      if (goHome()) return;
      this.doLogin();
    });
  },

  // 进入首页前，若缺昵称/头像则引导补齐（用官方「头像昵称填写能力」，可跳过）
  // 说明：微信已禁止静默获取真实头像昵称，getUserInfo/getUserProfile 只返回灰色头像+“微信用户”，
  // 因此只能由用户点选/一键填充，这里把它放在登录成功后、进首页之前，体验最接近“自动带上”。
  async enterApp() {
    const app = getApp();
    const u = app.globalData.user || {};
    const need = !String(u.nickname || '').trim() || !u.avatar;
    if (!need) { wx.switchTab({ url: '/pages/index/index' }); return; }
    this.setData({
      needProfile: true, loading: false,
      tempAvatar: '', avatarPreview: '',
      nickDraft: String(u.nickname || '').trim()
    });
  },

  // 用户点选头像（微信会提供「使用微信头像」）
  onChooseAvatar(e) {
    const path = e.detail && e.detail.avatarUrl;
    if (!path) return;
    this.setData({ tempAvatar: path, avatarPreview: path });
  },

  onNickInput(e) {
    this.setData({ nickDraft: e.detail.value });
  },

  async submitProfile() {
    const nick = String(this.data.nickDraft || '').trim();
    if (!nick) { wx.showToast({ title: '请填写昵称', icon: 'none' }); return; }
    this.setData({ savingProfile: true });
    wx.showLoading({ title: '保存中', mask: true });
    const app = getApp();
    try {
      // 先传头像（后端会直接写回 user.avatar），再存昵称；头像失败不阻断昵称，但要让用户知道
      let avatarFail = '';
      if (this.data.tempAvatar) {
        try {
          const r = await api.uploadAvatar(this.data.tempAvatar);
          if (r && r.user) app.globalData.user = r.user;
        } catch (e2) {
          avatarFail = (e2 && e2.message) || '头像上传失败';
        }
      }
      const r2 = await api.saveProfile({ nickname: nick });
      if (r2 && r2.user) app.globalData.user = r2.user;
      else await app.refreshUser();
      wx.hideLoading();
      this.setData({ needProfile: false, savingProfile: false });
      wx.switchTab({ url: '/pages/index/index' });
      if (avatarFail) setTimeout(() => wx.showToast({ title: avatarFail, icon: 'none' }), 400);
    } catch (e) {
      wx.hideLoading();
      this.setData({ savingProfile: false });
      wx.showToast({ title: e.message || '保存失败', icon: 'none' });
    }
  },

  skipProfile() {
    this.setData({ needProfile: false });
    wx.switchTab({ url: '/pages/index/index' });
  },

  async doLogin() {
    this.setData({ loading: true, error: '' });
    const app = getApp();
    try {
      const res = await wxLogin();
      app.setTokenAndSave(res.token);
      if (app.globalData.baseUrl) cfg.setBaseUrl(app.globalData.baseUrl);   // 记住能连上的地址
      await app.bootstrap();
      await this.enterApp();
    } catch (e) {
      const base = app.globalData.baseUrl || '';
      let msg = e.message || '登录失败，请重试';
      // 「未配置地址」的提示本身就在说地址问题，再拼一遍当前地址只会自相矛盾
      if (e.code !== 'NO_BASE' && base && msg.indexOf(base) < 0) msg += `（当前：${base}）`;
      this.setData({ loading: false, error: msg, currentBase: base });
    }
  },

  // 开发模式模拟登录：需后台「小程序对接 → 开发模式」已开启
  // 固定 openid：后端 openid 为空串时会把多个开发者混成同一个账号，固定下来审批状态才可持久
  async onDevLogin() {
    const app = getApp();
    try {
      const res = await devLogin('dev_local_tester', '测试用户');
      app.setTokenAndSave(res.token);
      if (app.globalData.baseUrl) cfg.setBaseUrl(app.globalData.baseUrl);
      await app.bootstrap();
      await this.enterApp();
    } catch (e) {
      wx.showToast({ title: e.message || '开发模式未开启', icon: 'none' });
    }
  },

  // ---------- 服务地址 ----------
  openBase() {
    const app = getApp();
    this.setData({
      showBase: true,
      baseInput: app.globalData.baseUrl || '',
      history: cfg.getHistory(),
      scanning: false, scanDone: 0, scanTotal: 0, scanList: [], scanFinished: false
    });
  },
  closeBase() {
    this.setData({ showBase: false });
  },
  onBaseInput(e) {
    this.setData({ baseInput: String(e.detail.value || '').trim() });
  },
  usePreset(e) {
    const p = e.currentTarget.dataset.preset;
    if (p) this.setData({ baseInput: p });
  },
  onScanPrefix(e) { this.setData({ scanPrefix: String(e.detail.value || '').trim() }); },

  // 扫描局域网：小程序没有 raw socket，这里是对「常见网段 × 常见主机位 × 常见端口」
  // 逐个请求 /api/health，返回 app=PrintGate 才算命中。真机需开调试模式或已备案域名。
  async startScan() {
    if (this.data.scanning) return;
    this._scanStop = false;
    this.setData({
      scanning: true, scanFinished: false, scanDone: 0, scanTotal: 0, scanList: []
    });
    try {
      const r = await lanscan.scan({
        prefix: this.data.scanPrefix,
        concurrency: 8,
        shouldStop: () => !!this._scanStop,
        onProgress: (n, total, foundN) => {
          if (this._scanStop) return;
          this.setData({ scanDone: n, scanTotal: total, scanFound: foundN });
        },
        onFound: (f, all) => {
          if (this._scanStop) return;
          const list = all.map((x) => ({ base: x.base, version: x.version }));
          this.setData({ scanList: list });
          // 只找到一个就自动填进输入框，省一次点击
          if (list.length === 1) this.setData({ baseInput: list[0].base });
        }
      });
      if (this._scanStop) return;
      this.setData({ scanning: false, scanFinished: true });
      if (!r.found.length) {
        wx.showToast({ title: '没扫到，试试填网段前缀或手动输入', icon: 'none' });
      }
    } catch (e) {
      this.setData({ scanning: false });
      wx.showToast({ title: e.message || '扫描失败', icon: 'none' });
    }
  },

  stopScan() {
    this._scanStop = true;
    this.setData({ scanning: false, scanFinished: true });
  },

  toggleScan() {
    return this.data.scanning ? this.stopScan() : this.startScan();
  },

  // 点扫描结果 / 历史地址：直接填入并保存重连（历史是验证过能连上的）
  useAddr(e) {
    const url = e.currentTarget.dataset.url;
    if (!url) return;
    this.setData({ baseInput: url });
    this.saveBase(url);
  },

  clearHistory() {
    const app = getApp();
    const cur = app.globalData.baseUrl || '';
    wx.showModal({
      title: '清除历史地址',
      content: '只清除本机记住的地址列表，不影响当前连接。',
      success: (r) => {
        if (!r.confirm) return;
        for (const u of this.data.history) cfg.removeHistory(u);
        this.setData({ history: cfg.getHistory().filter((x) => x === cur) });
      }
    });
  },

  saveBase(preset) {
    const app = getApp();
    const raw = typeof preset === 'string' ? preset : this.data.baseInput;
    let v = String(raw || '').trim().replace(/\/+$/, '');
    // 用户常直接输 IP:端口，这里补上协议，与「我的 → 服务地址」保持同一套宽松度
    if (v && !/^https?:\/\//i.test(v)) v = `http://${v}`;
    if (!v) { wx.showToast({ title: '请先填写服务地址', icon: 'none' }); return; }
    if (!/^https?:\/\/[^\s]+$/i.test(v)) {
      wx.showToast({ title: '地址格式不正确，应以 http(s):// 开头', icon: 'none' });
      return;
    }
    app.setBaseUrlAndSave(v);
    this.setData({ showBase: false, currentBase: v, error: '', history: cfg.getHistory() });
    wx.showToast({ title: '地址已保存，正在重试', icon: 'none' });
    // 保存后立刻用新地址重试，省一次手动点击
    this.doLogin();
  }
});
