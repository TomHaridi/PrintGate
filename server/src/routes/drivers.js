'use strict';
// 驱动中心接口：本地驱动库 / 在线驱动库（OpenPrinting）/ URL 下载 / 手动上传 / 推荐
const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');
const multer = require('multer');
const drivers = require('../drivers');
const sec = require('../security');
const { logAudit } = require('../db');
const { requireAdmin } = require('../middleware');
const fsutil = require('../fsutil');
const orphans = require('../orphans');

const router = express.Router();
const upload = multer({
  dest: path.join(os.tmpdir(), 'pg-driver-upload'),
  limits: { fileSize: drivers.MAX_DRIVER_BYTES, files: 1 }
});

// ---------- 本地驱动库 ----------
router.get('/drivers', requireAdmin, async (req, res) => {
  const q = String(req.query.q || '');
  const [local, stored] = await Promise.all([drivers.searchLocal(q, 80), Promise.resolve(drivers.storedDrivers())]);
  const items = [
    ...stored.map((d) => ({ ...d, kind: 'stored' })),
    ...local.map((d) => ({ ...d, kind: d.builtin ? 'builtin' : 'local' }))
  ];
  res.json({ ok: true, items, stored: stored.length, local: local.length });
});

router.get('/drivers/stored', requireAdmin, (req, res) => {
  res.json({ ok: true, items: drivers.storedDrivers() });
});

router.delete('/drivers/stored/:id', requireAdmin, (req, res) => {
  const r = drivers.removeStored(decodeURIComponent(req.params.id));
  if (!r.ok) return res.status(400).json({ ok: false, msg: r.msg });
  logAudit('driver_remove', `id=${req.params.id}`, sec.clientIp(req), 'admin');
  res.json({ ok: true, msg: '驱动已删除' });
});

// ---------- 手动上传 PPD ----------
router.post('/drivers/upload', requireAdmin, sec.rateLimit({ key: 'drvUpload', windowMs: 60000, max: 20 }), upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ ok: false, msg: '请选择 PPD 文件（.ppd / .ppd.gz / .tar.gz / .zip）' });
  try {
    const r = await drivers.saveUploadedFull(req.file, String((req.body || {}).label || ''));
    if (!r.ok) return res.status(400).json({ ok: false, msg: r.msg });
    logAudit('driver_upload', `file=${req.file.originalname} size=${req.file.size}`, sec.clientIp(req), 'admin');
    res.json({ ok: true, driver: r.driver, msg: `驱动 ${r.driver.label} 已导入` });
  } finally {
    // multer 临时文件无论成败都要清掉；瞬态锁删不掉就登记 orphans（不阻塞响应）
    fsutil.safeUnlink(req.file.path, { label: '驱动上传临时文件' })
      .then((ok) => { if (!ok) orphans.add(req.file.path); });
  }
});

// ---------- 按 URL 下载 ----------
router.post('/drivers/download', requireAdmin, sec.rateLimit({ key: 'drvDownload', windowMs: 60000, max: 15 }), async (req, res) => {
  const url = String((req.body || {}).url || '').trim();
  if (!/^https?:\/\//i.test(url)) return res.status(400).json({ ok: false, msg: '请填写 http:// 或 https:// 开头的 PPD 直链' });
  const r = await drivers.downloadToStore(url, String((req.body || {}).label || ''));
  if (!r.ok) return res.status(400).json({ ok: false, msg: r.msg });
  logAudit('driver_download', `url=${url}`, sec.clientIp(req), 'admin');
  res.json({ ok: true, driver: r.driver, msg: `驱动 ${r.driver.label} 已下载并导入` });
});

// ---------- 在线驱动库（OpenPrinting） ----------
router.get('/drivers/online/vendors', requireAdmin, async (req, res) => {
  const list = await drivers.onlineVendors();
  res.json({ ok: list.length > 0, vendors: list, source: 'OpenPrinting PPD' });
});

router.get('/drivers/online/search', requireAdmin, async (req, res) => {
  const r = await drivers.onlineSearch(String(req.query.q || ''), String(req.query.vendor || ''));
  if (!r.ok) return res.status(400).json({ ok: false, msg: r.msg });
  res.json(r);
});

router.post('/drivers/online/install', requireAdmin, async (req, res) => {
  const b = req.body || {};
  const url = String(b.url || '');
  // 只允许从 OpenPrinting 官方站下载，避免被当成任意 URL 代理
  if (!/^https:\/\/www\.openprinting\.org\/download\/PPD\/[A-Za-z0-9_.%/-]+$/i.test(url)) {
    return res.status(400).json({ ok: false, msg: '在线驱动地址非法' });
  }
  const label = String(b.name || url.split('/').pop() || '').replace(/\.ppd(\.gz)?$/i, '').replace(/_/g, ' ');
  const r = await drivers.downloadToStore(url, label);
  if (!r.ok) return res.status(400).json({ ok: false, msg: r.msg });
  logAudit('driver_online_install', `url=${url}`, sec.clientIp(req), 'admin');
  res.json({ ok: true, driver: r.driver, msg: `驱动 ${r.driver.label} 已导入` });
});

// ---------- 现场生成免驱 PPD（driverless） ----------
// 解决「IPP Everywhere 建不了队列」：给打印机现场生成一份 PPD 存成本地驱动，
// 用户选它建队列即可绕开调度器的严格属性校验，同时保住彩色/双面等选项。
router.post('/drivers/generate', requireAdmin, sec.rateLimit({ key: 'drvGen', windowMs: 60000, max: 10 }), async (req, res) => {
  const uri = String((req.body || {}).uri || '').trim();
  const label = String((req.body || {}).label || '').trim().slice(0, 80);
  if (!uri) return res.status(400).json({ ok: false, msg: '缺少打印机地址' });
  const r = await drivers.generateDriverless(uri, label);
  if (!r.ok) return res.status(400).json({ ok: false, msg: r.msg });
  logAudit('driver_generate', `uri=${uri}`, sec.clientIp(req), 'admin');
  res.json({ ok: true, driver: r.driver, msg: `已生成免驱驱动「${r.driver.label}」` });
});

// ---------- 推荐驱动 ----------
router.post('/drivers/recommend', requireAdmin, async (req, res) => {
  const device = req.body || {};
  const r = await drivers.recommend(device);
  res.json({ ok: true, ...r });
});

module.exports = router;
