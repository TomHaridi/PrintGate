'use strict';
// IPP 清洗代理：修掉部分 Canon 固件返回的非法 naturalLanguage 值。
//
// 背景（实测 Canon MF650C Series，192.168.31.38，固件 CANON INC. 2021）：
//   打印机的 IPP 本身是好的——Get-Printer-Attributes 返回 successful-ok、
//   driverless 也能正常生成 PPD。问题只在一个属性值上：它把 naturalLanguage
//   返回成 "en-  "（RFC 8011 §5.1.9 要求恰好 2 个字母），而 CUPS 调度器
//   （cupsd，不是 cups-filters 的 driverless）对每个自然语言值都做严格校验，
//   有一个不合格就拒收整条响应：
//     · lpadmin -m everywhere → "Bad naturalLanguage value" 建不了免驱队列
//     · 只能退回 RAW 直通     → 没有驱动 → 彩色/双面等选项全部失效
//   实测一条 8979 字节的响应里，坏值同时出现在三个属性上：
//     attributes-natural-language / generated-natural-language-supported /
//     natural-language-configured
//   所以不能按属性名修，要按 IPP 的 naturalLanguage 标签（0x48）统一修。
//
// 做法：在本机起一个代理，CUPS 连代理，代理转发给打印机，回来时把非法的
// 自然语言值改写成 "en"，其余字节原样透传。CUPS 于是看到一台「正常」的
// IPP Everywhere 打印机，免驱链路恢复，彩色打印随之恢复。

const http = require('http');

const MAX_BUFFER = 32 * 1024 * 1024; // 超过就不再改写，直接透传（document-data 之类的大响应）

// IPP 分隔标签（开始一个新属性组 / 结束）
const DELIM = new Set([0x01, 0x02, 0x03, 0x04, 0x05]);
// 无值标签（只有名字，没有值）
const NO_VALUE = new Set([0x10, 0x11, 0x12]);
const TAG_NATURAL = 0x48;   // naturalLanguage
const TAG_BEG_COLLECTION = 0x34;
const TAG_END_COLLECTION = 0x37;
const TAG_MEMBER_NAME = 0x4a;

// 判断一个字节串是不是合法的 natural-language（恰好 2 个字母）
function isValidLanguage(buf) {
  if (buf.length !== 2) return false;
  const ok = (c) => (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a);
  return ok(buf[0]) && ok(buf[1]);
}

/**
 * 读一个「tag + name (+ value)」，非法语言值就地改写。
 * 返回值约定：
 *   -1  解析失败（调用方据此整体放弃，返回原样入参）
 *   -2  读到了 end-of-attributes，整个报文结束
 *   >0  新的偏移
 */
function readOne(buf, i, pieces, state) {
  const tag = buf[i];
  if (tag === 0x03) { pieces.push(buf.slice(i, i + 1)); return -2; }
  if (DELIM.has(tag)) { pieces.push(buf.slice(i, i + 1)); return i + 1; }
  if (tag === TAG_BEG_COLLECTION) return readCollection(buf, i, pieces, state);
  if (tag === TAG_END_COLLECTION || tag === TAG_MEMBER_NAME) return -1; // 只该出现在集合内部

  const start = i;
  i += 1;
  if (i + 2 > buf.length) return -1;
  const nlen = buf.readUInt16BE(i); i += 2;
  if (nlen > 255 || i + nlen > buf.length) return -1;
  const name = buf.slice(i, i + nlen); i += nlen;
  if (NO_VALUE.has(tag)) { pieces.push(buf.slice(start, i)); return i; } // 只有名字，没有值

  if (i + 2 > buf.length) return -1;
  const vlen = buf.readUInt16BE(i); i += 2;
  if (i + vlen > buf.length) return -1;
  const val = buf.slice(i, i + vlen); i += vlen;

  if (tag === TAG_NATURAL && !isValidLanguage(val)) {
    const good = Buffer.from('en', 'latin1');
    const nl = Buffer.alloc(2); nl.writeUInt16BE(name.length, 0);
    const vl = Buffer.alloc(2); vl.writeUInt16BE(good.length, 0);
    pieces.push(Buffer.concat([Buffer.from([tag]), nl, name, vl, good]));
    state.fixed += 1;
  } else {
    pieces.push(buf.slice(start, i)); // 原样透传
  }
  return i;
}

