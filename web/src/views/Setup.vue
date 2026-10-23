<template>
  <div class="auth-wrap">
    <div class="auth-hero">
      <div class="hero-brand">
        <div class="hero-logo">PG</div>
        <div>
          <div class="hero-name">printgate</div>
          <div class="hero-sub">打印网关 · 一次性初始化</div>
        </div>
      </div>
      <h1>欢迎使用 PrintGate</h1>
      <p class="hero-desc">
        这是首次启动。为管理后台设置一个强密码，即可开始接入打印机、CUPS 队列、微信小程序与内网穿透。
      </p>
      <ul class="hero-list">
        <li><span class="dot"></span>密码使用 scrypt 加盐散列存储，服务端不留明文</li>
        <li><span class="dot"></span>登录失败次数超限会自动锁定，防暴力破解</li>
        <li><span class="dot"></span>初始化完成后可扫码绑定管理员微信，开启扫码登录</li>
      </ul>
    </div>

    <div class="auth-card">
      <h2>设置管理员密码</h2>
      <p class="muted" style="margin: 6px 0 22px">至少 8 位，需同时包含字母与数字。</p>
      <n-form ref="formRef" :model="form" :rules="rules" label-placement="top" @submit.prevent="submit">
        <n-form-item label="管理员密码" path="password">
          <n-input v-model:value="form.password" type="password" show-password-on="click" size="large" placeholder="请输入密码">
            <template #prefix><n-icon :component="LockClosedOutline" /></template>
          </n-input>
        </n-form-item>
        <n-form-item label="确认密码" path="confirm">
          <n-input v-model:value="form.confirm" type="password" show-password-on="click" size="large" placeholder="再次输入密码" @keyup.enter="submit">
            <template #prefix><n-icon :component="ShieldCheckmarkOutline" /></template>
          </n-input>
        </n-form-item>
        <div class="strength">
          <div v-for="i in 3" :key="i" class="bar" :class="{ on: strength >= i }"></div>
          <span class="muted">{{ strengthText }}</span>
        </div>
        <n-button type="primary" size="large" block :loading="loading" style="margin-top: 18px" @click="submit">
          完成初始化并进入后台
        </n-button>
      </n-form>
      <div class="muted" style="margin-top: 16px; font-size: 12px">
        初始化后如需找回密码：删除数据卷中的 printgate.db 会重置全部数据，请谨慎操作。
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, reactive, ref } from 'vue';
import { useRouter } from 'vue-router';
import { useMessage } from 'naive-ui';
import { LockClosedOutline, ShieldCheckmarkOutline } from '@vicons/ionicons5';
import { setupAdmin } from '../store';

const router = useRouter();
const message = useMessage();
const loading = ref(false);
const formRef = ref(null);
const form = reactive({ password: '', confirm: '' });

const rules = {
  password: [{ required: true, message: '请输入密码', trigger: ['blur', 'input'] }],
  confirm: [{
    required: true,
    validator: (r, v) => (v === form.password ? true : new Error('两次输入的密码不一致')),
    trigger: ['blur', 'input']
  }]
};

const strength = computed(() => {
  const p = form.password;
  let s = 0;
  if (p.length >= 8) s++;
  if (/[A-Za-z]/.test(p) && /[0-9]/.test(p)) s++;
  if (p.length >= 12 && /[^A-Za-z0-9]/.test(p)) s++;
  return s;
});
const strengthText = computed(() => ['太弱', '较弱', '中等', '很强'][strength.value] || '太弱');

async function submit() {
  if (loading.value) return;
  loading.value = true;
  try {
    await setupAdmin(form.password, form.confirm);
    message.success('初始化完成');
    router.replace({ name: 'dashboard' });
  } catch (e) {
    message.error(e.message);
  } finally {
    loading.value = false;
  }
}
</script>

<style scoped>
.auth-wrap { min-height: 100vh; display: grid; grid-template-columns: 1.05fr .95fr; background: #f5f7fa; }
.auth-hero {
  background: linear-gradient(155deg, #0b3b3a 0%, #0f766e 55%, #0ea5a4 100%);
  color: #e6fffb; padding: 64px 56px; display: flex; flex-direction: column; justify-content: center;
}
.hero-brand { display: flex; align-items: center; gap: 12px; margin-bottom: 40px; }
.hero-logo {
  width: 44px; height: 44px; border-radius: 12px; background: rgba(255,255,255,.16);
  display: grid; place-items: center; font-weight: 700; letter-spacing: .5px;
}
.hero-name { font-size: 18px; font-weight: 700; }
.hero-sub { font-size: 12px; opacity: .75; }
.auth-hero h1 { font-size: 30px; margin: 0 0 14px; letter-spacing: -.5px; }
.hero-desc { line-height: 1.75; opacity: .88; max-width: 420px; margin: 0; }
.hero-list { list-style: none; padding: 0; margin: 26px 0 0; display: grid; gap: 12px; font-size: 13px; opacity: .92; }
.hero-list li { display: flex; gap: 10px; align-items: flex-start; }
.hero-list .dot { width: 6px; height: 6px; border-radius: 50%; background: #5eead4; margin-top: 7px; flex: 0 0 6px; }
.auth-card { background: #fff; padding: 56px 52px; display: flex; flex-direction: column; justify-content: center; }
.auth-card h2 { margin: 0; font-size: 22px; }
.strength { display: flex; align-items: center; gap: 6px; margin-top: 2px; }
.strength .bar { height: 4px; width: 46px; border-radius: 4px; background: #e5e7eb; }
.strength .bar.on:nth-child(1) { background: #ef4444; }
.strength .bar.on:nth-child(2) { background: #f59e0b; }
.strength .bar.on:nth-child(3) { background: #16a34a; }
.strength span { margin-left: 6px; font-size: 12px; }
@media (max-width: 900px) {
  .auth-wrap { grid-template-columns: 1fr; }
  .auth-hero { display: none; }
  .auth-card { padding: 40px 24px; min-height: 100vh; }
}
</style>
