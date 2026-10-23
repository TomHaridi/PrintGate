'use strict';
// 安全核心：密码散列 / JWT / 登录失败锁定 / 通用限流 / 扫码票据
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { db, getSetting, setSetting, nowISO, cfg, logAudit } = require('./db');

// ---------- 密码 ----------
const SCRYPT_KEYLEN = 32;

function hashPassword(plain) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(String(plain), salt, SCRYPT_KEYLEN, { N: 16384, r: 8, p: 1 });
  return `scrypt$16384$8$1$${salt.toString('base64')}$${key.toString('base64')}`;
}

function verifyPassword(plain, stored) {
  if (!stored) return false;
  try {
    const parts = String(stored).split('$');
    if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
    const [, N, r, p, saltB64, keyB64] = parts;
    // N/r/p 存在存储串里，若被写成异常值（如 N=2^30），scryptSync 会直接吃光内存/CPU。
    // 正常值由 hashPassword 固定为 16384/8/1，这里限定合法范围，属纵深防御。
    const nN = Number(N), nr = Number(r), np = Number(p);
    if (!Number.isInteger(nN) || nN < 1024 || nN > 1048576 || 2 ** Math.round(Math.log2(nN)) !== nN) return false;
    if (!Number.isInteger(nr) || nr < 1 || nr > 32) return false;
    if (!Number.isInteger(np) || np < 1 || np > 16) return false;
    const salt = Buffer.from(saltB64, 'base64');
    const expected = Buffer.from(keyB64, 'base64');
    const actual = crypto.scryptSync(String(plain), salt, expected.length, { N: nN, r: nr, p: np });
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  } catch (_) {
    return false;
  }
}

