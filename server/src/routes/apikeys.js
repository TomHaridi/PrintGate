'use strict';
// 开放 API Key：供小程序/第三方系统或「中转对接」调用打印接口
const express = require('express');
const crypto = require('crypto');
const { db, logAudit, nowISO } = require('../db');
const sec = require('../security');
const { requireAdmin } = require('../middleware');

const router = express.Router();

router.get('/keys', requireAdmin, (req, res) => {
  const keys = db.prepare('SELECT * FROM api_keys ORDER BY id DESC').all().map((k) => ({
    id: k.id, name: k.name, prefix: k.prefix, revoked: !!k.revoked,
    created_at: k.created_at, last_used_at: k.last_used_at, last_used_ip: k.last_used_ip
  }));
  res.json({ ok: true, keys });
});

router.post('/keys', requireAdmin, (req, res) => {
  const name = String((req.body || {}).name || '').trim().slice(0, 60) || '未命名密钥';
  const raw = `pg_${crypto.randomBytes(24).toString('base64url')}`;
  const hash = crypto.createHash('sha256').update(raw).digest('hex');
  const prefix = `${raw.slice(0, 10)}…${raw.slice(-4)}`;
  const r = db.prepare('INSERT INTO api_keys (name, prefix, token_hash, created_at) VALUES (?,?,?,?)')
    .run(name, prefix, hash, nowISO());
  logAudit('apikey_create', `name=${name}`, sec.clientIp(req), 'admin');
  res.json({ ok: true, id: r.lastInsertRowid, token: raw, msg: '密钥只显示一次，请立即复制保存' });
});

router.delete('/keys/:id', requireAdmin, (req, res) => {
  const r = db.prepare('UPDATE api_keys SET revoked = 1 WHERE id = ?').run(req.params.id);
  if (!r.changes) return res.status(404).json({ ok: false, msg: '密钥不存在' });
  logAudit('apikey_revoke', `id=${req.params.id}`, sec.clientIp(req), 'admin');
  res.json({ ok: true, msg: '密钥已吊销' });
});

module.exports = router;
