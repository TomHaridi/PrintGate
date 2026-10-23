'use strict';
// 模拟一台「IPP 响应带非法 attributes-natural-language」的打印机（Canon MF650C 固件 bug）。
// 用途：判别 CUPS 在「已指定 PPD」时是否仍会向打印机查询属性。
//   BROKEN=1 → 按真实抓包返回 "en-  "（CUPS 会报 Bad naturalLanguage value）
//   BROKEN=0 → 返回合法的 "en"（对照组）
const http = require('http');
const fsx = require('fs');

const PORT = Number(process.env.PORT || 6311);
const BROKEN = process.env.BROKEN !== '0';
const PATH = process.env.PATH || '/ipp/print';
const LOG = process.env.LOG || '/tmp/mock-requests.log';

function log(line) { try { fsx.appendFileSync(LOG, line + String.fromCharCode(10)); } catch (_) {} }

// IPP 值标签
const T = {
  charset: 0x47, naturalLanguage: 0x48,
  integer: 0x21, boolean: 0x22, keyword: 0x44, text: 0x41,
  uri: 0x45, operationAttrs: 0x01, printerAttrs: 0x04, end: 0x03
};

function strAttr(tag, name, value) {
  const n = Buffer.from(name, 'latin1');
  const v = Buffer.from(value, 'latin1');
  const head = Buffer.alloc(2); head.writeUInt16BE(n.length, 0);
  const vhead = Buffer.alloc(2); vhead.writeUInt16BE(v.length, 0);
  return Buffer.concat([Buffer.from([tag]), head, n, vhead, v]);
}

function intAttr(name, value) {
  const n = Buffer.from(name, 'latin1');
  const head = Buffer.alloc(2); head.writeUInt16BE(n.length, 0);
  const v = Buffer.alloc(4); v.writeInt32BE(value, 0);
  const vhead = Buffer.alloc(2); vhead.writeUInt16BE(4, 0);
  return Buffer.concat([Buffer.from([T.integer]), head, n, vhead, v]);
}

function boolAttr(name, value) {
  const n = Buffer.from(name, 'latin1');
  const head = Buffer.alloc(2); head.writeUInt16BE(n.length, 0);
  const vhead = Buffer.alloc(2); vhead.writeUInt16BE(1, 0);
  return Buffer.concat([Buffer.from([T.boolean]), head, n, vhead, Buffer.from([value ? 1 : 0])]);
}

function buildResponse(reqBuf) {
  const version = reqBuf.slice(0, 2);
  const reqId = reqBuf.slice(4, 8);
  const status = Buffer.alloc(2); status.writeUInt16BE(0x0000, 0); // successful-ok
  const parts = [version, status, reqId, Buffer.from([T.operationAttrs])];
  parts.push(strAttr(T.charset, 'attributes-charset', 'utf-8'));
  parts.push(strAttr(T.naturalLanguage, 'attributes-natural-language', BROKEN ? 'en-  ' : 'en'));
  parts.push(Buffer.from([T.printerAttrs]));
  parts.push(intAttr('printer-state', 3));
  parts.push(strAttr(T.keyword, 'printer-state-reasons', 'none'));
  parts.push(boolAttr('printer-is-accepting-jobs', true));
  parts.push(strAttr(T.keyword, 'document-format-supported', 'application/pdf'));
  parts.push(strAttr(T.keyword, 'document-format-supported', 'image/urf'));
  parts.push(strAttr(T.keyword, 'document-format-supported', 'image/pwg-raster'));
  parts.push(strAttr(T.uri, 'printer-uri-supported', `ipp://127.0.0.1:${PORT}${PATH}`));
  parts.push(strAttr(T.text, 'printer-make-and-model', 'Canon MF650C Series'));
  parts.push(strAttr(T.keyword, 'ipp-versions-supported', '1.1'));
  parts.push(strAttr(T.keyword, 'ipp-versions-supported', '2.0'));
  parts.push(Buffer.from([T.end]));
  return Buffer.concat(parts);
}

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const reqBuf = Buffer.concat(chunks);
    const ver = reqBuf.length >= 2 ? `${reqBuf[0]}.${reqBuf[1]}` : '?';
    const op = reqBuf.length >= 4 ? reqBuf.readUInt16BE(2) : -1;
    log(`${new Date().toISOString()} ${req.method} ${req.url} len=${reqBuf.length} ipp=${ver} op=0x${(op >>> 0).toString(16)}`);
    const resp = buildResponse(reqBuf);
    res.writeHead(200, { 'Content-Type': 'application/ipp', 'Content-Length': resp.length });
    res.end(resp);
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`mock-ipp listening on 127.0.0.1:${PORT}${PATH} broken=${BROKEN}`);
});
