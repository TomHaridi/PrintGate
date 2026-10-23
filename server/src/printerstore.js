'use strict';
// 打印机配置的「自有真相」+ 崩溃后自动重建。
//
// 背景：CUPS 把 printers.conf 的落盘做成约 30 秒一次的脏检查（实测 SIGHUP / cupsctl /
// 再次 lpadmin 都逼不出来）。也就是说「刚加完打印机就断电/重启/容器被 kill」会丢整个队列，
// 用户看到的是打印机凭空消失、还得重新添加。
// 这里的做法：所有由本应用创建的队列都在 SQLite 里存一份配置，启动后（以及定期）与 CUPS
// 对账，缺哪个就按原参数重建。删除走应用接口时同步删掉记录，所以不会被"复活"。
const { db, nowISO, cfg, logAudit } = require('./db');

const COLS = ['name', 'uri', 'model', 'info', 'location', 'shared'];

function init() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS printer_config (
      name       TEXT PRIMARY KEY,
      uri        TEXT NOT NULL,
      model      TEXT NOT NULL DEFAULT '',
      info       TEXT NOT NULL DEFAULT '',
      location   TEXT NOT NULL DEFAULT '',
      shared     INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
}

function remember({ name, uri, model, info = '', location = '', shared = true }) {
  if (!name || !uri) return;
  init();
  const now = nowISO();
  db.prepare(
    `INSERT INTO printer_config (name, uri, model, info, location, shared, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?)
     ON CONFLICT(name) DO UPDATE SET uri=excluded.uri, model=excluded.model, info=excluded.info,
       location=excluded.location, shared=excluded.shared, updated_at=excluded.updated_at`
  ).run(String(name), String(uri), String(model || ''), String(info || ''), String(location || ''), shared ? 1 : 0, now, now);
}

function forget(name) {
  init();
  db.prepare('DELETE FROM printer_config WHERE name = ?').run(String(name));
}

function all() {
  init();
  return db.prepare('SELECT * FROM printer_config ORDER BY name').all();
}

function get(name) {
  init();
  return db.prepare('SELECT * FROM printer_config WHERE name = ?').get(String(name)) || null;
}

// 把库里记着、但 CUPS 里没有的队列重新建出来。
// 只补不删：CUPS 里多出来的（手工 lpadmin 建的）一律不动。
async function reconcile(cups, { verbose = false } = {}) {
  const rows = all();
  if (!rows.length) return { stored: 0, restored: [], missing: [] };
  let list;
  try {
    list = await cups.listPrinters();
  } catch (e) {
    return { stored: rows.length, restored: [], error: e.message };
  }
  if (!list || !list.ok) return { stored: rows.length, restored: [], error: (list && list.msg) || 'CUPS 未就绪' };
  const live = new Set((list.printers || []).map((p) => p.name));
  const restored = [];
  for (const row of rows) {
    if (live.has(row.name)) continue;
    const r = await cups.addPrinter({
      name: row.name,
      uri: row.uri,
      model: row.model || 'everywhere',
      info: row.info || '',
      location: row.location || '',
      shared: !!row.shared
    });
    if (r.ok) {
      restored.push(row.name);
      logAudit('printer_restore', `queue=${row.name} uri=${row.uri} model=${row.model || '-'}`, '', 'system');
      if (verbose) console.log(`[printerstore] 已按配置重建队列 ${row.name}`);
    } else {
      console.warn(`[printerstore] 重建队列 ${row.name} 失败: ${r.msg || ''}`);
      logAudit('printer_restore_failed', `queue=${row.name} ${r.msg || ''}`, '', 'system');
    }
  }
  // 重建过的队列如果本来就是默认打印机，把 default 也一并恢复
  const def = cfg().defaultPrinter;
  if (def && restored.includes(def)) {
    const d = await cups.setDefault(def).catch(() => null);
    if (d && d.ok) logAudit('printer_restore_default', `queue=${def}`, '', 'system');
  }
  return { stored: rows.length, restored };
}

module.exports = { init, remember, forget, all, get, reconcile, COLS };