// 老版本明文密码（迁移自 remote-print.db / ADMIN_PASSWORD）→ 首次登录后升级为 scrypt
function passwordMatches(plain, stored) {
  if (!stored) return false;
  if (String(stored).startsWith('scrypt$')) return verifyPassword(plain, stored);
  const a = Buffer.from(String(plain));
  const b = Buffer.from(String(stored));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ---------- JWT ----------
function jwtSecret() {
  let s = getSetting('jwtSecret');
  if (!s) {
    s = crypto.randomBytes(48).toString('base64url');
    setSetting('jwtSecret', s);
  }
  return s;
}

// 会话纪元：修改密码后自增，旧的管理端 JWT 立即失效
function authEpoch() {
  return getSetting('authEpoch', '1');
}
function bumpAuthEpoch() {
  const next = String(parseInt(authEpoch(), 10) + 1);
  setSetting('authEpoch', next);
  return next;
}

function signAdmin(extra = {}) {
  const hours = cfg().sessionHours;
  return jwt.sign(
    { role: 'admin', scope: 'admin', ep: authEpoch(), ...extra },
    jwtSecret(),
    { expiresIn: `${hours}h` }
  );
}

function signUser(user) {
  return jwt.sign(
    { role: 'miniapp', scope: 'miniapp', uid: user.id, openid: user.openid },
    jwtSecret(),
    { expiresIn: `${cfg().sessionHours}h` }
  );
}

// 显式限定算法：jsonwebtoken 若不限制，遇到 alg: none / alg 混淆时会打 degrade 路径，
// 这里锁死为服务实际使用的 HS256，属于纵深防御。
function verify(token) {
  try { return jwt.verify(token, jwtSecret(), { algorithms: ['HS256'] }); } catch (_) { return null; }
}

// 校验管理端令牌（含会话纪元），用于全部 /api 管理接口
function verifyAdmin(token) {
  const p = verify(token);
  if (!p || p.scope !== 'admin') return null;
  if (String(p.ep || '') !== authEpoch()) return null;
  return p;
}

// ---------- 客户端 IP ----------
// 默认只信 socket 对端地址。X-Forwarded-For 可被客户端伪造，
// 若直接采信就能通过换头绕过登录锁定与限流；只有明确部署在可信反代之后
// （TRUST_PROXY=true）才取 XFF 的最后一跳。
const TRUST_PROXY = process.env.TRUST_PROXY === 'true';

// 判断是否为内网/回环地址（用于给本地调试接口加边界）
function isLocalIp(ip) {
  const v4 = String(ip || '').replace(/^::ffff:/, '');
  if (!v4) return false;
  if (v4 === '::1' || v4 === '127.0.0.1' || /^127\./.test(v4)) return true;
  if (/^10\./.test(v4) || /^192\.168\./.test(v4) || /^169\.254\./.test(v4)) return true;
  const m = v4.match(/^172\.(\d+)\./);
  if (m && Number(m[1]) >= 16 && Number(m[1]) <= 31) return true;
  if (/^f[cd][0-9a-f]{2}:/i.test(v4) || /^fe80:/i.test(v4)) return true;
  return false;
}

function clientIp(req) {
  const direct = String(req.socket?.remoteAddress || '').replace(/^::ffff:/, '');
  let ip = '';
  // TRUST_PROXY 只在「对端确实是可信跳」时才生效：直连的 socket 对端是公网地址，
  // 说明请求没经过反代（或反代没接上），此时 XFF 完全由客户端控制，
  // 采信就等于把登录锁定、限流、审计 IP 一起交出去（实测可 10/10 绕过）。
  // 反代与本服务同机（127.0.0.1）或同内网/容器网络（10./172./192.168.）时正常采信。
  if (TRUST_PROXY && isLocalIp(direct)) {
    const xff = String(req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
    // 取最后一跳：$proxy_add_x_forwarded_for 会把真实对端追加在尾部，
    // 客户端自己塞进 XFF 的值只会留在前面，取尾部天然不可伪造。
    ip = xff.length ? xff[xff.length - 1] : '';
  }
  if (!ip) ip = direct;
  return String(ip).replace(/^::ffff:/, '');
}

// ---------- 绑定码（小程序扫码绑定管理员） ----------
// 策略：一码一人 + TTL。
//   · 生成即计时（默认 10 分钟），到期自动换新；
//   · 绑定成功立刻换新 → 旧码即刻失效，截图/投屏/转发拿到的一次性凭证无法二次使用；
//   · 全站失败次数超阈值也强制换新，防短码 + 多 IP 的分布式撞码。
const BIND_KEY = 'bindToken';
const BIND_EXP = 'bindTokenExpiresAt';
const BIND_FAIL_WINDOW_MIN = 30;

function bindTtlMs() {
  const min = Number(cfg().bindTokenTtlMin) || 10;
  return Math.max(1, Math.min(1440, min)) * 60000;
}

function rotateBindToken(reason = '') {
  const token = crypto.randomBytes(16).toString('hex');
  const expiresAt = Date.now() + bindTtlMs();
  setSetting(BIND_KEY, token);
  setSetting(BIND_EXP, String(expiresAt));
  if (reason) logAudit('bind_token_rotate', reason, '', 'system');
  return { token, expiresAt };
}

// 读取当前有效码；没有/已过期就地换新（老版本升级上来只有 token 没有过期时间，按已过期处理）
function bindTokenInfo() {
  const token = getSetting(BIND_KEY, '');
  const expiresAt = Number(getSetting(BIND_EXP, '0')) || 0;
  let cur = { token, expiresAt };
  if (!token || !expiresAt || expiresAt <= Date.now()) {
    cur = rotateBindToken(!token ? 'init' : 'expired');
  }
  return {
    token: cur.token,
    expiresAt: cur.expiresAt,
    ttlSec: Math.round(bindTtlMs() / 1000),
    remainingSec: Math.max(0, Math.ceil((cur.expiresAt - Date.now()) / 1000))
  };
}

// 校验提交的绑定码：格式先按 32 位 hex 卡一道，再走定时安全比较
function verifyBindToken(submitted) {
  const info = bindTokenInfo();
  const s = String(submitted == null ? '' : submitted).trim();
  if (!/^[0-9a-f]{32}$/.test(s)) return false;
  const a = Buffer.from(s);
  const b = Buffer.from(info.token);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// 全站（跨 IP）近 N 分钟的绑定码失败次数
function bindFailuresRecent(minutes = BIND_FAIL_WINDOW_MIN) {
  const since = new Date(Date.now() - minutes * 60000).toISOString();
  return db.prepare("SELECT COUNT(*) c FROM login_attempts WHERE kind = 'bind' AND ok = 0 AND created_at >= ?").get(since).c;
}

// ---------- 微信管理员 OpenID ----------
// 微信分配的 openid/unionid 是 28 位左右的字母数字（可能含 _ -）。后台有两个入口
// 都能写这个设置（/api/settings 与 /api/wechat/config），必须共用同一套校验，
// 否则一个入口写进去的非法值会让另一个入口的页面永远保存失败。
const OPENID_RE = /^[A-Za-z0-9_-]{10,64}$/;
function validOpenid(id) {
  return OPENID_RE.test(String(id || ''));
}
function cleanOpenids(raw) {
  const arr = Array.isArray(raw) ? raw : String(raw == null ? '' : raw).split(/[,\s]+/);
  const list = arr.map((s) => String(s).trim()).filter(Boolean);
  return { list, bad: list.filter((id) => !OPENID_RE.test(id)) };
}

// ---------- 登录失败锁定（持久化，重启不清零） ----------
function recordAttempt(ip, kind, ok) {
  db.prepare('INSERT INTO login_attempts (ip, kind, ok, created_at) VALUES (?,?,?,?)')
    .run(ip, kind, ok ? 1 : 0, nowISO());
}

function recentFailures(ip, kind, windowMin) {
  const since = new Date(Date.now() - windowMin * 60000).toISOString();
  const row = db.prepare(
    'SELECT COUNT(*) c FROM login_attempts WHERE ip = ? AND kind = ? AND ok = 0 AND created_at >= ?'
  ).get(ip, kind, since);
  return row.c;
}

function lockedUntil(ip, kind) {
  const { loginMaxFail, loginLockMin } = cfg();
  const fails = recentFailures(ip, kind, loginLockMin);
  if (fails < loginMaxFail) return 0;
  const last = db.prepare(
    'SELECT created_at FROM login_attempts WHERE ip = ? AND kind = ? AND ok = 0 ORDER BY id DESC LIMIT 1'
  ).get(ip, kind);
  if (!last) return 0;
  const until = new Date(new Date(last.created_at).getTime() + loginLockMin * 60000).getTime();
  return until > Date.now() ? until : 0;
}

function checkLock(req, res, kind) {
  const ip = clientIp(req);
  const until = lockedUntil(ip, kind);
  if (until) {
    const mins = Math.max(1, Math.ceil((until - Date.now()) / 60000));
    res.status(429).json({
      ok: false, code: 'LOCKED',
      msg: `尝试次数过多，请在 ${mins} 分钟后重试`,
      retryAfter: mins * 60
    });
    return true;
  }
  return false;
}

// ---------- 通用滑动窗口限流（内存，按 IP + 路由组） ----------
const buckets = new Map();
function rateLimit({ windowMs = 60000, max = 60, key = 'default' } = {}) {
  return (req, res, next) => {
    const id = `${key}:${clientIp(req)}`;
    const now = Date.now();
    let b = buckets.get(id);
    if (!b || now > b.reset) { b = { count: 0, reset: now + windowMs }; buckets.set(id, b); }
    b.count += 1;
    if (b.count > max) {
      res.set('Retry-After', String(Math.ceil((b.reset - now) / 1000)));
      return res.status(429).json({ ok: false, code: 'RATE_LIMITED', msg: '请求过于频繁，请稍后再试' });
    }
    next();
  };
}
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of buckets) if (now > v.reset) buckets.delete(k);
}, 60000).unref();

