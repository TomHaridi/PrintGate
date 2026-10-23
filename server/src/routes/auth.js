'use strict';
// 首次部署初始化 / 管理员登录 / 扫码登录(网页) / 密码管理
const express = require('express');
const QRCode = require('qrcode');
const { db, cfg, getSetting, setSetting, logAudit, nowISO } = require('../db');
const sec = require('../security');
const config = require('../config');
const { requireAdmin, bearer } = require('../middleware');
const wechat = require('../wechat');

const router = express.Router();

// ---------- 公共引导信息 ----------
router.get('/public/bootstrap', (req, res) => {
  const c = cfg();
  res.json({
    ok: true,
    app: 'PrintGate',
    version: config.version,
    needsSetup: !sec.hasAdminPassword(),
    qrLoginEnabled: c.enableQrLogin,
    passwordLoginEnabled: c.enablePasswordLogin,
    userRegisterEnabled: c.enableUserRegister,
    wxConfigured: !!(c.wxAppid && c.wxSecret),
    guestMode: c.guestMode,
    serverTime: nowISO()
  });
});

// ---------- 首次部署：设置管理员密码 ----------
router.post('/setup', sec.rateLimit({ key: 'setup', windowMs: 60000, max: 10 }), (req, res) => {
  if (sec.hasAdminPassword()) {
    return res.status(409).json({ ok: false, msg: '管理员密码已设置，请直接登录' });
  }
  const { password, confirm } = req.body || {};
  if (typeof password !== 'string' || password.length < 8) {
    return res.status(400).json({ ok: false, msg: '密码至少 8 位' });
  }
  if (password !== confirm) return res.status(400).json({ ok: false, msg: '两次输入的密码不一致' });
  if (!/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) {
    return res.status(400).json({ ok: false, msg: '密码需同时包含字母和数字' });
  }
  sec.setAdminPassword(password);
  sec.jwtSecret();
  // 首次部署生成独立的绑定码（不再复用环境变量里的弱默认值）
  if (!getSetting('bindToken')) sec.bindTokenInfo();
  logAudit('setup_admin', `ip=${sec.clientIp(req)}`, sec.clientIp(req), 'admin');
  const token = sec.signAdmin();
  res.json({ ok: true, msg: '初始化完成，已登录后台', token });
});

// ---------- 登录 ----------
router.post('/auth/login', sec.rateLimit({ key: 'login', windowMs: 60000, max: 20 }), (req, res) => {
  // 管理员可在「系统设置 → 安全」里关掉密码登录，只保留微信扫码（少一个可猜测的入口）
  if (!cfg().enablePasswordLogin) {
    return res.status(403).json({ ok: false, code: 'PASSWORD_LOGIN_DISABLED', msg: '密码登录已关闭，请使用微信扫码登录' });
  }
  if (sec.checkLock(req, res, 'login')) return;
  const { password } = req.body || {};
  const stored = getSetting('adminPassHash') || getSetting('adminPassword');
  if (!stored) return res.status(409).json({ ok: false, code: 'NEED_SETUP', msg: '尚未设置管理员密码，请先完成初始化' });
  const ip = sec.clientIp(req);
  if (typeof password !== 'string' || !password || !sec.passwordMatches(password, stored)) {
    sec.recordAttempt(ip, 'login', false);
    logAudit('login_fail', `ip=${ip}`, ip, 'anonymous');
    const left = Math.max(0, cfg().loginMaxFail - sec.recentFailures(ip, 'login', cfg().loginLockMin));
    return res.status(403).json({ ok: false, msg: `密码错误${left ? `，还可尝试 ${left} 次` : '，账号已临时锁定'}`, remaining: left });
  }
  if (!String(stored).startsWith('scrypt$')) sec.setAdminPassword(password); // 明文密码自动升级
  sec.recordAttempt(ip, 'login', true);
  logAudit('login_ok', `ip=${ip}`, ip, 'admin');
  res.json({ ok: true, token: sec.signAdmin(), user: { name: '管理员', role: 'admin' } });
});

