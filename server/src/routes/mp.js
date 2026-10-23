'use strict';
// 微信小程序对接：登录、扫码绑定管理员、扫码登录确认
const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { db, cfg, getSetting, setSettings, logAudit, nowISO } = require('../db');
const sec = require('../security');
const cups = require('../cups');
const { code2Session } = require('../wechat');
const { requireMiniUser, requireMiniAdmin, requireApprovedUser, publicUser, isAdminOpenid } = require('../middleware');
const config = require('../config');
const fsutil = require('../fsutil');
const orphans = require('../orphans');

const router = express.Router();

// % 与 _ 在 LIKE 里是通配符，搜索时必须按字面量转义
const like = (s) => String(s).replace(/[\\%_]/g, (c) => `\\${c}`);

// 用户自助填写的资料字段：昵称/头像之外，管理员要看的「微信号、手机号、姓名、申请说明」
const PROFILE_FIELDS = [
  ['nickname', 64],
  ['avatar', 512],
  ['wechat_id', 64],
  ['phone', 32],
  ['real_name', 64],
  ['apply_note', 200]
];

// 微信自 2022 起对 getUserInfo / getUserProfile 只回匿名数据（昵称「微信用户」+ 灰色头像）。
// 这些占位值一旦写库，会把用户之前填的真名覆盖成一片「微信用户」，后台完全没法分辨是谁，
// 所以登录入参里的匿名昵称一律丢弃，等前端用「头像昵称填写能力」补真值。
const ANON_NICKNAMES = new Set(['微信用户', 'wechat user', '微信昵称', '匿名用户', '未知用户']);

// allowClear=false 用于登录（每次登录都会带全量字段，空值不覆盖已有资料）；
// allowClear=true 用于用户/管理员主动保存，允许把填错的微信号、手机号清掉。
function cleanProfile(body = {}, allowClear = false) {
  const out = {};
  for (const [key, max] of PROFILE_FIELDS) {
    if (!(key in body)) continue;
    const v = String(body[key] == null ? '' : body[key]).trim().slice(0, max);
    if (!v && !allowClear) continue;
    if (key === 'nickname' && ANON_NICKNAMES.has(v.toLowerCase())) continue;
    // 头像只接受本站上传接口返回的路径：允许任意外链会让客户端把头像指到别处（跟踪/裂图/钓鱼）
    if (key === 'avatar' && v && !/^\/api\/mp\/avatar\/[A-Za-z0-9._-]+$/.test(v)) continue;
    out[key] = v;
  }
  return out;
}

function upsertUser({ openid, unionid, profile = {} }) {
  const c = cfg();
  let user = db.prepare('SELECT * FROM users WHERE openid = ?').get(openid);
  // 之前被解绑过（openid 换成了 local_unbound_*）：同一微信再登录时回到原来那条账号，
  // 否则会新建一个 pending 账号，旧的文件/任务全变成孤儿数据。
  if (!user) {
    const prev = db.prepare("SELECT * FROM users WHERE prev_openid = ? AND role <> 'admin'").get(openid);
    if (prev) {
      db.prepare('UPDATE users SET openid = ?, prev_openid = \'\', last_login = ?, updated_at = ? WHERE id = ?')
        .run(openid, nowISO(), nowISO(), prev.id);
      user = db.prepare('SELECT * FROM users WHERE id = ?').get(prev.id);
      logAudit('mp_rebind_restore', `openid=${openid}`, '', `user#${user.id}`);
    }
  }
  const adminByList = isAdminOpenid(openid);
  const cols = ['nickname', 'avatar', 'wechat_id', 'phone', 'real_name', 'apply_note'];
  if (!user) {
    // 管理员可以关掉自助注册：此时新微信登录不再建号，只能由管理员在「小程序用户」里添加。
    // 白名单里的管理员 OpenID 例外——否则一旦关掉注册又没绑过管理员，就没人能进后台了。
    if (!adminByList && !c.enableUserRegister) {
      const err = new Error('管理员已关闭自助注册，请联系管理员添加你的微信');
      err.code = 'REGISTER_CLOSED';
      throw err;
    }
    const role = adminByList ? 'admin' : 'user';
    // 访客模式（guestMode）此前只是个存了没人用的开关，这里让它真正生效：新用户免审批
    const status = adminByList || !c.approveNewUser || c.guestMode ? 'approved' : 'pending';
    const vals = cols.map((k) => profile[k] || '');
    const r = db.prepare(
      `INSERT INTO users (openid, unionid, nickname, avatar, wechat_id, phone, real_name, apply_note,
                          role, status, created_at, approved_at, last_login, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(openid, unionid || '', ...vals, role, status, nowISO(), status === 'approved' ? nowISO() : null, nowISO(), nowISO());
    user = db.prepare('SELECT * FROM users WHERE id = ?').get(r.lastInsertRowid);
    logAudit('mp_register', `openid=${openid} role=${role} status=${status}`, '', `user#${user.id}`);
  } else {
    const sets = [];
    const args = [];
    for (const k of cols) {
      // 只补空/更新变化项，避免每次登录把管理员校正过的资料覆盖回去
      if (profile[k] && profile[k] !== user[k]) { sets.push(`${k} = ?`); args.push(profile[k]); }
    }
    if (adminByList && (user.role !== 'admin' || user.status !== 'approved')) {
      sets.push("role = 'admin'", "status = 'approved'");
      if (!user.approved_at) { sets.push('approved_at = ?'); args.push(nowISO()); }
    }
    sets.push('last_login = ?', 'updated_at = ?');
    args.push(nowISO(), nowISO(), user.id);
    db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...args);
    user = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
  }
  return user;
}

