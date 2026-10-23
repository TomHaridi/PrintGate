<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h1 class="page-title">系统状态</h1>
        <div class="page-desc">容器资源、服务进程与数据占用情况</div>
      </div>
      <div class="row wrap">
        <n-button size="small" :loading="loading" @click="load">
          <template #icon><n-icon :component="RefreshOutline" /></template>刷新
        </n-button>
        <n-button size="small" @click="backup">
          <template #icon><n-icon :component="DownloadOutline" /></template>备份数据库
        </n-button>
      </div>
    </div>

    <n-spin :show="loading">
      <div class="grid4">
        <div class="box">
          <div class="bx-label">版本 / 运行时长</div>
          <div class="bx-num">v{{ info.version }}</div>
          <div class="muted">已运行 {{ fmtDuration(info.uptime) }}</div>
        </div>
        <div class="box">
          <div class="bx-label">内存占用</div>
          <div class="bx-num">{{ pct(info.mem?.used, info.mem?.total) }}%</div>
          <n-progress type="line" :percentage="pct(info.mem?.used, info.mem?.total)" :show-indicator="false" :height="5" style="margin-top: 8px" />
          <div class="muted">{{ fmtBytes(info.mem?.used) }} / {{ fmtBytes(info.mem?.total) }}</div>
        </div>
        <div class="box">
          <div class="bx-label">数据盘占用</div>
          <div class="bx-num">{{ pct(info.disk?.used, info.disk?.total) }}%</div>
          <n-progress type="line" :percentage="pct(info.disk?.used, info.disk?.total)" :show-line="false" :height="5" style="margin-top: 8px" />
          <div class="muted">{{ fmtBytes(info.disk?.used) }} / {{ fmtBytes(info.disk?.total) }}</div>
        </div>
        <div class="box">
          <div class="bx-label">CPU 负载（{{ info.cpu?.cores }} 核）</div>
          <div class="bx-num">{{ (info.cpu?.load || []).join(' / ') }}</div>
          <div class="muted" style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap">{{ info.cpu?.model }}</div>
        </div>
      </div>

      <n-card size="small" title="服务进程" style="margin-top: 16px">
        <n-table :single-line="false" size="small">
          <thead><tr><th style="width: 200px">服务</th><th style="width: 90px">状态</th><th>详情</th><th style="width: 110px">操作</th></tr></thead>
          <tbody>
            <tr v-for="s in services" :key="s.key">
              <td>{{ s.name }}</td>
              <td>
                <n-tag size="small" :type="s.running ? 'success' : s.optional ? 'default' : 'error'" :bordered="false">
                  {{ s.running ? '运行中' : s.enabled === false ? '未启用' : s.optional ? '按需' : '未运行' }}
                </n-tag>
              </td>
              <td class="muted">{{ s.detail }}</td>
              <td>
                <n-button v-if="s.canRestart" size="tiny" quaternary @click="restart(s)">重启</n-button>
                <span v-else class="muted">—</span>
              </td>
            </tr>
          </tbody>
        </n-table>
      </n-card>

      <div class="cols" style="margin-top: 16px">
        <n-card size="small" title="数据占用">
          <div class="kv"><span>上传文件</span><b>{{ storage.files }} 个 · {{ fmtBytes(storage.uploads) }}</b></div>
          <div class="kv"><span>扫描文件</span><b>{{ fmtBytes(storage.scans) }}</b></div>
          <div class="kv"><span>数据库</span><b>{{ fmtBytes(storage.db) }}</b></div>
          <div class="kv"><span>打印任务</span><b>{{ storage.tasks }} 条</b></div>
          <div class="kv"><span>保留策略</span><b>{{ storage.retentionDays }} 天</b></div>
          <div class="row" style="margin-top: 12px">
            <n-button size="small" @click="cleanup">立即清理过期文件</n-button>
            <n-button size="small" quaternary @click="$router.push('/settings?tab=storage')">调整策略</n-button>
          </div>
        </n-card>

        <n-card size="small" title="运行环境">
          <div class="kv"><span>主机名</span><b class="mono">{{ info.hostname }}</b></div>
          <div class="kv"><span>系统</span><b class="mono">{{ info.platform }}</b></div>
          <div class="kv"><span>架构</span><b class="mono">{{ info.arch }}</b></div>
          <div class="kv"><span>Node.js</span><b class="mono">{{ info.node }}</b></div>
          <div class="kv"><span>数据目录</span><b class="mono">{{ info.dataDir }}</b></div>
          <div class="kv"><span>时区</span><b class="mono">{{ info.timezone }}</b></div>
          <div class="row" style="margin-top: 12px">
            <n-button size="small" @click="$router.push('/cups')">CUPS 后台</n-button>
            <n-button size="small" quaternary @click="$router.push('/logs')">查看运行日志</n-button>
          </div>
        </n-card>
      </div>
    </n-spin>
  </div>
