'use strict';
// 文件上传 / 打印任务（提交、审批、取消、重试、预览）
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const cups = require('../cups');
const converter = require('../converter');
const render = require('../render');
const fsutil = require('../fsutil');
const orphans = require('../orphans');
const idcard = require('../idcard');
const config = require('../config');
const { db, cfg, logAudit, nowISO } = require('../db');
const sec = require('../security');
const { requireAdmin, requireAdminOrKey, requirePrintAccess, requirePrintAccessOrKey, requireMiniUser, requireApprovedUser } = require('../middleware');

// 打印工作台的「归属」约定：admin / API Key 提交的产物不归属任何普通用户（user_id = NULL）；
// 已审批普通用户提交的，一律记在自己名下，后续列表/预览/删除只能碰自己的。
const actorUid = (req) => (req.actor && req.actor.kind === 'user' ? req.actor.uid : null);
const actorSource = (req) => {
  if (!req.actor) return 'web';
  if (req.actor.kind === 'user') return 'portal';
  if (req.actor.kind === 'key') return 'api';
  return 'web';
};

// 普通用户只能操作自己的文件；管理员/API Key 不受限。返回 true 表示校验通过。
function canUseFile(req, fileId, { mustBeActive = false } = {}) {
  const uid = actorUid(req);
  const row = db.prepare(
    `SELECT * FROM files WHERE id = ?${mustBeActive ? " AND status = 'active'" : ''}`
  ).get(parseInt(fileId, 10));
  if (!row) return { ok: false, code: 404, msg: '文件不存在或已被清理' };
  if (uid && row.user_id !== uid) return { ok: false, code: 404, msg: '文件不存在或已被清理' };
  return { ok: true, file: row };
}


const router = express.Router();

// 搜索关键词里的 % / _ 是 LIKE 通配符，不转义的话输入 % 等于「查全部」
const like = (s) => String(s).replace(/[\\%_]/g, (c) => `\\${c}`);

// 把 PDF 逐页转成 PNG（发票合排用）。pdftoppm 输出形如 <prefix>-1.png / <prefix>-01.png，
// 页数超过 9 会补零，所以按文件名里的数字排序，不能按字符串排。
async function pdfToImages(pdfPath, outDir, dpi = 150) {
  const prefix = path.join(outDir, `p${crypto.randomBytes(4).toString('hex')}`);
  const r = await cups.run('pdftoppm', ['-r', String(dpi), '-png', pdfPath, prefix], { timeout: 120000 });
  if (!r.ok) throw new Error(`PDF 转图片失败：${(r.stderr || r.error || '').trim().split(/\r?\n/)[0].slice(0, 120)}`);
  const base = path.basename(prefix);
  const files = fs.readdirSync(outDir)
    .filter((f) => f.startsWith(`${base}-`) && /\.png$/i.test(f))
    .map((f) => ({ f, n: parseInt(f.replace(new RegExp(`^${base}-(\\d+)\\.png$`, 'i'), '$1'), 10) }))
    .filter((x) => Number.isFinite(x.n))
    .sort((a, b) => a.n - b.n)
    .map((x) => path.join(outDir, x.f));
  return files;
}

const IMAGE_EXT = ['.jpg', '.jpeg', '.png', '.bmp', '.gif', '.tif', '.tiff', '.webp', '.heic', '.heif'];
const DOC_EXT = ['.pdf'];
const OFFICE_EXT = ['.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.odt', '.ods', '.odp', '.rtf', '.txt'];
// 视频只收不印：允许上传/留档，但刻意不并入 IMAGE_EXT，
// 这样预览和打印逻辑不会把视频当图片去渲染。
const VIDEO_EXT = ['.mp4', '.mov', '.m4v', '.avi', '.mkv', '.webm'];
const ALLOWED = [...DOC_EXT, ...IMAGE_EXT, ...OFFICE_EXT, ...VIDEO_EXT];

// multipart 的 filename 由 busboy 按 latin1 解码，中文会变成乱码（æµè¯…）。
// 这里回转一次 UTF-8 并校验，取不到合法结果时保留原值。
function decodeFilename(name) {
  const raw = String(name || '').trim() || 'file';
  if (!/[\u0080-\u00ff]/.test(raw)) return raw.slice(0, 200);
  const utf8 = Buffer.from(raw, 'latin1').toString('utf8');
  const fixed = utf8.includes('\uFFFD') ? raw : utf8;
  return fixed.slice(0, 200);
}

// 微信真机上传的临时文件常常是 `tmp_xxxx` 这种没有扩展名的路径（尤其 chooseMedia /
// chooseMessageFile 拿到的图片），靠扩展名判类型会直接 400。这里按文件头认出真实格式。
// 只用于图片和 PDF —— Office 是 ZIP/OLE 容器，光看魔数分不出 docx/xlsx，仍按扩展名走。
function sniffExt(filePath) {
  const head = (n) => {
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(n);
    try { fs.readSync(fd, buf, 0, n, 0); } finally { fs.closeSync(fd); }
    return buf;
  };
  try {
    const b8 = head(8);
    if (b8.slice(0, 5).toString('latin1') === '%PDF-') return '.pdf';
    if (b8.equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return '.png';
    const b3 = head(3);
    if (b3[0] === 0xff && b3[1] === 0xd8 && b3[2] === 0xff) return '.jpg';
    if (head(6).toString('latin1').startsWith('GIF8')) return '.gif';
    if (head(2).toString('latin1') === 'BM') return '.bmp';
    const b12 = head(12);
    if (b12.slice(0, 4).toString('latin1') === 'RIFF' && b12.slice(8, 12).toString('latin1') === 'WEBP') return '.webp';
    // iPhone 相册原图是 HEIC：ISO BMFF 容器，[4..8)='ftyp'，brand 在 [8..12)
    if (b12.slice(4, 8).toString('latin1') === 'ftyp') {
      const brand = b12.slice(8, 12).toString('latin1');
      if (['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis'].includes(brand)) return '.heic';
    }
    const b4 = head(4);
    if ((b4[0] === 0x49 && b4[1] === 0x49) || (b4[0] === 0x4d && b4[1] === 0x4d)) return '.tiff';
    return '';
  } catch (_) {
    return '';
  }
}

// 图片和 PDF 一律以文件头为准（这些扩展名与真实内容不一致是常态，不是攻击）
const CONTENT_FIRST_EXT = ['.pdf', ...IMAGE_EXT];

// 扩展名是客户端说了算的，必须用文件头校验真实类型：
// 否则把 HTML/脚本改名成 .pdf 就能存进来，后续预览失败，将来做"下载原文件"还会变成存储型 XSS。
function contentMatches(ext, filePath) {
  const head = (n) => {
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(n);
    try { fs.readSync(fd, buf, 0, n, 0); } finally { fs.closeSync(fd); }
    return buf;
  };
  try {
    if (ext === '.pdf') return head(5).toString('latin1') === '%PDF-';
    if (ext === '.txt') return true;                       // 纯文本没有魔数，只能放过（渲染时按文本处理）
    if (ext === '.jpg' || ext === '.jpeg') { const b = head(3); return b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff; }
    if (ext === '.png') return head(8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    if (ext === '.gif') return head(6).toString('latin1').startsWith('GIF8');
    if (ext === '.bmp') return head(2).toString('latin1') === 'BM';
    if (ext === '.webp') { const b = head(12); return b.slice(0, 4).toString('latin1') === 'RIFF' && b.slice(8, 12).toString('latin1') === 'WEBP'; }
    if (ext === '.tif' || ext === '.tiff') { const b = head(4); return (b[0] === 0x49 && b[1] === 0x49) || (b[0] === 0x4d && b[1] === 0x4d); }
    if (ext === '.docx' || ext === '.xlsx' || ext === '.pptx' || ext === '.odt' || ext === '.ods' || ext === '.odp') {
      const b = head(4);
      return b[0] === 0x50 && b[1] === 0x4b && (b[2] === 0x03 || b[2] === 0x05 || b[2] === 0x07);   // ZIP 容器
    }
    if (ext === '.doc' || ext === '.xls' || ext === '.ppt') {
      const b = head(4);
      return b[0] === 0xd0 && b[1] === 0xcf && b[2] === 0x11 && b[3] === 0xe0;                       // OLE 复合文档
    }
    if (ext === '.rtf') return head(5).toString('latin1') === '{\\rtf';
    return true;
  } catch (_) {
    return false;
  }
}

// 预览页码：1 起；超出文档页数时返回 null（调用方给 404）
function previewPage(req, totalPages) {
  const raw = parseInt((req.query || {}).page, 10);
  const page = Number.isInteger(raw) && raw > 0 ? raw : 1;
  if (!totalPages) return page;          // 页数未知（pdfinfo 缺失）时不拦，交给 pdftoppm 判断
  return page > totalPages ? null : page;
}

function extOf(name) {
  const e = path.extname(String(name || '')).toLowerCase();
  return ALLOWED.includes(e) ? e : null;
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, config.uploadDir),
  filename: (req, file, cb) => {
    file.originalname = decodeFilename(file.originalname);
    const ext = extOf(file.originalname) || '.bin';
    cb(null, `${Date.now().toString(36)}${crypto.randomBytes(8).toString('hex')}${ext}`);
  }
});

