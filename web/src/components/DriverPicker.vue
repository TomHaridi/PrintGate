<template>
  <n-modal
    :show="show" preset="card" title="选择驱动" style="max-width: 720px" :bordered="false"
    @update:show="(v) => emit('update:show', v)"
  >
    <div class="dev-line">
      <div class="grow">
        <div class="dev-name">{{ device?.name || device?.host || '新打印机' }}</div>
        <div class="muted mono dev-uri">{{ device?.uri || '' }}</div>
        <div class="muted dev-model">
          {{ device?.model || '未识别型号' }}
          <template v-if="device?.deviceId"> · {{ device.deviceId }}</template>
        </div>
      </div>
      <n-tag v-if="device?.driverless" size="small" type="success" :bordered="false">支持免驱</n-tag>
    </div>

    <n-tabs v-model:value="tab" type="line" animated>
      <!-- 推荐 -->
      <n-tab-pane name="rec" tab="推荐">
        <n-spin :show="recLoading">
          <div v-if="rec" class="rec-box">
            <div class="rec-head">
              <n-tag :type="confType" size="small" :bordered="false">{{ confText }}</n-tag>
              <span class="rec-label">{{ rec.label }}</span>
            </div>
            <div class="muted rec-reason">{{ rec.reason }}</div>
            <div class="muted rec-source">来源：{{ rec.source }}</div>
            <n-radio-group v-model:value="chosenId" class="rec-list">
              <n-radio v-for="o in recOptions" :key="o.id" :value="o.id" class="rec-opt">
                <span>{{ o.label }}</span>
                <span v-if="o.reason" class="muted opt-reason">{{ o.reason }}</span>
              </n-radio>
            </n-radio-group>
          </div>
          <div v-else class="rec-box">
            <n-empty description="暂无推荐，请从本地或在线驱动库选择" />
          </div>

          <!-- 免驱 PPD 现场生成：专治「IPP Everywhere 建不了队列」 -->
          <div v-if="canGenerate" class="gen-box">
            <div class="gen-title">免驱队列建不起来？</div>
            <div class="muted gen-tip">
              部分打印机（如某些 Canon 机型）固件返回的 IPP 属性不符合规范，导致「IPP Everywhere」无法创建队列。
              点下面的按钮当场向打印机索取一份 PPD 并存为驱动，选它即可正常建队列，彩色/双面等选项都能保留。
            </div>
            <n-button size="small" type="primary" :loading="generating" @click="doGenerate">
              生成免驱 PPD
            </n-button>
            <n-alert v-if="genMsg" :type="genErr ? 'error' : 'success'" :bordered="false" style="margin-top: 10px">
              {{ genMsg }}
            </n-alert>
          </div>
        </n-spin>
      </n-tab-pane>

      <!-- 本地驱动库 -->
      <n-tab-pane name="local" tab="本地驱动库">
        <n-input
          v-model:value="localQuery" size="small" clearable
          placeholder="按型号搜索，例如 HP LaserJet 1022 / Epson L3153"
          @keyup.enter="searchLocal"
        >
          <template #suffix>
            <n-button text size="tiny" @click="searchLocal">搜索</n-button>
          </template>
        </n-input>
        <n-spin :show="localLoading">
          <div class="list">
            <div
              v-for="it in localItems" :key="it.id" class="item" :class="{ on: chosenId === it.id }"
              @click="chosen = { id: it.id, label: it.label || it.short, source: it.kind === 'stored' ? '已导入' : '本地驱动库' }; chosenId = it.id"
            >
              <div class="grow">
                <div class="item-label">
                  {{ it.label || it.short }}
                  <n-tag v-if="it.kind === 'stored'" size="tiny" :bordered="false" type="info">已导入</n-tag>
                </div>
                <div class="muted mono item-id">{{ it.id }}</div>
              </div>
              <n-icon v-if="chosenId === it.id" :component="CheckmarkCircle" color="#0ea5a4" />
            </div>
            <n-empty v-if="!localItems.length && !localLoading" description="没有匹配的驱动" style="padding: 24px 0" />
          </div>
        </n-spin>
      </n-tab-pane>

      <!-- 在线驱动库 -->
      <n-tab-pane name="online" tab="在线驱动库">
        <n-alert type="info" :bordered="false" style="margin-bottom: 12px">
          驱动来自 OpenPrinting 官方 PPD 库（收录有限，部分品牌只有少量机型）。输入型号关键词检索；
          找不到时请用「上传 / 直链」导入厂商提供的 PPD。导入后会自动保存到本机驱动目录。
        </n-alert>
        <div class="row" style="gap: 8px">
          <n-input
            v-model:value="onlineQ" size="small" placeholder="型号关键词，例如 laserjet 1022 / pixma"
            @keyup.enter="searchOnline"
          />
          <n-select
            v-model:value="onlineVendor" size="small" clearable placeholder="厂商（可选）"
            :options="vendorOptions" style="max-width: 170px"
          />
          <n-button size="small" type="primary" :loading="onlineLoading" @click="searchOnline">检索</n-button>
        </div>
        <n-spin :show="onlineLoading">
          <div class="list online-list">
            <div v-for="it in onlineItems" :key="it.url" class="item">
              <div class="grow">
                <div class="item-label">{{ it.name }}</div>
                <div class="muted mono item-id">{{ it.vendor }} · {{ it.file }}</div>
              </div>
              <n-button
                size="tiny" type="primary" ghost :loading="importing === it.url"
                @click="installOnline(it)"
              >{{ chosenId === `ppd:${it.url}` ? '已导入' : '导入' }}</n-button>
            </div>
            <n-empty
              v-if="!onlineItems.length && !onlineLoading && onlineSearched"
              :description="onlineMsg || '没有匹配的驱动：官方镜像收录有限，可改用「上传 / 直链」导入厂商 PPD'"
              style="padding: 24px 0"
            />
          </div>
        </n-spin>
      </n-tab-pane>

      <!-- 上传 / URL -->
      <n-tab-pane name="manual" tab="上传 / 直链">
        <div class="manual">
          <div class="manual-box">
            <div class="manual-title">上传驱动文件</div>
            <div class="muted manual-tip">支持 .ppd、.ppd.gz、.tar.gz、.zip（压缩包内需含 .ppd）</div>
            <n-upload
              :show-file-list="false" :custom-request="onUpload" accept=".ppd,.gz,.tgz,.tar,.zip"
            >
              <n-button size="small" :loading="uploading">选择文件</n-button>
            </n-upload>
          </div>
          <div class="manual-box">
            <div class="manual-title">按 URL 下载</div>
            <div class="muted manual-tip">填入厂商或 OpenPrinting 提供的 PPD 直链</div>
            <div class="row" style="gap: 8px">
              <n-input v-model:value="dlUrl" size="small" placeholder="https://.../printer.ppd" />
              <n-button size="small" :loading="downloading" @click="doDownload">下载</n-button>
            </div>
          </div>
        </div>
        <n-alert v-if="manualMsg" :type="manualErr ? 'error' : 'success'" :bordered="false" style="margin-top: 12px">
          {{ manualMsg }}
        </n-alert>
      </n-tab-pane>
    </n-tabs>

    <template #footer>
      <div class="foot">
        <div class="muted grow chosen-text">
          当前选择：<b>{{ chosenLabel || '未选择' }}</b>
        </div>
        <n-button size="small" @click="emit('update:show', false)">取消</n-button>
        <n-button size="small" type="primary" :disabled="!chosenId" @click="confirm">使用此驱动</n-button>
      </div>
    </template>
  </n-modal>
