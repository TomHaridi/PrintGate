'use strict';
// 用 OSV 数据库核对镜像内每个 apk 包的真实漏洞数量（镜像内没有扫描器时用来定位来源）
// 用法：docker run --rm --entrypoint sh <img> -c "apk list --installed" > pkgs.txt
//       node tools/osv-scan.js pkgs.txt
const fs = require('fs');

const file = process.argv[2] || 'pkgs.txt';
const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
const pkgs = [];
for (const l of lines) {
  const m = l.match(/^([a-zA-Z0-9._+-]+)-([0-9][^\s]*)\s/);
  if (m) pkgs.push({ name: m[1], version: m[2] });
}
console.log('解析到包数:', pkgs.length);

const SEV_RANK = { CRITICAL: 4, HIGH: 3, MODERATE: 2, MEDIUM: 2, LOW: 1 };

async function q(p) {
  const r = await fetch('https://api.osv.dev/v1/query', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ package: { name: p.name, ecosystem: 'Alpine:v3.24' }, version: p.version })
  });
  const d = await r.json().catch(() => ({}));
  const vulns = d.vulns || [];
  return { ...p, vulns: vulns.map((v) => ({
    id: v.id,
    sev: (v.database_specific && v.database_specific.severity) || 'UNKNOWN',
    fixed: (v.affected || []).flatMap((a) => (a.ranges || []).flatMap((rr) => (rr.events || []).map((e) => e.fixed).filter(Boolean)))
  })) };
}

(async () => {
  const out = [];
  const CONC = 8;
  for (let i = 0; i < pkgs.length; i += CONC) {
    const batch = pkgs.slice(i, i + CONC);
    const rs = await Promise.all(batch.map((p) => q(p).catch((e) => ({ ...p, vulns: [], err: e.message }))));
    out.push(...rs);
    process.stdout.write(`\r已查询 ${Math.min(i + CONC, pkgs.length)}/${pkgs.length}`);
  }
  console.log('');

  const bad = out.filter((p) => p.vulns.length).sort((a, b) => b.vulns.length - a.vulns.length);
  const total = bad.reduce((n, p) => n + p.vulns.length, 0);
  const bySev = {};
  for (const p of bad) for (const v of p.vulns) bySev[v.sev] = (bySev[v.sev] || 0) + 1;

  console.log('\n有漏洞的包:', bad.length, '| 漏洞条目合计:', total);
  console.log('按严重度:', JSON.stringify(bySev));
  console.log('\n包（按条目数排序）：');
  for (const p of bad.slice(0, 20)) {
    const sev = {};
    for (const v of p.vulns) sev[v.sev] = (sev[v.sev] || 0) + 1;
    console.log(`  ${p.name}-${p.version}`.padEnd(44), `${p.vulns.length} 条`, JSON.stringify(sev));
  }

  fs.writeFileSync(file.replace(/\.txt$/, '') + '-osv.json', JSON.stringify(out, null, 2));
  console.log('\n明细写入', file.replace(/\.txt$/, '') + '-osv.json');
})();