function uploader(fieldName = 'file') {
  const maxMB = cfg().maxFileMB;
  return multer({ storage, limits: { fileSize: maxMB * 1024 * 1024, files: 1 } }).single(fieldName);
}

function uploadMiddleware(fieldName) {
  return (req, res, next) => {
    uploader(fieldName)(req, res, (err) => {
      if (err) {
        const msg = err.code === 'LIMIT_FILE_SIZE'
          ? `文件超过上限（${cfg().maxFileMB} MB），可在设置中调整`
          : `上传失败：${err.message}`;
        return res.status(400).json({ ok: false, msg });
      }
      next();
    });
  };
}

async function pdfInfo(filePath) {
  const r = await cups.run('pdfinfo', [filePath], { timeout: 10000 });
  if (!r.ok) return { pages: 0, parsed: false };
  const m = r.stdout.match(/^Pages:\s+(\d+)/m);
  return { pages: m ? parseInt(m[1], 10) : 0, parsed: !!m };
}

// 落库 + 必要的格式转换
// 端上合成图（文字/发票/身份证）希望有个可读文件名。
// 只取基名、滤掉控制字符与路径符号，扩展名强制沿用服务端已校验的真实类型
// —— 展示名不能成为绕过「内容与扩展名相符」校验的口子。
function displayNameFrom(raw, fallback) {
  const s = String(raw || '').trim();
  if (!s || s.length > 200) return '';
  const realExt = extOf(fallback);
  let base = path.basename(s).replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, '').trim();
  if (!base) return '';
  const givenExt = extOf(base);
  if (givenExt === realExt) return base.slice(0, 160);
  if (givenExt) base = base.slice(0, -(givenExt.length)).trim();
  return ((base || 'upload') + realExt).slice(0, 160);
}

async function registerFile({ userId, file, source, hintName }) {
  // 上传被拒的文件没有 DB 记录，cleanup 扫不到——这里删不掉就是永久泄漏，必须登记 orphans
  if (!file.size) {
    const ok = await fsutil.safeUnlink(file.path, { label: '空文件上传' });
    if (!ok) orphans.add(file.path);
    return { ok: false, msg: '文件内容为空，请重新选择' };
  }
  file.originalname = decodeFilename(file.originalname);
  let ext = extOf(file.originalname);
  const sniffed = sniffExt(file.path);
  // 图片/PDF 以内容为准：改名成 .jpg 的 PNG、没有扩展名的 tmp 文件，都按真实格式收下，
  // 后续预览/打印用的也是真实格式，不存在「改后缀绕过校验」的口子
  if (sniffed && CONTENT_FIRST_EXT.includes(sniffed)) ext = sniffed;
  if (!ext) {
    const given = path.extname(file.originalname) || path.extname(String(hintName || ''));
    const ok = await fsutil.safeUnlink(file.path, { label: '类型不符上传' });
    if (!ok) orphans.add(file.path);
    return { ok: false, msg: `不支持的文件类型${given ? ' ' + given : '（文件名没有扩展名）'}，支持 PDF / 图片 / Office 文档 / TXT` };
  }
  if (!contentMatches(ext, file.path)) {
    const ok = await fsutil.safeUnlink(file.path, { label: '内容与扩展名不符' });
    if (!ok) orphans.add(file.path);
    return { ok: false, msg: `文件内容与扩展名不符（${ext}），请确认文件没有损坏或被改过后缀` };
  }

  // multer 是按「上传时的文件名」定扩展名的。微信真机给的临时名是 tmp_xxxx（没有扩展名），
  // 于是落盘成 xxxx.bin；上面虽然按文件头认出了真实类型，但磁盘名还是 .bin。
  // 后面合并、预览、打印全都按 storage_path 的后缀判类型 —— .bin 会被当成未知文件，
  // 表现就是「单张传上了、多选合成报不是图片 / 打印说格式不支持」。这里把磁盘名改成真实类型。
  const diskExt = extOf(file.path);
  if (diskExt !== ext) {
    const fixed = path.join(path.dirname(file.path), `${path.parse(file.path).name}${ext}`);
    try {
      fs.renameSync(file.path, fixed);
      file.path = fixed;
    } catch (_) { /* 改名失败就沿用原名，不影响上传本身 */ }
  }

  let storagePath = file.path;
  // 展示名：优先用端上带过来的名字（小程序临时文件名是 tmp_xxx），扩展名强制换成真实类型
  // hintName 可能是空白字符串，trim 后为空就退回原文件名，避免落出「   .png」这种名字
  const hint = String(hintName || '').trim();
  const wantName = hint || file.originalname;
  const stem = (path.parse(String(wantName)).name || '').replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, '').trim().slice(0, 60) || '文件';
  let filename = displayNameFrom(wantName, `upload${ext}`) || `${stem}${ext}`;
  let pages = 0;

  if (OFFICE_EXT.includes(ext) && ext !== '.txt') {
    try {
      const pdfPath = await converter.convertToPdf(file.path, path.dirname(file.path));
      storagePath = pdfPath;
      filename = filename.replace(/\.[^.]+$/, '.pdf');
      const ok = await fsutil.safeUnlink(file.path, { label: 'Office 转换后清源文件' });
      if (!ok) orphans.add(file.path);
    } catch (e) {
      const ok = await fsutil.safeUnlink(file.path, { label: 'Office 转换失败清源文件' });
      if (!ok) orphans.add(file.path);
      return { ok: false, msg: e.message };
    }
  }
  if (storagePath.toLowerCase().endsWith('.pdf')) {
    const info = await pdfInfo(storagePath);
    pages = info.pages;
  }
  const maxPages = cfg().maxPages;
  if (pages && pages > maxPages) {
    const ok = await fsutil.safeUnlink(storagePath, { label: '页数超限' });
    if (!ok) orphans.add(storagePath);
    return { ok: false, msg: `文档 ${pages} 页，超过单任务上限 ${maxPages} 页（可在「系统设置 → 单任务最大页数」调大）` };
  }

  const size = fs.statSync(storagePath).size;
  const r = db.prepare(
    'INSERT INTO files (user_id, filename, size, mime, pages, storage_path, created_at) VALUES (?,?,?,?,?,?,?)'
  ).run(userId || null, filename, size, file.mimetype || '', pages, storagePath, nowISO());
  return {
    ok: true,
    file: { id: r.lastInsertRowid, filename, size, pages, created_at: nowISO(), source: source || 'web' }
  };
}

function publicTask(t) {
  let options = {};
  try { options = JSON.parse(t.options_json || '{}'); } catch (_) { options = {}; }
  return {
    id: t.id, printer: t.printer, copies: t.copies, options,
    status: t.status, jobId: t.job_id, pages: t.pages, error: t.error,
    source: t.source, created_at: t.created_at, approved_at: t.approved_at, finished_at: t.finished_at,
    filename: t.filename, size: t.size, nickname: t.nickname, user_id: t.user_id, file_id: t.file_id,
    avatar: t.avatar || '', wechat_id: t.wechat_id || '', phone: t.phone || '',
    file_available: t.file_status === undefined ? true : t.file_status === 'active'
  };
}

// 带上提交者的头像与联系方式，管理端核对「这份是谁打的、怎么联系」
const TASK_SELECT = `SELECT t.*, f.filename, f.size, f.pages AS file_pages, f.status AS file_status,
  u.nickname, u.avatar, u.wechat_id, u.phone
  FROM tasks t LEFT JOIN files f ON f.id = t.file_id LEFT JOIN users u ON u.id = t.user_id`;

// ---------- 打印工作台元信息 ----------
// 管理员与已审批用户共用同一个「发起打印」页面，但两者能看到的范围不同：
// 这里一次性给出打印机、限制、是否显示高级参数、最近任务，前端据此渲染。
router.get('/print/meta', requirePrintAccess, async (req, res) => {
  const c = cfg();
  const uid = actorUid(req);
  const list = await cups.listPrinters();
  const printers = (list.ok ? list.printers : []).map((p) => ({
    name: p.name, state: p.state, enabled: p.enabled, accepting: p.accepting,
    isDefault: !!p.isDefault, info: p.info || '', location: p.location || '', model: p.model || ''
  }));
  const recent = (uid
    ? db.prepare(`${TASK_SELECT} WHERE t.user_id = ? ORDER BY t.id DESC LIMIT 5`).all(uid)
    : db.prepare(`${TASK_SELECT} ORDER BY t.id DESC LIMIT 5`).all()).map(publicTask);
  res.json({
    ok: true,
    role: req.actor && req.actor.kind === 'user' ? 'user' : 'admin',
    printers,
    default: list.default || '',
    cups: { running: !!list.ok, message: list.ok ? '' : (list.msg || 'CUPS 未就绪') },
    settings: {
      maxFileMB: c.maxFileMB, maxCopies: c.maxCopies, maxPages: c.maxPages,
      approveEachJob: c.approveEachJob, defaultPrinter: c.defaultPrinter
    },
    // 管理员隐藏普通用户详细设置时，工作台只保留基础参数
    advanced: req.actor && req.actor.kind === 'user' ? !c.hideUserAdvanced : true,
    recent
  });
});

