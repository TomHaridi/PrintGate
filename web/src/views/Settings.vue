<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h1 class="page-title">系统设置</h1>
        <div class="page-desc">所有配置实时生效并持久化到数据库，重启后保持</div>
      </div>
      <n-button size="small" :loading="loading" @click="load">
        <template #icon><n-icon :component="RefreshOutline" /></template>重新读取
      </n-button>
    </div>

    <n-spin :show="loading">
      <n-tabs v-model:value="tab" type="line" animated>
        <!-- 打印 -->
        <n-tab-pane name="print" tab="打印与文件">
          <n-card size="small">
            <template #header>
              <div class="card-hd">
                <span class="card-title">打印与文件</span>
                <span class="card-meta">默认打印机、上传限制与审批策略</span>
              </div>
            </template>
            <n-form label-placement="top">
              <div class="grid2">
                <n-form-item label="默认打印机">
                  <n-select v-model:value="print.defaultPrinter" :options="printerOptions" clearable placeholder="选择默认队列" />
                </n-form-item>
                <n-form-item label="CUPS 服务地址">
                  <n-input v-model:value="print.cupsServer" placeholder="127.0.0.1:631" />
                </n-form-item>
              </div>
              <div class="grid3">
                <n-form-item label="单文件上限（MB）">
                  <n-input-number v-model:value="print.maxFileMB" :min="1" :max="2048" style="width: 100%" />
                </n-form-item>
                <n-form-item label="单任务最大份数">
                  <n-input-number v-model:value="print.maxCopies" :min="1" :max="999" style="width: 100%" />
                </n-form-item>
                <n-form-item label="单任务最大页数">
                  <n-input-number v-model:value="print.maxPages" :min="1" :max="2000" style="width: 100%" />
                </n-form-item>
              </div>
              <n-form-item label="打印审批">
                <n-radio-group v-model:value="print.approveEachJob">
                  <n-radio :value="false">直接打印</n-radio>
                  <n-radio :value="true">逐单审批（提交后需管理员放行）</n-radio>
                </n-radio-group>
              </n-form-item>
              <n-alert :type="features.officeConvert ? 'success' : 'warning'" :bordered="false">
                <div>
                  Office 文档转换组件（LibreOffice，docx/xlsx/pptx → PDF）。当前：<b>{{ features.officeConvert ? '已安装' : '未安装' }}</b>
                  <template v-if="features.officeVersion">（{{ features.officeVersion }}）</template>
                  <n-button text size="tiny" style="margin-left: 6px" :loading="rechecking" @click="recheckOffice">重新检测</n-button>
                </div>
                <div v-if="!features.officeConvert" class="office-hint">
                  <div class="office-row"><span class="k">开启</span>重新构建镜像时加 <span class="mono">--build-arg WITH_OFFICE=1</span>，会安装 writer/calc/impress（约 50MB）</div>
                  <div class="office-row"><span class="k">替代</span>上传前先把文档转成 PDF；上传 .docx 时会收到明确提示</div>
                </div>
                <div v-else class="office-hint">
                  <div class="office-row"><span class="k">支持</span>doc / docx / xls / xlsx / ppt / pptx / odt / ods 等常见格式，上传后自动转 PDF 打印</div>
                </div>
              </n-alert>
              <n-button type="primary" style="margin-top: 14px" :loading="saving" @click="save">保存</n-button>
            </n-form>
          </n-card>
        </n-tab-pane>

        <!-- 安全 -->
        <n-tab-pane name="security" tab="安全">
          <div class="layout">
            <n-card size="small">
            <template #header>
              <div class="card-hd">
                <span class="card-title">登录与防爆破</span>
              </div>
            </template>
              <n-form label-placement="top">
                <div class="grid2">
                  <n-form-item label="失败多少次后锁定">
                    <n-input-number v-model:value="security.loginMaxFail" :min="1" :max="50" style="width: 100%" />
                  </n-form-item>
                  <n-form-item label="锁定时长（分钟）">
                    <n-input-number v-model:value="security.loginLockMin" :min="1" :max="1440" style="width: 100%" />
                  </n-form-item>
                </div>
                <n-form-item label="登录有效期（小时）">
                  <n-input-number v-model:value="security.sessionHours" :min="1" :max="720" style="width: 100%" />
                </n-form-item>
                <n-space vertical size="small">
                  <n-checkbox v-model:checked="security.enableQrLogin">允许微信扫码登录</n-checkbox>
                  <n-checkbox v-model:checked="security.enablePasswordLogin">允许管理员密码登录</n-checkbox>
                  <div class="hint">
                    关掉密码登录后，登录页只保留微信扫码。两项不能同时关闭，否则任何账号都进不来。
                  </div>
                  <n-checkbox v-model:checked="security.enableUserRegister">允许普通用户自助注册</n-checkbox>
                  <div class="hint">
                    关闭后登录页不再显示「普通用户注册」入口，新微信登录也不会自动建号；
                    只能在「小程序用户 → 添加用户」里手工登记 OpenID 开号。
                  </div>
                  <n-checkbox v-model:checked="security.approveNewUser">小程序新用户需审批</n-checkbox>
                  <n-checkbox v-model:checked="security.guestMode">访客模式（仅查看，不允许打印）</n-checkbox>
                  <n-checkbox v-model:checked="security.hideUserAdvanced">
                    隐藏普通用户的详细打印设置（份数 / 色彩 / 单双面 / 纸张）
                  </n-checkbox>
                  <div class="hint">
                    普通用户网页与小程序里只能「选文件 → 选打印机 → 打印」，参数固定为单份 / 黑白 / 单面 / A4；
                    它们仍然只能打印、看自己的记录、一键清空自己的历史。
                  </div>
                  <n-checkbox v-model:checked="security.devMode">开发模式（开启模拟登录接口，仅本机联调）</n-checkbox>
                </n-space>
                <n-button type="primary" style="margin-top: 14px" :loading="saving" @click="save">保存</n-button>
              </n-form>
            </n-card>

            <n-card size="small">
            <template #header>
              <div class="card-hd">
                <span class="card-title">修改管理员密码</span>
              </div>
            </template>
              <n-form label-placement="top">
                <n-form-item label="当前密码">
                  <n-input v-model:value="pwd.oldPassword" type="password" show-password-on="click" />
                </n-form-item>
                <n-form-item label="新密码（≥8 位，含字母和数字）">
                  <n-input v-model:value="pwd.newPassword" type="password" show-password-on="click" />
                </n-form-item>
                <n-form-item label="确认新密码">
                  <n-input v-model:value="pwd.confirm" type="password" show-password-on="click" />
                </n-form-item>
                <n-button type="primary" :loading="pwdSaving" @click="changePassword">修改密码</n-button>
              </n-form>
              <n-alert type="warning" :bordered="false" style="margin-top: 14px">
                修改后当前会话仍然有效；其他设备需重新登录。忘记密码只能在服务器重置数据卷。
              </n-alert>
            </n-card>
          </div>

