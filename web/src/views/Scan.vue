<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h1 class="page-title">扫描仪</h1>
        <div class="page-desc">通过 SANE / eSCL 驱动平板与馈纸式扫描仪，结果可直接下载</div>
      </div>
      <n-button size="small" :loading="loading" @click="load">
        <template #icon><n-icon :component="RefreshOutline" /></template>重新检测
      </n-button>
    </div>

    <n-alert v-if="!ok" type="warning" :bordered="false" style="margin-bottom: 16px">
      <div>{{ msg || '未检测到扫描组件' }}</div>
      <div v-if="diag.hints" class="diag">
        <div class="diag-row"><span class="mono">安装</span>{{ diag.hints.install || DEFAULT_HINT.install }}</div>
        <div class="diag-row"><span class="mono">USB</span>{{ diag.hints.usb || DEFAULT_HINT.usb }}</div>
        <div class="diag-row"><span class="mono">网络</span>{{ diag.hints.network || DEFAULT_HINT.network }}</div>
      </div>
    </n-alert>

    <n-alert v-else-if="!devices.length" type="info" :bordered="false" style="margin-bottom: 16px">
      <div>SANE 组件正常（{{ diag.version || '已安装' }}），但还没识别到扫描仪。</div>
      <div class="diag">
        <div class="diag-row"><span class="mono">USB</span>{{ (diag.hints || DEFAULT_HINT).usb }}</div>
        <div class="diag-row"><span class="mono">网络</span>{{ (diag.hints || DEFAULT_HINT).network }}</div>
        <div v-if="(diag.usb || []).length" class="diag-row">
          <span class="mono">已见</span>USB 总线上发现 {{ diag.usb.length }} 个设备：{{ diag.usb.map((u) => u.model).join('、') }}（可能是缺驱动）
        </div>
      </div>
    </n-alert>

    <div class="layout">
      <n-card size="small" class="net-card">
        <template #header>
          <div class="card-hd">
            <span class="card-title">网络扫描仪</span>
            <span class="card-meta">{{ netDevices.length }} 台已配置</span>
          </div>
        </template>

        <n-alert v-if="netInfo.advice" :type="netInfo.bridged ? 'warning' : 'success'" :bordered="false" style="margin-bottom: 12px; font-size: 12.5px">
          {{ netInfo.advice }}
        </n-alert>

        <div class="net-form">
          <n-input v-model:value="netName" size="small" placeholder="名称，如 二楼一体机" style="width: 150px" />
          <n-input v-model:value="netHost" size="small" placeholder="IP 或 IP:端口，如 192.168.1.50" style="flex: 1; min-width: 180px" />
          <n-button size="small" :loading="probing" @click="probe">探测</n-button>
          <n-button size="small" type="primary" :loading="adding" @click="addNet">添加</n-button>
        </div>
        <div v-if="probeMsg" class="probe-msg" :class="probeOk ? 'ok' : 'bad'">
          {{ probeMsg }}
          <div v-if="!probeOk && probeDetail.length" class="probe-steps">
            <span class="steps-toggle" @click="showSteps = !showSteps">{{ showSteps ? '收起明细' : '查看探测明细' }}</span>
            <div v-if="showSteps" class="steps-body">
              <div v-for="(st, i) in probeDetail" :key="i" class="step-row">
                <span class="step-url">{{ st.url }}</span>
                <span class="step-res">{{ st.status ? 'HTTP ' + st.status : (st.error || '失败') }}</span>
              </div>
              <div v-if="openPorts.length" class="step-row"><span class="step-url">开放端口</span><span class="step-res ok">{{ openPorts.join(' / ') }}</span></div>
            </div>
          </div>
          <n-button v-if="!probeOk && canForce" size="tiny" type="warning" :loading="forcing" style="margin-top: 8px" @click="forceAdd">
            强制添加（老机型 / WSD）
          </n-button>
        </div>

        <div v-if="netDevices.length" class="net-list">
          <div v-for="d in netDevices" :key="d.name" class="net-row">
            <span class="net-name">{{ d.name }}</span>
            <span class="mono grow">{{ d.url }}</span>
            <n-button size="tiny" quaternary type="error" @click="removeNet(d)">移除</n-button>
          </div>
        </div>
        <div v-else class="muted" style="font-size: 12.5px">还没配置网络扫描仪。填上一体机的 IP 点「添加」，之后它就会出现在下面的设备列表里。</div>
      </n-card>

      <n-card size="small" title="扫描设置">
        <n-form label-placement="top">
          <n-form-item label="扫描设备">
            <n-select v-model:value="form.device" :options="deviceOptions" :disabled="!devices.length" placeholder="未发现设备" @update:value="loadOptions" />
            <div v-if="currentDevice && currentDevice.url" class="dev-url">
              地址：<span class="mono">{{ currentDevice.url }}</span>
              <span v-if="currentDevice.addressKind === 'host'" class="dev-warn">（主机名，容器可能解析不了 → 建议在「网络扫描仪」里填 IP）</span>
            </div>
          </n-form-item>
          <div class="grid2">
            <n-form-item label="分辨率">
              <n-select v-model:value="form.resolution" :options="resOptions" />
            </n-form-item>
            <n-form-item label="色彩模式">
              <n-select v-model:value="form.mode" :options="modeOptions" />
            </n-form-item>
          </div>
          <div class="grid2">
            <n-form-item label="来源">
              <n-select v-model:value="form.source" :options="sourceOptions" />
            </n-form-item>
            <n-form-item label="输出格式">
              <n-select v-model:value="form.format" :options="[
                { label: 'JPEG', value: 'jpeg' }, { label: 'PNG', value: 'png' }, { label: 'PDF', value: 'pdf' }
              ]" />
            </n-form-item>
          </div>
          <n-form-item label="页数（馈纸器连续扫描）">
            <n-input-number v-model:value="form.pages" :min="1" :max="20" style="width: 100%" />
          </n-form-item>
          <n-button type="primary" block :loading="scanning" :disabled="!form.device" @click="startScan">
            <template #icon><n-icon :component="ScanOutline" /></template>
            {{ scanning ? '扫描中…' : '开始扫描' }}
          </n-button>
          <div v-if="scanError" class="err">
            {{ scanError }}
            <div style="margin-top: 6px">
              <n-button size="tiny" :loading="selfTesting" @click="runSelfTest">设备自检</n-button>
            </div>
          </div>
          <div v-if="selfTest" class="selftest">
            <div class="st-line"><b>能否打开</b>{{ selfTest.openable ? '可以' : '打不开' }}</div>
            <div class="st-line" v-if="selfTest.hint"><b>结论</b>{{ selfTest.hint }}</div>
            <div class="st-line" v-if="(selfTest.discover || []).length">
              <b>发现到的地址</b>
              <div>
                <div v-for="(d, i) in selfTest.discover" :key="i" class="mono">{{ d.kind }} · {{ d.name }} → {{ d.url }}</div>
              </div>
            </div>
            <div class="st-line" v-if="selfTest.test && selfTest.test.msg"><b>原始输出</b>{{ selfTest.test.msg }}</div>
          </div>
        </n-form>
      </n-card>

      <n-card size="small" title="扫描记录">
        <template #header-extra>
          <n-button text size="small" @click="load">刷新</n-button>
        </template>
        <div v-if="records.length" class="records">
          <div v-for="r in records" :key="r.id" class="rec">
            <n-icon :component="ImageOutline" :size="18" style="color: #0f766e" />
            <div class="grow" style="min-width: 0">
              <div class="rec-name">{{ r.filename }}</div>
              <div class="muted" style="font-size: 11.5px">{{ fmtBytes(r.size) }} · {{ fmtTime(r.created_at) }}</div>
            </div>
            <n-button size="tiny" quaternary type="primary" @click="download(r)">下载</n-button>
            <n-button size="tiny" quaternary type="error" @click="remove(r)">删除</n-button>
          </div>
        </div>
        <n-empty v-else description="还没有扫描记录" style="padding: 40px 0" />
      </n-card>
    </div>
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue';
import { useMessage } from 'naive-ui';
import { RefreshOutline, ScanOutline, ImageOutline } from '@vicons/ionicons5';
import { api, fmtBytes, fmtTime } from '../api';