// ---------- 文件 ----------
router.post('/files', requirePrintAccessOrKey, uploadMiddleware('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ ok: false, msg: '未收到文件' });
  const r = await registerFile({ userId: actorUid(req), file: req.file, source: actorSource(req) });
  if (!r.ok) return res.status(400).json(r);
  const who = req.actor && req.actor.kind === 'user' ? `user#${req.actor.uid}` : 'admin';
  logAudit('upload', `${r.file.filename} (${r.file.size}B)`, sec.clientIp(req), who);
  res.json({ ok: true, file: r.file });
});

router.get('/files', requirePrintAccess, (req, res) => {
  const uid = actorUid(req);
  const list = uid
    ? db.prepare(
      `SELECT id, filename, size, pages, created_at FROM files
       WHERE status = 'active' AND user_id = ? ORDER BY id DESC LIMIT 60`
    ).all(uid)
    : db.prepare(
      `SELECT id, filename, size, pages, created_at FROM files
       WHERE status = 'active' AND user_id IS NULL ORDER BY id DESC LIMIT 60`
    ).all();
  res.json({ ok: true, files: list });
});

// 把服务端生成/合成的 PDF 也登记成普通文件，后续走与上传文件完全相同的链路
async function saveGeneratedFile(filename, storagePath, userId = null) {
  const info = await pdfInfo(storagePath);
  const maxPages = cfg().maxPages;
  if (info.pages && info.pages > maxPages) {
    const ok = await fsutil.safeUnlink(storagePath, { label: '生成内容页数超限' });
    if (!ok) orphans.add(storagePath);
    return { ok: false, msg: `生成内容 ${info.pages} 页，超过单任务上限 ${maxPages} 页` };
  }
  const size = fs.statSync(storagePath).size;
  const r = db.prepare(
    'INSERT INTO files (user_id, filename, size, mime, pages, storage_path, created_at) VALUES (?,?,?,?,?,?,?)'
  ).run(userId || null, filename, size, 'application/pdf', info.pages, storagePath, nowISO());
  return { ok: true, file: { id: r.lastInsertRowid, filename, size, pages: info.pages, created_at: nowISO(), source: 'web' } };
}

function genPath(prefix) {
  fs.mkdirSync(config.uploadDir, { recursive: true });
  return path.join(config.uploadDir, `${prefix}-${Date.now().toString(36)}${crypto.randomBytes(5).toString('hex')}.pdf`);
}

// 矫正/生成的图片也登记成普通文件，后续走与上传文件相同的预览/删除链路
function saveGeneratedImage(filename, storagePath, userId = null) {
  const size = fs.statSync(storagePath).size;
  const r = db.prepare(
    'INSERT INTO files (user_id, filename, size, mime, pages, storage_path, created_at) VALUES (?,?,?,?,?,?,?)'
  ).run(userId || null, filename, size, 'image/png', 0, storagePath, nowISO());
  return { id: r.lastInsertRowid, filename, size, pages: 0, created_at: nowISO(), source: 'web' };
}

// 身份证自动矫正识别切割：把随手拍的照片里身份证找出来、旋转摆正、裁掉背景。
router.post('/print/idcard/auto-crop', requirePrintAccess, sec.rateLimit({ key: 'idcardcrop', windowMs: 60000, max: 30 }), async (req, res) => {
  const b = req.body || {};
  const id = parseInt(b.fileId, 10);
  if (!(id > 0)) return res.status(400).json({ ok: false, msg: '缺少文件' });
  const own = canUseFile(req, id, { mustBeActive: true });
  if (!own.ok) return res.status(own.code).json({ ok: false, msg: own.msg });
  const f = own.file;
  const lower = f.storage_path.toLowerCase();
  if (!IMAGE_EXT.includes(path.extname(lower))) {
    return res.status(400).json({ ok: false, msg: '只能对图片（JPG/PNG）做自动矫正' });
  }
  if (!fs.existsSync(f.storage_path)) return res.status(410).json({ ok: false, msg: '源文件已清理，无法矫正' });

  const out = path.join(config.uploadDir, `idcard-${Date.now().toString(36)}${crypto.randomBytes(5).toString('hex')}.png`);
  try {
    const r = await idcard.autoCrop(f.storage_path);
    if (!r.ok) return res.status(422).json(r);
    fs.writeFileSync(out, r.buffer);
    const base = path.basename(f.filename, path.extname(f.filename)) || '身份证';
    const file = saveGeneratedImage(`${base}-矫正.png`, out, actorUid(req));
    logAudit('idcard_crop', `file=${f.id}->${file.id} angle=${Math.round(r.angle)}°`, sec.clientIp(req), 'admin');
    res.json({ ok: true, file, angle: Math.round(r.angle * 10) / 10, box: r.box });
  } catch (e) {
    const ok = await fsutil.safeUnlink(out, { label: '身份证矫正失败' });
    if (!ok) orphans.add(out);
    res.status(500).json({ ok: false, msg: '矫正失败：' + e.message });
  }
});

// 身份证正反面 → { path, rotate(0|90|180|270), scale(0.3~3) }，只认白名单值
function resolveCard(spec, uid = null) {
  if (!spec || !spec.fileId) return null;
  const id = parseInt(spec.fileId, 10);
  if (!(id > 0)) return null;
  const f = db.prepare("SELECT * FROM files WHERE id = ? AND status = 'active'").get(id);
  if (!f || !fs.existsSync(f.storage_path)) return null;
  // 普通用户只能用自己上传的证件照（管理员 uid 为 null，不受限）
  if (uid && f.user_id !== uid) return null;
  if (!IMAGE_EXT.includes(path.extname(f.storage_path.toLowerCase()))) return null;
  const rotate = [0, 90, 180, 270].includes(Number(spec.rotate)) ? Number(spec.rotate) : 0;
  const scale = Math.min(Math.max(Number(spec.scale) || 1, 0.3), 3);
  return { path: f.storage_path, rotate, scale };
}

// 身份证拼接实时预览：正反各占半页，可调每张的旋转/缩放，返回拼好的第一页 PNG
router.post('/print/idcard/preview', requirePrintAccess, sec.rateLimit({ key: 'idcardprev', windowMs: 60000, max: 60 }), async (req, res) => {
  const b = req.body || {};
  const front = resolveCard(b.front, actorUid(req));
  const back = resolveCard(b.back, actorUid(req));
  if (!front && !back) return res.status(400).json({ ok: false, msg: '请先上传身份证' });
  const media = ['A4', 'A3', 'A5', 'Letter', 'Legal', 'B5'].includes(b.media) ? b.media : 'A4';
  const p = genPath('idprev');
  const png = `${p}.png`;
  const cleanup = () => { try { fs.unlinkSync(p); } catch (_) {} try { fs.unlinkSync(png); } catch (_) {} };
  try {
    await render.idcardPdf(p, { front, back, media, margin: 36, gap: 18 });
    const r = await cups.run('pdftoppm', ['-f', '1', '-l', '1', '-r', '80', '-png', '-singlefile', p, png.replace(/\.png$/, '')], { timeout: 30000 });
    if (!r.ok || !fs.existsSync(png)) return res.status(415).json({ ok: false, msg: '无法生成预览（缺少 pdftoppm 组件）' });
    res.set('Cache-Control', 'no-store');
    res.sendFile(png, cleanup);
  } catch (e) {
    cleanup();
    res.status(500).json({ ok: false, msg: '预览失败：' + e.message });
  }
});

// 身份证打印提交：与预览同一套拼接参数，生成 PDF 落库并（可选）直接打印
router.post('/print/idcard', requirePrintAccess, sec.rateLimit({ key: 'idcardprint', windowMs: 60000, max: 30 }), async (req, res) => {
  const b = req.body || {};
  const front = resolveCard(b.front, actorUid(req));
  const back = resolveCard(b.back, actorUid(req));
  if (!front && !back) return res.status(400).json({ ok: false, msg: '请先上传身份证' });
  const media = ['A4', 'A3', 'A5', 'Letter', 'Legal', 'B5'].includes(b.media) ? b.media : 'A4';
  const p = genPath('idcard');
  try {
    await render.idcardPdf(p, { front, back, media, margin: 36, gap: 18 });
    const f = await saveGeneratedFile('身份证合排.pdf', p, actorUid(req));
    if (!f.ok) return res.status(400).json(f);
    logAudit('print_idcard', `file=${f.file.id} front=${front ? 1 : 0} back=${back ? 1 : 0}`, sec.clientIp(req), 'admin');
    if (b.printer) {
      const t = await createTask({ fileId: f.file.id, printer: b.printer, options: b.options || {}, userId: actorUid(req), source: actorSource(req), ip: sec.clientIp(req) });
      return res.json({ ok: t.ok, file: f.file, taskId: t.taskId, status: t.status, msg: t.msg });
    }
    res.json({ ok: true, file: f.file });
  } catch (e) {
    const ok = await fsutil.safeUnlink(p, { label: '身份证合排失败' });
    if (!ok) orphans.add(p);
    res.status(500).json({ ok: false, msg: '合排失败：' + e.message });
  }
});


