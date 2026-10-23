<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h1 class="page-title">打印机</h1>
        <div class="page-desc">CUPS 队列管理 · 自动发现局域网内 AirPrint / IPP / RAW 打印机</div>
      </div>
      <div class="row wrap">
        <n-button size="small" :loading="loading" @click="load">
          <template #icon><n-icon :component="RefreshOutline" /></template>刷新
        </n-button>
        <n-button size="small" @click="openAdd()">
          <template #icon><n-icon :component="AddOutline" /></template>手动添加
        </n-button>
        <n-button size="small" @click="createVirtual">
          <template #icon><n-icon :component="DesktopOutline" /></template>创建虚拟打印机
        </n-button>
        <n-button size="small" @click="openHistory">
          <template #icon><n-icon :component="TrashOutline" /></template>历史清理
        </n-button>
        <n-button size="small" type="primary" @click="openDiscover">
          <template #icon><n-icon :component="ScanOutline" /></template>自动扫描打印机
        </n-button>
      </div>
    </div>

    <n-alert v-if="!cups.running" type="warning" :bordered="false" style="margin-bottom: 16px">
      CUPS 服务未就绪：{{ cups.message }}。容器启动需要几秒钟，稍后刷新即可；若持续异常请到「系统状态」查看。
    </n-alert>

    <n-spin :show="loading">
      <div v-if="printers.length" class="cards">
        <div v-for="p in printers" :key="p.name" class="pcard" :class="{ off: p.state === 'stopped' }">
          <div class="pcard-head">
            <div class="pcard-icon"><n-icon :component="PrintOutline" /></div>
            <div class="grow">
              <div class="pname">
                {{ p.name }}
                <n-tag v-if="p.isDefault" size="tiny" type="primary" :bordered="false">默认</n-tag>
              </div>
              <div class="muted mono puri">{{ p.uri || '未绑定设备地址' }}</div>
            </div>
            <n-tag size="small" :type="stateType(p.state)" :bordered="false">{{ stateText(p.state) }}</n-tag>
          </div>
          <div class="pmeta">
            <span><b>{{ p.queueJobs }}</b> 个队列任务</span>
            <span v-if="p.location">· {{ p.location }}</span>
            <span v-if="p.note" class="muted">· {{ p.note }}</span>
          </div>
          <div class="pcard-actions">
            <n-button size="tiny" secondary @click="testPage(p)">测试页</n-button>
            <n-button size="tiny" secondary :disabled="p.isDefault" @click="setDefault(p)">设为默认</n-button>
            <n-button size="tiny" secondary @click="togglePause(p)">{{ p.enabled ? '暂停' : '恢复' }}</n-button>
            <n-dropdown :options="moreOptions(p)" trigger="click" @select="(k) => onMore(k, p)">
              <n-button size="tiny" quaternary>
                <template #icon><n-icon :component="EllipsisHorizontalOutline" /></template>
              </n-button>
            </n-dropdown>
          </div>
        </div>
      </div>
      <n-empty v-else description="还没有添加打印机" style="padding: 60px 0">
        <template #extra>
          <n-button size="small" type="primary" @click="openDiscover">自动扫描打印机</n-button>
        </template>
      </n-empty>
    </n-spin>

    <!-- 自动扫描抽屉 -->
    <n-drawer v-model:show="discoverShow" :width="drawerWidth" placement="right">
      <n-drawer-content title="自动扫描打印机" closable>
        <div class="disc-top">
          <div class="disc-label">扫描范围</div>
          <div class="row" style="gap: 8px">
            <n-input
              v-model:value="cidr" size="small" style="flex: 1"
              placeholder="局域网网段，例如 192.168.1.0/24（多个用逗号分隔）"
              @blur="saveCidr"
            >
              <template #prefix><n-icon :component="GlobeOutline" /></template>
            </n-input>
            <n-select
              v-model:value="cidr" size="small" style="max-width: 168px" :options="cidrOptions"
              placeholder="常用网段" @update:value="saveCidr"
            />
          </div>
          <div v-if="containerOnly" class="disc-warn">
            当前容器运行在 <b>桥接网络</b>，只能看到 Docker 内网（{{ detectedCidr }}），收不到局域网的 mDNS 广播。
            请在上面填写路由器网段（如 192.168.1.0/24），或直接用下面的「手动探测」输入打印机 IP。
          </div>

          <div class="row" style="margin-top: 10px">
            <n-radio-group v-model:value="mode" size="small">
              <n-radio-button value="quick">快速扫描</n-radio-button>
              <n-radio-button value="deep">深度扫描</n-radio-button>
            </n-radio-group>
            <span class="muted" style="font-size: 12px">
              {{ mode === 'quick' ? '探测 631 / 9100' : '额外探测 443(IPPS) / 515(LPD)' }}
            </span>
          </div>
          <div class="row" style="margin-top: 10px">
            <n-button type="primary" size="small" :loading="scanning" @click="startScan">
              {{ scanning ? '扫描中…' : '开始扫描' }}
            </n-button>
            <span class="muted">{{ stageText }}</span>
          </div>
          <n-progress
            v-if="scanning" type="line" :percentage="progress" :show-indicator="false"
            :height="4" style="margin-top: 10px"
          />
          <div class="disc-label" style="margin-top: 16px">手动探测（扫描不到时用）</div>
          <div class="row" style="gap: 8px">
            <n-input
              v-model:value="probeHost" size="small" style="flex: 1" placeholder="打印机 IP 或主机名，例如 192.168.1.50"
              @keyup.enter="doProbe"
            >
              <template #prefix><n-icon :component="SearchOutline" /></template>
            </n-input>
            <n-button size="small" :loading="probing" @click="doProbe">识别并添加</n-button>
          </div>
          <div class="muted" style="margin-top: 8px; font-size: 12px; line-height: 1.7">
            扫描会对网段内的 631(IPP)、9100(RAW) 等端口做并发探测，并对 631/443 做真实 IPP 握手，
            自动识别型号与资源路径。只开 443(IPPS) 或 515(LPD) 的机器请用「深度扫描」。
          </div>
        </div>

        <n-divider style="margin: 14px 0" />

        <div v-if="found.length" class="found-list">
          <div class="row" style="justify-content: space-between; margin-bottom: 8px">
            <span class="muted">共 {{ found.length }} 台，其中 {{ newCount }} 台未添加</span>
            <n-button v-if="newCount" size="tiny" type="primary" ghost @click="openFound">批量添加…</n-button>
          </div>
          <div v-for="(f, i) in found" :key="i" class="found" :class="{ added: f.added }">
            <div class="grow" style="min-width: 0">
              <div class="fname">
                {{ f.name || f.host }}
                <n-tag size="tiny" :bordered="false" type="info">{{ f.source }}</n-tag>
                <n-tag v-if="f.driverless" size="tiny" :bordered="false" type="success">免驱</n-tag>
                <n-tag v-if="f.pathConfidence === 'guess'" size="tiny" :bordered="false" type="warning">路径待确认</n-tag>
              </div>
              <div class="muted mono furi">{{ f.uri }}</div>
              <div class="muted fmodel">
                {{ f.model || '未知型号' }}
                <template v-if="f.deviceId"> · {{ f.deviceId }}</template>
              </div>
            </div>
            <n-button v-if="f.added" size="tiny" disabled>已添加</n-button>
            <n-button v-else size="tiny" type="primary" @click="openAdd(f)">添加</n-button>
          </div>
        </div>
        <n-empty
          v-else-if="!scanning"
          :description="scanDone ? '未发现可用打印机：请确认设备已开机、与容器同网段，或改用「深度扫描」指定网段' : '点击「开始扫描」搜索附近打印机'"
          style="padding: 40px 0"
        />
        <n-spin v-else show style="padding: 40px 0; display: block" />
      </n-drawer-content>
    </n-drawer>

    <!-- 添加打印机 -->
    <n-modal v-model:show="addShow" preset="card" title="添加打印机" style="max-width: 620px" :bordered="false">
      <n-form label-placement="top" :model="form">
        <div class="grid2">
          <n-form-item label="队列名称（仅字母数字 _ . -）">
            <n-input v-model:value="form.name" placeholder="例如 Office-MF650C" />
          </n-form-item>
          <n-form-item label="驱动 / 型号">
            <div class="row" style="gap: 8px; width: 100%">
              <n-select
                v-model:value="form.model" filterable clearable :options="modelOptions" style="flex: 1"
                placeholder="默认按设备地址自动选择驱动" @update:value="onModelChange"
              />
              <n-button size="small" @click="openDriverPicker">驱动库…</n-button>
            </div>
            <template v-if="form.driverLabel" #feedback>
              <span class="muted" style="font-size: 12px">已选：{{ form.driverLabel }}（{{ form.driverSource }}）</span>
            </template>
          </n-form-item>
        </div>
        <n-form-item label="设备地址 URI">
          <n-input
            v-model:value="form.uri"
            placeholder="ipp://192.168.1.50:631/ipp/print 或 socket://192.168.1.50:9100"
            @update:value="syncModelWithUri"
          />
        </n-form-item>
        <div class="grid2">
          <n-form-item label="位置（可选）">
            <n-input v-model:value="form.location" placeholder="三楼财务室" />
          </n-form-item>
          <n-form-item label="描述（可选）">
            <n-input v-model:value="form.info" placeholder="Canon MF650C" />
          </n-form-item>
        </div>
        <n-form-item label="共享给局域网设备（AirPrint 可见）">
          <n-switch v-model:value="form.shared" />
        </n-form-item>
        <n-alert type="info" :bordered="false" style="margin-bottom: 8px">
          网络打印建议使用 <span class="mono">ipp://IP/ipp/print</span> 并选择 <span class="mono">everywhere</span> 免驱模式；
          RAW 端口使用 <span class="mono">socket://IP:9100</span>，需配合具体型号驱动。
        </n-alert>
      </n-form>
      <template #footer>
        <div class="row" style="justify-content: flex-end">
          <n-button @click="addShow = false">取消</n-button>
          <n-button type="primary" :loading="adding" @click="submitAdd">添加并启用</n-button>
        </div>
      </template>
    </n-modal>

    <!-- 历史清理 -->
    <n-modal v-model:show="histShow" preset="card" title="历史清理" style="max-width: 680px" :bordered="false">
      <n-alert type="info" :bordered="false" style="margin-bottom: 14px">
        只清理历史记录与落盘文件，<b>不会影响正在打印、待审批的任务</b>；被未完成任务引用的源文件会自动跳过。
      </n-alert>

      <n-spin :show="histLoading">
        <div v-if="hist" class="hist-grid">
          <div class="hist-cell">
            <div class="hist-k">任务记录</div>
            <div class="hist-v">{{ hist.tasks.finished }} <span class="muted">/ {{ hist.tasks.total }} 条</span></div>
            <div class="muted hist-sub">已完成 / 全部（进行中 {{ hist.tasks.active }} 条保留）</div>
          </div>
          <div class="hist-cell">
            <div class="hist-k">CUPS 已完成作业</div>
            <div class="hist-v">{{ hist.cups.completed }}</div>
            <div class="muted hist-sub">lpstat 历史，清理后队列更清爽</div>
          </div>
          <div class="hist-cell">
            <div class="hist-k">虚拟打印机落盘</div>
            <div class="hist-v">{{ hist.spool.count }}</div>
            <div class="muted hist-sub">{{ fmtBytes(hist.spool.bytes) }}</div>
          </div>
          <div class="hist-cell">
            <div class="hist-k">源文件</div>
            <div class="hist-v">{{ hist.files.count }}</div>
            <div class="muted hist-sub">{{ fmtBytes(hist.files.bytes) }} · 扫描件 {{ hist.scans.count }}（{{ fmtBytes(hist.scans.bytes) }}）</div>
          </div>
        </div>
        <div v-if="hist?.lastCleanup" class="muted" style="font-size: 12px; margin-top: 10px">
          上次清理：{{ fmtTime(hist.lastCleanup.at) }} · {{ hist.lastCleanup.detail }}
        </div>
      </n-spin>

      <n-divider style="margin: 16px 0" />

      <div class="grid2">
        <n-form-item label="保留最近的历史">
          <n-select v-model:value="histDays" size="small" :options="dayOptions" />
        </n-form-item>
        <n-form-item label="清理范围">
          <n-checkbox-group v-model:value="histTargets" size="small">
            <div class="row wrap" style="gap: 4px 12px">
              <n-checkbox value="tasks">任务记录</n-checkbox>
              <n-checkbox value="cups">CUPS 作业</n-checkbox>
              <n-checkbox value="spool">落盘文件</n-checkbox>
              <n-checkbox value="files">源文件</n-checkbox>
              <n-checkbox value="scans">扫描记录</n-checkbox>
            </div>
          </n-checkbox-group>
        </n-form-item>
      </div>

      <div class="row" style="margin-top: 6px">
        <n-button type="primary" :loading="cleaning" :disabled="!histTargets.length" @click="runClean">
          立即清理
        </n-button>
        <span class="muted" style="font-size: 12px">
          {{ histDays === 0 ? '将清除全部已完成历史（不可撤销）' : `保留最近 ${histDays} 天，清理更早的记录` }}
        </span>
      </div>

      <n-divider style="margin: 16px 0" />

      <div class="auto-box">
        <div class="grow">
          <div class="auto-title">自动清理</div>
          <div class="muted auto-sub">
            每小时检查一次：删除超过保留天数的已完成任务、CUPS 作业与落盘文件，释放磁盘且不掉历史统计口径。
          </div>
        </div>
        <n-switch :value="autoClean" :loading="autoSaving" @update:value="saveAuto" />
      </div>
      <div v-if="autoClean" class="row" style="margin-top: 10px; gap: 8px">
        <span class="muted" style="font-size: 12.5px">自动保留最近</span>
        <n-input-number v-model:value="autoDays" size="tiny" :min="0" :max="3650" style="width: 110px" />
        <span class="muted" style="font-size: 12.5px">天</span>
        <n-button size="tiny" quaternary :loading="autoSaving" @click="saveAuto()">保存</n-button>
      </div>

      <template #footer>
        <div class="row" style="justify-content: flex-end">
          <n-button size="small" @click="histShow = false">关闭</n-button>
        </div>
      </template>
    </n-modal>

    <!-- 扫描完成后：是否自动安装驱动 -->
    <FoundPrinters v-model:show="foundShow" :devices="found" @done="onFoundDone" />

    <!-- 驱动选择（推荐 / 本地 / 在线 / 上传） -->
    <DriverPicker v-model:show="driverShow" :device="driverDevice" @picked="onDriverPicked" />
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue';
import { useMessage, useDialog } from 'naive-ui';
import {
  PrintOutline, ScanOutline, AddOutline, RefreshOutline, EllipsisHorizontalOutline, DesktopOutline,
  GlobeOutline, SearchOutline, TrashOutline
} from '@vicons/ionicons5';
import { api, fmtBytes, fmtTime } from '../api';
import FoundPrinters from '../components/FoundPrinters.vue';
import DriverPicker from '../components/DriverPicker.vue';

