<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h1 class="page-title">小程序对接</h1>
        <div class="page-desc">所有接入参数集中在此维护，保存即生效；扫码绑定与接口文档同屏可查</div>
      </div>
      <div class="row wrap">
        <n-tag :type="cfg.configured ? 'success' : 'warning'" :bordered="false" size="small">
          {{ cfg.configured ? '凭据已配置' : '未配置凭据' }}
        </n-tag>
        <n-tag :type="cfg.enableQrLogin ? 'success' : 'default'" :bordered="false" size="small">
          扫码登录{{ cfg.enableQrLogin ? '已开启' : '已关闭' }}
        </n-tag>
        <n-tag v-if="cfg.stats.pending" type="warning" :bordered="false" size="small">
          {{ cfg.stats.pending }} 位用户待审批
        </n-tag>
      </div>
    </div>

    <!-- 概览条 -->
    <div class="overview">
      <div class="ov">
        <div class="ov-label">接入地址（BASE）</div>
        <div class="ov-value mono">{{ cfg.baseUrl || origin }}</div>
        <div class="ov-foot">
          <n-button size="tiny" quaternary @click="copy(cfg.baseUrl || origin)">复制</n-button>
          <n-button v-if="!cfg.baseUrl" size="tiny" quaternary type="primary" @click="useOrigin">设为当前地址</n-button>
          <span v-else-if="cfg.baseUrl !== origin" class="warn">与当前访问地址不一致</span>
        </div>
      </div>
      <div class="ov">
        <div class="ov-label">小程序凭据</div>
        <div class="ov-value">{{ cfg.configured ? '已配置' : '未配置' }}</div>
        <div class="ov-foot mono">{{ cfg.appid || '—' }}</div>
      </div>
      <div class="ov">
        <div class="ov-label">授权用户</div>
        <div class="ov-value">{{ cfg.stats.users }}</div>
        <div class="ov-foot">待审批 {{ cfg.stats.pending }} · 管理员 {{ cfg.stats.admins }}</div>
      </div>
      <div class="ov">
        <div class="ov-label">新用户策略</div>
        <div class="ov-value">{{ cfg.approveNewUser ? '需审批' : '自动放行' }}</div>
        <div class="ov-foot">{{ cfg.approveEachJob ? '逐单审批开启' : '提交即打印' }}</div>
      </div>
    </div>

    <div class="layout">
      <!-- 左：关键参数 -->
      <n-card size="small" title="关键接入参数">
        <template #header-extra>
          <span class="muted" style="font-size: 12px">唯一维护入口 · 保存立即生效</span>
        </template>
        <n-form label-placement="top">
          <div class="grid2">
            <n-form-item label="小程序 AppID">
              <n-input v-model:value="form.appid" placeholder="wx1234567890abcdef" :disabled="saving" />
            </n-form-item>
            <n-form-item label="小程序 AppSecret">
              <n-input
                v-model:value="form.secret" type="password" show-password-on="click" :disabled="saving"
                :placeholder="cfg.secretConfigured ? `已配置 ${cfg.secret}（留空保持不变）` : '32 位字母数字'"
              />
            </n-form-item>
          </div>
          <n-form-item label="接入地址（BASE，小程序 request / uploadFile 域名）">
            <n-input v-model:value="form.baseUrl" placeholder="https://print.example.com" :disabled="saving">
              <template #prefix><n-icon :component="LinkOutline" /></template>
            </n-input>
            <template #feedback>
              <span class="muted" style="font-size: 12px">
                公网部署填 https 域名；内网联调可留空，小程序直接用 <span class="mono">{{ origin }}</span>
              </span>
            </template>
          </n-form-item>
          <n-form-item label="管理员 OpenID 白名单（登录即管理员）">
            <n-dynamic-tags v-model:value="form.openids" :disabled="saving" />
            <template #feedback>
              <span class="muted" style="font-size: 12px">可留空，改用微信扫码绑定；回车添加一个 OpenID</span>
            </template>
          </n-form-item>

          <div class="switches">
            <label class="sw">
              <n-switch v-model:value="form.approveNewUser" :disabled="saving" size="small" />
              <div>
                <div class="sw-title">新用户需审批</div>
                <div class="sw-desc">关闭后微信登录即可打印，适合内部小范围使用</div>
              </div>
            </label>
            <label class="sw">
              <n-switch v-model:value="form.enableQrLogin" :disabled="saving" size="small" />
              <div>
                <div class="sw-title">允许微信扫码登录后台</div>
                <div class="sw-desc">需至少绑定一个管理员微信</div>
              </div>
            </label>
            <label class="sw">
              <n-switch v-model:value="form.devMode" :disabled="saving" size="small" />
              <div>
                <div class="sw-title">开发模式（模拟登录）</div>
                <div class="sw-desc">开放 /api/mp/dev-login，仅本机联调，公网务必关闭</div>
              </div>
            </label>
          </div>

          <n-alert v-if="form.devMode" type="warning" :bordered="false" style="margin: 4px 0 12px">
            开发模式已开启：任何能访问本服务的人都可以伪造微信身份登录，请仅在联调时使用。
          </n-alert>

          <div class="row" style="margin-top: 8px">
            <n-button type="primary" :loading="saving" @click="save">保存接入参数</n-button>
            <n-button :loading="testing" @click="test">测试连通性</n-button>
            <n-button v-if="cfg.secretConfigured" quaternary type="error" :loading="saving" @click="clearSecret">清除密钥</n-button>
            <span v-if="dirty" class="muted">有未保存的修改</span>
          </div>
        </n-form>
      </n-card>

      <!-- 右：绑定 + 步骤 -->
      <div class="col">
        <n-card size="small" title="扫码绑定管理员">
          <div class="bind">
            <div class="qr">
              <img v-if="cfg.bindQr" :src="cfg.bindQr" alt="绑定二维码" />
              <n-spin v-else />
            </div>
            <div class="grow" style="min-width: 0">
              <div class="muted" style="font-size: 12.5px; line-height: 1.8">
                小程序内「扫一扫」扫描此码，当前微信立即升级为管理员，之后可在登录页扫码登录后台。
              </div>
              <div class="token-line">
                <span class="muted">绑定码</span>
                <code class="mono">{{ cfg.bindToken || '—' }}</code>
                <n-button size="tiny" quaternary @click="copy(cfg.bindToken)">复制</n-button>
              </div>
              <div class="bind-meta">
                <n-tag size="tiny" :bordered="false" :type="remainSec > 60 ? 'success' : 'warning'">
                  {{ remainSec > 0 ? `${mmss(remainSec)} 后自动换新` : '正在换新…' }}
                </n-tag>
                <span class="muted">一码一人 · 绑定成功或到期即换新，旧码立刻失效</span>
              </div>
              <n-button size="small" :loading="regenerating" style="margin-top: 10px" @click="regenerate">
                重新生成绑定码
              </n-button>
            </div>
          </div>
        </n-card>

        <n-card size="small" title="接入步骤">
          <n-steps vertical size="small" :current="stepCurrent">
            <n-step title="填写接入参数" :description="cfg.configured ? 'AppID / AppSecret 已配置' : '填写 AppID 与 AppSecret 并保存'" />
            <n-step title="配置小程序域名" description="把接入地址加入 request / uploadFile 合法域名" />
            <n-step title="小程序登录" :description="`${cfg.stats.users} 位微信用户已登录`" />
            <n-step title="授权或绑定管理员" :description="cfg.stats.admins ? `${cfg.stats.admins} 位管理员可扫码登录` : '扫码绑定或审批用户'" />
          </n-steps>
          <template #footer>
            <div class="row-between">
              <n-button text size="small" @click="$router.push('/users')">用户管理</n-button>
              <n-button text size="small" @click="$router.push('/settings?tab=security')">安全策略</n-button>
            </div>
          </template>
        </n-card>
      </div>
    </div>

    <!-- 接口文档 -->
    <n-card size="small" title="接口文档" style="margin-top: 16px">
      <n-tabs type="segment" size="small">
        <n-tab-pane name="api" tab="接口一览">
          <n-table :single-line="false" size="small">
            <thead><tr><th style="width: 210px">接口</th><th style="width: 64px">方法</th><th>说明</th></tr></thead>
            <tbody>
              <tr v-for="e in endpoints" :key="e.path">
                <td class="mono">{{ e.path }}</td>
                <td><n-tag size="tiny" :bordered="false" :type="e.method === 'GET' ? 'info' : 'success'">{{ e.method }}</n-tag></td>
                <td class="muted">{{ e.desc }}</td>
              </tr>
            </tbody>
          </n-table>
        </n-tab-pane>
        <n-tab-pane name="login" tab="登录">
          <pre class="code">{{ loginCode }}</pre>
        </n-tab-pane>
        <n-tab-pane name="print" tab="上传并打印">
          <pre class="code">{{ printCode }}</pre>
        </n-tab-pane>
        <n-tab-pane name="scan" tab="扫码绑定 / 扫码登录">
          <pre class="code">{{ scanCode }}</pre>
        </n-tab-pane>
      </n-tabs>
    </n-card>
  </div>
