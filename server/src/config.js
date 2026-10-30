'use strict';
// PrintGate 服务端配置：环境变量只作为「首次启动默认值」，
// 运行期以数据库 settings 表为准（管理后台可改，重启后仍生效）。
const path = require('path');
const fs = require('fs');

const dataDir = process.env.PG_DATA_DIR || process.env.DATA_DIR || '/data';
// 网络扫描仪（sane-airscan）的设备地址存在数据卷里：容器重建后不用重配。
// SANE 会按 SANE_CONFIG_DIR 的冒号列表依次找 backend 配置，把 /etc/sane.d 留在后面，
// 这样 airscan.conf 由我们托管，epson2 等其它后端仍用系统自带配置。
const saneConfDir = path.join(dataDir, 'sane.d');
try { fs.mkdirSync(saneConfDir, { recursive: true }); } catch (_) {}
if (!process.env.SANE_CONFIG_DIR) process.env.SANE_CONFIG_DIR = `${saneConfDir}:/etc/sane.d`;
try { fs.mkdirSync(dataDir, { recursive: true }); } catch (_) {}

const num = (v, d) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : d;
};

module.exports = {
  appName: 'PrintGate',
  version: require('../package.json').version,
  port: num(process.env.PORT, 8080),
  host: process.env.HOST || '0.0.0.0',
  dataDir,
  uploadDir: path.join(dataDir, 'files'),
  avatarDir: path.join(dataDir, 'avatars'),
  scanDir: path.join(dataDir, 'scans'),
  saneConfDir,
  dbPath: path.join(dataDir, 'printgate.db'),
  logDir: process.env.PG_LOG_DIR || '/var/log/printgate',
  webRoot: path.join(__dirname, '..', 'public'),

  // 首次启动默认值（之后由设置页覆盖）
  defaults: {
    cupsServer: process.env.CUPS_SERVER || '127.0.0.1:631',
    defaultPrinter: process.env.DEFAULT_PRINTER || '',
    maxFileMB: num(process.env.MAX_FILE_MB, 200),
    maxCopies: num(process.env.MAX_COPIES, 10),
    maxPages: num(process.env.MAX_PAGES, 200),
    loginMaxFail: num(process.env.LOGIN_MAX_FAIL, 5),
    loginLockMin: num(process.env.LOGIN_LOCK_MIN, 15),
    // 绑定码（小程序扫码升管理员）有效期：默认 10 分钟，用后立即作废换新
    bindTokenTtlMin: num(process.env.BIND_TOKEN_TTL_MIN, 10),
    // 全站 30 分钟内绑定码失败次数达到该值 → 强制换码（防多 IP 分布式撞码）
    bindFailRotate: num(process.env.BIND_FAIL_ROTATE, 50),
    sessionHours: num(process.env.SESSION_HOURS, 24),
    approveNewUser: process.env.APPROVE_NEW_USER !== 'false',
    approveEachJob: process.env.APPROVE_EACH_JOB === 'true',
    enableQrLogin: process.env.ENABLE_QR_LOGIN !== 'false',
    // 管理员密码登录开关（关掉后只能用微信扫码登录，适合全员微信授权的场景）
    enablePasswordLogin: process.env.ENABLE_PASSWORD_LOGIN !== 'false',
    // 普通用户门户是否隐藏详细打印设置（份数/单双面/纸张等），只给「选文件-选打印机-打印」
    hideUserAdvanced: process.env.HIDE_USER_ADVANCED === 'true',
    // 是否允许普通用户自助注册（关闭后新微信登录不再自动建号，只能由管理员在后台添加）
    enableUserRegister: process.env.ENABLE_USER_REGISTER !== 'false',
    guestMode: process.env.GUEST_MODE === 'true',
    retentionDays: num(process.env.RETENTION_DAYS, 30),
    // 历史清理：任务记录 / CUPS 已完成作业 / 落盘文件；0 天表示全部
    autoCleanHistory: process.env.AUTO_CLEAN_HISTORY !== 'false',
    historyDays: num(process.env.HISTORY_DAYS, 30),
    // 审计日志保留天数：随自动清理一并轮转，0 表示永久保留（默认 180 天，避免表无限膨胀）
    auditRetentionDays: num(process.env.AUDIT_RETENTION_DAYS, 180),
    wxAppid: process.env.WX_APPID || '',
    wxSecret: process.env.WX_SECRET || '',
    adminOpenids: process.env.ADMIN_OPENIDS || '',
    enableFrp: process.env.FRP_SERVER_ADDR ? 'true' : 'false',
    frpServer: process.env.FRP_SERVER_ADDR || '',
    frpPort: num(process.env.FRP_SERVER_PORT, 7000),
    frpToken: process.env.FRP_TOKEN || '',
    frpRemotePort: num(process.env.FRP_REMOTE_PORT, 3100),
    // tcp：云服务器用独立端口映射（简单）；wss：复用 443，经 nginx 的 /~!frp 转发到 frps
    frpMode: process.env.FRP_MODE === 'wss' ? 'wss' : 'tcp',
    frpDomain: process.env.FRP_DOMAIN || '',
    relayPort: num(process.env.RELAY_PORT, 3100),
    relayPublicUrl: process.env.RELAY_PUBLIC_URL || ''
  }
};
