'use strict';
// 小程序用户管理：审批 / 拒绝 / 拉黑 / 角色 / 资料 / 删除
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('../config');
const fsutil = require('../fsutil');
const orphans = require('../orphans');
const { db, logAudit, nowISO } = require('../db');
const { intId } = require('../idutil');
const sec = require('../security');
const { requireAdmin, publicUser } = require('../middleware');
const acc = require('./account');

const router = express.Router();

// 搜索关键词里若带 % 或 _ ，LIKE 会把它当通配符（输入 % 就等于查全部），
// 统一转义后再拼，保证搜的是字面量
const like = (s) => String(s).replace(/[\\%_]/g, (c) => `\\${c}`);

// 管理员可代用户维护的资料字段（note 是管理员备注，其余为申请资料）
const EDITABLE = [
  ['nickname', 64], ['real_name', 64], ['wechat_id', 64],
  ['phone', 32], ['apply_note', 200], ['note', 200]
];

const ACTIONS = {
  approve: { sql: "UPDATE users SET status='approved', approved_at=COALESCE(approved_at, ?), approved_by=?, updated_at=? WHERE id=? AND status<>'approved'", msg: '已授权', log: 'user_approve' },
  reject: { sql: "UPDATE users SET status='rejected', approved_at=NULL, updated_at=? WHERE id=? AND status<>'rejected'", msg: '已拒绝', log: 'user_reject' },
  block: { sql: "UPDATE users SET status='blocked', updated_at=? WHERE id=? AND status<>'blocked'", msg: '已拉黑', log: 'user_block' },
  unblock: { sql: "UPDATE users SET status='approved', approved_at=COALESCE(approved_at, ?), approved_by=?, updated_at=? WHERE id=? AND status<>'approved'", msg: '已解除拉黑', log: 'user_unblock' },
  promote: { sql: "UPDATE users SET role='admin', status='approved', approved_at=COALESCE(approved_at, ?), updated_at=? WHERE id=? AND role<>'admin'", msg: '已设为管理员', log: 'user_promote' },
  demote: { sql: "UPDATE users SET role='user', updated_at=? WHERE id=? AND role<>'user'", msg: '已取消管理员', log: 'user_demote' }
};

function findUser(id) {
  // 必须用严格数字校验：parseInt("1e9") === 1，会把 1e9 号用户解析成 1 号
  const n = intId(id);
  if (!n) return null;
  return db.prepare('SELECT * FROM users WHERE id = ?').get(n);
}

router.get('/users', requireAdmin, (req, res) => {
  const status = String(req.query.status || 'all');
  const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
  const size = Math.min(Math.max(parseInt(req.query.size, 10) || 20, 1), 200);
  const args = [];
  const where = [];
  if (status !== 'all') { where.push('status = ?'); args.push(status); }
  const kw = String(req.query.q || '').trim();
  if (kw) {
    where.push(`(nickname LIKE ? ESCAPE '\\' OR openid LIKE ? ESCAPE '\\' OR note LIKE ? ESCAPE '\\'
                 OR wechat_id LIKE ? ESCAPE '\\' OR phone LIKE ? ESCAPE '\\' OR real_name LIKE ? ESCAPE '\\'
                 OR apply_note LIKE ? ESCAPE '\\')`);
    const p = `%${like(kw)}%`;
    args.push(p, p, p, p, p, p, p);
  }
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = db.prepare(`SELECT COUNT(*) c FROM users ${w}`).get(...args).c;
  const rows = db.prepare(`SELECT * FROM users ${w} ORDER BY id DESC LIMIT ? OFFSET ?`).all(...args, size, (page - 1) * size);
  const stats = {
    total: db.prepare('SELECT COUNT(*) c FROM users').get().c,
    pending: db.prepare("SELECT COUNT(*) c FROM users WHERE status='pending'").get().c,
    approved: db.prepare("SELECT COUNT(*) c FROM users WHERE status='approved'").get().c,
    rejected: db.prepare("SELECT COUNT(*) c FROM users WHERE status='rejected'").get().c,
    blocked: db.prepare("SELECT COUNT(*) c FROM users WHERE status='blocked'").get().c,
    admins: db.prepare("SELECT COUNT(*) c FROM users WHERE role='admin'").get().c
  };
  res.json({ ok: true, users: rows.map(publicUser), total, page, size, stats });
});

