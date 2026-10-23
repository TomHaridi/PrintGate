<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h1 class="page-title">任务审批</h1>
        <div class="page-desc">平台内所有打印任务记录，开启「逐单审批」后需在此放行</div>
      </div>
      <div class="row wrap">
        <n-input v-model:value="q" size="small" placeholder="搜索文件名 / 用户 / 打印机" clearable style="width: 220px" @keyup.enter="reload" />
        <n-button size="small" :loading="loading" @click="reload">
          <template #icon><n-icon :component="RefreshOutline" /></template>刷新
        </n-button>
        <n-button v-if="tab === 'pending' && checked.length" size="small" type="primary" @click="batchApprove">
          批量批准（{{ checked.length }}）
        </n-button>
      </div>
    </div>

    <n-card size="small">
      <div class="filter-bar">
        <n-radio-group v-model:value="tab" size="small" @update:value="onTab">
          <n-radio-button value="pending">待审批{{ stats.pending ? ` (${stats.pending})` : '' }}</n-radio-button>
          <n-radio-button value="all">全部</n-radio-button>
          <n-radio-button value="done">已完成</n-radio-button>
          <n-radio-button value="failed">失败 / 异常</n-radio-button>
        </n-radio-group>
      </div>

      <n-spin :show="loading">
        <n-table v-if="tasks.length" :single-line="false" size="small">
          <thead>
            <tr>
              <th v-if="tab === 'pending'" style="width: 40px">
                <n-checkbox :checked="allChecked" :indeterminate="indeterminate" @update:checked="toggleAll" />
              </th>
              <th style="width: 60px">ID</th>
              <th>文件</th>
              <th style="width: 130px">来源</th>
              <th style="width: 130px">打印机</th>
              <th style="width: 190px">参数</th>
              <th style="width: 90px">状态</th>
              <th style="width: 140px">提交时间</th>
              <th style="width: 180px">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="t in tasks" :key="t.id">
              <td v-if="tab === 'pending'">
                <n-checkbox :checked="checked.includes(t.id)" @update:checked="(v) => toggle(t.id, v)" />
              </td>
              <td class="mono">{{ t.id }}</td>
              <td>
                <div class="fname">{{ t.filename || '（文件已清理）' }}</div>
                <div class="muted" style="font-size: 11.5px">
                  {{ fmtBytes(t.size) }}<span v-if="t.pages"> · {{ t.pages }} 页</span>
                  <span v-if="t.jobId" class="mono"> · {{ t.jobId }}</span>
                </div>
                <div v-if="t.error" class="err">{{ t.error }}</div>
              </td>
              <td>
                <n-tag size="tiny" :bordered="false" :type="t.source === 'miniapp' ? 'info' : 'default'">
                  {{ t.source === 'miniapp' ? '小程序' : '后台' }}
                </n-tag>
                <div v-if="t.source === 'miniapp' && (t.nickname || t.avatar)" class="who">
                  <div class="who-av">
                    <img v-if="t.avatar" :src="t.avatar" alt="" />
                    <span v-else>{{ (t.nickname || '微')[0] }}</span>
                  </div>
                  <n-popover trigger="hover" placement="top" :delay="200">
                    <template #trigger>
                      <span class="who-name">{{ t.nickname || '微信用户' }}</span>
                    </template>
                    <div class="who-pop">
                      <div class="who-pop-name">{{ t.nickname || '微信用户' }}</div>
                      <div class="muted">微信号：{{ t.wechat_id || '未填写' }}</div>
                      <div class="muted">手机号：{{ t.phone || '未填写' }}</div>
                      <n-button
                        v-if="t.user_id" size="tiny" quaternary type="primary"
                        @click="$router.push(`/users?uid=${t.user_id}`)"
                      >查看用户资料</n-button>
                    </div>
                  </n-popover>
                </div>
                <div v-else class="muted" style="font-size: 11.5px; margin-top: 2px">{{ t.nickname || '管理员' }}</div>
              </td>
              <td class="mono" style="font-size: 12px">{{ t.printer }}</td>
              <td class="muted" style="font-size: 12px">{{ paramText(t) }}</td>
              <td><n-tag size="small" :type="statusMeta(t.status).type" :bordered="false">{{ statusMeta(t.status).text }}</n-tag></td>
              <td class="muted">{{ fmtTime(t.created_at) }}</td>
              <td>
                <template v-if="t.status === 'pending'">
                  <n-button size="tiny" type="primary" secondary @click="approve(t)">批准</n-button>
                  <n-button size="tiny" type="error" quaternary @click="reject(t)">拒绝</n-button>
                </template>
                <template v-else>
                  <n-button
                    v-if="['failed', 'canceled', 'rejected'].includes(t.status)"
                    size="tiny" quaternary type="primary" @click="retry(t)"
                  >重试</n-button>
                  <n-button
                    v-if="['approved', 'printing', 'pending'].includes(t.status)"
                    size="tiny" quaternary type="error" @click="cancel(t)"
                  >取消</n-button>
                  <n-button v-if="t.file_id && t.file_available !== false" size="tiny" quaternary @click="preview(t)">预览</n-button>
                </template>
              </td>
            </tr>
          </tbody>
        </n-table>
        <n-empty v-else description="没有符合条件的任务" style="padding: 50px 0" />
      </n-spin>

      <template #footer>
        <div class="row-between">
          <span class="muted">共 {{ total }} 条 · 第 {{ page }} 页</span>
          <n-pagination v-model:page="page" :page-size="size" :item-count="total" size="small" @update:page="load" />
        </div>
      </template>
    </n-card>

    <n-modal v-model:show="previewShow" preset="card" title="文件预览" style="max-width: 720px" :bordered="false">
      <div style="text-align: center; background: #f8fafc; border-radius: 10px; min-height: 200px; padding: 12px">
        <img v-if="previewUrl" :src="previewUrl" alt="预览" style="max-width: 100%; box-shadow: 0 6px 24px rgba(0,0,0,.08)" />
        <div v-else class="muted" style="padding: 60px 0">该文件不支持预览或已被清理</div>
      </div>
    </n-modal>
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useMessage, useDialog } from 'naive-ui';
import { RefreshOutline } from '@vicons/ionicons5';
import { api, fmtBytes, fmtTime, STATUS_META } from '../api';

