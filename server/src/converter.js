'use strict';
// Office 文档转换（可选组件）：容器内装了 libreoffice 才会启用，否则明确提示
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const cups = require('./cups');

let cached = null;

const HINT = '当前镜像没有内置 Office 转换（构建时用了 WITH_OFFICE=0）。两种解决方式：'
  + '① 用默认参数重新构建镜像（默认已包含 LibreOffice）；'
  + '② 或上传前先把 docx/xlsx/pptx 转成 PDF';

async function detect(force = false) {
  if (!force && cached && Date.now() - cached.at < 60000) return cached;
  let bin = '';
  for (const candidate of ['libreoffice', 'soffice']) {
    const r = await cups.run('which', [candidate], { timeout: 3000 });
    if (r.ok && r.stdout.trim()) { bin = r.stdout.trim(); break; }
  }
  let version = '';
  if (bin) {
    const v = await cups.run(bin, ['--version'], { timeout: 10000 });
    version = String(v.stdout || '').trim().split(/\r?\n/)[0];
  }
  cached = { at: Date.now(), available: !!bin, bin, version, hint: bin ? '' : HINT };
  return cached;
}

// ---------- 按需安装（镜像精简 + 数据卷持久化 + 进度上报） ----------
// 主镜像不带 LibreOffice（省 ~1GB），需要时后台点一下按钮在容器内安装。
// 但装在容器可写层的东西，一旦「换镜像重建容器」就全没了 —— 每次升级都要重装一次。
// 所以把 apk 包缓存到数据卷：/data/office/pkgs/*.apk
//   · 安装时先 apk fetch -R 把全部依赖下载到数据卷，再从本地包装（离线可重复）
//   · 容器启动时若发现 soffice 不在、但数据卷有缓存 → 后台自动离线重装（约 30 秒）
//   · 数据卷没清就不用联网，也不用重新点「一键安装」
const { spawn } = require('child_process');
const cfg = require('./config');

const PACKAGES = ['libreoffice-writer', 'libreoffice-calc', 'libreoffice-impress'];
const OFFICE_DIR = path.join(cfg.dataDir, 'office');
const PKG_DIR = path.join(OFFICE_DIR, 'pkgs');
const META_PATH = path.join(OFFICE_DIR, 'meta.json');

// 进度阶段 → 百分比区间：下载 0-40，安装 40-92，校验 92-100
const RANGE = { download: [0, 40], install: [40, 92], verify: [92, 100] };

function state() {
  return {
    running: false, phase: '', percent: 0, done: 0, total: 0,
    startedAt: 0, finishedAt: 0, ok: null, msg: '', log: ''
  };
}
let install = state();   // 用户点「一键安装」触发的
let restore = state();   // 换镜像后启动时自动恢复

function readMeta() {
  try { return JSON.parse(fs.readFileSync(META_PATH, 'utf8')); } catch (_) { return null; }
}

function cacheInfo() {
  let count = 0, bytes = 0;
  try {
    for (const n of fs.readdirSync(PKG_DIR)) {
      if (!n.endsWith('.apk')) continue;
      count++;
      try { bytes += fs.statSync(path.join(PKG_DIR, n)).size; } catch (_) {}
    }
  } catch (_) {}
  const meta = readMeta();
  return { count, bytes, savedAt: (meta && meta.savedAt) || 0, packages: (meta && meta.packages) || [] };
}

function canInstall() {
  return typeof process.getuid === 'function' ? process.getuid() === 0 : false;
}

// 统一的对外状态：优先报「正在进行的那个」任务，附带缓存信息
function installStatus() {
  const active = install.running ? install : (restore.running ? restore : (install.finishedAt >= restore.finishedAt ? install : restore));
  const cache = cacheInfo();
  return {
    ...active,
    restoring: !!restore.running,
    packages: PACKAGES,
    canInstall: canInstall(),
    cache: { count: cache.count, bytes: cache.bytes, savedAt: cache.savedAt, missingMain: missingMainPkgs() },
    elapsedMs: active.startedAt ? (active.finishedAt || Date.now()) - active.startedAt : 0
  };
}