// ---------- 文字速印 ----------
// 直接把一段文字排成 PDF，适合打备注、地址、取件码这类没有源文件的场景
router.post('/print/text', requirePrintAccess, sec.rateLimit({ key: 'printtext', windowMs: 60000, max: 30 }), async (req, res) => {
  const b = req.body || {};
  const body = String(b.body || '');
  if (!body.trim()) return res.status(400).json({ ok: false, msg: '请输入要打印的文字' });
  if (body.length > 50000) return res.status(400).json({ ok: false, msg: '文字过长（最多 5 万字符）' });
  if (!render.cjkFont()) return res.status(500).json({ ok: false, msg: '镜像缺少中文字体，无法排版' });
  const media = ['A4', 'A3', 'A5', 'Letter', 'Legal', 'B5'].includes(b.media) ? b.media : 'A4';
  const title = String(b.title || '').slice(0, 60);
  const p = genPath('text');
  try {
    await render.textPdf(p, {
      title, body, media,
      fontSize: Math.min(Math.max(Number(b.fontSize) || 12, 6), 48),
      lineGap: Math.min(Math.max(Number(b.lineGap) || 5, 0), 30),
      margin: Math.min(Math.max(Number(b.margin) || 56, 20), 120)
    });
    const name = (title || '文字速印') + '.pdf';
    const f = await saveGeneratedFile(name, p, actorUid(req));
    if (!f.ok) return res.status(400).json(f);
    logAudit('print_text', `file=${f.file.id} chars=${body.length}`, sec.clientIp(req), 'admin');
    if (b.printer) {
      const t = await createTask({ fileId: f.file.id, printer: b.printer, options: b.options || {}, userId: actorUid(req), source: actorSource(req), ip: sec.clientIp(req) });
      return res.json({ ok: t.ok, file: f.file, taskId: t.taskId, status: t.status, msg: t.msg });
    }
    res.json({ ok: true, file: f.file });
  } catch (e) {
    const ok = await fsutil.safeUnlink(p, { label: '文字速印失败' });
    if (!ok) orphans.add(p);
    res.status(500).json({ ok: false, msg: '排版失败：' + e.message });
  }
});

// ---------- 多图合排（发票 / 身份证） ----------
// 把已上传的图片按「上下居中」或「等分网格」排到一张纸上，
// 身份证用 stack（正反各占半页），发票用 grid（一页 2 张）。
router.post('/print/compose', requirePrintAccess, sec.rateLimit({ key: 'printcompose', windowMs: 60000, max: 30 }), async (req, res) => {
  const b = req.body || {};
  const ids = (Array.isArray(b.fileIds) ? b.fileIds : []).map((x) => parseInt(x, 10)).filter((x) => x > 0).slice(0, 8);
  if (!ids.length) return res.status(400).json({ ok: false, msg: '请先选择图片' });
  const rows = ids.map((id) => db.prepare("SELECT * FROM files WHERE id = ? AND status = 'active'").get(id)).filter(Boolean);
  if (rows.length !== ids.length) return res.status(400).json({ ok: false, msg: '部分文件不存在或已被清理，请重新选择' });

  // 发票/证件合排原来只吃 JPG/PNG，电子发票（PDF）传不上去。这里先把 PDF 逐页转成 PNG，
  // 再走原有合排逻辑；转换用的临时目录在 finally 里统一清掉。
  const MAX_PAGES_PER_PDF = 10;
  const images = [];
  const tmpDirs = [];
  try {
    for (const r of rows) {
      if (/\.pdf$/i.test(r.storage_path)) {
        const dir = path.join(config.uploadDir, `compose-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`);
        fs.mkdirSync(dir, { recursive: true });
        tmpDirs.push(dir);
        const pages = await pdfToImages(r.storage_path, dir);
        if (!pages.length) {
          return res.status(400).json({ ok: false, msg: `「${r.filename}」转换后没有可取出的页面，请确认 PDF 正常` });
        }
        if (pages.length > MAX_PAGES_PER_PDF) {
          return res.status(400).json({
            ok: false,
            msg: `「${r.filename}」有 ${pages.length} 页，单份最多取前 ${MAX_PAGES_PER_PDF} 页，请拆分后再合排`
          });
        }
        images.push(...pages);
      } else {
        images.push(r.storage_path);
      }
    }

    const bad = images.find((p) => !render.readableImage(p));
    if (bad) {
      const name = rows.find((r) => r.storage_path === bad);
      return res.status(400).json({
        ok: false,
        msg: `「${name ? name.filename : path.basename(bad)}」不是有效的 JPG/PNG（可能已损坏或传输不完整），请重新上传后再合排`
      });
    }
  } catch (e) {
    for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {} }
    return res.status(400).json({ ok: false, msg: e.message });
  }

  const layout = b.layout === 'grid' ? 'grid' : 'stack';
  const media = ['A4', 'A3', 'A5', 'Letter', 'Legal', 'B5'].includes(b.media) ? b.media : 'A4';
  const p = genPath('compose');
  try {
    await render.imagesPdf(p, {
      images,
      layout,
      perPage: Math.min(Math.max(parseInt(b.perPage, 10) || 2, 1), 4),
      media,
      margin: Math.min(Math.max(Number(b.margin) || 28, 10), 60)
    });
    const name = String(b.title || (layout === 'stack' ? '身份证合排' : '发票合排')).slice(0, 40) + '.pdf';
    const f = await saveGeneratedFile(name, p, actorUid(req));
    if (!f.ok) return res.status(400).json(f);
    logAudit('print_compose', `file=${f.file.id} images=${ids.length} layout=${layout}`, sec.clientIp(req), 'admin');
    if (b.printer) {
      const t = await createTask({ fileId: f.file.id, printer: b.printer, options: b.options || {}, userId: actorUid(req), source: actorSource(req), ip: sec.clientIp(req) });
      return res.json({ ok: t.ok, file: f.file, taskId: t.taskId, status: t.status, msg: t.msg });
    }
    res.json({ ok: true, file: f.file });
  } catch (e) {
    const ok = await fsutil.safeUnlink(p, { label: '合排失败' });
    if (!ok) orphans.add(p);
    res.status(500).json({ ok: false, msg: '合排失败：' + e.message });
  } finally {
    for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {} }
  }
});

// 文字速印预览：把表单内容实时排成 PDF，取第一页光栅图返回。
// 之前文字模式在刷新预览的逻辑里没有分支，导致「文字速印」永远看不到预览。
router.post('/print/text/preview', requirePrintAccess, sec.rateLimit({ key: 'textpreview', windowMs: 60000, max: 90 }), async (req, res) => {
  const b = req.body || {};
  const body = String(b.body || '');
  if (!body.trim()) return res.status(400).json({ ok: false, msg: '请输入要打印的文字' });
  if (body.length > 50000) return res.status(400).json({ ok: false, msg: '文字过长（最多 5 万字符）' });
  if (!render.cjkFont()) return res.status(500).json({ ok: false, msg: '镜像缺少中文字体，无法排版' });
  const media = ['A4', 'A3', 'A5', 'Letter', 'Legal', 'B5'].includes(b.media) ? b.media : 'A4';
  const p = genPath('textprev');
  const png = `${p}.png`;
  const cleanup = () => {
    try { fs.unlinkSync(p); } catch (_) {}
    try { fs.unlinkSync(png); } catch (_) {}
  };
  try {
    await render.textPdf(p, {
      title: String(b.title || '').slice(0, 60), body, media,
      fontSize: Math.min(Math.max(Number(b.fontSize) || 12, 6), 48),
      lineGap: Math.min(Math.max(Number(b.lineGap) || 5, 0), 30),
      margin: Math.min(Math.max(Number(b.margin) || 56, 20), 120)
    });
    const r = await cups.run('pdftoppm', ['-f', '1', '-l', '1', '-r', '80', '-png', '-singlefile', p, png.replace(/\.png$/, '')], { timeout: 30000 });
    if (!r.ok || !fs.existsSync(png)) return res.status(415).json({ ok: false, msg: '无法生成预览（缺少 pdftoppm 组件）' });
    res.set('Cache-Control', 'no-store');
    res.sendFile(png, cleanup);
  } catch (e) {
    cleanup();
    res.status(500).json({ ok: false, msg: '预览失败：' + e.message });
  }
});

router.delete('/files/:id', requirePrintAccess, async (req, res) => {
  try {
    const own = canUseFile(req, req.params.id);
    if (!own.ok) return res.status(own.code).json({ ok: false, msg: own.msg });
    const f = own.file;
    const ok = await fsutil.safeUnlink(f.storage_path, { label: '管理端删文件' });
    if (!ok) return res.status(500).json({ ok: false, msg: '文件暂时无法删除（可能被其他程序占用），请稍后重试' });
    db.prepare("UPDATE files SET status = 'deleted' WHERE id = ?").run(f.id);
    logAudit('file_delete', f.filename, sec.clientIp(req), 'admin');
    res.json({ ok: true, msg: '文件已删除' });
  } catch (e) {
    res.status(500).json({ ok: false, msg: '删除失败：' + e.message });
  }
});

