'use strict';
// Office 文档转换（可选组件）：容器内装了 libreoffice 才会启用，否则明确提示
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const cups = require('./cups');

let cached = null;

const HINT = '镜像未内置 Office 转换。两种解决方式：'
  + '① 重新构建镜像时加 --build-arg WITH_OFFICE=1；'
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

module.exports = { detect, convertToPdf, HINT };