// spawn + 逐行回调：apk 的进度在 stderr 上，execFile 拿不到中间态
function runStream(cmd, args, { onLine, timeout = 1200000 } = {}) {
  return new Promise((resolve) => {
    let out = '', err = '', done = false;
    let child;
    try {
      child = spawn(cmd, args, { env: process.env });
    } catch (e) {
      return resolve({ ok: false, code: 1, stdout: '', stderr: String(e.message || e) });
    }
    const timer = setTimeout(() => {
      if (done) return;
      try { child.kill('SIGKILL'); } catch (_) {}
    }, timeout);
    const feed = (buf, keep) => {
      const s = buf.toString();
      if (keep === 'err') err += s; else out += s;
      if (!onLine) return;
      for (const line of s.split(/\r?\n/)) {
        const t = line.trim();
        if (t) { try { onLine(t); } catch (_) {} }
      }
    };
    child.stdout.on('data', (c) => feed(c, 'out'));
    child.stderr.on('data', (c) => feed(c, 'err'));
    child.on('error', (e) => {
      done = true; clearTimeout(timer);
      resolve({ ok: false, code: 1, stdout: out, stderr: `${err}\n${e.message || e}` });
    });
    child.on('close', (code) => {
      done = true; clearTimeout(timer);
      resolve({ ok: code === 0, code, stdout: out, stderr: err });
    });
  });
}

function setPercent(st, phase, ratio) {
  const [lo, hi] = RANGE[phase] || [0, 100];
  const r = Math.max(0, Math.min(1, ratio));
  st.phase = phase;
  st.percent = Math.min(hi, Math.round(lo + (hi - lo) * r));
}

// 下载阶段：apk fetch 的输出格式各版本不一，直接盯数据卷里的 .apk 数量最可靠
function watchFetch(st, expected) {
  const timer = setInterval(() => {
    if (!st.running) return clearInterval(timer);
    const n = cacheInfo().count;
    st.done = n;
    // apk fetch --simulate 只列直接依赖，实际会拉全部传递依赖（数量更多），
    // 所以总数取两者较大值，进度封顶在 39%——真正的百分比交给后面的安装阶段（apk 会打 (n/m)）
    st.total = Math.max(expected || 0, n);
    const ratio = st.total ? n / st.total : 0;
    st.phase = 'download';
    st.percent = expected ? Math.min(39, Math.max(1, Math.round(39 * ratio))) : Math.min(39, 5 + Math.round(n / 6));
  }, 800);
  return () => clearInterval(timer);
}

// 镜像为了省体积把 /var/cache/apk 删了，apk 没有索引会直接报 no such package。
// 安装前先 apk update 一次把它建起来（约 5-15 秒），之后 fetch/add 才认得包名。
let indexReady = false;
async function ensureIndex() {
  if (indexReady) return true;
  const r = await cups.run('apk', ['update', '--no-progress'], { timeout: 45000 });
  indexReady = r.ok;
  return r.ok;
}

// apk fetch 的输出是 `Downloading <包名-版本-rN>`（不是纯包名），各版本还可能只印包名，
// 两种都认；别写成「行首就是包名」，否则一条都匹配不上，完整性判断会静默失效
const PKG_LINE = /^[a-z0-9][\w.+-]*-[\d][^\s]*-r\d+$/;

function pkgNameOf(line) {
  const t = line.trim().replace(/^Downloading\s+/i, '').replace(/\.apk$/i, '').trim();
  return PKG_LINE.test(t) ? t : '';
}

async function expectedFetchCount(pkgs = PACKAGES) {
  await ensureIndex();
  const sim = await cups.run('apk', ['fetch', '-R', '--simulate', ...pkgs], { timeout: 120000 });
  const n = `${sim.stdout || ''}\n${sim.stderr || ''}`.split(/\r?\n/).filter((l) => pkgNameOf(l)).length;
  return n > 5 ? n : 0;
}

// 完整包清单（含传递依赖）：判断「缓存能不能离线装出完整组件」的唯一依据。
// 只数 .apk 文件个数是不够的 —— 有 151 个依赖、独独缺 395MB 的 libreoffice-common 时，
// 装到一半 apk 会去联网补、网络一抖就整体回滚，用户看到进度条倒退。
async function remotePkgNames(pkgs = PACKAGES) {
  await ensureIndex();
  const sim = await cups.run('apk', ['fetch', '-R', '--simulate', ...pkgs], { timeout: 120000 });
  const out = new Set();
  for (const line of `${sim.stdout || ''}\n${sim.stderr || ''}`.split(/\r?\n/)) {
    const name = pkgNameOf(line);
    if (name) out.add(name);
  }
  return [...out];
}

function cacheMissingNames(names) {
  let have = [];
  try { have = fs.readdirSync(PKG_DIR).filter((n) => n.endsWith('.apk')); } catch (_) { return names; }
  const has = new Set(have.map((n) => n.replace(/\.apk$/, '')));
  return names.filter((n) => !has.has(n));
}

