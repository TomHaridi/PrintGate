import { reactive } from 'vue';
import { api, token } from './api';

export const store = reactive({
  boot: {
    app: 'PrintGate', version: '', needsSetup: true,
    qrLoginEnabled: true, passwordLoginEnabled: true, wxConfigured: false, loaded: false
  },
  authed: !!token.get(),
  // 'admin' 管理台 / 'user' 普通用户打印门户；空串表示还没确认（首屏守卫会去问一次）
  role: '',
  me: null,
  loading: false
});

// 会话身份：同一套登录页，管理员进管理台，普通用户只进打印门户
export async function whoami(force = false) {
  if (store.role && !force) return { role: store.role, user: store.me };
  const d = await api.get('/auth/whoami');
  store.role = d.role || '';
  store.me = d.user || null;
  return d;
}

export function clearSession() {
  token.clear();
  store.authed = false;
  store.role = '';
  store.me = null;
}

// force=true 用于登录页：管理员可能刚改过「密码登录开关」，不重取就会拿到缓存的旧状态
export async function loadBootstrap(force = false) {
  if (store.boot.loaded && !force) return store.boot;
  try {
    const d = await api.get('/public/bootstrap');
    Object.assign(store.boot, d, { loaded: true });
  } catch (_) {
    store.boot.loaded = true;
  }
  return store.boot;
}

export async function login(password) {
  const d = await api.post('/auth/login', { password });
  token.set(d.token);
  store.authed = true;
  store.role = 'admin';
  store.me = d.user || { name: '管理员' };
  store.boot.needsSetup = false;
  return d;
}

export async function setupAdmin(password, confirm) {
  const d = await api.post('/setup', { password, confirm });
  token.set(d.token);
  store.authed = true;
  store.role = 'admin';
  store.me = { name: '管理员' };
  store.boot.needsSetup = false;
  return d;
}

export async function loginWithToken(t, role = 'admin', user = null) {
  token.set(t);
  store.authed = true;
  store.role = role;
  store.me = user;
}

export function logout() {
  clearSession();
}
