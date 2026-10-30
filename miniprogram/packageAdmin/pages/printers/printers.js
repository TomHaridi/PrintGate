// 打印机管理：暂停 / 恢复 / 设为默认（卡片风格 + 暗夜）
const api = require('../../../services/api');
const { printerState } = require('../../../utils/format');

// WXML 不能调用页面方法：状态/说明文案在这里算好
function decoratePrinter(p) {
  const st = printerState(p.state);
  return Object.assign({}, p, {
    _state: st.text,
    _stateKind: st.kind,
    _paused: st.kind === 'danger',
    _info: p.info || p.location || ''
  });
}

Page({
  data: {
    dark: false,
    primaryStyle: '',
    printers: [],
    default: '',
    loading: true,
    denied: false
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

  onPullDownRefresh() {
    this.load().finally(() => wx.stopPullDownRefresh());
  },

  load() {
    this.setData({ loading: true });
    return api.adminPrinters().then((res) => {
      const def = res.default || '';
      const list = (res.printers || []).map((p) => Object.assign(decoratePrinter(p), { _isDefault: p.name === def }));
      this.setData({
        printers: list,
        default: def,
        loading: false,
        denied: false
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

  async togglePause(e) {
    const name = e.currentTarget.dataset.name;
    const p = this.data.printers.find((x) => x.name === name);
    if (!p) return;
    const paused = printerState(p.state).kind === 'danger';
    try {
      await api.adminPrinterAction(name, paused ? 'resume' : 'pause');
      wx.showToast({ title: paused ? '已恢复' : '已暂停', icon: 'success' });
      this.load();
    } catch (err) {
      wx.showToast({ title: err.message || '操作失败', icon: 'none' });
    }
  },

  async setDefault(e) {
    const name = e.currentTarget.dataset.name;
    try {
      await api.adminPrinterAction(name, 'default');
      wx.showToast({ title: '已设为默认', icon: 'success' });
      this.load();
    } catch (err) {
      wx.showToast({ title: err.message || '操作失败', icon: 'none' });
    }
  },

  // ---------- 视图辅助 ----------
  stateText(p) { return printerState(p.state).text; },
  stateKind(p) { return printerState(p.state).kind; },
  isPaused(p) { return printerState(p.state).kind === 'danger'; },
  isDefault(p) { return p.name === this.data.default || !!p.isDefault; },
  infoText(p) { return p.info || p.location || ''; }
});
