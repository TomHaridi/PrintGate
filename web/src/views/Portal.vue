<template>
  <div class="portal">
    <header class="p-head">
      <div class="brand">
        <div class="logo">PG</div>
        <div>
          <div class="b-name">printgate</div>
          <div class="b-sub">打印门户</div>
        </div>
      </div>
      <div class="me">
        <img v-if="me.avatarAbs" class="av" :src="me.avatarAbs" alt="" />
        <div v-else class="av av-ph">{{ (me.name || '微').slice(0, 1) }}</div>
        <div class="me-txt">
          <div class="me-name">{{ me.name || '微信用户' }}</div>
          <div class="me-role">
            <n-tag size="tiny" :bordered="false" :type="statusMeta.type" style="margin-right: 6px">{{ statusMeta.text }}</n-tag>
            <template v-if="me.username">账号 {{ me.username }} · </template>普通用户 · 仅可打印与查看自己的记录
          </div>
        </div>
        <div class="me-actions">
          <n-button size="small" secondary @click="openAccount">
            <template #icon><n-icon :component="SettingsOutline" /></template>
            设置
          </n-button>
          <n-button size="small" quaternary @click="doLogout">退出</n-button>
        </div>
      </div>
    </header>

    <n-alert v-if="me.status === 'pending'" type="warning" :bordered="false" style="margin-bottom: 14px">
      <div style="font-weight: 600; margin-bottom: 2px">账号待管理员审批，暂时不能打印</div>
      审批通过后本页会自动解锁（每 15 秒检查一次，也可手动刷新）。现在可以查看自己的记录，但上传与打印会被拒绝。
    </n-alert>
    <n-alert v-else-if="me.status === 'rejected'" type="error" :bordered="false" style="margin-bottom: 14px">
      注册申请已被管理员拒绝，如需使用请联系管理员。
    </n-alert>
    <n-alert v-else-if="me.status === 'blocked'" type="error" :bordered="false" style="margin-bottom: 14px">
      账号已被停用，请联系管理员恢复。
    </n-alert>

    <n-modal v-model:show="accShow" preset="card" title="账号设置" style="max-width: 460px">
      <div class="acc-block">
        <div class="acc-line"><span class="muted">账号</span><b>{{ me.username || '微信登录' }}</b></div>
        <div class="acc-line"><span class="muted">状态</span><n-tag size="small" :type="statusMeta.type" :bordered="false">{{ statusMeta.text }}</n-tag></div>
      </div>

      <n-divider style="margin: 14px 0">修改登录密码</n-divider>
      <template v-if="me.username">
        <n-form label-placement="top" :show-feedback="false">
          <n-form-item label="当前密码">
            <n-input v-model:value="pwd.oldPassword" type="password" show-password-on="click" placeholder="输入当前密码" />
          </n-form-item>
          <n-form-item label="新密码（至少 8 位，含字母和数字）">
            <n-input v-model:value="pwd.newPassword" type="password" show-password-on="click" />
          </n-form-item>
          <n-form-item label="确认新密码">
            <n-input v-model:value="pwd.confirm" type="password" show-password-on="click" />
          </n-form-item>
          <n-button type="primary" block :loading="savingPwd" @click="savePwd">保存新密码</n-button>
        </n-form>
      </template>
      <n-alert v-else type="info" :bordered="false">
        当前是微信登录，没有密码可改。可在小程序「我的」里改资料。
      </n-alert>

      <template #footer>
        <div class="row-between">
          <span class="muted" style="font-size: 12px">忘记密码请联系管理员重置</span>
          <n-button size="small" @click="accShow = false">关闭</n-button>
        </div>
      </template>
    </n-modal>

    <n-modal v-model:show="bindShow" preset="card" title="绑定微信" style="max-width: 420px">
      <div class="bind-wrap">
        <n-spin :show="bindLoading">
          <img v-if="bindQr" class="bind-qr" :src="bindQr" alt="绑定二维码" />
          <div v-else class="bind-empty">正在生成二维码…</div>
        </n-spin>
        <div class="bind-tip">用小程序「我的 → 扫码绑定账号」扫这个码，之后微信也能登录本账号</div>
        <div class="bind-meta">
          <span v-if="bindLeft > 0">{{ bindLeft }} 秒后过期</span>
          <span v-else class="expired">已过期</span>
          <n-button size="tiny" quaternary type="primary" @click="genBindQr">重新生成</n-button>
        </div>
        <n-alert v-if="bindMsg" :type="bindMsg.ok ? 'success' : 'warning'" :bordered="false" style="margin-top: 8px">
          {{ bindMsg.text }}
        </n-alert>
      </div>
    </n-modal>

    <div class="p-grid">
      <!-- 左：发起打印 -->
      <n-card size="small">
        <template #header>
          <div class="card-head">
            <span>发起打印</span>
          </div>
        </template>
        <div class="up" :class="{ locked: !canPrint }" @click="pick" @dragover.prevent @drop.prevent="onDrop">
          <input ref="fileInput" type="file" hidden accept=".pdf,.png,.jpg,.jpeg,.webp,.txt,.doc,.docx,.xls,.xlsx,.ppt,.pptx" @change="onPick" />
          <div class="up-icon">＋</div>
          <div class="up-title">{{ !canPrint ? '账号待审批，暂不能上传' : (file ? file.name : '点击选择文件，或拖进来') }}</div>
          <div class="up-sub">
            {{ !canPrint ? '管理员审批通过后这里会自动解锁' : (file ? fmtBytes(file.size) : `支持 PDF / 图片 / Office 文档，单文件上限 ${cfg.maxFileMB} MB`) }}
          </div>
        </div>

        <n-form label-placement="left" label-width="76" style="margin-top: 14px">
          <n-form-item label="打印机">
            <n-select v-model:value="printer" :options="printerOptions" placeholder="选择打印机" :loading="loadingPrinters" />
          </n-form-item>
          <template v-if="advanced">
            <n-form-item label="份数">
              <n-input-number v-model:value="copies" :min="1" :max="cfg.maxCopies || 10" style="width: 100%" />
            </n-form-item>
            <n-form-item label="色彩">
              <n-radio-group v-model:value="color">
                <n-radio-button value="mono">黑白</n-radio-button>
                <n-radio-button value="color">彩色</n-radio-button>
              </n-radio-group>
            </n-form-item>
            <n-form-item label="单双面">
              <n-radio-group v-model:value="sides">
                <n-radio-button value="one-sided">单面</n-radio-button>
                <n-radio-button value="two-sided-long-edge">双面</n-radio-button>
              </n-radio-group>
            </n-form-item>
            <n-form-item label="纸张">
              <n-select v-model:value="media" :options="mediaOptions" />
            </n-form-item>
          </template>
          <n-form-item v-else label="设置">
            <div class="muted">管理员已隐藏详细设置，将按默认参数打印（单份 / 黑白 / 单面 / A4）。</div>
          </n-form-item>
        </n-form>

        <n-button type="primary" block size="large" :loading="printing" :disabled="!file || !printer || !canPrint" @click="doPrint">
          {{ canPrint ? '上传并打印' : '待审批，暂不能打印' }}
        </n-button>
        <div class="muted tip">提交后可在右侧「我的打印记录」查看状态；需要管理员放行的任务会显示待审批。</div>

        <!-- 大卡片入口：高级打印 / 绑定微信 -->
        <div class="entry-grid">
          <button class="entry-card" :disabled="!canPrint" @click="goWorkbench">
            <span class="ec-icon">🖨️</span>
            <span class="ec-body">
              <span class="ec-title">高级打印</span>
              <span class="ec-sub">文字速印 · 发票合排 · 身份证</span>
            </span>
            <span class="ec-arrow">→</span>
          </button>
          <button class="entry-card" :disabled="!canPrint" @click="openBind">
            <span class="ec-icon">📱</span>
            <span class="ec-body">
              <span class="ec-title">绑定微信</span>
              <span class="ec-sub">扫码把微信绑到本账号，小程序也能用</span>
            </span>
            <span class="ec-arrow">→</span>
          </button>
        </div>
      </n-card>

      <!-- 右：历史 -->
      <n-card size="small">
        <template #header>
          <div class="h-head">
            <span>我的打印记录</span>
            <n-button size="tiny" quaternary type="error" :loading="clearing" :disabled="!rows.length" @click="clearHistory">
              一键清空历史
            </n-button>
          </div>
        </template>

        <n-spin :show="loadingTasks">
          <div v-if="!rows.length" class="empty">还没有打印记录</div>
          <div v-else class="rows">
            <div v-for="t in rows" :key="t.id" class="row">
              <div class="r-main">
                <div class="r-name">{{ t.filename || `文件 #${t.file_id}` }}</div>
                <div class="r-meta">
                  {{ fmtTime(t.created_at) }} · {{ t.printer }} · {{ t.copies }} 份
                  <span v-if="t.pages"> · {{ t.pages }} 页</span>
                </div>
                <div v-if="t.error" class="r-err">{{ t.error }}</div>
              </div>
              <n-tag size="tiny" :type="statusType(t.status)" :bordered="false">{{ statusText(t.status) }}</n-tag>
            </div>
          </div>
        </n-spin>
        <template #footer>
          <div class="row-between">
            <span class="muted">只显示你自己的记录，最多 50 条</span>
            <n-button size="tiny" quaternary :loading="loadingTasks" @click="loadTasks">刷新</n-button>
          </div>
        </template>
      </n-card>
    </div>
  </div>
