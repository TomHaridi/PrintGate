'use strict';
// 微信小程序：code2Session、扫码登录票据
const { cfg } = require('./db');

async function code2Session(code) {
  const { wxAppid, wxSecret } = cfg();
  if (!wxAppid || !wxSecret) throw new Error('未配置小程序 AppID / AppSecret');
  const url = new URL('https://api.weixin.qq.com/sns/jscode2session');
  url.searchParams.set('appid', wxAppid);
  url.searchParams.set('secret', wxSecret);
  url.searchParams.set('js_code', code);
  url.searchParams.set('grant_type', 'authorization_code');

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    const data = await res.json();
    if (data.errcode) {
      const map = {
        40029: '登录凭证 code 无效或已过期，请在小程序内重新进入',
        40163: '登录凭证已被使用，请重试',
        40013: 'AppID 无效，请检查小程序配置',
        40125: 'AppSecret 无效，请检查小程序配置',
        45011: '调用频率超限，请稍后再试'
      };
      throw new Error(map[data.errcode] || `微信登录失败（${data.errcode}: ${data.errmsg || ''}）`);
    }
    if (!data.openid) throw new Error('微信未返回 openid');
    return { openid: data.openid, unionid: data.unionid || '', sessionKey: data.session_key || '' };
  } finally {
    clearTimeout(timer);
  }
}

// ---------- access_token（获取小程序码用） ----------
// 微信限制每天 2000 次、有效期 2 小时；这里在进程内缓存并提前 5 分钟续期，
// 避免每次打开登录页都去换一次 token。
let tokCache = { token: '', exp: 0 };

async function getAccessToken(force = false) {
  const { wxAppid, wxSecret } = cfg();
  if (!wxAppid || !wxSecret) throw new Error('未配置小程序 AppID / AppSecret');
  if (!force && tokCache.token && tokCache.exp > Date.now()) return tokCache.token;

  const url = new URL('https://api.weixin.qq.com/cgi-bin/token');
  url.searchParams.set('grant_type', 'client_credential');
  url.searchParams.set('appid', wxAppid);
  url.searchParams.set('secret', wxSecret);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    const data = await res.json();
    if (data.errcode) {
      const map = { 40013: 'AppID 无效', 40125: 'AppSecret 无效', 40164: '调用 IP 不在白名单', 45011: '调用频率超限' };
      throw new Error(map[data.errcode] || `获取 access_token 失败（${data.errcode}: ${data.errmsg || ''}）`);
    }
    tokCache = { token: data.access_token, exp: Date.now() + Math.max(60, (data.expires_in || 7200) - 300) * 1000 };
    return tokCache.token;
  } finally {
    clearTimeout(timer);
  }
}

// ---------- 小程序码（普通用户扫码注册入口） ----------
// 网页登录页放一个小程序码，微信扫一扫直接进入小程序，登录即自动建号。
// 生成失败不抛给前端硬错误：降级成「请在小程序里搜索 XXX」的文案。
let qrCache = { buf: null, exp: 0, env: '' };

async function getUserEntryQr() {
  if (qrCache.buf && qrCache.exp > Date.now()) return qrCache.buf;
  const token = await getAccessToken();

  // 依次尝试 正式版 / 体验版 / 开发版：个人部署常常还没发布正式版，
  // 只试 release 会一直失败；体验版小程序码只有体验成员能扫，但总比没有强。
  const envs = ['release', 'trial', 'develop'];
  const errs = [];
  for (const env of envs) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    try {
      const res = await fetch(`https://api.weixin.qq.com/wxa/getwxacodeunlimit?access_token=${encodeURIComponent(token)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scene: 'reg',
          page: 'pages/index/index',
          // check_path:false 允许小程序尚未发布时也能生成（开发/体验版联调）
          check_path: false,
          env_version: env,
          width: 430
        }),
        signal: ctrl.signal
      });
      const type = res.headers.get('content-type') || '';
      if (!type.includes('image')) {
        const d = await res.json().catch(() => ({}));
        errs.push(`${env}:${d.errcode || '?'} ${d.errmsg || '返回非图片'}`);
        continue;
      }
      const buf = Buffer.from(await res.arrayBuffer());
      // 小程序码基本不变，缓存 7 天；失败不缓存
      qrCache = { buf, exp: Date.now() + 7 * 86400 * 1000, env };
      return buf;
    } catch (e) {
      errs.push(`${env}:${e.message}`);
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(`生成小程序码失败（${errs.join('；')}）`);
}

module.exports = { code2Session, getAccessToken, getUserEntryQr };