const message = useMessage();
const dialog = useDialog();

const loading = ref(false);
const printers = ref([]);
const cups = ref({ running: false, message: '' });

const discoverShow = ref(false);
const mode = ref('quick');
const cidr = ref('');
const subnets = ref([]);
const commonCidrs = ref([]);
const savedCidr = ref('');
const scanning = ref(false);
const scanDone = ref(false);
const progress = ref(0);
const stageText = ref('');
const found = ref([]);
const foundShow = ref(false);
const probeHost = ref('');
const probing = ref(false);
let pollTimer = null;

const histShow = ref(false);
const hist = ref(null);
const histLoading = ref(false);
const cleaning = ref(false);
const histDays = ref(0);
const histTargets = ref(['tasks', 'cups', 'spool', 'files', 'scans']);
const autoClean = ref(true);
const autoDays = ref(30);
const autoSaving = ref(false);
const dayOptions = [
  { label: '全部历史（0 天）', value: 0 },
  { label: '保留最近 1 天', value: 1 },
  { label: '保留最近 3 天', value: 3 },
  { label: '保留最近 7 天', value: 7 },
  { label: '保留最近 30 天', value: 30 },
  { label: '保留最近 90 天', value: 90 }
];

const addShow = ref(false);
const adding = ref(false);
const form = reactive({
  name: '', uri: '', model: 'everywhere', location: '', info: '', shared: true,
  driverLabel: '', driverSource: '', deviceId: '', formats: [], driverless: false
});
const driverShow = ref(false);
const driverDevice = ref({});

