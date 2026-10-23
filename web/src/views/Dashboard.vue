<template>
  <div class="page">
    <!-- 新用户审批：右上角条状提醒，5 秒自动消失，点一下直达审批列表 -->
    <transition name="notice-slide">
      <div v-if="notice.show" class="notice-bar" @click="openPendingUsers">
        <span class="notice-icon">👤</span>
        <div class="notice-body">
          <div class="notice-title">有新的普通用户注册申请</div>
          <div class="notice-desc">{{ notice.count }} 位待审批 · 点击去放行</div>
        </div>
        <span class="notice-close" @click.stop="closeNotice">✕</span>
        <span class="notice-progress"></span>
      </div>
    </transition>
    <div class="page-head">
      <div>
        <h1 class="page-title">运行概览</h1>
        <div class="page-desc">打印网关的实时状态、今日任务与最近动态</div>
      </div>
      <div class="row wrap">
        <n-button size="small" @click="$router.push('/print')">
          <template #icon><n-icon :component="AddOutline" /></template>
          发起打印
        </n-button>
        <n-button size="small" type="primary" @click="$router.push('/printers')">
          <template #icon><n-icon :component="ScanOutline" /></template>
          扫描打印机
        </n-button>
      </div>
    </div>

    <n-spin :show="loading">
      <div class="stats">
        <div
          v-for="s in cards" :key="s.key" class="stat clickable"
          :style="{ '--accent': s.color }" role="link" tabindex="0"
          :title="`打开「${s.label}」`"
          @click="goCard(s)" @keyup.enter="goCard(s)"
        >
          <div class="stat-icon"><n-icon :component="s.icon" /></div>
          <div class="stat-body">
            <div class="stat-num">{{ s.value }}</div>
            <div class="stat-label">{{ s.label }}</div>
          </div>
          <div v-if="s.hint" class="stat-hint">{{ s.hint }}</div>
          <span class="stat-go">›</span>
        </div>
      </div>

      <div class="cols">
        <n-card size="small" :bordered="true">
          <template #header>
            <div class="card-hd">
              <span class="card-title">最近 7 天打印量</span>
              <span class="card-meta">
                今日 {{ counts.tasksToday }} · 累计 {{ counts.pagesToday }} 页
                <template v-if="totalTrend"> · 近 7 天 {{ totalTrend }} · 日均 {{ dayAvg }}</template>
              </span>
            </div>
          </template>
          <!-- 横向条形图：日期固定左列、数值固定右列，条长按占比，天然对齐 -->
          <div class="hbar-list">
            <div
              v-for="(d, i) in trend" :key="d.date" class="hbar-row" :class="{ today: d.today }"
              :title="`${d.date}：${d.count} 个任务`"
            >
              <span class="hbar-date">{{ d.date }}</span>
              <span class="hbar-track">
                <span
                  class="hbar-fill" :class="{ today: d.today, zero: !d.count }"
                  :style="{ width: barWidth(d.count), transitionDelay: `${i * 60}ms` }"
                ></span>
              </span>
              <span class="hbar-val" :class="{ zero: !d.count }">{{ d.count }}</span>
            </div>
          </div>
          <div v-if="!totalTrend" class="chart-empty">最近 7 天还没有打印任务</div>
        </n-card>

        <n-card size="small">
          <template #header>
            <div class="card-hd">
              <span class="card-title">服务状态</span>
              <n-button text size="small" class="card-link" @click="$router.push('/system')">系统详情 →</n-button>
            </div>
          </template>
          <div class="svc-list">
            <div v-for="s in services" :key="s.key" class="svc">
              <span class="dot" :class="s.running ? 'ok' : s.optional ? 'idle' : 'bad'"></span>
              <div class="grow">
                <div class="svc-name">{{ s.name }}</div>
                <div class="muted" style="font-size: 12px">{{ s.detail }}</div>
              </div>
              <n-tag size="small" :type="s.running ? 'success' : s.optional ? 'default' : 'error'" :bordered="false">
                {{ s.running ? '正常' : s.optional ? '按需' : '异常' }}
              </n-tag>
            </div>
          </div>
          <div class="card-foot">
            <span class="muted">内存 {{ pct(system.mem?.used, system.mem?.total) }}% · 磁盘 {{ pct(system.disk?.used, system.disk?.total) }}%</span>
          </div>
        </n-card>
      </div>

      <div class="cols" style="margin-top: 16px">
        <n-card size="small">
          <template #header>
            <div class="card-hd">
              <span class="card-title">最近打印任务</span>
              <n-button text size="small" class="card-link" @click="$router.push('/tasks')">全部任务 →</n-button>
            </div>
          </template>
          <n-table v-if="recent.length" :single-line="false" size="small">
            <thead>
              <tr><th>文件</th><th style="width: 110px">打印机</th><th style="width: 88px">状态</th><th style="width: 130px">时间</th></tr>
            </thead>
            <tbody>
              <tr v-for="t in recent" :key="t.id">
                <td class="ellipsis">{{ t.filename || '（文件已清理）' }}</td>
                <td class="mono ellipsis">{{ t.printer }}</td>
                <td><n-tag size="small" :type="statusMeta(t.status).type" :bordered="false">{{ statusMeta(t.status).text }}</n-tag></td>
                <td class="muted">{{ fmtTime(t.created_at) }}</td>
              </tr>
            </tbody>
          </n-table>
          <n-empty v-else description="还没有打印记录" style="padding: 24px 0" />
        </n-card>

        <n-card size="small">
          <template #header>
            <div class="card-hd">
              <span class="card-title">最近操作</span>
              <n-button text size="small" class="card-link" @click="$router.push('/logs')">审计日志 →</n-button>
            </div>
          </template>
          <div v-if="audit.length" class="timeline">
            <div v-for="a in audit" :key="a.id" class="tl-item">
              <span class="tl-dot"></span>
              <div class="grow">
                <div class="tl-action">{{ actionText(a.action) }}</div>
                <div class="muted tl-detail">{{ a.detail || '—' }}</div>
              </div>
              <div class="muted tl-time">{{ fmtTime(a.created_at) }}</div>
            </div>
          </div>
          <n-empty v-else description="暂无操作记录" style="padding: 24px 0" />
        </n-card>
      </div>

      <n-card v-if="pendingUsers.length" size="small" style="margin-top: 16px">
        <template #header>
          <div class="card-hd">
            <span class="card-title">
              待审批用户
              <n-tag size="tiny" type="warning" :bordered="false" style="margin-left: 6px">
                {{ counts.usersPending || pendingUsers.length }}
              </n-tag>
            </span>
            <n-button text size="small" class="card-link" @click="$router.push('/users?status=pending')">去审批 →</n-button>
          </div>
        </template>
        <div class="applicants">
          <div v-for="u in pendingUsers" :key="u.id" class="applicant">
            <div class="ava">
              <img v-if="u.avatar" :src="u.avatar" alt="" />
              <span v-else>{{ (u.nickname || '微')[0] }}</span>
            </div>
            <div class="grow" style="min-width: 0">
              <div class="ap-name">
                {{ u.nickname || '微信用户' }}
                <span v-if="u.real_name" class="muted">（{{ u.real_name }}）</span>
              </div>
              <div class="muted ap-meta">
                <span v-if="u.wechat_id">微信号 {{ u.wechat_id }}</span>
                <span v-if="u.phone"> · {{ u.phone }}</span>
                <span v-if="!u.wechat_id && !u.phone">未留联系方式</span>
                <span v-if="u.apply_note"> · {{ u.apply_note }}</span>
              </div>
            </div>
            <div class="muted ap-time" style="font-size: 11.5px">{{ fmtTime(u.created_at) }}</div>
            <div class="row" style="gap: 6px">
              <n-button size="tiny" type="primary" secondary @click="approve(u)">通过</n-button>
              <n-button size="tiny" quaternary type="error" @click="reject(u)">拒绝</n-button>
            </div>
          </div>
        </div>
      </n-card>

      <n-card v-if="printers.list?.length" size="small" style="margin-top: 16px">
        <template #header>
          <div class="card-hd">
            <span class="card-title">打印机队列</span>
            <n-button text size="small" class="card-link" @click="$router.push('/printers')">管理打印机 →</n-button>
          </div>
        </template>
        <div class="printer-row">
          <div v-for="p in printers.list" :key="p.name" class="printer-chip">
            <span class="dot" :class="p.state === 'stopped' ? 'bad' : 'ok'"></span>
            <div class="grow">
              <div class="pc-name">
                {{ p.name }}
                <n-tag v-if="p.isDefault" size="tiny" type="primary" :bordered="false">默认</n-tag>
              </div>
              <div class="muted pc-uri mono">{{ p.uri || '—' }}</div>
            </div>
            <n-tag size="tiny" :type="p.state === 'printing' ? 'info' : p.state === 'stopped' ? 'error' : 'success'" :bordered="false">
              {{ stateText(p.state) }}
            </n-tag>
          </div>
        </div>
      </n-card>
    </n-spin>
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue';
import { useMessage } from 'naive-ui';
import { useRouter } from 'vue-router';
import {
  PrintOutline, CheckmarkCircleOutline, TimeOutline, PeopleOutline,
  ScanOutline, AddOutline
} from '@vicons/ionicons5';
import { api, fmtTime, STATUS_META } from '../api';