</template>

<script setup>
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { useMessage, useDialog } from 'naive-ui';
import { RefreshOutline, DownloadOutline } from '@vicons/ionicons5';
import { api, fmtBytes, fmtDuration } from '../api';

const message = useMessage();
const dialog = useDialog();
const loading = ref(false);
const info = ref({});
const services = ref([]);
const storage = ref({});

const pct = (u, t) => (t ? Math.min(100, Math.round((u / t) * 100)) : 0);

async function load() {
  loading.value = true;
  try {
    const [i, s] = await Promise.all([api.get('/system/info'), api.get('/settings/storage')]);
    info.value = i.info || {};
    services.value = i.services || [];
    storage.value = s.storage || {};
  } catch (e) {
    message.error(e.message);
  } finally {
    loading.value = false;
  }
}

function restart(s) {
  dialog.warning({
    title: `重启 ${s.name}`,
    content: '重启期间打印会短暂中断，确定继续？',
    positiveText: '重启',
    negativeText: '取消',
    onPositiveClick: async () => {
      try {
        const d = await api.post(`/system/services/${s.key}/restart`);
        message.success(d.msg);
        setTimeout(load, 2500);
      } catch (e) { message.error(e.message); }
    }
  });
}

function cleanup() {
  dialog.info({
    title: '清理过期文件',
    content: `将删除超过保留期（${storage.value.retentionDays} 天）的上传文件与扫描记录。`,
    positiveText: '开始清理',
    negativeText: '取消',
    onPositiveClick: async () => {
      try {
        const d = await api.post('/settings/cleanup');
        message.success(d.msg);
        load();
      } catch (e) { message.error(e.message); }
    }
  });
}

async function backup() {
  try {
    const blob = await api.get('/settings/backup', { responseType: 'blob' });
    const url = URL.createObjectURL(blob instanceof Blob ? blob : new Blob([blob]));
    const a = document.createElement('a');
    a.href = url;
    a.download = `printgate-backup-${Date.now()}.db`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 3000);
    message.success('备份已下载');
  } catch (e) { message.error(e.message); }
}

const onRefresh = () => load();
onMounted(() => {
  load();
  window.addEventListener('pg:refresh', onRefresh);
});
onBeforeUnmount(() => window.removeEventListener('pg:refresh', onRefresh));
</script>

<style scoped>
.grid4 { display: grid; grid-template-columns: repeat(4, 1fr); gap: 14px; }
.box { background: #fff; border: 1px solid var(--pg-border); border-radius: 14px; padding: 14px 16px; }
.bx-label { font-size: 12px; color: var(--pg-muted); }
.bx-num { font-size: 22px; font-weight: 700; margin: 4px 0 2px; letter-spacing: -.4px; }
.cols { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
.kv { display: flex; justify-content: space-between; gap: 12px; padding: 8px 0; border-bottom: 1px dashed #eef2f6; font-size: 13px; }
.kv:last-of-type { border-bottom: none; }
@media (max-width: 1000px) { .grid4 { grid-template-columns: repeat(2, 1fr); } .cols { grid-template-columns: 1fr; } }
@media (max-width: 560px) { .grid4 { grid-template-columns: 1fr; } }
</style>
