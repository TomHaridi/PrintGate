// 管理后台首页：Bento 概览 + 功能入口 + 打印机状态（卡片风格 + 暗夜）
const api = require('../../../services/api');
const { printerState } = require('../../../utils/format');

// WXML 不能调用页面方法：状态文案在这里算好
function decoratePrinter(p) {
  const st = printerState(p.state);
  return Object.assign({}, p, { _state: st.text, _stateKind: st.kind });
}

Page({
  data: {
    dark: false,
    primaryStyle: '',
    overview: null,
    printers: [],
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
    return api.adminOverview().then((res) => {
      this.setData({
        overview: res.overview || null,
        printers: (res.printers || []).map(decoratePrinter),
        loading: false,
        denied: false
      });
    }).catch((e) => {
      this.setData({ loading: false });
      if (e.code === 'NOT_ADMIN' || e.status === 403) {
        this.setData({ denied: true });
      } else {
        wx.showToast({ title: e.message || '加载失败', icon: 'none' });
      }
    });
  },

  goUsers() { wx.navigateTo({ url: '/packageAdmin/pages/users/users' }); },
  goApprove() { wx.navigateTo({ url: '/packageAdmin/pages/approve/approve' }); },
  goPrinters() { wx.navigateTo({ url: '/packageAdmin/pages/printers/printers' }); },
  goSettings() { wx.navigateTo({ url: '/packageAdmin/pages/settings/settings' }); },
  goHistory() { wx.navigateTo({ url: '/packageAdmin/pages/history/history' }); },

  // ---------- 视图辅助 ----------
  stateText(p) { return printerState(p.state).text; },
  stateKind(p) { return printerState(p.state).kind; },
  cupsText() {
    const o = this.data.overview;
    if (!o) return '';
    return o.cupsOk ? '正常' : '异常';
  },
  cupsKind() {
    const o = this.data.overview;
    return o && o.cupsOk ? 'success' : 'danger';
  }
});