function listLocalPkgs() {
  try {
    return fs.readdirSync(PKG_DIR)
      .filter((n) => n.endsWith('.apk'))
      .map((n) => path.join(PKG_DIR, n));
  } catch (_) { return []; }
}

// 主包 = writer/calc/impress。缓存里只数依赖包不够：真正决定能不能转换的是这三个。
// （踩过：apk fetch 被超时中断时只下到 calc，依赖全在、主包缺两个，
//   addFromLocal 装完 which soffice 有、转换直接 abort，谁也看不出缺东西）
function localPkgFor(name) {
  try {
    return fs.readdirSync(PKG_DIR).filter((n) => n.endsWith('.apk') && n.startsWith(`${name}-`));
  } catch (_) { return []; }
}

function missingMainPkgs() {
  return PACKAGES.filter((p) => !localPkgFor(p).length);
}

// 已安装校验：apk info -e 返回 0 表示该包已装（比 which soffice 更能反映真实完整性）
async function missingInstalled() {
  const miss = [];
  for (const p of PACKAGES) {
    const r = await cups.run('apk', ['info', '-e', p], { timeout: 15000 });
    if (!r.ok) miss.push(p);
  }
  return miss;
}

// 该有哪些包：优先问仓库（能发现新增依赖），离线时退回 meta.json 里上次记下的清单，
// 否则「离线恢复」会因为拿不到清单而误判缓存完整。
async function requiredNames() {
  const remote = await remotePkgNames();
  if (remote.length) return remote;
  const meta = readMeta();
  return (meta && Array.isArray(meta.names)) ? meta.names : [];
}

// 从数据卷里的本地包装（离线）；失败返回 null 交给网络安装
async function addFromLocal(st) {  const files = listLocalPkgs();
  if (!files.length) return null;
  const r = await runStream('apk', ['add', '--no-cache', '--allow-untrusted', ...files], {
    onLine(line) {
      const m = line.match(/\((\d+)\/(\d+)\)\s+(?:Installing|Upgrading|Replacing)/);
      if (m) {
        st.done = Number(m[1]);
        st.total = Number(m[2]);
        setPercent(st, 'install', st.done / Math.max(1, st.total));
      }
    }
  });
  st.log = `${r.stdout}\n${r.stderr}`.trim();
  return r.ok ? r : null;
}

// 下载：先把 targets 整包拉下来，再逐个补缺的主包。
// 踩过的坑：apk fetch 15 分钟硬超时被掐断，151 个依赖包下完、writer/impress 还没轮到，
// 装出来 which soffice 有、一转换就 abort —— 主包必须逐个补齐并校验。
async function downloadPackages(st) {
  try { fs.mkdirSync(PKG_DIR, { recursive: true }); } catch (_) {}
  await ensureIndex();
  const names = await requiredNames();
  let miss = cacheMissingNames(names);
  st.total = names.length;
  st.done = names.length - miss.length;
  if (!miss.length) { st.phase = 'download'; st.percent = 40; return { ok: true, missing: [] }; }
  let r = null;
  if (miss.length > 5) {
    // 缺得多（首次安装）→ 整包拉一次，apk 自己会并发下载
    const stop = watchFetch(st, names.length);
    try {
      r = await cups.run('apk', ['fetch', '-R', '--no-cache', '-o', PKG_DIR, ...PACKAGES], { timeout: 3600000 });
    } finally { stop(); }
    miss = cacheMissingNames(names);
  }
  // 剩下缺的单个下（不带 -R：递归会把已有的几十个依赖重下一遍，白等十几分钟）
  for (let attempt = 0; attempt < 3 && miss.length; attempt++) {
    for (const n of miss) {
      await cups.run('apk', ['fetch', '--no-cache', '-o', PKG_DIR, n], { timeout: 1200000 });
    }
    miss = cacheMissingNames(names);
  }
  st.phase = 'download';
  st.done = names.length - miss.length;
  st.total = Math.max(st.total || 0, st.done);
  st.percent = miss.length ? Math.min(38, st.percent) : 40;
  return { ...(r || {}), ok: !miss.length, missing: miss };
}

async function verifyOffice(st) {
  setPercent(st, 'verify', 0.2);
  cached = null;
  const conv = await detect(true);
  // which 找到 soffice 不代表能转换：writer 过滤器缺失时照样 abort
  const miss = conv.available ? await missingInstalled() : PACKAGES.slice();
  setPercent(st, 'verify', miss.length ? 0.6 : 1);
  st.log = `${st.log}\n${conv.version || '未检测到 soffice'}${miss.length ? '（缺 ' + miss.join('/') + '）' : ''}`.trim();
  return { ...conv, missing: miss };
}

