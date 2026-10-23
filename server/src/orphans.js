'use strict';
// 孤儿文件清单：物理删除最终失败的文件记在这里，后续每次清理都重试，
// 保证「逻辑上删了的文件」最终一定从磁盘上消失。
// 典型场景：删用户时某个文件正被占用；清理任务撞上瞬态锁。
const fs = require('fs');
const path = require('path');
const config = require('./config');
const { safeUnlink } = require('./fsutil');

const FILE = path.join(config.dataDir, 'orphans.json');

function list() {
  try {
    const arr = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return Array.isArray(arr) ? arr : [];
  } catch (_) { return []; }
}

function add(p) {
  if (!p) return;
  const cur = list();
  if (cur.some((x) => x.path === p)) return;
  cur.push({ path: p, at: new Date().toISOString() });
  try { fs.writeFileSync(FILE, JSON.stringify(cur.slice(-500))); } catch (_) { /* 写不进去就算了 */ }
}

// 重试清单里的全部；返回 { removed, left }
async function retryAll() {
  const cur = list();
  if (!cur.length) return { removed: 0, left: 0 };
  const left = [];
  let removed = 0;
  for (const item of cur) {
    const ok = await safeUnlink(item.path, { label: 'orphan' });
    if (ok) removed++;
    else left.push(item);
  }
  try { fs.writeFileSync(FILE, JSON.stringify(left)); } catch (_) {}
  return { removed, left: left.length };
}

module.exports = { list, add, retryAll };