</template>

<script setup>
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue';
import { useRouter } from 'vue-router';
import { useDialog, useMessage } from 'naive-ui';
import { SettingsOutline } from '@vicons/ionicons5';
import { api, fmtBytes, fmtTime } from '../api';
import { logout, store } from '../store';

const router = useRouter();

// ---------- 账号设置：改密码 ----------
const accShow = ref(false);
const savingPwd = ref(false);
const pwd = reactive({ oldPassword: '', newPassword: '', confirm: '' });
function openAccount() {
  pwd.oldPassword = ''; pwd.newPassword = ''; pwd.confirm = '';
  accShow.value = true;
}
async function savePwd() {
  if (!pwd.oldPassword) return message.warning('请输入当前密码');
  if (!pwd.newPassword || pwd.newPassword.length < 8) return message.warning('新密码至少 8 位');
  if (!/[A-Za-z]/.test(pwd.newPassword) || !/\d/.test(pwd.newPassword)) return message.warning('新密码要同时包含字母和数字');
  if (pwd.newPassword !== pwd.confirm) return message.warning('两次输入的新密码不一致');
  savingPwd.value = true;
  try {
    await api.post('/auth/account/password', { oldPassword: pwd.oldPassword, newPassword: pwd.newPassword });
    message.success('密码已更新，下次登录用新密码');
    accShow.value = false;
  } catch (e) {
    message.error(e.message || '修改失败');
  } finally {
    savingPwd.value = false;
  }
}