<n-card size="small" style="margin-top: 16px">            <template #header>
              <div class="card-hd">
                <span class="card-title">登录失败记录</span>
                
                
                <div class="card-hd-right"><div class="row">
                <n-tag :type="fails24 ? 'warning' : 'success'" :bordered="false" size="small">24 小时失败 {{ fails24 }} 次</n-tag>
                <n-button size="tiny" quaternary type="error" @click="clearAttempts">清空并解锁</n-button>
              </div></div>
              </div>
            </template>
            <div v-if="attempts.length" class="attempts">
              <div v-for="a in attempts.slice(0, 12)" :key="a.id" class="attempt">
                <span class="mono">{{ a.ip }}</span>
                <span class="muted">{{ a.kind === 'login' ? '后台登录' : '绑定码' }}</span>
                <n-tag size="tiny" :type="a.ok ? 'success' : 'error'" :bordered="false">{{ a.ok ? '成功' : '失败' }}</n-tag>
                <span class="muted">{{ fmtTime(a.created_at) }}</span>
              </div>
            </div>
            <n-empty v-else description="暂无失败记录" style="padding: 20px 0" />
          </n-card>
        </n-tab-pane>

        <!-- 小程序：参数已集中到「小程序对接」页，这里只做状态展示与跳转 -->
        <n-tab-pane name="wechat" tab="小程序">
          <n-card size="small">
            <template #header>
              <div class="card-hd">
                <span class="card-title">小程序接入参数</span>
              </div>
            </template>
            <n-alert type="info" :bordered="false" style="margin-bottom: 14px">
              AppID、AppSecret、接入地址、管理员白名单与策略开关已统一收到「小程序对接」页维护，
              这里不再重复填写，避免两处保存互相覆盖。
            </n-alert>
            <div class="kv"><span>小程序凭据</span><b>{{ settings.wechat?.wxAppid ? '已配置' : '未配置' }}</b></div>
            <div class="kv"><span>AppID</span><b class="mono">{{ settings.wechat?.wxAppid || '—' }}</b></div>
            <div class="kv"><span>AppSecret</span><b class="mono">{{ settings.wechat?.wxSecretConfigured ? settings.wechat.wxSecret : '未配置' }}</b></div>
            <div class="kv"><span>扫码登录</span><b>{{ settings.security?.enableQrLogin ? '已开启' : '已关闭' }}</b></div>
            <div class="kv"><span>密码登录</span><b>{{ settings.security?.enablePasswordLogin === false ? '已关闭' : '已开启' }}</b></div>
            <div class="kv"><span>新用户审批</span><b>{{ settings.security?.approveNewUser ? '需要审批' : '自动放行' }}</b></div>
            <div class="row" style="margin-top: 14px">
              <n-button type="primary" @click="$router.push('/wechat')">去维护接入参数</n-button>
              <n-button @click="$router.push('/users')">小程序用户</n-button>
            </div>
          </n-card>
        </n-tab-pane>

        <!-- 中转：参数统一在「中转对接」页维护 -->
        <n-tab-pane name="relay" tab="中转与穿透">
          <n-card size="small">
            <template #header>
              <div class="card-hd">
                <span class="card-title">frp 内网穿透</span>
              </div>
            </template>
            <n-alert type="info" :bordered="false" style="margin-bottom: 14px">
              穿透模式、域名、服务端、Token 与配置片段已集中到「中转对接」页的分步向导，这里不再重复填写，
              避免两处保存互相覆盖。
            </n-alert>
            <div class="kv"><span>当前模式</span><b>{{ settings.relay?.frpMode === 'wss' ? '单端口 443（wss 复用）' : '独立端口 TCP' }}</b></div>
            <div class="kv"><span>服务端</span><b class="mono">{{ settings.relay?.frpServer ? `${settings.relay.frpServer}:${settings.relay.frpPort}` : '未配置' }}</b></div>
            <div class="kv"><span>隧道端口</span><b class="mono">{{ settings.relay?.frpRemotePort || '—' }}</b></div>
            <div class="kv"><span>对外地址</span><b class="mono">{{ settings.relay?.relayPublicUrl || '未设置' }}</b></div>
            <div class="kv"><span>启用状态</span><b>{{ settings.relay?.enableFrp ? '已启用' : '未启用' }}</b></div>
            <div class="row" style="margin-top: 14px">
              <n-button type="primary" @click="$router.push('/relay')">打开中转向导</n-button>
            </div>
          </n-card>
        </n-tab-pane>

        <!-- 数据 -->
        <n-tab-pane name="storage" tab="数据与维护">
          <div class="layout">
            <n-card size="small">
            <template #header>
              <div class="card-hd">
                <span class="card-title">保留与清理</span>
              </div>
            </template>
              <n-form label-placement="top">
                <n-form-item label="上传文件保留天数">
                  <n-input-number v-model:value="storage.retentionDays" :min="1" :max="3650" style="width: 100%" />
                </n-form-item>
                <n-button type="primary" :loading="saving" @click="save">保存</n-button>
              </n-form>
              <n-divider />
              <div class="kv"><span>上传文件</span><b>{{ storageInfo.files }} 个 · {{ fmtBytes(storageInfo.uploads) }}</b></div>
              <div class="kv"><span>扫描文件</span><b>{{ fmtBytes(storageInfo.scans) }}</b></div>
              <div class="kv"><span>数据库</span><b>{{ fmtBytes(storageInfo.db) }}</b></div>
              <div class="kv"><span>磁盘可用</span><b>{{ fmtBytes(storageInfo.disk?.free) }} / {{ fmtBytes(storageInfo.disk?.total) }}</b></div>
              <div class="row" style="margin-top: 12px">
                <n-button size="small" @click="cleanupNow">立即清理过期数据</n-button>
                <n-button size="small" @click="backup">下载数据库备份</n-button>
              </div>
            </n-card>

            <n-card size="small">
            <template #header>
              <div class="card-hd">
                <span class="card-title">运行日志</span>
              </div>
            </template>
              <div class="muted" style="line-height: 1.9; font-size: 13px">
                日志按天滚动，默认保留在容器内 <span class="mono">/var/log/printgate</span>；
                CUPS 日志位于 <span class="mono">/var/log/cups</span>。
              </div>
              <div class="row" style="margin-top: 12px">
                <n-button size="small" @click="$router.push('/logs')">查看日志</n-button>
                <n-button size="small" @click="$router.push('/system')">系统状态</n-button>
              </div>
              <n-divider />
              <div class="muted" style="font-size: 12.5px; line-height: 1.9">
                提示：容器重启不会丢失配置（数据卷 <span class="mono">/data</span>）；CUPS 队列保存在
                <span class="mono">/etc/cups</span>，建议一并挂载持久化。
              </div>
            </n-card>
          </div>
        </n-tab-pane>
      </n-tabs>
    </n-spin>
  </div>
