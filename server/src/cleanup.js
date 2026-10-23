'use strict';
// 历史与存储清理：任务记录、CUPS 已完成作业、虚拟打印机落盘、源文件、扫描件
//
// 原则：
//   1. 绝不动 pending / approved / printing 的任务；
//   2. 被未完成任务引用的源文件一律保留（否则重试/预览会失效）；
//   3. 每一次清理都写审计，自动与手动走同一套实现，避免两处逻辑漂移。
const fs = require('fs');
const path = require('path');
const config = require('./config');
const cups = require('./cups');
const fsutil = require('./fsutil');
const orphans = require('./orphans');
const { db, cfg, logAudit } = require('./db');

const FINISHED = ['done', 'failed', 'rejected', 'canceled'];
const ACTIVE = ['pending', 'approved', 'printing'];
const ALL_TARGETS = ['tasks', 'cups', 'spool', 'files', 'scans', 'preview'];

function cutoffOf(days) {
  // days = 0 表示「全部历史」，用当前时间做上界即可
  const d = Math.max(0, Number(days) || 0);
  return new Date(Date.now() - d * 86400000).toISOString();
}

function dirStats(dir) {
  let count = 0;
  let bytes = 0;
  try {
    for (const f of fs.readdirSync(dir)) {
      const p = path.join(dir, f);
      try {
        const st = fs.statSync(p);
        if (st.isFile()) { count++; bytes += st.size; }
      } catch (_) {}
    }
  } catch (_) {}
  return { count, bytes };
}

function filesStats({ cutoff } = {}) {
  const rows = cutoff
    ? db.prepare("SELECT size FROM files WHERE status = 'active' AND created_at < ?").all(cutoff)
    : db.prepare("SELECT size FROM files WHERE status = 'active'").all();
  return { count: rows.length, bytes: rows.reduce((a, r) => a + (r.size || 0), 0) };
}

async function cupsCompleted() {
  const r = await cups.listJobs({ state: 'completed' });
  return { ok: r.ok, jobs: r.jobs || [] };
}

// lpstat 的时间有两种形态：
//   Thu Oct 22 01:43:39 2026            （-W completed 的完成时间）
//   Thu 21 Oct 2026 10:01:25 AM CST     （提交时间，带时区缩写）
function parseJobTime(text) {
  const s = String(text || '').replace(/\s+[A-Z]{2,4}$/, '').trim();
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : NaN;
}

async function stats() {
  const now = new Date().toISOString();
  const taskRows = db.prepare('SELECT status, COUNT(*) AS n FROM tasks GROUP BY status').all();
  const byStatus = {};
  for (const r of taskRows) byStatus[r.status] = r.n;
  const finished = FINISHED.reduce((a, s) => a + (byStatus[s] || 0), 0);
  const active = ACTIVE.reduce((a, s) => a + (byStatus[s] || 0), 0);
  const cupsR = await cupsCompleted();
  const files = filesStats({});
  const scans = db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(size),0) AS b FROM scan_records').get();
  const last = db.prepare("SELECT created_at, detail FROM audit WHERE action IN ('cleanup','auto_cleanup') ORDER BY id DESC LIMIT 1").get();
  return {
    tasks: { total: taskRows.reduce((a, r) => a + r.n, 0), finished, active, byStatus },
    cups: { completed: cupsR.jobs.length, ok: cupsR.ok },
    spool: dirStats(path.join(config.dataDir, 'spool')),
    files,
    scans: { count: scans.n || 0, bytes: scans.b || 0 },
    preview: dirStats(path.join(config.dataDir, 'preview')),
    lastCleanup: last ? { at: last.created_at, detail: last.detail } : null,
    now
  };
}

async function cleanTasks(cutoff) {
  // 只删已结束的任务；被引用文件是否删除在 cleanFiles 里单独判断
  const rows = db.prepare(
    `SELECT id FROM tasks
      WHERE status IN (${FINISHED.map(() => '?').join(',')})
        AND COALESCE(finished_at, created_at) < ?`
  ).all(...FINISHED, cutoff);
  if (!rows.length) return { removed: 0 };
  const del = db.prepare('DELETE FROM tasks WHERE id = ?');
  const tx = db.transaction((list) => { for (const r of list) del.run(r.id); });
  tx(rows);
  return { removed: rows.length };
}

