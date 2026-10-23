<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h1 class="page-title">CUPS 后台</h1>
        <div class="page-desc">容器内 CUPS 服务状态、队列与作业运维、配置与日志</div>
      </div>
      <div class="row wrap">
        <n-tag size="small" :type="info.running ? 'success' : 'error'" :bordered="false" style="margin-right: 4px">
          {{ info.running ? 'CUPS 运行中' : 'CUPS 未运行' }}
        </n-tag>
        <n-button size="small" :loading="loading" @click="load">
          <template #icon><n-icon :component="RefreshOutline" /></template>刷新
        </n-button>
        <n-button size="small" type="warning" secondary :loading="restarting" @click="restartCups">
          <template #icon><n-icon :component="PowerOutline" /></template>重启 CUPS
        </n-button>
      </div>
    </div>

    <n-spin :show="loading">
      <div class="grid4">
        <div class="box">
          <div class="bx-label">CUPS 版本</div>
          <div class="bx-num">{{ info.version || '—' }}</div>
          <div class="muted">{{ info.installed ? '命令行工具已就绪' : '未检测到 CUPS 客户端' }}</div>
        </div>
        <div class="box">
          <div class="bx-label">守护进程</div>
          <div class="bx-num">{{ info.pid && info.pid.length ? `PID ${info.pid.join(',')}` : '—' }}</div>
          <div class="muted">{{ info.message || '—' }}</div>
        </div>
        <div class="box">
          <div class="bx-label">打印队列</div>
          <div class="bx-num">{{ counts.queues ?? 0 }} <span style="font-size: 13px; font-weight: 500">台</span></div>
          <div class="muted">停用 {{ counts.stopped ?? 0 }} · 拒收 {{ counts.rejecting ?? 0 }}</div>
        </div>
        <div class="box">
          <div class="bx-label">未完作业</div>
          <div class="bx-num">{{ counts.jobs ?? 0 }} <span style="font-size: 13px; font-weight: 500">个</span></div>
          <div class="muted">正在打印 {{ counts.processing ?? 0 }} 个</div>
        </div>
      </div>

      <n-tabs v-model:value="tab" type="line" animated style="margin-top: 16px">
        <n-tab-pane name="overview" tab="队列与作业">
          <div class="cols">
            <n-card size="small" title="服务与路径">
              <div class="kv"><span>服务地址</span><b class="mono">{{ info.server || '—' }}</b></div>
              <div class="kv"><span>配置文件</span><b class="mono">{{ paths.conf || '—' }}</b></div>
              <div class="kv"><span>配置目录</span><b class="mono">{{ paths.confDir || '—' }}</b></div>
              <div class="kv"><span>日志目录</span><b class="mono">{{ paths.logDir || '—' }}</b></div>
              <div class="kv"><span>驱动目录（PPD）</span><b class="mono">{{ paths.ppdDir || '—' }}</b></div>
              <div class="kv"><span>后台程序目录</span><b class="mono">{{ paths.serverBin || '—' }}</b></div>
              <div class="kv"><span>默认队列</span><b class="mono">{{ info.defaultPrinter || '未设置' }}</b></div>
              <div class="kv"><span>自愈记录</span><b>{{ (info.store && info.store.count) || 0 }} 条</b></div>
              <div class="row" style="margin-top: 12px">
                <n-button size="small" quaternary @click="$router.push('/printers')">去打印机管理</n-button>
              </div>
            </n-card>

            <n-card size="small" title="配置文件状态">
              <div class="kv"><span>文件</span><b class="mono">{{ conf.path || '—' }}</b></div>
              <div class="kv"><span>存在</span>
                <n-tag size="small" :type="conf.exists ? 'success' : 'error'" :bordered="false">{{ conf.exists ? '是' : '否' }}</n-tag>
              </div>
              <div class="kv"><span>可写</span>
                <n-tag size="small" :type="conf.writable ? 'success' : 'warning'" :bordered="false">{{ conf.writable ? '可写' : '只读' }}</n-tag>
              </div>
              <div class="kv"><span>大小</span><b class="mono">{{ fmtBytes(conf.size) }}</b></div>
              <div class="muted" style="margin-top: 10px; font-size: 12.5px">
                {{ conf.writable ? '可在「配置」页签直接修改常用指令，保存后重启 CUPS 生效（原文件会备份为 cupsd.conf.pg.bak）。' : '当前配置文件不可写，需要用只读挂载或进入容器修改。' }}
              </div>
              <div class="row" style="margin-top: 12px">
                <n-button size="small" @click="tab = 'config'">查看配置项</n-button>
                <n-button size="small" quaternary @click="tab = 'logs'">查看日志</n-button>
              </div>
            </n-card>
          </div>

          <n-card size="small" title="打印队列" style="margin-top: 16px">
            <template #header-extra><span class="muted">共 {{ queues.length }} 个队列</span></template>
            <n-table v-if="queues.length" :single-line="false" size="small">
              <thead>
                <tr>
                  <th style="width: 180px">队列</th><th style="width: 90px">状态</th><th style="width: 90px">接收</th>
                  <th>设备 URI</th><th style="width: 260px">操作</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="q in queues" :key="q.name">
                  <td>
                    <div class="row" style="gap: 6px">
                      <b>{{ q.name }}</b>
                      <n-tag v-if="q.isDefault" size="tiny" type="success" :bordered="false">默认</n-tag>
                    </div>
                    <div class="muted" style="font-size: 12px">{{ q.info || '—' }}</div>
                  </td>
                  <td>
                    <n-tag size="small" :type="q.enabled === false ? 'error' : q.state === 'printing' ? 'info' : 'success'" :bordered="false">
                      {{ q.enabled === false ? '已停用' : q.state === 'printing' ? '打印中' : '空闲' }}
                    </n-tag>
                  </td>
                  <td>
                    <n-tag size="small" :type="q.accepting === false ? 'warning' : 'default'" :bordered="false">
                      {{ q.accepting === false ? '拒收' : '接收中' }}
                    </n-tag>
                  </td>
                  <td class="mono muted" style="font-size: 12px">{{ q.uri || '—' }}</td>
                  <td>
                    <div class="row wrap" style="gap: 4px">
                      <n-button size="tiny" quaternary @click="queueOp(q, q.enabled === false ? 'enable' : 'disable')">
                        {{ q.enabled === false ? '启用' : '停用' }}
                      </n-button>
                      <n-button size="tiny" quaternary @click="queueOp(q, q.accepting === false ? 'accept' : 'reject')">
                        {{ q.accepting === false ? '恢复接收' : '停止接收' }}
                      </n-button>
                      <n-button size="tiny" quaternary @click="queueOp(q, 'default')">设默认</n-button>
                      <n-button size="tiny" quaternary @click="testPage(q)">测试页</n-button>
                      <n-button size="tiny" quaternary type="error" @click="queueOp(q, 'purge')">清空作业</n-button>
                    </div>
                  </td>
                </tr>
              </tbody>
            </n-table>
            <n-empty v-else description="还没有打印队列" style="padding: 30px 0" />
          </n-card>

          <n-card size="small" title="未完作业" style="margin-top: 16px">
            <template #header-extra><span class="muted">最多显示 50 条</span></template>
            <n-table v-if="jobs.length" :single-line="false" size="small">
              <thead>
                <tr>
                  <th style="width: 150px">作业</th><th style="width: 160px">队列</th><th style="width: 100px">提交者</th>
                  <th style="width: 100px">大小</th><th>提交时间</th><th style="width: 90px">状态</th><th style="width: 160px">操作</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="j in jobs" :key="j.id">
                  <td class="mono">{{ j.id }}</td>
                  <td>{{ j.printer }}</td>
                  <td class="muted">{{ j.user }}</td>
                  <td class="muted">{{ fmtBytes(j.size) }}</td>
                  <td class="muted">{{ j.submitted }}</td>
                  <td>
                    <n-tag size="small" :type="j.state === 'processing' ? 'info' : 'default'" :bordered="false">
                      {{ j.state === 'processing' ? '打印中' : '排队中' }}
                    </n-tag>
                  </td>
                  <td>
                    <div class="row wrap" style="gap: 4px">
                      <n-button size="tiny" quaternary @click="jobOp(j, 'hold')">挂起</n-button>
                      <n-button size="tiny" quaternary @click="jobOp(j, 'release')">继续</n-button>
                      <n-button size="tiny" quaternary type="error" @click="jobOp(j, 'cancel')">取消</n-button>
                    </div>
                  </td>
                </tr>
              </tbody>
            </n-table>
            <n-empty v-else description="当前没有排队中的作业" style="padding: 30px 0" />
          </n-card>
        </n-tab-pane>

        <n-tab-pane name="config" tab="配置">
          <n-card size="small" title="常用指令">
            <template #header-extra>
              <span class="muted">{{ conf.writable ? '保存后需重启 CUPS 生效' : '配置文件只读，无法保存' }}</span>
            </template>
            <div class="cfg-grid">
              <div v-for="item in editableList" :key="item.key" class="cfg-item">
                <div class="cfg-label">{{ item.label }}</div>
                <n-select
                  v-if="item.values" v-model:value="form[item.key]" size="small" :options="selectOptions(item)"
                  :disabled="!conf.writable" style="max-width: 220px"
                />
                <n-input
                  v-else v-model:value="form[item.key]" size="small" placeholder="留空表示不修改"
                  :disabled="!conf.writable" style="max-width: 220px"
                />
                <div class="muted" style="font-size: 12px; margin-top: 4px">
                  {{ item.hint }}<template v-if="item.current"> · 当前值 {{ item.current }}</template>
                </div>
              </div>
            </div>
            <div class="row" style="margin-top: 14px">
              <n-button size="small" type="primary" :disabled="!conf.writable" :loading="saving" @click="saveConfig">保存配置</n-button>
              <n-button size="small" :disabled="!conf.writable" @click="resetForm">还原为当前值</n-button>
              <n-button size="small" type="warning" secondary :loading="restarting" @click="restartCups">重启 CUPS</n-button>
            </div>
          </n-card>

          <n-card size="small" title="配置文件原文" style="margin-top: 16px">
            <template #header-extra><span class="muted mono">{{ conf.path }}</span></template>
            <pre class="logs">{{ confRaw || '（读不到配置文件）' }}</pre>
          </n-card>
        </n-tab-pane>

        <n-tab-pane name="logs" tab="日志">
          <n-card size="small" title="CUPS 日志">
            <div class="filters">
              <n-select v-model:value="logName" size="small" style="width: 220px" :options="logOptions" @update:value="loadLog" />
              <n-input-number v-model:value="lines" size="small" :min="20" :max="2000" :step="100" style="width: 130px" />
              <n-button size="small" :loading="logLoading" @click="loadLog">刷新</n-button>
              <span class="muted mono" style="font-size: 12px">{{ logPath }}</span>
            </div>
            <pre class="logs">{{ logContent || '（日志为空或不可读）' }}</pre>
          </n-card>
        </n-tab-pane>
      </n-tabs>
    </n-spin>
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useMessage, useDialog } from 'naive-ui';
import { RefreshOutline, PowerOutline } from '@vicons/ionicons5';
import { api, fmtBytes } from '../api';