// 文件预览（PDF 首屏渲染为 PNG；图片直接返回）
router.get('/files/:id/preview', requirePrintAccess, async (req, res) => {
  const own = canUseFile(req, req.params.id);
  if (!own.ok) return res.status(own.code).json({ ok: false, msg: own.msg });
  const f = own.file;
  if (!f) return res.status(404).json({ ok: false, msg: '文件记录不存在' });
  if (f.status !== 'active' || !fs.existsSync(f.storage_path)) {
    return res.status(410).json({ ok: false, msg: '源文件已清理（超过保留期），无法预览' });
  }
  const lower = f.storage_path.toLowerCase();
  if (IMAGE_EXT.includes(path.extname(lower))) return res.sendFile(f.storage_path);
  const page = previewPage(req, f.pages);
  if (page === null) return res.status(404).json({ ok: false, msg: '页码超出范围' });
  const cacheDir = path.join(config.dataDir, 'preview');
  fs.mkdirSync(cacheDir, { recursive: true });
  const out = path.join(cacheDir, `f${f.id}-p${page}.png`);
  if (!fs.existsSync(out)) {
    const r = await cups.run('pdftoppm', ['-f', String(page), '-l', String(page), '-r', '80', '-png', '-singlefile', f.storage_path, out.replace(/\.png$/, '')], { timeout: 30000 });
    if (!r.ok) return res.status(415).json({ ok: false, msg: '无法生成预览（缺少 pdftoppm 组件）' });
  }
  res.set('Cache-Control', 'private, max-age=300');
  res.set('X-Page', String(page));
  res.set('X-Total-Pages', String(f.pages || 0));
  res.sendFile(out);
});

// ---------- 打印 ----------
const SIDES = new Set(['one-sided', 'two-sided-long-edge', 'two-sided-short-edge']);
const MEDIA = new Set(['A4', 'A3', 'A5', 'A6', 'Letter', 'Legal', 'B5', '16K']);
const SCALING = new Set(['auto', 'fit', 'fill', 'none']);
const NUMBER_UP = new Set([1, 2, 4, 6, 9, 16]);
const LAYOUTS = new Set(['lrtb', 'lrbt', 'rltb', 'rlbt', 'tblr', 'tbrl', 'btlr', 'btrl']);
const SAFE_TOKEN = /^[A-Za-z0-9_.:\/-]{0,60}$/;