</template>

<script setup>
import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue';
import { useMessage, useDialog } from 'naive-ui';
import { LinkOutline } from '@vicons/ionicons5';
import { api } from '../api';

const message = useMessage();
const dialog = useDialog();
const saving = ref(false);
const testing = ref(false);
const regenerating = ref(false);
const origin = window.location.origin;

const cfg = ref({
  appid: '', secret: '', secretConfigured: false, configured: false, baseUrl: '',
  adminOpenids: [], approveNewUser: true, enableQrLogin: true, devMode: false,
  approveEachJob: false, bindToken: '', bindQr: '',
  bindExpiresAt: 0, bindTtlSec: 600,
  stats: { users: 0, pending: 0, admins: 0 }
});

// ---- 绑定码倒计时 / 自动换新 ----
// 服务端策略：一码一人 + TTL。这里只负责显示与同步：
//   · 每秒刷新剩余时间，归零时主动拉一次（服务端会就地换新）；
//   · 每 10 秒轻量轮询，有人扫码绑定成功后新码自动顶上来。
const now = ref(Date.now());
const remainSec = computed(() => {
  const exp = Number(cfg.value.bindExpiresAt) || 0;
  return exp ? Math.max(0, Math.ceil((exp - now.value) / 1000)) : 0;
});
const mmss = (s) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;