// 导出用户台账：与审计导出一致，CSV 单元格要做公式注入中和
function csvCell(v) {
  let s = String(v === undefined || v === null ? '' : v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

router.get('/users/export', requireAdmin, (req, res) => {
  const status = String(req.query.status || 'all');
  const args = [];
  const where = status === 'all' ? '' : 'WHERE status = ?';
  if (where) args.push(status);
  const rows = db.prepare(
    `SELECT u.*, (SELECT COUNT(*) FROM tasks t WHERE t.user_id = u.id) tasks
     FROM users u ${where} ORDER BY u.id DESC`
  ).all(...args);
  const STATUS_TEXT = { pending: '待审批', approved: '已授权', rejected: '已拒绝', blocked: '已拉黑' };
  const head = ['ID', '昵称', '姓名', '微信号', '手机号', '角色', '状态', '申请说明', '管理员备注', '申请时间', '授权时间', '最近登录', '打印任务数', 'OpenID'];
  const lines = [head.map(csvCell).join(',')];
  for (const u of rows) {
    lines.push([
      u.id, u.nickname, u.real_name, u.wechat_id, u.phone,
      u.role === 'admin' ? '管理员' : '普通用户',
      STATUS_TEXT[u.status] || u.status,
      u.apply_note, u.note, u.created_at, u.approved_at || '', u.last_login || '', u.tasks, u.openid
    ].map(csvCell).join(','));
  }
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="printgate-users-${new Date().toISOString().slice(0, 10)}.csv"`);
  // BOM 保证 Excel 打开中文不乱码
  res.send('\uFEFF' + lines.join('\r\n'));
  logAudit('user_export', `${rows.length} 条 status=${status}`, sec.clientIp(req), 'admin');
});

// 用户详情：资料 + 最近打印统计，供管理端抽屉展示
router.get('/users/:id', requireAdmin, (req, res) => {
  const u = findUser(req.params.id);
  if (!u) return res.status(404).json({ ok: false, msg: '用户不存在' });
  const stat = db.prepare(
    `SELECT COUNT(*) tasks, COALESCE(SUM(copies), 0) copies,
            COALESCE(SUM(CASE WHEN status='done' THEN copies ELSE 0 END), 0) done_copies
     FROM tasks WHERE user_id = ?`
  ).get(u.id);
  const files = db.prepare('SELECT COUNT(*) c, COALESCE(SUM(size), 0) size FROM files WHERE user_id = ?').get(u.id);
  const recent = db.prepare(
    `SELECT t.id, t.printer, t.copies, t.status, t.created_at, f.filename
     FROM tasks t LEFT JOIN files f ON f.id = t.file_id
     WHERE t.user_id = ? ORDER BY t.id DESC LIMIT 5`
  ).all(u.id);
  res.json({
    ok: true,
    user: publicUser(u),
    stats: {
      tasks: stat.tasks, copies: stat.copies, doneCopies: stat.done_copies,
      files: files.c, fileSize: files.size
    },
    recent
  });
});

function runAction(u, action, actor) {
  const rule = ACTIONS[action];
  if (!rule) return { code: 400, msg: '未知操作' };
  const t = nowISO();
  let args;
  if (action === 'approve' || action === 'unblock') args = [t, actor, t, u.id];
  else if (action === 'reject' || action === 'block' || action === 'demote') args = [t, u.id];
  else args = [t, t, u.id]; // promote
  const r = db.prepare(rule.sql).run(...args);
  // 条件更新命中 0 行：状态已经是目标值（并发双击/重复点击），按成功处理更省心
  // changed=false 时不写审计，避免刷日志
  return { ok: true, msg: r.changes ? rule.msg : '状态无需变更', log: rule.log, changed: !!r.changes };
}

function applyAction(req, res, u, action) {
  const out = runAction(u, action, 'admin');
  if (out.code) return res.status(out.code).json({ ok: false, msg: out.msg });
  if (out.changed) logAudit(out.log, `user=${u.id} openid=${u.openid} name=${u.nickname || ''}`, sec.clientIp(req), 'admin');
  const fresh = db.prepare('SELECT * FROM users WHERE id = ?').get(u.id);
  res.json({ ok: true, msg: out.msg, user: publicUser(fresh) });
}

// 手工添加用户：支持「微信 OpenID」与「用户名 + 密码」两种
// - 微信方式要 OpenID（唯一身份，不能乱编）
// - 账号方式要用户名 + 密码，openid 自动生成 local_xxx 占位，与微信用户共用同一套权限/任务体系
router.post('/users', requireAdmin, (req, res) => {
  const b = req.body || {};
  const mode = b.mode === 'account' || b.username ? 'account' : 'wechat';
  const role = b.role === 'admin' ? 'admin' : 'user';
  const status = ['pending', 'approved', 'blocked'].includes(b.status) ? b.status : 'approved';
  const pick = (k, max) => String(b[k] == null ? '' : b[k]).trim().slice(0, max);
  const vals = {
    nickname: pick('nickname', 64),
    wechat_id: pick('wechat_id', 64),
    phone: pick('phone', 32),
    real_name: pick('real_name', 64),
    apply_note: pick('apply_note', 200),
    note: pick('note', 200)
  };

  let openid = '';
  let username = null;
  let passHash = null;

  if (mode === 'account') {
    const acc = require('./account');
    username = acc.normalizeUsername(b.username);
    if (!acc.USERNAME_RE.test(username)) {
      return res.status(400).json({ ok: false, msg: '用户名 3-32 位，只能用小写字母、数字、点、下划线或短横线，且以字母或数字开头' });
    }
    if (acc.findByUsername(username)) return res.status(409).json({ ok: false, msg: '该用户名已被占用' });
    const pwdErr = acc.passwordProblem(b.password, b.confirmPassword);
    if (pwdErr) return res.status(400).json({ ok: false, msg: pwdErr });
    passHash = sec.hashPassword(b.password);
    openid = acc.localOpenid();
    if (!vals.nickname) vals.nickname = username;
  } else {
    openid = String(b.openid || '').trim();
    if (!openid) return res.status(400).json({ ok: false, msg: '缺少 OpenID（让用户在小程序「我的资料」页复制给你），或改用账号密码方式添加' });
    if (!sec.validOpenid(openid)) {
      return res.status(400).json({ ok: false, msg: 'OpenID 格式不正确（10-64 位字母、数字、下划线或短横线）' });
    }
    if (db.prepare('SELECT id FROM users WHERE openid = ?').get(openid)) {
      return res.status(409).json({ ok: false, msg: '该 OpenID 已存在，无需重复添加' });
    }
    if (!vals.nickname) vals.nickname = '微信用户';
  }

  try {
    const r = db.prepare(
      `INSERT INTO users (openid, username, pass_hash, unionid, nickname, avatar, wechat_id, phone, real_name,
                          apply_note, role, status, created_at, approved_at, approved_by, note, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      openid, username, passHash, '', vals.nickname, '', vals.wechat_id, vals.phone, vals.real_name,
      vals.apply_note, role, status, nowISO(),
      status === 'approved' ? nowISO() : null,
      status === 'approved' ? 'admin/manual' : null,
      vals.note, nowISO()
    );
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(r.lastInsertRowid);
    logAudit('user_create', `mode=${mode} ${username ? 'username=' + username : 'openid=' + openid} role=${role} status=${status}`,
      sec.clientIp(req), `user#${user.id}`);
    res.json({
      ok: true,
      msg: `已添加${role === 'admin' ? '管理员' : '用户'}：${user.nickname}${username ? `（账号 ${username}）` : ''}`,
      user: publicUser(user)
    });
  } catch (e) {
    if (/UNIQUE/.test(e.message)) return res.status(409).json({ ok: false, msg: '用户名或 OpenID 已存在' });
    res.status(500).json({ ok: false, msg: '添加失败：' + e.message });
  }
});

// 最后一个已授权管理员不能被降级/拉黑/删除：否则后台就再也没有微信或账号能进
function isLastActiveAdmin(u) {
  if (u.role !== 'admin' || u.status !== 'approved') return false;
  return db.prepare("SELECT COUNT(*) c FROM users WHERE role='admin' AND status='approved' AND id<>?").get(u.id).c === 0;
}

router.post('/users/:id/:action(approve|reject|block|unblock|promote|demote)', requireAdmin, (req, res) => {
  const u = findUser(req.params.id);
  if (!u) return res.status(404).json({ ok: false, msg: '用户不存在' });
  const action = req.params.action;
  if (['demote', 'block', 'reject'].includes(action) && isLastActiveAdmin(u)) {
    return res.status(400).json({ ok: false, msg: '这是最后一个已授权管理员，不能降级或禁用；请先添加另一个管理员' });
  }
  applyAction(req, res, u, action);
});

// 批量审批：待审批列表一键通过/拒绝
router.post('/users/batch', requireAdmin, (req, res) => {
  const { ids, action } = req.body || {};
  if (!ACTIONS[action] || !['approve', 'reject', 'block', 'unblock'].includes(action)) {
    return res.status(400).json({ ok: false, msg: '不支持的批量操作' });
  }
  const list = Array.isArray(ids) ? ids.map((i) => parseInt(i, 10)).filter(Number.isFinite) : [];
  if (!list.length) return res.status(400).json({ ok: false, msg: '请先选择用户' });
  let done = 0;
  let skipped = 0;
  for (const id of [...new Set(list)].slice(0, 200)) {
    const u = findUser(id);
    if (!u) continue;
    const out = runAction(u, action, 'admin');
    if (!out.ok) continue;
    if (!out.changed) { skipped++; continue; }
    done++;
    logAudit(out.log, `batch user=${u.id}`, sec.clientIp(req), 'admin');
  }
  res.json({ ok: true, msg: `已处理 ${done} 位用户${skipped ? `（${skipped} 位状态无需变更）` : ''}`, done, skipped });
});

// 管理员代改资料（备注 / 微信号 / 手机号 / 姓名等）
router.put('/users/:id', requireAdmin, (req, res) => {
  const u = findUser(req.params.id);
  if (!u) return res.status(404).json({ ok: false, msg: '用户不存在' });
  const sets = [];
  const args = [];
  for (const [key, max] of EDITABLE) {
    if (!(key in (req.body || {}))) continue;
    const v = String(req.body[key] == null ? '' : req.body[key]).trim().slice(0, max);
    if (v === (u[key] || '')) continue;
    sets.push(`${key} = ?`);
    args.push(v);
  }
  if (!sets.length) return res.json({ ok: true, msg: '资料无变化', user: publicUser(u) });
  sets.push('updated_at = ?');
  args.push(nowISO(), u.id);
  db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...args);
  logAudit('user_edit', `user=${u.id} fields=${sets.slice(0, -1).join(',')}`, sec.clientIp(req), 'admin');
  const fresh = db.prepare('SELECT * FROM users WHERE id = ?').get(u.id);
  res.json({ ok: true, msg: '资料已保存', user: publicUser(fresh) });
});

