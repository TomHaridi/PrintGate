// 小程序「字段级」静态检查：模板绑定的字段，JS 里到底有没有赋值
// 背景：WXML 绑了 item._name，但 JS 忘了 map(decorate) —— 静态检查查不出来，
// 真机上就是一片空白（v5.11 的打印记录页就踩了这个）。
// 用法：node tools/mp-field-check.js [小程序目录]
const fs = require('fs');
const path = require('path');

function resolveRoot() {
  if (process.argv[2]) return process.argv[2];
  if (process.env.MP_DIR) return process.env.MP_DIR;
  const base = process.env.MP_ROOT || 'C:/Users/Administrator/AppData/Local/Temp/mp56';
  try {
    const dirs = fs.readdirSync(base)
      .filter((n) => n.startsWith('Printgate-小程序端'))
      .map((n) => ({ n, t: fs.statSync(path.join(base, n)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    if (dirs.length) return path.join(base, dirs[0].n);
  } catch (_) {}
  return base;
}

const ROOT = resolveRoot();
const read = (p) => fs.readFileSync(p, 'utf8');
const exists = (p) => { try { return fs.statSync(p).isFile(); } catch (_) { return false; } };

// ---------- 收集页面 ----------
const appJson = JSON.parse(read(path.join(ROOT, 'app.json')));
const pages = [];
for (const p of appJson.pages || []) pages.push(p);
for (const sp of appJson.subPackages || appJson.subpackages || []) {
  for (const p of sp.pages || []) pages.push(`${sp.root}/${p}`.replace(/\/+/g, '/'));
}

// 已知非数据标识符（模板内置 / 全局 API）
const BUILTIN = new Set(['true', 'false', 'null', 'undefined', 'item', 'index', 'wx', 'this',
  'length', 'Math', 'JSON', 'String', 'Number', 'Date', 'Array', 'Object', 'parseInt', 'parseFloat']);

// 从 data:{...} 里取顶层键
function dataKeys(js) {
  const keys = new Set();
  const i = js.search(/\bdata\s*:\s*\{/);
  if (i < 0) return keys;
  const start = js.indexOf('{', i);
  let depth = 0, end = start;
  for (let k = start; k < js.length; k++) {
    if (js[k] === '{') depth++;
    else if (js[k] === '}') { depth--; if (!depth) { end = k; break; } }
  }
  const body = js.slice(start + 1, end);
  const re = /(?:^|[\s,{])([A-Za-z_$][\w$]*)\s*:/g;
  let m;
  while ((m = re.exec(body))) keys.add(m[1]);
  return keys;
}

// setData 里出现过的键（含 'options.copies' 这种路径写法）
function setDataKeys(js) {
  const keys = new Set();
  const re = /setData\(\s*\{([\s\S]*?)\}\s*(?:,|\))/g;
  let m;
  while ((m = re.exec(js))) {
    const body = m[1];
    let km;
    const kr = /(?:^|[\s,])([A-Za-z_$][\w$]*)\s*:/g;
    while ((km = kr.exec(body))) keys.add(km[1]);
    // 计算属性名：['options.copies']: 或 [`options.${k}`]:
    const cr = /\{\s*[`'"]([A-Za-z_$][\w$.]*)/g;
    while ((km = cr.exec(body))) keys.add(km[1].split('.')[0]);
    // 对象展开：...Object.assign({}, x, { foo: 1 }) 里的 foo 已被上面的 re 覆盖
  }
  // 动态路径赋值 this.setData({ [side === 'front' ? 'idFront' : 'idBack']: ... })
  const dyn = /\?\s*'([\w$]+)'\s*:\s*'([\w$]+)'/g;
  while ((m = dyn.exec(js))) { keys.add(m[1]); keys.add(m[2]); }
  return keys;
}

// 表达式里可能出现字符串字面量（'theme-dark'），分词前先剔掉，否则会把
// theme / dark / on / ok 当成绑定的字段误报。
function stripStrings(expr) {
  return expr
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``');
}

function wxmlBindings(file) {
  const src = read(file);
  const out = new Map(); // field -> first snippet
  const re = /\{\{([\s\S]*?)\}\}/g;
  let m;
  while ((m = re.exec(src))) {
    const raw = m[1];
    const expr = stripStrings(raw);
    if (!expr.replace(/[\s()?:!<>=+\-*/|&,'"]/g, '')) continue;
    // item.xxx / file.xxx / user.xxx / options.xxx
    let mm;
    const dotted = /\b(?:item|file|user|task|options|previewFile)\s*\.\s*([A-Za-z_$][\w$]*)/g;
    while ((mm = dotted.exec(expr))) {
      const f = mm[1];
      if (!BUILTIN.has(f)) out.set(`•.${f}`, (out.get(`•.${f}`) || expr.trim()).slice(0, 50));
    }
    // 顶层标识符
    const bare = /(?:^|[^.\w$])([A-Za-z_$][\w$]*)/g;
    while ((mm = bare.exec(expr))) {
      const f = mm[1];
      if (BUILTIN.has(f)) continue;
      if (!out.has(f)) out.set(f, expr.trim().slice(0, 50));
    }
  }
  return out;
}

let pass = 0, fail = 0;
const problems = [];

for (const page of pages) {
  const base = path.join(ROOT, page);
  const wxml = `${base}.wxml`;
  const js = `${base}.js`;
  if (!exists(wxml) || !exists(js)) { console.log(`SKIP | ${page}（缺文件）`); continue; }
  const src = read(js);
  const dk = dataKeys(src);
  const sk = setDataKeys(src);
  const binds = wxmlBindings(wxml);

  const missingUnderscore = [];
  const missingPlain = [];

  // 顶层函数是否真的被调用过：decorateTask 定义了却没 .map(decorateTask)，
  // 就是「字段算得出来但从没算」——模板全空白，静态检查却看不出来。
  const unusedFns = new Set();
  let fm;
  const fRe = /^function\s+([A-Za-z_$][\w$]*)\s*\(/gm;
  while ((fm = fRe.exec(src))) {
    const name = fm[1];
    const hits = src.split(new RegExp(`\\b${name}\\b`)).length - 1;
    if (hits <= 1) unusedFns.add(name);
  }
  if (unusedFns.size) {
    for (const n of unusedFns) missingPlain.push(`函数 ${n}() 已定义但从未调用（算好的字段不会生效）`);
  }

  // 把「从未被调用的顶层函数」整段剔除，剩下的源码里若还找不到字段，
  // 说明这个计算字段只在死代码里出现过 → 模板必然空白。
  let live = src;
  for (const fn of unusedFns) {
    const start = live.search(new RegExp(`^function\\s+${fn}\\s*\\(`, 'm'));
    if (start < 0) continue;
    // 简单的花括号配对，够用（页面里的顶层函数没有嵌套花括号字符串）
    let depth = 0, end = start;
    for (let k = live.indexOf('{', start); k < live.length; k++) {
      if (live[k] === '{') depth++;
      else if (live[k] === '}') { depth--; if (!depth) { end = k; break; } }
    }
    live = live.slice(0, start) + live.slice(end + 1);
  }

  for (const [field, snippet] of binds) {
    if (field.startsWith('•.')) {
      const f = field.slice(2);
      // item.xxx 的非下划线字段来自服务端原始数据，这里不做推断；
      // 只校验项目约定的「计算字段」item._xxx（decorate 产物），它必须真的在 JS 里生成。
      if (f.startsWith('_') && !new RegExp(`\\b${f}\\b`).test(live)) {
        missingUnderscore.push(`${f}  ← {{${snippet}}}`);
      }
      continue;
    }
    if (field.startsWith('_')) {
      if (!new RegExp(`\\b${field}\\b`).test(live)) missingUnderscore.push(`${field}  ← {{${snippet}}}`);
      continue;
    }
    if (dk.has(field) || sk.has(field)) continue;
    // 模板里也可能引用 JS 里的常量/方法名，宽一点：源码出现过就不报
    if (new RegExp(`\\b${field}\\b`).test(live)) continue;
    missingPlain.push(`${field}  ← {{${snippet}}}`);
  }

  const bad = missingUnderscore.concat(missingPlain);
  if (!bad.length) { pass++; console.log(`PASS | ${page}`); continue; }
  fail++;
  console.log(`FAIL | ${page}`);
  for (const b of bad.slice(0, 8)) console.log(`        ${b}`);
  problems.push({ page, bad });
}

console.log(`\n合计 ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
