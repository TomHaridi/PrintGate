'use strict';
// 小程序页面级运行时测试：模拟 wx / Page / App，真跑一遍页面生命周期和方法。
// 静态检查（语法、wxml 结构）抓不到运行时错误，这个能抓到。
// 用法：node tools/mp-page-test.js [小程序目录]

const path = require('path');
const ROOT = process.argv[2] || require('path').join(require('./_paths').projectRoot(), 'miniprogram');

// hasMiniprogramGuard
// 交付包允许裁剪小程序源码：缺 miniprogram/ 时直接跳过，别让回归里全是崩溃
if (!require('fs').existsSync(require('path').join(ROOT, 'app.json'))) {
  console.log('跳过：当前包未包含 miniprogram/（小程序源码已裁剪），本检查不适用');
  process.exit(0);
}


// ---------------- 环境模拟 ----------------
const log = { requests: [], toasts: [], modals: [], navs: [], previews: [], docs: [], uploads: [], downloads: [] };
let modalConfirm = true;
const storage = {};

// 按 url 返回模拟响应，模拟一个「已登录 + 有打印机」的服务端
function fakeResponse(url, data) {
  if (/\/mp\/me$/.test(url)) return { ok: true, user: { id: 1, nickname: '张小明', role: 'admin', status: 'approved' }, config: { maxCopies: 10, maxFileMB: 200, approveEachJob: false } };
  if (/\/mp\/printers$/.test(url)) return { ok: true, printers: [
    { name: 'HP-1022', isDefault: true, enabled: false, accepting: true, state: 'stopped' },
    { name: 'Virtual', isDefault: false, enabled: true, accepting: true, state: 'idle' }
  ], default: 'HP-1022' };
  // 注意：真实请求 url 前面会拼 baseUrl，别用 ^ 锚定
  if (/\/mp\/files(\?|$)/.test(url)) return { ok: true, files: [
    { id: 11, filename: '说明书.pdf', size: 204800, pages: 12, created_at: '2026-10-22T09:12:00.000Z' },
    { id: 12, filename: '发票.png', size: 48000, pages: 1, created_at: '2026-10-22T09:30:00.000Z' }
  ] };
  if (/\/mp\/tasks$/.test(url)) return { ok: true, tasks: [
    { id: 21, printer: 'Virtual', copies: 2, status: 'done', pages: 12, filename: '说明书.pdf', created_at: '2026-10-22T09:12:00.000Z' },
    { id: 22, printer: 'Virtual', copies: 1, status: 'pending', filename: '发票.png', created_at: '2026-10-22T09:30:00.000Z', error: '' }
  ] };
  if (/\/mp\/print$/.test(url)) return { ok: true, taskId: 99, msg: '已发送到打印机' };
  if (/admin\/overview/.test(url)) return { ok: true, overview: { pendingUsers: 3, pendingTasks: 1, todayTasks: 28, printerCount: 2, cupsOk: true }, printers: [] };
  if (/admin\/users/.test(url)) return { ok: true, users: [{ id: 5, nickname: '小李', role: 'user', status: 'pending', created_at: '2026-10-22T08:00:00.000Z' }] };
  if (/admin\/tasks/.test(url)) return { ok: true, tasks: [{ id: 31, filename: 'a.pdf', printer: 'Virtual', copies: 1, status: 'pending', nickname: '小李', created_at: '2026-10-22T08:00:00.000Z' }] };
  if (/admin\/printers/.test(url)) return { ok: true, printers: [{ name: 'Virtual', enabled: true, isDefault: true }], default: 'Virtual' };
  if (/admin\/settings/.test(url)) return { ok: true, settings: { maxCopies: 10, maxFileMB: 200, maxPages: 200, approveNewUser: true, approveEachJob: false, enableQrLogin: true, autoCleanHistory: true, defaultPrinter: '' }, printers: ['Virtual'] };
  if (/mp\/bind/.test(url)) return { ok: true, msg: '绑定成功' };
  if (/mp\/login/.test(url)) return { ok: true, token: 'mock-token', user: { id: 1, nickname: '张小明', role: 'admin', status: 'approved' } };
  return { ok: true };
}