</template>

<script setup>
import { onMounted, reactive, ref } from 'vue';
import { useRoute } from 'vue-router';
import { useMessage, useDialog } from 'naive-ui';
import { RefreshOutline } from '@vicons/ionicons5';
import { api, fmtBytes, fmtTime } from '../api';

const route = useRoute();
const message = useMessage();
const dialog = useDialog();

const loading = ref(false);
const saving = ref(false);
const pwdSaving = ref(false);
const settings = ref({});
const features = ref({});
const rechecking = ref(false);

// 重新探测转换组件（服务端有 60s 缓存，强制走一次转换探测）
async function recheckOffice() {
  rechecking.value = true;
  try {
    const s = await api.get('/settings?officeProbe=1');
    features.value = s.features || {};
    message.success(features.value.officeConvert ? `检测到转换组件：${features.value.officeVersion || '已安装'}` : '仍未检测到转换组件');
  } catch (e) { message.error(e.message); }
  finally { rechecking.value = false; }
}
const printerOptions = ref([]);
const attempts = ref([]);
const fails24 = ref(0);
const storageInfo = ref({});

const tab = ref(route.query.tab || 'print');

const print = reactive({ defaultPrinter: '', cupsServer: '127.0.0.1:631', maxFileMB: 200, maxCopies: 10, maxPages: 200, approveEachJob: false });
const security = reactive({
  loginMaxFail: 5, loginLockMin: 15, sessionHours: 24,
  enableQrLogin: true, enablePasswordLogin: true, enableUserRegister: true,
  approveNewUser: true, guestMode: false, devMode: false,
  hideUserAdvanced: false
});
const storage = reactive({ retentionDays: 30 });
const pwd = reactive({ oldPassword: '', newPassword: '', confirm: '' });