// ---------- 扫码票据 ----------
function createTicket(kind, ip, ttlSec = 120) {
  const ticket = crypto.randomBytes(24).toString('base64url');
  db.prepare('INSERT INTO qr_tickets (ticket, kind, status, ip, created_at, expires_at) VALUES (?,?,?,?,?,?)')
    .run(ticket, kind, 'pending', ip, nowISO(), Date.now() + ttlSec * 1000);
  return ticket;
}

function getTicket(ticket) {
  const t = db.prepare('SELECT * FROM qr_tickets WHERE ticket = ?').get(ticket);
  if (!t) return null;
  if (t.expires_at < Date.now() || t.status === 'expired') return { ...t, status: 'expired' };
  return t;
}

function markTicket(ticket, status, userId = null) {
  db.prepare('UPDATE qr_tickets SET status = ?, user_id = COALESCE(?, user_id) WHERE ticket = ?')
    .run(status, userId, ticket);
}

setInterval(() => {
  const cutoff = Date.now();
  db.prepare('DELETE FROM qr_tickets WHERE expires_at < ?').run(cutoff - 3600_000);
}, 600000).unref();

// ---------- 管理员是否存在 ----------
function hasAdminPassword() {
  return !!getSetting('adminPassHash') || !!getSetting('adminPassword');
}

function setAdminPassword(plain) {
  setSetting('adminPassHash', hashPassword(plain));
  setSetting('adminPassword', ''); // 清除明文
}

function auditAuthFail(action, req, detail = '') {
  logAudit(action, detail, clientIp(req), 'anonymous');
}

module.exports = {
  hashPassword, verifyPassword, passwordMatches, hasAdminPassword, setAdminPassword,
  jwtSecret, signAdmin, signUser, verify, verifyAdmin, authEpoch, bumpAuthEpoch,
  clientIp, isLocalIp, recordAttempt, recentFailures, lockedUntil, checkLock, rateLimit,
  createTicket, getTicket, markTicket, auditAuthFail,
  bindTokenInfo, rotateBindToken, verifyBindToken, bindFailuresRecent, BIND_FAIL_WINDOW_MIN,
  cleanOpenids, validOpenid
};
