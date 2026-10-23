'use strict';
// 用 OSV 扫描 node_modules 里的真实漏洞（npm 镜像站不提供 audit 接口，只能这样核对）
// 用法：node tools/osv-scan-npm.js [node_modules 路径]
const fs = require('fs');
const path = require('path');

const root = process.argv[2] || 'C:/pg_rc_ext/Printgate/server/node_modules';
const found = new Map(); // name@version -> {name, version, paths:[]}

function walk(dir, depth = 0) {
  if (depth > 6) return;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const full = path.join(dir, e.name);
    if (e.name.startsWith('@')) { walk(full, depth + 1); continue; }
    if (e.name === 'node_modules') { walk(full, depth + 1); continue; }
    const pj = path.join(full, 'package.json');
    if (fs.existsSync(pj)) {
      try {
        const j = JSON.parse(fs.readFileSync(pj, 'utf8'));
        if (j.name && j.version) {
          const key = `${j.name}@${j.version}`;
          if (!found.has(key)) found.set(key, { name: j.name, version: j.version });
        }
      } catch (_) {}
      walk(path.join(full, 'node_modules'), depth + 1);
    }
  }
}

walk(root);
const pkgs = [...found.values()];
console.log('node_modules 包数:', pkgs.length);

async function q(p) {
  const r = await fetch('https://api.osv.dev/v1/query', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ package: { name: p.name, ecosystem: 'npm' }, version: p.version })
  });
  const d = await r.json().catch(() => ({}));
  return { ...p, vulns: (d.vulns || []).map((v) => ({
    id: v.id,
    sev: (v.database_specific && v.database_specific.severity) || 'UNKNOWN',
    fixed: (v.affected || []).flatMap((a) => (a.ranges || []).flatMap((rr) => (rr.events || []).map((e) => e.fixed).filter(Boolean)))
  })) };
}

(async () => {
  const out = [];
  const CONC = 10;
  for (let i = 0; i < pkgs.length; i += CONC) {
    const rs = await Promise.all(pkgs.slice(i, i + CONC).map((p) => q(p).catch(() => ({ ...p, vulns: [] }))));
    out.push(...rs);
    process.stdout.write(`\r已查询 ${Math.min(i + CONC, pkgs.length)}/${pkgs.length}`);
  }
  console.log('');

  const bad = out.filter((p) => p.vulns.length).sort((a, b) => b.vulns.length - a.vulns.length);
  const bySev = {};
  let fixedAvail = 0;
  for (const p of bad) for (const v of p.vulns) { bySev[v.sev] = (bySev[v.sev] || 0) + 1; if (v.fixed.length) fixedAvail++; }

  console.log('\n有漏洞的包:', bad.length, '| 漏洞条目:', bad.reduce((n, p) => n + p.vulns.length, 0), '| 其中能修:', fixedAvail);
  console.log('按严重度:', JSON.stringify(bySev));
  for (const p of bad) {
    const s = {};
    for (const v of p.vulns) s[v.sev] = (s[v.sev] || 0) + 1;
    const fixes = [...new Set(p.vulns.flatMap((v) => v.fixed))].slice(0, 3);
    console.log(`  ${(p.name + '@' + p.version).padEnd(38)} ${String(p.vulns.length).padStart(2)} 条 ${JSON.stringify(s)}  fix→ ${fixes.join(', ') || '无'}`);
  }

  const outFile = 'C:/Users/Administrator/AppData/Local/Temp/npm-osv.json';
  fs.writeFileSync(outFile, JSON.stringify(out.filter((p) => p.vulns.length), null, 2));
  console.log('\n明细:', outFile);
})();