const message = useMessage();
const loading = ref(false);
const ok = ref(true);
const msg = ref('');
const devices = ref([]);
const diag = ref({ usb: [], version: '', hints: null, devices: [] });
const records = ref([]);
const opts = ref([]);
const scanning = ref(false);
const scanError = ref('');

const form = reactive({ device: '', resolution: 300, mode: 'Color', source: '', format: 'jpeg', pages: 1 });

// 诊断接口拿不到时的兜底文案，保证页面永远有可执行的提示
const DEFAULT_HINT = {
  install: 'apk add --no-cache sane sane-utils（需先启用 community 仓库）',
  usb: 'docker run --device /dev/bus/usb ... 或 compose 的 devices: - /dev/bus/usb:/dev/bus/usb',
  network: '网络一体机需与容器同网段（建议 network_mode: host），eSCL 设备可装 sane-airscan'
};

const deviceOptions = computed(() => devices.value.map((d) => ({ label: `${d.model}（${d.device}）`, value: d.device })));
const resOptions = computed(() => {
  const r = opts.value.find((o) => o.name === 'resolution');
  const vals = (r?.values || []).filter((v) => /^\d+$/.test(v)).map((v) => ({ label: `${v} dpi`, value: Number(v) }));
  return vals.length ? vals : [75, 150, 300, 600, 1200].map((v) => ({ label: `${v} dpi`, value: v }));
});
const modeOptions = computed(() => {
  const o = opts.value.find((x) => x.name === 'mode');
  return (o?.values?.length ? o.values : ['Color', 'Gray', 'Lineart']).map((v) => ({ label: v, value: v }));
});
const sourceOptions = computed(() => {
  const o = opts.value.find((x) => x.name === 'source');
  return [{ label: '自动', value: '' }, ...(o?.values || ['Flatbed', 'ADF']).map((v) => ({ label: v, value: v }))];
});

