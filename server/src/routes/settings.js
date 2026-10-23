'use strict';
// 设置中心：读写配置、连通性自检、数据清理、数据库备份
const express = require('express');
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const cups = require('../cups');
const system = require('../system');
const converter = require('../converter');
const cleanup = require('../cleanup');
const config = require('../config');
const { db, cfg, getSetting, setSettings, logAudit, nowISO } = require('../db');
const sec = require('../security');
const { requireAdmin } = require('../middleware');

const router = express.Router();

function mask(v) {
  if (!v) return '';
  if (v.length <= 8) return '****';
  return `${v.slice(0, 4)}****${v.slice(-4)}`;
}

function fullSettings() {
  const c = cfg();
  const bind = sec.bindTokenInfo(); // 一码一人 + TTL，前端按 remainingSec 倒计时
  return {
    cups: { cupsServer: c.cupsServer, defaultPrinter: c.defaultPrinter },
    print: { maxFileMB: c.maxFileMB, maxCopies: c.maxCopies, maxPages: c.maxPages, approveEachJob: c.approveEachJob },
    security: {
      loginMaxFail: c.loginMaxFail, loginLockMin: c.loginLockMin, sessionHours: c.sessionHours,
      enableQrLogin: c.enableQrLogin, approveNewUser: c.approveNewUser, guestMode: c.guestMode,
      enablePasswordLogin: c.enablePasswordLogin, hideUserAdvanced: c.hideUserAdvanced,
      enableUserRegister: c.enableUserRegister
    },
    wechat: {
      wxAppid: c.wxAppid,
      wxSecret: mask(c.wxSecret),
      wxSecretConfigured: !!c.wxSecret,
      // 与旧版保持一致返回逗号串（这个字段被脚本/第三方按字符串消费），只过滤掉非法值
      adminOpenids: sec.cleanOpenids(c.adminOpenids).list.filter((id) => sec.validOpenid(id)).join(',')
    },
    relay: {
      enableFrp: c.enableFrp, frpServer: c.frpServer, frpPort: c.frpPort,
      frpToken: mask(c.frpToken), frpTokenConfigured: !!c.frpToken,
      frpRemotePort: c.frpRemotePort, relayPort: c.relayPort, relayPublicUrl: c.relayPublicUrl,
      frpMode: c.frpMode, frpDomain: c.frpDomain
    },
    storage: { retentionDays: c.retentionDays },
    history: { autoCleanHistory: c.autoCleanHistory, historyDays: c.historyDays },
    dev: { devMode: getSetting('devMode', '0') === '1' },
    // 绑定码：一码一人 + TTL，前端按 remainingSec 显示倒计时
    bindToken: bind.token,
    bindExpiresAt: bind.expiresAt,
    bindTtlMin: Math.round(bind.ttlSec / 60),
    bindRemainingSec: bind.remainingSec
  };
}

router.get('/settings', requireAdmin, async (req, res) => {
  // officeProbe=1：跳过 60s 缓存重新探测（设置页「重新检测」按钮用）
  const conv = req.query.officeProbe === '1' ? await require('../converter').detect(true) : await converter.detect();
  res.json({
    ok: true, settings: fullSettings(), version: config.version,
    features: { officeConvert: conv.available, officeVersion: conv.version || '' }
  });
});