router.post('/mp/login', sec.rateLimit({ key: 'mplogin', windowMs: 60000, max: 40 }), async (req, res) => {
  try {
    const { code } = req.body || {};
    if (!code) return res.status(400).json({ ok: false, msg: '缺少 code' });
    const wx = await code2Session(String(code));
    const user = upsertUser({ openid: wx.openid, unionid: wx.unionid, profile: cleanProfile(req.body) });
    res.json({ ok: true, token: sec.signUser(user), user: publicUser(user) });
  } catch (e) {
    if (e.code === 'REGISTER_CLOSED') return res.status(403).json({ ok: false, code: e.code, msg: e.message });
    res.status(400).json({ ok: false, msg: e.message });
  }
});

// 本地联调用的模拟登录（默认关闭，需在设置里开启开发模式）
router.post('/mp/dev-login', sec.rateLimit({ key: 'mpdev', windowMs: 60000, max: process.env.PG_DEV_MODE === 'true' ? 200 : 20 }), (req, res) => {
  if (getSetting('devMode', '0') !== '1' && process.env.PG_DEV_MODE !== 'true') {
    return res.status(404).json({ ok: false, msg: '未开启开发模式' });
  }
  // 光靠一个开关太脆：万一生产误开，任何人都能拿任意 openid（含管理员）换令牌。
  // 这里再收两道口子：只允许内网/本机来源；配了 PG_DEV_LOGIN_TOKEN 时还必须带对口令。
  const ip = sec.clientIp(req);
  if (!sec.isLocalIp(ip)) {
    return res.status(404).json({ ok: false, msg: '未开启开发模式' });
  }
  const devToken = process.env.PG_DEV_LOGIN_TOKEN || '';
  if (devToken && String((req.body || {}).devToken || '') !== devToken) {
    return res.status(403).json({ ok: false, msg: '开发模式口令不正确' });
  }
  const { openid = `dev_${crypto.randomBytes(4).toString('hex')}` } = req.body || {};
  const profile = cleanProfile(req.body);
  // 只在「压根没传昵称」时用测试默认值；传了「微信用户」这类匿名值会被 cleanProfile 丢弃，
  // 与生产登录（/mp/login）保持同一套过滤规则，否则本地联调看到的行为跟线上不一致。
  if (!('nickname' in (req.body || {}))) profile.nickname = '测试用户';
  let user;
  try {
    user = upsertUser({ openid, profile });
  } catch (e) {
    if (e.code === 'REGISTER_CLOSED') return res.status(403).json({ ok: false, code: e.code, msg: e.message });
    throw e;
  }
  res.json({ ok: true, token: sec.signUser(user), user: publicUser(user), dev: true });
});

router.get('/mp/me', requireMiniUser, (req, res) => {
  res.json({ ok: true, user: publicUser(req.user), config: {
      maxCopies: cfg().maxCopies, maxFileMB: cfg().maxFileMB, approveEachJob: cfg().approveEachJob,
      // 普通用户门户是否隐藏详细打印设置（份数/单双面/纸张等）
      advancedPrint: !cfg().hideUserAdvanced
    } });
});

// 完善资料：待审批用户也能改，方便补填微信号/手机号后再提醒管理员
router.put('/mp/profile', requireMiniUser, (req, res) => {
  const profile = cleanProfile(req.body || {}, true);
  const keys = Object.keys(profile);
  if (!keys.length) return res.status(400).json({ ok: false, msg: '没有需要保存的资料' });
  const sets = keys.map((k) => `${k} = ?`);
  const args = keys.map((k) => profile[k]);
  db.prepare(`UPDATE users SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`).run(...args, nowISO(), req.user.id);
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  logAudit('mp_profile', keys.join(','), sec.clientIp(req), `user#${user.id}`);
  res.json({ ok: true, msg: '资料已保存', user: publicUser(user) });
});