// ---------- 绑定微信：自己生成一张绑定码，用小程序扫 ----------
const bindShow = ref(false);
const bindQr = ref('');
const bindLoading = ref(false);
const bindLeft = ref(0);
const bindMsg = ref(null);
let bindTimer = null;
let bindPoll = null;
function clearBindTimers() {
  if (bindTimer) { clearInterval(bindTimer); bindTimer = null; }
  if (bindPoll) { clearInterval(bindPoll); bindPoll = null; }
}
onUnmounted(clearBindTimers);

async function openBind() {
  if (!canPrint.value) return message.warning('账号待管理员审批，暂时不能使用');
  bindShow.value = true;
  bindMsg.value = null;
  await genBindQr();
}

async function genBindQr() {
  clearBindTimers();
  bindQr.value = '';
  bindMsg.value = null;
  bindLoading.value = true;
  try {
    const d = await api.post('/mp/bind/qr');
    bindQr.value = d.qr;
    bindLeft.value = d.expiresIn || 120;
    bindTimer = setInterval(() => {
      bindLeft.value -= 1;
      if (bindLeft.value <= 0) { clearInterval(bindTimer); bindTimer = null; }
    }, 1000);
    bindPoll = setInterval(async () => {
      try {
        const st = await api.get('/mp/bind/qr/status');
        if (st.bound) {
          clearBindTimers();
          bindMsg.value = { ok: true, text: '已绑定：' + (st.nickname || ('openid…' + (st.openidTail || ''))) };
          const me2 = await api.get('/mp/me');
          const u = me2.user || {};
          me.name = u.nickname || u.name || me.name;
          me.avatarAbs = u.avatar || '';
          unboundWechat.value = false;
        }
      } catch (_) { /* 抖动忽略 */ }
    }, 2000);
  } catch (e) {
    bindMsg.value = { ok: false, text: e.message || '生成失败' };
  } finally {
    bindLoading.value = false;
  }
}
function goWorkbench() {
  if (!canPrint.value) return message.warning('账号待管理员审批，暂时不能打印');
  router.push({ name: 'workbench' });
}
const message = useMessage();
const dialog = useDialog();

