// 确认弹窗：ok / cancel 事件；danger 样式用于删除等危险操作；暗夜自适配
Component({
  properties: {
    visible: { type: Boolean, value: false },
    title: { type: String, value: '提示' },
    content: { type: String, value: '' },
    okText: { type: String, value: '确定' },
    cancelText: { type: String, value: '取消' },
    danger: { type: Boolean, value: false },
    single: { type: Boolean, value: false }
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
    noop() {},
    onMask() { this.triggerEvent('cancel'); },
    onOk() { this.triggerEvent('ok'); },
    onCancel() { this.triggerEvent('cancel'); }
  }
});