// 只保留白名单内的值：非法值不入库、不落到 lp 命令行
function normalizeOptions(o = {}) {
  // 客户端可能传 null / 数组 / 字符串：默认参数只管 undefined，这里显式兜住，
  // 否则 o.copies 直接抛 TypeError，请求会挂住而不是返回 400。
  if (!o || typeof o !== 'object' || Array.isArray(o)) o = {};
  const pick = (k) => (o[k] === undefined || o[k] === null ? '' : String(o[k]).trim());
  const opts = {};
  opts.copies = Math.min(Math.max(parseInt(o.copies, 10) || 1, 1), cfg().maxCopies);
  opts.media = MEDIA.has(pick('media')) ? pick('media') : 'A4';
  opts.sides = SIDES.has(pick('sides')) ? pick('sides') : 'one-sided';
  opts.color = pick('color') === 'color' ? 'color' : 'mono';
  opts.orientation = pick('orientation') === 'landscape' ? 'landscape' : 'portrait';
  const ranges = pick('pageRanges').replace(/\s+/g, '');
  opts.pageRanges = /^[0-9][0-9,-]{0,80}$/.test(ranges) ? ranges : '';
  const nu = parseInt(o.numberUp, 10) || 1;
  opts.numberUp = NUMBER_UP.has(nu) ? nu : 1;
  opts.numberUpLayout = LAYOUTS.has(pick('numberUpLayout')) ? pick('numberUpLayout') : 'lrtb';
  opts.pageBorder = !!o.pageBorder;
  opts.scaling = SCALING.has(pick('scaling')) ? pick('scaling') : 'fit';
  opts.mediaType = SAFE_TOKEN.test(pick('mediaType')) ? pick('mediaType') : '';
  opts.inputSlot = SAFE_TOKEN.test(pick('inputSlot')) ? pick('inputSlot') : '';
  const extra = Array.isArray(o.extra) ? o.extra : [];
  opts.extra = extra
    .filter((kv) => typeof kv === 'string' && /^[A-Za-z0-9_.-]{1,40}=[A-Za-z0-9_.:,\/ -]{0,80}$/.test(kv))
    .slice(0, 10);
  // 页面子集：全部 / 奇数页 / 偶数页 / 偶数页倒序（做小册子时常用）
  const ps = pick('pageSet');
  opts.pageSet = ['odd', 'even', 'even-reverse'].includes(ps) ? ps : 'all';
  opts.mirror = !!o.mirror;
  // 水印走 PDF 叠加，只接受短文本，避免把排版搞崩
  const wm = pick('watermark').slice(0, 40);
  opts.watermark = /^[\p{L}\p{N} \-_.·()（）#]{0,40}$/u.test(wm) ? wm : '';
  const res = pick('resolution');
  opts.resolution = /^\d{2,4}(x\d{2,4})?dpi$/i.test(res) ? res : '';
  return opts;
}

async function createTask({ fileId, printer, options = {}, userId = null, source = 'web', ip = '' }) {
  const f = db.prepare('SELECT * FROM files WHERE id = ? AND status = ?').get(fileId, 'active');
  if (!f) return { ok: false, code: 404, msg: '文件不存在或已被清理' };
  const c = cfg();
  const target = printer || c.defaultPrinter;
  if (!target) return { ok: false, code: 400, msg: '未指定打印机，且未设置默认打印机' };
  // 先做参数归一化：参数非法应当直接 400，而不是被"CUPS 没就绪"掩盖
  const opts = normalizeOptions(options);
  const printers = await cups.listPrinters();
  if (!printers.ok) return { ok: false, code: 503, msg: 'CUPS 服务未就绪，无法打印' };
  if (!printers.printers.some((p) => p.name === target)) {
    return { ok: false, code: 400, msg: `打印机「${target}」不存在或已被删除，请重新选择` };
  }
  // RAW 直通队列没有驱动，彩色/双面等选项会被 CUPS 丢掉 —— 提前说明，别让用户以为设了彩色就是彩色
  let rawWarn = '';
  if (opts.color === 'color') {
    const qi = await cups.queueInfo(target).catch(() => null);
    if (qi && qi.known && (qi.raw || !qi.hasColor)) {
      rawWarn = qi.raw
        ? '（注意：该队列是 RAW 直通、未安装驱动，彩色不会生效，将按打印机默认输出）'
        : '（注意：该队列驱动不支持彩色，将按打印机默认输出）';
    }
  }
  const needApprove = c.approveEachJob;
  const status = needApprove ? 'pending' : 'approved';
  const r = db.prepare(
    `INSERT INTO tasks (user_id, file_id, printer, copies, options_json, status, pages, source, created_at, approved_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`
  ).run(userId, f.id, target, opts.copies, JSON.stringify(opts), status, f.pages || 0, source, nowISO(), needApprove ? null : nowISO());
  const taskId = r.lastInsertRowid;
  logAudit('print_submit', `task=${taskId} file=${f.filename} printer=${target} copies=${opts.copies} ${opts.color} ${opts.sides}`, ip, userId ? `user#${userId}` : 'admin');
  if (status === 'approved') executeTask(taskId).catch((e) => console.error('[print] exec failed', taskId, e.message));
  const base = needApprove ? '已提交，等待管理员审批' : '已发送到打印机';
  return { ok: true, taskId, status, warn: rawWarn, msg: base + rawWarn };
}

async function executeTask(taskId) {
  const t = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
  if (!t) return;
  const f = db.prepare('SELECT * FROM files WHERE id = ?').get(t.file_id);
  if (!f || !fs.existsSync(f.storage_path)) {
    db.prepare("UPDATE tasks SET status = 'failed', error = ?, finished_at = ? WHERE id = ?").run('文件已丢失', nowISO(), taskId);
    return;
  }
  let options = {};
  try { options = JSON.parse(t.options_json || '{}'); } catch (_) {}
  db.prepare("UPDATE tasks SET status = 'printing' WHERE id = ?").run(taskId);

  // 水印：先落一份带水印的临时 PDF 再提交，源文件保持干净（重试时按同一规则重新生成）。
  // 非 PDF（图片 / TXT）也要先包成 PDF，否则水印会静默失效——用户看到"设了水印却没印出来"。
  let submitPath = f.storage_path;
  const tmpFiles = [];
  if (options.watermark) {
    const workDir = path.dirname(f.storage_path);
    const stamp = `${taskId}-${Date.now()}`;
    try {
      let src = f.storage_path;
      const ext = path.extname(f.storage_path).toLowerCase();
      if (['.jpg', '.jpeg', '.png'].includes(ext)) {
        src = path.join(workDir, `wm-src-${stamp}.pdf`);
        await render.imagesPdf(src, { images: [f.storage_path], layout: 'stack', media: options.media, margin: 12, guide: false });
        tmpFiles.push(src);
      } else if (ext === '.txt') {
        src = path.join(workDir, `wm-src-${stamp}.pdf`);
        const text = fs.readFileSync(f.storage_path, 'utf8').slice(0, 50000);
        await render.textPdf(src, { body: text, media: options.media });
        tmpFiles.push(src);
      }
      const out = path.join(workDir, `wm-${stamp}.pdf`);
      const w = await render.applyWatermark(src, out, { text: options.watermark, media: options.media });
      if (w.ok) { submitPath = out; tmpFiles.push(out); }
      else logAudit('watermark_failed', `task=${taskId} ${w.msg}`, '', 'system');
    } catch (e) {
      logAudit('watermark_failed', `task=${taskId} ${String(e.message).slice(0, 120)}`, '', 'system');
    }
  }

  const r = await cups.submitJob({ printer: t.printer, filePath: submitPath, title: f.filename, options });
  // 水印 / 文字转 PDF 的中间产物：删不掉的登记 orphans，下一轮清理重试
  await Promise.all(tmpFiles.map(async (p) => {
    const ok = await fsutil.safeUnlink(p, { label: '打印临时文件' });
    if (!ok) orphans.add(p);
  }));
  if (r.ok) {
    // 已送达 CUPS 不等于已出纸：先标记 printing，由 syncPrintingTasks 依据队列状态收尾
    if (r.jobId) {
      db.prepare("UPDATE tasks SET status = 'printing', job_id = ?, error = '' WHERE id = ?").run(r.jobId, taskId);
      logAudit('print_queued', `task=${taskId} job=${r.jobId}`, '', 'system');
    } else {
      db.prepare("UPDATE tasks SET status = 'done', job_id = '', error = '', finished_at = ? WHERE id = ?").run(nowISO(), taskId);
      logAudit('print_done', `task=${taskId}`, '', 'system');
    }
  } else {
    db.prepare("UPDATE tasks SET status = 'failed', error = ?, finished_at = ? WHERE id = ?")
      .run(String(r.msg || '打印失败').slice(0, 500), nowISO(), taskId);
    logAudit('print_failed', `task=${taskId} err=${r.msg}`, '', 'system');
  }
}

// 后台同步：printing 任务在 CUPS 队列中消失即视为完成（取消/失败另有分支）
const STALE_MS = 6 * 3600 * 1000;
// executeTask 先把状态置 printing、再提交 CUPS 拿 job_id。若进程在这两步之间挂掉，
// 任务既没有 job_id 也不会被下面的队列比对收尾 —— 必须单独按时间兜底。
const SUBMIT_GRACE_MS = 2 * 60 * 1000;
async function syncPrintingTasks() {
  const rows = db.prepare("SELECT id, job_id, created_at FROM tasks WHERE status IN ('printing','approved')").all();
  if (!rows.length) return { checked: 0, done: 0 };
  const r = await cups.listJobs({ state: 'not-completed' });
  if (!r.ok) return { checked: rows.length, done: 0, error: 'CUPS 不可用' };
  const active = new Set(r.jobs.map((j) => j.id));
  let done = 0;
  for (const t of rows) {
    const age = Date.now() - new Date(t.created_at).getTime();
    if (!t.job_id) {
      if (age > SUBMIT_GRACE_MS) {
        db.prepare("UPDATE tasks SET status = 'failed', error = ?, finished_at = ? WHERE id = ? AND status = 'printing'")
          .run('提交打印超时（服务重启或 CUPS 无响应），请重新打印', nowISO(), t.id);
        logAudit('print_submit_timeout', `task=${t.id}`, '', 'system');
      }
      continue;
    }
    if (!active.has(t.job_id)) {
      db.prepare("UPDATE tasks SET status = 'done', finished_at = ? WHERE id = ? AND status = 'printing'")
        .run(nowISO(), t.id);
      done += 1;
      logAudit('print_done', `task=${t.id} job=${t.job_id}`, '', 'system');
    } else if (age > STALE_MS) {
      db.prepare("UPDATE tasks SET status = 'failed', error = ?, finished_at = ? WHERE id = ? AND status = 'printing'")
        .run('打印机超过 6 小时未完成该任务，请检查设备', nowISO(), t.id);
    }
  }
  return { checked: rows.length, done };
}

router.post('/print', requirePrintAccessOrKey, async (req, res) => {
  const { fileId, printer, options } = req.body || {};
  if (!fileId) return res.status(400).json({ ok: false, msg: '缺少 fileId' });
  const own = canUseFile(req, fileId, { mustBeActive: true });
  if (!own.ok) return res.status(own.code).json({ ok: false, msg: own.msg });
  const r = await createTask({ fileId: own.file.id, printer, options, userId: actorUid(req), source: actorSource(req), ip: sec.clientIp(req) });
  res.status(r.ok ? 200 : r.code || 400).json(r);
});

// 一步式：上传 + 打印
router.post('/print/upload', requireAdminOrKey, uploadMiddleware('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ ok: false, msg: '未收到文件' });
  const reg = await registerFile({ userId: null, file: req.file, source: 'web' });
  if (!reg.ok) return res.status(400).json(reg);
  let options = {};
  if (req.body && req.body.options) {
    try { options = typeof req.body.options === 'string' ? JSON.parse(req.body.options) : req.body.options; } catch (_) {}
  } else if (req.body) {
    options = { ...req.body };
  }
  const r = await createTask({
    fileId: reg.file.id, printer: req.body.printer, options,
    userId: null, source: 'web', ip: sec.clientIp(req)
  });
  if (!r.ok) {
    // 任务没建起来就把刚登记的文件回滚掉，否则磁盘和 files 表都会留下没人引用的孤儿
    try {
      await fsutil.safeUnlink(reg.file.storage_path, { label: '回滚上传文件' });
      db.prepare('DELETE FROM files WHERE id = ?').run(reg.file.id);
    } catch (_) { /* 删不掉就留给清理任务 */ }
    return res.status(r.code || 400).json(r);
  }
  res.json({ ...r, file: reg.file });
});

// ---------- 任务 ----------
router.get('/tasks', requirePrintAccess, (req, res) => {
  const status = String(req.query.status || 'all');
  const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
  const size = Math.min(Math.max(parseInt(req.query.size, 10) || 20, 1), 200);
  const where = [];
  const args = [];
  if (status !== 'all') {
    if (status === 'failed') where.push("t.status IN ('failed','rejected','canceled')");
    else { where.push('t.status = ?'); args.push(status); }
  }
  const kw = String(req.query.q || '').trim();
  const uid = actorUid(req);
  if (uid) { where.push('t.user_id = ?'); args.push(uid); }
  if (kw) {
    where.push(`(f.filename LIKE ? ESCAPE '\\' OR u.nickname LIKE ? ESCAPE '\\' OR t.printer LIKE ? ESCAPE '\\')`);
    const p = `%${like(kw)}%`;
    args.push(p, p, p);
  }
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = db.prepare(`SELECT COUNT(*) c FROM tasks t LEFT JOIN files f ON f.id=t.file_id LEFT JOIN users u ON u.id=t.user_id ${w}`).get(...args).c;
  const rows = db.prepare(`${TASK_SELECT} ${w} ORDER BY t.id DESC LIMIT ? OFFSET ?`).all(...args, size, (page - 1) * size);
  res.json({ ok: true, tasks: rows.map(publicTask), total, page, size });
});

router.get('/tasks/:id', requireAdmin, (req, res) => {
  const t = db.prepare(`${TASK_SELECT} WHERE t.id = ?`).get(req.params.id);
  if (!t) return res.status(404).json({ ok: false, msg: '任务不存在' });
  const cupsJob = null;
  res.json({ ok: true, task: publicTask(t), cupsJob });
});

router.post('/tasks/:id/approve', requireAdmin, async (req, res) => {
  const t = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
  if (!t) return res.status(404).json({ ok: false, msg: '任务不存在' });
  if (t.status !== 'pending') return res.status(400).json({ ok: false, msg: '该任务不在待审批状态' });
  // 条件更新：并发点两次「批准」时只有一个请求能抢到，避免重复打印
  const upd = db.prepare("UPDATE tasks SET status = 'approved', approved_at = ? WHERE id = ? AND status = 'pending'")
    .run(nowISO(), t.id);
  if (!upd.changes) return res.status(409).json({ ok: false, msg: '该任务已被其他人处理' });
  logAudit('task_approve', `task=${t.id}`, sec.clientIp(req), 'admin');
  executeTask(t.id).catch((e) => console.error('[print]', e.message));
  res.json({ ok: true, msg: '已批准并发送打印' });
});

router.post('/tasks/:id/reject', requireAdmin, (req, res) => {
  const t = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
  if (!t) return res.status(404).json({ ok: false, msg: '任务不存在' });
  if (t.status !== 'pending') return res.status(400).json({ ok: false, msg: '该任务不在待审批状态' });
  const upd = db.prepare("UPDATE tasks SET status = 'rejected', error = ?, finished_at = ? WHERE id = ? AND status = 'pending'")
    .run(String((req.body || {}).reason || '管理员拒绝'), nowISO(), t.id);
  if (!upd.changes) return res.status(409).json({ ok: false, msg: '该任务已被其他人处理' });
  logAudit('task_reject', `task=${t.id}`, sec.clientIp(req), 'admin');
  res.json({ ok: true, msg: '已拒绝' });
});

router.post('/tasks/:id/cancel', requireAdmin, async (req, res) => {
  const t = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
  if (!t) return res.status(404).json({ ok: false, msg: '任务不存在' });
  // 先判状态再动 CUPS：已完成的任务如果还去 cancelJob，
  // cupsd 重启后 job id 可能被重新计数，等于误杀别人的任务。
  if (!['pending', 'approved', 'printing'].includes(t.status)) {
    return res.status(409).json({ ok: false, msg: '任务已结束，无法取消' });
  }
  if (t.job_id) await cups.cancelJob(t.job_id);
  const upd = db.prepare("UPDATE tasks SET status = 'canceled', finished_at = ? WHERE id = ? AND status IN ('pending','approved','printing')")
    .run(nowISO(), t.id);
  if (!upd.changes) return res.status(409).json({ ok: false, msg: '任务已结束，无法取消' });
  logAudit('task_cancel', `task=${t.id} job=${t.job_id}`, sec.clientIp(req), 'admin');
  res.json({ ok: true, msg: '任务已取消' });
});

router.post('/tasks/:id/retry', requireAdmin, async (req, res) => {
  const t = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
  if (!t) return res.status(404).json({ ok: false, msg: '任务不存在' });
  if (!['failed', 'canceled', 'rejected'].includes(t.status)) {
    return res.status(400).json({ ok: false, msg: '只有失败/取消/拒绝的任务可以重试' });
  }
  const upd = db.prepare("UPDATE tasks SET status = 'approved', error = '', finished_at = NULL, approved_at = ? WHERE id = ? AND status IN ('failed','canceled','rejected')")
    .run(nowISO(), t.id);
  if (!upd.changes) return res.status(409).json({ ok: false, msg: '任务状态已变化，请刷新后重试' });
  logAudit('task_retry', `task=${t.id}`, sec.clientIp(req), 'admin');
  executeTask(t.id).catch((e) => console.error('[print]', e.message));
  res.json({ ok: true, msg: '已重新提交' });
});

// CUPS 队列任务（原始任务，可取消/挂起/恢复）
router.get('/cups/jobs', requireAdmin, async (req, res) => {
  const state = req.query.state === 'completed' ? 'completed' : 'not-completed';
  const r = await cups.listJobs({ state });
  res.json({ ok: r.ok, jobs: r.jobs });
});

router.post('/cups/jobs/:id/:action(cancel|hold|release)', requireAdmin, async (req, res) => {
  const { id, action } = req.params;
  // 作业 id 由 CUPS 生成（形如 Printer-123），以 '-' 开头的值会被 lp/cancel 当成命令行开关
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(String(id))) {
    return res.status(400).json({ ok: false, msg: '作业编号格式不正确' });
  }
  const r = action === 'cancel' ? await cups.cancelJob(id)
    : action === 'hold' ? await cups.holdJob(id) : await cups.releaseJob(id);
  if (!r.ok) return res.status(400).json({ ok: false, msg: r.msg || '操作失败' });
  logAudit(`cups_job_${action}`, `job=${id}`, sec.clientIp(req), 'admin');
  res.json({ ok: true, msg: { cancel: '已取消', hold: '已挂起', release: '已恢复' }[action] });
});