const me = reactive({ name: '', avatarAbs: '', status: '', username: '' });
// 只有「已授权」能上传/打印；未审批、被拒绝、被停用一律锁住（后端同样 403 NOT_APPROVED，双层保险）
const canPrint = computed(() => me.status === 'approved');
// 是否还没有真微信（账号密码注册的用户 openid 是 local_ 占位）
const unboundWechat = ref(false);
const STATUS_META = {
  approved: { text: '已授权', type: 'success' },
  pending: { text: '待审批', type: 'warning' },
  rejected: { text: '已拒绝', type: 'error' },
  blocked: { text: '已停用', type: 'error' }
};
const statusMeta = computed(() => STATUS_META[me.status] || { text: me.status || '未知', type: 'default' });
const cfg = reactive({ maxFileMB: 200, maxCopies: 10, advancedPrint: true });
const advanced = computed(() => cfg.advancedPrint !== false);

const fileInput = ref(null);
const file = ref(null);
const printer = ref('');
const printers = ref([]);
const loadingPrinters = ref(false);
const printing = ref(false);

const copies = ref(1);
const color = ref('mono');
const sides = ref('one-sided');
const media = ref('A4');
const mediaOptions = [
  { label: 'A4', value: 'A4' },
  { label: 'A5', value: 'A5' },
  { label: 'Letter', value: 'Letter' }
];

const rows = ref([]);
const loadingTasks = ref(false);
const clearing = ref(false);

const printerOptions = computed(() => printers.value.map((p) => ({
  label: `${p.name}${p.isDefault ? '（默认）' : ''}${p.state && p.state !== 'idle' ? ` · ${p.state}` : ''}`,
  value: p.name
})));

const STATUS = {
  pending: ['待审批', 'warning'],
  approved: ['已放行', 'info'],
  printing: ['打印中', 'info'],
  done: ['已完成', 'success'],
  failed: ['失败', 'error'],
  canceled: ['已取消', 'default'],
  rejected: ['已拒绝', 'default']
};
const statusText = (s) => (STATUS[s] || [s || '—', 'default'])[0];
const statusType = (s) => (STATUS[s] || [s, 'default'])[1];

function absAvatar(v) {
  if (!v) return '';
  return /^https?:\/\//.test(v) ? v : v;
}

async function loadMe() {
  const d = await api.get('/mp/me');
  const u = d.user || {};
  me.name = u.nickname || '微信用户';
  me.avatarAbs = absAvatar(u.avatar);
  me.status = u.status || '';
  me.username = u.username || '';
  Object.assign(cfg, d.config || {});
}

async function loadPrinters() {
  loadingPrinters.value = true;
  try {
    const d = await api.get('/mp/printers');
    printers.value = d.printers || [];
    if (!printer.value) printer.value = d.default || (printers.value[0] && printers.value[0].name) || '';
  } catch (e) {
    message.error(e.message);
  } finally {
    loadingPrinters.value = false;
  }
}

async function loadTasks() {
  loadingTasks.value = true;
  try {
    const d = await api.get('/mp/tasks');
    rows.value = d.tasks || [];
  } catch (e) {
    message.error(e.message);
  } finally {
    loadingTasks.value = false;
  }
}

function pick() {
  if (!canPrint.value) {
    message.warning('账号待管理员审批，暂时不能上传文件');
    return;
  }
  fileInput.value && fileInput.value.click();
}

