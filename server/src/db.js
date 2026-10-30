'use strict';
// SQLite 存储层：设置 / 管理员 / 小程序用户 / 文件 / 打印任务 / 扫码票据 / API Key / 扫描记录 / 审计
const Database = require('better-sqlite3');
const fs = require('fs');
const config = require('./config');

for (const d of [config.dataDir, config.uploadDir, config.scanDir]) {
  try { fs.mkdirSync(d, { recursive: true }); } catch (_) {}
}

const db = new Database(config.dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

db.exec(`
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  openid      TEXT UNIQUE NOT NULL,
  -- 账号用户（网页用户名+密码注册）用这两列；微信用户的 openid 才是真 openid，
  -- 账号用户的 openid 是 local_xxx 占位，保证既有的 user_id 外键与权限逻辑不用改
  username    TEXT,
  pass_hash   TEXT,
  unionid     TEXT DEFAULT '',
  nickname    TEXT DEFAULT '',
  avatar      TEXT DEFAULT '',
  wechat_id   TEXT DEFAULT '',
  phone       TEXT DEFAULT '',
  real_name   TEXT DEFAULT '',
  apply_note  TEXT DEFAULT '',
  role        TEXT NOT NULL DEFAULT 'user',
  status      TEXT NOT NULL DEFAULT 'pending',
  note        TEXT DEFAULT '',
  created_at  TEXT NOT NULL,
  approved_at TEXT,
  approved_by TEXT DEFAULT '',
  last_login  TEXT,
  updated_at  TEXT
);

CREATE TABLE IF NOT EXISTS files (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER,
  filename     TEXT NOT NULL,
  size         INTEGER NOT NULL DEFAULT 0,
  mime         TEXT DEFAULT '',
  pages        INTEGER DEFAULT 0,
  storage_path TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'active',
  created_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER,
  file_id      INTEGER,
  printer      TEXT NOT NULL,
  copies       INTEGER NOT NULL DEFAULT 1,
  options_json TEXT DEFAULT '{}',
  status       TEXT NOT NULL DEFAULT 'pending',
  job_id       TEXT DEFAULT '',
  pages        INTEGER DEFAULT 0,
  error        TEXT DEFAULT '',
  source       TEXT DEFAULT 'web',
  created_at   TEXT NOT NULL,
  approved_at  TEXT,
  finished_at  TEXT
);

CREATE TABLE IF NOT EXISTS qr_tickets (
  ticket      TEXT PRIMARY KEY,
  kind        TEXT NOT NULL DEFAULT 'login',
  status      TEXT NOT NULL DEFAULT 'pending',
  user_id     INTEGER,
  ip          TEXT DEFAULT '',
  created_at  TEXT NOT NULL,
  expires_at  INTEGER NOT NULL,
  used        INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS api_keys (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT NOT NULL,
  prefix       TEXT NOT NULL,
  token_hash   TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  last_used_at TEXT,
  last_used_ip TEXT DEFAULT '',
  revoked      INTEGER NOT NULL DEFAULT 0,
  expires_at   TEXT
);

CREATE TABLE IF NOT EXISTS scan_records (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  device     TEXT DEFAULT '',
  filename   TEXT NOT NULL,
  storage_path TEXT NOT NULL,
  size       INTEGER DEFAULT 0,
  pages      INTEGER DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  actor      TEXT DEFAULT 'system',
  action     TEXT NOT NULL,
  detail     TEXT DEFAULT '',
  ip         TEXT DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS login_attempts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ip         TEXT NOT NULL,
  kind       TEXT NOT NULL,
  ok         INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_attempts_ip ON login_attempts(ip, created_at);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status, id);
CREATE INDEX IF NOT EXISTS idx_audit_time ON audit(created_at);
`);

// 旧库补列：CREATE TABLE IF NOT EXISTS 不会给已存在的表加字段，
// 升级后用户资料（微信号/手机/真实姓名/申请说明）必须能落库，否则接口会报 no such column。
function ensureColumns(table, columns) {
  const exists = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
  for (const [name, ddl] of Object.entries(columns)) {
    if (exists.has(name)) continue;
    try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${ddl}`); } catch (_) { /* 列已存在并发场景 */ }
  }
}

ensureColumns('api_keys', { expires_at: 'TEXT' });
ensureColumns('users', {
  username: 'TEXT',
  pass_hash: 'TEXT',
  wechat_id: "TEXT DEFAULT ''",
  phone: "TEXT DEFAULT ''",
  real_name: "TEXT DEFAULT ''",
  apply_note: "TEXT DEFAULT ''",
  approved_by: "TEXT DEFAULT ''",
  // 解绑时把原 openid 记下来：同一微信再次登录可以直接回到原账号，不再新建重复用户
  prev_openid: "TEXT DEFAULT ''",
  // 改密/重置密码的时间：比它更早签发的令牌一律失效，避免密码泄露后旧会话还能用
  pwd_changed_at: "TEXT DEFAULT ''",
  updated_at: 'TEXT'
});
db.exec('CREATE INDEX IF NOT EXISTS idx_users_status ON users(status, id)');
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users(username)');
// 小程序的文件/任务列表、删用户、用户详情统计都按 user_id 过滤，没有索引会全表扫
db.exec('CREATE INDEX IF NOT EXISTS idx_files_user ON files(user_id, id)');
db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_user ON tasks(user_id, id)');
db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_created ON tasks(created_at)');

const nowISO = () => new Date().toISOString();

const stmtSettingGet = db.prepare('SELECT value FROM settings WHERE key = ?');
const stmtSettingSet = db.prepare(
  'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
);

function getSetting(key, fallback = null) {
  const row = stmtSettingGet.get(key);
  if (!row) return fallback;
  return row.value;
}

function setSetting(key, value) {
  stmtSettingSet.run(key, value === null || value === undefined ? '' : String(value));
}

function setSettings(obj) {
  const tx = db.transaction((entries) => {
    for (const [k, v] of entries) setSetting(k, v);
  });
  tx(Object.entries(obj));
}

function getBool(key, fallback = false) {
  const v = getSetting(key, null);
  if (v === null) return fallback;
  return v === '1' || v === 'true' || v === 'on';
}

function getInt(key, fallback = 0) {
  const v = getSetting(key, null);
  if (v === null || v === '') return fallback;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

// 运行期配置：所有模块统一从这里读，避免散落的 process.env
function cfg() {
  const d = config.defaults;
  return {
    cupsServer: getSetting('cupsServer', d.cupsServer),
    defaultPrinter: getSetting('defaultPrinter', d.defaultPrinter),
    maxFileMB: getInt('maxFileMB', d.maxFileMB),
    maxCopies: getInt('maxCopies', d.maxCopies),
    maxPages: getInt('maxPages', d.maxPages),
    loginMaxFail: getInt('loginMaxFail', d.loginMaxFail),
    loginLockMin: getInt('loginLockMin', d.loginLockMin),
    bindTokenTtlMin: getInt('bindTokenTtlMin', d.bindTokenTtlMin),
    bindFailRotate: getInt('bindFailRotate', d.bindFailRotate),
    sessionHours: getInt('sessionHours', d.sessionHours),
    approveNewUser: getBool('approveNewUser', d.approveNewUser),
    approveEachJob: getBool('approveEachJob', d.approveEachJob),
    enableQrLogin: getBool('enableQrLogin', d.enableQrLogin),
    enablePasswordLogin: getBool('enablePasswordLogin', d.enablePasswordLogin),
    hideUserAdvanced: getBool('hideUserAdvanced', d.hideUserAdvanced),
    enableUserRegister: getBool('enableUserRegister', d.enableUserRegister),
    guestMode: getBool('guestMode', d.guestMode),
    retentionDays: getInt('retentionDays', d.retentionDays),
    autoCleanHistory: getBool('autoCleanHistory', d.autoCleanHistory),
    historyDays: getInt('historyDays', d.historyDays),
    auditRetentionDays: getInt('auditRetentionDays', d.auditRetentionDays),
    wxAppid: getSetting('wxAppid', d.wxAppid),
    wxSecret: getSetting('wxSecret', d.wxSecret),
    adminOpenids: getSetting('adminOpenids', d.adminOpenids),
    enableFrp: getBool('enableFrp', d.enableFrp === 'true'),
    frpServer: getSetting('frpServer', d.frpServer),
    frpPort: getInt('frpPort', d.frpPort),
    frpToken: getSetting('frpToken', d.frpToken),
    frpRemotePort: getInt('frpRemotePort', d.frpRemotePort),
    frpMode: getSetting('frpMode', d.frpMode),
    frpDomain: getSetting('frpDomain', d.frpDomain),
    relayPort: getInt('relayPort', d.relayPort),
    relayPublicUrl: getSetting('relayPublicUrl', d.relayPublicUrl)
  };
}

function logAudit(action, detail = '', ip = '', actor = 'admin') {
  try {
    db.prepare('INSERT INTO audit (actor, action, detail, ip, created_at) VALUES (?,?,?,?,?)')
      .run(actor, action, String(detail).slice(0, 800), ip, nowISO());
  } catch (_) { /* 审计失败不阻塞业务 */ }
}

module.exports = {
  db, nowISO, getSetting, setSetting, setSettings, getBool, getInt,
  cfg, logAudit
};
