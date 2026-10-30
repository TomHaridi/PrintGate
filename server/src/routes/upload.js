'use strict';
// 分片上传：微信小程序 wx.uploadFile 单次上传有大小上限（约 10MB），
// 19MB 的 PDF 根本传不上去。这里按 4MB 切片，服务端拼回完整文件后再走原来的入库流程。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const config = require('../config');
const db = require('../db');
const sec = require('../security');
const { requireMiniUser, requireApprovedUser } = require('../middleware');
const printRoutes = require('./print');

const router = express.Router();

const CHUNK = 4 * 1024 * 1024;               // 4MB/片，明显低于微信上限
const MAX_AGE_MS = 2 * 3600 * 1000;          // 半成品保留 2 小时
const sessionRoot = path.join(config.uploadDir, '.chunks');

// 只收内存里的分片（4MB），切片结束立刻落盘
const chunkUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: CHUNK + 1024 * 1024 } })
  .single('chunk');

function extOf(name) {
  return path.extname(String(name || '')).toLowerCase();
}

// 允许的扩展名与 /api/mp/files 保持一致：直接复用打印路由的白名单判断不可见，
// 这里按同样规则列出，避免绕过分片入口塞进别的类型。
const ALLOWED = new Set([
  '.pdf', '.jpg', '.jpeg', '.png', '.bmp', '.gif', '.tif', '.tiff',
  '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.odt', '.ods', '.odp', '.rtf', '.txt'
]);

function sessDir(id) {
  return path.join(sessionRoot, String(id));
}

function readMeta(id) {
  try {
    return JSON.parse(fs.readFileSync(path.join(sessDir(id), 'meta.json'), 'utf8'));
  } catch (_) {
    return null;
  }
}

function cleanStale() {
  let list = [];
  try { list = fs.readdirSync(sessionRoot); } catch (_) { return; }
  const now = Date.now();
  for (const name of list) {
    const dir = path.join(sessionRoot, name);
    try {
      const st = fs.statSync(dir);
      if (now - st.mtimeMs > MAX_AGE_MS) fs.rmSync(dir, { recursive: true, force: true });
    } catch (_) { /* 并发删除忽略 */ }
  }
}

function safeId(v) {
  return /^[a-f0-9]{24}$/.test(String(v || '')) ? String(v) : '';
}

// 1) 初始化：校验大小与类型，返回分片大小
router.post('/mp/upload/init', requireMiniUser, requireApprovedUser, (req, res) => {
  const b = req.body || {};
  const filename = String(b.filename || '').trim().slice(0, 200) || 'upload.bin';
  const size = parseInt(b.size, 10) || 0;
  const ext = extOf(filename);
  if (!ALLOWED.has(ext)) {
    return res.status(400).json({ ok: false, msg: `不支持的文件类型 ${ext || '(无扩展名)'}（支持 PDF / 图片 / Office 文档 / TXT）` });
  }
  const cfg = db.cfg();
  const maxBytes = (Number(cfg.maxFileMB) || 200) * 1024 * 1024;
  if (size <= 0) return res.status(400).json({ ok: false, msg: '文件大小无效' });
  if (size > maxBytes) {
    return res.status(400).json({ ok: false, msg: `文件超过上限 ${cfg.maxFileMB}MB，请压缩后再试` });
  }

  cleanStale();
  const id = crypto.randomBytes(12).toString('hex');
  const dir = sessDir(id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({
    id, filename, size, ext, mime: String(b.mime || ''), userId: req.user.id, createdAt: new Date().toISOString()
  }));
  res.json({ ok: true, uploadId: id, chunkSize: CHUNK, total: Math.ceil(size / CHUNK) });
});

// 2) 上传一片
router.post('/mp/upload/chunk', requireMiniUser, requireApprovedUser, (req, res) => {
  chunkUpload(req, res, (err) => {
    if (err) {
      const tooBig = err.code === 'LIMIT_FILE_SIZE';
      return res.status(400).json({ ok: false, msg: tooBig ? '分片过大，请用 4MB 切片' : '分片接收失败' });
    }
    const uploadId = safeId((req.body || {}).uploadId);
    const index = parseInt((req.body || {}).index, 10);
    if (!uploadId || !Number.isInteger(index) || index < 0) {
      return res.status(400).json({ ok: false, msg: '分片参数不合法' });
    }
    const meta = readMeta(uploadId);
    if (!meta || meta.userId !== req.user.id) return res.status(404).json({ ok: false, msg: '上传会话不存在或已过期' });
    if (!req.file || !req.file.buffer || !req.file.buffer.length) {
      return res.status(400).json({ ok: false, msg: '分片内容为空' });
    }
    const total = Math.ceil(meta.size / CHUNK);
    if (index >= total) return res.status(400).json({ ok: false, msg: '分片序号越界' });

    // 先写临时名再原子改名：并发重传同一片时不会读到半个文件
    const dst = path.join(sessDir(uploadId), `${index}.part`);
    const tmp = `${dst}.tmp`;
    fs.writeFileSync(tmp, req.file.buffer);
    fs.renameSync(tmp, dst);
    res.json({ ok: true, index, bytes: req.file.buffer.length });
  });
});

// 3) 合并 + 入库
router.post('/mp/upload/complete', requireMiniUser, requireApprovedUser, async (req, res) => {
  const uploadId = safeId((req.body || {}).uploadId);
  if (!uploadId) return res.status(400).json({ ok: false, msg: '缺少 uploadId' });
  const meta = readMeta(uploadId);
  if (!meta || meta.userId !== req.user.id) return res.status(404).json({ ok: false, msg: '上传会话不存在或已过期' });

  const total = Math.ceil(meta.size / CHUNK);
  const dir = sessDir(uploadId);
  const missing = [];
  for (let i = 0; i < total; i++) {
    if (!fs.existsSync(path.join(dir, `${i}.part`))) missing.push(i);
  }
  if (missing.length) {
    return res.status(400).json({ ok: false, msg: `缺少 ${missing.length} 个分片，请重新上传`, missing: missing.slice(0, 20) });
  }

  const outPath = path.join(config.uploadDir, `${Date.now().toString(36)}${crypto.randomBytes(8).toString('hex')}${meta.ext}`);
  const fd = fs.openSync(outPath, 'w');
  try {
    for (let i = 0; i < total; i++) {
      const buf = fs.readFileSync(path.join(dir, `${i}.part`));
      fs.writeSync(fd, buf);
    }
  } finally {
    fs.closeSync(fd);
  }

  const stat = fs.statSync(outPath);
  if (stat.size !== meta.size) {
    try { fs.unlinkSync(outPath); } catch (_) {}
    return res.status(400).json({ ok: false, msg: `合并后大小不一致（${stat.size}/${meta.size}），请重试` });
  }

  // 交给原有入库流程：类型嗅探、页数、Office 转换、配额都在那里
  const r = await printRoutes.registerFile({
    userId: req.user.id,
    file: { path: outPath, originalname: meta.filename, size: stat.size, mimetype: meta.mime || '' },
    source: 'miniapp'
  });

  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  if (!r.ok) return res.status(400).json(r);
  res.json({ ok: true, file: r.file, merged: total });
});

// 4) 放弃
router.delete('/mp/upload/:uploadId', requireMiniUser, (req, res) => {
  const id = safeId(req.params.uploadId);
  const meta = id ? readMeta(id) : null;
  if (meta && meta.userId === req.user.id) {
    try { fs.rmSync(sessDir(id), { recursive: true, force: true }); } catch (_) {}
  }
  res.json({ ok: true });
});

module.exports = router;
