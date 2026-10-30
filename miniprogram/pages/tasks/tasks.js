// 打印记录：状态筛选、查看详情、取消待审批任务（卡片风格 + 暗夜）
const api = require('../../services/api');
const { taskStatus, optionsSummary, relativeTime } = require('../../utils/format');

const TABS = [
  { key: 'all', label: '全部' },
  { key: 'pending', label: '待审批' },
  { key: 'printing', label: '打印中' },
  { key: 'done', label: '已完成' },
  { key: 'failed', label: '未完成' }
];

// 后端状态生命周期：pending → approved → printing → done；pending → rejected / canceled
// approved 是「已放行、尚未送达 CUPS」的瞬态，归入「打印中」才不会从筛选里消失
function matchTab(task, tab) {
  if (tab === 'all') return true;
  if (tab === 'printing') return ['approved', 'printing'].includes(task.status);
  if (tab === 'failed') return ['failed', 'rejected', 'canceled'].includes(task.status);
  return task.status === tab;
}

// WXML 不支持 {{fn(item)}} 这种「调用页面方法」的写法，绑上去只会渲染成空。
// 统一在 JS 里算好展示字段（_name/_state/_time/_meta...），模板只读字段。
function decorateTask(t) {
  const st = taskStatus(t.status);
  const cleaned = t.file_available === false;
  return Object.assign({}, t, {
    _name: (t.filename || (cleaned ? '未知文件' : '未命名文件')) + (cleaned ? '（源文件已清理）' : ''),
    _state: st.text,
    _stateKind: st.kind,
    _time: relativeTime(t.created_at),
    _meta: `${t.printer || '默认打印机'} · ${optionsSummary(t.options || {})}`,
    _error: t.error || '',
    _canCancel: t.status === 'pending'
  });
}

Page({
  data: {
    dark: false,
    primaryStyle: '',
    tabs: TABS,
    tab: 'all',
    tasks: [],
    allTasks: [],
    loading: true,
    cancelTarget: null,
    cancelVisible: false
  },

  onShow() {
    const app = getApp();
    this.setData({ dark: app.isDark(), primaryStyle: app.primaryStyle() });
    if (!app.globalData.token) {
      wx.reLaunch({ url: '/pages/login/login' });
      return;
    }
    this.loadTasks();
  },

  onPullDownRefresh() {
    this.loadTasks().finally(() => wx.stopPullDownRefresh());
  },

  loadTasks() {
    this.setData({ loading: true });
    return api.myTasks().then((res) => {
      // 必须走 decorateTask：模板绑定的是 _name/_state/_time/_meta，
      // 直接塞原始任务对象会让整列渲染成空白（v5.11 漏了这一处）
      const all = (res.tasks || []).map(decorateTask);
      this.setData({ allTasks: all, loading: false }, () => this.applyFilter());
    }).catch((e) => {
      this.setData({ loading: false });
      wx.showToast({ title: e.message || '加载失败', icon: 'none' });
    });
  },

  switchTab(e) {
    const tab = e.currentTarget.dataset.key;
    this.setData({ tab }, () => this.applyFilter());
  },

  applyFilter() {
    const { allTasks, tab } = this.data;
    this.setData({ tasks: allTasks.filter((t) => matchTab(t, tab)) });
  },

  askCancel(e) {
    const id = e.currentTarget.dataset.id;
    const t = this.data.allTasks.find((x) => String(x.id) === String(id));
    if (!t) return;
    this.setData({ cancelTarget: t, cancelVisible: true });
  },

  onCancelCancel() {
    this.setData({ cancelVisible: false, cancelTarget: null });
  },

  onCancelOk() {
    const t = this.data.cancelTarget;
    this.setData({ cancelVisible: false, cancelTarget: null });
    if (!t) return;
    api.cancelTask(t.id).then(() => {
      wx.showToast({ title: '已取消', icon: 'success' });
      this.loadTasks();
    }).catch((e) => {
      wx.showToast({ title: e.message || '取消失败', icon: 'none' });
    });
  },

  goPrint() {
    wx.switchTab({ url: '/pages/index/index' });
  },

  // ---------- 视图辅助 ----------
  statusText(t) { return taskStatus(t.status).text; },
  statusKind(t) { return taskStatus(t.status).kind; },
  timeText(t) { return relativeTime(t.created_at); },
  summaryText(t) { return optionsSummary(t.options || {}); },
  canCancel(t) { return t.status === 'pending'; },
  hasError(t) { return !!t.error; },
  errorText(t) { return t.error; },
  fileName(t) {
    if (t.file_available === false) return `${t.filename || '未知文件'}（源文件已清理）`;
    return t.filename || '（文件已清理）';
  }
});
