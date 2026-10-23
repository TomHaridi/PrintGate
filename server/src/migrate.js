'use strict';
// 一次性数据迁移：从旧版 remote-print.db（微信中转服务）导入设置/用户/任务
// 只读旧库，不改动原文件；迁移完成后写标记，避免重复导入。
const fs = require('fs');
const path = require('path');
const config = require('./config');
const { db, getSetting, setSetting, setSettings, nowISO } = require('./db');

function tryOpen(file) {
  try {
    const Database = require('better-sqlite3');
    return new Database(file, { readonly: true, fileMustExist: true });
  } catch (_) {
    return null;
  }
}

function migrateLegacy() {
  // 只有明确成功的标记才跳过；'error:xxx' / 'failed-open' 是失败态，下次启动要重试并提示
  const flag = getSetting('legacyMigrated');
  if (flag && !/^(error|failed)/i.test(String(flag))) return { skipped: true };
  if (flag) console.warn(`[migrate] 上次迁移未完成（${flag}），本次重试`);
  const candidates = [
    path.join(config.dataDir, 'remote-print.db'),
    '/app/relay/data/remote-print.db'
  ];
  const legacyPath = candidates.find((p) => fs.existsSync(p));
  if (!legacyPath) {
    setSetting('legacyMigrated', 'none');
    return { skipped: true };
  }
  const old = tryOpen(legacyPath);
  if (!old) {
    setSetting('legacyMigrated', 'failed-open');
    return { skipped: true };
  }

  const result = { settings: 0, users: 0, tasks: 0, files: 0 };
  try {
    // ---- 设置 ----
    const rows = old.prepare('SELECT key, value FROM settings').all();
    const map = new Map(rows.map((r) => [r.key, r.value]));
    const updates = {};
    const put = (to, from, transform = (v) => v) => {
      if (map.has(from) && map.get(from) !== '' && map.get(from) != null) {
        updates[to] = transform(map.get(from));
        result.settings++;
      }
    };
    put('adminPassword', 'adminPassword');           // 明文，首次登录后自动升级为 scrypt
    put('wxAppid', 'wxAppid');
    put('wxSecret', 'wxSecret');
    put('adminOpenids', 'adminOpenids');
    put('bindToken', 'bindToken');
    put('maxFileMB', 'maxFileMB');
    put('maxCopies', 'maxCopies');
    put('approveEachJob', 'approveEachJob', (v) => (v === 'true' || v === '1' ? '1' : '0'));
    put('defaultPrinter', 'nasPrinter');
    if (Object.keys(updates).length) setSettings(updates);

    // ---- 用户 ----
    const oldUsers = old.prepare('SELECT * FROM users').all();
    const insUser = db.prepare(
      `INSERT INTO users (openid, nickname, avatar, role, status, created_at, approved_at)
       VALUES (?,?,?,?,?,?,?)
       ON CONFLICT(openid) DO NOTHING`
    );
    const tx = db.transaction(() => {
      for (const u of oldUsers) {
        const r = insUser.run(u.openid, u.nickname || '', u.avatar || '', u.role || 'user', u.status || 'pending', u.created_at || nowISO(), u.approved_at || null);
        result.users += r.changes;
      }
    });
    tx();

    // ---- 文件 + 任务 ----
    const oldFiles = old.prepare('SELECT * FROM files').all();
    const fileIdMap = new Map();
    const uploadsDir = path.join(config.dataDir, 'uploads');
    for (const f of oldFiles) {
      let p = String(f.storage_path || '');
      p = p.replace('/app/relay/data/', `${config.dataDir}/`);
      if (!fs.existsSync(p) && fs.existsSync(uploadsDir)) {
        const alt = path.join(uploadsDir, path.basename(p));
        if (fs.existsSync(alt)) p = alt;
      }
      if (!fs.existsSync(p)) continue;
      const legacyUser = oldUsers.find((u) => u.id === f.user_id);
      const newUser = legacyUser ? db.prepare('SELECT id FROM users WHERE openid = ?').get(legacyUser.openid) : null;
      const r = db.prepare(
        'INSERT INTO files (user_id, filename, size, mime, storage_path, status, created_at) VALUES (?,?,?,?,?,?,?)'
      ).run(newUser ? newUser.id : null, f.filename, f.size || 0, f.mime || '', p, f.status || 'active', f.created_at || nowISO());
      fileIdMap.set(f.id, r.lastInsertRowid);
      result.files++;
    }

    const oldTasks = old.prepare('SELECT * FROM tasks').all();
    const statusMap = {
      pending: 'pending', approved: 'approved', rejected: 'rejected', printing: 'printing',
      done: 'done', failed: 'failed', canceled: 'canceled'
    };
    for (const t of oldTasks) {
      const fid = fileIdMap.get(t.file_id);
      if (!fid) continue;
      const legacyUser = oldUsers.find((u) => u.id === t.user_id);
      const newUser = legacyUser ? db.prepare('SELECT id FROM users WHERE openid = ?').get(legacyUser.openid) : null;
      const options = {
        copies: t.copies || 1,
        color: t.color ? 'color' : 'mono',
        sides: t.duplex ? 'two-sided-long-edge' : 'one-sided',
        media: 'A4',
        orientation: 'portrait'
      };
      db.prepare(
        `INSERT INTO tasks (user_id, file_id, printer, copies, options_json, status, job_id, error, source, created_at, approved_at, finished_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
      ).run(newUser ? newUser.id : null, fid, t.printer || '', t.copies || 1, JSON.stringify(options),
        statusMap[t.status] || 'done', t.cups_job_id || '', t.error || '', 'miniapp',
        t.created_at || nowISO(), t.approved_at || null, ['done', 'failed', 'canceled', 'rejected'].includes(t.status) ? (t.approved_at || t.created_at) : null);
      result.tasks++;
    }

    setSetting('legacyMigrated', new Date().toISOString());
  } catch (e) {
    console.error('[migrate] failed:', e.message);
    setSetting('legacyMigrated', 'error:' + e.message.slice(0, 100));
  } finally {
    try { old.close(); } catch (_) {}
  }
  console.log('[migrate] legacy import:', JSON.stringify(result));
  return result;
}

module.exports = { migrateLegacy };
