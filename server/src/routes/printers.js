'use strict';
// 打印机管理：列表 / 增删 / 启停 / 默认 / 测试页 / 自动发现
const express = require('express');
const fs = require('fs');
const path = require('path');
const cups = require('../cups');
const discover = require('../discover');
const scan = require('../scan');
const config = require('../config');
const { db, cfg, getSetting, setSettings, logAudit, nowISO } = require('../db');
const sec = require('../security');
const { requireAdmin, requirePrintAccess } = require('../middleware');
const { buildTestPagePdf } = require('../pdf');
const vprinter = require('../vprinter');
const drivers = require('../drivers');
const printerstore = require('../printerstore');
const cleanup = require('../cleanup');
const fsutil = require('../fsutil');
const orphans = require('../orphans');

const router = express.Router();

// 打印机附注（备注/常用）保存在 settings，键前缀 printerNote:
function noteOf(name) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(`printerNote:${name}`);
  return row ? row.value : '';
}

router.get('/printers', requirePrintAccess, async (req, res) => {
  const isAdmin = !req.actor || req.actor.kind === 'admin' || req.actor.kind === 'key';
  const [data, jobs] = await Promise.all([
    cups.listPrinters(),
    isAdmin ? cups.listJobs() : Promise.resolve({ jobs: [] })
  ]);
  if (!data.ok) return res.json({ ok: false, msg: data.msg, printers: [], cups: { running: false, message: data.msg } });
  const counts = {};
  for (const j of jobs.jobs) counts[j.printer] = (counts[j.printer] || 0) + 1;
  const printers = data.printers.map((p) => ({
    ...p,
    // 队列里有多少待打任务属于内部信息，普通用户只拿到队列本身的状态
    queueJobs: isAdmin ? (counts[p.name] || 0) : undefined,
    note: isAdmin ? noteOf(p.name) : ''
  }));
  res.json({ ok: true, printers, default: data.default, cups: await cups.status() });
});

router.get('/printers/models', requireAdmin, async (req, res) => {
  const data = await cups.listModels(String(req.query.q || ''));
  res.json({ ok: true, ...data });
});

router.get('/printers/devices', requireAdmin, async (req, res) => {
  const data = await cups.listDevices();
  res.json({ ok: true, ...data });
});

