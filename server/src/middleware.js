'use strict';
// 鉴权中间件：后台管理员(JWT) / 小程序用户(JWT) / 开放 API Key
const crypto = require('crypto');
const { db, cfg, logAudit } = require('./db');
const sec = require('./security');

function bearer(req) {
  const h = req.headers.authorization || '';
  return h.startsWith('Bearer ') ? h.slice(7).trim() : '';
}

// 会话时长改短后，已签发的令牌仍带着原来的 exp。按「当前设置」再判一次，
// 让「把 24 小时改成 1 小时」能对存量的长令牌立即生效。
function expiredByPolicy(payload) {
  const hours = Number(cfg().sessionHours) || 0;
  if (!hours || !payload || !payload.iat) return false;
  return (Date.now() / 1000 - Number(payload.iat)) > hours * 3600;
}

// 密码变更后，之前签发的令牌全部失效。
// JWT 的 iat 精度是秒，改密时间用 ISO 存的毫秒，这里统一按秒比较并留 5 秒容差，
// 否则"改密后立刻用新令牌"会被自己的时间戳卡掉。
function staleAfterPasswordChange(payload, user) {
  const changed = user && user.pwd_changed_at ? Date.parse(user.pwd_changed_at) || 0 : 0;
  if (!changed) return false;
  // 旧令牌没有 pwdv 字段（升级前签发的），在改密用户这里一律视为过期
  return Number((payload && payload.pwdv) || 0) !== changed;
}

function requireAdmin(req, res, next) {
  const payload = sec.verifyAdmin(bearer(req));
  if (!payload || payload.scope !== 'admin') {
    return res.status(401).json({ ok: false, code: 'UNAUTHORIZED', msg: '登录已失效，请重新登录' });
  }
  if (expiredByPolicy(payload)) {
    return res.status(401).json({ ok: false, code: 'UNAUTHORIZED', msg: '登录已超过会话时长，请重新登录' });
  }
  req.admin = { via: 'session' };
  next();
}

// 解析 API Key（不发响应，只返回行记录）。原来只在 requireAdminOrKey 里内联写过一份，
// 而 requirePrintAccessOrKey 却去读一个从未被赋值的 req.apiKey —— 结果 Key 上传文件永远 401。
function resolveApiKey(req) {
  const raw = req.headers['x-api-key'] || bearer(req);
  if (!raw || !String(raw).startsWith('pg_')) return null;
  const hash = crypto.createHash('sha256').update(String(raw)).digest('hex');
  const row = db.prepare('SELECT * FROM api_keys WHERE token_hash = ? AND revoked = 0').get(hash);
  if (!row) return null;
  if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) return null;
  db.prepare('UPDATE api_keys SET last_used_at = ?, last_used_ip = ? WHERE id = ?')
    .run(new Date().toISOString(), sec.clientIp(req), row.id);
  return row;
}

// 管理员或 API Key 均可访问（供小程序/第三方中转调用）
function requireAdminOrKey(req, res, next) {
  const payload = sec.verifyAdmin(bearer(req));
  if (payload && payload.scope === 'admin') { req.admin = { via: 'session' }; return next(); }
  const row = resolveApiKey(req);
  if (row) { req.apiKey = row; req.admin = { via: 'apikey', keyId: row.id }; return next(); }
  return res.status(401).json({ ok: false, msg: '请先登录，或提供有效的 API Key' });
}


function requireMiniUser(req, res, next) {
  const payload = sec.verify(bearer(req));
  if (!payload || payload.scope !== 'miniapp' || !payload.uid) {
    return res.status(401).json({ ok: false, code: 'UNAUTHORIZED', msg: '登录已失效，请重新进入小程序' });
  }
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(payload.uid);
  if (!user) return res.status(401).json({ ok: false, msg: '用户不存在' });
  // 拉黑必须立即生效：令牌还活着也不能继续用（小程序令牌没有撤销机制，只能靠这里拦）
  if (user.status === 'blocked') {
    return res.status(403).json({ ok: false, code: 'BLOCKED', msg: '账号已被停用，请联系管理员' });
  }
  if (expiredByPolicy(payload)) {
    return res.status(401).json({ ok: false, code: 'UNAUTHORIZED', msg: '登录已失效，请重新进入小程序' });
  }
  // 改过密码/被管理员重置过：比改密时刻更早签发的令牌立即作废（留 5 秒时钟容差）
  if (staleAfterPasswordChange(payload, user)) {
    return res.status(401).json({ ok: false, code: 'TOKEN_STALE', msg: '密码已修改，请重新登录' });
  }
  req.user = user;
  next();
}

