'use strict';
// 小程序接入配置：把散落在多处的关键参数收敛到一个端点（GET/PUT /api/wechat/config）
// 唯一维护点：AppID / AppSecret / 接入地址(BASE) / 管理员白名单 / 三个策略开关 / 绑定码
const express = require('express');
const QRCode = require('qrcode');
const { db, cfg, getSetting, setSettings, logAudit } = require('../db');
const sec = require('../security');
const { requireAdmin } = require('../middleware');

const router = express.Router();

function mask(v) {
  if (!v) return '';
  if (v.length <= 8) return '****';
  return `${v.slice(0, 4)}****${v.slice(-4)}`;
}

function adminIds() {
  // 只回显合法 OpenID：非法值本来就不会匹配到任何用户，显示出来反而让「保存」必然 400
  return sec.cleanOpenids(cfg().adminOpenids || '').list.filter((id) => sec.validOpenid(id));
}

async function buildConfig() {
  const c = cfg();
  const users = db.prepare('SELECT COUNT(*) c FROM users').get().c;
  const pending = db.prepare("SELECT COUNT(*) c FROM users WHERE status='pending'").get().c;
  const admins = db.prepare("SELECT COUNT(*) c FROM users WHERE role='admin' AND status='approved'").get().c;
  const bind = sec.bindTokenInfo(); // 没有/已过期会就地换新
  const bindToken = bind.token;
  const qr = await QRCode.toDataURL(bindToken, { margin: 1, width: 320 });
  return {
    appid: c.wxAppid || '',
    secret: mask(c.wxSecret),
    secretConfigured: !!c.wxSecret,
    configured: !!(c.wxAppid && c.wxSecret),
    baseUrl: c.relayPublicUrl || '',
    adminOpenids: adminIds(),
    approveNewUser: c.approveNewUser,
    enableQrLogin: c.enableQrLogin,
    devMode: getSetting('devMode', '0') === '1',
    approveEachJob: c.approveEachJob,
    bindToken,
    bindQr: qr,
    bindExpiresAt: bind.expiresAt,
    bindTtlSec: bind.ttlSec,
    bindRemainingSec: bind.remainingSec,
    stats: { users, pending, admins }
  };
}

router.get('/wechat/config', requireAdmin, async (req, res) => {
  res.json({ ok: true, config: await buildConfig() });
});

router.put('/wechat/config', requireAdmin, async (req, res, next) => {
  const b = req.body || {};
  const updates = {};
  const errors = [];

  if (b.appid !== undefined) {
    const v = String(b.appid).trim();
    if (v && !/^wx[0-9a-zA-Z]{16}$/.test(v)) errors.push('AppID 格式不正确（wx 开头共 18 位）');
    else updates.wxAppid = v;
  }
  if (b.secret !== undefined) {
    const v = String(b.secret).trim();
    if (/^.{4}\*{4}.{4}$/.test(v)) {
      // GET 返回的 secret 是掩码（abcd****wxyz）。有的客户端会把表单原样回存，
      // 若当成新密钥校验就会 400「AppSecret 应为 32 位字母数字」，导致保存永远失败。
      // 掩码一律视为「保持不变」。
    } else if (v === '') {
      // 显式清除
      if (b.clearSecret === true) updates.wxSecret = '';
    } else if (!/^[0-9a-zA-Z]{32}$/.test(v)) {
      errors.push('AppSecret 应为 32 位字母数字');
    } else {
      updates.wxSecret = v;
    }
  }
  if (b.baseUrl !== undefined) {
    const v = String(b.baseUrl).trim().replace(/\/+$/, '');
    // 与 /api/settings 保持同一套规则：禁止空白、引号与尖括号（会拼进页面/二维码/请求）
    const lower = v.toLowerCase();
    const protoOk = lower.startsWith('http://') || lower.startsWith('https://');
    // 逐字符判断：空白/控制字符、引号、尖括号、反引号、反斜杠都不允许（会拼进页面/二维码/请求）
    const hasBadChar = v.split('').some((ch) => {
      const c = ch.charCodeAt(0);
      return c <= 32 || c === 34 || c === 39 || c === 60 || c === 62 || c === 96 || c === 92;
    });
    if (v && (!protoOk || v.length > 253 || hasBadChar)) {
      errors.push('接入地址需以 http(s):// 开头，且不能包含空格或引号');
    } else {
      updates.relayPublicUrl = v;
    }
  }
  if (b.adminOpenids !== undefined) {
    const { list, bad } = sec.cleanOpenids(b.adminOpenids);
    if (bad.length) errors.push(`OpenID 格式可疑：${bad.slice(0, 2).join(', ')}`);
    else updates.adminOpenids = list.join(',');
  }
  for (const k of ['approveNewUser', 'enableQrLogin']) {
    if (b[k] !== undefined) updates[k] = b[k] ? '1' : '0';
  }
  if (b.devMode !== undefined) updates.devMode = b.devMode ? '1' : '0';

  if (errors.length) return res.status(400).json({ ok: false, msg: errors[0], errors });

  if (Object.keys(updates).length) setSettings(updates);
  logAudit('wechat_config_update', Object.keys(updates).join(',') || 'noop', sec.clientIp(req), 'admin');
  res.json({ ok: true, msg: '接入参数已保存并立即生效', config: await buildConfig() });
});

// 重置绑定码（小程序扫码绑定管理员用）
// 与 auth.js 的 /admin/bind/regenerate 等价，两处入口共用同一套 TTL/轮换逻辑
router.post('/wechat/bind-token', requireAdmin, async (req, res) => {
  const info = sec.rotateBindToken('manual');
  logAudit('bind_token_regenerate', '', sec.clientIp(req), 'admin');
  const qr = await QRCode.toDataURL(info.token, { margin: 1, width: 320 });
  res.json({
    ok: true, msg: '新的绑定码已生成，旧码立即失效',
    bindToken: info.token, bindQr: qr, bindExpiresAt: info.expiresAt,
    bindTtlSec: info.ttlSec,
    bindRemainingSec: Math.max(0, Math.ceil((info.expiresAt - Date.now()) / 1000))
  });
});

// 凭据连通性自检（获取 access_token 验证 AppID/Secret 是否匹配）
router.post('/wechat/test', requireAdmin, sec.rateLimit({ key: 'wxtest', windowMs: 60000, max: 12 }), async (req, res) => {
  const c = cfg();
  if (!c.wxAppid || !c.wxSecret) return res.json({ ok: false, msg: '请先填写 AppID 与 AppSecret 并保存' });
  try {
    const url = `https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=${encodeURIComponent(c.wxAppid)}&secret=${encodeURIComponent(c.wxSecret)}`;
    const r = await fetch(url, { signal: AbortSignal.timeout(10000) });
    const d = await r.json();
    if (d.errcode) return res.json({ ok: false, msg: `微信校验失败：${d.errmsg}（${d.errcode}）` });
    res.json({ ok: true, msg: '凭据有效，小程序可正常登录', detail: { expiresIn: d.expires_in } });
  } catch (e) {
    res.json({ ok: false, msg: `无法连接微信接口：${e.message}` });
  }
});

module.exports = router;