// ---------- 头像上传 ----------
// 小程序 chooseAvatar 给的是临时文件，只能整体上传；文件名随机，读取接口无需登录（网页端 <img> 带不上令牌）
const avatarStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    try { fs.mkdirSync(config.avatarDir, { recursive: true }); } catch (_) {}
    cb(null, config.avatarDir);
  },
  // 先落一个无扩展名的随机名：扩展名由文件头决定。
  // 微信 chooseAvatar 的临时文件经常没有扩展名（或叫 file），
  // 按 originalname 猜类型会把 JPEG 存成 .png，HTTP 头也跟着错，小程序 <image> 直接裂图。
  filename: (req, file, cb) => cb(null, crypto.randomBytes(12).toString('hex')),
});
const avatarUpload = multer({
  storage: avatarStorage,
  limits: { fileSize: 5 * 1024 * 1024, files: 1 }
}).single('avatar');

// mimetype / 文件名都由客户端说了算（微信临时文件常常没有扩展名），落盘后按文件头判断真实类型。
// 返回扩展名（含点），不是图片返回 null。
function detectImageExt(file) {
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(12);
    fs.readSync(fd, buf, 0, 12, 0);
    fs.closeSync(fd);
    if (buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return '.png';
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return '.jpg';
    if (buf.slice(0, 6).toString('latin1').startsWith('GIF8')) return '.gif';
    if (buf.slice(0, 4).toString('latin1') === 'RIFF' && buf.slice(8, 12).toString('latin1') === 'WEBP') return '.webp';
    return null;
  } catch (_) {
    return null;
  }
}

router.post('/mp/avatar', requireMiniUser, (req, res) => {
  avatarUpload(req, res, async (err) => {
    // multer 回调是异步的：Express 4 不会捕获回调里的 rejection，必须自己兜住
    try {
      if (err) return res.status(400).json({ ok: false, msg: err.code === 'LIMIT_FILE_SIZE' ? '头像不能超过 5 MB' : err.message });
      if (!req.file) return res.status(400).json({ ok: false, msg: '未收到头像文件' });
      // 按内容决定扩展名：文件名不可信
      const ext = detectImageExt(req.file.path);
      if (!ext) {
        // 非图片：刚上传的垃圾文件必须删掉；瞬态锁删不掉就登记 orphans 让清理任务兜底
        const ok = await fsutil.safeUnlink(req.file.path, { label: '头像类型不符' });
        if (!ok) orphans.add(req.file.path);
        return res.status(400).json({ ok: false, msg: '请选择 PNG / JPG / GIF / WEBP 图片' });
      }
      let savedName = req.file.filename;
      if (!savedName.endsWith(ext)) {
        const renamed = savedName + ext;
        try {
          fs.renameSync(req.file.path, path.join(config.avatarDir, renamed));
          savedName = renamed;
        } catch (_) { /* 改名失败就沿用原名，读取接口按内容兜底 */ }
      }
      const url = `/api/mp/avatar/${savedName}`;
      const old = String(req.user.avatar || '');
      // 条件更新：只有「确实是从我读到的那个旧头像迁移过来的」才允许删旧文件。
      // 并发换头像时，另一个请求可能已经把 avatar 改成了新文件，这时再删 old 就会把别人的成果删掉、界面裂图。
      const moved = db.prepare("UPDATE users SET avatar = ?, updated_at = ? WHERE id = ? AND COALESCE(avatar,'') = ?")
        .run(url, nowISO(), req.user.id, old);
      if (!moved.changes) {
        // 并发场景：只更新指向，不删任何文件（残留文件交给清理任务处理）
        db.prepare('UPDATE users SET avatar = ?, updated_at = ? WHERE id = ?').run(url, nowISO(), req.user.id);
      } else if (old.startsWith('/api/mp/avatar/')) {
        const p = path.join(config.avatarDir, path.basename(old));
        if (fsutil.isInside(config.avatarDir, p)) {
          // 头像已换成功，旧文件删不掉只是留个孤儿文件，不能反过来让换头像失败——登记后由清理任务重试
          const ok = await fsutil.safeUnlink(p, { label: '旧头像' });
          if (!ok) orphans.add(p);
        }
      }
      const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
      res.json({ ok: true, msg: '头像已更新', user: publicUser(user) });
    } catch (e) {
      console.error('[mp/avatar]', e);
      if (!res.headersSent) res.status(500).json({ ok: false, msg: '服务器错误' });
    }
  });
});