async function cleanCups(cutoff, days) {
  const { jobs } = await cupsCompleted();
  let removed = 0;
  const failed = [];
  const skipped = [];
  const cutoffMs = Date.parse(cutoff);
  for (const j of jobs) {
    // 尊重保留天数：老作业才清；时间解析不出来时，只有「清理全部历史」才动它。
    // 之前这里无条件清空，导致每次自动清理都把 CUPS 历史抹掉。
    if (days > 0) {
      const t = parseJobTime(j.submitted);
      if (Number.isFinite(t) && t >= cutoffMs) { skipped.push(j.id); continue; }
    }
    const r = await cups.cancelJob(j.id, { purge: true });
    if (r.ok) removed++;
    else failed.push({ id: j.id, msg: r.msg });
  }
  return { removed, skipped: skipped.length, failed: failed.slice(0, 5) };
}

async function cleanSpool(cutoff) {
  const dir = path.join(config.dataDir, 'spool');
  let removed = 0;
  let bytes = 0;
  try {
    for (const f of fs.readdirSync(dir)) {
      const p = path.join(dir, f);
      try {
        const st = fs.statSync(p);
        if (!st.isFile() || new Date(st.mtime).toISOString() >= cutoff) continue;
        bytes += st.size;
        if (await fsutil.safeUnlink(p, { label: '清理 spool' })) removed++;
        else orphans.add(p);
      } catch (_) {}
    }
  } catch (_) {}
  return { removed, bytes };
}

async function cleanFiles(cutoff) {
  // 被 pending/approved/printing 任务引用的文件必须保留
  const busy = new Set(
    db.prepare(`SELECT DISTINCT file_id FROM tasks WHERE status IN (${ACTIVE.map(() => '?').join(',')}) AND file_id IS NOT NULL`)
      .all(...ACTIVE).map((r) => r.file_id)
  );
  const rows = db.prepare("SELECT * FROM files WHERE status = 'active' AND created_at < ?").all(cutoff);
  let removed = 0;
  let bytes = 0;
  let failed = 0;
  const mark = db.prepare("UPDATE files SET status='deleted' WHERE id = ?");
  for (const f of rows) {
    if (busy.has(f.id)) continue;
    // 磁盘没删干净就保持 active：下次清理还会轮到它，不会悄悄留下「已删除」的文件
    let ok = true;
    try {
      if (fs.existsSync(f.storage_path)) {
        bytes += fs.statSync(f.storage_path).size || 0;
        ok = await fsutil.safeUnlink(f.storage_path, { label: '清理过期文件' });
      }
    } catch (_) { ok = false; }
    if (ok) {
      removed++;
      mark.run(f.id);
    } else {
      failed++;
      orphans.add(f.storage_path);
    }
  }
  return { removed, bytes, failed };
}

// 预览缓存：data/preview/f{id}.png。删了文件/任务后这些 PNG 没人回收，会一直涨。
async function cleanPreview(cutoff) {
  const dir = path.join(config.dataDir, 'preview');
  let removed = 0;
  let bytes = 0;
  let failed = 0;
  let names = [];
  try { names = fs.readdirSync(dir); } catch (_) { return { removed: 0, bytes: 0, failed: 0 }; }
  const alive = new Set(db.prepare('SELECT id FROM files').all().map((r) => String(r.id)));
  for (const name of names) {
    const m = /^f(\d+)\.png$/i.exec(name);
    if (!m) continue;
    const p = path.join(dir, name);
    let st;
    try { st = fs.statSync(p); } catch (_) { continue; }
    // 源文件已经不存在，或超过保留期 → 可以删
    const orphan = !alive.has(m[1]);
    if (!orphan && st.mtime.toISOString() >= cutoff) continue;
    try {
      bytes += st.size || 0;
      await fsutil.safeUnlink(p, { label: '清理预览缓存' });
      removed++;
    } catch (_) { failed++; }
  }
  return { removed, bytes, failed };
}

async function cleanScans(cutoff) {
  const rows = db.prepare('SELECT * FROM scan_records WHERE created_at < ?').all(cutoff);
  let removed = 0;
  let bytes = 0;
  let failed = 0;
  const del = db.prepare('DELETE FROM scan_records WHERE id = ?');
  for (const s of rows) {
    let ok = true;
    try {
      if (fs.existsSync(s.storage_path)) {
        bytes += fs.statSync(s.storage_path).size || 0;
        ok = await fsutil.safeUnlink(s.storage_path, { label: '清理过期扫描件' });
      }
    } catch (_) { ok = false; }
    if (ok) {
      del.run(s.id);
      removed++;
    } else {
      failed++;
      orphans.add(s.storage_path);
    }
  }
  return { removed, bytes, failed };
}

