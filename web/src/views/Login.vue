<template>
  <div class="auth-wrap">
    <div class="auth-hero">
      <div class="hero-brand">
        <div class="hero-logo">PG</div>
        <div>
          <div class="hero-name">printgate</div>
          <div class="hero-sub">打印网关管理台</div>
        </div>
      </div>
      <h1>把打印机接到<br />你的每一个入口</h1>
      <p class="hero-desc">
        CUPS 队列、微信小程序、内网穿透、扫描仪 —— 一个后台统一管理。所有操作留痕，权限可控。
      </p>
      <div class="hero-badges">
        <div class="badge"><b>{{ store.boot.version || '2.0' }}</b><span>版本</span></div>
        <div class="badge"><b>{{ store.boot.wxConfigured ? '已配置' : '待配置' }}</b><span>小程序</span></div>
        <div class="badge"><b>{{ store.boot.qrLoginEnabled ? '可用' : '关闭' }}</b><span>扫码登录</span></div>
      </div>
    </div>

    <div class="auth-card">
      <h2>{{ store.boot.passwordLoginEnabled ? '登录 PrintGate' : '微信扫码登录' }}</h2>
      <p class="muted" style="margin: 6px 0 20px">
        {{ store.boot.passwordLoginEnabled
          ? '管理员用密码进入后台；普通用户扫码登录后只能打印和查看自己的记录。'
          : '管理员已关闭密码登录，请用微信扫码进入。' }}
      </p>

      <n-tabs v-model:value="tab" type="segment" animated class="login-tabs" style="margin-bottom: 18px">
        <n-tab-pane v-if="store.boot.passwordLoginEnabled" name="password" tab="密码登录">
          <n-input
            v-model:value="password" type="password" size="large" show-password-on="click"
            placeholder="管理员密码" :input-props="{ autocomplete: 'current-password' }"
            @keyup.enter="submit"
          >
            <template #prefix><n-icon :component="LockClosedOutline" /></template>
          </n-input>
          <n-alert v-if="lockedMsg" type="warning" :bordered="false" style="margin-top: 14px">{{ lockedMsg }}</n-alert>
          <n-alert v-else-if="errorMsg" type="error" :bordered="false" style="margin-top: 14px">{{ errorMsg }}</n-alert>
          <n-button type="primary" size="large" block :loading="loading" style="margin-top: 18px" @click="submit">
            登 录
          </n-button>
        </n-tab-pane>

        <n-tab-pane v-if="store.boot.qrLoginEnabled" name="qr" tab="扫码登录">
          <!-- 没配 AppID 时后端直接 400，这里必须给出明确说明，否则用户只看到一个永远转圈的圈 -->
          <div v-if="!store.boot.wxConfigured" class="qr-box">
            <n-alert type="warning" :bordered="false" style="width: 100%">
              <div style="font-weight: 600; margin-bottom: 4px">扫码登录暂不可用</div>
              还没有配置小程序 AppID / AppSecret，二维码无法生成。
              请先到「小程序对接」页填写凭据，再回到本页刷新。
            </n-alert>
          </div>
          <div v-else class="qr-box">
            <div v-if="qrData" class="qr-frame">
              <img :src="qrData" alt="扫码登录二维码" />
              <div v-if="qrStatus === 'scanned'" class="qr-mask">已扫描，请在手机上确认</div>
              <div v-if="qrStatus === 'expired'" class="qr-mask expired">
                <div>二维码已过期</div>
                <n-button size="tiny" type="primary" @click="createQr">刷新</n-button>
              </div>
            </div>
            <n-spin v-else size="large" />
            <div class="qr-tip">
              <div class="qr-title">用微信扫码登录</div>
              <div class="muted" style="font-size: 12px; line-height: 1.8">
                管理员与已授权用户都可扫码：管理员进管理台，普通用户进打印门户（仅打印与自己的记录）。<br />
                管理员首次登录：进入小程序 → 我的 → 扫码绑定，扫描后台「小程序对接」页的绑定码。
              </div>
              <n-button quaternary size="small" style="margin-top: 8px" @click="createQr">刷新二维码</n-button>
            </div>
          </div>
        </n-tab-pane>

        <!-- 普通用户：账号 + 密码，注册与登录在同一个 Tab 里切换 -->
        <n-tab-pane name="account" tab="普通用户">
          <n-form v-if="accMode === 'login'" @keyup.enter="submitAccount">
            <n-input v-model:value="acc.username" size="large" placeholder="用户名" :input-props="{ autocomplete: 'username' }">
              <template #prefix><n-icon :component="PersonOutline" /></template>
            </n-input>
            <n-input
              v-model:value="acc.password" type="password" size="large" show-password-on="click"
              placeholder="密码" style="margin-top: 12px" :input-props="{ autocomplete: 'current-password' }"
            >
              <template #prefix><n-icon :component="LockClosedOutline" /></template>
            </n-input>
            <n-alert v-if="accLocked" type="warning" :bordered="false" style="margin-top: 14px">{{ accLocked }}</n-alert>
            <n-alert v-else-if="accErr" type="error" :bordered="false" style="margin-top: 14px">{{ accErr }}</n-alert>
            <n-button type="primary" size="large" block :loading="accLoading" style="margin-top: 18px" @click="submitAccount">
              登 录
            </n-button>
            <div class="reg-line">
              <span class="muted">还没有账号？</span>
              <n-button v-if="store.boot.userRegisterEnabled" text type="primary" size="small" @click="switchAcc('register')">立即注册</n-button>
              <span v-else class="muted">管理员已关闭注册，请联系管理员开通</span>
            </div>
          </n-form>

          <n-form v-else @keyup.enter="submitAccount">
            <n-input v-model:value="acc.username" size="large" placeholder="用户名（3-32 位小写字母/数字）" :input-props="{ autocomplete: 'username' }">
              <template #prefix><n-icon :component="PersonOutline" /></template>
            </n-input>
            <n-input v-model:value="acc.nickname" size="large" placeholder="昵称（选填，默认同用户名）" style="margin-top: 12px" />
            <n-input
              v-model:value="acc.password" type="password" size="large" show-password-on="click"
              placeholder="密码（至少 8 位，含字母和数字）" style="margin-top: 12px" :input-props="{ autocomplete: 'new-password' }"
            >
              <template #prefix><n-icon :component="LockClosedOutline" /></template>
            </n-input>
            <n-input
              v-model:value="acc.confirm" type="password" size="large" show-password-on="click"
              placeholder="确认密码" style="margin-top: 12px" :input-props="{ autocomplete: 'new-password' }"
            >
              <template #prefix><n-icon :component="LockClosedOutline" /></template>
            </n-input>
            <n-alert v-if="accErr" type="error" :bordered="false" style="margin-top: 14px">{{ accErr }}</n-alert>
            <n-button type="primary" size="large" block :loading="accLoading" style="margin-top: 18px" @click="submitAccount">
              注册并登录
            </n-button>
            <div class="reg-line">
              <span class="muted">已有账号？</span>
              <n-button text type="primary" size="small" @click="switchAcc('login')">直接登录</n-button>
            </div>
            <div v-if="store.boot.approveNewUser" class="muted" style="margin-top: 10px; font-size: 12px; line-height: 1.7">
              注册后需要管理员审批，通过后即可打印。
            </div>
          </n-form>
        </n-tab-pane>

      </n-tabs>
    </div>
  </div>