router.put('/users/:id/note', requireAdmin, (req, res) => {
  const u = findUser(req.params.id);
  if (!u) return res.status(404).json({ ok: false, msg: '用户不存在' });
  const note = String((req.body || {}).note || '').slice(0, 200);
  db.prepare('UPDATE users SET note = ?, updated_at = ? WHERE id = ?').run(note, nowISO(), u.id);
  res.json({ ok: true, msg: '备注已保存' });
});

router.delete('/users/:id', requireAdmin, async (req, res) => {
  try {
    const u = findUser(req.params.id);
    if (!u) return res.status(404).json({ ok: false, msg: '用户不存在' });
    // 别把最后一个管理员删了：删完就没有任何微信能扫码登录后台
    if (u.role === 'admin' && u.status === 'approved') {
      const left = db.prepare("SELECT COUNT(*) c FROM users WHERE role='admin' AND status='approved' AND id<>?").get(u.id).c;
      if (!left) return res.status(400).json({ ok: false, msg: '这是最后一个已授权管理员，删除后将无人能扫码登录后台' });
    }
    const files = db.prepare('SELECT * FROM files WHERE user_id = ?').all(u.id);
    // 文件删不动的进孤儿清单（用户必须能删掉，不能卡在磁盘占用上），后续清理任务会重试
    for (const f of files) {
      const ok = await fsutil.safeUnlink(f.storage_path, { label: `删用户 ${u.id} 的文件` });
      if (!ok) orphans.add(f.storage_path);
    }
    db.prepare('DELETE FROM files WHERE user_id = ?').run(u.id);
    db.prepare('DELETE FROM tasks WHERE user_id = ?').run(u.id);
    db.prepare('DELETE FROM users WHERE id = ?').run(u.id);
    // 头像文件独立于 files 表，单独清掉
    if (String(u.avatar || '').startsWith('/api/mp/avatar/')) {
      const ok = await fsutil.safeUnlink(path.join(config.avatarDir, path.basename(u.avatar)), { label: '删用户的头像' });
      if (!ok) orphans.add(path.join(config.avatarDir, path.basename(u.avatar)));
    }
    logAudit('user_delete', `user=${u.id} openid=${u.openid}`, sec.clientIp(req), 'admin');
    res.json({ ok: true, msg: '用户及其数据已删除' });
  } catch (e) {
    res.status(500).json({ ok: false, msg: '删除失败：' + e.message });
  }
});

