<template>
  <n-modal
    :show="show" preset="card" style="max-width: 780px" :bordered="false"
    title="发现打印机，是否自动安装驱动？"
    @update:show="(v) => { if (!v) emit('update:show', false); }"
  >
    <n-alert type="info" :bordered="false" style="margin-bottom: 14px">
      已识别到 <b>{{ pending.length }}</b> 台新设备。默认按设备上报的型号自动匹配驱动（免驱 IPP 优先），
      直接勾选并点「自动安装并添加」即可；驱动不理想可对单台再手动选择、在线下载或上传。
    </n-alert>

    <div class="rows">
      <div v-for="d in rows" :key="d.host" class="row-item" :class="{ added: d.added }">
        <n-checkbox v-model:checked="d.checked" :disabled="d.added" />
        <div class="grow" style="min-width: 0">
          <div class="d-name">
            {{ d.name }}
            <n-tag size="tiny" :bordered="false" type="info">{{ d.source }}</n-tag>
            <n-tag v-if="d.driverless" size="tiny" :bordered="false" type="success">免驱</n-tag>
            <n-tag v-if="d.added" size="tiny" :bordered="false">已添加</n-tag>
          </div>
          <div class="muted mono d-uri">{{ d.uri }}</div>
          <div class="muted d-model">{{ d.model || '未识别型号' }}</div>
        </div>
        <div class="d-driver">
          <n-spin v-if="d.recLoading" size="small" />
          <template v-else>
            <n-select
              v-model:value="d.driverId" size="tiny" :options="driverOptions(d)" :disabled="d.added"
              style="width: 190px"
            />
            <n-button size="tiny" quaternary :disabled="d.added" @click="openPicker(d)">更换驱动…</n-button>
          </template>
        </div>
      </div>
    </div>

    <template #footer>
      <div class="foot">
        <span class="muted grow">{{ footerText }}</span>
        <n-button size="small" @click="emit('update:show', false)">稍后</n-button>
        <n-button size="small" type="primary" :loading="adding" :disabled="!selected.length" @click="addSelected">
          自动安装并添加{{ selected.length ? `（${selected.length}）` : '' }}
        </n-button>
      </div>
    </template>

    <DriverPicker v-model:show="pickerShow" :device="pickerDevice" @picked="onPicked" />
  </n-modal>
</template>

<script setup>
import { computed, reactive, ref, watch } from 'vue';
import { useMessage } from 'naive-ui';
import { api } from '../api';
import DriverPicker from './DriverPicker.vue';

const props = defineProps({
  show: { type: Boolean, default: false },
  devices: { type: Array, default: () => [] }
});
const emit = defineEmits(['update:show', 'done']);
const message = useMessage();

const rows = reactive([]);
const adding = ref(false);
const pickerShow = ref(false);
const pickerDevice = ref({});
const pickerRow = ref(null);

const pending = computed(() => rows.filter((r) => !r.added));
const selected = computed(() => rows.filter((r) => r.checked && !r.added));
const footerText = computed(() => (
  selected.value.length
    ? `将按自动匹配的驱动创建队列，失败会逐台提示`
    : '未选中任何设备'
));

watch(() => props.show, async (v) => {
  if (!v) return;
  rows.splice(0, rows.length);
  for (const d of props.devices) {
    rows.push({
      ...d,
      checked: !d.added,
      driverId: '',
      driverLabel: '',
      recLoading: false,
      altOptions: []
    });
  }
  // 并发取推荐驱动（每台一次，最多 8 台，避免一次扫到很多设备时打爆）
  const targets = rows.filter((r) => !r.added).slice(0, 8);
  await Promise.all(targets.map(async (r) => {
    r.recLoading = true;
    try {
      const d = await api.post('/drivers/recommend', {
        uri: r.uri, kind: r.kind, model: r.model, deviceId: r.deviceId,
        formats: r.formats || [], driverless: !!r.driverless
      });
      r.driverId = d.id;
      r.driverLabel = d.label;
      r.altOptions = (d.alternatives || []).slice(0, 3);
    } catch (_) {
      r.driverId = /^(ipp|ipps):/i.test(r.uri) ? 'everywhere' : 'raw';
      r.driverLabel = r.driverId === 'everywhere' ? 'IPP Everywhere（免驱）' : 'RAW 直通';
    } finally {
      r.recLoading = false;
    }
  }));
  for (const r of rows) if (!r.driverId) r.driverId = 'raw';
});