</template>

<script setup>
import { onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { useMessage } from 'naive-ui';
import { LockClosedOutline, PersonOutline } from '@vicons/ionicons5';
import { api } from '../api';
import { login, loadBootstrap, loginWithToken, store } from '../store';

const router = useRouter();
const message = useMessage();
// 密码登录被管理员关掉时，默认落在扫码 Tab（否则会看到一个空白的密码框）
const tab = ref(store.boot.passwordLoginEnabled ? 'password' : 'qr');
const password = ref('');
const loading = ref(false);
const errorMsg = ref('');
const lockedMsg = ref('');

// 普通用户账号体系（用户名 + 密码）
const accMode = ref('login');            // login | register
const acc = reactive({ username: '', nickname: '', password: '', confirm: '' });
const accLoading = ref(false);
const accErr = ref('');
const accLocked = ref('');

const qrData = ref('');
const qrStatus = ref('pending');
const ticket = ref('');
const pollFail = ref(0);
let pollTimer = null;
let expireTimer = null;

async function submit() {
  if (!password.value) { errorMsg.value = '请输入密码'; return; }
  loading.value = true;
  errorMsg.value = '';
  lockedMsg.value = '';
  try {
    await login(password.value);
    message.success('登录成功');
    router.replace({ name: 'dashboard' });
  } catch (e) {
    if (e.status === 429) {
      lockedMsg.value = e.message;
    } else if (e.data && e.data.code === 'PASSWORD_LOGIN_DISABLED') {
      // 管理员刚把密码登录关掉：本页还停着旧状态，刷一次并把用户带到扫码 Tab
      await loadBootstrap(true);
      lockedMsg.value = e.message;
      if (store.boot.qrLoginEnabled) {
        tab.value = 'qr';
        if (!qrData.value) createQr();
      }
    } else {
      errorMsg.value = e.message;
    }
  } finally {
    loading.value = false;
  }
}

function switchAcc(mode) {
  accMode.value = mode;
  accErr.value = '';
  accLocked.value = '';
  acc.password = '';
  acc.confirm = '';
}

// 注册与登录共用一个提交入口：注册成功会直接登录（待审批时门户里会显示横幅）
async function submitAccount() {
  accLoading.value = true;
  accErr.value = '';
  accLocked.value = '';
  try {
    if (accMode.value === 'register') {
      if (!acc.username.trim()) throw Object.assign(new Error('请输入用户名'), { status: 400 });
      if (!acc.password) throw Object.assign(new Error('请输入密码'), { status: 400 });
      if (acc.password !== acc.confirm) throw Object.assign(new Error('两次输入的密码不一致'), { status: 400 });
      const d = await api.post('/auth/account/register', {
        username: acc.username.trim(),
        password: acc.password,
        confirm: acc.confirm,
        nickname: acc.nickname.trim()
      });
      await loginWithToken(d.token, 'user', d.user);
      message.success(d.msg || '注册成功');
      router.replace({ name: 'portal' });
      return;
    }
    if (!acc.username.trim() || !acc.password) throw Object.assign(new Error('请输入用户名和密码'), { status: 400 });
    const d = await api.post('/auth/account/login', { username: acc.username.trim(), password: acc.password });
    await loginWithToken(d.token, 'user', d.user);
    message.success('登录成功');
    router.replace({ name: 'portal' });
  } catch (e) {
    if (e.status === 429) accLocked.value = e.message;
    else accErr.value = e.message;
  } finally {
    accLoading.value = false;
  }
}

function stopPolling() {
  clearInterval(pollTimer);
  pollTimer = null;
}

async function createQr() {
  try {
    const d = await api.post('/auth/qr/create');
    qrData.value = d.qr;
    ticket.value = d.ticket;
    qrStatus.value = 'pending';
    pollFail.value = 0;
    stopPolling();
    clearTimeout(expireTimer);
    // 5 秒轮询一次扫码状态：太密没必要，太慢用户会觉得没反应
    pollTimer = setInterval(pollQr, 5000);
    expireTimer = setTimeout(() => {
      qrStatus.value = 'expired';
      stopPolling();
    }, (d.expiresIn || 120) * 1000);
  } catch (e) {
    message.error(e.message);
    qrData.value = '';
  }
}

async function pollQr() {
  if (!ticket.value) return;
  try {
    const d = await api.get(`/auth/qr/status?ticket=${encodeURIComponent(ticket.value)}`);
    pollFail.value = 0;
    qrStatus.value = d.status;
    if (d.status === 'confirmed' && d.token) {
      stopPolling();
      const role = d.role === 'user' ? 'user' : 'admin';
      await loginWithToken(d.token, role, d.user || null);
      message.success(role === 'user' ? '登录成功，已进入打印门户' : '扫码登录成功');
      router.replace({ name: role === 'user' ? 'portal' : 'dashboard' });
    }
    if (d.status === 'expired' || d.status === 'denied') {
      stopPolling();
      if (d.status === 'denied') message.error(d.msg || '该微信不是管理员');
    }
  } catch (_) {
    // 轮询失败不能一直静默，否则用户会对着一个已经断线的二维码干等
    pollFail.value += 1;
    if (pollFail.value === 3) message.warning('网络异常，正在重试…');
  }
}

onMounted(async () => {
  // 管理员可能刚关掉密码登录，必须重取一次引导信息，否则这里还会显示密码输入框
  await loadBootstrap(true);
  if (store.boot.needsSetup) { router.replace({ name: 'setup' }); return; }
  if (!store.boot.passwordLoginEnabled && tab.value === 'password') {
    tab.value = store.boot.qrLoginEnabled ? 'qr' : 'account';
  }
  // 管理员关掉自助注册时，别停在一个已经不存在的 Tab 上
  // 注册被关闭时不能停在注册表单上：退回登录形态（账号仍可正常登录）
  if (!store.boot.userRegisterEnabled && accMode.value === 'register') {
    switchAcc('login');
  }
  // 默认就落在扫码 Tab 时（密码登录被关），watch 不会触发，这里补一次生成二维码
  if (tab.value === 'qr' && store.boot.qrLoginEnabled && store.boot.wxConfigured) createQr();
});

// 切回密码登录时必须停轮询：否则会在后台空转最多 60 次，白耗请求与接口限流额度
watch(tab, (v) => {
  if (v === 'qr') {
    if (!store.boot.wxConfigured) return;   // 未配置时不打扰，页面已有明确提示
    if (!qrData.value) createQr();
    else if (!pollTimer) // 5 秒轮询一次扫码状态：太密没必要，太慢用户会觉得没反应
    pollTimer = setInterval(pollQr, 5000);
  } else {
    stopPolling();
  }
});

onBeforeUnmount(() => {
  stopPolling();
  clearTimeout(expireTimer);
});
</script>

<style scoped>
.auth-wrap { min-height: 100vh; display: grid; grid-template-columns: 1.05fr .95fr; }
.auth-hero {
  background: radial-gradient(1200px 600px at 0% 0%, #115e59 0%, #0b3b3a 45%, #062523 100%);
  color: #e6fffb; padding: 64px 56px; display: flex; flex-direction: column; justify-content: center;
}
.hero-brand { display: flex; align-items: center; gap: 12px; margin-bottom: 44px; }
.hero-logo {
  width: 44px; height: 44px; border-radius: 12px; background: rgba(255,255,255,.14);
  display: grid; place-items: center; font-weight: 700;
}
.hero-name { font-size: 18px; font-weight: 700; letter-spacing: .3px; }
.hero-sub { font-size: 12px; opacity: .7; }
.auth-hero h1 { font-size: 32px; line-height: 1.35; margin: 0 0 16px; letter-spacing: -.6px; }
.hero-desc { opacity: .82; line-height: 1.8; max-width: 420px; margin: 0; }
.hero-badges { display: flex; gap: 12px; margin-top: 34px; }
.badge {
  background: rgba(255,255,255,.07); border: 1px solid rgba(94,234,212,.22); border-radius: 12px;
  padding: 10px 16px; display: grid; gap: 2px; min-width: 86px;
}
.badge b { font-size: 15px; }
.badge span { font-size: 11px; opacity: .65; }
.auth-card { background: #fff; padding: 56px 52px; display: flex; flex-direction: column; justify-content: center; }
.auth-card h2 { margin: 0; font-size: 22px; }
.login-tabs :deep(.n-tab-pane) { padding-top: 6px; }
.qr-box { display: flex; gap: 20px; align-items: center; }
.qr-frame { position: relative; width: 180px; height: 180px; border-radius: 14px; overflow: hidden; border: 1px solid var(--pg-border); flex: 0 0 180px; }
.qr-frame img { width: 100%; height: 100%; display: block; }
.qr-mask {
  position: absolute; inset: 0; background: rgba(15,23,42,.72); color: #fff; display: grid; place-items: center;
  font-size: 13px; text-align: center; padding: 10px;
}
.qr-mask.expired { gap: 10px; display: flex; flex-direction: column; }
.qr-title { font-weight: 600; margin-bottom: 4px; }
.reg-line { display: flex; align-items: center; gap: 8px; margin-top: 14px; font-size: 12.5px; }
@media (max-width: 900px) {
  .auth-wrap { grid-template-columns: 1fr; }
  .auth-hero { display: none; }
  .auth-card { padding: 40px 24px; min-height: 100vh; }
  .qr-box { flex-direction: column; align-items: flex-start; }
}
</style>
