'use strict';
// 普通用户账号体系：网页「用户名 + 密码」注册 / 登录
// 与微信账号共用 users 表：账号用户的 openid 是 local_xxx 占位，其余（角色/状态/任务/文件/拉黑）完全复用。
const express = require('express');
const crypto = require('crypto');
const { db, cfg, getSetting, logAudit, nowISO } = require('../db');
const sec = require('../security');
const { publicUser } = require('../middleware');

const router = express.Router();

const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{2,31}$/; // 3-32 位，小写字母数字开头
const normalizeUsername = (v) => String(v == null ? '' : v).trim().toLowerCase();

function findByUsername(name) {
  if (!name) return null;
  return db.prepare('SELECT * FROM users WHERE username = ?').get(normalizeUsername(name));
}

// 账号用户没有微信身份，用一个不会被微信分配到的前缀占位
const localOpenid = () => `local_${crypto.randomBytes(8).toString('hex')}`;

function passwordProblem(pwd, confirm) {
  if (typeof pwd !== 'string' || pwd.length < 8) return '密码至少 8 位';
  if (pwd.length > 72) return '密码最长 72 位';
  if (!/[A-Za-z]/.test(pwd) || !/[0-9]/.test(pwd)) return '密码需同时包含字母和数字';
  if (confirm !== undefined && pwd !== confirm) return '两次输入的密码不一致';
  return '';
}

function issue(user) {
  // 与小程序同一套会话：门户用的 /api/mp/* 接口认这个令牌，权限边界由 users 表决定
  return { token: sec.signUser(user), user: publicUser(user) };
}

// ---------- 注册 ----------
router.post('/auth/account/register', sec.rateLimit({ key: 'accreg', windowMs: 60000, max: process.env.PG_DEV_MODE === 'true' ? 200 : 30 }), (req, res) => {
  const c = cfg();
  if (!c.enableUserRegister) {
    return res.status(403).json({ ok: false, code: 'REGISTER_CLOSED', msg: '管理员已关闭注册，请联系管理员开通账号' });
  }
  const b = req.body || {};
  const username = normalizeUsername(b.username);
  if (!USERNAME_RE.test(username)) {
    return res.status(400).json({ ok: false, msg: '用户名 3-32 位，只能用小写字母、数字、点、下划线或短横线，且以字母或数字开头' });
  }
  const pwdErr = passwordProblem(b.password, b.confirm);
  if (pwdErr) return res.status(400).json({ ok: false, msg: pwdErr });
  if (findByUsername(username)) return res.status(409).json({ ok: false, msg: '该用户名已被占用，换一个试试' });

  const nickname = String(b.nickname == null ? '' : b.nickname).trim().slice(0, 64) || username;
  // 与微信新用户一致：默认待审批；关了审批或访客模式则直接可用
  const status = !c.approveNewUser || c.guestMode ? 'approved' : 'pending';
  try {
    const r = db.prepare(
      `INSERT INTO users (openid, username, pass_hash, unionid, nickname, avatar, wechat_id, phone, real_name,
                          apply_note, role, status, created_at, approved_at, approved_by, note, last_login, updated_at)
       VALUES (?,?,?,?,?,'','','','','','user',?,?,?,?,?,?,?)`
    ).run(
      localOpenid(), username, sec.hashPassword(b.password), '',
      nickname, status, nowISO(),
      status === 'approved' ? nowISO() : null,
      status === 'approved' ? 'auto/register' : null, '', nowISO(), nowISO()
    );
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(r.lastInsertRowid);
    logAudit('user_register', `username=${username} status=${status}`, sec.clientIp(req), `user#${user.id}`);
    res.json({
      ok: true,
      needApproval: status === 'pending',
      msg: status === 'pending' ? '注册成功，等待管理员审批后即可打印' : '注册成功，已自动登录',
      ...issue(user)
    });
  } catch (e) {
    if (/UNIQUE/.test(e.message)) return res.status(409).json({ ok: false, msg: '该用户名已被占用，换一个试试' });
    console.error('[account/register]', e);
    res.status(500).json({ ok: false, msg: '注册失败，请稍后重试' });
  }
});

