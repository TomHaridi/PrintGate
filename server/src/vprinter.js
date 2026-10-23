'use strict';
// 虚拟打印机：本机 TCP 9100 “打印接收器”，把收到的原始任务落盘。
// 用途：没有实体打印机时验证整条链路（上传 → 队列 → 后端发送 → 落盘），也便于对接调试。
const net = require('net');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('./config');
const { getSetting, logAudit } = require('./db');

const state = { server: null, port: 9100, jobs: [], dir: path.join(config.dataDir, 'spool') };

function listJobs() {
  try {
    const files = fs.readdirSync(state.dir)
      .filter((f) => f.startsWith('vjob-'))
      .map((f) => {
        const p = path.join(state.dir, f);
        const st = fs.statSync(p);
        return { filename: f, size: st.size, created_at: st.mtime.toISOString() };
      })
      .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
      .slice(0, 30);
    return files;
  } catch (_) {
    return [];
  }
}

function start(port = 9100) {
  if (state.server) return { ok: true, msg: `虚拟打印机已在 ${state.port} 端口运行`, port: state.port };
  fs.mkdirSync(state.dir, { recursive: true });
  state.port = port;
  const MAX_JOB = 200 * 1024 * 1024;
  state.server = net.createServer((sock) => {
    const chunks = [];
    let size = 0;
    let overflow = false;
    sock.on('data', (d) => {
      size += d.length;
      if (size <= MAX_JOB) {
        chunks.push(d);
      } else if (!overflow) {
        // 超限就明确失败：继续收集会 OOM，静默截断会落一个打不开的残包还看不出来
        overflow = true;
        chunks.length = 0;
        logAudit('vprinter_overflow', `size>${MAX_JOB}`, '', 'system');
        try { sock.destroy(); } catch (_) {}
      }
    });
    sock.on('error', () => {});
    sock.on('end', () => {
      if (overflow) return;
      const buf = Buffer.concat(chunks);
      const ts = new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 15);
      // 时间戳只精确到秒：同一秒到达的多个任务曾写到同一个文件名上互相覆盖（丢数据）。
      // 加随机后缀保证唯一，落盘验证才可靠。
      const file = path.join(state.dir, `vjob-${ts}-${crypto.randomBytes(3).toString('hex')}.dat`);
      try {
        fs.writeFileSync(file, buf);
        logAudit('vprinter_job', `file=${path.basename(file)} size=${buf.length}`, '', 'system');
      } catch (e) {
        console.error('[vprinter] 写入失败', e.message);
      }
    });
  });
  state.server.on('error', (e) => {
    console.error('[vprinter] listen error', e.message);
    state.server = null;
  });
  state.server.listen(port, '127.0.0.1');
  return { ok: true, msg: `虚拟打印机已启动，监听 127.0.0.1:${port}`, port };
}

function stop() {
  if (!state.server) return { ok: true, msg: '虚拟打印机未运行' };
  try { state.server.close(); } catch (_) {}
  state.server = null;
  return { ok: true, msg: '虚拟打印机已停止' };
}

function status() {
  return { running: !!state.server, port: state.port, enabled: getSetting('virtualPrinter', '0') === '1', jobs: listJobs() };
}

// 启动时按设置决定是否拉起
function autoStart() {
  if (getSetting('virtualPrinter', '0') === '1') start();
}

module.exports = { start, stop, status, listJobs, autoStart, dir: state.dir };
