<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h1 class="page-title">日志审计</h1>
        <div class="page-desc">所有管理操作留痕，可筛选、导出；同时查看服务运行日志</div>
      </div>
      <div class="row wrap">
        <n-button size="small" @click="exportCsv">
          <template #icon><n-icon :component="DownloadOutline" /></template>导出审计
        </n-button>
        <n-button size="small" :loading="loading" @click="refresh">
          <template #icon><n-icon :component="RefreshOutline" /></template>刷新
        </n-button>
      </div>
    </div>

    <n-tabs v-model:value="tab" type="line" animated>
      <n-tab-pane name="audit" tab="审计日志">
        <n-card size="small">
          <div class="filters">
            <n-input v-model:value="q" size="small" clearable placeholder="搜索详情 / 操作者 / IP" style="width: 240px" @keyup.enter="reload" />
            <n-select
              v-model:value="action" size="small" clearable filterable style="width: 220px"
              :options="actionOptions" placeholder="全部操作类型" @update:value="reload"
            />
            <n-button size="small" @click="reload">查询</n-button>
          </div>
          <n-spin :show="loading">
            <n-table v-if="logs.length" :single-line="false" size="small">
              <thead>
                <tr><th style="width: 160px">时间</th><th style="width: 150px">操作</th><th>详情</th><th style="width: 130px">操作者</th><th style="width: 130px">IP</th></tr>
              </thead>
              <tbody>
                <tr v-for="l in logs" :key="l.id">
                  <td class="muted">{{ fmtTime(l.created_at) }}</td>
                  <td><n-tag size="small" :type="tagType(l.action)" :bordered="false">{{ actionText(l.action) }}</n-tag></td>
                  <td class="detail">{{ l.detail || '—' }}</td>
                  <td class="muted">{{ actorText(l.actor) }}</td>
                  <td class="mono muted">{{ l.ip || '—' }}</td>
                </tr>
              </tbody>
            </n-table>
            <n-empty v-else description="暂无日志" style="padding: 40px 0" />
          </n-spin>
          <template #footer>
            <div class="row-between">
              <span class="muted">共 {{ total }} 条</span>
              <n-pagination v-model:page="page" :page-size="size" :item-count="total" size="small" @update:page="load" />
            </div>
          </template>
        </n-card>
      </n-tab-pane>

      <n-tab-pane name="runtime" tab="运行日志">
        <n-card size="small">
          <div class="filters">
            <n-select v-model:value="logName" size="small" style="width: 220px" :options="logOptions" @update:value="loadLog" />
            <n-input-number v-model:value="lines" size="small" :min="20" :max="2000" :step="100" style="width: 130px" />
            <n-button size="small" :loading="logLoading" @click="loadLog">刷新</n-button>
            <span class="muted mono" style="font-size: 12px">{{ logPath }}</span>
          </div>
          <pre class="logs">{{ logContent || '（日志为空）' }}</pre>
        </n-card>
      </n-tab-pane>

      <n-tab-pane name="security" tab="登录尝试">
        <n-card size="small">
          <template #header-extra>
            <div class="row">
              <n-tag type="warning" :bordered="false" size="small">24 小时失败 {{ fails24 }} 次</n-tag>
              <n-button size="tiny" quaternary type="error" @click="clearAttempts">清空并解锁</n-button>
            </div>
          </template>
          <n-table v-if="attempts.length" :single-line="false" size="small">
            <thead><tr><th style="width: 160px">时间</th><th style="width: 160px">IP</th><th style="width: 120px">类型</th><th>结果</th></tr></thead>
            <tbody>
              <tr v-for="a in attempts" :key="a.id">
                <td class="muted">{{ fmtTime(a.created_at) }}</td>
                <td class="mono">{{ a.ip }}</td>
                <td>{{ a.kind === 'login' ? '后台登录' : a.kind === 'bind' ? '绑定码' : a.kind }}</td>
                <td>
                  <n-tag size="small" :type="a.ok ? 'success' : 'error'" :bordered="false">{{ a.ok ? '成功' : '失败' }}</n-tag>
                </td>
              </tr>
            </tbody>
          </n-table>
          <n-empty v-else description="暂无登录记录" style="padding: 40px 0" />
        </n-card>
      </n-tab-pane>
    </n-tabs>
  </div>
</template>

<script setup>
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { useMessage, useDialog } from 'naive-ui';
import { RefreshOutline, DownloadOutline } from '@vicons/ionicons5';
import { api, fmtTime } from '../api';

const message = useMessage();
const dialog = useDialog();
const tab = ref('audit');
const loading = ref(false);
const logs = ref([]);
const total = ref(0);
const page = ref(1);
const size = ref(30);
const q = ref('');
const action = ref(null);
const actions = ref([]);

const logName = ref('app');
const lines = ref(300);
const logContent = ref('');
const logPath = ref('');
const logFiles = ref([]);
const logLoading = ref(false);

const attempts = ref([]);
const fails24 = ref(0);