const message = useMessage();
const router = useRouter();
const loading = ref(true);
const counts = ref({});
const trend = ref([]);
const recent = ref([]);
const audit = ref([]);
const services = ref([]);
const printers = ref({ list: [] });
const system = ref({});
const pendingUsers = ref([]);
// 右上角「新用户申请」条状弹窗：5 秒自动关；只在数量变多时再弹，避免每 30 秒刷一次
const notice = reactive({ show: false, count: 0 });
let noticeTimer = null;
const knownPending = ref(null);
function showNotice(n) {
  notice.count = n;
  notice.show = true;
  if (noticeTimer) clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => { notice.show = false; noticeTimer = null; }, 5000);
}
function closeNotice() {
  notice.show = false;
  if (noticeTimer) { clearTimeout(noticeTimer); noticeTimer = null; }
}
function openPendingUsers() {
  closeNotice();
  router.push('/users?status=pending');
}
function syncPendingNotice(usersPending) {
  const n = Number(usersPending) || 0;
  if (knownPending.value === null) {
    // 首次进入页面：有积压就提醒一次（同一次会话只提醒一次）
    if (n > 0 && sessionStorage.getItem('pg_pending_notice') !== '1') {
      sessionStorage.setItem('pg_pending_notice', '1');
      showNotice(n);
    }
  } else if (n > knownPending.value) {
    showNotice(n);
  }
  knownPending.value = n;
}

