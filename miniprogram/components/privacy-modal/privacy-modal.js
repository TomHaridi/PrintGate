// 隐私协议弹窗：只负责「展示与结算」，监听统一由 utils/privacy.js 收口
// 结算逻辑见 utils/privacy.js 顶部注释（为什么不能各自 on/off）
const privacy = require('../../utils/privacy');

Component({
  data: { show: false, privacyContractName: '', dark: false },

  lifetimes: {
    attached() {
      const app = getApp();
      this.setData({ dark: !!(app && app.globalData && app.globalData.dark) });
      this.__dead = false;
      privacy.attach(this);
      this.fetchContractName();
    },
    detached() {
      this._clearTimer();
      // 只撤销自己的前台身份。绝不能在这里 wx.offNeedPrivacyAuthorization()：
      // 那会把别的页面刚注册的监听一起清掉（详见 utils/privacy.js）
      privacy.detach(this);
    }
  },

  // show 属于 pageLifetimes（写在 lifetimes 下不会被触发）：tab 页常驻，
  // 切回本页时必须重新登记为前台，否则弹窗会落在已隐藏的旧页面上。
  pageLifetimes: {
    show() {
      const app = getApp();
      const dark = !!(app && app.globalData && app.globalData.dark);
      if (dark !== this.data.dark) this.setData({ dark });
      this.__dead = false;
      privacy.attach(this);
    }
  },

  methods: {
    // 由收口模块调用
    showPrivacy() { this.setData({ show: true }); },
    hidePrivacy() { this.setData({ show: false }); },

    _clearTimer() {
      if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    },

    fetchContractName() {
      if (!wx.getPrivacySetting) return;
      wx.getPrivacySetting({
        success: (res) => {
          if (res.privacyContractName) this.setData({ privacyContractName: res.privacyContractName });
        },
        fail: () => {}
      });
    },

    // 官方同意按钮：必须由 <button open-type="agreePrivacyAuthorization"> 触发。
    // 微信在 button 点击时记录同意状态，我们再把 buttonId 回传给 resolve 完成结算。
    // 之前的自绘 view + resolve({event:'agree'}) 只放行「这一次」调用、不记账，
    // 于是每次点「聊天文件 / 图片相册」都会被重新拦截 —— 就是「点了同意还是选不了」。
    onAgreePrivacy() {
      this._clearTimer();
      privacy.settle(this, 'agree', 'privacy-agree-btn');
    },

    onDisagree() {
      this._clearTimer();
      privacy.settle(this, 'disagree');
      this.triggerEvent('disagree');
    },

    openContract() {
      wx.openPrivacyContract({ fail: () => {} });
    },

    // catchtap 阻止冒泡用的显式空处理器（避免引用不存在的方法）
    noop() {}
  }
});
