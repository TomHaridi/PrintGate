import { createRouter, createWebHashHistory } from 'vue-router';
import { store, loadBootstrap, whoami, clearSession } from './store';
import { token } from './api';

const routes = [
  { path: '/setup', name: 'setup', component: () => import('./views/Setup.vue'), meta: { public: true, title: '初始化' } },
  { path: '/login', name: 'login', component: () => import('./views/Login.vue'), meta: { public: true, title: '登录' } },
  // 普通用户的「高级打印工作台」：复用管理台的发起打印页（标准/文字/发票/身份证），
  // 只开放打印能力，数据按 user_id 隔离，仍然看不到任何后台设置
  { path: '/workbench', name: 'workbench', component: () => import('./views/Print.vue'), meta: { title: '打印工作台' } },
  // 普通用户门户：只有「上传打印 / 我的打印记录 / 一键清空」，跟管理台完全隔离
  { path: '/portal', name: 'portal', component: () => import('./views/Portal.vue'), meta: { title: '打印门户' } },
  {
    path: '/',
    component: () => import('./layouts/MainLayout.vue'),
    children: [
      { path: '', redirect: '/dashboard' },
      { path: 'dashboard', name: 'dashboard', component: () => import('./views/Dashboard.vue'), meta: { title: '概览', icon: 'grid' } },
      { path: 'printers', name: 'printers', component: () => import('./views/Printers.vue'), meta: { title: '打印机', icon: 'print' } },
      { path: 'print', name: 'print', component: () => import('./views/Print.vue'), meta: { title: '发起打印', icon: 'document' } },
      { path: 'jobs', name: 'jobs', component: () => import('./views/Jobs.vue'), meta: { title: '打印队列', icon: 'list' } },
      { path: 'tasks', name: 'tasks', component: () => import('./views/Tasks.vue'), meta: { title: '任务审批', icon: 'checkmark' } },
      { path: 'scan', name: 'scan', component: () => import('./views/Scan.vue'), meta: { title: '扫描仪', icon: 'scan' } },
      { path: 'users', name: 'users', component: () => import('./views/Users.vue'), meta: { title: '小程序用户', icon: 'people' } },
      { path: 'wechat', name: 'wechat', component: () => import('./views/Wechat.vue'), meta: { title: '小程序对接', icon: 'phone' } },
      { path: 'relay', name: 'relay', component: () => import('./views/Relay.vue'), meta: { title: '中转对接', icon: 'swap' } },
      { path: 'cups', name: 'cups', component: () => import('./views/Cups.vue'), meta: { title: 'CUPS 后台', icon: 'server' } },
      { path: 'logs', name: 'logs', component: () => import('./views/Logs.vue'), meta: { title: '日志审计', icon: 'time' } },
      { path: 'system', name: 'system', component: () => import('./views/System.vue'), meta: { title: '系统状态', icon: 'pulse' } },
      { path: 'settings', name: 'settings', component: () => import('./views/Settings.vue'), meta: { title: '系统设置', icon: 'settings' } }
    ]
  },
  { path: '/:pathMatch(.*)*', redirect: '/dashboard' }
];

export const router = createRouter({ history: createWebHashHistory(), routes });

router.beforeEach(async (to) => {
  // 首屏守卫可能早于 bootstrap 返回：先等引导信息，避免误判到初始化页
  if (!store.boot.loaded) await loadBootstrap();
  const hasToken = !!token.get();
  if (!to.meta.public && !hasToken) {
    return { name: store.boot.needsSetup ? 'setup' : 'login' };
  }
  if (to.name === 'setup' && !store.boot.needsSetup) return { name: 'login' };

  // 有令牌：先确认身份，普通用户与管理员各走各的入口，互不越界
  if (hasToken && (to.name === 'login' || !to.meta.public)) {
    let role = store.role;
    if (!role) {
      try { role = (await whoami()).role; } catch (_) { role = ''; }
    }
    if (!role) { clearSession(); return { name: 'login' }; }
    const USER_PAGES = ['portal', 'workbench'];
    if (role === 'user' && !USER_PAGES.includes(to.name)) return { name: 'portal' };
    if (role === 'admin' && USER_PAGES.includes(to.name)) return { name: 'dashboard' };
  }
  if (to.meta.title) document.title = `${to.meta.title} · PrintGate`;
  return true;
});
