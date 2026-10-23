'use strict';
// 文件删除助手。
// Windows 上刚写入的文件可能被杀毒软件 / 索引器短暂占用（ERROR_ACCESS_DENIED / EBUSY），
// 一次 unlink 失败是常态；此前各处直接 try/catch 静默吞掉，
// 结果是「数据库标记已删、磁盘上文件还在」——既漏存储又是泄漏面。
// 这里统一：ENOENT 视为成功，其他错误退避重试，最终失败大声报出来（不静默）。
const fs = require('fs');
const path = require('path');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BACKOFF = [150, 400, 1000];

async function safeUnlink(p, { retries = 3, label = '' } = {}) {
  if (!p) return true;
  for (let i = 0; i < retries; i++) {
    try {
      fs.unlinkSync(p);
      return true;
    } catch (e) {
      if (e.code === 'ENOENT') return true; // 已经不在了，视为成功
      if (i < retries - 1) {
        await sleep(BACKOFF[i] !== undefined ? BACKOFF[i] : 1000);
        continue;
      }
      console.warn(`[fs] 删除失败${label ? `（${label}）` : ''}: ${p} → ${e.code || ''} ${e.message || e}`);
      return false;
    }
  }
  return false;
}

// 目录包含判断。不要用 str.startsWith(dir) —— `/data/avatar-evil` 也以 `/data/avatar` 开头，
// 会被误判成「在目录内」，进而删到目录外的文件。这里按路径分段比较。
function isInside(parent, child) {
  if (!parent || !child) return false;
  const p = path.resolve(String(parent));
  const c = path.resolve(String(child));
  if (c === p) return true;
  return c.startsWith(p.endsWith(path.sep) ? p : p + path.sep);
}

module.exports = { safeUnlink, isInside };