router.post('/printers', requireAdmin, async (req, res) => {
  const {
    name, uri, model = 'everywhere', info = '', location = '', shared = true,
    deviceId = '', formats = [], driverless = false
  } = req.body || {};
  if (!name || !uri) return res.status(400).json({ ok: false, msg: '队列名与设备地址必填' });
  const cleanName = String(name).trim();
  const cleanUri = String(uri).trim();
  if (!/^[A-Za-z0-9_.-]{1,60}$/.test(cleanName)) {
    return res.status(400).json({ ok: false, msg: '队列名只能包含字母、数字、下划线、点和中划线' });
  }
  // file:// 会把作业写到任意本地路径（CUPS 的 file backend），等价于给管理员开了
  // 一个「以 root 任意写文件」的口子——打印机设备地址不该有这种能力，直接不允许
  if (!/^(ipp|ipps|socket|lpd|usb|dnssd|smb|http|https):\/\/.+/i.test(cleanUri)) {
    return res.status(400).json({ ok: false, msg: '设备地址需为 ipp:// ipps:// socket:// lpd:// usb:// dnssd:// 等标准 URI' });
  }
  // lpadmin -p 对已存在的队列是「修改」，不拦会把别人的队列 URI 改掉
  const existing = await cups.listPrinters();
  if (existing.printers.some((p) => p.name === cleanName)) {
    return res.status(400).json({ ok: false, msg: `队列名 ${cleanName} 已存在，请换一个名称或先删除` });
  }
  // 驱动可以是 everywhere / raw / drv://... / ppd:/data/drivers/xxx.ppd
  let useModel = String(model || '').trim() || 'everywhere';
  if (/^ppd:/i.test(useModel)) {
    const ppdPath = useModel.slice(4);
    if (!fsutil.isInside(drivers.driversDir, ppdPath) || !fs.existsSync(ppdPath)) {
      return res.status(400).json({ ok: false, msg: '所选驱动文件不存在，请重新下载或上传' });
    }
  } else if (!/^(everywhere|raw|drv:\/\/\/|lsb\/)/i.test(useModel)) {
    return res.status(400).json({ ok: false, msg: '驱动标识非法' });
  }
  const cleanInfo = String(info || '').trim().slice(0, 120);
  const cleanLocation = String(location || '').trim().slice(0, 120);
  let r = await cups.addPrinter({ name: cleanName, uri: cleanUri, model: useModel, info: cleanInfo, location: cleanLocation, shared: !!shared });
  let fallback = '';
  // 免驱驱动对老旧机型经常不可用（设备不返回 IPP 属性 / 不支持 PWG）：
  // 自动按 device-id 退回 PCL / PostScript 通用驱动，让「自动安装驱动」真的能落地
  if (!r.ok && useModel === 'everywhere') {
    const alt = await drivers.recommend({
      uri: cleanUri,
      kind: /^(ipp|ipps|dnssd):/i.test(cleanUri) ? 'ipp' : 'socket',
      model: info,
      deviceId: String(deviceId || ''),
      formats: Array.isArray(formats) ? formats : [],
      driverless: !!driverless
    });
    if (alt.id && alt.id !== 'everywhere') {
      const retry = await cups.addPrinter({
        name: cleanName, uri: cleanUri, model: alt.id, info: cleanInfo, location: cleanLocation, shared: !!shared
      });
      if (retry.ok) {
        r = retry;
        fallback = `免驱驱动不可用，已自动改用「${alt.label}」`;
      }
    }
  }
  if (!r.ok) return res.status(400).json({ ok: false, msg: r.msg || '添加失败' });
  // CUPS 的 printers.conf 是延迟落盘的（约 30 秒），这期间崩溃会丢队列。
  // 这里在自有库里存一份原始参数，启动时据此重建。
  printerstore.remember({
    name: cleanName, uri: cleanUri, model: useModel,
    info: cleanInfo, location: cleanLocation, shared: !!shared
  });
  logAudit('printer_add', `queue=${cleanName} uri=${cleanUri} model=${r.usedModel}${fallback ? ` fallback=${fallback}` : ''}`,
    sec.clientIp(req), 'admin');
  const notes = [r.note, fallback].filter(Boolean).join('；');
  res.json({
    ok: true,
    msg: `打印机 ${cleanName} 已添加${notes ? `（${notes}）` : ''}`,
    model: r.usedModel,
    fallback
  });
});

router.delete('/printers/:name', requireAdmin, async (req, res) => {
  // 与添加路由同一套白名单：execFile 参数数组不经 shell（无注入），
  // 但畸形名字会让 lpadmin 报难以理解的错误，统一在校验层挡掉
  if (!/^[A-Za-z0-9_.-]{1,60}$/.test(req.params.name)) {
    return res.status(400).json({ ok: false, msg: '队列名只能包含字母、数字、下划线、点和中划线' });
  }
  const r = await cups.removePrinter(req.params.name);
  if (!r.ok) return res.status(400).json({ ok: false, msg: r.msg || '删除失败' });
  db.prepare('DELETE FROM settings WHERE key = ?').run(`printerNote:${req.params.name}`);
  printerstore.forget(req.params.name);
  logAudit('printer_delete', `queue=${req.params.name}`, sec.clientIp(req), 'admin');
  res.json({ ok: true, msg: '打印机已删除' });
});

// :name 会作为 lpadmin/cupsenable 的参数数组元素传入。虽然 execFile 不经 shell（无命令注入），
// 但以 '-' 开头的畸形名字会被当成命令行开关，统一白名单挡在入口
function badQueueName(name) {
  return !/^[A-Za-z0-9_.-]{1,60}$/.test(String(name || ''));
}

router.post('/printers/:name/default', requireAdmin, async (req, res) => {
  if (badQueueName(req.params.name)) return res.status(400).json({ ok: false, msg: '队列名只能包含字母、数字、下划线、点和中划线' });
  const r = await cups.setDefault(req.params.name);
  if (!r.ok) return res.status(400).json({ ok: false, msg: r.msg || '设置失败' });
  logAudit('printer_default', `queue=${req.params.name}`, sec.clientIp(req), 'admin');
  res.json({ ok: true, msg: '已设为默认打印机' });
});