router.get('/mp/avatar/:name', (req, res) => {
  const name = path.basename(String(req.params.name || ''));
  // 允许带扩展名，也兼容改名失败留下的无扩展名文件（按内容判断类型）
  if (!/^[a-f0-9]{24}(\.[a-z]{3,4})?$/.test(name)) return res.status(404).end();
  const file = path.join(config.avatarDir, name);
  if (!file.startsWith(config.avatarDir) || !fs.existsSync(file)) return res.status(404).end();
  const ext = path.extname(name).slice(1);
  const type = ext ? ext.replace('jpg', 'jpeg') : (detectImageExt(file) || '').slice(1).replace('jpg', 'jpeg');
  if (!type) return res.status(404).end();
  res.setHeader('Content-Type', `image/${type}`);
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.sendFile(file);
});

// 小程序扫码绑定管理员：扫后台生成的绑定码，当前微信升级为管理员
// 一码一人：绑定成功即换新码（旧码立刻失效），码本身带 TTL，泄漏也无法长期使用
router.post('/mp/bind', requireMiniUser, sec.rateLimit({ key: 'bind', windowMs: 60000, max: 15 }), (req, res) => {
  if (sec.checkLock(req, res, 'bind')) return;
  const expected = sec.bindTokenInfo(); // 没有/已过期会就地换新，等于旧码无效
  if (!expected.token) return res.status(400).json({ ok: false, msg: '后台尚未生成绑定码，请先在「微信对接」页生成' });
  const submitted = (req.body || {}).token;
  const ok = sec.verifyBindToken(submitted);
  const ip = sec.clientIp(req);
  if (!ok) {
    sec.recordAttempt(ip, 'bind', false);
    logAudit('mp_bind_fail', `ip=${ip}`, ip, `user#${req.user.id}`);
    // 分布式撞码兜底：全站失败次数越线 → 立刻换码，正在爆破的旧码当场作废
    const globalFails = sec.bindFailuresRecent(sec.BIND_FAIL_WINDOW_MIN);
    const limit = Number(cfg().bindFailRotate) || 50;
    if (globalFails >= limit) sec.rotateBindToken(`auto:global_fails=${globalFails}`);
    return res.status(403).json({ ok: false, msg: '绑定码不正确或已失效' });
  }
  sec.recordAttempt(ip, 'bind', true);
  db.prepare("UPDATE users SET role = 'admin', status = 'approved', approved_at = COALESCE(approved_at, ?) WHERE id = ?")
    .run(nowISO(), req.user.id);
  // 一次性：用完立即换新，避免同一个码被第二个人再次提权
  const rotated = sec.rotateBindToken(`used_by=user#${req.user.id}`);
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  logAudit('mp_bind_ok', `openid=${user.openid}`, ip, `user#${user.id}`);
  res.json({
    ok: true, msg: '绑定成功，你现在是管理员，可扫码登录后台',
    user: publicUser(user), tokenRotated: true, bindExpiresAt: rotated.expiresAt
  });
});

// 普通用户自助绑定：门户里点「绑定微信」→ 给自己生成一张一次性二维码 → 小程序扫码完成绑定
// 只允许账号密码用户（openid 是 local_ 占位）使用；已绑过真微信的直接告诉他不用再绑。
const QRCode = require('qrcode');
router.post('/mp/bind/qr', requireMiniUser, requireApprovedUser, sec.rateLimit({ key: 'selfbind', windowMs: 60000, max: 10 }), async (req, res) => {
  const me = req.user;
  if (me.openid && !/^local_/.test(me.openid)) {
    return res.status(409).json({ ok: false, msg: '该账号已绑定微信，无需重复绑定' });
  }
  db.prepare("UPDATE qr_tickets SET used = 1 WHERE kind = 'bind' AND user_id = ? AND used = 0").run(me.id);
  const ticket = crypto.randomBytes(12).toString('hex');
  const expiresIn = 120;
  db.prepare(`INSERT INTO qr_tickets (ticket, kind, status, user_id, ip, created_at, expires_at, used)
    VALUES (?, 'bind', 'pending', ?, ?, ?, ?, 0)`).run(ticket, me.id, sec.clientIp(req), nowISO(), Date.now() + expiresIn * 1000);
  const qr = await QRCode.toDataURL(`printgate://bind?ticket=${ticket}`, { margin: 1, width: 300, errorCorrectionLevel: 'M' });
  logAudit('mp_self_bind_qr', `user=${me.id}`, sec.clientIp(req), `user#${me.id}`);
  res.json({ ok: true, ticket, qr, expiresIn });
});

router.get('/mp/bind/qr/status', requireMiniUser, (req, res) => {
  const u = req.user;
  res.json({ ok: true, bound: !!(u.openid && !/^local_/.test(u.openid)), nickname: u.nickname || '', openidTail: u.openid ? String(u.openid).slice(-6) : '' });
});

