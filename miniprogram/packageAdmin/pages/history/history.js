// 打印历史（管理端）：查看全部用户/任务的打印记录，支持清除已结束历史（卡片风格 + 暗夜）
const api = require('../../../services/api');
const { taskStatus, optionsSummary, formatTime } = require('../../../utils/format');

const TABS = [
  { key: 'all', label: '全部' },
  { key: 'pending', label: '待审批' },
  { key: 'printing', label: '打印中' },
  { key: 'done', label: '已完成' },
  { key: 'failed', label: '失败' },
  { key: 'rejected', label: '已拒绝' },
  { key: 'canceled', label: '已取消' }
];

// 可清除的状态（已结束）
const CLEANABLE = [
  { key: 'done', label: '已完成' },
  { key: 'failed', label: '失败' },
  { key: 'rejected', label: '已拒绝' },
  { key: 'canceled', label: '已取消' }
];

// WXML 不能调用页面方法：历史列表的名称/状态/时间在这里算好
function decorateTask(t) {
  const st = taskStatus(t.status);
  const parts = [`${t.copies || 1} 份`];
  if (t.pages) parts.push(`${t.pages} 页`);
  return Object.assign({}, t, {
    _name: t.filename || '（文件已清理）',
    _state: st.text,
    _stateKind: st.kind,
    _time: formatTime(t.created_at),
    _printer: t.printer || '未知打印机',
    _summary: parts.join(' · ')
  });
}

Page({
  data: {
    dark: false,
    primaryStyle: '',
    tabs: TABS,
    tab: 'all',
    tasks: [],
    loading: true,
    denied: false,
    // 清除确认
    cleanVisible: false,
    cleanStatus: '',      // '' = 全部已结束
    cleanLabel: '全部已结束记录'
  },

  onShow() {
    const app = getApp();
    this.setData({ dark: app.isDark(), primaryStyle: app.primaryStyle() });
    if (!app.globalData.token) { wx.reLaunch({ url: '/pages/login/login' }); return; }
    this.load();
  },

  onPullDownRefresh() { this.load().finally(() => wx.stopPullDownRefresh()); },

  load() {
    this.setData({ loading: true });
    return api.adminTasks(this.data.tab).then((res) => {
      this.setData({ tasks: (res.tasks || []).map(decorateTask), loading: false, denied: false });
    }).catch((e) => {
      this.setData({ loading: false });
      if (e.status === 403 || e.code === 'NOT_ADMIN') this.setData({ denied: true });
      else wx.showToast({ title: e.message || '加载失败', icon: 'none' });
    });
  },

  switchTab(e) {
    this.setData({ tab: e.currentTarget.dataset.key }, () => this.load());
  },

  // 打开清除确认
  askClean(e) {
    const status = e.currentTarget.dataset.status;
    const label = status ? (CLEANABLE.find((c) => c.key === status) || {}).label : '全部已结束记录';
    this.setData({ cleanVisible: true, cleanStatus: status, cleanLabel: label });
  },
  closeClean() { this.setData({ cleanVisible: false }); },

  async confirmClean() {
    const status = this.data.cleanStatus;
    this.setData({ cleanVisible: false });
    try {
      const res = await api.adminTaskCleanup(status);
      wx.showToast({ title: res.msg || '已清除', icon: 'success' });
      this.load();
    } catch (e) {
      wx.showToast({ title: e.message || '清除失败', icon: 'none' });
    }
  },

  // ---------- 视图辅助 ----------
  statusText(t) { return taskStatus(t.status).text; },
  statusKind(t) { return taskStatus(t.status).kind; },
  timeText(t) { return formatTime(t.created_at); },
  summaryText(t) {
    const parts = [`${t.copies || 1} 份`];
    if (t.pages) parts.push(`${t.pages} 页`);
    return parts.join(' · ');
  },
  fileName(t) { return t.filename || '（文件已清理）'; },
  printerText(t) { return t.printer || '未知打印机'; }
});