function onPick(e) {
  const f = (e.target.files || [])[0];
  if (f) setFile(f);
}

function onDrop(e) {
  const f = (e.dataTransfer.files || [])[0];
  if (f) setFile(f);
}

function setFile(f) {
  if (!canPrint.value) {
    message.warning('账号待管理员审批，暂时不能上传文件');
    return;
  }
  const limit = (Number(cfg.maxFileMB) || 200) * 1024 * 1024;
  if (f.size > limit) {
    message.error(`文件超过 ${cfg.maxFileMB} MB 上限`);
    return;
  }
  file.value = f;
}

async function doPrint() {
  if (!canPrint.value) return message.warning('账号待管理员审批，暂时不能打印');
  if (!file.value || !printer.value) return;
  printing.value = true;
  try {
    const fd = new FormData();
    fd.append('file', file.value);
    // 大文件走 5 分钟超时，与后台「发起打印」页保持一致
    const up = await api.post('/mp/files', fd, { headers: { 'Content-Type': 'multipart/form-data' }, timeout: 300000 });
    const fileId = up.file && up.file.id;
    if (!fileId) throw new Error('上传失败');
    const options = advanced.value
      ? { copies: Number(copies.value) || 1, color: color.value, sides: sides.value, media: media.value, orientation: 'portrait' }
      : { copies: 1, color: 'mono', sides: 'one-sided', media: 'A4', orientation: 'portrait' };
    const r = await api.post('/mp/print', { fileId, printer: printer.value, options });
    message.success(r.msg || '已提交打印');
    file.value = null;
    if (fileInput.value) fileInput.value.value = '';
    await loadTasks();
  } catch (e) {
    message.error(e.message);
  } finally {
    printing.value = false;
  }
}

function clearHistory() {
  dialog.warning({
    title: '清空打印历史',
    content: '将删除你所有已结束的打印记录和已上传的文件（正在打印的任务不受影响），此操作不可恢复。',
    positiveText: '确认清空',
    negativeText: '取消',
    onPositiveClick: async () => {
      clearing.value = true;
      try {
        const d = await api.delete('/mp/history');
        message.success(d.msg || '已清空');
        await loadTasks();
      } catch (e) {
        message.error(e.message);
      } finally {
        clearing.value = false;
      }
    }
  });
}

async function doLogout() {
  logout();
  router.replace({ name: 'login' });
}

let statusTimer = null;
onUnmounted(() => { if (statusTimer) clearInterval(statusTimer); });

// 待审批时每 15 秒看一次是否已被放行，避免让用户自己反复刷新
function watchApproval() {
  if (statusTimer) clearInterval(statusTimer);
  statusTimer = setInterval(async () => {
    if (me.status !== 'pending') { clearInterval(statusTimer); statusTimer = null; return; }
    try {
      const d = await api.get('/mp/me');
      const u = d.user || {};
      if (u.status && u.status !== me.status) {
        me.status = u.status;
        if (u.status === 'approved') message.success('管理员已通过审批，现在可以打印了');
      }
    } catch (_) { /* 网络抖动忽略，下一轮再试 */ }
  }, 15000);
}

onMounted(async () => {
  try {
    await loadMe();
  } catch (e) {
    message.error(e.message);
    if (e.status === 401 || e.status === 403) {
      logout();
      router.replace({ name: 'login' });
      return;
    }
  }
  await Promise.all([loadPrinters(), loadTasks()]);
  me.name = me.name || (store.me && store.me.name) || '微信用户';
  if (me.status === 'pending') watchApproval();
});
</script>

<style scoped>
/* 头部操作区 */
.me-actions { display: flex; align-items: center; gap: 8px; }

