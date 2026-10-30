// 分区卡片：标题 + 右侧附加 + 内容插槽；暗夜自适配
// 标题栏点击触发 headtap 自定义事件（catchtap 阻止冒泡，不会误触内容区）
Component({
  properties: {
    title: { type: String, value: '' },
    extra: { type: String, value: '' },
    plain: { type: Boolean, value: false }
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
    onHeadTap() { this.triggerEvent('headtap'); },
    noop() {}
  }
});