// begCollection(0x34)：名字 + 值长度 + 若干成员属性 + endCollection(0x37)。
// 注意：实测这台 Canon 把 begCollection 的值长度写成了 0，后面却跟着一堆成员属性
// （x-dimension / y-dimension ...）。所以这个长度字段不能信，一律读到 endCollection 为止。
function readCollection(buf, i, pieces, state) {
  const start = i;
  i += 1;
  if (i + 2 > buf.length) return -1;
  const nlen = buf.readUInt16BE(i); i += 2;
  if (nlen > 255 || i + nlen > buf.length) return -1;
  i += nlen; // 集合名
  if (i + 2 > buf.length) return -1;
  i += 2;    // 跳过（不可信的）值长度字段

  const head = buf.slice(start, i);
  const tmp = []; // 成员先攒着，全部成功再提交，避免半截集合拼进出参
  while (i < buf.length) {
    const t = buf[i];
    if (t === TAG_END_COLLECTION) { tmp.push(buf.slice(i, i + 1)); i += 1; break; }
    if (t === TAG_MEMBER_NAME) { // memberAttrName：只有名字
      const s = i; i += 1;
      if (i + 2 > buf.length) return -1;
      const nl = buf.readUInt16BE(i); i += 2;
      if (i + nl > buf.length) return -1;
      i += nl;
      tmp.push(buf.slice(s, i));
      continue;
    }
    if (t === TAG_BEG_COLLECTION) { // 嵌套集合
      const r = readCollection(buf, i, tmp, state);
      if (r < 0) return -1;
      i = r;
      continue;
    }
    if (DELIM.has(t)) return -1; // 集合内部不该出现组分隔标签
    const r = readOne(buf, i, tmp, state);
    if (r < 0) return -1; // -2（end-of-attributes）在集合内部同样算失败
    i = r;
  }
  if (tmp.length === 0 || tmp[tmp.length - 1][0] !== TAG_END_COLLECTION) return -1; // 没读到 endCollection
  pieces.push(head);
  for (const p of tmp) pieces.push(p);
  return i;
}

/**
 * 把响应里所有非法的 naturalLanguage 值改写成 "en"。
 *
 * 安全性约定：只替换「完整解析成功」的属性；一旦某处解析不下去，
 * 已修好的部分保留、剩余字节原样拼回，绝不输出结构错乱的报文。
 */
function sanitizeIpp(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 8) return buf;
  const pieces = [buf.slice(0, 8)]; // version + status + request-id
  const state = { fixed: 0 };
  let i = 8;
  let done = false;
  while (i < buf.length) {
    const r = readOne(buf, i, pieces, state);
    if (r === -2) { done = true; break; }
    if (r === -1) break; // 解析失败：停止改写，剩余部分原样透传
    i = r;
  }
  if (state.fixed === 0) return buf;
  if (!done && i < buf.length) pieces.push(buf.slice(i));
  if (process.env.IPP_PROXY_DEBUG) {
    console.error('[dbg] fixed=%s done=%s i=%s/%s pieces=%s', state.fixed, done, i, buf.length, pieces.length);
  }
  return Buffer.concat(pieces);
}

// 判断一段 CUPS 的错误文本是不是「自然语言标记」引起的
function isNaturalLanguageError(text) {
  const t = String(text || '');
  return /naturalLanguage|natural-language|RFC ?8011/i.test(t);
}

/**
 * 启动一个清洗代理。
 * @param {object} opt
 * @param {string} opt.target   形如 192.168.31.38:631
 * @param {string} [opt.path]   打印机 IPP 路径，默认 /ipp/print
 * @param {number} [opt.port]   本地监听端口，0 = 随机
 * @param {string} [opt.host]   本地监听地址，默认 127.0.0.1
 * @param {boolean}[opt.verbose] 调试：记录每个请求
 * @param {string} [opt.logFile] 调试日志路径
 */