// 一次完整安装：fetch → 本地装 → 校验 → 记 meta
async function doInstall(st, { useCacheFirst = true } = {}) {
  // 缓存里缺件（旧版本曾把下载被掐断的残件留在数据卷）→ 先补齐，别拿残件去装
  if (useCacheFirst && listLocalPkgs().length) {
    const names = await requiredNames();
    if (cacheMissingNames(names).length) await downloadPackages(st);
  }
  const local = useCacheFirst ? await addFromLocal(st) : null;
  if (!local) {
    const f = await downloadPackages(st);
    if (f.missing && f.missing.length) {
      st.ok = false;
      st.msg = `下载不完整：还缺 ${f.missing.length} 个包（网络中断时会出现），请重试或改用 WITH_OFFICE=1 的镜像`;
      st.log = `${st.log}\n${f.stderr || f.error || ''}`.slice(-4000);
      return false;
    }
    const r = await addFromLocal(st);
    if (!r) {
      // 本地包不完整（例如换镜像后仓库版本变了）→ 回退到联网安装
      st.phase = 'install';
      const net = await cups.run('apk', ['add', '-U', '--no-cache', '--no-progress', ...PACKAGES], { timeout: 900000 });
      st.log = `${st.log}\n${String(net.stdout || '').slice(-2000)}\n${String(net.stderr || '').slice(-2000)}`.trim();
      if (!net.ok) { st.ok = false; st.msg = '安装失败（详见日志）'; return false; }
    }
  }
  const conv = await verifyOffice(st);
  if (!conv.available) {
    st.ok = false;
    st.msg = '包装完了但 soffice 仍不可用，请查看日志';
    return false;
  }
  if (conv.missing && conv.missing.length) {
    st.ok = false;
    st.msg = `安装不完整（缺 ${conv.missing.join('、')}），转换会失败，请重试`;
    return false;
  }
  try {
    fs.writeFileSync(META_PATH, JSON.stringify({
      savedAt: Date.now(), packages: PACKAGES, version: conv.version || '',
      names: await requiredNames()
    }, null, 2));
  } catch (_) {}
  st.percent = 100;
  st.phase = 'done';
  st.ok = true;
  st.msg = `安装完成：${conv.version || 'LibreOffice 已可用'}`;
  backfillCache();   // 后台补齐缓存，保证下次换镜像能离线恢复
  return true;
}

// 装成功时，有些依赖是 apk add 现场联网补的（典型是 395MB 的 libreoffice-common），
// 缓存里没有它们 → 换镜像「离线恢复」就会失败。这里在后台把缺的包补进数据卷，不阻塞安装结果。
let backfilling = false;
async function backfillCache() {
  if (backfilling) return;
  backfilling = true;
  try {
    await ensureIndex();
    const names = await requiredNames();
    let miss = cacheMissingNames(names);
    for (let attempt = 0; attempt < 2 && miss.length; attempt++) {
      for (const n of miss) {
        await cups.run('apk', ['fetch', '--no-cache', '-o', PKG_DIR, n], { timeout: 1800000 });
      }
      miss = cacheMissingNames(names);
    }
    if (!miss.length) {
      try {
        const meta = readMeta() || {};
        meta.savedAt = Date.now();
        meta.packages = PACKAGES;
        fs.writeFileSync(META_PATH, JSON.stringify(meta, null, 2));
      } catch (_) {}
    }
  } catch (_) {
    // 补缓存失败不影响已装好的组件，下次点安装时会再补
  } finally {
    backfilling = false;
  }
}

function startTask(st, label, phase = 'download') {
  st.running = true;
  st.phase = phase;
  st.percent = 0;
  st.done = 0;
  st.total = 0;
  st.ok = null;
  st.msg = '';
  st.log = '';
  st.startedAt = Date.now();
  st.finishedAt = 0;
  // 不 await：装 300 个包要几分钟，接口先返回，页面轮询
  (async () => {
    try { await doInstall(st); } catch (e) {
      st.ok = false;
      st.msg = `安装异常：${e.message || e}`;
      st.log = `${st.log}\n${e.stack || ''}`.slice(-4000);
    } finally {
      st.running = false;
      st.finishedAt = Date.now();
      cached = null;
      await detect(true).catch(() => {});
    }
  })();
  return { ok: true, msg: label, started: true };
}