let tickTimer = null;
let pollTimer = null;
let syncing = false;

async function refreshBind() {
  if (syncing) return;
  syncing = true;
  try {
    const d = await api.get('/admin/bind/info');
    if (!d.ok || !d.token) return;
    const changed = d.token !== cfg.value.bindToken;
    cfg.value = { ...cfg.value, bindToken: d.token, bindQr: d.qr, bindExpiresAt: d.expiresAt, bindTtlSec: d.ttlSec };
    now.value = Date.now();
    if (changed && cfg.value.bindToken) message.info('绑定码已换新（已有人完成绑定或原码到期），请用新码');
  } catch (_) {
    /* 轮询失败静默：下次再来，不影响页面其它操作 */
  } finally {
    syncing = false;
  }
}

const form = reactive({ appid: '', secret: '', baseUrl: '', openids: [], approveNewUser: true, enableQrLogin: true, devMode: false });
const saved = ref('');

const snapshot = () => JSON.stringify({
  appid: form.appid, secret: form.secret, baseUrl: form.baseUrl, openids: form.openids,
  approveNewUser: form.approveNewUser, enableQrLogin: form.enableQrLogin, devMode: form.devMode
});
const dirty = computed(() => saved.value !== '' && snapshot() !== saved.value);

const stepCurrent = computed(() => {
  if (!cfg.value.configured) return 1;
  if (!cfg.value.baseUrl) return 2;
  if (!cfg.value.stats.users) return 3;
  return 4;
});

const endpoints = [
  { path: '/api/mp/login', method: 'POST', desc: 'code 换 token（code2session），首次登录创建待审批用户' },
  { path: '/api/mp/me', method: 'GET', desc: '读取当前用户状态与打印限制' },
  { path: '/api/mp/printers', method: 'GET', desc: '打印队列列表（小程序里选打印机用）' },
  { path: '/api/mp/files', method: 'POST', desc: '上传待打印文件（multipart，字段名 file）' },
  { path: '/api/mp/files', method: 'GET', desc: '我上传过的文件；DELETE /api/mp/files/:id 删除' },
  { path: '/api/mp/files/:id/preview', method: 'GET', desc: '预览自己的文件（PDF 出首页图，图片原样返回）' },
  { path: '/api/mp/print', method: 'POST', desc: '提交打印：fileId + printer + options（支持 watermark / mirror / pageSet）' },
  { path: '/api/mp/tasks', method: 'GET', desc: '我的打印任务列表；POST /api/mp/tasks/:id/cancel 取消' },
  { path: '/api/mp/bind', method: 'POST', desc: '扫码绑定管理员：token（后台绑定码）' },
  { path: '/api/mp/qr/scan', method: 'POST', desc: '扫码登录：ticket（网页二维码里的 ticket）' },
  { path: '/api/mp/qr/confirm', method: 'POST', desc: '扫码登录二次确认，网页随即自动登录' },
  { path: '/api/mp/admin/overview', method: 'GET', desc: '【管理员】概览：待审用户/任务、今日任务、打印机数' },
  { path: '/api/mp/admin/users', method: 'GET', desc: '【管理员】用户列表（?status=pending|approved|blocked|all）' },
  { path: '/api/mp/admin/users/:id/:action', method: 'POST', desc: '【管理员】approve 通过 / block 停用 / unblock 恢复' },
  { path: '/api/mp/admin/tasks', method: 'GET', desc: '【管理员】任务列表（?status=pending）' },
  { path: '/api/mp/admin/tasks/:id/:action', method: 'POST', desc: '【管理员】approve 放行（立即投递）/ reject 拒绝' },
  { path: '/api/mp/admin/printers', method: 'GET', desc: '【管理员】打印队列与默认队列' },
  { path: '/api/mp/admin/printers/:name/:action', method: 'POST', desc: '【管理员】pause 暂停 / resume 启用 / default 设为默认' },
  { path: '/api/mp/admin/settings', method: 'GET/PUT', desc: '【管理员】读写打印设置（上限、审批、保留天数、默认打印机）' }
];

