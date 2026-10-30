// 数字步进器：份数等；暗夜自适配
Component({
  properties: {
    value: { type: Number, value: 1 },
    min: { type: Number, value: 1 },
    max: { type: Number, value: 99 },
    unit: { type: String, value: '' }
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
    onMinus() {
      if (this.data.value <= this.data.min) return;
      this.triggerEvent('change', { value: this.data.value - 1 });
    },
    onPlus() {
      if (this.data.value >= this.data.max) {
        wx.showToast({ title: `上限 ${this.data.max}`, icon: 'none' });
        return;
      }
      this.triggerEvent('change', { value: this.data.value + 1 });
    }
  }
});
