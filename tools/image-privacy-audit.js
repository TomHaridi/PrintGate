'use strict';
// 审计已发布镜像里是否混入了隐私数据（数据库、日志、密钥、测试账号等）
// 用法：node tools/image-privacy-audit.js 2.2.2 2.2.1 2.2.0 2.1.1 2.1.0 2.0.1 2.0.0
// 做法：docker create + docker export 展平 rootfs → 只看文件清单 + 抽取敏感目录做内容扫描，无需启动容器
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tags = process.argv.slice(2);
if (!tags.length) { console.error('用法: node tools/image-privacy-audit.js <tag> [tag...]'); process.exit(1); }

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-audit-'));

// 文件名层面就该报警的（有则说明把本地数据打进了镜像）
const BAD_FILE = [
  /(^|\/)printgate\.db/i, /\.db($|-wal$|-shm$)/i, /\.sqlite\d?$/i,
  /(^|\/)\.env(\.|$)/i, /\.pem$/i, /(^|\/)id_rsa/i, /\.key$/i,
  /(^|\/)\.git\//i, /(^|\/)_data/i, /(^|\/)_logs/i, /\.log$/i,
  /cupsd\.pid/i, /(^|\/)printers\.conf$/i, /(^|\/)passwd$/i, /(^|\/)shadow$/i
];
// 这些是镜像本来就该有的（CUPS 基线配置），单独放行
const ALLOW = [/(^|\/)etc\/cups\/(cups-files\.conf|cupsd\.conf|mime\.|snmp\.conf|client\.conf|ppd\/)/i, /(^|\/)package-lock\.json$/];

// 内容层面：密钥 / 本机测试口令 / 测试数据
const PATTERNS = [
  ['Docker PAT', /dckr_pat_[A-Za-z0-9_-]{10,}/],
  ['GitHub Token', /ghp_[A-Za-z0-9]{20,}/],
  ['微信 AppID', /wx[0-9a-f]{16}\b/],
  ['私钥', /-----BEGIN (RSA |OPENSSH |EC )?PRIVATE KEY-----/],
  ['AWS Key', /AKIA[0-9A-Z]{16}/],
  ['口令散列', /scrypt\$\d+\$\d+\$\d+\$/],
  ['本机测试口令', /LocalTest2026|PrintGate2026/],
  ['测试账号昵称', /财务-李敏|运营-王浩|设计-陈曦|行政-赵倩|打印机小王/],
  ['示例域名', /print\.example\.com/],
  ['管理员密码键名', /adminPassHash/],
  ['绑定码键名', /bindToken/]
];

// Windows 上 GNU tar 会把 "C:" 当成远程主机名，因此统一在 TMP 目录下用相对路径 + --force-local
function sh(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { maxBuffer: 1024 * 1024 * 200, cwd: TMP, ...opts });
}

