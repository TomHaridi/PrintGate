// 自定义导航栏：状态栏高度 + 微信胶囊按钮对齐；暗夜自适配
Component({
  properties: {
    title: { type: String, value: '' },
    showBack: { type: Boolean, value: false },
    center: { type: Boolean, value: false }
  },
  data: {
    statusHeight: 20,
    navHeight: 44,
    rightGap: 7,
    canBack: false,
    dark: false
  },
  lifetimes: {
    attached() {
      let sys = null;
      try { sys = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync(); } catch (_) { sys = null; }
      let rect = null;
      try { rect = wx.getMenuButtonBoundingClientRect(); } catch (_) { rect = null; }
      const statusH = (sys && sys.statusBarHeight) || 20;
      const navH = rect ? (rect.top - statusH) * 2 + rect.height : 44;
      const pages = getCurrentPages();
      const app = getApp();
      this.setData({
        statusHeight: statusH,
        navHeight: navH,
        rightGap: rect ? (sys.windowWidth - rect.right) : 7,
        canBack: pages.length > 1,
        dark: !!(app && app.globalData && app.globalData.dark)
      });
    },
    // 页面再次显示时同步主题（切换主题后长驻组件要刷新暗夜类）
    show() {
      const app = getApp();
      const dark = !!(app && app.globalData && app.globalData.dark);
      if (dark !== this.data.dark) this.setData({ dark });
    }
  },
  methods: {
    onBack() {
      const pages = getCurrentPages();
      if (pages.length > 1) {
        wx.navigateBack({ fail: () => wx.reLaunch({ url: '/pages/index/index' }) });
      } else {
        this.triggerEvent('back');
      }
    }
  }
});