// 扫码绑定普通用户：用户用小程序扫「后台生成的绑定二维码」，把自己的微信绑到那条用户记录上。
// 场景：先在网页用账号密码注册/后台手工建号，之后想让本人用微信进小程序，绑一次即可。
// 约束：必须已通过审批；目标账号不能已有真微信；绑定后把当前微信账号的文件/任务迁移过去，再删掉临时账号。
router.post('/mp/bind-user', requireMiniUser, requireApprovedUser, sec.rateLimit({ key: 'binduser', windowMs: 60000, max: 10 }), (req, res) => {
  const ticket = String((req.body || {}).ticket || '').trim();
  if (!ticket) return res.status(400).json({ ok: false, msg: '缺少绑定票据' });
  const t = db.prepare("SELECT * FROM qr_tickets WHERE ticket = ? AND kind = 'bind'").get(ticket);
  if (!t) return res.status(404).json({ ok: false, msg: '绑定二维码无效，请让管理员重新生成' });
  if (t.used) return res.status(409).json({ ok: false, msg: '该二维码已被使用过，请让管理员重新生成' });
  if (Number(t.expires_at) < Date.now()) return res.status(410).json({ ok: false, msg: '二维码已过期，请让管理员重新生成' });

  const me = req.user;
  // 管理员账号绝不能走这条路径：源账号会被删除，等于把自己的管理员权限弄丢
  if (me.role === 'admin') {
    return res.status(400).json({ ok: false, msg: '管理员账号不能绑定到普通用户；如需切换身份请用其他微信' });
  }
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(t.user_id));
  if (!target) return res.status(404).json({ ok: false, msg: '要绑定的账号不存在，可能已被删除' });
  if (target.role === 'admin') return res.status(400).json({ ok: false, msg: '管理员账号不需要绑定' });
  if (target.id === me.id) return res.status(400).json({ ok: false, msg: '这个微信已经就是该账号了' });
  if (target.openid && !/^local_/.test(target.openid)) {
    return res.status(409).json({ ok: false, msg: '该账号已绑定其他微信，请先在后台解绑' });
  }

  // 事务：迁移文件/任务 → 删掉当前临时账号 → 把 openid 写到目标账号（unique 约束要求先删再写）
  const tx = db.transaction(() => {
    db.prepare('UPDATE files SET user_id = ? WHERE user_id = ?').run(target.id, me.id);
    db.prepare('UPDATE tasks SET user_id = ? WHERE user_id = ?').run(target.id, me.id);
    db.prepare("UPDATE qr_tickets SET used = 1, status = 'used' WHERE ticket = ?").run(ticket);
    db.prepare('DELETE FROM users WHERE id = ?').run(me.id);
    const keepAvatar = target.avatar || me.avatar || '';
    const keepNick = target.nickname || me.nickname || '';
    db.prepare('UPDATE users SET openid = ?, unionid = ?, avatar = ?, nickname = ?, updated_at = ? WHERE id = ?')
      .run(me.openid, me.unionid || '', keepAvatar, keepNick, nowISO(), target.id);
  });
  try { tx(); } catch (e) {
    return res.status(500).json({ ok: false, msg: '绑定失败：' + e.message });
  }

  const fresh = db.prepare('SELECT * FROM users WHERE id = ?').get(target.id);
  logAudit('mp_bind_user_ok', `target=${target.id} openid=${String(me.openid).slice(0, 10)}…`, sec.clientIp(req), `user#${target.id}`);
  // 旧令牌指向已删除的账号，必须换发新令牌，否则小程序下一次请求就 401
  res.json({ ok: true, msg: '绑定成功，已使用该账号', token: sec.signUser(fresh), user: publicUser(fresh) });
});

// 扫码登录：小程序扫网页二维码 -> 扫描(scanned) -> 确认(confirmed)
router.post('/mp/qr/scan', requireMiniUser, sec.rateLimit({ key: 'qrscan', windowMs: 60000, max: 60 }), (req, res) => {
  const ticket = String((req.body || {}).ticket || '');
  const t = sec.getTicket(ticket);
  if (!t) return res.status(404).json({ ok: false, msg: '二维码无效或已过期' });
  if (t.status === 'expired') return res.json({ ok: false, msg: '二维码已过期，请在网页刷新' });
  // 普通用户也能扫码登录网页（只拿到用户会话：打印 + 自己的历史），管理员拿到管理会话
  if (req.user.status !== 'approved') {
    return res.status(403).json({ ok: false, msg: '当前微信未获授权，请先在小程序里提交申请，等管理员审批' });
  }
  if (t.status === 'pending') sec.markTicket(ticket, 'scanned', req.user.id);
  res.json({ ok: true, msg: '已扫描，请在确认页点击「确认登录」', user: publicUser(req.user) });
});