function requireApprovedUser(req, res, next) {
  if (req.user.status !== 'approved') {
    return res.status(403).json({ ok: false, code: 'NOT_APPROVED', msg: '账号待管理员授权，暂时无法使用打印功能' });
  }
  next();
}

// 打印工作台准入：管理员（密码/扫码会话）或「已通过审批」的普通用户（微信/账号会话）
// 只放行打印相关能力；系统设置、用户管理等仍是 requireAdmin，普通用户碰不到。
function requirePrintAccess(req, res, next) {
  const raw = bearer(req);
  const payload = sec.verify(raw);
  if (!payload) return res.status(401).json({ ok: false, msg: '请先登录' });

  if (payload.scope === 'admin') {
    if (!sec.verifyAdmin(raw)) return res.status(401).json({ ok: false, msg: '登录已失效，请重新登录' });
    req.actor = { kind: 'admin' };
    return next();
  }
  if (payload.scope === 'miniapp') {
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(payload.uid);
    if (!u) return res.status(401).json({ ok: false, msg: '账号不存在' });
    if (u.status === 'blocked') return res.status(403).json({ ok: false, code: 'BLOCKED', msg: '账号已被停用' });
    if (u.status !== 'approved') {
      return res.status(403).json({ ok: false, code: 'NOT_APPROVED', msg: '账号待管理员授权，暂时无法使用打印功能' });
    }
    req.actor = { kind: 'user', uid: u.id, user: u };
    return next();
  }
  return res.status(401).json({ ok: false, msg: '请先登录' });
}

// 允许 API Key 调用（脚本/第三方）时用这个：Key 视为管理员身份，但不带用户归属
function requirePrintAccessOrKey(req, res, next) {
  // Key 优先：脚本/第三方没有用户会话，靠这里放行
  if (!req.apiKey) req.apiKey = resolveApiKey(req);
  if (req.apiKey) { req.actor = { kind: 'key' }; return next(); }
  return requirePrintAccess(req, res, next);
}

// 小程序里的管理员接口：必须是已通过审批的管理员账号
function requireMiniAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ ok: false, code: 'UNAUTHORIZED', msg: '请先登录' });
  if (req.user.role !== 'admin' || req.user.status !== 'approved') {
    return res.status(403).json({ ok: false, code: 'NOT_ADMIN', msg: '仅已授权管理员可操作' });
  }
  next();
}

function publicUser(u) {
  return {
    id: u.id, nickname: u.nickname || '', avatar: u.avatar || '',
    wechat_id: u.wechat_id || '', phone: u.phone || '', real_name: u.real_name || '',
    apply_note: u.apply_note || '',
    role: u.role, status: u.status, openid: u.openid,
    // 账号用户才有 username；微信用户为 null，前端据此显示「微信」或「账号」标识
    username: u.username || '',
    created_at: u.created_at, approved_at: u.approved_at, approved_by: u.approved_by || '',
    last_login: u.last_login || '', updated_at: u.updated_at || '',
    note: u.note || ''
  };
}

function isAdminOpenid(openid) {
  const list = String(cfg().adminOpenids || '').split(',').map((s) => s.trim()).filter(Boolean);
  return list.includes(openid);
}

module.exports = {
  resolveApiKey, requirePrintAccess, requirePrintAccessOrKey, requireAdmin, requireAdminOrKey, requireMiniUser, requireApprovedUser, requireMiniAdmin, publicUser, isAdminOpenid, bearer };