const message = useMessage();
const dialog = useDialog();

const loading = ref(false);
const restarting = ref(false);
const saving = ref(false);
const tab = ref('overview');
const info = ref({});
const form = ref({});

const logName = ref('error');
const lines = ref(300);
const logContent = ref('');
const logPath = ref('');
const logLoading = ref(false);
const logFiles = ref([]);

const counts = computed(() => info.value.counts || {});
const queues = computed(() => info.value.queues || []);
const jobs = computed(() => info.value.jobs || []);
const paths = computed(() => info.value.paths || {});
const conf = computed(() => info.value.conf || {});
const confRaw = computed(() => conf.value.rawText || '');
const editableList = computed(() => {
  const e = (info.value.conf || {}).editable || {};
  return Object.entries(e).map(([key, v]) => ({ key, ...v }));
});
const logOptions = computed(() => (logFiles.value.length ? logFiles.value : [{ label: 'CUPS 错误日志', value: 'error' }])
  .map((l) => ({ label: `${l.label}${l.exists === false ? '（空）' : ''}`, value: l.key })));

function selectOptions(item) {
  const values = item.values || [];
  return values.map((v) => ({ label: v, value: v }));
}

async function load() {
  loading.value = true;
  try {
    const d = await api.get('/cups/status');
    info.value = d || {};
    logFiles.value = d.logs || [];
    resetForm();
    if (tab.value === 'logs') loadLog();
    else if (tab.value === 'config') loadRaw();
  } catch (e) {
    message.error(e.message);
  } finally {
    loading.value = false;
  }
}