router.post('/printers/:name/:action(pause|resume|reject|accept)', requireAdmin, async (req, res) => {
  if (badQueueName(req.params.name)) return res.status(400).json({ ok: false, msg: '队列名只能包含字母、数字、下划线、点和中划线' });
  const map = {
    pause: [cups.pausePrinter, '已暂停该队列'],
    resume: [cups.resumePrinter, '已恢复该队列'],
    reject: [cups.rejectJobs, '已停止接收新任务'],
    accept: [cups.acceptJobs, '已恢复接收任务']
  };
  const entry = map[req.params.action];
  const r = await entry[0](req.params.name);
  if (!r.ok) return res.status(400).json({ ok: false, msg: r.msg || '操作失败' });
  logAudit(`printer_${req.params.action}`, `queue=${req.params.name}`, sec.clientIp(req), 'admin');
  res.json({ ok: true, msg: entry[1] });
});

router.get('/printers/:name/options', requireAdmin, async (req, res) => {
  const list = await cups.listPrinters();
  if (!list.printers.some((p) => p.name === req.params.name)) {
    return res.status(404).json({ ok: false, msg: '打印机不存在' });
  }
  const data = await cups.printerOptions(req.params.name);
  res.json({ ok: data.ok, options: data.options, raw: data.raw });
});

// 发起打印页右栏用：驱动可选项 + 耗材余量 + 已装纸张
router.get('/printers/:name/detail', requirePrintAccess, async (req, res) => {
  const list = await cups.listPrinters();
  const p = list.printers.find((x) => x.name === req.params.name);
  if (!p) return res.status(404).json({ ok: false, msg: '打印机不存在' });
  const detail = await cups.printerDetail(req.params.name);
  res.json({ ok: true, printer: p, detail });
});

