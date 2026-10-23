<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h1 class="page-title">打印队列</h1>
        <div class="page-desc">CUPS 实时队列（来自 lpstat），可取消、挂起、恢复</div>
      </div>
      <div class="row wrap">
        <n-switch v-model:value="auto" size="small">
          <template #checked>自动刷新</template>
          <template #unchecked>手动</template>
        </n-switch>
        <n-radio-group v-model:value="state" size="small" @update:value="load">
          <n-radio-button value="not-completed">未完成</n-radio-button>
          <n-radio-button value="completed">已完成</n-radio-button>
        </n-radio-group>
        <n-button size="small" :loading="loading" @click="load">
          <template #icon><n-icon :component="RefreshOutline" /></template>刷新
        </n-button>
      </div>
    </div>

    <n-card size="small">
      <n-spin :show="loading">
        <n-table v-if="jobs.length" :single-line="false" size="small">
          <thead>
            <tr>
              <th style="width: 180px">任务 ID</th>
              <th>打印机</th>
              <th style="width: 120px">提交者</th>
              <th style="width: 100px">大小</th>
              <th style="width: 180px">提交时间</th>
              <th style="width: 100px">状态</th>
              <th style="width: 170px">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="j in jobs" :key="j.id">
              <td class="mono">{{ j.id }}</td>
              <td>{{ j.printer }}</td>
              <td>{{ j.user }}</td>
              <td>{{ fmtBytes(j.size) }}</td>
              <td class="muted">{{ j.submitted }}</td>
              <td>
                <n-tag size="small" :type="j.state === 'processing' ? 'info' : 'warning'" :bordered="false">
                  {{ j.state === 'processing' ? '打印中' : '排队中' }}
                </n-tag>
              </td>
              <td>
                <n-button size="tiny" quaternary type="error" @click="act(j, 'cancel')">取消</n-button>
                <n-button size="tiny" quaternary @click="act(j, 'hold')">挂起</n-button>
                <n-button size="tiny" quaternary type="primary" @click="act(j, 'release')">恢复</n-button>
              </td>
            </tr>
          </tbody>
        </n-table>
        <n-empty v-else :description="state === 'completed' ? '没有已完成的任务' : '队列为空，暂无待打印任务'" style="padding: 50px 0" />
      </n-spin>
      <template #footer>
        <div class="row-between">
          <span class="muted">共 {{ jobs.length }} 个任务{{ auto ? ' · 每 5 秒自动刷新' : '' }}</span>
          <n-button text size="small" @click="$router.push('/tasks')">查看任务记录 / 审批</n-button>
        </div>
      </template>
    </n-card>

    <n-card size="small" style="margin-top: 16px" title="队列说明">
      <div class="muted" style="line-height: 1.9; font-size: 13px">
        · 这里的任务直接来自 CUPS 内核队列，取消后打印机立即停止输出（已进入打印机缓冲的任务可能仍会输出）。<br />
        · 若任务长期停留在「排队中」，通常是打印机离线、驱动不匹配或队列被暂停，可到「打印机」页查看状态。<br />
        · 平台自身提交的打印任务带有审批与重试逻辑，请在「任务审批」页处理。
      </div>
    </n-card>
  </div>
</template>

<script setup>
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useMessage } from 'naive-ui';
import { RefreshOutline } from '@vicons/ionicons5';
import { api, fmtBytes } from '../api';

const message = useMessage();
const loading = ref(false);
const jobs = ref([]);
const state = ref('not-completed');
const auto = ref(true);
let timer = null;

async function load() {
  loading.value = true;
  try {
    const d = await api.get(`/cups/jobs?state=${state.value}`);
    jobs.value = d.jobs || [];
  } catch (e) {
    message.error(e.message);
  } finally {
    loading.value = false;
  }
}

async function act(job, action) {
  try {
    const d = await api.post(`/cups/jobs/${encodeURIComponent(job.id)}/${action}`);
    message.success(d.msg);
    load();
  } catch (e) { message.error(e.message); }
}

function resetTimer() {
  clearInterval(timer);
  if (auto.value) timer = setInterval(load, 5000);
}

watch(auto, resetTimer);
const onRefresh = () => load();
onMounted(() => {
  load();
  resetTimer();
  window.addEventListener('pg:refresh', onRefresh);
});
onBeforeUnmount(() => {
  clearInterval(timer);
  window.removeEventListener('pg:refresh', onRefresh);
});
</script>
