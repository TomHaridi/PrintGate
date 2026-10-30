// 系统设置：管理员可查看并修改后端开放的全部设置项（卡片风格 + 暗夜）
// 与后端 MP_SETTABLE 白名单一一对应：
// maxFileMB / maxCopies / maxPages / historyDays / approveNewUser /
// approveEachJob / enableQrLogin / autoCleanHistory / defaultPrinter
const api = require('../../../services/api');

// 取值范围（与后端校验一致，先拦一层）
const RANGES = {
  maxFileMB: { min: 1, max: 500, label: '单文件大小上限' },
  maxCopies: { min: 1, max: 99, label: '单任务份数上限' },
  maxPages: { min: 1, max: 2000, label: '单任务页数上限' },
  historyDays: { min: 0, max: 3650, label: '历史保留天数' }
};

Page({
  data: {
    dark: false,
    primaryStyle: '',
    settings: null,
    printers: [],
    loading: true,
    denied: false,
    saving: false,
    dirty: false
  },

  onShow() {
    const app = getApp();
    this.setData({ dark: app.isDark(), primaryStyle: app.primaryStyle() });
    if (!app.globalData.token) {
      wx.reLaunch({ url: '/pages/login/login' });
      return;
    }
    this.load();
  },

  load() {
    this.setData({ loading: true });
    return Promise.all([api.adminSettings(), api.adminPrinters()]).then(([s, p]) => {
      const st = s.settings || null;
      const names = (p.printers || []).map((x) => x.name);
      // WXML 不能调用页面方法：下拉选中项与显示文案在这里算好
      const cur = st ? names.indexOf(st.defaultPrinter) : -1;
      this.setData({
        settings: st,
        printers: names,
        printerIndex: cur < 0 ? 0 : cur,
        printerText: !st ? '未设置' : (st.defaultPrinter || '未设置（提交时需指定打印机）'),
        loading: false,
        denied: false,
        dirty: false
      });
    }).catch((e) => {
      this.setData({ loading: false });
      if (e.status === 403 || e.code === 'NOT_ADMIN') {
        this.setData({ denied: true });
      } else {
        wx.showToast({ title: e.message || '加载失败', icon: 'none' });
      }
    });
  },

  onPullDownRefresh() {
    this.load().finally(() => wx.stopPullDownRefresh());
  },

  // ---------- 交互 ----------
  onIntInput(e) {
    const k = e.currentTarget.dataset.k;
    const v = e.detail.value;
    this.setData({ [`settings.${k}`]: v, dirty: true });
  },

  onIntBlur(e) {
    const k = e.currentTarget.dataset.k;
    const r = RANGES[k];
    let n = parseInt(this.data.settings[k], 10);
    if (!Number.isFinite(n)) n = r.min;
    n = Math.min(Math.max(n, r.min), r.max);
    this.setData({ [`settings.${k}`]: n });
  },

  onCopiesChange(e) {
    this.setData({ 'settings.maxCopies': e.detail.value, dirty: true });
  },

  onToggle(e) {
    const k = e.currentTarget.dataset.k;
    this.setData({ [`settings.${k}`]: e.detail.value, dirty: true });
  },

  onPrinterChange(e) {
    const idx = parseInt(e.detail.value, 10) || 0;
    this.setData({ 'settings.defaultPrinter': this.data.printers[idx] || '', dirty: true });
  },

  async save() {
    const s = this.data.settings;
    if (!s) return;
    // 范围校验（与后端一致）
    for (const [k, r] of Object.entries(RANGES)) {
      const n = parseInt(s[k], 10);
      if (!Number.isFinite(n) || n < r.min || n > r.max) {
        wx.showToast({ title: `${r.label}需在 ${r.min}-${r.max} 之间`, icon: 'none' });
        return;
      }
    }
    this.setData({ saving: true });
    try {
      const payload = {
        maxFileMB: parseInt(s.maxFileMB, 10),
        maxCopies: parseInt(s.maxCopies, 10),
        maxPages: parseInt(s.maxPages, 10),
        historyDays: parseInt(s.historyDays, 10),
        approveNewUser: !!s.approveNewUser,
        approveEachJob: !!s.approveEachJob,
        enableQrLogin: !!s.enableQrLogin,
        autoCleanHistory: !!s.autoCleanHistory,
        defaultPrinter: s.defaultPrinter || ''
      };
      await api.adminSaveSettings(payload);
      wx.showToast({ title: '设置已保存并生效', icon: 'success' });
      this.setData({ dirty: false });
    } catch (e) {
      wx.showToast({ title: e.message || '保存失败', icon: 'none' });
    } finally {
      this.setData({ saving: false });
    }
  },

  // ---------- 视图辅助 ----------
  boolVal(k) { const s = this.data.settings; return !!s && !!s[k]; },
  rangeHint(k) {
    const r = RANGES[k];
    return `（${r.min} - ${r.max}）`;
  },
  intVal(k) { const s = this.data.settings; return s ? String(s[k]) : ''; },
  printerIndex() {
    const i = this.data.printers.indexOf(this.data.settings ? this.data.settings.defaultPrinter : '');
    return i < 0 ? 0 : i;
  },
  printerText() {
    const s = this.data.settings;
    if (!s) return '未设置';
    return s.defaultPrinter || '未设置（提交时需指定打印机）';
  }
});