// ---------- 扫码绑定：给普通用户生成一次性绑定二维码 ----------
const QRCode = require('qrcode');

router.post('/users/:id/bind-qr', requireAdmin, async (req, res) => {
  const id = intId(req.params.id);
  if (!id) return res.status(404).json({ ok: false, msg: '用户不存在' });
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!u) return res.status(404).json({ ok: false, msg: '用户不存在' });
  if (u.role === 'admin') return res.status(400).json({ ok: false, msg: '管理员账号不需要扫码绑定' });
  if (u.openid && !/^local_/.test(u.openid)) {
    return res.status(409).json({ ok: false, msg: '该账号已绑定微信，如需换绑请先在列表里解绑' });
  }
  // 同一个人重复点「扫码绑定」时，作废上一张票，避免旧码还能用
  db.prepare("UPDATE qr_tickets SET used = 1 WHERE kind = 'bind' AND user_id = ? AND used = 0").run(id);
  const ticket = sec.randToken ? sec.randToken(16) : crypto.randomBytes(12).toString('hex');
  const expiresIn = 120;
  const now = Date.now();
  db.prepare(`INSERT INTO qr_tickets (ticket, kind, status, user_id, ip, created_at, expires_at, used)
    VALUES (?, 'bind', 'pending', ?, ?, ?, ?, 0)`).run(ticket, id, sec.clientIp(req), nowISO(), now + expiresIn * 1000);
  const qr = await QRCode.toDataURL(`printgate://bind?ticket=${ticket}`, { margin: 1, width: 300, errorCorrectionLevel: 'M' });
  logAudit('user_bind_qr', `user=${id} ticket=${ticket.slice(0, 8)}…`, sec.clientIp(req), 'admin');
  res.json({ ok: true, ticket, qr, expiresIn, user: publicUser(u) });
});