router.put('/settings', requireAdmin, (req, res) => {
  const b = req.body || {};
  const updates = {};
  const errors = [];
  const intIn = (v, min, max, label) => {
    const n = parseInt(v, 10);
    if (!Number.isFinite(n) || n < min || n > max) { errors.push(`${label} 需在 ${min}-${max} 之间`); return null; }
    return n;
  };

  if (b.defaultPrinter !== undefined) updates.defaultPrinter = String(b.defaultPrinter).trim().slice(0, 64);
  if (b.cupsServer !== undefined) {
    const v = String(b.cupsServer).trim();
    // 必须是 host 或 host:port，"7" 之类的裸数字能存但连不上，直接拦掉
    const m = v ? /^([A-Za-z0-9][A-Za-z0-9._-]*)(?::(\d{1,5}))?$/.exec(v) : null;
    if (v && !m) errors.push('CUPS 服务地址格式应为 host 或 host:port（示例 127.0.0.1:631）');
    else if (v && /^\d+$/.test(v)) errors.push('CUPS 服务地址格式应为 host 或 host:port（示例 127.0.0.1:631）');
    else if (v && m[2] && (Number(m[2]) < 1 || Number(m[2]) > 65535)) errors.push('CUPS 端口需在 1-65535 之间');
    else updates.cupsServer = v || '127.0.0.1:631';
  }
  if (b.maxFileMB !== undefined) { const v = intIn(b.maxFileMB, 1, 2048, '单文件上限'); if (v) updates.maxFileMB = v; }
  if (b.maxCopies !== undefined) { const v = intIn(b.maxCopies, 1, 999, '最大份数'); if (v) updates.maxCopies = v; }
  if (b.maxPages !== undefined) { const v = intIn(b.maxPages, 1, 2000, '单任务页数上限'); if (v) updates.maxPages = v; }
  if (b.loginMaxFail !== undefined) { const v = intIn(b.loginMaxFail, 1, 50, '登录失败次数'); if (v) updates.loginMaxFail = v; }
  if (b.loginLockMin !== undefined) { const v = intIn(b.loginLockMin, 1, 1440, '锁定分钟数'); if (v) updates.loginLockMin = v; }
  if (b.sessionHours !== undefined) { const v = intIn(b.sessionHours, 1, 720, '登录有效期（小时）'); if (v) updates.sessionHours = v; }
  if (b.retentionDays !== undefined) { const v = intIn(b.retentionDays, 1, 3650, '文件保留天数'); if (v) updates.retentionDays = v; }
  if (b.historyDays !== undefined) { const v = intIn(b.historyDays, 0, 3650, '历史保留天数'); if (v !== null) updates.historyDays = v; }
  if (b.autoCleanHistory !== undefined) updates.autoCleanHistory = b.autoCleanHistory ? '1' : '0';

  for (const k of ['approveEachJob', 'enableQrLogin', 'approveNewUser', 'guestMode', 'enableFrp',
    'enablePasswordLogin', 'hideUserAdvanced', 'enableUserRegister']) {
    if (b[k] !== undefined) updates[k] = b[k] ? '1' : '0';
  }
  if (b.devMode !== undefined) updates.devMode = b.devMode ? '1' : '0';

  if (b.wxAppid !== undefined) {
    const v = String(b.wxAppid).trim();
    if (v && !/^wx[0-9a-zA-Z]{16}$/.test(v)) errors.push('小程序 AppID 格式不正确（通常为 wx 开头 18 位）');
    else updates.wxAppid = v;
  }
  if (b.wxSecret !== undefined && String(b.wxSecret).trim() !== '') {
    const v = String(b.wxSecret).trim();
    if (!/^[0-9a-zA-Z]{32}$/.test(v)) errors.push('小程序 AppSecret 应为 32 位字母数字');
    else updates.wxSecret = v;
  }
  if (b.adminOpenids !== undefined) {
    // 与 /api/wechat/config 同一套规则：两个入口写同一个设置，不能一个严一个松
    const { list, bad } = sec.cleanOpenids(b.adminOpenids);
    if (bad.length) errors.push(`OpenID 格式可疑：${bad.slice(0, 2).join(', ')}`);
    else updates.adminOpenids = list.join(',');
  }
  if (b.frpServer !== undefined) {
    const raw = String(b.frpServer).trim();
    const v = raw.toLowerCase();
    // 服务端地址会写进 frpc.toml，必须限定为 IP 或域名，杜绝引号/换行导致的配置注入
    if (raw.length > 128) errors.push('frp 服务端地址过长（最多 128 字符）');
    else if (v && !(/^\d{1,3}(\.\d{1,3}){3}$/.test(v) || /^[a-z0-9]([a-z0-9-]{0,62}\.)*[a-z0-9]{1,63}$/.test(v))) {
      errors.push('frp 服务端地址需为 IP 或域名（示例：1.2.3.4 或 frp.example.com）');
    } else updates.frpServer = raw;
  }
  if (b.frpPort !== undefined) { const v = intIn(b.frpPort, 1, 65535, 'frp 服务端口'); if (v) updates.frpPort = v; }
  if (b.frpRemotePort !== undefined) { const v = intIn(b.frpRemotePort, 1, 65535, 'frp 远程端口'); if (v) updates.frpRemotePort = v; }
  if (b.frpToken !== undefined) {
    const raw = String(b.frpToken).trim();
    if (raw === '') { /* 空串表示不修改 */ }
    else if (raw.length > 256) errors.push('frp Token 过长（最多 256 字符）');
    else if (!/^[A-Za-z0-9._~+/-]{1,256}$/.test(raw)) errors.push('frp Token 只能包含字母、数字与 . _ ~ + / - （不支持引号或换行）');
    else updates.frpToken = raw;
  }
  if (b.frpMode !== undefined) {
    const v = String(b.frpMode).trim();
    if (!['tcp', 'wss'].includes(v)) errors.push('frp 模式只能是 tcp 或 wss');
    else updates.frpMode = v;
  }
  if (b.frpDomain !== undefined) {
    const v = String(b.frpDomain).trim().toLowerCase();
    if (v && !/^[a-z0-9]([a-z0-9-]{0,62}\.)*[a-z0-9]([a-z0-9-]{0,62})$/.test(v)) {
      errors.push('域名格式不正确（示例：print.example.com）');
    } else updates.frpDomain = v;
  }
  if (b.relayPublicUrl !== undefined) {
    const v = String(b.relayPublicUrl).trim();
    // 禁止空白与引号：该地址会出现在页面、二维码与后续请求拼接处
    if (v && !/^https?:\/\/[^\s"'`<>\\]{1,253}$/i.test(v)) {
      errors.push('对外访问地址需以 http(s):// 开头，且不能包含空格或引号');
    } else updates.relayPublicUrl = v;
  }
  // 密码登录与扫码登录不能同时关掉：否则管理员自己也进不来（只能删库重置）
  if ('enablePasswordLogin' in updates || 'enableQrLogin' in updates) {
    const c0 = cfg();
    const pwd = 'enablePasswordLogin' in updates ? updates.enablePasswordLogin === '1' : c0.enablePasswordLogin;
    const qr = 'enableQrLogin' in updates ? updates.enableQrLogin === '1' : c0.enableQrLogin;
    if (!pwd && !qr) {
      errors.push('密码登录与微信扫码登录不能同时关闭，否则任何账号都无法登录后台');
      delete updates.enablePasswordLogin;
      delete updates.enableQrLogin;
    }
  }
  if (errors.length) return res.status(400).json({ ok: false, msg: errors[0], errors });

  setSettings(updates);
  if (['enableFrp', 'frpServer', 'frpPort', 'frpToken', 'frpRemotePort', 'frpMode', 'frpDomain'].some((k) => k in updates)) {
    system.writeFrpFiles();
    cups.run('pkill', ['-x', 'frpc']);
  }
  logAudit('settings_update', Object.keys(updates).join(','), sec.clientIp(req), 'admin');
  res.json({ ok: true, msg: '设置已保存并生效', settings: fullSettings() });
});

router.post('/settings/test', requireAdmin, sec.rateLimit({ key: 'selftest', windowMs: 60000, max: 20 }), async (req, res) => {
  const target = String((req.body || {}).target || '');
  const c = cfg();
  if (target === 'cups') {
    const st = await cups.status();
    const list = await cups.listPrinters();
    return res.json({
      ok: st.running, msg: st.running ? `CUPS 正常，共 ${list.printers.length} 个队列` : st.message,
      detail: { printers: list.printers.length, default: list.default }
    });
  }
  if (target === 'wechat') {
    if (!c.wxAppid || !c.wxSecret) return res.json({ ok: false, msg: '请先填写 AppID 与 AppSecret' });
    try {
      const url = `https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=${encodeURIComponent(c.wxAppid)}&secret=${encodeURIComponent(c.wxSecret)}`;
      const r = await fetch(url);
      const d = await r.json();
      if (d.errcode) return res.json({ ok: false, msg: `微信校验失败：${d.errmsg}（${d.errcode}）` });
      return res.json({ ok: true, msg: '小程序凭据有效，可正常登录', detail: { expiresIn: d.expires_in } });
    } catch (e) {
      return res.json({ ok: false, msg: `无法连接微信接口：${e.message}` });
    }
  }
  if (target === 'frp') {
    if (!c.frpServer) return res.json({ ok: false, msg: '请先填写 frp 服务端地址' });
    const ok = await new Promise((resolve) => {
      const s = new net.Socket();
      let done = false;
      const fin = (v) => { if (!done) { done = true; s.destroy(); resolve(v); } };
      s.setTimeout(4000);
      s.once('connect', () => fin(true));
      s.once('timeout', () => fin(false));
      s.once('error', () => fin(false));
      s.connect(c.frpPort, c.frpServer);
    });
    return res.json({ ok, msg: ok ? `可连通 ${c.frpServer}:${c.frpPort}` : `无法连接 ${c.frpServer}:${c.frpPort}` });
  }
  res.status(400).json({ ok: false, msg: '未知的检测目标' });
});

// 立即执行清理（按「数据保留」策略：源文件 / 扫描件 / 180 天前日志）
router.post('/settings/cleanup', requireAdmin, async (req, res) => {
  const b = req.body || {};
  // 默认按「数据保留」策略跑；也允许手动指定天数（0 表示清全部历史）
  let days = cfg().retentionDays;
  if (b.days !== undefined && b.days !== null && b.days !== '') {
    const n = parseInt(b.days, 10);
    if (!Number.isFinite(n) || n < 0 || n > 3650) {
      return res.status(400).json({ ok: false, msg: '清理天数需在 0-3650 之间（0 表示全部历史）' });
    }
    days = n;
  }
  const CLEANABLE = ['files', 'scans', 'tasks', 'cups', 'spool'];
  let targets = ['files', 'scans'];
  if (b.kinds !== undefined) {
    if (!Array.isArray(b.kinds) || !b.kinds.length) return res.status(400).json({ ok: false, msg: '请指定要清理的项' });
    const bad = b.kinds.filter((k) => !CLEANABLE.includes(k));
    if (bad.length) return res.status(400).json({ ok: false, msg: `未知的清理项：${bad.join('、')}` });
    targets = b.kinds;
  }
  const r = await cleanup.clean({ days, targets, auditDays: 180 });
  const msg = `已清理 ${r.files?.removed || 0} 个文件、${r.scans?.removed || 0} 条扫描记录、`
    + `${r.audit?.removed || 0} 条旧日志`;
  logAudit('cleanup', `files=${r.files?.removed || 0} scans=${r.scans?.removed || 0} audit=${r.audit?.removed || 0} days=${days}`,
    sec.clientIp(req), 'admin');
  res.json({ ok: true, msg });
});

// 数据库备份下载
router.get('/settings/backup', requireAdmin, (req, res) => {
  let tmp = '';
  try {
    // 直接下载活动库会在流式传输期间被写入「撕裂」。VACUUM INTO 会生成一份一致的快照，
    // 下载完再删，既有完整性又不需要停服。
    tmp = path.join(os.tmpdir(), `printgate-backup-${process.pid}-${Date.now()}.db`);
    db.exec(`VACUUM INTO '${String(tmp).replace(/'/g, "''")}'`);
    const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    logAudit('backup', 'database', sec.clientIp(req), 'admin');
    res.download(tmp, `printgate-backup-${ts}.db`, () => {
      try { fs.unlinkSync(tmp); } catch (_) {}
    });
  } catch (e) {
    try { if (tmp && fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (_) {}
    res.status(500).json({ ok: false, msg: '备份失败：' + e.message });
  }
});

// 存储占用
router.get('/settings/storage', requireAdmin, async (req, res) => {
  const dirSize = (dir) => {
    let total = 0;
    try {
      for (const f of fs.readdirSync(dir)) {
        const p = path.join(dir, f);
        try { const st = fs.statSync(p); if (st.isFile()) total += st.size; } catch (_) {}
      }
    } catch (_) {}
    return total;
  };
  res.json({
    ok: true,
    storage: {
      uploads: dirSize(config.uploadDir),
      scans: dirSize(config.scanDir),
      db: fs.existsSync(config.dbPath) ? fs.statSync(config.dbPath).size : 0,
      disk: await system.diskUsage(),
      retentionDays: cfg().retentionDays,
      files: db.prepare('SELECT COUNT(*) c FROM files').get().c,
      tasks: db.prepare('SELECT COUNT(*) c FROM tasks').get().c
    }
  });
});

module.exports = router;
module.exports.fullSettings = fullSettings;
