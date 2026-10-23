'use strict';
// 极简 IPP 客户端：只做 Get-Printer-Attributes。
// 用途有两个，都是原扫描失效的关键：
//   1. 判断 631/443 上跑的到底是不是 IPP 打印服务（而不是随便一个 HTTP 服务）；
//   2. 拿到 printer-make-and-model / printer-device-id，用于推荐驱动；
//      同时探测正确的资源路径（/ipp/print、/ipp/printer、/ 等），避免队列建好却 404。
const net = require('net');
const http = require('http');
const https = require('https');

const OP_GET_PRINTER_ATTRIBUTES = 0x000b;

const TAG = {
  integer: 0x21,
  boolean: 0x22,
  enum: 0x23,
  octetString: 0x30,
  dateTime: 0x31,
  resolution: 0x32,
  rangeOfInteger: 0x33,
  begCollection: 0x34,
  textWithLanguage: 0x35,
  nameWithLanguage: 0x36,
  endCollection: 0x37,
  textWithoutLanguage: 0x41,
  nameWithoutLanguage: 0x42,
  keyword: 0x44,
  uri: 0x45,
  uriScheme: 0x46,
  charset: 0x47,
  naturalLanguage: 0x48,
  mimeMediaType: 0x49,
  memberAttrName: 0x4a
};

function encAttr(tag, name, valueBuf) {
  const n = Buffer.from(name, 'utf8');
  const head = Buffer.alloc(3);
  head.writeUInt8(tag, 0);
  head.writeUInt16BE(n.length, 1);
  const len = Buffer.alloc(2);
  len.writeUInt16BE(valueBuf.length, 0);
  return Buffer.concat([head, n, len, valueBuf]);
}

function encString(tag, name, value) {
  return encAttr(tag, name, Buffer.from(String(value), 'utf8'));
}

function buildRequest({ uri, requestId = 1, requested = [], operation = OP_GET_PRINTER_ATTRIBUTES }) {
  const ver = Buffer.from([0x01, 0x01]);
  const op = Buffer.alloc(2);
  op.writeUInt16BE(operation, 0);
  const rid = Buffer.alloc(4);
  rid.writeUInt32BE(requestId, 0);
  const parts = [ver, op, rid];

  // operation-attributes 组
  parts.push(Buffer.from([0x01]));
  parts.push(encString(TAG.charset, 'attributes-charset', 'utf-8'));
  parts.push(encString(TAG.naturalLanguage, 'attributes-natural-language', 'en'));
  parts.push(encString(TAG.uri, 'printer-uri', uri));
  if (requested.length) {
    const first = encString(TAG.keyword, 'requested-attributes', requested[0]);
    parts.push(first);
    for (const r of requested.slice(1)) {
      // 同组同名的附加属性：name 为空串
      parts.push(encString(TAG.keyword, '', r));
    }
  }
  parts.push(Buffer.from([0x03])); // end-of-attributes
  return Buffer.concat(parts);
}

// 解析响应：只取标量属性，集合类型整体跳过（够用且不易出错）
function parseResponse(buf) {
  if (!buf || buf.length < 8) return { ok: false, status: -1, attrs: {}, error: '响应过短' };
  const version = `${buf[0]}.${buf[1]}`;
  const status = buf.readUInt16BE(2);
  const attrs = {};
  let i = 8;
  let curName = '';
  let curTag = 0;
  const push = (name, tag, val) => {
    if (!name) return;
    if (attrs[name] === undefined) attrs[name] = val;
    else if (Array.isArray(attrs[name])) attrs[name].push(val);
    else attrs[name] = [attrs[name], val];
  };
  while (i < buf.length) {
    const tag = buf[i++];
    if (tag === 0x03) break; // end-of-attributes
    if (tag <= 0x0f) { curName = ''; continue; } // 分隔符（组）
    if (tag === TAG.endCollection) { i += 2; curName = ''; continue; }
    if (i + 2 > buf.length) break;
    const nameLen = buf.readUInt16BE(i);
    i += 2;
    const name = nameLen ? buf.slice(i, i + nameLen).toString('utf8') : curName;
    i += nameLen;
    if (i + 2 > buf.length) break;
    const valLen = buf.readUInt16BE(i);
    i += 2;
    const val = buf.slice(i, i + valLen);
    i += valLen;
    curName = name;
    curTag = tag;
    if (tag === TAG.begCollection) { push(name, tag, ''); continue; }
    let out = '';
    if (tag === TAG.integer || tag === TAG.enum) out = val.length >= 4 ? val.readInt32BE(0) : 0;
    else if (tag === TAG.boolean) out = val.length >= 1 && val[0] === 1;
    else if (tag === TAG.rangeOfInteger) out = val.length >= 8 ? [val.readInt32BE(0), val.readInt32BE(4)] : [];
    else if (tag === TAG.resolution) out = val.length >= 9 ? `${val.readInt32BE(0)}x${val.readInt32BE(4)}dpi` : '';
    else if (tag === TAG.textWithLanguage || tag === TAG.nameWithLanguage) {
      const l1 = val.length >= 2 ? val.readUInt16BE(0) : 0;
      const l2 = val.length >= l1 + 4 ? val.readUInt16BE(l1 + 2) : 0;
      out = val.slice(l1 + 4, l1 + 4 + l2).toString('utf8');
    } else out = val.toString('utf8');
    void curTag;
    push(name, tag, out);
  }
  return { ok: status === 0, status, version, attrs };
}