// ---------- 小程序侧 ----------
router.post('/mp/files', requireMiniUser, requireApprovedUser, uploadMiddleware('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ ok: false, msg: '未收到文件' });
  // 端上合成的图片（文字速印 / 发票合排 / 身份证）源路径是临时文件名，
  // 允许上传时带上展示名；否则打印记录里只会看到 tmp_xxxx.png
  const r = await registerFile({
    userId: req.user.id, file: req.file, source: 'miniapp',
    hintName: req.body && req.body.filename
  });
  if (!r.ok) return res.status(400).json(r);
  logAudit('mp_upload', `${r.file.filename} (${r.file.size}B)`, sec.clientIp(req), `user#${req.user.id}`);
  res.json({ ok: true, file: r.file });
});

router.get('/mp/files', requireMiniUser, (req, res) => {
  const list = db.prepare(
    "SELECT id, filename, size, pages, created_at FROM files WHERE user_id = ? AND status = 'active' ORDER BY id DESC LIMIT 50"
  ).all(req.user.id);
  res.json({ ok: true, files: list });
});

// 相册 / 聊天多选图片：端上逐张上传（微信只支持单文件上传），再调这里按选择顺序
// 合成一个多页 PDF（每张一页）。这样打印记录里是一条「N 页」文档，
// 预览能翻页、页数计费与传一个多页 PDF 完全一致。
const MERGE_IMG_EXT = ['.jpg', '.jpeg', '.png', '.webp', '.bmp', '.gif', '.heic', '.heif'];
const MERGE_MAX = 20;

router.post('/mp/files/merge', requireMiniUser, requireApprovedUser, async (req, res) => {
  const raw = req.body && req.body.ids;
  const ids = [...new Set((Array.isArray(raw) ? raw : [])
    .map((x) => Number(x))
    .filter((n) => Number.isInteger(n) && n > 0))];
  if (!ids.length) return res.status(400).json({ ok: false, msg: '请先选择图片' });
  if (ids.length > MERGE_MAX) return res.status(400).json({ ok: false, msg: `一次最多合并 ${MERGE_MAX} 张图片` });
  const maxPages = cfg().maxPages;
  if (ids.length > maxPages) return res.status(400).json({ ok: false, msg: `合计 ${ids.length} 页，超过单任务上限 ${maxPages} 页` });

  const images = [];
  const tmpFiles = [];
  try {
    for (const id of ids) {
      const f = db.prepare("SELECT id, filename, storage_path FROM files WHERE id = ? AND user_id = ? AND status = 'active'")
        .get(id, req.user.id);
      if (!f) return res.status(404).json({ ok: false, msg: '有图片已失效，请重新选择' });
      const ext = extOf(f.storage_path) || '';
      // 兼容修复前落盘的图（磁盘名是 .bin）：扩展名不像图片时再用文件头确认一次
      if (!MERGE_IMG_EXT.includes(ext) && !MERGE_IMG_EXT.includes(sniffExt(f.storage_path))) {
        return res.status(400).json({ ok: false, msg: `「${f.filename}」不是图片，不能和其它图片合并` });
      }
      if (render.readableImage(f.storage_path)) { images.push(f.storage_path); continue; }
      // webp / heic / bmp 这类 pdfkit 读不了，先转 PNG；sharp 不可用就明确告知
      const png = path.join(config.uploadDir, `mg${Date.now().toString(36)}${crypto.randomBytes(5).toString('hex')}.png`);
      if (await render.toPng(f.storage_path, png)) { tmpFiles.push(png); images.push(png); continue; }
      return res.status(400).json({ ok: false, msg: `「${f.filename}」格式无法解析，请改用 JPG / PNG` });
    }

    const outPath = path.join(config.uploadDir, `${Date.now().toString(36)}${crypto.randomBytes(8).toString('hex')}.pdf`);
    // perPage=1 + guide=false：每张图独占一页，等比铺满，不画裁切框
    await render.imagesPdf(outPath, {
      images, layout: 'grid', perPage: 1, media: 'A4', margin: 18, gap: 0, guide: false
    });
    const info = await pdfInfo(outPath);
    const pages = info.pages || images.length;
    if (pages > maxPages) {
      await fsutil.safeUnlink(outPath, { label: '合并超页数' });
      return res.status(400).json({ ok: false, msg: `合成后 ${pages} 页，超过单任务上限 ${maxPages} 页` });
    }
    const name = displayNameFrom(req.body && req.body.filename, outPath)
      || `图片合并-${images.length}张.pdf`;
    const size = fs.statSync(outPath).size;
    const ins = db.prepare(
      'INSERT INTO files (user_id, filename, size, mime, pages, storage_path, created_at) VALUES (?,?,?,?,?,?,?)'
    ).run(req.user.id, name, size, 'application/pdf', pages, outPath, nowISO());
    logAudit('mp_merge_images', `${name}（${images.length} 张）`, sec.clientIp(req), `user#${req.user.id}`);
    res.json({
      ok: true,
      file: { id: ins.lastInsertRowid, filename: name, size, pages, created_at: nowISO() }
    });
  } catch (e) {
    res.status(500).json({ ok: false, msg: `合成失败：${e.message}` });
  } finally {
    for (const p of tmpFiles) fsutil.safeUnlink(p, { label: '合并临时图片' }).catch(() => {});
  }
});