/* 高级打印 / 绑定微信：大卡片按钮 */
.entry-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-top: 14px; }
@media (max-width: 560px) { .entry-grid { grid-template-columns: 1fr; } }
.entry-card {
  display: flex; align-items: center; gap: 12px; width: 100%; text-align: left;
  padding: 16px 16px; border-radius: 14px; cursor: pointer;
  background: linear-gradient(135deg, #f0fdfa, #ecfeff);
  border: 1px solid #ccfbf1; color: inherit; transition: transform .15s ease, box-shadow .15s ease;
}
.entry-card:hover:not(:disabled) { transform: translateY(-2px); box-shadow: 0 8px 20px rgba(13,148,136,.12); }
.entry-card:disabled { opacity: .55; cursor: not-allowed; }
.ec-icon { font-size: 26px; line-height: 1; }
.ec-body { display: flex; flex-direction: column; gap: 3px; flex: 1; min-width: 0; }
.ec-title { font-size: 15px; font-weight: 600; color: #0f172a; }
.ec-sub { font-size: 12.5px; color: #64748b; }
.ec-arrow { font-size: 16px; color: #0ea5a4; }

/* 账号设置弹窗 */
.acc-block { display: grid; gap: 8px; }
.acc-line { display: flex; align-items: center; justify-content: space-between; font-size: 13.5px; }

/* 绑定微信弹窗 */
.bind-wrap { display: flex; flex-direction: column; align-items: center; gap: 10px; }
.bind-qr { width: 220px; height: 220px; border-radius: 12px; border: 1px solid var(--pg-border); background: #fff; padding: 8px; }
.bind-empty { width: 220px; height: 220px; display: grid; place-items: center; color: var(--pg-muted); font-size: 13px; }
.bind-tip { font-size: 12.5px; color: var(--pg-muted); text-align: center; line-height: 1.6; }
.bind-meta { display: flex; align-items: center; gap: 10px; font-size: 12.5px; color: var(--pg-muted); }
.bind-meta .expired { color: #ef4444; }
</style>
<style scoped>
.card-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.portal { max-width: 1180px; margin: 0 auto; padding: 22px 24px 48px; }
.p-head { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 18px; flex-wrap: wrap; }
.brand { display: flex; align-items: center; gap: 10px; }
.logo { width: 38px; height: 38px; border-radius: 11px; background: #0f766e; color: #fff; display: grid; place-items: center; font-weight: 700; }
.b-name { font-weight: 700; font-size: 16px; }
.b-sub { font-size: 12px; color: var(--pg-muted); }
.me { display: flex; align-items: center; gap: 10px; }
.av { width: 38px; height: 38px; border-radius: 50%; object-fit: cover; background: #e2e8f0; }
.av-ph { display: grid; place-items: center; font-weight: 600; color: #64748b; }
.me-name { font-size: 13.5px; font-weight: 600; }
.me-role { font-size: 11.5px; color: var(--pg-muted); }
.p-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; align-items: start; }
.up { border: 1.5px dashed #cbd5e1; border-radius: 12px; padding: 26px 16px; text-align: center; cursor: pointer; transition: .15s; }
.up:hover { border-color: #0f766e; background: #f6fefc; }
.up.locked { cursor: not-allowed; border-color: #e2e8f0; background: #f8fafc; color: var(--pg-muted); }
.up.locked:hover { border-color: #e2e8f0; background: #f8fafc; }
.up.locked .up-icon { color: #cbd5e1; }
.up-icon { font-size: 24px; color: #0f766e; line-height: 1; }
.up-title { font-weight: 600; margin-top: 8px; word-break: break-all; }
.up-sub { font-size: 12px; color: var(--pg-muted); margin-top: 4px; }
.tip { font-size: 12px; margin-top: 10px; line-height: 1.7; }
.h-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.empty { text-align: center; color: var(--pg-muted); padding: 28px 0; font-size: 13px; }
.rows { display: grid; gap: 8px; max-height: 460px; overflow: auto; }
.row { display: flex; align-items: flex-start; gap: 10px; padding: 10px 12px; border: 1px solid var(--pg-border); border-radius: 10px; }
.r-main { flex: 1; min-width: 0; }
.r-name { font-size: 13px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.r-meta { font-size: 11.5px; color: var(--pg-muted); margin-top: 2px; }
.r-err { font-size: 11.5px; color: #dc2626; margin-top: 2px; }
.row-between { display: flex; align-items: center; justify-content: space-between; }
.muted { color: var(--pg-muted); font-size: 12px; }
@media (max-width: 900px) {
  .p-grid { grid-template-columns: 1fr; }
}
</style>