// 原文单独读，避免概览接口每次都带上整个 cupsd.conf
async function loadRaw() {
  try {
    const r = await api.get('/cups/config/raw');
    info.value.conf = { ...(info.value.conf || {}), rawText: (r && r.raw) || '' };
  } catch (_) {
    info.value.conf = { ...(info.value.conf || {}), rawText: '' };
  }
}

function resetForm() {
  const f = {};
  for (const item of editableList.value) f[item.key] = item.current || '';
  form.value = f;
}

async function saveConfig() {
  saving.value = true;
  try {
    const patch = {};
    for (const [k, v] of Object.entries(form.value)) {
      if (String(v || '').trim()) patch[k] = String(v).trim();
    }
    if (!Object.keys(patch).length) { message.warning('没有需要保存的改动'); return; }
    const d = await api.post('/cups/config', { patch });
    message.success(d.msg);
    await load();
    if (d.needRestart) tab.value = 'config';
  } catch (e) {
    message.error(e.message);
  } finally {
    saving.value = false;
  }
}

function restartCups() {
  dialog.warning({
    title: '重启 CUPS',
    content: '重启期间正在排队的作业会短暂中断，确定继续？',
    positiveText: '重启',
    negativeText: '取消',
    onPositiveClick: async () => {
      restarting.value = true;
      try {
        const d = await api.post('/cups/restart');
        message.success(d.msg);
        setTimeout(load, 2500);
      } catch (e) {
        message.error(e.message);
      } finally {
        restarting.value = false;
      }
    }
  });
}