router.post('/mp/qr/confirm', requireMiniUser, sec.rateLimit({ key: 'qrconfirm', windowMs: 60000, max: 60 }), (req, res) => {
  const ticket = String((req.body || {}).ticket || '');
  const t = sec.getTicket(ticket);
  if (!t || t.status === 'expired') return res.status(404).json({ ok: false, msg: '二维码已过期，请在网页刷新' });
  if (req.user.status !== 'approved') {
    return res.status(403).json({ ok: false, msg: '当前微信未获授权，暂不能登录网页' });
  }
  sec.markTicket(ticket, 'confirmed', req.user.id);
  logAudit('qr_confirm', `ticket=${ticket.slice(0, 8)}… user=${req.user.id}`, sec.clientIp(req), `user#${req.user.id}`);
  res.json({ ok: true, msg: '已确认，网页将自动登录' });
});

// ---------- 小程序管理台（管理员专用） ----------
// 后台能改的项很多，这里只开放小程序里真正需要、且改错也不会把自己锁在外面的那部分。
const MP_SETTABLE = {
  maxFileMB: { type: 'int', min: 1, max: 500 },
  maxCopies: { type: 'int', min: 1, max: 99 },
  maxPages: { type: 'int', min: 1, max: 2000 },
  historyDays: { type: 'int', min: 0, max: 3650 },
  approveNewUser: { type: 'bool' },
  approveEachJob: { type: 'bool' },
  enableQrLogin: { type: 'bool' },
  autoCleanHistory: { type: 'bool' },
  defaultPrinter: { type: 'string', max: 64 }
};

router.get('/mp/admin/overview', requireMiniUser, requireMiniAdmin, async (req, res) => {
  const pendingUsers = db.prepare("SELECT COUNT(*) c FROM users WHERE status = 'pending'").get().c;
  const totalUsers = db.prepare('SELECT COUNT(*) c FROM users').get().c;
  const pendingTasks = db.prepare("SELECT COUNT(*) c FROM tasks WHERE status = 'pending'").get().c;
  const printing = db.prepare("SELECT COUNT(*) c FROM tasks WHERE status = 'printing'").get().c;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const todayTasks = db.prepare('SELECT COUNT(*) c FROM tasks WHERE created_at >= ?').get(today.toISOString()).c;
  const files = db.prepare("SELECT COUNT(*) c FROM files WHERE status = 'active'").get().c;
  let printers = [];
  let cupsOk = false;
  try {
    const list = await cups.listPrinters();
    printers = (list.printers || []).map((p) => ({ name: p.name, state: p.state, enabled: p.enabled, isDefault: !!p.isDefault }));
    cupsOk = !!list.ok;
  } catch (_) { /* CUPS 不可用时给空列表 */ }
  res.json({
    ok: true,
    overview: { pendingUsers, totalUsers, pendingTasks, printing, todayTasks, files, cupsOk, printerCount: printers.length },
    printers
  });
});

router.get('/mp/admin/users', requireMiniUser, requireMiniAdmin, (req, res) => {
  const status = String(req.query.status || 'all');
  const where = [];
  const args = [];
  if (status !== 'all') { where.push('status = ?'); args.push(status); }
  const kw = String(req.query.q || '').trim();
  if (kw) {
    where.push(`(nickname LIKE ? ESCAPE '\\' OR openid LIKE ? ESCAPE '\\' OR wechat_id LIKE ? ESCAPE '\\'
                 OR phone LIKE ? ESCAPE '\\' OR real_name LIKE ? ESCAPE '\\' OR note LIKE ? ESCAPE '\\'
                 OR apply_note LIKE ? ESCAPE '\\')`);
    const p = `%${like(kw)}%`;
    args.push(p, p, p, p, p, p, p);
  }
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const rows = db.prepare(`SELECT * FROM users ${w} ORDER BY id DESC LIMIT 100`).all(...args);
  res.json({ ok: true, users: rows.map(publicUser) });
});

