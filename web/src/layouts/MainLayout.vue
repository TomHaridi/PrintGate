<template>
  <div class="shell">
    <aside class="sider" :class="{ collapsed: collapsed }">
      <div class="brand" @click="$router.push('/dashboard')">
        <div class="logo">
          <svg viewBox="0 0 32 32" width="26" height="26">
            <path d="M10 12V8h12v4" stroke="#fff" stroke-width="2.2" fill="none" stroke-linecap="round" />
            <rect x="6" y="12" width="20" height="9.5" rx="2.4" fill="#fff" />
            <rect x="11" y="19.5" width="10" height="6" rx="1.2" fill="#0ea5a4" />
            <circle cx="23.4" cy="15.2" r="1.1" fill="#0ea5a4" />
          </svg>
        </div>
        <div v-show="!collapsed" class="brand-text">
          <div class="brand-name">printgate</div>
          <div class="brand-sub">打印网关管理台</div>
        </div>
      </div>

      <n-menu
        :value="activeKey"
        :options="menuOptions"
        :collapsed="collapsed"
        :collapsed-width="68"
        :collapsed-icon-size="20"
        :indent="18"
        inverted
        class="menu"
        @update:value="go"
      />

      <div v-show="!collapsed" class="sider-foot">
        <div class="foot-line">
          <span class="dot" :class="cupsOk === null ? 'warn' : cupsOk ? 'ok' : 'bad'"></span>
          <span>CUPS {{ cupsOk === null ? '检测中…' : cupsOk ? '运行中' : '未就绪' }}</span>
        </div>
        <div class="foot-line">
          <span class="dot" :class="store.boot.wxConfigured ? 'ok' : 'warn'"></span>
          <span>小程序 {{ store.boot.wxConfigured ? '已配置' : '未配置' }}</span>
        </div>
        <div class="foot-ver">v{{ store.boot.version || '2.1.0' }}</div>
      </div>
    </aside>

    <div class="main">
      <header class="topbar">
        <div class="row" style="gap: 12px">
          <n-button quaternary circle size="small" class="only-mobile" @click="drawer = true">
            <template #icon><n-icon :component="MenuOutline" /></template>
          </n-button>
          <n-button quaternary circle size="small" class="only-desktop" @click="collapsed = !collapsed">
            <template #icon><n-icon :component="collapsed ? MenuOutline : ChevronBackOutline" /></template>
          </n-button>
          <div>
            <div class="crumb">{{ crumb }}</div>
            <div class="top-title">{{ route.meta.title || '概览' }}</div>
          </div>
        </div>
        <div class="row" style="gap: 8px">
          <n-tag v-if="pendingCount" type="warning" size="small" round style="cursor: pointer" @click="$router.push('/tasks')">
            待处理 {{ pendingCount }}
          </n-tag>
          <n-tooltip trigger="hover">
            <template #trigger>
              <n-button quaternary circle size="small" @click="refresh">
                <template #icon><n-icon :component="RefreshOutline" /></template>
              </n-button>
            </template>
            <span>刷新当前页数据</span>
          </n-tooltip>
          <n-dropdown :options="userMenu" trigger="click" @select="onUserMenu">
            <div class="user-chip">
              <div class="avatar">管</div>
              <span class="only-desktop">管理员</span>
            </div>
          </n-dropdown>
        </div>
      </header>

      <section class="content scrollbar-thin">
        <router-view v-slot="{ Component }">
          <transition name="fade" mode="out-in">
            <component :is="Component" />
          </transition>
        </router-view>
      </section>
    </div>

    <n-drawer v-model:show="drawer" :width="260" placement="left">
      <n-drawer-content body-content-style="padding:0">
        <div class="drawer-brand">printgate</div>
        <n-menu :value="activeKey" :options="menuOptions" inverted @update:value="(k) => { drawer = false; go(k); }" />
      </n-drawer-content>
    </n-drawer>
  </div>
</template>