// 每张卡片都能点进对应功能页
const cards = computed(() => [
  { key: 'today', label: '今日打印任务', value: counts.value.tasksToday ?? '—', icon: PrintOutline, color: '#0ea5a4', to: '/jobs' },
  { key: 'done', label: '累计完成', value: counts.value.tasksDone ?? '—', icon: CheckmarkCircleOutline, color: '#16a34a', to: '/jobs' },
  {
    key: 'pending',
    label: '待处理',
    value: (counts.value.tasksPending || 0) + (counts.value.usersPending || 0),
    icon: TimeOutline, color: '#f59e0b',
    hint: `任务 ${counts.value.tasksPending || 0} · 用户 ${counts.value.usersPending || 0}`,
    // 有任务待批就去任务页，否则去用户审批
    to: (counts.value.tasksPending || 0) > 0 ? '/tasks' : '/users?status=pending'
  },
  { key: 'printers', label: '在线打印机', value: `${printers.value.online || 0}/${printers.value.total || 0}`, icon: ScanOutline, color: '#3b82f6', to: '/printers' },
  { key: 'users', label: '小程序用户', value: counts.value.users ?? '—', icon: PeopleOutline, color: '#8b5cf6', to: '/users' }
]);

function goCard(card) {
  if (!card || !card.to) return;
  router.push(card.to);
}

const maxTrend = computed(() => Math.max(1, ...trend.value.map((t) => t.count)));
// 柱高按「绘图区高度」百分比算；入场时先 0 再触发，才有生长动画
const totalTrend = computed(() => trend.value.reduce((a, b) => a + (b.count || 0), 0));
const chartReady = ref(false);
const dayAvg = computed(() => (trend.value.length ? (totalTrend.value / trend.value.length).toFixed(1) : '0'));
const barWidth = (n) => {
  if (!chartReady.value) return '0%';
  if (!n) return '2%'; // 0 值留一小截，行不至于空掉
  return `${Math.max(6, Math.round((n / maxTrend.value) * 100))}%`;
};

const pct = (used, total) => (total ? Math.round((used / total) * 100) : 0);

const statusMeta = (s) => STATUS_META[s] || { text: s, type: 'default' };
const stateText = (s) => ({ idle: '空闲', printing: '打印中', stopped: '已停用' })[s] || s;

