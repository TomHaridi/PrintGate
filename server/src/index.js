'use strict';
// PrintGate 主服务：管理后台 SPA + REST API + 小程序接口 + 开放 API
const express = require('express');
const path = require('path');
const fs = require('fs');
const config = require('./config');
const { cfg, setSetting, getSetting } = require('./db');
const sec = require('./security');
const system = require('./system');
const { migrateLegacy } = require('./migrate');
const cleanup = require('./cleanup');
const vprinter = require('./vprinter');

const app = express();
app.disable('x-powered-by');
// 只有显式声明 TRUST_PROXY=true 才信任反代头，避免伪造 IP 绕过限流
app.set('trust proxy', process.env.TRUST_PROXY === 'true' ? 1 : false);

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: false, limit: '2mb' }));

// ---------- 安全响应头 ----------
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; " +
    "object-src 'none'; frame-ancestors 'self'; base-uri 'self'; form-action 'self'");
  if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
  next();
});

// ---------- 启动初始化 ----------
migrateLegacy();
// 首次启动生成绑定码（带 TTL），保证「小程序扫码绑定管理员」开箱可用
sec.bindTokenInfo();
try { vprinter.autoStart(); } catch (e) { console.warn('[vprinter] 启动失败:', e.message); }

// ---------- 打印队列自愈 ----------
// CUPS 的 printers.conf 是「约 30 秒脏检查」才落盘的（实测 SIGHUP / cupsctl 都逼不出来），
// 所以「刚加完打印机就崩溃/重启」这个窗口里队列会丢。应用自己在 SQLite 里留了一份配置，
// 启动后等 CUPS 就绪再对账，缺哪个按原参数重建；之后每 5 分钟再对一次，防止 cupsd 重启丢配置。
const cups = require('./cups');
const printerstore = require('./printerstore');
let orphanChecked = false;
async function reconcilePrinters() {
  try {
    const r = await printerstore.reconcile(cups);
    if (r.error) return false;
    if (r.restored && r.restored.length) {
      console.log(`[PrintGate] 已按本地配置重建 ${r.restored.length} 个打印队列：${r.restored.join(', ')}`);
    }
    // 队列对账完再看一眼「printing 但作业已消失」的任务，避免把没出纸的任务当成功。
    // 只在启动后第一次对账时做（正常运行的收尾交给 syncPrintingTasks，每 8 秒一次）。
    if (!orphanChecked) {
      orphanChecked = true;
      try {
        const o = await require('./routes/print').markOrphanedPrinting();
        if (o.failed) console.log(`[PrintGate] ${o.failed} 个任务因服务重启丢失作业，已标记为失败待重试`);
      } catch (_) {}
    }
    return true;
  } catch (e) {
    console.warn('[printerstore] 对账失败:', e.message);
    return false;
  }
}
(async () => {
  // CUPS 在容器里比自己晚几秒就绪，最多重试约 60 秒
  for (let i = 0; i < 24; i++) {
    if (await reconcilePrinters()) break;
    await new Promise((r) => setTimeout(r, 2500));
  }
})();
setInterval(reconcilePrinters, 5 * 60 * 1000).unref();
// 同步 frp 配置文件（守护进程按 /data/frp/enabled 决定是否启动）
try { system.writeFrpFiles(); } catch (e) { console.warn('[frp] 写入配置失败:', e.message); }

// ---------- 路由 ----------
app.use('/api', sec.rateLimit({ key: 'global', windowMs: 60000, max: 900 }));
app.use('/api', require('./routes/auth'));
app.use('/api', require('./routes/account'));
app.use('/api', require('./routes/mp'));
app.use('/api', require('./routes/wechat'));
app.use('/api', require('./routes/printers'));
app.use('/api', require('./routes/drivers'));
app.use('/api', require('./routes/relay'));
const printRoutes = require('./routes/print');
app.use('/api', printRoutes);
app.use('/api', require('./routes/upload'));
app.use('/api', require('./routes/users'));
app.use('/api', require('./routes/settings'));
app.use('/api', require('./routes/system'));
app.use('/api', require('./routes/cups'));
app.use('/api', require('./routes/apikeys'));

app.get('/api/health', (req, res) => {
  let sharpOk = true;
  try { sharpOk = require('./render').sharpReady(); } catch (_) { sharpOk = false; }
  res.json({
    ok: true, app: 'PrintGate', version: config.version, time: new Date().toISOString(),
    uptime: Math.round(process.uptime()), sharp: sharpOk
  });
});

app.use('/api', (req, res) => res.status(404).json({ ok: false, msg: '接口不存在' }));

// ---------- 移动端 Web（H5，iOS 壳也加载这一份） ----------
// 与接口同源，所以 H5 里直接打相对路径的 /api/*，不需要 CORS；
// iOS 壳只要加载 <服务地址>/m/ 就等于装上了 App，UI 更新只更新容器镜像即可。
const mobileRoot = path.join(__dirname, '..', 'mobile');
if (fs.existsSync(mobileRoot)) {
  app.use('/m', express.static(mobileRoot, {
    setHeaders: (res, filePath) => {
      // 入口文件不缓存，避免换了镜像用户还看到旧界面
      if (/\.(js|css|html|webmanifest)$/.test(filePath)) res.setHeader('Cache-Control', 'no-cache');
    }
  }));
}