<script setup>
import { computed, h, onMounted, onBeforeUnmount, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { NIcon, useMessage, useDialog } from 'naive-ui';
import {
  GridOutline, PrintOutline, DocumentTextOutline, ListOutline, CheckmarkDoneOutline,
  ScanOutline, PeopleOutline, PhonePortraitOutline, SwapHorizontalOutline, TimeOutline,
  PulseOutline, SettingsOutline, LogOutOutline, RefreshOutline, MenuOutline, ChevronBackOutline,
  KeyOutline, ServerOutline
} from '@vicons/ionicons5';
import { api } from '../api';
import { store, logout } from '../store';

const route = useRoute();
const router = useRouter();
const message = useMessage();
const dialog = useDialog();

const collapsed = ref(false);
const drawer = ref(false);
const cupsOk = ref(null);
const pendingCount = ref(0);

const icon = (c) => () => h(NIcon, { component: c });

const menuOptions = computed(() => [
  { type: 'group', label: '总览', key: 'g1', children: [
    { label: '概览', key: 'dashboard', icon: icon(GridOutline) }
  ] },
  { type: 'group', label: '打印', key: 'g2', children: [
    { label: '打印机', key: 'printers', icon: icon(PrintOutline) },
    { label: '发起打印', key: 'print', icon: icon(DocumentTextOutline) },
    { label: '打印队列', key: 'jobs', icon: icon(ListOutline) },
    { label: '任务审批', key: 'tasks', icon: icon(CheckmarkDoneOutline) },
    { label: '扫描仪', key: 'scan', icon: icon(ScanOutline) }
  ] },
  { type: 'group', label: '对接', key: 'g3', children: [
    { label: '小程序用户', key: 'users', icon: icon(PeopleOutline) },
    { label: '小程序对接', key: 'wechat', icon: icon(PhonePortraitOutline) },
    { label: '中转对接', key: 'relay', icon: icon(SwapHorizontalOutline) }
  ] },
  { type: 'group', label: '运维', key: 'g4', children: [
    { label: 'CUPS 后台', key: 'cups', icon: icon(ServerOutline) },
    { label: '日志审计', key: 'logs', icon: icon(TimeOutline) },
    { label: '系统状态', key: 'system', icon: icon(PulseOutline) },
    { label: '系统设置', key: 'settings', icon: icon(SettingsOutline) }
  ] }
]);

const activeKey = computed(() => route.name);
const crumb = computed(() => `PrintGate / ${route.meta.title || '概览'}`);

const userMenu = [
  { label: '修改密码', key: 'password', icon: icon(KeyOutline) },
  { type: 'divider', key: 'd1' },
  { label: '退出登录', key: 'logout', icon: icon(LogOutOutline) }
];

function go(key) {
  if (key && key !== route.name) router.push({ name: key });
}

function refresh() {
  window.dispatchEvent(new CustomEvent('pg:refresh'));
  message.success('已刷新');
}

function onUserMenu(key) {
  if (key === 'logout') {
    dialog.warning({
      title: '退出登录',
      content: '确定要退出当前管理后台吗？',
      positiveText: '退出',
      negativeText: '取消',
      onPositiveClick: async () => {
        try { await api.post('/auth/logout'); } catch (_) {}
        logout();
        router.replace({ name: 'login' });
      }
    });
  } else if (key === 'password') {
    router.push({ name: 'settings', query: { tab: 'security' } });
  }
}

async function poll() {
  // 先拿轻量的打印机状态，避免概览接口较慢时侧栏长时间停在「检测中」
  try {
    const p = await api.get('/printers');
    cupsOk.value = !!(p.cups && p.cups.running);
  } catch (_) {}
  try {
    const d = await api.get('/dashboard');
    pendingCount.value = (d.counts?.tasksPending || 0) + (d.counts?.usersPending || 0);
  } catch (_) {}
}

let timer = null;
onMounted(() => {
  poll();
  timer = setInterval(poll, 20000);
});
onBeforeUnmount(() => clearInterval(timer));
</script>

<style scoped>
.shell { display: flex; height: 100vh; overflow: hidden; }
.sider {
  width: 236px; flex: 0 0 236px; background: var(--pg-sidebar);
  display: flex; flex-direction: column; transition: width .22s ease, flex-basis .22s ease;
  padding: 14px 10px 10px; color: #cbd5e1;
}
.sider.collapsed { width: 76px; flex-basis: 76px; }
.brand { display: flex; align-items: center; gap: 10px; padding: 6px 8px 16px; cursor: pointer; }
.logo {
  width: 36px; height: 36px; border-radius: 10px; background: linear-gradient(140deg, #0ea5a4, #0f766e);
  display: grid; place-items: center; flex: 0 0 36px; box-shadow: 0 6px 16px rgba(14, 165, 164, .25);
}
.brand-name { color: #fff; font-weight: 700; font-size: 16px; letter-spacing: .3px; line-height: 1.1; }
.brand-sub { color: #94a3b8; font-size: 11px; margin-top: 2px; }
.menu { flex: 1; overflow-y: auto; }
.sider :deep(.n-menu) { --n-color: transparent !important; --n-item-text-color: #cbd5e1; --n-item-text-color-hover: #ffffff; --n-item-text-color-active: #ffffff; --n-item-color-active: rgba(14,165,164,.22); --n-item-color-active-hover: rgba(14,165,164,.28); --n-group-text-color: #64748b; --n-arrow-color: #94a3b8; }
.sider-foot { padding: 10px 12px 6px; border-top: 1px solid rgba(148,163,184,.16); font-size: 12px; color: #94a3b8; }
.foot-line { display: flex; align-items: center; gap: 7px; margin-bottom: 6px; }
.dot { width: 7px; height: 7px; border-radius: 50%; background: #64748b; }
.dot.ok { background: #22c55e; box-shadow: 0 0 0 3px rgba(34,197,94,.16); }
.dot.bad { background: #ef4444; }
.dot.warn { background: #f59e0b; }
.foot-ver { margin-top: 8px; opacity: .55; font-size: 11px; }

.main { flex: 1; display: flex; flex-direction: column; min-width: 0; }
.topbar {
  height: 62px; flex: 0 0 62px; background: rgba(255,255,255,.86); backdrop-filter: blur(8px);
  border-bottom: 1px solid var(--pg-border); display: flex; align-items: center;
  justify-content: space-between; padding: 0 20px; gap: 12px;
}
.crumb { font-size: 11px; color: #94a3b8; }
.top-title { font-size: 15px; font-weight: 650; line-height: 1.2; }
.user-chip { display: flex; align-items: center; gap: 8px; padding: 4px 10px 4px 4px; border-radius: 999px; cursor: pointer; }
.user-chip:hover { background: #f1f5f9; }
.avatar {
  width: 28px; height: 28px; border-radius: 50%; background: linear-gradient(140deg, #0ea5a4, #0284c7);
  color: #fff; font-size: 12px; display: grid; place-items: center; font-weight: 600;
}
.content { flex: 1; overflow-y: auto; }
.drawer-brand { padding: 18px 20px; font-weight: 700; color: #0f766e; font-size: 17px; border-bottom: 1px solid var(--pg-border); }
.only-mobile { display: none; }
.fade-enter-active, .fade-leave-active { transition: opacity .16s ease; }
.fade-enter-from, .fade-leave-to { opacity: 0; }
@media (max-width: 900px) {
  .sider { display: none; }
  .only-mobile { display: inline-flex; }
  .only-desktop { display: none !important; }
  .topbar { padding: 0 12px; }
}
</style>