// 会话身份：前端用它决定进「管理台」还是「打印门户」
// 小程序 JWT（scope=miniapp）一律视为普通用户，即使该微信在后台是管理员——
// 要管理权限必须走密码登录或管理员扫码，两种能力不混在一个令牌里
router.get('/auth/whoami', (req, res) => {
  const raw = bearer(req);
  const payload = sec.verify(raw);
  if (!payload) return res.status(401).json({ ok: false, msg: '登录已失效' });
  if (payload.scope === 'admin') {
    const p = sec.verifyAdmin(raw);
    if (!p) return res.status(401).json({ ok: false, msg: '登录已失效，请重新登录' });
    return res.json({ ok: true, role: 'admin', user: { name: '管理员' } });
  }
  if (payload.scope === 'miniapp') {
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(payload.uid);
    if (!u) return res.status(401).json({ ok: false, msg: '用户不存在' });
    if (u.status === 'blocked') return res.status(403).json({ ok: false, code: 'BLOCKED', msg: '账号已被停用，请联系管理员' });
    return res.json({
      ok: true, role: 'user',
      user: { id: u.id, name: u.nickname || '微信用户', avatar: u.avatar || '', status: u.status }
    });
  }
  return res.status(401).json({ ok: false, msg: '登录已失效' });
});

router.get('/auth/me', requireAdmin, (req, res) => {
  res.json({
    ok: true,
    user: { name: '管理员', role: 'admin' },
    passwordIsDefault: false
  });
});

router.post('/auth/logout', (req, res) => {
  logAudit('logout', '', sec.clientIp(req), 'admin');
  res.json({ ok: true });
});

// 修改密码
router.post('/auth/password', requireAdmin, sec.rateLimit({ key: 'chpwd', windowMs: 60000, max: 10 }), (req, res) => {
  const { oldPassword, newPassword, confirm } = req.body || {};
  const stored = getSetting('adminPassHash') || getSetting('adminPassword');
  if (!sec.passwordMatches(oldPassword || '', stored)) {
    logAudit('change_password_fail', `ip=${sec.clientIp(req)}`, sec.clientIp(req), 'admin');
    return res.status(403).json({ ok: false, msg: '当前密码不正确' });
  }
  if (typeof newPassword !== 'string' || newPassword.length < 8) {
    return res.status(400).json({ ok: false, msg: '新密码至少 8 位' });
  }
  if (!/[A-Za-z]/.test(newPassword) || !/[0-9]/.test(newPassword)) {
    return res.status(400).json({ ok: false, msg: '新密码需同时包含字母和数字' });
  }
  if (newPassword !== confirm) return res.status(400).json({ ok: false, msg: '两次输入的新密码不一致' });
  sec.setAdminPassword(newPassword);
  sec.bumpAuthEpoch(); // 旧会话（其他设备上的 JWT）立即失效
  logAudit('change_password', `ip=${sec.clientIp(req)}`, sec.clientIp(req), 'admin');
  res.json({ ok: true, msg: '密码已修改，其他设备的登录已失效', token: sec.signAdmin() });
});

// ---------- 普通用户自助注册入口 ----------
// 普通用户没有密码，账号只能来自微信。这里给网页登录页一个小程序码，
// 扫码进小程序登录即自动建号（默认待审批），审批后就能在本页扫码登录。
router.get('/auth/user-entry', sec.rateLimit({ key: 'userentry', windowMs: 60000, max: 30 }), async (req, res) => {
  const c = cfg();
  const out = {
    ok: true,
    enabled: !!c.enableUserRegister,
    configured: !!(c.wxAppid && c.wxSecret),
    qr: '',
    hint: '',
    approveNewUser: !!c.approveNewUser
  };
  // 管理员关掉自助注册后，这里连小程序码都不给——避免用户白扫一遍才被告知不能注册
  if (!out.enabled) {
    out.hint = '管理员已关闭自助注册，请联系管理员在后台添加你的微信。';
    return res.json(out);
  }
  if (!out.configured) {
    out.hint = '管理员还没配置小程序 AppID / AppSecret，暂时不能在这里自助注册；请联系管理员开通。';
    return res.json(out);
  }
  try {
    const buf = await wechat.getUserEntryQr();
    out.qr = `data:image/png;base64,${buf.toString('base64')}`;
    out.hint = '微信扫一扫 → 进入小程序 → 点「微信一键登录」即自动建号';
  } catch (e) {
    // 微信接口失败（IP 白名单、未发布、频率超限…）不该让整个登录页报错，降级成文字指引
    out.hint = `小程序码暂时生成失败（${e.message}），可以让管理员把小程序码发给你，或在微信里搜索小程序名称进入。`;
  }
  res.json(out);
});