const models = ref([]);
const modelOptions = computed(() => {
  const base = [
    { label: 'everywhere（免驱 IPP/AirPrint，仅适用于 ipp:// 设备）', value: 'everywhere' },
    { label: 'raw（RAW/PCL 直通，适用于 socket:// 设备）', value: 'raw' },
    ...models.value.filter((m) => m.id !== 'everywhere' && m.id !== 'raw')
      .map((m) => ({ label: m.label || m.id, value: m.id }))
  ];
  // 从驱动库选中的 PPD 不在 lpinfo 列表里，补一条显示项，否则下拉框会显示成裸路径
  if (form.model && !base.some((o) => o.value === form.model)) {
    base.unshift({ label: `已导入驱动：${form.driverLabel || form.model}`, value: form.model });
  }
  return base;
});
const newCount = computed(() => found.value.filter((f) => !f.added).length);
const subnetOptions = computed(() => subnets.value.map((s) => ({
  label: `${s.cidr}${s.container ? '（Docker 内网）' : ''}（${s.iface} ${s.address}）`, value: s.cidr
})));
const cidrOptions = computed(() => {
  const opts = [...subnetOptions.value];
  for (const c of commonCidrs.value) if (!opts.some((o) => o.value === c)) opts.push({ label: `${c}（常用）`, value: c });
  return opts;
});
// 只有 Docker 内网时提示用户手动填局域网网段（桥接网络收不到局域网 mDNS）
const containerOnly = computed(() => subnets.value.length > 0 && subnets.value.every((s) => s.container));
const detectedCidr = computed(() => (subnets.value[0] ? subnets.value[0].cidr : '—'));
const viewportWidth = ref(window.innerWidth);
const onResize = () => { viewportWidth.value = window.innerWidth; };
const drawerWidth = computed(() => (viewportWidth.value < 720 ? '100%' : 520));

