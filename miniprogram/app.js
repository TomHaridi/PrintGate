// 全局：登录态、角色、服务地址、主题、跨页暂存
const { getBaseUrl, setBaseUrl } = require('./utils/config');
const { getToken, clearToken } = require('./utils/auth');
const theme = require('./utils/theme');
const privacy = require('./utils/privacy');

App({
  globalData: {
    baseUrl: getBaseUrl(),
    token: '',
    user: null,          // { id, nickname, avatar, role, status, ... }
    config: null,        // 服务端下发的打印限制 { maxCopies, maxFileMB, approveEachJob }
    printers: [],
    defaultPrinter: '',
    pendingFile: null,   // 从「文件」页带过来待打印的文件 { id, filename, size, pages }
    dark: false,         // 当前是否暗夜
    themeMode: 'auto',   // auto / light / dark
    primary: theme.getPrimary(),   // 主色（可在「我的 → 主题色」自定义）
    loginReady: null     // 登录态就绪的 Promise，页面可 await
  },

  primaryStyle() {
    return theme.primaryStyle(this.globalData.primary, this.isDark());
  },

  // tabBar / 导航栏用的主色：暗夜下提亮一档
  primaryColor() {
    const p = this.globalData.primary || theme.DEFAULT_PRIMARY;
    return this.isDark() ? theme.primaryForDark(p) : p;
  },

  setPrimary(hex) {
    const v = theme.setPrimary(hex);
    this.globalData.primary = v;
    this.applyTheme();
    return v;
  },

  onLaunch() {
    // 隐私监听在启动时注册一次、全局唯一、永不反注册。
    // 等到页面 attach 再注册会慢一拍：某些隐私接口在页面 onLoad 里就调用了。
    privacy.bindOnce();
    this.applyTheme();
    const token = getToken();
    if (token) {
      this.globalData.token = token;
      this.globalData.loginReady = this.bootstrap();
    } else {
      this.globalData.loginReady = Promise.resolve(null);
    }
  },

  onShow() {
    // 从后台恢复时重新解析主题（系统主题可能已变）
    this.applyTheme();
  },

  // ---------- 主题 ----------
  applyTheme() {
    const mode = theme.getMode();
    const dark = theme.isDark(mode);
    this.globalData.themeMode = mode;
    this.globalData.dark = dark;
    // tabBar 配色
    try {
      wx.setTabBarStyle({
        backgroundColor: dark ? '#10181C' : '#FFFFFF',
        color: dark ? '#7A8B92' : '#9AA8AE',
        selectedColor: this.primaryColor(),
        borderStyle: dark ? 'black' : 'white'
      });
    } catch (_) {}
    // 状态栏文字配色（暗夜用浅色文字）
    try {
      wx.setNavigationBarColor({
        frontColor: dark ? '#ffffff' : '#000000',
        backgroundColor: dark ? '#10181C' : '#F3F5F6'
      });
    } catch (_) {}
    // 页面背景（含下拉回弹露出区域）
    try {
      wx.setBackgroundColor({
        backgroundColor: dark ? '#10181C' : '#F3F5F6',
        backgroundColorTop: dark ? '#10181C' : '#F3F5F6',
        backgroundColorBottom: dark ? '#10181C' : '#F3F5F6'
      });
    } catch (_) {}
    return dark;
  },

  setThemeMode(mode) {
    const m = theme.setMode(mode);
    this.applyTheme();
    return m;
  },

  isDark() {
    return !!this.globalData.dark;
  },

  // ---------- 登录态 ----------
  // 拉取用户信息 + 打印机列表；登录后与页面恢复时调用
  bootstrap() {
    const api = require('./services/api');
    return Promise.all([
      api.me().then((u) => {
        this.globalData.user = u.user;
        this.globalData.config = u.config || null;
        return u;
      }).catch(() => null),
      api.printers().then((d) => {
        this.globalData.printers = d.printers || [];
        const dft = d.default || (d.printers || []).find((p) => p.isDefault);
        this.globalData.defaultPrinter = dft ? (dft.name || dft) : '';
        return d;
      }).catch(() => null)
    ]).then(([u]) => u);
  },

  isAdmin() {
    const u = this.globalData.user;
    return !!u && u.role === 'admin' && u.status === 'approved';
  },

  // 已授权用户才能打印（待审批 / 已拒绝 / 已拉黑都不行）
  canPrint() {
    const u = this.globalData.user;
    return !!u && u.status === 'approved';
  },

  refreshUser() {
    const api = require('./services/api');
    return api.me().then((u) => {
      this.globalData.user = u.user;
      this.globalData.config = u.config || null;
      return u.user;
    }).catch(() => null);
  },

  refreshPrinters() {
    const api = require('./services/api');
    return api.printers().then((d) => {
      this.globalData.printers = d.printers || [];
      const dft = d.default || (d.printers || []).find((p) => p.isDefault);
      this.globalData.defaultPrinter = dft ? (dft.name || dft) : '';
      return d;
    }).catch(() => ({ printers: [], default: '' }));
  },

  setTokenAndSave(token) {
    this.globalData.token = token;
    wx.setStorageSync('pg_token', token);
  },

  logout() {
    clearToken();
    this.globalData.token = '';
    this.globalData.user = null;
  },

  setBaseUrlAndSave(url) {
    // 走 config.setBaseUrl：统一做规范化 + 写入「最近使用」列表
    const v = setBaseUrl(url);
    this.globalData.baseUrl = v;
    return v;
  },

  // 跨页传递待打印文件
  setPendingFile(file) {
    this.globalData.pendingFile = file;
  },
  takePendingFile() {
    const f = this.globalData.pendingFile;
    this.globalData.pendingFile = null;
    return f;
  }
});