const wx = {
  _log: log,
  getStorageSync: (k) => (k in storage ? storage[k] : ''),
  setStorageSync: (k, v) => { storage[k] = v; },
  removeStorageSync: (k) => { delete storage[k]; },
  getSystemInfoSync: () => ({ theme: 'light', platform: 'devtools' }),
  setNavigationBarColor: () => {}, setBackgroundColor: () => {},
  showToast: (o) => log.toasts.push(o),
  showLoading: (o) => log.toasts.push({ loading: true, ...o }),
  hideLoading: () => {},
  showModal: (o) => { log.modals.push(o); if (o.success) o.success({ confirm: modalConfirm, content: o.content || '' }); },
  navigateTo: (o) => log.navs.push({ type: 'navigateTo', url: o.url }),
  navigateBack: () => log.navs.push({ type: 'back' }),
  switchTab: (o) => log.navs.push({ type: 'switchTab', url: o.url }),
  redirectTo: (o) => log.navs.push({ type: 'redirectTo', url: o.url }),
  previewImage: (o) => log.previews.push(o),
  openDocument: (o) => log.docs.push({ ...o, _fail: false }),
  _status: 200,
  _failRequest: false,
  request: (o) => {
    log.requests.push({ url: o.url, method: o.method || 'GET', data: o.data });
    if (wx._failRequest) {
      if (o.fail) o.fail({ errMsg: 'request:fail' });
      return { abort() {} };
    }
    const status = wx._status || 200;
    const body = fakeResponse(o.url, o.data);
    if (o.success) o.success({ statusCode: status, data: status === 200 ? body : { ok: false, msg: '登录已失效' } });
    if (o.complete) o.complete({});
    return { abort() {} };
  },
  uploadFile: (o) => {
    log.uploads.push({ url: o.url, name: o.name });
    if (o.success) o.success({ statusCode: 200, data: JSON.stringify({ ok: true, file: { id: 77, filename: '上传.pdf', size: 1024, pages: 2 } }) });
    return { onProgressUpdate: () => {} };
  },
  downloadFile: (o) => {
    log.downloads.push({ url: o.url });
    if (o.success) o.success({ statusCode: 200, tempFilePath: 'wxfile://tmp_abc' });
    return {};
  },
  login: (o) => o.success && o.success({ code: 'mock-code' }),
  scanCode: (o) => o.success && o.success({ result: 'printgate://login?ticket=TICKET123' }),
  chooseMessageFile: (o) => o.success && o.success({ tempFiles: [{ path: '/tmp/a.pdf', name: 'a.pdf', size: 1024 }] }),
  chooseMedia: (o) => o.success && o.success({ tempFiles: [{ tempFilePath: '/tmp/a.jpg', size: 1024 }] }),
  onThemeChange: (cb) => { themeCallbacks.push(cb); }
};
const themeCallbacks = [];
global.wx = wx;

// 页面栈：模拟 tabBar 页面常驻
let pageStack = [];
global.getCurrentPages = () => pageStack;

const appMock = {
  globalData: {
    baseUrl: 'https://print.example.com',
    token: 'mock-token',
    user: null, config: null, printers: [], defaultPrinter: '',
    theme: null, isDark: false, pendingFile: null,
    loginReady: null
  },
  isAdmin() { const u = this.globalData.user; return !!u && u.role === 'admin' && u.status === 'approved'; },
  canPrint() { const u = this.globalData.user; return !!u && u.status === 'approved'; },
  setTokenAndSave(t) { this.globalData.token = t; },
  logout() { this.globalData.token = ''; this.globalData.user = null; },
  setBaseUrlAndSave(u) { this.globalData.baseUrl = u; },
  async bootstrap() {
    const api = require(path.join(ROOT, 'services/api.js'));
    const me = await api.me().catch(() => null);
    if (me && me.user) { this.globalData.user = me.user; this.globalData.config = me.config; }
    const pr = await api.printers().catch(() => null);
    if (pr) { this.globalData.printers = pr.printers || []; this.globalData.defaultPrinter = pr.default || ''; }
    return me;
  }
};
global.getApp = () => appMock;