const loginCode = `// app.js
const BASE = '${window.location.origin}';
wx.login({
  success: async ({ code }) => {
    const res = await wx.request({
      url: BASE + '/api/mp/login',
      method: 'POST',
      data: { code, nickname: '张三', avatar: '' }
    });
    if (res.data.ok) {
      wx.setStorageSync('pg_token', res.data.token);
      // res.data.user.status: pending | approved
    } else {
      wx.showToast({ title: res.data.msg, icon: 'none' });
    }
  }
});`;

const printCode = `// 选择聊天文件 -> 上传 -> 打印
wx.chooseMessageFile({ count: 1, type: 'file', success: ({ tempFiles }) => {
  const f = tempFiles[0];
  wx.uploadFile({
    url: BASE + '/api/mp/files',
    filePath: f.path, name: 'file',
    header: { Authorization: 'Bearer ' + wx.getStorageSync('pg_token') },
    success: (up) => {
      const file = JSON.parse(up.data).file;
      wx.request({
        url: BASE + '/api/mp/print',
        method: 'POST',
        header: { Authorization: 'Bearer ' + wx.getStorageSync('pg_token') },
        data: {
          fileId: file.id,
          options: { copies: 1, color: 'mono', sides: 'one-sided', media: 'A4', orientation: 'portrait' }
        },
        success: (r) => wx.showModal({ title: '提交结果', content: r.data.msg, showCancel: false })
      });
    }
  });
}});`;

const scanCode = `// 扫码绑定管理员（扫的是本页「扫码绑定管理员」二维码）
wx.scanCode({ success: ({ result }) => {
  wx.request({
    url: BASE + '/api/mp/bind', method: 'POST',
    header: { Authorization: 'Bearer ' + wx.getStorageSync('pg_token') },
    data: { token: result.trim() },
    success: (r) => wx.showToast({ title: r.data.msg, icon: 'none' })
  });
}});

// 扫码登录（扫的是网页登录页二维码，内容为 printgate://login?ticket=xxx）
wx.scanCode({ success: ({ result }) => {
  const ticket = new URL(result.replace('printgate://', 'https://x/')).searchParams.get('ticket');
  wx.request({ url: BASE + '/api/mp/qr/scan', method: 'POST', data: { ticket },
    header: { Authorization: 'Bearer ' + wx.getStorageSync('pg_token') } });
  wx.showModal({ title: '确认登录后台？', content: '仅管理员微信可登录',
    success: (m) => { if (m.confirm) wx.request({ url: BASE + '/api/mp/qr/confirm', method: 'POST',
      data: { ticket }, header: { Authorization: 'Bearer ' + wx.getStorageSync('pg_token') } }); } });
}});`;

function apply(config) {
  cfg.value = config;
  form.appid = config.appid || '';
  form.secret = '';
  form.baseUrl = config.baseUrl || '';
  form.openids = [...(config.adminOpenids || [])];
  form.approveNewUser = !!config.approveNewUser;
  form.enableQrLogin = !!config.enableQrLogin;
  form.devMode = !!config.devMode;
  saved.value = snapshot();
}

async function load() {
  try {
    const d = await api.get('/wechat/config');
    apply(d.config);
  } catch (e) {
    message.error(e.message);
  }
}

async function save() {
  saving.value = true;
  try {
    const d = await api.put('/wechat/config', {
      appid: form.appid,
      secret: form.secret,
      baseUrl: form.baseUrl,
      adminOpenids: form.openids,
      approveNewUser: form.approveNewUser,
      enableQrLogin: form.enableQrLogin,
      devMode: form.devMode
    });
    apply(d.config);
    message.success(d.msg || '已保存');
  } catch (e) {
    message.error(e.message);
  } finally {
    saving.value = false;
  }
}

