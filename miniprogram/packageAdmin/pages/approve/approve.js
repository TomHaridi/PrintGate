// 任务审批：放行 / 拒绝（待审批），查看各状态任务（卡片风格 + 暗夜）
const api = require('../../../services/api');
const { taskStatus, formatTime } = require('../../../utils/format');

// 后端任务状态生命周期：pending → approved → printing → done；pending → rejected / canceled
// 原 tab 只有「已放行/已拒绝」，放行后任务很快进入 printing/done，导致「已放行」几乎恒为空。
// 这里按真实状态补齐，管理员才能看到放行之后的去向。
const TABS = [
  { key: 'pending', label: '待审批' },
  { key: 'approved', label: '已放行' },
  { key: 'printing', label: '打印中' },
  { key: 'done', label: '已完成' },
  { key: 'rejected', label: '已拒绝' },
  { key: 'all', label: '全部' }
];

// WXML 不能调用页面方法：审批列表的名称/状态/时间都在这里算好
function decorateTask(t) {
  const st = taskStatus(t.status);
  const parts = [`${t.copies || 1} 份`];
  if (t.pages) parts.push(`${t.pages} 页`);
  return Object.assign({}, t, {
    _name: t.filename || '（文件已清理）',
    _state: st.text,
    _stateKind: st.kind,
    _time: formatTime(t.created_at),
    _summary: parts.join(' · '),
    _canAct: t.status === 'pending'
  });
}

Page({
  data: {
    dark: false,
    primaryStyle: '',
    tabs: TABS,
    tab: 'pending',
    tasks: [],
    loading: true,
    denied: false,
    actionTarget: null,
    actionVisible: false,
    actionTitle: '',
    actionOkText: '',
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
    return api.adminTasks(this.data.tab).then((res) => {
      this.setData({ tasks: (res.tasks || []).map(decorateTask), loading: false, denied: false });
    }).catch((e) => {
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

  askAction(e) {
    const { id, action } = e.currentTarget.dataset;
    const t = this.data.tasks.find((x) => String(x.id) === String(id));
    if (!t) return;
    const isApprove = action === 'approve';
    this.setData({
      actionTarget: t,
      actionTitle: isApprove ? '放行任务' : '拒绝任务',
      actionOkText: isApprove ? '放行' : '拒绝',
      actionFn: action,
      actionVisible: true
    });
  },

  closeAction() {
    this.setData({ actionVisible: false, actionTarget: null });
  },

  async confirmAction() {
    const t = this.data.actionTarget;
    const action = this.data.actionFn;
    this.setData({ actionVisible: false, actionTarget: null });
    if (!t) return;
    try {
      const res = await api.adminTaskAction(t.id, action);
      wx.showToast({ title: res.msg || '已处理', icon: 'success' });
      this.load();
    } catch (e) {
      wx.showToast({ title: e.message || '操作失败', icon: 'none' });
    }
  },

  // ---------- 视图辅助 ----------
  statusText(t) { return taskStatus(t.status).text; },
  statusKind(t) { return taskStatus(t.status).kind; },
  timeText(t) { return formatTime(t.created_at); },
  // 管理端任务接口只下发 copies / pages（不含完整 options），
  // 不能拿空 options 硬拼「黑白·单面」，否则每条都显示成同一个默认值，误导审批。
  summaryText(t) {
    const parts = [`${t.copies || 1} 份`];
    if (t.pages) parts.push(`${t.pages} 页`);
    return parts.join(' · ');
  },
  canAct(t) { return t.status === 'pending'; },
  fileName(t) { return t.filename || '（文件已清理）'; }
});