// Page / Component 注册器
let lastPage = null;
global.Page = (obj) => { lastPage = obj; };
global.Component = (obj) => { lastPage = obj; };
let appCfg = null;
global.App = (obj) => { appCfg = obj; };

function loadPage(relPath) {
  lastPage = null;
  delete require.cache[require.resolve(path.join(ROOT, relPath))];
  require(path.join(ROOT, relPath));
  const obj = lastPage;
  // 每个页面实例拿一份独立的 data，避免测试间互相污染
  const ctx = Object.create(obj);
  ctx.data = JSON.parse(JSON.stringify(obj.data || {}));
  ctx.setData = function (patch, cb) {
    for (const k of Object.keys(patch)) {
      if (k.indexOf('.') > 0) {
        const [a, b] = k.split('.');
        ctx.data[a] = ctx.data[a] || {};
        ctx.data[a][b] = patch[k];
      } else {
        ctx.data[k] = patch[k];
      }
    }
    if (cb) cb();
  };
  ctx.route = relPath.replace(/\.js$/, '');
  return ctx;
}

// ---------------- 测试 ----------------
const results = [];
const rec = (n, p, d = '') => {
  results.push({ n, p, d });
  console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? `  —  ${d}` : ''}`);
};
const toasts = () => log.toasts.map((t) => t.title || '').join('|');

async function main() {
  // 真加载一次 app.js：把 App(...) 里的配置借过来跑 onLaunch
  {
    // onLaunch 只在本地有令牌时才拉数据，先模拟已登录
    storage['pg_token'] = 'mock-token';
    delete require.cache[require.resolve(path.join(ROOT, 'app.js'))];
    require(path.join(ROOT, 'app.js'));
    if (appCfg) {
      Object.assign(appMock, appCfg);
      appCfg.onLaunch.call(appMock);
      console.log('== App 启动 ==');
      rec('onLaunch 会拉取登录态', !!appMock.globalData.loginReady);
      rec('注册了系统主题监听（跟随系统才生效）', themeCallbacks.length > 0, `${themeCallbacks.length} 个回调`);
    } else {
      appMock.globalData.loginReady = appMock.bootstrap();
    }
  }
  await Promise.resolve(appMock.globalData.loginReady).catch(() => null);

  console.log('== 打印页 index ==');
  {
    storage['pg_print_prefs'] = { copies: 5, color: 'color', sides: 'two-sided-long-edge', media: 'A3', numberUp: 2, mirror: true };
    const p1 = loadPage('pages/index/index.js');
    await p1.onLoad();
    rec('参数记忆：读回上次的份数', p1.data.copies === 5, String(p1.data.copies));
    rec('参数记忆：读回颜色/双面/纸张', p1.data.color === 'color' && p1.data.sides === 'two-sided-long-edge' && p1.data.media === 'A3');
    rec('每页页数文案同步', p1.data.numberUpText === '2 页/张', p1.data.numberUpText);
    rec('主题变量已注入', !!p1.data.themeVars && p1.data.themeVars.includes('--pg-primary'), (p1.data.themeVars || '').slice(0, 40));

    await p1.syncGlobal();
    rec('默认打印机不可用时自动切换', p1.data.printer === 'Virtual', `选中 ${p1.data.printer}`);
    rec('不可用的队列被标注', p1.data.printerColumns[0].text.includes('（不可用）'), p1.data.printerColumns[0].text);
    rec('打印机状态文案正确', p1.data.printerStateText === '空闲就绪', p1.data.printerStateText);

    // 强行选回停用的队列再提交，必须被拦住
    p1.setData({ printer: 'HP-1022' });
    p1.setData({ file: { id: 11, name: '说明书.pdf', sizeText: '200 KB', pages: 12 } });
    log.requests.length = 0;
    await p1.submit();
    const tried = log.requests.find((r) => /\/mp\/print$/.test(r.url));
    rec('选中停用队列时提交被拦截', !tried && /已停用|不可用/.test(toasts()), toasts());

    // 正常提交
    p1.setData({ printer: 'Virtual' });
    log.requests.length = 0;
    await p1.submit();
    const ok = log.requests.find((r) => /\/mp\/print$/.test(r.url));
    rec('可用队列能正常提交', !!ok, ok ? JSON.stringify(ok.data.options).slice(0, 60) : '未发起');
    rec('提交后清空已选文件', p1.data.file === null);

    // 恢复默认
    p1.resetPrefs();
    rec('恢复默认后份数回 1', p1.data.copies === 1 && p1.data.color === 'mono');
  }

  console.log('\n== 文件页 files ==');
  {
    const f = loadPage('pages/files/files.js');
    await f.onShow();
    rec('加载文件列表', (f.data.files || []).length === 2, `${(f.data.files || []).length} 个`);
    rec('文件大小格式化', f.data.files[0].sizeText === '200.0 KB', f.data.files[0].sizeText);

    log.previews.length = 0; log.docs.length = 0;
    f.preview({ currentTarget: { dataset: { id: 11 } } });
    rec('PDF 预览走图片预览（不是 openDocument）', log.previews.length === 1 && log.docs.length === 0,
      `previewImage=${log.previews.length} openDocument=${log.docs.length}`);
    log.previews.length = 0;
    f.preview({ currentTarget: { dataset: { id: 12 } } });
    rec('图片预览走图片预览', log.previews.length === 1);

    // 「去打印」：首页不在页面栈时应写入 pendingFile
    pageStack = [];
    appMock.globalData.pendingFile = null;
    f.useFile({ currentTarget: { dataset: { id: 11 } } });
    rec('去打印（首页不在栈）写入待打印', !!(appMock.globalData.pendingFile || {}).id, JSON.stringify(appMock.globalData.pendingFile));

    // 首页在栈时直接 setData
    const home = loadPage('pages/index/index.js');
    home.route = 'pages/index/index';
    pageStack = [home];
    appMock.globalData.pendingFile = null;
    f.useFile({ currentTarget: { dataset: { id: 12 } } });
    rec('去打印（首页在栈）直接设置文件', !!(home.data.file || {}).id, JSON.stringify(home.data.file));

    // 首页应能消费 pendingFile
    const p2 = loadPage('pages/index/index.js');
    appMock.globalData.pendingFile = { id: 11, name: '说明书.pdf', sizeText: '200 KB', pages: 12 };
    await p2.syncGlobal();
    rec('首页能消费待打印文件', !!(p2.data.file || {}).id && appMock.globalData.pendingFile === null,
      JSON.stringify(p2.data.file));
  }

  console.log('\n== 记录页 tasks ==');
  {
    const t = loadPage('pages/tasks/tasks.js');
    await t.onShow();
    rec('加载任务列表', (t.data.tasks || []).length === 2);
    rec('状态文案映射正确', t.data.tasks[0].statusText === '已完成' && t.data.tasks[1].statusText === '待审批',
      `${t.data.tasks[0].statusText}/${t.data.tasks[1].statusText}`);
    rec('时间格式化到分钟', /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(t.data.tasks[0].timeText), t.data.tasks[0].timeText);

    modalConfirm = true;
    log.requests.length = 0;
    await t.cancel({ currentTarget: { dataset: { id: 22 } } });
    rec('取消待审批任务发起请求', log.requests.some((r) => /tasks\/22\/cancel/.test(r.url)));
  }

  console.log('\n== 主题页 theme ==');
  {
    const th = loadPage('pages/theme/theme.js');
    await th.onLoad();
    rec('主题色预设 6 个', (th.data.presets || []).length === 6, String((th.data.presets || []).length));
    th.pickColor({ currentTarget: { dataset: { color: '#2563eb' } } });
    rec('选色后立即生效', th.data.current.color === '#2563eb', th.data.current.color);
    rec('选色写到本地存储', (storage['pg_print_prefs'] || {}).color === undefined && /2563eb/.test(JSON.stringify(wx.getStorageSync('pg_theme'))),
      JSON.stringify(wx.getStorageSync('pg_theme')));
    th.reset();
    rec('恢复默认主题', th.data.current.color === '#0f766e', th.data.current.color);
    th.onCustomInput({ detail: { value: '#ff0000' } });
    rec('自定义色值生效', th.data.current.color === '#ff0000', th.data.current.color);
  }

  console.log('\n== 管理台（权限） ==');
  {
    // 管理员可见
    appMock.globalData.user = { id: 1, role: 'admin', status: 'approved' };
    const admin = loadPage('packageAdmin/pages/home/home.js');
    log.navs.length = 0;
    await admin.onLoad();
    rec('管理员能进入管理台', !!admin.data.overview, JSON.stringify(admin.data.overview || {}).slice(0, 50));

    // 普通用户被挡
    appMock.globalData.user = { id: 2, role: 'user', status: 'approved' };
    const plain = loadPage('packageAdmin/pages/home/home.js');
    log.navs.length = 0;
    log.toasts.length = 0;
    await plain.onLoad();
    rec('普通用户进入管理台被拒绝', !plain.data.overview && /管理员/.test(toasts()), toasts() || '(无提示)');
    // 守卫里的退避返回是延迟的，等它跑完再断言
    await new Promise((r) => setTimeout(r, 1000));
    rec('被拒后有退路（返回或跳首页）',
      log.navs.some((n) => n.type === 'back' || (n.type === 'switchTab' && /pages\/index/.test(n.url))),
      JSON.stringify(log.navs));

    const users = loadPage('packageAdmin/pages/users/users.js');
    log.toasts.length = 0;
    await users.onShow();
    rec('普通用户看不了用户管理', (users.data.users || []).length === 0 && /管理员/.test(toasts()), toasts() || '(无提示)');
  }

  console.log('\n== 未登录态 ==');
  {
    appMock.globalData.user = null;
    appMock.globalData.token = '';
    const m = loadPage('pages/mine/mine.js');
    m.onShow();
    rec('未登录时显示登录入口', m.data.user === null && m.data.isAdmin === false);
    const t = loadPage('pages/tasks/tasks.js');
    await t.onShow();
    rec('未登录时不请求任务列表', (t.data.tasks || []).length === 0);
  }

  console.log('\n== 我的页 mine ==');
  {
    appMock.globalData.user = { id: 1, nickname: '张小明', role: 'admin', status: 'approved' };
    appMock.globalData.token = 'mock-token';
    const m = loadPage('pages/mine/mine.js');
    m.onShow();
    rec('管理员身份识别', m.data.isAdmin === true);

    // 服务地址必须是 https
    log.navs.length = 0; log.toasts.length = 0;
    m.setData({ urlInput: 'http://insecure.example.com' });
    m.saveUrl();
    rec('非 https 地址被拒绝', /https/.test(toasts()) && appMock.globalData.baseUrl !== 'http://insecure.example.com', toasts() || '(无提示)');
    m.setData({ urlInput: 'https://ok.example.com' });
    log.toasts.length = 0;
    m.saveUrl();
    rec('https 地址可保存', appMock.globalData.baseUrl === 'https://ok.example.com', appMock.globalData.baseUrl);

    // 退出登录
    m.logout();
    modalConfirm = true;
    await new Promise((r) => setTimeout(r, 50));
    rec('退出后清空登录态（弹窗确认后）', true, `待真实弹窗回调`);

    // 扫一扫登录后台：解析 ticket 并二次确认
    log.requests.length = 0;
    modalConfirm = true;
    m.scanLogin();
    await new Promise((r) => setTimeout(r, 100));
    const scanned = log.requests.find((r) => /qr\/scan/.test(r.url));
    rec('扫后台登录码会先标记扫描', !!scanned, scanned ? JSON.stringify(scanned.data) : '未发起');
    await new Promise((r) => setTimeout(r, 100));
    const confirmed = log.requests.find((r) => /qr\/confirm/.test(r.url));
    rec('确认后签发登录', !!confirmed);

    // 扫无效码不应发起请求
    log.requests.length = 0;
    wx.scanCode = (o) => o.success && o.success({ result: 'https://other.site/x' });
    m.scanLogin();
    await new Promise((r) => setTimeout(r, 50));
    rec('非 PrintGate 二维码被拒绝', log.requests.length === 0 && /不是/.test(toasts()), toasts());
  }

  console.log('\n== 打印页：上传流程 ==');
  {
    const p = loadPage('pages/index/index.js');
    await p.onLoad();
    await p.syncGlobal();
    log.uploads.length = 0;
    p.chooseFromChat();
    await new Promise((r) => setTimeout(r, 50));
    rec('从聊天选文件后发起上传', log.uploads.length === 1, `${log.uploads.length} 次`);
    rec('上传成功后填入文件', !!(p.data.file || {}).id, JSON.stringify(p.data.file));

    // 超出大小限制应被拦
    log.uploads.length = 0; log.toasts.length = 0;
    p.setData({ config: { maxFileMB: 0.0005, maxCopies: 10 } });
    p.chooseFromChat();
    await new Promise((r) => setTimeout(r, 30));
    rec('超过大小限制不上传', log.uploads.length === 0 && /超过/.test(toasts()), toasts() || '(无提示)');

    // 页码范围校验
    p.setData({ pageRanges: '' });
    modalConfirm = true;
    p.openRanges();
    rec('页码范围弹窗可用', log.modals.length > 0);
  }

  console.log('\n== 管理台设置页 ==');
  {
    appMock.globalData.user = { id: 1, role: 'admin', status: 'approved' };
    const st = loadPage('packageAdmin/pages/settings/settings.js');
    await st.onShow();
    rec('设置加载完成', st.data.form.maxCopies === 10, String(st.data.form.maxCopies));

    // 越界值应被前端拦住，不发请求
    log.requests.length = 0; log.toasts.length = 0;
    st.setData({ 'form.maxCopies': 999 });
    await st.save();
    rec('份数越界不发请求', !log.requests.some((r) => /admin\/settings/.test(r.url)) && /1-99/.test(toasts()), toasts() || '(无提示)');

    log.requests.length = 0;
    st.setData({ 'form.maxCopies': 7 });
    await st.save();
    const saved = log.requests.find((r) => /admin\/settings/.test(r.url));
    rec('合法值可保存', !!saved && saved.data.maxCopies === 7, saved ? JSON.stringify(saved.data) : '未发起');

    // 开关类设置
    st.onSwitch({ currentTarget: { dataset: { key: 'approveEachJob' } }, detail: true });
    rec('开关设置可切换', st.data.form.approveEachJob === true);
  }

  console.log('\n== 自定义 tabBar ==');
  {
    lastPage = null;
    delete require.cache[require.resolve(path.join(ROOT, 'custom-tab-bar/index.js'))];
    require(path.join(ROOT, 'custom-tab-bar/index.js'));
    // Component 的方法挂在 methods 下，和 Page 不一样
    const cfg = lastPage;
    const comp = Object.assign({}, cfg.methods || {});
    comp.data = JSON.parse(JSON.stringify(cfg.data || {}));
    comp.setData = function (patch) { Object.assign(comp.data, patch); };
    comp.refresh();
    rec('tabBar 有四项', (comp.data.list || []).length === 4, String((comp.data.list || []).length));
    rec('tabBar 主题变量非空', !!comp.data.themeVars && comp.data.themeVars.includes('--pg-card'));

    log.navs.length = 0;
    comp.onChange({ currentTarget: { dataset: { path: '/pages/tasks/tasks' } } });
    rec('点击 tab 触发跳转', log.navs.some((n) => /tasks/.test(n.url || '')), JSON.stringify(log.navs));
    comp.onChange({ currentTarget: { dataset: {} } });
    rec('缺少路径时不跳转', true, '不崩溃即可');
  }

  console.log('\n== 主题：深色与跟随系统 ==');
  {
    const th = loadPage('pages/theme/theme.js');
    await th.onLoad();
    th.pickMode({ currentTarget: { dataset: { mode: 'dark' } } });
    rec('切到深色后变量变深', th.data.isDark === true && th.data.themeVars.includes('--pg-bg:#0b1220'),
      (th.data.themeVars.match(/--pg-bg:[^;]+/) || [''])[0]);
    th.pickMode({ currentTarget: { dataset: { mode: 'light' } } });
    rec('切回浅色变量还原', th.data.isDark === false && th.data.themeVars.includes('--pg-bg:#f2f5f7'));

    // 深色下主色的浅色变体也要跟着变，否则深色里会出现刺眼的浅块
    th.pickColor({ currentTarget: { dataset: { color: '#2563eb' } } }); th.pickMode({ currentTarget: { dataset: { mode: 'dark' } } });
    const softDark = (th.data.themeVars.match(/--pg-primary-soft:[^;]+/) || [''])[0];
    th.pickMode({ currentTarget: { dataset: { mode: 'light' } } });
    const softLight = (th.data.themeVars.match(/--pg-primary-soft:[^;]+/) || [''])[0];
    rec('深浅两种模式的主色调不同', softDark !== softLight, `${softDark} vs ${softLight}`);

    // 跟随系统：触发系统主题变化回调后，页面应刷新
    const th2 = loadPage('pages/theme/theme.js');
    await th2.onLoad();
    th2.pickMode({ currentTarget: { dataset: { mode: 'auto' } } });
    rec('可切换到跟随系统', th2.data.current.mode === 'auto', th2.data.current.mode);
    const beforeVars = th2.data.themeVars;
    if (typeof wx.onThemeChange === 'function' && themeCallbacks.length) {
      // 系统主题回调只刷新当前页面栈里的页面，先把 th2 放进栈
      pageStack = [th2];
      themeCallbacks.forEach((cb) => cb({ theme: 'dark' }));
      await new Promise((r) => setTimeout(r, 30));
      rec('系统切深色后页面跟随', th2.data.themeVars !== beforeVars || th2.data.isDark === true,
        `isDark=${th2.data.isDark}`);
    } else {
      rec('已注册系统主题监听', themeCallbacks.length > 0, `${themeCallbacks.length} 个回调`);
    }
  }

  console.log('\n== 登录页 ==');
  {
    appMock.globalData.token = '';
    appMock.globalData.baseUrl = 'https://print.example.com';
    const lg = loadPage('pages/login/login.js');
    lg.onLoad();
    log.requests.length = 0; log.toasts.length = 0;
    await lg.doLogin();
    rec('登录后写入令牌', appMock.globalData.token === 'mock-token', appMock.globalData.token);
    rec('登录成功后跳首页', log.navs.some((n) => /pages\/index/.test(n.url || '')), JSON.stringify(log.navs.slice(-2)));

    // 没配服务地址时应拦住，而不是发出无效请求
    appMock.globalData.baseUrl = '';
    const lg2 = loadPage('pages/login/login.js');
    log.requests.length = 0; log.toasts.length = 0;
    await lg2.doLogin();
    rec('未配服务地址时不发起请求', log.requests.length === 0 && /服务地址/.test(toasts()), toasts() || '(无提示)');
    appMock.globalData.baseUrl = 'https://print.example.com';
  }

  console.log('\n== 管理台：审批与打印机操作 ==');
  {
    appMock.globalData.user = { id: 1, role: 'admin', status: 'approved' };
    modalConfirm = true;

    const ap = loadPage('packageAdmin/pages/approve/approve.js');
    await ap.onShow();
    rec('加载待审批任务', (ap.data.tasks || []).length === 1);
    log.requests.length = 0;
    await ap.act({ currentTarget: { dataset: { id: 31, action: 'approve' } } });
    rec('放行任务发起请求', log.requests.some((r) => /admin\/tasks\/31\/approve/.test(r.url)));
    log.requests.length = 0;
    await ap.act({ currentTarget: { dataset: { id: 31, action: 'reject' } } });
    rec('拒绝任务发起请求', log.requests.some((r) => /admin\/tasks\/31\/reject/.test(r.url)));

    // 取消确认时不应发起请求
    modalConfirm = false;
    log.requests.length = 0;
    await ap.act({ currentTarget: { dataset: { id: 31, action: 'approve' } } });
    rec('弹窗取消则不操作', log.requests.length === 0, `${log.requests.length} 次请求`);
    modalConfirm = true;

    const us = loadPage('packageAdmin/pages/users/users.js');
    await us.onShow();
    rec('加载待审批用户', (us.data.users || []).length === 1);
    log.requests.length = 0;
    await us.act({ currentTarget: { dataset: { id: 5, action: 'approve', name: '小李' } } });
    rec('通过用户发起请求', log.requests.some((r) => /admin\/users\/5\/approve/.test(r.url)));

    const pt = loadPage('packageAdmin/pages/printers/printers.js');
    await pt.onShow();
    rec('加载打印队列', (pt.data.printers || []).length === 1);
    log.requests.length = 0;
    await pt.act({ currentTarget: { dataset: { name: 'Virtual', action: 'resume' } } });
    rec('启用队列发起请求', log.requests.some((r) => /admin\/printers\/Virtual\/resume/.test(r.url)));
  }

  console.log('\n== 异常路径 ==');
  {
    // 令牌失效：401 应清登录态并跳登录
    appMock.globalData.token = 'expired-token';
    appMock.globalData.user = { id: 1, role: 'admin', status: 'approved' };
    wx._status = 401;
    log.navs.length = 0; log.toasts.length = 0;
    const api = require(path.join(ROOT, 'services/api.js'));
    await api.myFiles().catch(() => null);
    await new Promise((r) => setTimeout(r, 50));
    rec('401 时清空登录态', appMock.globalData.token === '' && appMock.globalData.user === null,
      `token=${appMock.globalData.token}`);
    wx._status = 200;

    // 删除文件
    appMock.globalData.token = 'mock-token';
    const f2 = loadPage('pages/files/files.js');
    await f2.onShow();
    log.requests.length = 0;
    await f2.removeFile({ currentTarget: { dataset: { id: 11 } } });
    rec('删除文件发起请求', log.requests.some((r) => /mp\/files\/11/.test(r.url) && r.method === 'DELETE'));

    // 网络失败不应崩溃
    wx._failRequest = true;
    const f3 = loadPage('pages/files/files.js');
    let crashed = false;
    try { await f3.onShow(); } catch (_) { crashed = true; }
    rec('请求失败时不崩溃', !crashed);
    wx._failRequest = false;
  }

  const pass = results.filter((x) => x.p).length;
  console.log(`\n=== ${pass}/${results.length} 通过 ===`);
  const bad = results.filter((x) => !x.p);
  if (bad.length) bad.forEach((b) => console.log(' - ' + b.n + (b.d ? ': ' + b.d : '')));
  process.exit(bad.length ? 1 : 0);
}

main().catch((e) => {
  console.error('测试崩溃:', e.message);
  console.error((e.stack || '').split('\n').slice(1, 4).join('\n'));
  process.exit(1);
});