async function load() {
  loading.value = true;
  try {
    const d = await api.get('/scanners?force=1');
    ok.value = !!d.sane;
    msg.value = d.msg || '';
    devices.value = d.devices || [];
    records.value = d.records || [];
    // 诊断接口失败也要保持结构完整，模板里直接用 diag.usb / diag.hints 才不会炸
    const dg = await api.get('/scanners/diag').catch(() => null);
    diag.value = Object.assign({ usb: [], version: '', hints: { ...DEFAULT_HINT }, devices: [] }, dg || {});
    if (devices.value.length && !form.device) {
      form.device = devices.value[0].device;
      loadOptions(form.device);
    }
  } catch (e) {
    ok.value = false;
    msg.value = e.message;
  } finally {
    loading.value = false;
  }
}

async function loadOptions(device) {
  if (!device) return;
  try {
    const d = await api.get(`/scanners/${encodeURIComponent(device)}/options`);
    opts.value = d.options || [];
    const res = opts.value.find((o) => o.name === 'resolution');
    if (res?.current && /^\d+$/.test(res.current)) form.resolution = Number(res.current);
    const m = opts.value.find((o) => o.name === 'mode');
    if (m?.current) form.mode = m.current;
  } catch (_) {}
}

async function startScan() {
  scanning.value = true;
  scanError.value = '';
  try {
    const d = await api.post('/scanners/scan', { ...form }, { timeout: 240000 });
    message.success(`扫描完成，生成 ${d.files?.length || 1} 个文件`);
    await load();
  } catch (e) {
    scanError.value = e.message;
  } finally {
    scanning.value = false;
  }
}

async function download(r) {
  try {
    const blob = await api.get(`/scanners/records/${r.id}/download`, { responseType: 'blob' });
    const url = URL.createObjectURL(blob instanceof Blob ? blob : new Blob([blob]));
    const a = document.createElement('a');
    a.href = url;
    a.download = r.filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 3000);
  } catch (e) { message.error(e.message); }
}

async function remove(r) {
  try {
    await api.delete(`/scanners/records/${r.id}`);
    message.success('已删除');
    load();
  } catch (e) { message.error(e.message); }
}

// ---------- 网络扫描仪 ----------
const netDevices = ref([]);
const netInfo = ref({});
const netName = ref('');
const netHost = ref('');
const probing = ref(false);
const adding = ref(false);
const probeMsg = ref('');
const probeOk = ref(false);
const probeDetail = ref([]);
const openPorts = ref([]);
const canForce = ref(false);
const forcing = ref(false);
const showSteps = ref(false);

async function loadNet() {
  try {
    const d = await api.get('/scanners/network');
    netDevices.value = d.devices || [];
    netInfo.value = d.network || {};
  } catch (_) { /* 老版本后端没这个接口时静默 */ }
}

async function probe() {
  if (!netHost.value.trim()) return message.warning('先填一体机的 IP');
  probing.value = true;
  probeMsg.value = '';
  try {
    const d = await api.post('/scanners/network/probe', { host: netHost.value.trim() });
    probeOk.value = !!d.ok;
    probeMsg.value = d.msg || (d.ok ? '已连通' : '未连通');
    probeDetail.value = d.steps || [];
    openPorts.value = d.open || [];
    canForce.value = !!d.canForce;
  } catch (e) {
    probeOk.value = false;
    probeMsg.value = e.message || '探测失败';
  } finally {
    probing.value = false;
  }
}