const stateText = (s) => ({ idle: '空闲', printing: '打印中', stopped: '已停用' })[s] || s;
const stateType = (s) => ({ idle: 'success', printing: 'info', stopped: 'error' })[s] || 'default';

async function load() {
  loading.value = true;
  try {
    const d = await api.get('/printers');
    printers.value = d.printers || [];
    cups.value = d.cups || { running: false, message: '' };
  } catch (e) {
    message.error(e.message);
  } finally {
    loading.value = false;
  }
}

async function loadModels(q = '') {
  try {
    const d = await api.get(`/printers/models?q=${encodeURIComponent(q)}`);
    models.value = d.models || [];
  } catch (_) {}
}

// URI 变化时自动选一个匹配的驱动，避免 everywhere 配 socket:// 直接失败
function syncModelWithUri(uri) {
  const v = String(uri || '');
  if (/^(ipp|ipps|dnssd):\/\//i.test(v) && (form.model === 'raw' || !form.model)) form.model = 'everywhere';
  else if (/^(socket|lpd|usb|smb|http|https):\/\//i.test(v) && (form.model === 'everywhere' || !form.model)) form.model = 'raw';
}

function onModelChange(v) {
  if (!form.name && v && v !== 'everywhere') {
    form.name = String(v).split('/').pop().replace(/\.ppd$/i, '').replace(/[^A-Za-z0-9_.-]/g, '-').slice(0, 40);
  }
}

async function openAdd(item) {
  addShow.value = true;
  form.name = '';
  form.uri = item?.uri || '';
  form.location = '';
  form.info = '';
  form.model = 'everywhere';
  form.shared = true;
  form.driverLabel = '';
  form.driverSource = '';
  form.deviceId = '';
  form.formats = [];
  form.driverless = false;
  if (item) {
    const host = String(item.host || '');
    const octet = (host.match(/^\d+\.\d+\.\d+\.(\d+)$/) || [])[1] || '';
    const generic = /打印服务|未知|CUPS \/ IPP/.test(item.model || '');
    const guess = (generic ? (item.kind === 'socket' ? 'raw' : 'ipp') : (item.model || item.name || host))
      .replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24).toLowerCase();
    form.name = `${guess || 'printer'}${octet ? '-' + octet : ''}`.slice(0, 40);
    form.info = (item.model || '').slice(0, 60);
    form.deviceId = item.deviceId || '';
    form.formats = item.formats || [];
    form.driverless = !!item.driverless;
    // 直接用扫描到的设备信息拿推荐驱动，省掉用户手选
    try {
      const d = await api.post('/drivers/recommend', {
        uri: item.uri, kind: item.kind, model: item.model, deviceId: item.deviceId,
        formats: item.formats || [], driverless: !!item.driverless
      });
      form.model = d.id;
      form.driverLabel = d.label;
      form.driverSource = d.source;
    } catch (_) {
      form.model = /^(ipp|ipps):/i.test(item.uri) ? 'everywhere' : 'raw';
    }
  }
  loadModels('');
}

function openDriverPicker() {
  driverDevice.value = {
    name: form.name || form.uri, uri: form.uri, info: form.info,
    model: form.info, kind: /^(ipp|ipps):/i.test(form.uri) ? 'ipp' : 'socket'
  };
  driverShow.value = true;
}

function onDriverPicked(d) {
  form.model = d.id;
  form.driverLabel = d.label;
  form.driverSource = d.source || '驱动库';
}

async function onFoundDone() {
  await load();
  // 刷新「已添加」标记，避免刚加完的打印机还显示「添加」按钮
  refreshFoundFlag();
}

function openFound() {
  if (!newCount.value) { message.info('没有新设备可添加'); return; }
  foundShow.value = true;
}

async function saveCidr() {
  const v = String(cidr.value || '').trim();
  if (!v) return;
  try {
    const d = await api.post('/printers/discover/cidr', { cidr: v });
    cidr.value = d.cidr;
    savedCidr.value = d.cidr;
  } catch (e) {
    message.warning(e.message);
  }
}

async function doProbe() {
  const host = String(probeHost.value || '').trim();
  if (!host) { message.warning('请输入打印机 IP 或主机名'); return; }
  probing.value = true;
  try {
    const d = await api.post('/printers/discover/probe', { host });
    const dev = d.device;
    const exists = found.value.find((f) => f.host === dev.host);
    if (exists) Object.assign(exists, dev, { added: exists.added });
    else found.value = [dev, ...found.value];
    message.success(`已识别 ${dev.model || dev.name}（${dev.uri}）`);
    foundShow.value = true;
  } catch (e) {
    message.error(e.message);
  } finally {
    probing.value = false;
  }
}

async function submitAdd() {
  if (!form.name || !form.uri) { message.warning('请填写队列名称与设备地址'); return; }
  adding.value = true;
  try {
    const d = await api.post('/printers', {
      name: form.name, uri: form.uri, model: form.model, info: form.info,
      location: form.location, shared: form.shared,
      deviceId: form.deviceId, formats: form.formats, driverless: form.driverless
    });
    message.success(d.msg || '已添加');
    addShow.value = false;
    await load();
    if (discoverShow.value) refreshFoundFlag();
  } catch (e) {
    message.error(e.message);
  } finally {
    adding.value = false;
  }
}

async function openDiscover() {
  discoverShow.value = true;
  if (!subnets.value.length) {
    try {
      const d = await api.get('/printers/discover/subnets');
      subnets.value = d.subnets || [];
      commonCidrs.value = d.commonCidrs || [];
      savedCidr.value = d.savedCidr || '';
      if (d.savedCidr) cidr.value = d.savedCidr;
      else if (subnets.value[0]) cidr.value = subnets.value[0].cidr;
    } catch (_) {}
  }
  // 已保存过网段才自动扫（首次打开让用户先确认范围，避免拿 Docker 内网白扫一遍）
  if (!found.value.length && savedCidr.value) startScan();
}

async function startScan() {
  if (scanning.value) return;
  await saveCidr();
  scanning.value = true;
  scanDone.value = false;
  progress.value = 3;
  stageText.value = '正在启动扫描…';
  found.value = [];
  try {
    const d = await api.post('/printers/discover/start', { mode: mode.value, cidr: cidr.value });
    if (d.localSubnets?.length) subnets.value = d.localSubnets;
    if (d.commonCidrs?.length) commonCidrs.value = d.commonCidrs;
    clearInterval(pollTimer);
    pollTimer = setInterval(() => pollScan(d.id), 900);
  } catch (e) {
    scanning.value = false;
    message.error(e.message);
  }
}

async function pollScan(id) {
  try {
    const d = await api.get(`/printers/discover/${id}`);
    progress.value = d.progress || 0;
    stageText.value = d.stage || '';
    found.value = d.found || [];
    if (d.status !== 'running') {
      scanning.value = false;
      scanDone.value = true;
      clearInterval(pollTimer);
      if (d.status === 'done') {
        message.success(d.stage || '扫描完成');
        // 发现新设备就直接弹「是否自动安装驱动」
        if (newCount.value) foundShow.value = true;
      } else {
        message.error(d.error || '扫描失败');
      }
    }
  } catch (e) {
    scanning.value = false;
    clearInterval(pollTimer);
  }
}

function refreshFoundFlag() {
  const uris = new Set(printers.value.map((p) => p.uri));
  found.value = found.value.map((f) => ({ ...f, added: uris.has(f.uri) }));
}

async function openHistory() {
  histShow.value = true;
  await loadHistory();
}

async function loadHistory() {
  histLoading.value = true;
  try {
    const d = await api.get('/printers/history');
    hist.value = d.stats;
    autoClean.value = !!d.settings?.autoCleanHistory;
    autoDays.value = Number(d.settings?.historyDays ?? 30);
    histDays.value = 0;
  } catch (e) {
    message.error(e.message);
  } finally {
    histLoading.value = false;
  }
}

async function runClean() {
  if (!histTargets.value.length) return;
  cleaning.value = true;
  try {
    const d = await api.post('/printers/history/clean', { days: histDays.value, targets: histTargets.value });
    message.success(d.msg || '清理完成');
    await loadHistory();
    await load();
  } catch (e) {
    message.error(e.message);
  } finally {
    cleaning.value = false;
  }
}

async function saveAuto(v) {
  autoSaving.value = true;
  const next = typeof v === 'boolean' ? v : autoClean.value;
  try {
    const d = await api.put('/printers/history/auto', { autoCleanHistory: next, historyDays: autoDays.value });
    autoClean.value = !!d.settings?.autoCleanHistory;
    autoDays.value = Number(d.settings?.historyDays ?? autoDays.value);
    message.success(d.msg || '已保存');
    if (autoClean.value) await loadHistory();
  } catch (e) {
    message.error(e.message);
  } finally {
    autoSaving.value = false;
  }
}

async function createVirtual() {
  try {
    const d = await api.post('/printers/virtual', {});
    message.success(d.msg || '虚拟打印机已就绪');
    await load();
  } catch (e) { message.error(e.message); }
}

async function testPage(p) {
  try {
    const d = await api.post(`/printers/${encodeURIComponent(p.name)}/test`);
    message.success(d.msg || '测试页已发送');
  } catch (e) { message.error(e.message); }
}

async function setDefault(p) {
  try {
    const d = await api.post(`/printers/${encodeURIComponent(p.name)}/default`);
    message.success(d.msg);
    load();
  } catch (e) { message.error(e.message); }
}

async function togglePause(p) {
  try {
    const action = p.enabled ? 'pause' : 'resume';
    const d = await api.post(`/printers/${encodeURIComponent(p.name)}/${action}`);
    message.success(d.msg);
    load();
  } catch (e) { message.error(e.message); }
}

function moreOptions(p) {
  return [
    { label: p.accepting ? '停止接收新任务' : '恢复接收任务', key: 'accept' },
    { label: '查看队列任务', key: 'jobs' },
    { label: '查看驱动选项', key: 'options' },
    { type: 'divider', key: 'd' },
    { label: '删除打印机', key: 'delete' }
  ];
}

async function onMore(key, p) {
  if (key === 'accept') {
    try {
      const action = p.accepting ? 'reject' : 'accept';
      const d = await api.post(`/printers/${encodeURIComponent(p.name)}/${action}`);
      message.success(d.msg);
      load();
    } catch (e) { message.error(e.message); }
  } else if (key === 'jobs') {
    window.location.hash = '#/jobs';
  } else if (key === 'options') {
    try {
      const d = await api.get(`/printers/${encodeURIComponent(p.name)}/options`);
      const keys = Object.keys(d.options || {});
      dialog.info({
        title: `${p.name} 驱动选项`,
        content: () => `可选参数（${keys.length} 项）：\n${keys.slice(0, 40).map((k) => `${k}: ${(d.options[k] || []).slice(0, 6).join(' | ')}`).join('\n')}`,
        positiveText: '知道了'
      });
    } catch (e) { message.error(e.message); }
  } else if (key === 'delete') {
    dialog.warning({
      title: '删除打印机',
      content: `确定删除队列「${p.name}」吗？队列中未完成的任务会一并取消。`,
      positiveText: '删除',
      negativeText: '取消',
      onPositiveClick: async () => {
        try {
          const d = await api.delete(`/printers/${encodeURIComponent(p.name)}`);
          message.success(d.msg);
          load();
        } catch (e) { message.error(e.message); }
      }
    });
  }
}

const onRefresh = () => load();
onMounted(() => {
  load();
  window.addEventListener('pg:refresh', onRefresh);
  window.addEventListener('resize', onResize);
});
onBeforeUnmount(() => {
  clearInterval(pollTimer);
  window.removeEventListener('pg:refresh', onRefresh);
  window.removeEventListener('resize', onResize);
});
</script>

<style scoped>
.cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(330px, 1fr)); gap: 14px; }
.pcard { background: #fff; border: 1px solid var(--pg-border); border-radius: 14px; padding: 16px; transition: box-shadow .2s ease; }
.pcard:hover { box-shadow: 0 8px 24px rgba(15,23,42,.06); }
.pcard.off { opacity: .72; }
.pcard-head { display: flex; gap: 12px; align-items: flex-start; }
.pcard-icon { width: 38px; height: 38px; border-radius: 11px; background: #ecfdf5; color: #0f766e; display: grid; place-items: center; font-size: 19px; flex: 0 0 38px; }
.pname { font-weight: 650; font-size: 14.5px; display: flex; align-items: center; gap: 6px; }
.puri { font-size: 11.5px; margin-top: 3px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 220px; }
.pmeta { font-size: 12.5px; color: #64748b; margin: 12px 0 10px; display: flex; gap: 6px; flex-wrap: wrap; }
.pcard-actions { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
.pcard-actions :deep(.n-button) { font-size: 12px; }
.hist-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
.hist-cell { border: 1px solid var(--pg-border); border-radius: 10px; padding: 10px 12px; }
.hist-k { font-size: 12px; opacity: .7; }
.hist-v { font-size: 20px; font-weight: 500; margin-top: 2px; }
.hist-v .muted { font-size: 12px; font-weight: 400; }
.hist-sub { font-size: 11.5px; margin-top: 2px; }
.auto-box { display: flex; align-items: center; gap: 14px; }
.auto-title { font-size: 13px; font-weight: 500; }
.auto-sub { font-size: 12px; line-height: 1.7; margin-top: 2px; }
.disc-top { display: flex; flex-direction: column; }
.disc-label { font-size: 12px; font-weight: 600; opacity: 0.72; margin-bottom: 6px; }
.disc-label:not(:first-child) { margin-top: 14px; }
.disc-warn {
  margin-top: 8px; padding: 8px 10px; border-radius: 8px; font-size: 12px; line-height: 1.7;
  background: rgba(245, 158, 11, 0.1); color: #b45309;
}
.found-list { display: grid; gap: 10px; }
.found { display: flex; gap: 12px; align-items: center; padding: 12px; border: 1px solid var(--pg-border); border-radius: 12px; }
.found.added { background: #f8fafc; }
.fname { font-weight: 600; font-size: 13.5px; display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
.furi { font-size: 11.5px; margin-top: 2px; word-break: break-all; }
.fmodel { font-size: 11.5px; margin-top: 2px; }
.grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 0 14px; }
@media (max-width: 640px) { .grid2 { grid-template-columns: 1fr; } }
</style>