async function load() {
  loading.value = true;
  try {
    const [s, p, a, st] = await Promise.all([
      api.get('/settings'), api.get('/printers'), api.get('/security/attempts'), api.get('/settings/storage')
    ]);
    settings.value = s.settings || {};
    features.value = s.features || {};
    printerOptions.value = (p.printers || []).map((x) => ({ label: `${x.name}${x.isDefault ? '（默认）' : ''}`, value: x.name }));
    attempts.value = a.attempts || [];
    fails24.value = a.fails24 || 0;
    storageInfo.value = st.storage || {};

    Object.assign(print, settings.value.print, settings.value.cups || {});
    Object.assign(security, settings.value.security, { devMode: !!settings.value.dev?.devMode });
    Object.assign(storage, settings.value.storage || {});
  } catch (e) {
    message.error(e.message);
  } finally {
    loading.value = false;
  }
}

async function save() {
  saving.value = true;
  try {
    // 小程序参数与接入地址不在此页提交，避免与「小程序对接」页互相覆盖
    const payload = { ...print, ...security, ...storage };
    const d = await api.put('/settings', payload);
    settings.value = d.settings || settings.value;
    message.success(d.msg);
    load();
  } catch (e) {
    message.error(e.message);
  } finally {
    saving.value = false;
  }
}

