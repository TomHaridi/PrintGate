'use strict';
// WXML 静态检查：把小程序编译器会拒绝的写法提前查出来
// 用法：node tools/check-wxml.js [项目目录]
const fs = require('fs');
const path = require('path');

const ROOT = process.argv[2] || require('path').join(require('./_paths').projectRoot(), 'miniprogram');

// hasMiniprogramGuard
// 交付包允许裁剪小程序源码：缺 miniprogram/ 时直接跳过，别让回归里全是崩溃
if (!require('fs').existsSync(require('path').join(ROOT, 'app.json'))) {
  console.log('跳过：当前包未包含 miniprogram/（小程序源码已裁剪），本检查不适用');
  process.exit(0);
}

const SKIP_DIRS = new Set(['node_modules', 'miniprogram_npm', '.git']);
// WXML 是严格 XML：只有显式写成 <tag /> 才算自闭合，没有 HTML 那种 void 元素
const VOID = new Set();

const problems = [];
const add = (file, line, msg) => problems.push({ file, line, msg });

function walk(dir, out = []) {
  for (const item of fs.readdirSync(dir)) {
    const full = path.join(dir, item);
    if (fs.statSync(full).isDirectory()) {
      if (SKIP_DIRS.has(item)) continue;
      walk(full, out);
    } else if (item.endsWith('.wxml')) out.push(full);
  }
  return out;
}

// 全文匹配标签（属性里可能含换行），再换算行号
const TAG_RE = /<(\/?)([a-zA-Z][\w-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g;

function lineOf(text, index) {
  let n = 1;
  for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

function tokens(text) {
  const out = [];
  TAG_RE.lastIndex = 0;
  let m;
  while ((m = TAG_RE.exec(text))) {
    out.push({
      closing: m[1] === '/',
      name: m[2],
      attrs: m[3] || '',
      selfClose: m[4] === '/',
      line: lineOf(text, m.index)
    });
  }
  return out;
}

function checkFile(file) {
  const text = fs.readFileSync(file, 'utf8');
  const rel = path.relative(ROOT, file).replace(/\\/g, '/');
  const toks = tokens(text);

  // 1. wx:else / wx:elif 与 wx:for 同标签
  for (const t of toks) {
    if (t.closing) continue;
    const hasFor = /\bwx:for\b/.test(t.attrs);
    const hasElse = /\bwx:else\b/.test(t.attrs);
    const hasElif = /\bwx:elif\b/.test(t.attrs);
    if (hasFor && (hasElse || hasElif)) {
      add(rel, t.line, `wx:${hasElse ? 'else' : 'elif'} 与 wx:for 写在同一标签（编译报 wx:if not found）`);
    }
  }

  // 2. 标签配对 + 记录每个节点的 depth / 父节点
  const stack = [];
  const nodes = [];   // { name, line, depth, attrs, siblingIndex }
  let siblingCount = [0];
  for (const t of toks) {
    if (t.selfClose || (VOID.has(t.name) && !t.closing)) {
      if (!t.closing) {
        nodes.push({ name: t.name, line: t.line, depth: stack.length + 1, attrs: t.attrs, order: siblingCount[stack.length]++ });
      }
      continue;
    }
    if (t.closing) {
      const top = stack.pop();
      if (!top) { add(rel, t.line, `多余的闭合标签 </${t.name}>`); continue; }
      if (top.name !== t.name) {
        add(rel, t.line, `标签未正确闭合：<${top.name}> (行 ${top.line}) 被 </${t.name}> 关闭`);
      }
      siblingCount.length = stack.length + 1;
      continue;
    }
    nodes.push({ name: t.name, line: t.line, depth: stack.length + 1, attrs: t.attrs, order: siblingCount[stack.length]++ });
    stack.push({ name: t.name, line: t.line });
  }
  stack.forEach((s) => add(rel, s.line, `<${s.name}> 未闭合`));

  // 3. wx:else 必须在同层、紧邻的 wx:if / wx:elif 之后
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (!/\bwx:else\b/.test(n.attrs)) continue;
    // 向前找同深度、order 更小的最近节点
    let prev = null;
    for (let k = i - 1; k >= 0; k--) {
      if (nodes[k].depth === n.depth) { prev = nodes[k]; break; }
      if (nodes[k].depth < n.depth) break;
    }
    if (!prev || !/\bwx:if\b|\bwx:elif\b/.test(prev.attrs)) {
      add(rel, n.line, prev
        ? `wx:else 的前一个同级节点（<${prev.name}> 行 ${prev.line}）不是 wx:if / wx:elif`
        : 'wx:else 找不到同级的 wx:if / wx:elif');
    }
  }
}

const files = walk(ROOT);
files.forEach(checkFile);

console.log(`扫描 ${files.length} 个 wxml`);
if (!problems.length) {
  console.log('未发现结构性问题');
  process.exit(0);
}
console.log(`发现 ${problems.length} 处问题：`);
problems.forEach((p) => console.log(`  ${p.file}:${p.line}  ${p.msg}`));
process.exit(1);
