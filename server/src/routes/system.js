'use strict';
// 系统：概览统计 / 服务状态 / 日志 / 审计 / 运行信息
const express = require('express');
const os = require('os');
const cups = require('../cups');
const system = require('../system');
const config = require('../config');
const { db, cfg, logAudit, nowISO } = require('../db');
const sec = require('../security');
const { requireAdmin, publicUser } = require('../middleware');

const router = express.Router();

// 搜索关键词里的 % / _ 是 LIKE 通配符，不转义的话输入 % 等于「查全部」
const like = (s) => String(s).replace(/[\\%_]/g, (c) => `\\${c}`);

// CSV 单元格：既要处理引号，也要防「公式注入」——
// 审计里的 detail 可能包含用户上传的文件名，一旦以 = + - @ 开头，
// Excel / WPS 打开导出的 CSV 会把它当公式执行，属于数据外泄与钓鱼入口。
function csvCell(v) {
  let s = String(v === undefined || v === null ? '' : v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'` + s;
  return `"${s.replace(/"/g, '""')}"`;
}

router.get('/dashboard', requireAdmin, async (req, res) => {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayISO = today.toISOString();
  const c = (sql, ...args) => db.prepare(sql).get(...args).c;

  const counts = {
    tasksTotal: c('SELECT COUNT(*) c FROM tasks'),
    tasksToday: c('SELECT COUNT(*) c FROM tasks WHERE created_at >= ?', todayISO),
    tasksPending: c("SELECT COUNT(*) c FROM tasks WHERE status = 'pending'"),
    tasksDone: c("SELECT COUNT(*) c FROM tasks WHERE status = 'done'"),
    tasksFailed: c("SELECT COUNT(*) c FROM tasks WHERE status IN ('failed','rejected','canceled')"),
    users: c('SELECT COUNT(*) c FROM users'),
    usersPending: c("SELECT COUNT(*) c FROM users WHERE status = 'pending'"),
    files: c("SELECT COUNT(*) c FROM files WHERE status = 'active'"),
    pagesToday: db.prepare('SELECT COALESCE(SUM(pages),0) c FROM tasks WHERE created_at >= ?').get(todayISO).c
  };

  const recent = db.prepare(
    `SELECT t.id, t.printer, t.status, t.copies, t.created_at, t.pages, f.filename, u.nickname
     FROM tasks t LEFT JOIN files f ON f.id = t.file_id LEFT JOIN users u ON u.id = t.user_id
     ORDER BY t.id DESC LIMIT 8`
  ).all();
  const audit = db.prepare('SELECT * FROM audit ORDER BY id DESC LIMIT 8').all();
  const pendingUsers = db
    .prepare(`SELECT * FROM users WHERE status = 'pending' ORDER BY id DESC LIMIT 6`)
    .all()
    .map(publicUser);
  const [printerData, svc, info] = await Promise.all([cups.listPrinters(), system.services(), system.info()]);

  // 最近 7 天打印量
  const trend = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - i);
    const next = new Date(d.getTime() + 86400000);
    trend.push({
      date: `${d.getMonth() + 1}/${d.getDate()}`,
      count: c('SELECT COUNT(*) c FROM tasks WHERE created_at >= ? AND created_at < ?', d.toISOString(), next.toISOString()),
      today: i === 0
    });
  }

  res.json({
    ok: true,
    counts, recent, audit, trend, pendingUsers,
    printers: { total: printerData.printers.length, online: printerData.printers.filter((p) => p.state !== 'stopped').length, default: printerData.default, list: printerData.printers.slice(0, 5) },
    services: svc,
    system: {
      uptime: info.uptime, mem: info.mem, disk: info.disk, load: info.cpu.load, cores: info.cpu.cores,
      version: config.version, hostname: info.hostname, platform: info.platform
    },
    config: {
      approveEachJob: cfg().approveEachJob,
      enableQrLogin: cfg().enableQrLogin,
      wxConfigured: !!(cfg().wxAppid && cfg().wxSecret),
      frp: cfg().enableFrp
    }
  });
});

router.get('/system/info', requireAdmin, async (req, res) => {
  res.json({ ok: true, info: await system.info(), services: await system.services() });
});

router.get('/system/services', requireAdmin, async (req, res) => {
  res.json({ ok: true, services: await system.services() });
});

router.post('/system/services/:key/restart', requireAdmin, async (req, res) => {
  const r = await system.restartService(req.params.key);
  logAudit('service_restart', `${req.params.key} → ${r.msg}`, sec.clientIp(req), 'admin');
  res.status(r.ok ? 200 : 400).json(r);
});

router.get('/system/logs', requireAdmin, (req, res) => {
  res.json({ ok: true, logs: system.logList() });
});

router.get('/system/logs/:name', requireAdmin, (req, res) => {
  const lines = Math.min(Math.max(parseInt(req.query.lines, 10) || 300, 20), 2000);
  const r = system.logs(req.params.name, lines);
  res.status(r.ok ? 200 : 400).json(r);
});

router.get('/audit', requireAdmin, (req, res) => {
  const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
  const size = Math.min(Math.max(parseInt(req.query.size, 10) || 30, 1), 500);
  const args = [];
  const where = [];
  const action = String(req.query.action || '').trim();
  if (action && action !== 'all') {
    where.push(`action LIKE ? ESCAPE '\\'`);
    args.push(`%${like(action)}%`);
  }
  const kw = String(req.query.q || '').trim();
  if (kw) {
    where.push(`(detail LIKE ? ESCAPE '\\' OR actor LIKE ? ESCAPE '\\' OR ip LIKE ? ESCAPE '\\')`);
    const p = `%${like(kw)}%`;
    args.push(p, p, p);
  }
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = db.prepare(`SELECT COUNT(*) c FROM audit ${w}`).get(...args).c;
  const rows = db.prepare(`SELECT * FROM audit ${w} ORDER BY id DESC LIMIT ? OFFSET ?`).all(...args, size, (page - 1) * size);
  const actions = db.prepare('SELECT action, COUNT(*) c FROM audit GROUP BY action ORDER BY c DESC LIMIT 40').all();
  res.json({ ok: true, logs: rows, total, page, size, actions });
});

router.get('/audit/export', requireAdmin, (req, res) => {
  const rows = db.prepare('SELECT * FROM audit ORDER BY id DESC LIMIT 5000').all();
  const header = 'id,actor,action,detail,ip,created_at\n';
  const csv = header + rows.map((r) =>
    [r.id, r.actor, r.action, r.detail, r.ip, r.created_at].map(csvCell).join(',')
  ).join('\n');
  logAudit('audit_export', `rows=${rows.length}`, sec.clientIp(req), 'admin');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="printgate-audit-${Date.now()}.csv"`);
  res.send('\uFEFF' + csv);
});

// 登录失败记录（安全页）
router.get('/security/attempts', requireAdmin, (req, res) => {
  const rows = db.prepare('SELECT * FROM login_attempts ORDER BY id DESC LIMIT 100').all();
  const fails24 = db.prepare("SELECT COUNT(*) c FROM login_attempts WHERE ok = 0 AND created_at >= ?")
    .get(new Date(Date.now() - 86400000).toISOString()).c;
  res.json({ ok: true, attempts: rows, fails24 });
});

router.delete('/security/attempts', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM login_attempts').run();
  logAudit('attempts_clear', '', sec.clientIp(req), 'admin');
  res.json({ ok: true, msg: '失败记录已清空，锁定状态解除' });
});

module.exports = router;
