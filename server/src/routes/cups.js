'use strict';
// 容器内 CUPS 后台管理接口（只读为主，写入项全部走白名单）
const express = require('express');
const cupsadmin = require('../cupsadmin');
const system = require('../system');
const sec = require('../security');
const { logAudit } = require('../db');
const { requireAdmin } = require('../middleware');

const router = express.Router();

const audit = (action, detail, req) => logAudit(action, detail, sec.clientIp(req), 'admin');

// 概览：服务 / 版本 / 路径 / 配置 / 队列 / 作业
router.get('/cups/status', requireAdmin, async (req, res) => {
  res.json(await cupsadmin.status());
});

// 日志列表与内容
router.get('/cups/logs', requireAdmin, (req, res) => {
  res.json({ ok: true, logs: cupsadmin.logList() });
});

router.get('/cups/logs/:name', requireAdmin, (req, res) => {
  const lines = parseInt(req.query.lines, 10) || 200;
  res.json(cupsadmin.logs(req.params.name, lines));
});

// 重启 cupsd（复用系统服务里的重启逻辑，容器内有守护进程会拉起）
router.post('/cups/restart', requireAdmin, sec.rateLimit({ key: 'cups-restart', windowMs: 60000, max: 6 }), async (req, res) => {
  const r = await system.restartService('cups');
  audit('cups_restart', r.ok ? '成功' : `失败：${r.msg}`, req);
  res.status(r.ok ? 200 : 400).json(r);
});

// 配置文件原文（概览接口不带原文，避免每次都传整个文件）
router.get('/cups/config/raw', requireAdmin, (req, res) => {
  const c = cupsadmin.readConf();
  res.json({ ok: true, path: c.path, exists: c.exists, writable: c.writable, raw: c.raw || '' });
});

// 保存 cupsd.conf 可编辑项
router.post('/cups/config', requireAdmin, (req, res) => {
  const patch = (req.body || {}).patch;
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    return res.status(400).json({ ok: false, msg: '参数格式错误' });
  }
  const r = cupsadmin.saveConf(patch);
  audit('cups_config', `${Object.keys(patch).join(',')} → ${r.ok ? '成功' : r.msg}`, req);
  res.status(r.ok ? 200 : 400).json(r);
});

// 队列运维：启用 / 停用 / 接收 / 拒收 / 设为默认 / 清空作业
router.post('/cups/queue/:name/:op(enable|disable|accept|reject|default|purge)', requireAdmin, async (req, res) => {
  const r = await cupsadmin.queueAction(req.params.name, req.params.op);
  audit(`cups_queue_${req.params.op}`, `${req.params.name} → ${r.ok ? '成功' : r.msg}`, req);
  res.status(r.ok ? 200 : 400).json(r);
});

// 作业运维：取消 / 清除 / 暂停 / 恢复
router.post('/cups/job/:id/:op(cancel|purge|hold|release)', requireAdmin, async (req, res) => {
  const r = await cupsadmin.jobAction(req.params.id, req.params.op);
  audit(`cups_job_${req.params.op}`, `${req.params.id} → ${r.ok ? '成功' : r.msg}`, req);
  res.status(r.ok ? 200 : 400).json(r);
});

module.exports = router;
