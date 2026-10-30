// 底部弹层：visible + title + 默认插槽；暗夜自适配
Component({
  properties: {
    visible: { type: Boolean, value: false },
    title: { type: String, value: '' },
    showClose: { type: Boolean, value: true }
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
    onMask() { this.triggerEvent('close'); },
    noop() {}
  }
});