const message = useMessage();
const dialog = useDialog();
const loading = ref(false);
const tasks = ref([]);
const tab = ref('pending');
const q = ref('');
const page = ref(1);
const size = ref(20);
const total = ref(0);
const stats = ref({ pending: 0 });
const checked = ref([]);
const previewShow = ref(false);
const previewUrl = ref('');

const statusMeta = (s) => STATUS_META[s] || { text: s, type: 'default' };
const allChecked = computed(() => tasks.value.length > 0 && checked.value.length === tasks.value.length);
const indeterminate = computed(() => checked.value.length > 0 && checked.value.length < tasks.value.length);

function paramText(t) {
  const o = t.options || {};
  const parts = [];
  if (o.copies) parts.push(`${o.copies} 份`);
  parts.push(o.color === 'color' ? '彩色' : '黑白');
  if (o.sides && o.sides !== 'one-sided') parts.push('双面');
  if (o.media) parts.push(o.media);
  if (o.pageRanges) parts.push(`页 ${o.pageRanges}`);
  if (o.numberUp > 1) parts.push(`${o.numberUp}页/张`);
  return parts.join(' · ');
}

async function load() {
  loading.value = true;
  try {
    const d = await api.get(`/tasks?status=${tab.value}&page=${page.value}&size=${size.value}&q=${encodeURIComponent(q.value)}`);
    tasks.value = d.tasks || [];
    total.value = d.total || 0;
    checked.value = [];
    const dash = await api.get('/dashboard');
    stats.value = { pending: dash.counts?.tasksPending || 0 };
  } catch (e) {
    message.error(e.message);
  } finally {
    loading.value = false;
  }
}

function reload() {
  page.value = 1;
  load();
}

function onTab() {
  page.value = 1;
  load();
}

function toggle(id, v) {
  checked.value = v ? [...new Set([...checked.value, id])] : checked.value.filter((x) => x !== id);
}
function toggleAll(v) {
  checked.value = v ? tasks.value.map((t) => t.id) : [];
}

async function approve(t) {
  try {
    const d = await api.post(`/tasks/${t.id}/approve`);
    message.success(d.msg);
    load();
  } catch (e) { message.error(e.message); }
}

async function reject(t) {
  dialog.warning({
    title: '拒绝任务',
    content: `确定拒绝「${t.filename}」的打印请求吗？`,
    positiveText: '拒绝',
    negativeText: '取消',
    onPositiveClick: async () => {
      try {
        const d = await api.post(`/tasks/${t.id}/reject`, { reason: '管理员拒绝' });
        message.success(d.msg);
        load();
      } catch (e) { message.error(e.message); }
    }
  });
}

async function cancel(t) {
  try {
    const d = await api.post(`/tasks/${t.id}/cancel`);
    message.success(d.msg);
    load();
  } catch (e) { message.error(e.message); }
}

async function retry(t) {
  try {
    const d = await api.post(`/tasks/${t.id}/retry`);
    message.success(d.msg);
    load();
  } catch (e) { message.error(e.message); }
}

function preview(t) {
  previewUrl.value = '';
  previewShow.value = true;
  // 通过任务里的文件 id 预览；后端 /files/:id/preview 仅管理员可用，token 走 query 不支持，这里用 blob 拉取
  api.get(`/files/${t.file_id}/preview`, { responseType: 'blob' })
    .then((blob) => {
      previewUrl.value = URL.createObjectURL(blob instanceof Blob ? blob : new Blob([blob]));
    })
    .catch((e) => {
      previewUrl.value = '';
      previewShow.value = false;
      message.warning(e.message || '预览失败');
    });
}

async function batchApprove() {
  const ids = [...checked.value];
  if (!ids.length) return;
  let ok = 0;
  for (const id of ids) {
    try { await api.post(`/tasks/${id}/approve`); ok++; } catch (_) {}
  }
  message.success(`已批准 ${ok} 个任务`);
  load();
}

const onRefresh = () => load();
onMounted(() => {
  load();
  window.addEventListener('pg:refresh', onRefresh);
});
onBeforeUnmount(() => window.removeEventListener('pg:refresh', onRefresh));
</script>

<style scoped>
.filter-bar { margin-bottom: 14px; }
.fname { font-size: 13px; font-weight: 550; max-width: 240px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.err { color: #dc2626; font-size: 11.5px; margin-top: 2px; max-width: 280px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* 提交者：头像 + 昵称，悬停看微信号 / 手机号，便于核对「这份是谁打的」 */
.who { display: flex; align-items: center; gap: 6px; margin-top: 4px; }
.who-av {
  width: 22px; height: 22px; border-radius: 50%; flex: 0 0 22px; overflow: hidden;
  background: linear-gradient(140deg, #0ea5a4, #0284c7); color: #fff;
  display: grid; place-items: center; font-size: 11px;
}
.who-av img { width: 100%; height: 100%; object-fit: cover; display: block; }
.who-name { font-size: 12px; cursor: default; max-width: 96px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.who-pop { max-width: 220px; }
.who-pop-name { font-size: 13px; font-weight: 600; margin-bottom: 4px; }
.who-pop .muted { font-size: 12px; }
</style>