async function test() {
  testing.value = true;
  try {
    const d = await api.post('/wechat/test');
    if (d.ok) message.success(d.msg); else message.error(d.msg);
  } catch (e) {
    message.error(e.message);
  } finally {
    testing.value = false;
  }
}

function clearSecret() {
  dialog.warning({
    title: '清除 AppSecret',
    content: '清除后小程序将无法登录，需要重新填写。确定继续？',
    positiveText: '清除',
    negativeText: '取消',
    onPositiveClick: async () => {
      saving.value = true;
      try {
        const d = await api.put('/wechat/config', { appid: form.appid, secret: '', clearSecret: true });
        apply(d.config);
        message.success('已清除');
      } catch (e) {
        message.error(e.message);
      } finally {
        saving.value = false;
      }
    }
  });
}

async function regenerate() {
  regenerating.value = true;
  try {
    const d = await api.post('/wechat/bind-token');
    cfg.value = { ...cfg.value, bindToken: d.bindToken, bindQr: d.bindQr, bindExpiresAt: d.bindExpiresAt, bindTtlSec: d.bindTtlSec };
    now.value = Date.now();
    message.success(d.msg);
  } catch (e) {
    message.error(e.message);
  } finally {
    regenerating.value = false;
  }
}

function useOrigin() {
  form.baseUrl = origin;
  message.info('已填入当前访问地址，保存后生效');
}

async function copy(text) {
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    message.success('已复制');
  } catch (_) {
    message.warning('复制失败，请手动选择复制');
  }
}

onMounted(async () => {
  await load();
  tickTimer = setInterval(() => { now.value = Date.now(); }, 1000);
  pollTimer = setInterval(refreshBind, 10000);
});
onUnmounted(() => {
  if (tickTimer) clearInterval(tickTimer);
  if (pollTimer) clearInterval(pollTimer);
});
// 倒计时归零：立刻拉一次，让服务端换新码顶上来（轮询最坏要等 10 秒）
watch(remainSec, (v) => { if (v === 0 && cfg.value.bindExpiresAt) refreshBind(); });
watch(() => form.devMode, (v) => { if (v) message.warning('开发模式已开启，公网环境请及时关闭'); });
</script>

<style scoped>
.overview { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin-bottom: 16px; }
.ov { background: #fff; border: 1px solid var(--pg-border); border-radius: 12px; padding: 12px 14px; min-width: 0; }
.ov-label { font-size: 12px; color: var(--pg-muted); }
.ov-value { font-size: 15px; font-weight: 650; margin: 4px 0 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ov-value.mono { font-size: 13px; font-weight: 600; }
.ov-foot { font-size: 12px; color: var(--pg-muted); display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
.ov-foot .warn { color: #d97706; }
.layout { display: grid; grid-template-columns: 1.18fr 0.82fr; gap: 16px; align-items: start; }
.col { display: grid; gap: 14px; }
.grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 0 14px; }
.switches { display: grid; gap: 10px; margin: 4px 0 10px; }
.sw { display: flex; gap: 10px; align-items: flex-start; padding: 10px 12px; border: 1px solid var(--pg-border); border-radius: 10px; cursor: pointer; }
.sw:hover { background: #fafcfe; }
.sw-title { font-size: 13px; font-weight: 550; }
.sw-desc { font-size: 11.5px; color: var(--pg-muted); margin-top: 2px; }
.bind { display: flex; gap: 16px; align-items: flex-start; }
.qr { width: 150px; height: 150px; flex: 0 0 150px; border: 1px solid var(--pg-border); border-radius: 12px; padding: 8px; display: grid; place-items: center; background: #fff; }
.qr img { width: 100%; height: 100%; }
.token-line { display: flex; align-items: center; gap: 8px; margin-top: 10px; flex-wrap: wrap; }
.token-line code { background: #f1f5f9; padding: 3px 8px; border-radius: 6px; font-size: 12px; }
.bind-meta { display: flex; align-items: center; gap: 8px; margin-top: 8px; flex-wrap: wrap; font-size: 12px; }
.bind-meta .muted { font-size: 11.5px; }
.code { background: #0f172a; color: #cbd5e1; padding: 14px; border-radius: 10px; font-size: 12px; line-height: 1.7; overflow-x: auto; margin: 0; }
@media (max-width: 1200px) {
  .overview { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .layout { grid-template-columns: 1fr; }
}
@media (max-width: 640px) {
  .overview { grid-template-columns: 1fr; }
  .grid2 { grid-template-columns: 1fr; }
  .bind { flex-direction: column; }
}
</style>