</template>

<script setup>
import { computed, ref, watch } from 'vue';
import { useMessage } from 'naive-ui';
import { CheckmarkCircle } from '@vicons/ionicons5';
import { api } from '../api';

const props = defineProps({
  show: { type: Boolean, default: false },
  device: { type: Object, default: () => ({}) }
});
const emit = defineEmits(['update:show', 'picked']);
const message = useMessage();

const tab = ref('rec');
const recLoading = ref(false);
const rec = ref(null);
const chosenId = ref('');
const chosen = ref(null);

const localQuery = ref('');
const localItems = ref([]);
const localLoading = ref(false);

const onlineQ = ref('');
const onlineVendor = ref(null);
const vendors = ref([]);
const onlineItems = ref([]);
const onlineLoading = ref(false);
const onlineSearched = ref(false);
const onlineMsg = ref('');
const importing = ref('');

const dlUrl = ref('');
const downloading = ref(false);
const uploading = ref(false);
const manualMsg = ref('');
const manualErr = ref(false);

// 免驱 PPD 现场生成：只有 IPP 类地址能做（driverless 需要 IPP）
const canGenerate = computed(() => /^(ipp|ipps|dnssd):\/\//i.test(String(props.device?.uri || '')));
const generating = ref(false);
const genMsg = ref('');
const genErr = ref(false);

async function doGenerate() {
  generating.value = true;
  genMsg.value = '';
  genErr.value = false;
  try {
    const r = await api.post('/drivers/generate', {
      uri: props.device?.uri || '',
      label: props.device?.model || ''
    });
    genMsg.value = r.msg || '已生成';
    genErr.value = false;
    // 生成成功后直接选中它，用户点「使用此驱动」即可
    if (r.driver) {
      chosenId.value = r.driver.id;
      chosen.value = { id: r.driver.id, label: r.driver.label };
      message.success('已生成并选中，点「使用此驱动」即可');
    }
    await searchLocal();
  } catch (e) {
    genMsg.value = e.message;
    genErr.value = true;
  } finally {
    generating.value = false;
  }
}

const confText = computed(() => ({ high: '高置信度', medium: '较可信', low: '推测' }[rec.value?.confidence] || '推荐'));
const confType = computed(() => ({ high: 'success', medium: 'info', low: 'warning' }[rec.value?.confidence] || 'default'));
const recOptions = computed(() => {
  if (!rec.value) return [];
  return [{ id: rec.value.id, label: rec.value.label, reason: rec.value.reason }, ...(rec.value.alternatives || [])];
});
const chosenLabel = computed(() => chosen.value?.label || '');
const vendorOptions = computed(() => vendors.value.map((v) => ({ label: v, value: v })));

watch(() => props.show, async (v) => {
  if (!v) return;
  tab.value = 'rec';
  rec.value = null;
  chosenId.value = '';
  chosen.value = null;
  localQuery.value = props.device?.model || '';
  localItems.value = [];
  onlineItems.value = [];
  onlineSearched.value = false;
  onlineMsg.value = '';
  manualMsg.value = '';
  dlUrl.value = '';
  await loadRec();
  searchLocal();
  loadVendors();
});

async function loadRec() {
  recLoading.value = true;
  try {
    const d = await api.post('/drivers/recommend', {
      uri: props.device?.uri || '',
      kind: props.device?.kind || '',
      model: props.device?.model || '',
      deviceId: props.device?.deviceId || '',
      formats: props.device?.formats || [],
      driverless: !!props.device?.driverless
    });
    rec.value = d;
    chosenId.value = d.id;
    chosen.value = { id: d.id, label: d.label, source: d.source };
  } catch (e) {
    message.error(e.message);
  } finally {
    recLoading.value = false;
  }
}

async function searchLocal() {
  localLoading.value = true;
  try {
    const d = await api.get(`/drivers?q=${encodeURIComponent(localQuery.value || '')}`);
    localItems.value = d.items || [];
  } catch (e) {
    message.error(e.message);
  } finally {
    localLoading.value = false;
  }
}

async function loadVendors() {
  if (vendors.value.length) return;
  try {
    const d = await api.get('/drivers/online/vendors');
    vendors.value = d.vendors || [];
  } catch (_) { /* 无外网时静默 */ }
}

async function searchOnline() {
  if (!String(onlineQ.value || '').trim() && !onlineVendor.value) {
    message.warning('请输入型号关键词，或选择一个厂商浏览全部机型');
    return;
  }
  onlineLoading.value = true;
  onlineSearched.value = true;
  onlineMsg.value = '';
  try {
    const q = new URLSearchParams({ q: onlineQ.value });
    if (onlineVendor.value) q.set('vendor', onlineVendor.value);
    const d = await api.get(`/drivers/online/search?${q.toString()}`);
    onlineItems.value = d.items || [];
    if (!onlineItems.value.length) onlineMsg.value = `已检索 ${d.vendors} 个厂商、${d.total} 个 PPD，没有匹配项`;
  } catch (e) {
    onlineItems.value = [];
    onlineMsg.value = e.message;
  } finally {
    onlineLoading.value = false;
  }
}

async function installOnline(it) {
  importing.value = it.url;
  try {
    const d = await api.post('/drivers/online/install', { url: it.url, name: it.name });
    chosenId.value = d.driver.id;
    chosen.value = { id: d.driver.id, label: d.driver.label, source: '在线下载' };
    message.success(d.msg || '驱动已导入');
  } catch (e) {
    message.error(e.message);
  } finally {
    importing.value = '';
  }
}

function onUpload({ file, onFinish, onError }) {
  uploading.value = true;
  manualMsg.value = '';
  const fd = new FormData();
  fd.append('file', file.file);
  api.post('/drivers/upload', fd)
    .then((d) => {
      chosenId.value = d.driver.id;
      chosen.value = { id: d.driver.id, label: d.driver.label, source: '手动上传' };
      manualErr.value = false;
      manualMsg.value = d.msg || '驱动已导入';
      onFinish();
    })
    .catch((e) => {
      manualErr.value = true;
      manualMsg.value = e.message;
      onError();
    })
    .finally(() => { uploading.value = false; });
}

async function doDownload() {
  if (!/^https?:\/\//i.test(dlUrl.value || '')) { message.warning('请填写 http(s) 开头的直链'); return; }
  downloading.value = true;
  manualMsg.value = '';
  try {
    const d = await api.post('/drivers/download', { url: dlUrl.value });
    chosenId.value = d.driver.id;
    chosen.value = { id: d.driver.id, label: d.driver.label, source: 'URL 下载' };
    manualErr.value = false;
    manualMsg.value = d.msg || '驱动已下载';
  } catch (e) {
    manualErr.value = true;
    manualMsg.value = e.message;
  } finally {
    downloading.value = false;
  }
}

function confirm() {
  if (!chosenId.value) return;
  emit('picked', {
    id: chosenId.value,
    label: chosen.value?.label || chosenId.value,
    source: chosen.value?.source || ''
  });
  emit('update:show', false);
}
</script>

<style scoped>
.dev-line { display: flex; align-items: flex-start; gap: 12px; margin-bottom: 12px; }
.dev-name { font-weight: 600; font-size: 15px; }
.dev-uri { font-size: 12px; margin-top: 2px; word-break: break-all; }
.dev-model { font-size: 12px; margin-top: 2px; }
.rec-box { padding: 4px 0; }.rec-head { display: flex; align-items: center; gap: 8px; }
.rec-label { font-weight: 600; }
.rec-reason { margin-top: 8px; font-size: 13px; }
.rec-source { font-size: 12px; margin-top: 4px; }
.rec-list { display: flex; flex-direction: column; gap: 8px; margin-top: 14px; }
.rec-opt { align-items: flex-start; }
.opt-reason { margin-left: 8px; font-size: 12px; }
.list { max-height: 300px; overflow: auto; margin-top: 10px; }
.item { display: flex; align-items: center; gap: 10px; padding: 8px 10px; border-radius: 8px; cursor: pointer; border: 1px solid transparent; }
.item:hover { background: rgba(14, 165, 164, 0.06); }
.item.on { border-color: rgba(14, 165, 164, 0.45); background: rgba(14, 165, 164, 0.07); }
.item-label { font-size: 13px; display: flex; align-items: center; gap: 6px; }
.item-id { font-size: 11px; word-break: break-all; }
.online-list .item { cursor: default; }
.manual { display: flex; flex-direction: column; gap: 14px; }
.manual-box { border: 1px solid rgba(148, 163, 184, 0.28); border-radius: 10px; padding: 14px; }
.manual-title { font-weight: 600; font-size: 13px; margin-bottom: 4px; }
.manual-tip { font-size: 12px; margin-bottom: 10px; }
.gen-box { margin-top: 16px; border: 1px dashed rgba(14, 165, 164, 0.5); border-radius: 10px; padding: 14px; background: rgba(14, 165, 164, 0.04); }
.gen-title { font-weight: 600; font-size: 13px; margin-bottom: 6px; }
.gen-tip { font-size: 12px; margin-bottom: 10px; line-height: 1.6; }
.foot { display: flex; align-items: center; gap: 10px; }
.chosen-text { font-size: 12px; }
</style>
