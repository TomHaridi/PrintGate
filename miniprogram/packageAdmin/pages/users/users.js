// 用户管理：搜索 / 状态筛选 / 授权 / 拒绝 / 拉黑 / 恢复 / 删除（卡片风格 + 暗夜）
const api = require('../../../services/api');
const { userStatus, formatTime } = require('../../../utils/format');

const TABS = [
  { key: 'all', label: '全部' },
  { key: 'pending', label: '待审批' },
  { key: 'approved', label: '已授权' },
  { key: 'rejected', label: '已拒绝' },
  { key: 'blocked', label: '已拉黑' }
];

// WXML 不能调用页面方法：用户列表的头像字/角色/状态/最近登录都在这里算好
function decorateUser(u) {
  const st = userStatus(u.status);
  return Object.assign({}, u, {
    _initial: (u.nickname || 'U').slice(0, 1),
    _role: u.role === 'admin' ? '管理员' : '用户',
    _state: st.text,
    _stateKind: st.kind,
    _lastLogin: u.last_login ? formatTime(u.last_login) : '从未登录'
  });
}

Page({
  data: {
    dark: false,
    primaryStyle: '',
    tabs: TABS,
    tab: 'all',
    keyword: '',
    users: [],
    loading: true,
    denied: false,
    actionTarget: null,
    actionVisible: false,
    actionTitle: '',
    actionOkText: '',
    actionDanger: false,
    actionFn: ''
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
    const base = getApp().globalData.baseUrl || '';
    // 搜索是边打边查，前一次请求可能后到：用序号丢弃过期响应，
    // 否则输入「张三」时会被上一次「张」的结果覆盖，列表和搜索词对不上
    const seq = (this._seq = (this._seq || 0) + 1);
    return api.adminUsers(this.data.tab, this.data.keyword).then((res) => {
      if (seq !== this._seq) return;
      // 头像为服务端相对路径，<image> 需要完整 URL（头像接口免登录）
      const users = (res.users || []).map((u) => Object.assign({}, u, {
        avatar: u.avatar ? (u.avatar.startsWith('http') ? u.avatar : `${base}${u.avatar}`) : ''
      }));
      this.setData({ users: users.map(decorateUser), loading: false, denied: false });
    }).catch((e) => {
      if (seq !== this._seq) return;
      this.setData({ loading: false });
      if (e.status === 403 || e.code === 'NOT_ADMIN') {
        this.setData({ denied: true });
      } else {
        wx.showToast({ title: e.message || '加载失败', icon: 'none' });
      }
    });
  },

  switchTab(e) {
    this.setData({ tab: e.currentTarget.dataset.key }, () => this.load());
  },

  onSearch(e) {
    this.setData({ keyword: e.detail.value || '' }, () => this.load());
  },

  // 打开操作二次确认
  askAction(e) {
    const { id, action } = e.currentTarget.dataset;
    const u = this.data.users.find((x) => String(x.id) === String(id));
    if (!u) return;
    // 与后端一致：不能对自己拉黑 / 删除
    const me = getApp().globalData.user;
    if (me && me.id === u.id && (action === 'delete' || action === 'block')) {
      wx.showToast({ title: '不能对自己执行该操作', icon: 'none' });
      return;
    }
    const cfgMap = {
      approve: { title: '授权用户', okText: '授权', danger: false },
      reject: { title: '拒绝用户', okText: '拒绝', danger: true },
      block: { title: '拉黑用户', okText: '拉黑', danger: true },
      unblock: { title: '恢复用户', okText: '恢复', danger: false },
      delete: { title: '删除用户', okText: '删除', danger: true }
    };
    const c = cfgMap[action] || cfgMap.approve;
    this.setData({
      actionTarget: u,
      actionTitle: c.title,
      actionOkText: c.okText,
      actionDanger: c.danger,
      actionFn: action,
      actionVisible: true
    });
  },

  closeAction() {
    this.setData({ actionVisible: false, actionTarget: null });
  },

  async confirmAction() {
    const u = this.data.actionTarget;
    const action = this.data.actionFn;
    this.setData({ actionVisible: false, actionTarget: null });
    if (!u) return;
    try {
      const res = await api.adminUserAction(u.id, action);
      wx.showToast({ title: res.msg || '已处理', icon: 'success' });
      this.load();
    } catch (e) {
      wx.showToast({ title: e.message || '操作失败', icon: 'none' });
    }
  },

  // ---------- 视图辅助 ----------
  statusText(u) { return userStatus(u.status).text; },
  statusKind(u) { return userStatus(u.status).kind; },
  roleText(u) { return u.role === 'admin' ? '管理员' : '用户'; },
  lastLoginText(u) { return u.last_login ? formatTime(u.last_login) : '从未登录'; },
  initial(u) { return (u.nickname || 'U').slice(0, 1); }
});