function driverOptions(row) {
  const opts = [];
  if (row.driverLabel) opts.push({ label: `推荐：${row.driverLabel}`, value: row.driverId });
  const push = (v, l) => { if (!opts.some((o) => o.value === v)) opts.push({ label: l, value: v }); };
  push('everywhere', 'IPP Everywhere（免驱）');
  push('raw', 'RAW 直通');
  for (const a of row.altOptions) push(a.id, a.label);
  if (row.driverId && !opts.some((o) => o.value === row.driverId)) {
    opts.push({ label: row.driverLabel || row.driverId, value: row.driverId });
  }
  return opts;
}

function queueNameFor(row) {
  const host = String(row.host || '');
  const octet = (host.match(/^\d+\.\d+\.\d+\.(\d+)$/) || [])[1] || '';
  const generic = !row.model || /打印服务|未知|RAW\/JetDirect/.test(row.model);
  const base = (generic ? (row.kind === 'socket' || row.kind === 'lpd' ? 'raw' : 'ipp') : row.model)
    .replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 26).toLowerCase();
  return `${base || 'printer'}${octet ? `-${octet}` : ''}`.slice(0, 40);
}

function openPicker(row) {
  pickerRow.value = row;
  pickerDevice.value = { ...row };
  pickerShow.value = true;
}

function onPicked(driver) {
  const row = pickerRow.value;
  if (!row) return;
  row.driverId = driver.id;
  row.driverLabel = driver.label;
  if (!driverOptions(row).some((o) => o.value === driver.id)) {
    row.altOptions = [...row.altOptions, { id: driver.id, label: driver.label }];
  }
  message.success(`已选择驱动：${driver.label}`);
}

async function addSelected() {
  adding.value = true;
  const ok = [];
  const fail = [];
  for (const row of selected.value) {
    const baseName = queueNameFor(row);
    let done = false;
    let lastErr = '';
    // 同名队列已存在时自动加 -2/-3 后缀，避免整批添加被一条重名卡住
    for (let attempt = 0; attempt < 4 && !done; attempt++) {
      const name = attempt === 0 ? baseName : `${baseName}-${attempt + 1}`.slice(0, 40);
      try {
        const d = await api.post('/printers', {
          name,
          uri: row.uri,
          model: row.driverId || 'raw',
          info: (row.model || row.name || '').slice(0, 60),
          deviceId: row.deviceId || '',
          formats: row.formats || [],
          driverless: !!row.driverless,
          shared: true
        });
        row.added = true;
        row.checked = false;
        ok.push(d.msg || name);
        done = true;
      } catch (e) {
        lastErr = e.message;
        if (!/已存在/.test(lastErr)) break;
      }
    }
    if (!done) fail.push(`${row.name}：${lastErr}`);
  }
  adding.value = false;
  if (ok.length) message.success(`已添加 ${ok.length} 台打印机`);
  if (fail.length) message.error(fail[0]);
  emit('done');
  if (!fail.length) emit('update:show', false);
}
</script>

<style scoped>
.rows { max-height: 52vh; overflow: auto; }
.row-item { display: flex; align-items: flex-start; gap: 10px; padding: 10px 4px; border-bottom: 1px solid rgba(148, 163, 184, 0.16); }
.row-item.added { opacity: 0.55; }
.d-name { font-weight: 600; font-size: 14px; display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.d-uri { font-size: 11px; word-break: break-all; margin-top: 2px; }
.d-model { font-size: 12px; margin-top: 2px; }
.d-driver { display: flex; align-items: center; gap: 4px; flex-shrink: 0; }
.foot { display: flex; align-items: center; gap: 10px; }
</style>