router.post('/mp/admin/users/:id/:action(approve|reject|block|unblock|delete)', requireMiniUser, requireMiniAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const action = req.params.action;
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    if (!u) return res.status(404).json({ ok: false, msg: '用户不存在' });
    if (u.id === req.user.id && (action === 'delete' || action === 'block')) {
      return res.status(400).json({ ok: false, msg: '不能对自己执行该操作' });
    }
    let msg = '已处理';
    if (action === 'approve') {
      db.prepare("UPDATE users SET status = 'approved', approved_at = COALESCE(approved_at, ?), approved_by = ?, updated_at = ? WHERE id = ?")
        .run(nowISO(), `admin#${req.user.id}`, nowISO(), id);
      msg = '已授权';
    } else if (action === 'reject') {
      db.prepare("UPDATE users SET status = 'rejected', approved_at = NULL, updated_at = ? WHERE id = ?").run(nowISO(), id);
      msg = '已拒绝';
    } else if (action === 'block') {
      db.prepare("UPDATE users SET status = 'blocked', updated_at = ? WHERE id = ?").run(nowISO(), id);
      msg = '已拉黑';
    } else if (action === 'unblock') {
      db.prepare("UPDATE users SET status = 'approved', approved_at = COALESCE(approved_at, ?), updated_at = ? WHERE id = ?").run(nowISO(), nowISO(), id);
      msg = '已解除拉黑';
    } else {
      // 真正的删除：与网页端一致，连带清理上传文件与任务。
      // 文件删不掉的进孤儿清单（用户行必须删掉，不能卡在磁盘占用上），后续清理任务重试
      for (const f of db.prepare('SELECT * FROM files WHERE user_id = ?').all(id)) {
        const ok = await fsutil.safeUnlink(f.storage_path, { label: `删用户 ${id} 的文件` });
        if (!ok) orphans.add(f.storage_path);
      }
      // 头像文件独立于 files 表，单独清掉（与网页端 users.js 行为对齐）
      if (String(u.avatar || '').startsWith('/api/mp/avatar/')) {
        const p = path.join(config.avatarDir, path.basename(u.avatar));
        const ok = await fsutil.safeUnlink(p, { label: `删用户 ${id} 的头像` });
        if (!ok) orphans.add(p);
      }
      db.prepare('DELETE FROM files WHERE user_id = ?').run(id);
      db.prepare('DELETE FROM tasks WHERE user_id = ?').run(id);
      db.prepare('DELETE FROM users WHERE id = ?').run(id);
      msg = '用户及其数据已删除';
    }
    logAudit(`mp_admin_user_${action}`, `id=${id} openid=${u.openid}`, sec.clientIp(req), `user#${req.user.id}`);
    res.json({ ok: true, msg });
  } catch (e) {
    console.error('[mp/admin/users]', e);
    res.status(500).json({ ok: false, msg: '操作失败：' + e.message });
  }
});

router.get('/mp/admin/tasks', requireMiniUser, requireMiniAdmin, (req, res) => {
  const status = String(req.query.status || 'pending');
  const w = status === 'all' ? '' : 'WHERE t.status = ?';
  const args = status === 'all' ? [] : [status];
  const rows = db.prepare(
    `SELECT t.*, f.filename, u.nickname FROM tasks t
     LEFT JOIN files f ON f.id = t.file_id LEFT JOIN users u ON u.id = t.user_id
     ${w} ORDER BY t.id DESC LIMIT 50`
  ).all(...args);
  res.json({ ok: true, tasks: rows.map((t) => ({
    id: t.id, printer: t.printer, copies: t.copies, status: t.status, pages: t.pages,
    source: t.source, created_at: t.created_at, error: t.error || '',
    filename: t.filename || '', nickname: t.nickname || ''
  })) });
});

router.post('/mp/admin/tasks/:id/:action(approve|reject)', requireMiniUser, requireMiniAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const t = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
  if (!t) return res.status(404).json({ ok: false, msg: '任务不存在' });
  if (t.status !== 'pending') return res.status(400).json({ ok: false, msg: `任务已${t.status}，无需处理` });
  // 条件更新 + 校验 changes：两个人同时点（或双击）时只有一个能改成功，
  // 否则会各投递一次 → 同一份文件打两遍。
  if (req.params.action === 'approve') {
    const upd = db.prepare("UPDATE tasks SET status = 'approved', approved_at = ? WHERE id = ? AND status = 'pending'")
      .run(nowISO(), id);
    if (!upd.changes) return res.status(409).json({ ok: false, msg: '该任务已被其他管理员处理' });
    logAudit('mp_admin_task_approve', `task=${id}`, sec.clientIp(req), `user#${req.user.id}`);
    // 与网页端一致：放行后立即投递
    const printRoutes = require('./print');
    printRoutes.executeTask(id).catch(() => {});
  } else {
    const upd = db.prepare("UPDATE tasks SET status = 'rejected', finished_at = ? WHERE id = ? AND status = 'pending'")
      .run(nowISO(), id);
    if (!upd.changes) return res.status(409).json({ ok: false, msg: '该任务已被其他管理员处理' });
    logAudit('mp_admin_task_reject', `task=${id}`, sec.clientIp(req), `user#${req.user.id}`);
  }
  res.json({ ok: true, msg: req.params.action === 'approve' ? '已放行，正在发送' : '已拒绝' });
});