const ACTION_MAP = {
  setup_admin: '完成初始化', login_ok: '管理员登录', login_fail: '登录失败', logout: '退出登录',
  print_submit: '提交打印', print_done: '打印完成', print_failed: '打印失败',
  task_approve: '批准任务', task_reject: '拒绝任务', task_cancel: '取消任务', task_retry: '重试任务',
  printer_add: '添加打印机', printer_delete: '删除打印机', printer_test: '打印测试页',
  printer_default: '设置默认打印机', printer_pause: '暂停打印机', printer_resume: '恢复打印机',
  user_approve: '授权用户', user_reject: '拒绝用户', user_block: '拉黑用户', user_promote: '设为管理员',
  user_delete: '删除用户', upload: '上传文件', settings_update: '修改设置',
  mp_register: '小程序新用户', mp_bind_ok: '微信绑定管理员', mp_bind_fail: '绑定码错误',
  user_unblock: '解除拉黑', user_demote: '取消管理员', user_edit: '编辑用户资料',
  user_batch: '批量处理用户', mp_profile: '小程序用户更新资料',
  mp_admin_user_approve: '小程序台授权用户', mp_admin_user_reject: '小程序台拒绝用户',
  mp_admin_user_block: '小程序台拉黑用户', mp_admin_user_unblock: '小程序台解除拉黑',
  mp_admin_user_delete: '小程序台删除用户', mp_admin_settings: '小程序台改设置',
  qr_login_ok: '扫码登录', qr_confirm: '扫码确认', scan: '扫描文档',
  service_restart: '重启服务', cleanup: '清理数据', backup: '备份数据库',
  apikey_create: '创建 API Key', apikey_revoke: '吊销 API Key', bind_token_regenerate: '重新生成绑定码'
};
const actionText = (a) => ACTION_MAP[a] || a;

async function load(silent = false) {
  if (!silent) loading.value = true;
  try {
    const d = await api.get('/dashboard');
    counts.value = d.counts || {};
    trend.value = d.trend || [];
    recent.value = d.recent || [];
    audit.value = d.audit || [];
    services.value = d.services || [];
    printers.value = d.printers || { list: [] };
    system.value = d.system || {};
    pendingUsers.value = d.pendingUsers || [];
    syncPendingNotice(counts.value.usersPending);
  } catch (e) {
    if (!silent) message.error(e.message);
  } finally {
    loading.value = false;
  }
}

// 概览页直接放行/拒绝，省得每次都进用户页
async function decide(u, action) {
  try {
    const d = await api.post(`/users/${u.id}/${action}`);
    message.success(d.msg);
    load(true);
  } catch (e) { message.error(e.message); }
}
const approve = (u) => decide(u, 'approve');
const reject = (u) => decide(u, 'reject');

const onRefresh = () => load(true);
let timer = null;
onMounted(async () => {
  // 先等一帧再放开 barPct，否则首屏渲染就是最终高度，transition 不会触发
  await load();
  requestAnimationFrame(() => requestAnimationFrame(() => { chartReady.value = true; }));
  timer = setInterval(() => load(true), 30000);
  window.addEventListener('pg:refresh', onRefresh);
});
onBeforeUnmount(() => {
  clearInterval(timer);
  window.removeEventListener('pg:refresh', onRefresh);
});
</script>