function startProxy(opt) {
  const o = opt || {};
  const target = String(o.target || '');
  const m = target.match(/^([^:/]+):(\d+)$/);
  if (!m) return Promise.reject(new Error(`目标地址格式不正确：${target}（应为 主机:端口）`));
  const tHost = m[1];
  const tPort = Number(m[2]);
  const tPath = String(o.path || '/ipp/print');
  const host = String(o.host || '127.0.0.1');

  const stats = { requests: 0, fixed: 0, bytes: 0, startedAt: new Date().toISOString() };
  const verbose = o.verbose || process.env.IPP_PROXY_VERBOSE === '1';
  const logFile = o.logFile || process.env.IPP_PROXY_LOG || '/tmp/ipp-proxy.log';
  function dbg(line) {
    if (!verbose) return;
    try { require('fs').appendFileSync(logFile, line + String.fromCharCode(10)); } catch (_) {}
  }

  const server = http.createServer((req, res) => {
    stats.requests += 1;
    dbg(`${new Date().toISOString()} ${req.method} ${req.url} from=${req.socket.remoteAddress}`);
    const chunks = [];
    let size = 0;
    let overflow = false;
    req.on('data', (d) => {
      size += d.length;
      if (size > MAX_BUFFER) { overflow = true; chunks.length = 0; return; }
      chunks.push(d);
    });
    req.on('end', () => {
      if (overflow) { res.writeHead(413); res.end('too large'); return; }
      const body = Buffer.concat(chunks);

      // 转发用的请求头：去掉 host / content-length / 连接管理类，避免干扰
      const headers = Object.assign({}, req.headers);
      delete headers.host;
      delete headers['content-length'];
      delete headers.connection;
      delete headers['accept-encoding'];

      const preq = http.request({
        host: tHost, port: tPort, path: req.url || tPath, method: req.method || 'POST',
        headers: Object.assign({}, headers, { host: `${tHost}:${tPort}` })
      }, (pres) => {
        const rchunks = [];
        let rsize = 0;
        let roverflow = false;
        pres.on('data', (d) => {
          rsize += d.length;
          if (rsize > MAX_BUFFER) { roverflow = true; rchunks.length = 0; return; }
          rchunks.push(d);
        });
        pres.on('end', () => {
          const outHeaders = Object.assign({}, pres.headers);
          delete outHeaders['content-length'];
          delete outHeaders['transfer-encoding'];
          delete outHeaders.connection;
          let payload = Buffer.concat(rchunks);
          if (!roverflow) {
            const clean = sanitizeIpp(payload);
            if (clean !== payload && !clean.equals(payload)) {
              stats.fixed += 1;
              payload = clean;
            }
          }
          stats.bytes += payload.length;
          outHeaders['content-length'] = String(payload.length);
          res.writeHead(pres.statusCode || 200, outHeaders);
          res.end(payload);
        });
        pres.on('error', (e) => { res.writeHead(502); res.end(`upstream error: ${e.message}`); });
      });
      preq.on('error', (e) => { res.writeHead(502); res.end(`upstream error: ${e.message}`); });
      preq.setTimeout(60000, () => { preq.destroy(); });
      preq.end(body);
    });
  });

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(Number(o.port || 0), host, () => {
      const port = server.address().port;
      resolve({
        url: `ipp://${host}:${port}${tPath}`,
        port, host,
        target: `${tHost}:${tPort}`,
        stop() { try { server.close(); } catch (_) {} },
        stats
      });
    });
  });
}

module.exports = { startProxy, sanitizeIpp, isNaturalLanguageError };

// 独立运行（调试用）：node ipp-proxy.js 192.168.31.38:631 16311
if (require.main === module) {
  const target = process.argv[2] || '192.168.31.38:631';
  const port = Number(process.argv[3] || 16311);
  startProxy({ target, port }).then((p) => {
    console.log(`[ipp-proxy] 监听 http://127.0.0.1:${p.port}${'/ipp/print'} → ${p.target}`);
    console.log(`[ipp-proxy] CUPS 请用：${p.url}`);
  }).catch((e) => { console.error('[ipp-proxy] 启动失败:', e.message); process.exit(1); });
}