// 清理已结束的任务记录（小程序「记录 → 清理」用；网页端没有对应入口，这里补齐）
// 只允许清 done / failed / rejected / canceled，pending 与 printing 一律不动，避免误删在打的活。
const CLEANABLE_STATUS = ['done', 'failed', 'rejected', 'canceled'];
router.post('/mp/admin/tasks/cleanup', requireMiniUser, requireMiniAdmin, (req, res) => {
  const want = String((req.body && req.body.status) || '').trim();
  if (want && !CLEANABLE_STATUS.includes(want)) {
    return res.status(400).json({ ok: false, msg: '只能清理已完成 / 失败 / 已拒绝 / 已取消的任务' });
  }
  const list = want ? [want] : CLEANABLE_STATUS;
  const ph = list.map(() => '?').join(',');
  const before = db.prepare(`SELECT COUNT(*) c FROM tasks WHERE status IN (${ph})`).get(...list).c;
  if (!before) return res.json({ ok: true, deleted: 0, msg: '没有可清理的记录' });
  const del = db.prepare(`DELETE FROM tasks WHERE status IN (${ph})`).run(...list);
  logAudit('mp_admin_task_cleanup', `status=${want || 'all'} deleted=${del.changes}`, sec.clientIp(req), `user#${req.user.id}`);
  res.json({ ok: true, deleted: del.changes, msg: `已清理 ${del.changes} 条记录` });
});

router.get('/mp/admin/printers', requireMiniUser, requireMiniAdmin, async (req, res) => {
  const list = await cups.listPrinters();
  res.json({
    ok: true,
    printers: (list.printers || []).map((p) => ({
      name: p.name, state: p.state, enabled: p.enabled, accepting: p.accepting,
      isDefault: !!p.isDefault, uri: p.uri || '', info: p.info || ''
    })),
    default: list.default || ''
  });
});

router.post('/mp/admin/printers/:name/:action(pause|resume|default)', requireMiniUser, requireMiniAdmin, async (req, res) => {
  const name = req.params.name;
  let r;
  if (req.params.action === 'pause') r = await cups.pausePrinter(name);
  else if (req.params.action === 'resume') r = await cups.resumePrinter(name);
  else r = await cups.setDefault(name);
  logAudit(`mp_admin_printer_${req.params.action}`, name, sec.clientIp(req), `user#${req.user.id}`);
  res.json(r && r.ok !== undefined ? r : { ok: true, msg: '已处理' });
});

router.get('/mp/admin/settings', requireMiniUser, requireMiniAdmin, async (req, res) => {
  const c = cfg();
  const list = await cups.listPrinters().catch(() => ({ printers: [] }));
  res.json({
    ok: true,
    settings: {
      maxFileMB: c.maxFileMB, maxCopies: c.maxCopies, maxPages: c.maxPages,
      historyDays: c.historyDays, approveNewUser: !!c.approveNewUser,
      approveEachJob: !!c.approveEachJob, enableQrLogin: !!c.enableQrLogin,
      autoCleanHistory: !!c.autoCleanHistory, defaultPrinter: c.defaultPrinter || ''
    },
    printers: (list.printers || []).map((p) => p.name),
    schema: Object.keys(MP_SETTABLE)
  });
});

router.put('/mp/admin/settings', requireMiniUser, requireMiniAdmin, (req, res) => {
  const b = req.body || {};
  const updates = {};
  const errors = [];
  for (const [key, rule] of Object.entries(MP_SETTABLE)) {
    if (!(key in b)) continue;
    const v = b[key];
    if (rule.type === 'int') {
      const n = parseInt(v, 10);
      if (!Number.isFinite(n) || n < rule.min || n > rule.max) errors.push(`${key} 需在 ${rule.min}-${rule.max} 之间`);
      else updates[key] = n;
    } else if (rule.type === 'bool') {
      updates[key] = !!(v === true || v === 'true' || v === 1 || v === '1');
    } else {
      const s = String(v || '').trim().slice(0, rule.max);
      if (s.length > rule.max) errors.push(`${key} 过长`);
      else updates[key] = s;
    }
  }
  if (!Object.keys(updates).length && !errors.length) return res.status(400).json({ ok: false, msg: '没有需要保存的设置' });
  if (errors.length) return res.status(400).json({ ok: false, msg: errors[0] });
  setSettings(updates);
  logAudit('mp_admin_settings', Object.keys(updates).join(','), sec.clientIp(req), `user#${req.user.id}`);
  res.json({ ok: true, msg: '设置已保存并生效', updates: Object.keys(updates) });
});

router.get('/mp/version', (req, res) => res.json({ ok: true, version: config.version, app: 'PrintGate' }));

module.exports = router;
module.exports.upsertUser = upsertUser;