router.put('/printers/:name/note', requireAdmin, (req, res) => {
  if (badQueueName(req.params.name)) return res.status(400).json({ ok: false, msg: '队列名只能包含字母、数字、下划线、点和中划线' });
  const note = String((req.body || {}).note || '').slice(0, 200);
  db.prepare('INSERT INTO settings (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(`printerNote:${req.params.name}`, note);
  res.json({ ok: true, msg: '备注已保存' });
});

// 测试页
router.post('/printers/:name/test', requireAdmin, async (req, res) => {
  const name = req.params.name;
  const tmpDir = path.join(config.dataDir, 'tmp');
  fs.mkdirSync(tmpDir, { recursive: true });
  const file = path.join(tmpDir, `testpage-${Date.now()}.pdf`);
  fs.writeFileSync(file, buildTestPagePdf({ printer: name, time: new Date().toLocaleString('zh-CN') }));
  const r = await cups.submitJob({ printer: name, filePath: file, title: 'PrintGate 测试页', options: { copies: 1 } });
  // 60 秒后删本地临时测试页；删不掉登记 orphans 由清理任务兜底（不阻塞响应）
  setTimeout(() => {
    fsutil.safeUnlink(file, { label: '测试页' }).then((ok) => { if (!ok) orphans.add(file); });
  }, 60000);
  if (!r.ok) return res.status(400).json({ ok: false, msg: r.msg || '测试页发送失败' });
  logAudit('printer_test', `queue=${name} job=${r.jobId}`, sec.clientIp(req), 'admin');
  res.json({ ok: true, msg: `测试页已发送${r.jobId ? `（任务 ${r.jobId}）` : ''}` });
});

// ---------- 虚拟打印机（本机测试接收器） ----------
router.get('/printers/virtual/status', requireAdmin, (req, res) => {
  res.json({ ok: true, ...vprinter.status(), dir: vprinter.dir });
});

router.post('/printers/virtual', requireAdmin, async (req, res) => {
  const action = String((req.body || {}).action || 'create');
  if (action === 'stop') {
    db.prepare("INSERT INTO settings (key, value) VALUES ('virtualPrinter','0') ON CONFLICT(key) DO UPDATE SET value='0'").run();
    return res.json(vprinter.stop());
  }
  db.prepare("INSERT INTO settings (key, value) VALUES ('virtualPrinter','1') ON CONFLICT(key) DO UPDATE SET value='1'").run();
  const started = vprinter.start();
  if (!started.ok) return res.status(400).json({ ok: false, msg: started.msg });
  const name = String((req.body || {}).name || 'PrintGate-Virtual').replace(/[^A-Za-z0-9_.-]/g, '-').slice(0, 40);
  const existing = await cups.listPrinters();
  if (existing.printers.some((p) => p.name === name)) {
    return res.json({ ok: true, msg: `虚拟打印机 ${name} 已存在`, name, port: started.port });
  }
  const r = await cups.addPrinter({
    name, uri: 'socket://127.0.0.1:9100', model: 'raw',
    info: '虚拟打印机（PrintGate 内置测试接收器）', location: '本机', shared: false
  });
  if (!r.ok) return res.status(400).json({ ok: false, msg: r.msg || '创建队列失败' });
  printerstore.remember({
    name, uri: 'socket://127.0.0.1:9100', model: 'raw',
    info: '虚拟打印机（PrintGate 内置测试接收器）', location: '本机', shared: false
  });
  logAudit('vprinter_create', `queue=${name}`, sec.clientIp(req), 'admin');
  res.json({ ok: true, msg: `虚拟打印机 ${name} 已创建，打印结果会保存到数据目录 spool/`, name, port: started.port });
});

// ---------- 历史与存储清理 ----------
router.get('/printers/history', requireAdmin, async (req, res) => {
  const [s, st] = await Promise.all([cleanup.stats(), cups.status()]);
  res.json({
    ok: true,
    stats: s,
    cups: st,
    settings: { autoCleanHistory: cfg().autoCleanHistory, historyDays: cfg().historyDays, auditRetentionDays: cfg().auditRetentionDays }
  });
});

router.post('/printers/history/clean', requireAdmin, sec.rateLimit({ key: 'clean', windowMs: 60000, max: 12 }), async (req, res) => {
  const b = req.body || {};
  const days = Number(b.days);
  if (!Number.isFinite(days) || days < 0 || days > 3650) {
    return res.status(400).json({ ok: false, msg: '保留天数需在 0-3650 之间（0 表示全部历史）' });
  }
  const targets = Array.isArray(b.targets) && b.targets.length ? b.targets : cleanup.ALL_TARGETS.slice();
  const bad = targets.filter((t) => !cleanup.ALL_TARGETS.includes(t));
  if (bad.length) return res.status(400).json({ ok: false, msg: `未知的清理项：${bad.join(', ')}` });

  const opts = { days, targets };
  // 审计日志可随手动清理一并裁剪（0 或不传表示不裁剪），避免 audit 表无限增长
  const auditDays = Number(b.auditDays);
  if (Number.isFinite(auditDays) && auditDays >= 0 && auditDays <= 3650) opts.auditDays = auditDays;

  const r = await cleanup.clean(opts);
  const parts = [];
  if (r.tasks) parts.push(`${r.tasks.removed} 条任务记录`);
  if (r.cups) parts.push(`${r.cups.removed} 个 CUPS 作业`);
  if (r.spool) parts.push(`${r.spool.removed} 个落盘文件`);
  if (r.files) parts.push(`${r.files.removed} 个源文件`);
  if (r.scans) parts.push(`${r.scans.removed} 条扫描记录`);
  // 小于 1MB 时用 KB/B，避免出现「释放 0.0 MB」这种看起来像没生效的文案
  const freedText = r.freed >= 1024 * 1024
    ? `${(r.freed / 1024 / 1024).toFixed(1)} MB`
    : r.freed >= 1024 ? `${Math.round(r.freed / 1024)} KB` : `${r.freed} B`;
  const msg = parts.length ? `已清理 ${parts.join('、')}${r.freed ? `，释放 ${freedText}` : ''}` : '没有需要清理的内容';

  logAudit('cleanup', `manual days=${days} targets=${targets.join(',')} tasks=${r.tasks?.removed || 0} cups=${r.cups?.removed || 0}`
    + ` spool=${r.spool?.removed || 0} files=${r.files?.removed || 0} scans=${r.scans?.removed || 0} freed=${Math.round(r.freed / 1024)}KB`,
    sec.clientIp(req), 'admin');
  res.json({ ok: true, result: r, msg });
});

router.put('/printers/history/auto', requireAdmin, (req, res) => {
  const b = req.body || {};
  const updates = {};
  if (b.autoCleanHistory !== undefined) updates.autoCleanHistory = b.autoCleanHistory ? '1' : '0';
  if (b.historyDays !== undefined) {
    const d = parseInt(b.historyDays, 10);
    if (!Number.isFinite(d) || d < 0 || d > 3650) {
      return res.status(400).json({ ok: false, msg: '历史保留天数需在 0-3650 之间' });
    }
    updates.historyDays = d;
  }
  if (b.auditRetentionDays !== undefined) {
    const d = parseInt(b.auditRetentionDays, 10);
    if (!Number.isFinite(d) || d < 0 || d > 3650) {
      return res.status(400).json({ ok: false, msg: '审计保留天数需在 0-3650 之间（0 表示永久保留）' });
    }
    updates.auditRetentionDays = d;
  }
  if (!Object.keys(updates).length) return res.status(400).json({ ok: false, msg: '没有需要保存的设置' });
  setSettings(updates);
  logAudit('history_auto', Object.entries(updates).map(([k, v]) => `${k}=${v}`).join(' '), sec.clientIp(req), 'admin');
  res.json({
    ok: true,
    msg: '自动清理设置已保存',
    settings: { autoCleanHistory: cfg().autoCleanHistory, historyDays: cfg().historyDays }
  });
});

// ---------- 自动扫描打印机 ----------
// 限流：每次扫描是一个最长 180s 的会话（最多 6 网段 × 1022 主机、48 并发），
// 不限流的话反复触发会同时堆多个会话，把文件描述符和 CPU 打满
router.post('/printers/discover/start', requireAdmin, sec.rateLimit({ key: 'discover', windowMs: 60000, max: 6 }), async (req, res) => {
  const { mode = 'quick', cidr = '' } = req.body || {};
  const s = await discover.runScan({ mode, cidr });
  // 并发锁命中：已有扫描进行中，拒绝新建（避免叠加多个 180s 会话打爆 FD/CPU）
  if (s.alreadyRunning) {
    return res.status(409).json({ ok: false, msg: '已有扫描任务进行中，请等待其完成后重试', id: s.id });
  }
  res.json({
    ok: true,
    id: s.id,
    localSubnets: discover.localSubnets(),
    commonCidrs: discover.COMMON_CIDRS,
    savedCidr: getSetting('discoverCidr', '')
  });
});

// 保存扫描网段：桥接网络下容器只看得到 Docker 内网，必须由用户指定局域网网段
router.post('/printers/discover/cidr', requireAdmin, (req, res) => {
  const r = discover.saveCidr(String((req.body || {}).cidr || ''));
  if (!r.ok) return res.status(400).json({ ok: false, msg: r.msg });
  logAudit('discover_cidr', `cidr=${r.cidr}`, sec.clientIp(req), 'admin');
  res.json({ ok: true, cidr: r.cidr });
});

// 手动探测单个地址：扫描不到时的补救入口（直接给 IP 就能识别型号并推荐驱动）
router.post('/printers/discover/probe', requireAdmin, sec.rateLimit({ key: 'probe', windowMs: 60000, max: 30 }), async (req, res) => {
  const host = String((req.body || {}).host || '').trim();
  const r = await discover.probeOne(host);
  if (!r.ok) return res.status(400).json({ ok: false, msg: r.msg });
  res.json({ ok: true, device: r.device });
});

router.get('/printers/discover/subnets', requireAdmin, (req, res) => {
  res.json({
    ok: true,
    subnets: discover.localSubnets(),
    commonCidrs: discover.COMMON_CIDRS,
    savedCidr: getSetting('discoverCidr', '')
  });
});

router.get('/printers/discover/:id', requireAdmin, (req, res) => {
  const s = discover.getSession(req.params.id);
  if (!s) return res.status(404).json({ ok: false, msg: '扫描任务不存在或已过期' });
  res.json({
    ok: true,
    status: s.status, progress: s.progress, stage: s.stage,
    found: s.found, error: s.error, total: s.total, scanned: s.scanned,
    elapsed: Math.round(((s.finishedAt || Date.now()) - s.startedAt) / 1000)
  });
});

// ---------- 扫描仪 ----------
router.get('/scanners', requireAdmin, async (req, res) => {
  // force=1 时跳过缓存重新枚举（页面点「重新检测」用）
  const data = await scan.listDevices(req.query.force === '1');
  const records = db.prepare('SELECT id, device, filename, size, pages, created_at FROM scan_records ORDER BY id DESC LIMIT 30').all();
  res.json({ ok: true, ...data, records });
});

// 扫描链路自检：组件版本 / USB 总线是否可见 / SANE 认到的设备，给排障用
router.get('/scanners/diag', requireAdmin, async (req, res) => {
  const [v, usb, list] = await Promise.all([scan.version(), scan.findUsb(), scan.listDevices(true)]);
  res.json({
    ok: true,
    saneInstalled: v.ok,
    version: v.version,
    usb: usb.hits,
    devices: list.devices || [],
    msg: !v.ok ? scan.HINT_INSTALL : (!(list.devices || []).length ? (usb.hits.length ? scan.HINT_DRIVER : scan.HINT_USB) : ''),
    hints: {
      install: 'apk add --no-cache sane sane-utils sane-network（需先启用 community 仓库）',
      usb: 'docker run --device /dev/bus/usb ... 或 compose 的 devices: - /dev/bus/usb:/dev/bus/usb',
      network: '网络一体机安装 sane-airscan 并在「网络扫描仪」里填 IP；或把容器改成 network_mode: host（仅 Linux）'
    },
    airscan: { conf: scan.AIRSCAN_CONF, devices: scan.readAirscanConf() },
    network: scan.netInfo()
  });
});

// SANE 设备名形如 epson2:libusb:001:004 / airscan:e0:Canon TR4700，
// 只允许这些字符，挡掉 ../ 与 shell 元字符（设备名最终会进 argv）
function safeDeviceName(v) {
  const s = String(v || '');
  return /^[A-Za-z0-9._:+@=-]{1,200}$/.test(s) ? s : '';
}

// ---------- 网络扫描仪（sane-airscan） ----------
// 桥接网络下 mDNS 过不来，这里让用户手填 IP，写进 airscan.conf 后 scanimage 就能认出设备。
router.get('/scanners/network', requireAdmin, (req, res) => {
  res.json({ ok: true, conf: scan.AIRSCAN_CONF, devices: scan.readAirscanConf(), network: scan.netInfo() });
});

// 只探测连通性，不落盘
router.post('/scanners/network/probe', requireAdmin, sec.rateLimit({ key: 'scanprobe', windowMs: 60000, max: 20 }), async (req, res) => {
  const host = String((req.body || {}).host || '').trim();
  if (!host) return res.status(400).json({ ok: false, msg: '请填写一体机的 IP 或 IP:端口' });
  const r = await scan.probeNetwork(host);
  res.json(r);
});

router.post('/scanners/network', requireAdmin, async (req, res) => {
  const b = req.body || {};
  const name = String(b.name || '').trim().slice(0, 40);
  const host = String(b.host || '').trim();
  if (!name) return res.status(400).json({ ok: false, msg: '给这台扫描仪起个名字（会显示在设备列表里）' });
  if (!host) return res.status(400).json({ ok: false, msg: '请填写一体机的 IP 或 IP:端口' });
  const probe = await scan.probeNetwork(host);
  // 探测不通也允许强制写入：老机型只支持 WSD / 厂商私有协议，
  // HTTP 探测不到不代表 airscan 扫不出来，让用户自己决定。
  const force = !!b.force;
  if (!probe.ok && !force) return res.status(400).json({ ok: false, msg: probe.msg, url: probe.url, canForce: true, steps: probe.steps || [], ports: probe.ports || [] });
  const target = probe.ok ? probe.url : scan.normalizeHost(host);
  if (!target) return res.status(400).json({ ok: false, msg: '地址格式不对' });
  const devices = scan.addNetworkScanner(name, target);
  // 立刻重新枚举，把结果一并返回，页面不用再点一次「重新检测」
  const list = await scan.listDevices(true);
  logAudit('scan_add_network', `name=${name} url=${probe.url}`, sec.clientIp(req), 'admin');
  res.json({ ok: true, msg: `已添加「${name}」`, devices, scan: list });
});

router.delete('/scanners/network/:name', requireAdmin, (req, res) => {
  const name = String(req.params.name || '').trim();
  if (!name) return res.status(400).json({ ok: false, msg: '缺少名称' });
  const devices = scan.removeNetworkScanner(name);
  logAudit('scan_del_network', `name=${name}`, sec.clientIp(req), 'admin');
  res.json({ ok: true, msg: `已移除「${name}」`, devices });
});

router.get('/scanners/:device/options', requireAdmin, async (req, res) => {
  const device = safeDeviceName(decodeURIComponent(req.params.device || ''));
  if (!device) return res.status(400).json({ ok: false, msg: '扫描设备名不合法', options: [] });
  const data = await scan.deviceOptions(device);
  res.json(data);
});

// 设备自检：只打开设备读参数（--test），不真正扫描；顺带列出 mDNS 发现到的真实地址
router.get('/scanners/:device/selftest', requireAdmin, async (req, res) => {
  const device = safeDeviceName(decodeURIComponent(req.params.device || ''));
  if (!device) return res.status(400).json({ ok: false, msg: '扫描设备名不合法' });
  const r = await scan.deviceSelfTest(device);
  res.json(r);
});

router.post('/scanners/scan', requireAdmin, sec.rateLimit({ key: 'scan', windowMs: 60000, max: 12 }), async (req, res) => {
  const { device, resolution = 300, mode = 'Color', source = '', format = 'jpeg', pages = 1 } = req.body || {};
  // 设备名必须是本次枚举出来的，避免拼一个任意字符串去驱动底层
  if (!safeDeviceName(device)) return res.status(400).json({ ok: false, msg: '扫描设备名不合法' });
  const known = (await scan.listDevices()).devices || [];
  if (!known.some((d) => d.device === String(device))) {
    return res.status(400).json({ ok: false, msg: '不是已识别的扫描设备，请重新检测后再扫描' });
  }
  const r = await scan.scan({ device, resolution, mode, source, format, pages });
  if (!r.ok) return res.status(400).json({ ok: false, msg: r.msg || '扫描失败' });
  const saved = r.files.map((f) => {
    const info = db.prepare('INSERT INTO scan_records (device, filename, storage_path, size, pages, created_at) VALUES (?,?,?,?,?,?)')
      .run(String(device), f.filename, f.path, f.size, 1, nowISO());
    return { id: info.lastInsertRowid, filename: f.filename, size: f.size, mime: f.mime };
  });
  logAudit('scan', `device=${device} files=${saved.length}`, sec.clientIp(req), 'admin');
  res.json({ ok: true, files: saved, note: r.note || '' });
});

router.get('/scanners/records/:id/download', requireAdmin, (req, res) => {
  const row = db.prepare('SELECT * FROM scan_records WHERE id = ?').get(req.params.id);
  if (!row || !fs.existsSync(row.storage_path)) return res.status(404).json({ ok: false, msg: '文件不存在' });
  res.download(row.storage_path, row.filename);
});

router.delete('/scanners/records/:id', requireAdmin, async (req, res) => {
  try {
    const row = db.prepare('SELECT * FROM scan_records WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ ok: false, msg: '记录不存在' });
    // 与文件删除同一条不变量：磁盘没删干净就不删记录，避免「界面说删了、文件还在」
    const ok = await fsutil.safeUnlink(row.storage_path, { label: '删扫描记录' });
    if (!ok) return res.status(500).json({ ok: false, msg: '文件暂时无法删除（可能被其他程序占用），请稍后重试' });
    db.prepare('DELETE FROM scan_records WHERE id = ?').run(row.id);
    res.json({ ok: true, msg: '已删除' });
  } catch (e) {
    res.status(500).json({ ok: false, msg: '删除失败：' + e.message });
  }
});

module.exports = router;