router.delete('/mp/files/:id', requireMiniUser, async (req, res) => {
  try {
    const f = db.prepare('SELECT * FROM files WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
    if (!f) return res.status(404).json({ ok: false, msg: '文件不存在' });
    // 磁盘没删干净就不标记删除：宁可这次删不掉，也不留「界面说删了、文件还在」的坑
    const ok = await fsutil.safeUnlink(f.storage_path, { label: '小程序删文件' });
    if (!ok) return res.status(500).json({ ok: false, msg: '文件暂时无法删除（可能被其他程序占用），请稍后重试' });
    db.prepare("UPDATE files SET status = 'deleted' WHERE id = ?").run(f.id);
    res.json({ ok: true, msg: '已删除' });
  } catch (e) {
    res.status(500).json({ ok: false, msg: '删除失败：' + e.message });
  }
});

// 普通用户「一键清空历史」：清掉已结束的打印记录 + 自己上传的文件（含落盘）
// 正在打印 / 待审批的任务一律保留——清历史不能把还没出纸的任务掐掉
const FINISHED_TASK_STATUS_MP = ['done', 'failed', 'canceled', 'rejected'];

router.delete('/mp/history', requireMiniUser, requireApprovedUser, async (req, res) => {
  try {
    const placeholders = FINISHED_TASK_STATUS_MP.map(() => '?').join(',');
    const finished = db.prepare(
      `SELECT COUNT(*) c FROM tasks WHERE user_id = ? AND status IN (${placeholders})`
    ).get(req.user.id, ...FINISHED_TASK_STATUS_MP).c;
    const files = db.prepare("SELECT * FROM files WHERE user_id = ? AND status = 'active'").all(req.user.id);

    // 先删盘再改库：磁盘没删掉的登记孤儿，绝不留下「界面说清了、文件还在」
    let fileGone = 0;
    for (const f of files) {
      const ok = await fsutil.safeUnlink(f.storage_path, { label: '清空历史' });
      if (ok) fileGone += 1;
      else orphans.add(f.storage_path);
    }
    db.prepare(`DELETE FROM tasks WHERE user_id = ? AND status IN (${placeholders})`)
      .run(req.user.id, ...FINISHED_TASK_STATUS_MP);
    db.prepare("UPDATE files SET status = 'deleted' WHERE user_id = ? AND status = 'active'").run(req.user.id);

    logAudit('mp_history_clear', `tasks=${finished} files=${fileGone}/${files.length}`, sec.clientIp(req), `user#${req.user.id}`);
    res.json({
      ok: true,
      msg: `已清空 ${finished} 条打印记录、${fileGone} 个文件`,
      clearedTasks: finished,
      clearedFiles: fileGone,
      keptFiles: files.length - fileGone
    });
  } catch (e) {
    console.error('[mp/history]', e);
    res.status(500).json({ ok: false, msg: '清空失败：' + e.message });
  }
});

router.post('/mp/print', requireMiniUser, requireApprovedUser, async (req, res) => {
  const { fileId, printer, options } = req.body || {};
  if (!fileId) return res.status(400).json({ ok: false, msg: '缺少 fileId' });
  const own = db.prepare("SELECT * FROM files WHERE id = ? AND user_id = ? AND status = 'active'").get(fileId, req.user.id);
  if (!own) return res.status(404).json({ ok: false, msg: '文件不存在' });
  const r = await createTask({
    fileId: own.id, printer, options, userId: req.user.id, source: 'miniapp', ip: sec.clientIp(req)
  });
  res.status(r.ok ? 200 : r.code || 400).json(r);
});

router.get('/mp/tasks', requireMiniUser, (req, res) => {
  const rows = db.prepare(`${TASK_SELECT} WHERE t.user_id = ? ORDER BY t.id DESC LIMIT 50`).all(req.user.id);
  res.json({ ok: true, tasks: rows.map(publicTask) });
});

// 打印队列列表：小程序里要能选打印机，这里只暴露必要字段（不泄漏设备 URI 之外的内部信息）
router.get('/mp/printers', requireMiniUser, async (req, res) => {
  const list = await cups.listPrinters();
  if (!list.ok) return res.json({ ok: true, printers: [], default: '' });
  const printers = (list.printers || []).map((p) => ({
    name: p.name, state: p.state, enabled: p.enabled, accepting: p.accepting,
    isDefault: !!p.isDefault, info: p.info || '', location: p.location || '', model: p.model || ''
  }));
  res.json({ ok: true, printers, default: list.default || '' });
});

// 预览自己上传的文件（管理员的 /files/:id/preview 不认小程序令牌）
router.get('/mp/files/:id/preview', requireMiniUser, async (req, res) => {
  const f = db.prepare('SELECT * FROM files WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!f) return res.status(404).json({ ok: false, msg: '文件不存在' });
  if (f.status !== 'active' || !fs.existsSync(f.storage_path)) {
    return res.status(410).json({ ok: false, msg: '源文件已清理，无法预览' });
  }
  const lower = f.storage_path.toLowerCase();
  if (IMAGE_EXT.includes(path.extname(lower))) return res.sendFile(f.storage_path);
  // 多页文档要能翻页：?page=N 按页渲染并各自缓存
  const page = previewPage(req, f.pages);
  if (page === null) return res.status(404).json({ ok: false, msg: '页码超出范围' });
  const cacheDir = path.join(config.dataDir, 'preview');
  fs.mkdirSync(cacheDir, { recursive: true });
  const out = path.join(cacheDir, `f${f.id}-p${page}.png`);
  if (!fs.existsSync(out)) {
    const r = await cups.run('pdftoppm', ['-f', String(page), '-l', String(page), '-r', '80', '-png', '-singlefile', f.storage_path, out.replace(/\.png$/, '')], { timeout: 30000 });
    if (!r.ok) return res.status(415).json({ ok: false, msg: '无法生成预览' });
  }
  res.set('Cache-Control', 'private, max-age=300');
  res.set('X-Page', String(page));
  res.set('X-Total-Pages', String(f.pages || 0));
  res.sendFile(out);
});

router.post('/mp/tasks/:id/cancel', requireMiniUser, (req, res) => {
  const t = db.prepare('SELECT * FROM tasks WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!t) return res.status(404).json({ ok: false, msg: '任务不存在' });
  if (t.status !== 'pending') return res.status(400).json({ ok: false, msg: '只能取消待审批任务' });
  // 与审批并发时（管理员正在放行）只有一个能成功，避免「记录已取消、纸还在出」
  const upd = db.prepare("UPDATE tasks SET status = 'canceled', finished_at = ? WHERE id = ? AND status = 'pending'")
    .run(nowISO(), t.id);
  if (!upd.changes) return res.status(409).json({ ok: false, msg: '该任务已被管理员处理，无法取消' });
  logAudit('mp_task_cancel', `task=${t.id}`, sec.clientIp(req), `user#${req.user.id}`);
  res.json({ ok: true, msg: '已取消' });
});

// 重启后处理「卡在 printing 但作业已经不在 CUPS 队列里」的任务。
// 崩溃/断电时 CUPS 的队列可能被重建（见 printerstore），原作业随之消失，
// 若沿用「作业不在队列即视为完成」的判断，会把根本没出纸的任务标成 done——用户以为打了、其实没打。
// 启动时先跑一次，把这类任务标成 failed 并说明原因（用户可一键重试）。
async function markOrphanedPrinting() {
  const rows = db.prepare("SELECT id, job_id, printer FROM tasks WHERE status = 'printing'").all();
  if (!rows.length) return { checked: 0, failed: 0 };
  const r = await cups.listJobs({ state: 'not-completed' });
  if (!r.ok) return { checked: rows.length, failed: 0, error: 'CUPS 不可用' };
  const active = new Set(r.jobs.map((j) => j.id));
  let failed = 0;
  for (const t of rows) {
    if (!t.job_id) {
      // 启动时仍处于 printing 却没有 job_id：executeTask 在提交前就断了，不会有人来收尾
      const upd0 = db.prepare(
        "UPDATE tasks SET status = 'failed', error = ?, finished_at = ? WHERE id = ? AND status = 'printing'"
      ).run('服务重启导致打印中断，请重新打印', nowISO(), t.id);
      if (upd0.changes) failed += 1;
      continue;
    }
    if (active.has(t.job_id)) continue;   // 还在队列里，继续等
    const upd = db.prepare(
      "UPDATE tasks SET status = 'failed', error = ?, finished_at = ? WHERE id = ? AND status = 'printing'"
    ).run('服务重启导致打印作业丢失，请重新打印', nowISO(), t.id);
    if (upd.changes) {
      failed += 1;
      logAudit('print_orphaned', `task=${t.id} job=${t.job_id}`, '', 'system');
    }
  }
  return { checked: rows.length, failed };
}

module.exports = router;
module.exports.createTask = createTask;
module.exports.executeTask = executeTask;
module.exports.syncPrintingTasks = syncPrintingTasks;
module.exports.markOrphanedPrinting = markOrphanedPrinting;
module.exports.executeTask = executeTask;
module.exports.registerFile = registerFile;