// login_attempts 只增不减：被扫描的公网部署会无限增长，跟着清理一起轮转
function cleanLoginAttempts(days) {
  const cut = new Date(Date.now() - Math.max(1, Number(days) || 30) * 86400000).toISOString();
  const n = db.prepare('DELETE FROM login_attempts WHERE created_at < ?').run(cut).changes;
  return { removed: n };
}

function cleanAudit(days) {
  const cut = new Date(Date.now() - Math.max(1, Number(days) || 180) * 86400000).toISOString();
  const n = db.prepare('DELETE FROM audit WHERE created_at < ?').run(cut).changes;
  return { removed: n };
}

async function clean({ days = 0, targets = ALL_TARGETS, auditDays = 0 } = {}) {
  const list = (Array.isArray(targets) ? targets : ALL_TARGETS).filter((t) => ALL_TARGETS.includes(t));
  const cutoff = cutoffOf(days);
  const out = { days: Number(days) || 0, cutoff, targets: list, freed: 0 };

  // 先把上一轮没删掉的孤儿文件再试一次（Windows 瞬态占用等一会儿就能删掉）
  out.orphans = await orphans.retryAll();
  if (out.orphans.removed > 0) console.log(`[cleanup] 补删孤儿文件 ${out.orphans.removed} 个`);

  if (list.includes('tasks')) out.tasks = await cleanTasks(cutoff);
  if (list.includes('cups')) out.cups = await cleanCups(cutoff, Number(days) || 0);
  if (list.includes('spool')) {
    out.spool = await cleanSpool(cutoff);
    out.freed += out.spool.bytes || 0;
  }
  // 先删任务再删文件，才能把「任务已清空」的源文件一起回收
  if (list.includes('files')) {
    out.files = await cleanFiles(cutoff);
    out.freed += out.files.bytes || 0;
  }
  if (list.includes('scans')) {
    out.scans = await cleanScans(cutoff);
    out.freed += out.scans.bytes || 0;
  }
  if (list.includes('preview')) {
    out.preview = await cleanPreview(cutoff);
    out.freed += out.preview.bytes || 0;
  }
  if (auditDays > 0) {
    out.audit = cleanAudit(auditDays);
  }
  out.loginAttempts = cleanLoginAttempts(Math.max(30, Number(auditDays) || 0));
  return out;
}

// 自动清理：按设置里的保留天数跑一遍，目标固定为「历史类」数据
async function autoRun({ force = false } = {}) {
  const c = cfg();
  const enabled = c.autoCleanHistory !== false;
  if (!enabled && !force) return { skipped: true, reason: 'disabled' };
  // 两套天数各管各的：historyDays 管任务/队列/落盘，retentionDays 管源文件/扫描件/预览。
  // 之前只用 historyDays，导致「文件保留天数」改了不生效。
  const daysHis = Number.isFinite(c.historyDays) ? c.historyDays : 30;
  const daysFile = Number.isFinite(c.retentionDays) ? c.retentionDays : daysHis;
  const auditDays = c.auditRetentionDays > 0 ? c.auditRetentionDays : 0;
  const rHis = await clean({ days: daysHis, targets: ['tasks', 'cups', 'spool'], auditDays });
  const rFile = await clean({ days: daysFile, targets: ['files', 'scans', 'preview'] });
  const r = Object.assign({}, rHis, {
    files: rFile.files, scans: rFile.scans, preview: rFile.preview,
    freed: (rHis.freed || 0) + (rFile.freed || 0)
  });
  const days = daysHis;
  const total = (r.tasks?.removed || 0) + (r.cups?.removed || 0) + (r.spool?.removed || 0)
    + (r.files?.removed || 0) + (r.scans?.removed || 0);
  if (total > 0 || r.freed > 0) {
    logAudit(
      'auto_cleanup',
      `days=${days} tasks=${r.tasks?.removed || 0} cups=${r.cups?.removed || 0} spool=${r.spool?.removed || 0}`
        + ` files=${r.files?.removed || 0} scans=${r.scans?.removed || 0} freed=${Math.round(r.freed / 1024)}KB`,
      '',
      'system'
    );
  }
  return { ...r, total };
}

module.exports = { stats, clean, autoRun, ALL_TARGETS, FINISHED, ACTIVE };
