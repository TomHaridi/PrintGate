// 搜索栏：防抖输入 / 清除 / 确认；暗夜自适配
Component({
  properties: {
    placeholder: { type: String, value: '搜索' },
    debounce: { type: Number, value: 350 }
  },
  data: { value: '', dark: false },
  lifetimes: {
    attached() {
      const app = getApp();
      this.setData({ dark: !!(app && app.globalData && app.globalData.dark) });
    },
    detached() {
      // 组件销毁时清掉未触发的防抖回调，避免向已销毁的页面派发事件
      if (this._t) { clearTimeout(this._t); this._t = null; }
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
    onInput(e) {
      const value = e.detail.value;
      this.setData({ value });
      this.triggerEvent('input', { value });
      if (this.data.debounce > 0) {
        clearTimeout(this._t);
        this._t = setTimeout(() => this.triggerEvent('search', { value }), this.data.debounce);
      }
    },
    onConfirm(e) {
      if (this._t) { clearTimeout(this._t); this._t = null; }
      this.triggerEvent('search', { value: e.detail.value });
    },
    onSearch() {
      if (this._t) { clearTimeout(this._t); this._t = null; }
      this.triggerEvent('search', { value: this.data.value });
    },
    onClear() {
      if (this._t) { clearTimeout(this._t); this._t = null; }
      this.setData({ value: '' });
      this.triggerEvent('input', { value: '' });
      this.triggerEvent('search', { value: '' });
    },
    setValue(v) { this.setData({ value: v || '' }); }
  }
});