function postIpp({ host, port, path, secure, body, timeout = 2500 }) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    const mod = secure ? https : http;
    let req;
    try {
      req = mod.request({
        host, port, path: path || '/', method: 'POST',
        headers: { 'Content-Type': 'application/ipp', 'Content-Length': body.length, 'User-Agent': 'PrintGate/2' },
        timeout,
        rejectUnauthorized: false,
        // 打印机常用自签证书；这里只做能力探测，不做信任建立
        servername: net.isIP(host) ? undefined : host
      }, (res) => {
        const chunks = [];
        let size = 0;
        res.on('data', (d) => {
          size += d.length;
          if (size > 1 << 20) { finish({ ok: false, error: '响应过大' }); req.destroy(); return; }
          chunks.push(d);
        });
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          if (res.statusCode !== 200) return finish({ ok: false, error: `HTTP ${res.statusCode}` });
          finish(parseResponse(buf));
        });
      });
    } catch (e) {
      return finish({ ok: false, error: e.message });
    }
    req.on('timeout', () => { req.destroy(); finish({ ok: false, error: '超时' }); });
    req.on('error', (e) => finish({ ok: false, error: e.code || e.message }));
    req.write(body);
    req.end();
  });
}

const PATHS = ['/ipp/print', '/ipp/printer', '/', '/ipp', '/printers', '/ipp/printers'];

// 探测某个 host:port。
// 只要收到「合法 IPP 响应」即可确认对方是 IPP 打印服务，即使状态码不是成功
// （CUPS 用 / 作为根路径时会回 not-found，但它确实是 IPP 服务）。
async function detect(host, port, { timeout = 2500 } = {}) {
  const secure = port === 443 || port === 6310;
  const scheme = secure ? 'ipps' : 'ipp';
  let ippSeen = false;
  let hint = null;
  for (const p of PATHS) {
    const body = buildRequest({ uri: `${scheme}://${host}:${port}${p}` });
    const r = await postIpp({ host, port, path: p, secure, body, timeout });
    if (r.ok) {
      return { ok: true, ipp: true, path: p, secure, version: r.version, attrs: r.attrs, status: r.status };
    }
    if (typeof r.status === 'number' && r.status >= 0) {
      ippSeen = true;
      if (!hint) hint = { path: p, status: r.status };
      continue;
    }
    // HTTP 4xx/5xx 说明是 HTTP 服务但不是 IPP，换下一个端口更合适
    if (r.error && /^HTTP /.test(r.error)) break;
  }
  return { ok: false, ipp: ippSeen, path: hint && hint.path, status: hint && hint.status, secure };
}

function first(v) {
  return Array.isArray(v) ? v[0] : v;
}

function summarize(attrs = {}) {
  const makeModel = String(first(attrs['printer-make-and-model']) || '').trim();
  const info = String(first(attrs['printer-info']) || '').trim();
  const name = String(first(attrs['printer-name']) || '').trim();
  const deviceId = String(first(attrs['printer-device-id']) || '').trim();
  const formats = [].concat(attrs['document-format-supported'] || []).map(String);
  const versions = [].concat(attrs['ipp-versions-supported'] || []).map(String);
  const uris = [].concat(attrs['printer-uri-supported'] || []).map(String);
  const state = first(attrs['printer-state']);
  const reasons = [].concat(attrs['printer-state-reasons'] || []).map(String);
  const color = String(first(attrs['color-supported']) || '');
  const duplex = String(first(attrs['sides-supported']) || '');
  // IPP Everywhere 的硬指标是支持 PWG Raster / URF；只有 PDF 只能算「可能免驱」
  const pwg = formats.some((f) => /pwg-raster|urf/i.test(f));
  const pdf = formats.some((f) => /application\/pdf/i.test(f));
  return {
    name: info || name || makeModel,
    model: makeModel,
    deviceId,
    formats,
    versions,
    uris,
    state,
    reasons,
    color: color === 'true' || color === '',
    duplex: /two-sided/i.test(duplex),
    driverless: pwg,
    pdf
  };
}

module.exports = { detect, parseResponse, buildRequest, postIpp, summarize, PATHS };