// ---------- 静态前端 ----------
const webRoot = config.webRoot;
app.use(express.static(webRoot, {
  index: false,
  setHeaders: (res, filePath) => {
    if (/\.(js|css|woff2?|png|svg|jpg|ico)$/.test(filePath)) {
      res.setHeader('Cache-Control', 'public, max-age=604800, immutable');
    }
  }
}));

app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  const index = path.join(webRoot, 'index.html');
  if (!fs.existsSync(index)) {
    return res.status(500).send('前端资源缺失：请先执行前端构建（npm run build）');
  }
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(index);
});

// ---------- 错误处理 ----------
app.use((err, req, res, next) => {
  // 4xx 属于客户端问题（畸形 JSON、字段非法等），不刷错误日志
  if (!err.status || err.status >= 500) {
    console.error('[error]', req.method, req.originalUrl, err.message);
  }
  if (res.headersSent) return next(err);
  res.status(err.status || 500).json({ ok: false, msg: err.expose ? err.message : '服务器内部错误' });
});

// ---------- 定时任务：历史与存储清理 ----------
// 自动清理默认每小时跑一次（PG_AUTO_CLEAN_MS 可调，便于测试），
// 逻辑统一在 cleanup.js：任务记录 / CUPS 已完成作业 / 落盘文件 / 源文件 / 扫描件。
const AUTO_CLEAN_MS = Number(process.env.PG_AUTO_CLEAN_MS || 3600 * 1000);
async function runAutoCleanup() {
  try {
    await cleanup.autoRun();
  } catch (e) {
    console.error('[cleanup]', e.message);
  }
}
setTimeout(runAutoCleanup, 20000);
setInterval(runAutoCleanup, AUTO_CLEAN_MS).unref();

// 打印状态同步：把已离开 CUPS 队列的 printing 任务收尾为 done
setInterval(() => {
  printRoutes.syncPrintingTasks().catch((e) => console.error('[sync]', e.message));
}, 8000).unref();
setTimeout(() => printRoutes.syncPrintingTasks().catch(() => {}), 5000);


// ---------- 启动 ----------
const server = app.listen(config.port, config.host, () => {
  console.log(`[PrintGate] v${config.version} listening on ${config.host}:${config.port}`);
  console.log(`[PrintGate] data dir: ${config.dataDir}`);
  try {
    const render = require('./render');
    console.log(`[PrintGate] modules: sharp=${render.sharpReady() ? 'ok' : 'FAIL(' + render.sharpError() + ')'} cups=ok`);
  } catch (e) {
    console.log('[PrintGate] modules: 检查失败 ' + e.message);
  }
  console.log(`[PrintGate] setup required: ${!sec.hasAdminPassword()}`);
  const c = cfg();
  console.log(`[PrintGate] default printer: ${c.defaultPrinter || '(未设置)'} | wechat: ${c.wxAppid ? 'configured' : 'missing'}`);
  // Office 组件装在容器可写层，换镜像就没了；数据卷里有包缓存就在后台自动装回去，
  // 用户不必每次升级后重新点「一键安装」（不阻塞启动，进度在设置页可见）
  require('./converter').restoreIfCached().then((r) => {
    if (r && r.started) console.log(`[PrintGate] office: ${r.msg}`);
  }).catch(() => {});
  // 旧版本把无扩展名的图片落成了 .bin，预览/合并按后缀判类型认不出，启动时按文件头改正
  try {
    const lf = require('./legacyfix').fixLegacyBinFiles();
    if (lf.fixed) console.log(`[PrintGate] 已修正 ${lf.fixed} 个历史图片文件的扩展名`);
  } catch (_) {}
});

function shutdown(sig) {
  console.log(`[PrintGate] ${sig} received, shutting down`);
  // 退出前把 WAL 合并回主库：否则「只拷贝 printgate.db」的外部备份会丢掉最近的写入
  try {
    const { db } = require('./db');
    db.pragma('wal_checkpoint(TRUNCATE)');
    console.log('[PrintGate] SQLite WAL 已合并到主库');
  } catch (e) {
    console.warn('[PrintGate] WAL 合并失败:', e.message);
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
// 未捕获异常说明进程状态已不可信（可能持有半成品任务/半开句柄），
// 记日志后退出，让 docker restart / systemd 拉起一个干净进程；静默续跑只会带病服务。
process.on('uncaughtException', (e) => {
  console.error('[uncaught] 进程状态不可信，准备退出：', e && (e.stack || e.message));
  try { require('./db').db.pragma('wal_checkpoint(TRUNCATE)'); } catch (_) {}
  setTimeout(() => process.exit(1), 100);
});
process.on('unhandledRejection', (e) => console.error('[unhandled]', e));