function auditOne(tag) {
  const image = `tomdfwe/printgate:${tag}`;
  const out = { tag, ok: false, badFiles: [], hits: [], env: [], labels: [], sizeMB: 0 };

  // 1) 配置层面的环境变量与标签（看有没有把密钥写成 ENV / LABEL）
  const info = JSON.parse(sh('docker', ['inspect', image]).toString())[0];
  out.env = (info.Config.Env || []);
  out.labels = Object.entries(info.Config.Labels || {}).map(([k, v]) => `${k}=${v}`);
  out.sizeMB = Math.round((info.Size || 0) / 1048576);

  // 2) 展平 rootfs 的清单
  const cname = `pg-audit-${tag.replace(/[^\w.-]/g, '_')}`;
  try { sh('docker', ['rm', '-f', cname]); } catch (_) {}
  sh('docker', ['create', '--name', cname, image]);
  const tarName = `${tag}.tar`;
  const tarPath = path.join(TMP, tarName);
  const buf = sh('docker', ['export', cname, '-o', tarPath], { cwd: os.tmpdir() });
  void buf;
  sh('docker', ['rm', '-f', cname]);

  const list = sh('tar', ['--force-local', '-tf', tarName]).toString().split(String.fromCharCode(10)).filter(Boolean);

  for (const p of list) {
    if (ALLOW.some((re) => re.test(p))) continue;
    if (BAD_FILE.some((re) => re.test(p))) out.badFiles.push(p);
  }

  // 3) 只抽取可能要 grep 的目录（避免解压 600MB）
  const want = ['app/src', 'app/public', 'app/package.json', 'data', 'etc/cups', 'root', 'home', 'tmp'];
  const extractDir = path.join(TMP, `${tag}-x`);
  fs.mkdirSync(extractDir, { recursive: true });
  const args = ['--force-local', '-xf', tarName, '-C', path.basename(extractDir), '--wildcards'];
  for (const w of want) args.push(`${w}/*`, w);
  try { sh('tar', args); } catch (_) { /* 某个目录不存在时 tar 返回非 0，忽略 */ }

  // 4) 内容扫描
  const walk = (dir) => {
    const out2 = [];
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) out2.push(...walk(p));
      else if (e.isFile() && fs.statSync(p).size < 12 * 1024 * 1024) out2.push(p);
    }
    return out2;
  };
  const files = fs.existsSync(extractDir) ? walk(extractDir) : [];
  for (const f of files) {
    let text;
    try { text = fs.readFileSync(f, 'latin1'); } catch (_) { continue; }
    for (const [name, re] of PATTERNS) {
      const m = text.match(re);
      if (m) out.hits.push({ file: path.relative(extractDir, f), pattern: name, sample: String(m[0]).slice(0, 60) });
    }
  }

  // 5) 数据目录必须为空（/data 是卷，镜像里不该有业务数据）
  const dataDir = path.join(extractDir, 'data');
  out.dataFiles = fs.existsSync(dataDir) ? walk(dataDir).map((f) => path.relative(dataDir, f)) : [];

  fs.rmSync(tarPath, { force: true });
  fs.rmSync(extractDir, { recursive: true, force: true });
  out.ok = true;
  return out;
}

const results = [];
for (const tag of tags) {
  process.stdout.write(`审计 ${tag} ... `);
  try {
    const r = auditOne(tag);
    results.push(r);
    console.log(`${r.badFiles.length ? '⚠ ' + r.badFiles.length + ' 个可疑文件' : '文件清单干净'}｜${r.hits.length ? '⚠ ' + r.hits.length + ' 处敏感串' : '内容无敏感串'}`);
  } catch (e) {
    console.log('失败：' + e.message);
    results.push({ tag, ok: false, error: e.message });
  }
}

console.log('\n================ 汇总 ================');
for (const r of results) {
  console.log(`\n[${r.tag}] ${r.ok ? r.sizeMB + 'MB' : '审计失败: ' + r.error}`);
  if (!r.ok) continue;
  console.log('  可疑文件:', r.badFiles.length ? r.badFiles.slice(0, 10) : '无');
  console.log('  敏感串  :', r.hits.length ? r.hits.slice(0, 8) : '无');
  console.log('  /data   :', r.dataFiles.length ? r.dataFiles : '空（正确）');
  console.log('  非敏感ENV:', r.env.filter((e) => !/^(PATH|NODE_VERSION|YARN_VERSION|ALPINE|TZ|NODE_ENV|LANG|PG_|PORT|HOME|HOSTNAME)/.test(e)).slice(0, 6));
  console.log('  LABEL   :', r.labels.slice(0, 8));
}

const bad = results.filter((r) => !r.ok || r.badFiles.length || r.hits.length || r.dataFiles.length);
fs.writeFileSync(path.join(__dirname, '..', '_logs', 'image-privacy-audit.json'), JSON.stringify(results, null, 2));
console.log(`\n结论：${bad.length ? '发现 ' + bad.length + ' 个镜像需要处理' : '全部镜像未发现隐私数据'}（明细见 _logs/image-privacy-audit.json）`);
process.exit(bad.length ? 1 : 0);