async function installOffice() {
  if (install.running) return { ok: false, msg: '安装正在进行中，请稍候' };
  if (restore.running) return { ok: false, msg: '正在从数据卷恢复组件，请稍候' };
  if (!canInstall()) {
    return { ok: false, msg: '当前进程不是 root，无法在容器内安装；请用 WITH_OFFICE=1 构建的镜像，或宿主机手动 apk add' };
  }
  if (cached && cached.available) return { ok: true, msg: '已经安装过了', available: true };
  const conv = await detect(true);
  if (conv.available) return { ok: true, msg: '镜像里已内置 Office 组件', available: true };

  const info = cacheInfo();
  const miss = info.count ? cacheMissingNames(await requiredNames()) : [];
  const msg = miss.length
    ? `数据卷缓存缺 ${miss.length} 个包，已开始补齐并安装（约 3-5 分钟，取决于网速）`
    : `已从数据卷找到 ${info.count} 个安装包，开始离线安装（约 1-2 分钟）`;
  install = state();
  return startTask(install, msg);
}

// 换镜像重建容器后调用：数据卷里有缓存就自动装回去，用户不用再点一次
async function restoreIfCached() {
  if (install.running || restore.running) return { ok: false, msg: '正在安装/恢复中' };
  const conv = await detect(true);
  if (conv.available) return { ok: true, msg: '镜像已内置 Office 组件，无需恢复' };
  const info = cacheInfo();
  if (!info.count) return { ok: false, msg: '数据卷里没有安装缓存' };
  const miss = cacheMissingNames(await requiredNames());
  if (miss.length) {
    // 缓存残缺（旧版本曾把下载超时的残件写进数据卷）→ 别自动恢复成半残组件
    const brief = miss.slice(0, 3).join('、') + (miss.length > 3 ? ` 等 ${miss.length} 个包` : '');
    return { ok: false, msg: `数据卷缓存不完整（缺 ${brief}），请点「一键安装」联网补齐` };
  }
  restore = state();
  return startTask(restore, `正在从数据卷恢复 Office 组件（${info.count} 个包）`, 'install');
}

// 清缓存：确认镜像已内置、或不再需要 Office 时释放数据卷空间
function clearCache() {
  if (install.running || restore.running) return { ok: false, msg: '任务进行中，稍后再清理' };
  try {
    fs.rmSync(PKG_DIR, { recursive: true, force: true });
    fs.rmSync(META_PATH, { force: true });
    return { ok: true, msg: '已清理安装缓存', cache: cacheInfo() };
  } catch (e) {
    return { ok: false, msg: `清理失败：${e.message}` };
  }
}


// LibreOffice 同一个用户配置目录不能并发转换（第二个进程会静默失败），
// 每次转换用独立的临时 profile，用完即删（不删的话 /tmp 会被 lo-profile-* 堆满）
function profileArgs() {
  const dir = path.join(require('os').tmpdir(), `lo-profile-${crypto.randomBytes(4).toString('hex')}`);
  return { args: [`-env:UserInstallation=file://${dir.replace(/\\/g, '/')}`, '-headless', '-norestore'], dir };
}

async function convertToPdf(inputPath, outDir) {
  const d = await detect();
  if (!d.available) throw new Error(HINT);
  fs.mkdirSync(outDir, { recursive: true });
  const { args: pArgs, dir: pDir } = profileArgs();
  const base = path.basename(inputPath).replace(/\.[^.]+$/, '.pdf');
  const out = path.join(outDir, base);
  let r;
  try {
    r = await cups.run(d.bin, [...pArgs, '--convert-to', 'pdf', '--outdir', outDir, inputPath], { timeout: 180000 });
  } finally {
    // 转换进程已退出，profile 可以安全删除；删不掉只是留一个临时目录，不阻塞主流程
    try { fs.rmSync(pDir, { recursive: true, force: true }); } catch (_) {}
  }
  // 转换进程退出码为 0 但没产出文件时，多半是文档本身打不开
  if (!r.ok || !fs.existsSync(out)) {
    // stderr 里常混着 "-headless is deprecated" 这类警告，过滤掉只留真正的错误
    const detail = String(r.stderr || r.error || '')
      .split(/[\r\n]+/)
      .filter((l) => l.trim() && !/^\s*Warning:/i.test(l))
      .join('；')
      .trim()
      .slice(0, 160);
    throw new Error(detail ? `转换失败：${detail}` : `转换失败：文档可能已损坏或为加密文档，无法生成 PDF`);
  }
  return out;
}

module.exports = {
  installOffice, installStatus, restoreIfCached, clearCache, PACKAGES, detect, convertToPdf, HINT };
