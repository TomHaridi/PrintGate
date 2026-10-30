// 我的：资料、管理员入口（后台/扫码/绑定）、服务地址、主题、关于、退出（卡片风格 + 暗夜）
const api = require('../../services/api');
const { userStatus } = require('../../utils/format');
const { MODE_LABEL, PRIMARY_PRESETS, DEFAULT_PRIMARY } = require('../../utils/theme');

const THEME_MODES = [
  { key: 'auto', label: '跟随系统', desc: '与微信深色模式保持一致' },
  { key: 'light', label: '浅色', desc: '始终使用浅色界面' },
  { key: 'dark', label: '深色', desc: '始终使用暗夜界面' }
];

// 头像地址统一处理：既支持 /api/mp/avatar/xxx 这种相对路径，也兼容历史遗留的完整 URL；
// 顺带去掉 baseUrl 末尾多余的斜杠，避免拼出 http://host//api/... 导致加载失败。
function avatarOf(u, app) {
  const a = (u && u.avatar) || '';
  if (!a) return '';
  if (/^https?:\/\//i.test(a)) return a;
  const rawBase = String((app && app.globalData && app.globalData.baseUrl) || '');
  const base = rawBase.replace(/\/+$/, '');
  return base + (a[0] === '/' ? a : '/' + a);
}

// 主色 → 名称（不在预设里时回落为自定义色值）
function primaryNameOf(hex) {
  const hit = PRIMARY_PRESETS.find((p) => String(p.v).toLowerCase() === String(hex || '').toLowerCase());
  return hit ? hit.t : String(hex || DEFAULT_PRIMARY);
}

Page({
  data: {
    dark: false,
    primaryStyle: '',
    user: null,
    isAdmin: false,
    avatarUrl: '',
    uploadingAvatar: false,
    version: '',
    baseUrl: '',
    themeMode: 'auto',
    themeLabel: '跟随系统',
    themeModes: THEME_MODES,
    // 主题色（可自定义）
    primaryList: PRIMARY_PRESETS,
    primary: DEFAULT_PRIMARY,
    primaryName: '青绿',
    // 资料编辑
    showProfile: false,
    savingProfile: false,
    profile: { nickname: '', wechat_id: '', phone: '', real_name: '', apply_note: '' },
    // 绑定管理员
    showBind: false,
    bindToken: '',
    binding: false,
    // 服务地址
    showBase: false,
    baseInput: '',
    // 主题
    showTheme: false,
    // 扫码登录确认
    showQrConfirm: false,
    qrTicket: '',
    confirmingQr: false,
    // 关于 / 退出
    showAbout: false,
    showLogout: false
  },

  // 主题 + 主色：把全局状态同步到页面（页面根节点用 primaryStyle 注入 CSS 变量）
  syncTheme() {
    const app = getApp();
    const primary = app.globalData.primary || DEFAULT_PRIMARY;
    const mode = app.globalData.themeMode || 'auto';
    this.setData({
      dark: app.isDark(),
      primary,
      primaryName: primaryNameOf(primary),
      primaryStyle: app.primaryStyle(),
      themeMode: mode,
      themeLabel: MODE_LABEL[mode] || '跟随系统',
      baseUrl: app.globalData.baseUrl || ''
    });
  },

  onLoad() {
    this.syncTheme();
    api.version().then((r) => this.setData({ version: r.version || '' })).catch(() => {});
  },

  onShow() {
    const app = getApp();
    this.syncTheme();
    if (!app.globalData.token) {
      wx.reLaunch({ url: '/pages/login/login' });
      return;
    }
    this.refreshUser();
  },

  refreshUser() {
    const app = getApp();
    app.refreshUser().then((u) => {
      if (!u) return;
      this.applyUser(u);
    });
  },

  applyUser(u) {
    const app = getApp();
    // 绑定 / 保存资料后同步全局登录态，避免 app.isAdmin() 等判断滞后
    app.globalData.user = u;
    this.setData({
      user: u,
      isAdmin: u.role === 'admin' && u.status === 'approved',
      // WXML 不支持调用页面方法，账号态在这里算好
      _roleText: u.role === 'admin' ? '管理员' : '普通用户',
      _statusText: (userStatus(u.status) || {}).text || '',
      _statusKind: (userStatus(u.status) || {}).kind || 'plain',
      _isPending: u.status === 'pending',
      _profileDone: !!(u.wechat_id || u.phone || u.real_name),
      avatarUrl: avatarOf(u, app), // 统一拼接：绝对地址直接用，相对路径补 baseUrl（并去掉重复斜杠）
      profile: {
        nickname: u.nickname || '',
        wechat_id: u.wechat_id || '',
        phone: u.phone || '',
        real_name: u.real_name || '',
        apply_note: u.apply_note || ''
      }
    });
  },

  // ---------- 头像 ----------
  // 上传成功后直接用接口返回的 user 刷新界面：
  // 之前是先 toast 再二次拉 /mp/me，那一步失败时头像其实已经换成功了，
  // 用户却看到「头像已更新」但图片没变 —— 会被当成「换不了头像」。
  async onChooseAvatar(e) {
    const path = e && e.detail && e.detail.avatarUrl;
    if (!path) return;
    if (this.data.uploadingAvatar) return;   // 连点时只处理一次
    this.setData({ uploadingAvatar: true });
    wx.showLoading({ title: '头像上传中', mask: true });
    try {
      const res = await api.uploadAvatar(path);
      wx.hideLoading();
      this.setData({ uploadingAvatar: false });
      if (res && res.user) this.applyUser(res.user);
      else {
        const app = getApp();
        const u = await app.refreshUser();
        if (u) this.applyUser(u);
      }
      wx.showToast({ title: '头像已更新', icon: 'success' });
    } catch (err) {
      wx.hideLoading();
      this.setData({ uploadingAvatar: false });
      wx.showToast({ title: (err && err.message) || '头像上传失败', icon: 'none' });
    }
  },

  // ---------- 资料 ----------
  openProfile() {
    this.setData({ showProfile: true });
  },
  closeProfile() {
    this.setData({ showProfile: false });
  },
  onProfileInput(e) {
    const k = e.currentTarget.dataset.k;
    this.setData({ [`profile.${k}`]: e.detail.value });
  },
  async saveProfile() {
    const p = this.data.profile;
    if (!p.nickname.trim()) {
      wx.showToast({ title: '请填写昵称', icon: 'none' });
      return;
    }
    this.setData({ savingProfile: true });
    try {
      const res = await api.saveProfile(p);
      wx.showToast({ title: '资料已保存', icon: 'success' });
      this.setData({ showProfile: false });
      this.applyUser(res.user);
    } catch (e) {
      wx.showToast({ title: e.message || '保存失败', icon: 'none' });
    } finally {
      this.setData({ savingProfile: false });
    }
  },

  // ---------- 管理员入口 ----------
  goAdminHome() {
    wx.navigateTo({ url: '/packageAdmin/pages/home/home' });
  },

  openBind() {
    this.setData({ showBind: true, bindToken: '' });
  },
  closeBind() {
    this.setData({ showBind: false });
  },
  onBindInput(e) {
    this.setData({ bindToken: e.detail.value.trim() });
  },
  // 扫码填入绑定码：扫后台「微信对接」页的绑定二维码，把结果填进输入框
  scanBindToken() {
    wx.scanCode({
      success: (res) => {
        let code = String(res.result || '').trim();
        // 绑定码可能是纯 token，也可能包在 URL 里（?token=xxx）
        const m = code.match(/[?&]token=([^&]+)/);
        if (m) code = decodeURIComponent(m[1]);
        if (!code) { wx.showToast({ title: '无效的绑定码', icon: 'none' }); return; }
        this.setData({ bindToken: code });
        wx.showToast({ title: '已填入，请确认绑定', icon: 'none' });
      },
      fail: () => { /* 用户取消扫描 */ }
    });
  },
  async doBind() {
    if (!this.data.bindToken) {
      wx.showToast({ title: '请输入绑定码', icon: 'none' });
      return;
    }
    this.setData({ binding: true });
    try {
      const res = await api.bindAdmin(this.data.bindToken);
      wx.showToast({ title: res.msg || '绑定成功', icon: 'success' });
      this.setData({ showBind: false });
      this.applyUser(res.user);
    } catch (e) {
      wx.showToast({ title: e.message || '绑定失败', icon: 'none' });
    } finally {
      this.setData({ binding: false });
    }
  },

  // ---------- 扫码登录后台 ----------
  // 扫码绑定账号：后台给普通用户生成一次性二维码（printgate://bind?ticket=xxx）
  scanBindAccount() {
    const app = getApp();
    wx.scanCode({
      onlyFromCamera: false,
      scanType: ['qrCode'],
      success: async (res) => {
        const raw = String(res.result || res.path || '').trim();
        const m = raw.match(/ticket=([A-Za-z0-9_-]+)/);
        const ticket = m ? m[1] : raw;
        if (!ticket) return wx.showToast({ title: '二维码内容无效', icon: 'none' });
        wx.showLoading({ title: '绑定中', mask: true });
        try {
          const r = await api.bindUser(ticket);
          if (r && r.token) app.setTokenAndSave(r.token);
          wx.showToast({ title: (r && r.msg) || '绑定成功', icon: 'success' });
          // 绑定会把当前微信切到另一个账号，必须重拉用户信息并同步全局登录态。
          // 这里原来写的是 this.load()，但本页没有 load 方法 —— 会抛 TypeError，
          // 界面还停在绑定前的旧账号上（看着像「绑定成功但没生效」）。
          const u = await app.refreshUser();
          if (u) this.applyUser(u);
          else this.refreshUser();
        } catch (e) {
          wx.showToast({ title: e.message || '绑定失败', icon: 'none' });
        } finally { wx.hideLoading(); }
      },
      fail: () => wx.showToast({ title: '已取消扫码', icon: 'none' })
    });
  },

  onScanQr() {
    wx.scanCode({
      success: (res) => {
        let ticket = String(res.result || '').trim();
        // 二维码可能是完整 URL，取出 ticket 参数
        const m = ticket.match(/[?&]ticket=([^&]+)/);
        if (m) ticket = decodeURIComponent(m[1]);
        if (!ticket) {
          wx.showToast({ title: '无效的二维码', icon: 'none' });
          return;
        }
        this.setData({ qrTicket: ticket });
        api.qrScan(ticket).then(() => {
          this.setData({ showQrConfirm: true });
        }).catch((e) => {
          wx.showToast({ title: e.message || '扫描失败', icon: 'none' });
        });
      },
      fail: () => { /* 用户取消扫描 */ }
    });
  },
  closeQrConfirm() {
    this.setData({ showQrConfirm: false, qrTicket: '' });
  },
  async confirmQr() {
    this.setData({ confirmingQr: true });
    try {
      await api.qrConfirm(this.data.qrTicket);
      wx.showToast({ title: '已确认，网页将自动登录', icon: 'success' });
      this.setData({ showQrConfirm: false, qrTicket: '' });
    } catch (e) {
      wx.showToast({ title: e.message || '确认失败', icon: 'none' });
    } finally {
      this.setData({ confirmingQr: false });
    }
  },

  // ---------- 服务地址 ----------
  openBase() {
    const app = getApp();
    this.setData({ showBase: true, baseInput: app.globalData.baseUrl || '' });
  },
  closeBase() {
    this.setData({ showBase: false });
  },
  onBaseInput(e) {
    this.setData({ baseInput: e.detail.value.trim() });
  },
  usePreset(e) {
    const preset = e.currentTarget.dataset.preset;
    if (preset) this.setData({ baseInput: preset });
  },
  saveBase() {
    let v = this.data.baseInput.trim().replace(/\/+$/, '');
    if (v && !/^https?:\/\//.test(v)) v = `http://${v}`;
    if (!v) {
      wx.showToast({ title: '请输入服务地址', icon: 'none' });
      return;
    }
    const app = getApp();
    app.setBaseUrlAndSave(v);
    this.setData({ showBase: false, baseUrl: v });
    app.bootstrap();
    wx.showToast({ title: '服务地址已保存', icon: 'success' });
  },

  // ---------- 主题 ----------
  openTheme() {
    const app = getApp();
    this.setData({ showTheme: true, themeMode: app.globalData.themeMode || 'auto' });
  },
  closeTheme() {
    this.setData({ showTheme: false });
  },
  setTheme(e) {
    const mode = e.currentTarget.dataset.mode;
    const app = getApp();
    const m = app.setThemeMode(mode);
    this.setData({
      themeMode: m,
      themeLabel: MODE_LABEL[m] || '跟随系统',
      dark: app.isDark(),
      showTheme: false
    });
    wx.showToast({ title: `已切换为${MODE_LABEL[m]}`, icon: 'none' });
  },

  // 选择主题色：立即生效（页面根节点 CSS 变量）+ 持久化 + 同步 tabBar
  setPrimaryColor(e) {
    const color = e.currentTarget.dataset.color;
    if (!color) return;
    const app = getApp();
    const v = app.setPrimary(color);
    this.setData({
      primary: v,
      primaryName: primaryNameOf(v),
      primaryStyle: app.primaryStyle()
    });
  },

  // ---------- 关于 / 退出 ----------
  openAbout() { this.setData({ showAbout: true }); },
  closeAbout() { this.setData({ showAbout: false }); },
  askLogout() { this.setData({ showLogout: true }); },
  onLogoutCancel() { this.setData({ showLogout: false }); },
  onLogoutOk() {
    this.setData({ showLogout: false });
    const app = getApp();
    app.logout();
    wx.reLaunch({ url: '/pages/login/login' });
  },

  // ---------- 视图辅助 ----------
  roleText() { return this.data.user && this.data.user.role === 'admin' ? '管理员' : '普通用户'; },
  statusText() { const u = this.data.user; return u ? userStatus(u.status).text : ''; },
  statusKind() { const u = this.data.user; return u ? userStatus(u.status).kind : 'plain'; },
  isPending() { const u = this.data.user; return !!u && u.status === 'pending'; },
  profileDone() {
    const p = this.data.profile;
    return !!(p.wechat_id || p.phone || p.real_name);
  }
});