// ---------- 网页扫码登录 ----------
router.post('/auth/qr/create', sec.rateLimit({ key: 'qrcreate', windowMs: 60000, max: 30 }), async (req, res) => {
  if (!cfg().enableQrLogin) return res.status(403).json({ ok: false, msg: '扫码登录未启用' });
  if (!cfg().wxAppid) return res.status(400).json({ ok: false, msg: '请先配置小程序 AppID / AppSecret' });
  const ticket = sec.createTicket('login', sec.clientIp(req), 120);
  const qr = await QRCode.toDataURL(`printgate://login?ticket=${ticket}`, { margin: 1, width: 320, errorCorrectionLevel: 'M' });
  res.json({ ok: true, ticket, qr, expiresIn: 120 });
});

router.get('/auth/qr/status', sec.rateLimit({ key: 'qrpoll', windowMs: 60000, max: 240 }), (req, res) => {
  const t = sec.getTicket(String(req.query.ticket || ''));
  if (!t) return res.status(404).json({ ok: false, msg: '二维码已失效，请刷新' });
  // 票据是「能力凭证」，只该被创建它的那个浏览器消费；换了来源 IP 一律当作无效，避免票据外泄被抢登
  if (t.ip && sec.clientIp(req) !== t.ip) {
    return res.status(404).json({ ok: false, msg: '二维码已失效，请刷新' });
  }
  if (t.status === 'expired') return res.json({ ok: true, status: 'expired' });
  if (t.status === 'confirmed') {
    const user = t.user_id ? db.prepare('SELECT * FROM users WHERE id = ?').get(t.user_id) : null;
    // 普通用户也能扫码登录，但只签「用户会话」：能打印/看自己的历史，进不了管理接口
    if (!user || user.status !== 'approved') {
      return res.json({ ok: true, status: 'denied', msg: '该微信账号未获授权，请先在小程序里提交申请' });
    }
    if (t.used) return res.json({ ok: true, status: 'expired' });
    db.prepare('UPDATE qr_tickets SET used = 1 WHERE ticket = ?').run(t.ticket);
    if (user.role === 'admin') {
      logAudit('qr_login_ok', `user=${user.id} role=admin`, t.ip || '', 'admin');
      return res.json({
        ok: true, status: 'confirmed', role: 'admin',
        token: sec.signAdmin({ uid: user.id }),
        user: { name: user.nickname || '管理员' }
      });
    }
    logAudit('qr_login_ok', `user=${user.id} role=user`, t.ip || '', `user#${user.id}`);
    return res.json({
      ok: true, status: 'confirmed', role: 'user',
      token: sec.signUser(user),
      user: { name: user.nickname || '微信用户', avatar: user.avatar || '' }
    });
  }
  res.json({ ok: true, status: t.status });
});

// ---------- 绑定码（小程序扫码授权管理员） ----------
// 一码一人 + TTL：前端按 remainingSec 倒计时，到期或被人用过都会换新码，
// 页面每 10 秒拉一次本接口即可自动无感刷新。
router.get('/admin/bind/info', requireAdmin, async (req, res) => {
  const info = sec.bindTokenInfo();
  const qr = await QRCode.toDataURL(info.token, { margin: 1, width: 320 });
  res.json({ ok: true, ...info, qr });
});

router.post('/admin/bind/regenerate', requireAdmin, async (req, res) => {
  const info = sec.rotateBindToken('manual');
  logAudit('bind_token_regenerate', '', sec.clientIp(req), 'admin');
  const qr = await QRCode.toDataURL(info.token, { margin: 1, width: 320 });
  res.json({
    ok: true, ...info, qr,
    remainingSec: Math.max(0, Math.ceil((info.expiresAt - Date.now()) / 1000)),
    msg: '新的绑定码已生成，旧码立即失效'
  });
});

module.exports = router;