const ACTION_MAP = {
  setup_admin: '完成初始化', login_ok: '管理员登录', login_fail: '登录失败', logout: '退出登录',
  change_password: '修改密码', change_password_fail: '改密失败',
  print_submit: '提交打印', print_done: '打印完成', print_failed: '打印失败',
  task_approve: '批准任务', task_reject: '拒绝任务', task_cancel: '取消任务', task_retry: '重试任务',
  printer_add: '添加打印机', printer_delete: '删除打印机', printer_test: '打印测试页',
  printer_default: '设默认打印机', printer_pause: '暂停打印机', printer_resume: '恢复打印机',
  printer_reject: '停止接收', printer_accept: '恢复接收',
  user_approve: '授权用户', user_reject: '拒绝用户', user_block: '拉黑用户', user_unblock: '解除拉黑',
  user_promote: '设为管理员', user_demote: '取消管理员', user_delete: '删除用户',
  upload: '上传文件', file_delete: '删除文件', settings_update: '修改设置',
  mp_register: '小程序注册', mp_upload: '小程序上传', mp_bind_ok: '绑定管理员', mp_bind_fail: '绑定码错误',
  mp_task_cancel: '小程序取消任务',
  qr_login_ok: '扫码登录', qr_confirm: '扫码确认',
  scan: '扫描文档', service_restart: '重启服务', cleanup: '清理数据', auto_cleanup: '自动清理',
  backup: '备份数据库', apikey_create: '创建密钥', apikey_revoke: '吊销密钥',
  bind_token_regenerate: '重生成绑定码', audit_export: '导出审计', attempts_clear: '清空登录记录',
  cups_job_cancel: '取消队列任务', cups_job_hold: '挂起队列任务', cups_job_release: '恢复队列任务'
};
const actionText = (a) => ACTION_MAP[a] || a;
const actionOptions = ref([]);
const actorText = (a) => (a === 'admin' ? '管理员' : a === 'system' ? '系统' : a === 'anonymous' ? '未登录' : a || '—');
const tagType = (a) => (a.includes('fail') ? 'error' : a.includes('delete') ? 'warning' : a.includes('ok') || a.includes('done') ? 'success' : 'default');

const logOptions = ref([{ label: 'PrintGate 服务日志', value: 'app' }]);

async function load() {
  loading.value = true;
  try {
    const d = await api.get(`/audit?page=${page.value}&size=${size.value}&q=${encodeURIComponent(q.value)}&action=${action.value || 'all'}`);
    logs.value = d.logs || [];
    total.value = d.total || 0;
    actions.value = d.actions || [];
    actionOptions.value = actions.value.map((x) => ({ label: `${actionText(x.action)} (${x.c})`, value: x.action }));
  } catch (e) {
    message.error(e.message);
  } finally {
    loading.value = false;
  }
}

function reload() { page.value = 1; load(); }

async function loadLogs() {
  try {
    const d = await api.get('/system/logs');
    logFiles.value = d.logs || [];
    logOptions.value = logFiles.value.map((l) => ({ label: `${l.label}${l.exists ? '' : '（空）'}`, value: l.key }));
    loadLog();
  } catch (e) { message.error(e.message); }
}

async function loadLog() {
  logLoading.value = true;
  try {
    const d = await api.get(`/system/logs/${logName.value}?lines=${lines.value}`);
    logContent.value = d.content || '';
    logPath.value = d.path || '';
  } catch (e) {
    logContent.value = e.message;
  } finally {
    logLoading.value = false;
  }
}

async function loadAttempts() {
  try {
    const d = await api.get('/security/attempts');
    attempts.value = d.attempts || [];
    fails24.value = d.fails24 || 0;
  } catch (_) {}
}

function clearAttempts() {
  dialog.warning({
    title: '清空登录尝试记录',
    content: '将解除所有 IP 的临时锁定，确定继续？',
    positiveText: '清空',
    negativeText: '取消',
    onPositiveClick: async () => {
      try {
        const d = await api.delete('/security/attempts');
        message.success(d.msg);
        loadAttempts();
      } catch (e) { message.error(e.message); }
    }
  });
}

async function exportCsv() {
  try {
    const blob = await api.get('/audit/export', { responseType: 'blob' });
    const url = URL.createObjectURL(blob instanceof Blob ? blob : new Blob([blob]));
    const a = document.createElement('a');
    a.href = url;
    a.download = `printgate-audit-${Date.now()}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 3000);
    message.success('已导出');
  } catch (e) { message.error(e.message); }
}

function refresh() {
  if (tab.value === 'audit') load();
  else if (tab.value === 'runtime') loadLog();
  else loadAttempts();
}

const onRefresh = () => refresh();
onMounted(() => {
  load();
  loadLogs();
  loadAttempts();
  window.addEventListener('pg:refresh', onRefresh);
});
onBeforeUnmount(() => window.removeEventListener('pg:refresh', onRefresh));
</script>

<style scoped>
.filters { display: flex; gap: 10px; align-items: center; margin-bottom: 14px; flex-wrap: wrap; }
.detail { max-width: 520px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12.5px; }
.logs {
  background: #0f172a; color: #cbd5e1; padding: 14px; border-radius: 10px; font-size: 12px;
  line-height: 1.65; max-height: 560px; overflow: auto; white-space: pre-wrap; word-break: break-all; margin: 0;
}
</style>