async function changePassword() {
  if (pwd.newPassword !== pwd.confirm) { message.warning('两次输入的新密码不一致'); return; }
  pwdSaving.value = true;
  try {
    const d = await api.post('/auth/password', { ...pwd });
    message.success(d.msg);
    pwd.oldPassword = ''; pwd.newPassword = ''; pwd.confirm = '';
  } catch (e) {
    message.error(e.message);
  } finally {
    pwdSaving.value = false;
  }
}

function clearAttempts() {
  dialog.warning({
    title: '清空登录记录',
    content: '将解除所有 IP 的临时锁定，确定继续？',
    positiveText: '清空',
    negativeText: '取消',
    onPositiveClick: async () => {
      try {
        const d = await api.delete('/security/attempts');
        message.success(d.msg);
        load();
      } catch (e) { message.error(e.message); }
    }
  });
}

async function cleanupNow() {
  try {
    const d = await api.post('/settings/cleanup');
    message.success(d.msg);
    load();
  } catch (e) { message.error(e.message); }
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

onMounted(load);
</script>

<style scoped>
.layout { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; align-items: start; }
.grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 0 14px; }
.grid3 { display: grid; grid-template-columns: repeat(3, 1fr); gap: 0 14px; }
.hint { font-size: 11.5px; line-height: 1.7; color: var(--pg-muted); padding-left: 26px; max-width: 620px; }
.hint { font-size: 11.5px; line-height: 1.7; color: var(--pg-muted); padding-left: 26px; max-width: 620px; }
.kv { display: flex; justify-content: space-between; gap: 12px; padding: 7px 0; border-bottom: 1px dashed #eef2f6; font-size: 13px; }
.attempts { display: grid; gap: 6px; }
.attempt { display: grid; grid-template-columns: 140px 100px 70px 1fr; gap: 8px; align-items: center; font-size: 12.5px; }
@media (max-width: 1000px) { .layout { grid-template-columns: 1fr; } .grid3 { grid-template-columns: 1fr 1fr; } }
@media (max-width: 600px) { .grid2, .grid3 { grid-template-columns: 1fr; } }
.office-hint { margin-top: 8px; display: grid; gap: 4px; }
.office-row { font-size: 11.5px; line-height: 1.7; }
.office-row .k { display: inline-block; min-width: 34px; margin-right: 8px; color: #0f766e; font-weight: 550; }
.office-row .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; background: rgba(2,132,199,.08); border-radius: 4px; padding: 0 4px; }
</style>
