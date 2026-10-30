// 空状态；暗夜自适配
Component({
  properties: {
    text: { type: String, value: '暂无数据' },
    actionText: { type: String, value: '' },
    image: { type: String, value: '/images/empty.png' }
  },
  data: { dark: false },
  lifetimes: {
    attached() {
      const app = getApp();
      this.setData({ dark: !!(app && app.globalData && app.globalData.dark) });
    }
  },

  // show 属于 pageLifetimes；写在 lifetimes 下不会被触发（长驻组件切主题后需刷新暗色类）
  pageLifetimes: {
    show() {
      const app = getApp();
      const dark = !!(app && app.globalData && app.globalData.dark);
      if (dark !== this.data.dark) this.setData({ dark });
    }
  },
  methods: {
    onAction() { this.triggerEvent('action'); }
  }
});
