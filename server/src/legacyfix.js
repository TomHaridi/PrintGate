'use strict';
// 一次性数据修复：2.4.21 及以前，微信真机上传的图片临时文件名没有扩展名（tmp_xxxx），
// multer 落盘时按「上传时的文件名」取后缀就落成了 xxxx.bin。
// 这些文件在「我的文件」里看得到、也能打印，但预览接口和合并接口都按 storage_path 的后缀
// 判类型，.bin 一律认不出是图片 —— 用户看到的就是「上传了但打不开/不能多选打印」。
//
// 新上传的已经在 registerFile 里把磁盘名纠正成真实类型；这里只把库里遗留的 .bin 扫一遍。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function sniffImageExt(filePath) {
  const head = (n) => {
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(n);
    try { fs.readSync(fd, buf, 0, n, 0); } finally { fs.closeSync(fd); }
    return buf;
  };
  try {
    const b8 = head(8);
    if (b8.equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return '.png';
    const b3 = head(3);
    if (b3[0] === 0xff && b3[1] === 0xd8 && b3[2] === 0xff) return '.jpg';
    if (head(6).toString('latin1').startsWith('GIF8')) return '.gif';
    if (head(2).toString('latin1') === 'BM') return '.bmp';
    const b12 = head(12);
    if (b12.slice(0, 4).toString('latin1') === 'RIFF' && b12.slice(8, 12).toString('latin1') === 'WEBP') return '.webp';
    if (b12.slice(4, 8).toString('latin1') === 'ftyp') {
      const brand = b12.slice(8, 12).toString('latin1');
      if (['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis'].includes(brand)) return '.heic';
    }
    return '';
  } catch (_) {
    return '';
  }
}

function fixLegacyBinFiles() {
  const { db } = require('./db');
  let rows = [];
  try {
    rows = db.prepare(
      "SELECT id, storage_path FROM files WHERE status = 'active' AND storage_path LIKE '%.bin'"
    ).all();
  } catch (_) { return { fixed: 0, skipped: 0 }; }
  if (!rows.length) return { fixed: 0, skipped: 0 };

  const upd = db.prepare('UPDATE files SET storage_path = ? WHERE id = ?');
  let fixed = 0, skipped = 0;
  for (const r of rows) {
    try {
      if (!fs.existsSync(r.storage_path)) { skipped++; continue; }
      const ext = sniffImageExt(r.storage_path);
      if (!ext) { skipped++; continue; }
      // 加随机后缀避免和目标名撞车（同一毫秒两次上传理论上可能同名）
      const base = path.parse(r.storage_path).name;
      let dest = path.join(path.dirname(r.storage_path), `${base}${ext}`);
      if (fs.existsSync(dest)) dest = path.join(path.dirname(r.storage_path), `${base}${crypto.randomBytes(3).toString('hex')}${ext}`);
      fs.renameSync(r.storage_path, dest);
      upd.run(dest, r.id);
      fixed++;
    } catch (_) { skipped++; }
  }
  return { fixed, skipped };
}

module.exports = { fixLegacyBinFiles, sniffImageExt };