// ---------- 登录 ----------
router.post('/auth/account/login', sec.rateLimit({ key: 'acclogin', windowMs: 60000, max: 20 }), (req, res) => {
  if (sec.checkLock(req, res, 'userlogin')) return;
  const b = req.body || {};
  const username = normalizeUsername(b.username);
  const password = String(b.password == null ? '' : b.password);
  const ip = sec.clientIp(req);

  const user = findByUsername(username);
  // 用户不存在也走一次哈希校验（对一个假散列），避免用响应时间判断用户名是否存在
  const stored = user && user.pass_hash ? user.pass_hash : sec.hashPassword('dummy-password-000');
  const ok = sec.passwordMatches(password, stored) && !!user && !!user.pass_hash && password.length > 0;

  if (!ok) {
    sec.recordAttempt(ip, 'userlogin', false);
    logAudit('user_login_fail', `username=${username || '-'}`, ip, 'anonymous');
    const left = Math.max(0, cfg().loginMaxFail - sec.recentFailures(ip, 'userlogin', cfg().loginLockMin));
    return res.status(403).json({
      ok: false,
      msg: `用户名或密码不正确${left ? `，还可尝试 ${left} 次` : '，账号已临时锁定'}`,
      remaining: left
    });
  }
  if (user.status === 'blocked') {
    return res.status(403).json({ ok: false, code: 'BLOCKED', msg: '账号已被停用，请联系管理员' });
  }
  sec.recordAttempt(ip, 'userlogin', true);
  db.prepare('UPDATE users SET last_login = ?, updated_at = ? WHERE id = ?').run(nowISO(), nowISO(), user.id);
  const fresh = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
  logAudit('user_login_ok', `username=${username}`, ip, `user#${user.id}`);
  res.json({ ok: true, msg: '登录成功', needApproval: fresh.status === 'pending', ...issue(fresh) });
});

// ---------- 改密码（账号用户自助） ----------
router.post('/auth/account/password', (req, res) => {
  const raw = req.headers.authorization || '';
  const token = raw.startsWith('Bearer ') ? raw.slice(7).trim() : '';
  const payload = sec.verify(token);
  if (!payload || payload.scope !== 'miniapp' || !payload.uid) {
    return res.status(401).json({ ok: false, msg: '登录已失效，请重新登录' });
  }
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(payload.uid);
  if (!user || !user.pass_hash) return res.status(400).json({ ok: false, msg: '当前账号不是密码账号' });
  const b = req.body || {};
  if (!sec.passwordMatches(String(b.oldPassword || ''), user.pass_hash)) {
    return res.status(403).json({ ok: false, msg: '当前密码不正确' });
  }
  const pwdErr = passwordProblem(b.newPassword, b.confirm);
  if (pwdErr) return res.status(400).json({ ok: false, msg: pwdErr });
  db.prepare('UPDATE users SET pass_hash = ?, updated_at = ? WHERE id = ?')
    .run(sec.hashPassword(b.newPassword), nowISO(), user.id);
  logAudit('user_change_password', `username=${user.username}`, sec.clientIp(req), `user#${user.id}`);
  res.json({ ok: true, msg: '密码已修改' });
});

// 注册开关状态（登录页据此显示/隐藏注册入口）
router.get('/auth/account/policy', (req, res) => {
  const c = cfg();
  res.json({
    ok: true,
    registerEnabled: !!c.enableUserRegister,
    approveNewUser: !!c.approveNewUser,
    minPassword: 8
  });
});

module.exports = router;
module.exports.normalizeUsername = normalizeUsername;
module.exports.findByUsername = findByUsername;
module.exports.USERNAME_RE = USERNAME_RE;
module.exports.passwordProblem = passwordProblem;
module.exports.localOpenid = localOpenid;