function queueOp(q, op) {
  const text = {
    enable: `启用队列「${q.name}」`,
    disable: `停用队列「${q.name}」后任务会一直排队，确定继续？`,
    accept: `恢复「${q.name}」接收新任务`,
    reject: `停止「${q.name}」接收新任务？新提交会直接失败`,
    default: `把「${q.name}」设为默认打印机`,
    purge: `清空「${q.name}」的所有作业（含历史记录）？`
  }[op];
  dialog.warning({
    title: '队列操作',
    content: text,
    positiveText: '确定',
    negativeText: '取消',
    onPositiveClick: async () => {
      try {
        const d = await api.post(`/cups/queue/${encodeURIComponent(q.name)}/${op}`);
        message.success(d.msg);
        load();
      } catch (e) { message.error(e.message); }
    }
  });
}

function jobOp(j, op) {
  const text = { cancel: `取消作业 ${j.id}？`, hold: `挂起作业 ${j.id}？`, release: `恢复作业 ${j.id}？` }[op];
  dialog.warning({
    title: '作业操作',
    content: text,
    positiveText: '确定',
    negativeText: '取消',
    onPositiveClick: async () => {
      try {
        const d = await api.post(`/cups/job/${encodeURIComponent(j.id)}/${op}`);
        message.success(d.msg);
        load();
      } catch (e) { message.error(e.message); }
    }
  });
}

async function testPage(q) {
  try {
    const d = await api.post(`/printers/${encodeURIComponent(q.name)}/test`);
    message.success(d.msg);
    load();
  } catch (e) { message.error(e.message); }
}

async function loadLog() {
  logLoading.value = true;
  try {
    const d = await api.get(`/cups/logs/${logName.value}?lines=${lines.value}`);
    logContent.value = d.content || '';
    logPath.value = d.path || '';
  } catch (e) {
    logContent.value = e.message;
  } finally {
    logLoading.value = false;
  }
}

// 配置原文和日志都比较大，切到对应页签时才按需拉一次
watch(tab, (v) => {
  if (v === 'config' && !confRaw.value) loadRaw();
  if (v === 'logs' && !logContent.value) loadLog();
});

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
.cfg-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 16px 24px; }
.cfg-label { font-size: 13px; font-weight: 600; margin-bottom: 6px; }
.filters { display: flex; gap: 10px; align-items: center; margin-bottom: 14px; flex-wrap: wrap; }
.logs {
  background: #0f172a; color: #cbd5e1; padding: 14px; border-radius: 10px; font-size: 12px;
  line-height: 1.65; max-height: 520px; overflow: auto; white-space: pre-wrap; word-break: break-all; margin: 0;
}
@media (max-width: 1000px) { .grid4 { grid-template-columns: repeat(2, 1fr); } .cols, .cfg-grid { grid-template-columns: 1fr; } }
@media (max-width: 560px) { .grid4 { grid-template-columns: 1fr; } }
</style>