<style scoped>
.stats { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 14px; }
.stat {
  position: relative; background: #fff; border: 1px solid var(--pg-border); border-radius: 14px;
  padding: 16px 16px 14px; display: flex; gap: 12px; align-items: center; overflow: hidden;
}
.stat::after {
  content: ''; position: absolute; inset: 0 auto 0 0; width: 3px; background: var(--accent); opacity: .85;
}
.stat-icon {
  width: 40px; height: 40px; border-radius: 12px; display: grid; place-items: center;
  background: color-mix(in srgb, var(--accent) 12%, white); color: var(--accent); font-size: 20px; flex: 0 0 40px;
}
.stat-num { font-size: 24px; font-weight: 700; line-height: 1.15; letter-spacing: -.5px; }
.stat-label { font-size: 12.5px; color: var(--pg-muted); margin-top: 2px; }
.stat-hint { position: absolute; right: 12px; bottom: 8px; font-size: 11px; color: #9ca3af; }
.cols { display: grid; grid-template-columns: 1.35fr 1fr; gap: 16px; align-items: stretch; }
/* 同一行的卡片强制等高：卡片自身纵向 flex，内容区撑满，图表/列表跟着长高 */
.cols > :deep(.n-card) { display: flex; flex-direction: column; height: 100%; }
.cols > :deep(.n-card > .n-card-content) { flex: 1; display: flex; flex-direction: column; min-height: 0; }
/* ---------- 卡片统一规范：同样的卡头、内边距、圆角、右侧链接 ---------- */
.cols > :deep(.n-card), .page > :deep(.n-card) { border-radius: 14px; }
.cols > :deep(.n-card > .n-card-header), .page > :deep(.n-card > .n-card-header) {
  padding: 12px 16px; border-bottom: 1px solid #f1f5f9;
}
.cols > :deep(.n-card > .n-card-content), .page > :deep(.n-card > .n-card-content) {
  padding: 14px 16px 16px;
}
.n-card-header .card-hd { padding: 0; }
.card-hd { display: flex; align-items: center; justify-content: space-between; gap: 12px; width: 100%; }
.card-title { font-size: 15px; font-weight: 600; color: #0f172a; letter-spacing: .2px; }
.card-meta { font-size: 12.5px; color: var(--pg-muted); font-weight: 400; }
.card-link { color: var(--accent, #0ea5a4) !important; font-size: 12.5px !important; }
.card-link:hover { opacity: .8; }
.card-foot { margin-top: auto; padding-top: 12px; border-top: 1px dashed #f1f5f9; font-size: 12.5px; }

/* ---------- 横向条形图：行高按卡片剩余空间均分，字体放大，尽量占满 ---------- */
.hbar-list {
  flex: 1; height: 100%; min-height: 0; display: grid; grid-auto-rows: 1fr; gap: 2px;
}
.hbar-row { display: grid; grid-template-columns: 60px 1fr 42px; align-items: center; gap: 14px; }
.hbar-date { font-size: 14.5px; color: #64748b; text-align: right; font-variant-numeric: tabular-nums; }
.hbar-track { height: 24px; border-radius: 10px; background: #f1f5f9; overflow: hidden; }
.hbar-fill {
  display: block; height: 100%; border-radius: 10px; min-width: 6px;
  background: linear-gradient(90deg, #5eead4, #0ea5a4);
  transition: width .6s cubic-bezier(.22, .61, .36, 1);
}
.hbar-fill.today { background: linear-gradient(90deg, #38bdf8, #0284c7); }
.hbar-fill.zero { background: #e2e8f0; }
.hbar-row:hover .hbar-fill { filter: saturate(1.25); }
.hbar-val { font-size: 16px; font-weight: 600; color: #0f766e; text-align: right; font-variant-numeric: tabular-nums; }
.hbar-val.zero { color: #cbd5e1; font-weight: 400; }
.hbar-row.today .hbar-date { color: #0284c7; font-weight: 600; }
.hbar-row.today .hbar-val { color: #0284c7; }
.chart-empty { padding: 14px 0; text-align: center; font-size: 13px; color: var(--pg-muted); }
.svc-list { display: grid; gap: 10px; flex: 1; align-content: center; }
.svc { display: flex; align-items: center; gap: 10px; }
.svc-name { font-size: 14px; font-weight: 550; }
.dot { width: 8px; height: 8px; border-radius: 50%; flex: 0 0 8px; }
.dot.ok { background: #22c55e; box-shadow: 0 0 0 3px rgba(34,197,94,.15); }
.dot.bad { background: #ef4444; box-shadow: 0 0 0 3px rgba(239,68,68,.12); }
.dot.idle { background: #94a3b8; box-shadow: 0 0 0 3px rgba(148,163,184,.15); }
.timeline { display: grid; gap: 12px; overflow-y: auto; min-height: 0; }
.cols > :deep(.n-card) .n-card-content { min-height: 0; }
.tl-item { display: flex; gap: 10px; align-items: flex-start; }
.tl-dot { width: 7px; height: 7px; border-radius: 50%; background: #cbd5e1; margin-top: 6px; flex: 0 0 7px; }
.tl-action { font-size: 13px; font-weight: 550; }
.tl-detail { font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 320px; }
.tl-time { font-size: 11.5px; white-space: nowrap; }
.printer-row { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 12px; }
.printer-chip { display: flex; align-items: center; gap: 10px; padding: 10px 12px; border: 1px solid var(--pg-border); border-radius: 12px; background: #fcfdfe; }
.pc-name { font-size: 13px; font-weight: 600; display: flex; align-items: center; gap: 6px; }
.pc-uri { font-size: 11.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 200px; }
.ellipsis { max-width: 260px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.applicants { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 10px; }
.applicant { display: flex; align-items: center; gap: 10px; padding: 10px 12px; border: 1px solid var(--pg-border); border-radius: 12px; background: #fcfdfe; }
.ava { width: 34px; height: 34px; border-radius: 50%; flex: 0 0 34px; overflow: hidden; background: linear-gradient(140deg, #0ea5a4, #0284c7); color: #fff; display: grid; place-items: center; font-size: 13px; }
.ava img { width: 100%; height: 100%; object-fit: cover; display: block; }
.ap-name { font-size: 13px; font-weight: 600; }
.ap-meta { font-size: 11.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
@media (max-width: 700px) {
  .ap-time { display: none; }
  .applicant { flex-wrap: wrap; }
}
@media (max-width: 1200px) {
  .stats { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  .cols { grid-template-columns: 1fr; }
}
@media (max-width: 700px) {
  .stats { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .stat-hint { display: none; }
}
</style>