// 后台弹窗轮询：这张票被用掉没有、绑上的是哪个微信
router.get('/users/:id/bind-status', requireAdmin, (req, res) => {
  const id = intId(req.params.id);
  if (!id) return res.status(404).json({ ok: false, msg: '用户不存在' });
  const t = db.prepare("SELECT * FROM qr_tickets WHERE kind = 'bind' AND user_id = ? ORDER BY rowid DESC LIMIT 1").get(id);
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!u) return res.status(404).json({ ok: false, msg: '用户不存在' });
  res.json({
    ok: true,
    bound: !!(u.openid && !/^local_/.test(u.openid)),
    nickname: u.nickname || '',
    openidTail: u.openid ? String(u.openid).slice(-6) : '',
    ticketUsed: t ? !!t.used : false,
  });
});

// 解绑：把 openid 换回占位，用户名密码登录不受影响
router.post('/users/:id/unbind-wechat', requireAdmin, (req, res) => {
  const id = intId(req.params.id);
  if (!id) return res.status(404).json({ ok: false, msg: '用户不存在' });
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!u) return res.status(404).json({ ok: false, msg: '用户不存在' });
  if (u.role === 'admin') return res.status(400).json({ ok: false, msg: '管理员账号不支持解绑微信，避免把自己锁在门外' });
  if (!u.openid || /^local_/.test(u.openid)) return res.status(400).json({ ok: false, msg: '该账号本来就没绑定微信' });
  // 记下原 openid：同一微信再次登录会命中 prev_openid，回到这条账号而不是新建一个
  db.prepare('UPDATE users SET prev_openid = ?, openid = ?, updated_at = ? WHERE id = ?')
    .run(u.openid, `local_unbound_${id}_${Date.now().toString(36)}`, nowISO(), id);
  logAudit('user_unbind_wechat', `user=${id}`, sec.clientIp(req), 'admin');
  res.json({ ok: true, msg: '已解绑；该微信下次登录会回到这个账号，历史记录不受影响' });
});