// 强制添加：探测没通过也被允许，交给 airscan 自己再试（WSD / 私有协议）
async function forceAdd() {
  if (!netName.value.trim()) return message.warning('给这台扫描仪起个名字');
  forcing.value = true;
  try {
    const d = await api.post('/scanners/network', { name: netName.value.trim(), host: netHost.value.trim(), force: true });
    message.success(d.msg || '已添加');
    netName.value = '';
    netHost.value = '';
    probeMsg.value = '';
    await loadNet();
    await load();
  } catch (e) {
    message.error(e.message || '添加失败');
  } finally {
    forcing.value = false;
  }
}

async function addNet() {
  if (!netName.value.trim()) return message.warning('给这台扫描仪起个名字');
  if (!netHost.value.trim()) return message.warning('先填一体机的 IP');
  adding.value = true;
  try {
    const d = await api.post('/scanners/network', { name: netName.value.trim(), host: netHost.value.trim() });
    message.success(d.msg || '已添加');
    netName.value = '';
    netHost.value = '';
    probeMsg.value = '';
    await loadNet();
    await load();          // 重新枚举，让新设备进「扫描设备」下拉
  } catch (e) {
    message.error(e.message || '添加失败');
  } finally {
    adding.value = false;
  }
}

async function removeNet(d) {
  try {
    await api.delete(`/scanners/network/${encodeURIComponent(d.name)}`);
    message.success('已移除');
    await loadNet();
    await load();
  } catch (e) {
    message.error(e.message || '移除失败');
  }
}

// 设备自检：--test 只打开设备不扫描，能区分「连不上」和「参数不对」
const selfTest = ref(null);
const selfTesting = ref(false);
const currentDevice = computed(() => devices.value.find((d) => d.device === form.device) || null);

async function runSelfTest() {
  if (!form.device) return;
  selfTesting.value = true;
  selfTest.value = null;
  try {
    selfTest.value = await api.get(`/scanners/${encodeURIComponent(form.device)}/selftest`);
  } catch (e) {
    selfTest.value = { openable: false, hint: e.message || '自检失败', discover: [] };
  } finally {
    selfTesting.value = false;
  }
}

onMounted(async () => { await loadNet(); });

onMounted(load);
</script>

<style scoped>
.dev-url { margin-top: 6px; font-size: 12px; color: #64748b; }
.dev-warn { color: #b45309; }
.selftest { margin-top: 10px; padding: 10px 12px; border-radius: 8px; background: #f8fafb; font-size: 12.5px; display: grid; gap: 6px; }
.st-line { display: flex; gap: 8px; }
.st-line b { flex: 0 0 76px; color: #475569; font-weight: 600; }
</style>
<style scoped>
.net-form { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.probe-msg { margin-top: 8px; font-size: 12.5px; line-height: 1.6; }
.probe-msg.ok { color: #158a63; }
.probe-msg.bad { color: #b45309; }
.probe-steps { margin-top: 6px; font-size: 12px; color: #64748b; }
.steps-toggle { color: #0c8b80; cursor: pointer; text-decoration: underline; }
.steps-body { margin-top: 6px; background: #f8fafb; border-radius: 8px; padding: 8px 10px; display: grid; gap: 4px; }
.step-row { display: flex; justify-content: space-between; gap: 12px; }
.step-url { font-family: ui-monospace, Menlo, monospace; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.step-res { flex: 0 0 auto; color: #b45309; }
.step-res.ok { color: #158a63; }
.net-list { margin-top: 10px; display: grid; gap: 6px; }
.net-row { display: flex; align-items: center; gap: 10px; padding: 6px 8px; border-radius: 8px; background: #f8fafb; font-size: 12.5px; }
.net-name { font-weight: 600; color: #0f172a; }
</style>
<style scoped>
.layout { display: grid; grid-template-columns: 400px 1fr; gap: 16px; align-items: start; }
/* 网络扫描仪横跨两列：输入框和按钮一行放得下 */
.net-card { grid-column: 1 / -1; }
.grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 0 12px; }
.records { display: grid; gap: 8px; max-height: 520px; overflow-y: auto; }
.rec { display: flex; align-items: center; gap: 10px; padding: 9px 12px; border: 1px solid var(--pg-border); border-radius: 10px; }
.rec-name { font-size: 13px; font-weight: 550; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.err { color: #dc2626; font-size: 12px; margin-top: 10px; }
.diag { margin-top: 8px; display: grid; gap: 4px; }
.diag-row { font-size: 11.5px; line-height: 1.6; word-break: break-all; }
.diag-row .mono {
  display: inline-block; min-width: 38px; margin-right: 8px; color: #0f766e;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
@media (max-width: 900px) { .layout { grid-template-columns: 1fr; } }
</style>