// 管理员重置密码：网页端「忘记密码联系管理员」这条流程之前没有对应接口，
// 这里补上。不传 password 就生成一个随机强密码，只回显一次。
router.post('/users/:id/reset-password', requireAdmin, (req, res) => {
  const id = intId(req.params.id);
  if (!id) return res.status(404).json({ ok: false, msg: '用户不存在' });
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!u) return res.status(404).json({ ok: false, msg: '用户不存在' });
  if (u.role === 'admin') return res.status(400).json({ ok: false, msg: '不支持在这里重置管理员密码，请用后台登录密码流程' });

  const wanted = String((req.body || {}).password || '').trim();
  let plain = wanted;
  if (plain) {
    const err = acc.passwordProblem(plain, plain);
    if (err) return res.status(400).json({ ok: false, msg: err });
  } else {
    // 12 位，去掉容易混淆的字符
    const pool = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
    plain = Array.from({ length: 12 }, () => pool[crypto.randomInt(pool.length)]).join('');
  }

  db.prepare('UPDATE users SET pass_hash = ?, pwd_changed_at = ?, updated_at = ? WHERE id = ?')
    .run(sec.hashPassword(plain), nowISO(), nowISO(), id);
  logAudit('user_reset_password', `user=${id} username=${u.username || u.openid}`, sec.clientIp(req), 'admin');
  res.json({ ok: true, msg: '密码已重置，旧会话已失效', password: plain, generated: !wanted });
});

module.exports = router;
module.exports.ACTIONS = ACTIONS;
