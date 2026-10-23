'use strict';
// 测试用假 IPP 打印机：监听 631(IPP) + 9100(RAW)，返回足够完整的 Get-Printer-Attributes，
// 使 CUPS 的 IPP Everywhere(driverless) 能真正生成 PPD 并建队列。
// 用法：node tools/mock-ipp.js [port]
const http = require('http');
const net = require('net');

const MODEL = process.env.MOCK_MODEL || 'HP LaserJet 1022';
const DEVICE_ID = process.env.MOCK_DEVICE_ID || 'MFG:HP;MDL:HP LaserJet 1022;CMD:PCL5C,PCLXL;';
const PORT = Number(process.argv[2] || 631);

function attr(tag, name, valueBuf) {
  const n = Buffer.from(name || '', 'utf8');
  const head = Buffer.alloc(3);
  head.writeUInt8(tag, 0);
  head.writeUInt16BE(n.length, 1);
  const len = Buffer.alloc(2);
  len.writeUInt16BE(valueBuf.length, 0);
  return Buffer.concat([head, n, len, valueBuf]);
}
const str = (tag, name, v) => attr(tag, name, Buffer.from(String(v), 'utf8'));
const kw = (name, v) => str(0x44, name, v);
const text = (name, v) => str(0x41, name, v);
const mime = (name, v) => str(0x49, name, v);
const nameAttr = (n, v) => str(0x42, n, v);
const bool = (name, v) => attr(0x22, name, Buffer.from([v ? 1 : 0]));
const en = (name, v) => {
  const b = Buffer.alloc(4);
  b.writeInt32BE(v, 0);
  return attr(0x23, name, b);
};
const res = (name, dpi) => {
  const b = Buffer.alloc(9);
  b.writeInt32BE(dpi, 0);
  b.writeInt32BE(dpi, 4);
  b.writeUInt8(3, 8); // dpi
  return attr(0x32, name, b);
};

function buildResponse(requestId) {
  const head = Buffer.from([0x01, 0x01, 0x00, 0x00]);
  const rid = Buffer.alloc(4);
  rid.writeUInt32BE(requestId, 0);
  const p = [head, rid];

  p.push(Buffer.from([0x01])); // operation attributes
  p.push(str(0x47, 'attributes-charset', 'utf-8'));
  p.push(str(0x48, 'attributes-natural-language', 'en'));
  p.push(str(0x48, 'natural-language-configured', 'en'));
  p.push(str(0x47, 'charset-configured', 'utf-8'));
  p.push(str(0x47, 'charset-supported', 'utf-8'));
  p.push(kw('generated-natural-language-supported', 'en'));

  p.push(Buffer.from([0x02])); // printer attributes
  p.push(nameAttr('printer-name', 'MockPrinter'));
  p.push(text('printer-info', MODEL));
  p.push(text('printer-make-and-model', MODEL));
  p.push(text('printer-location', 'PrintGate 测试'));
  p.push(text('printer-device-id', DEVICE_ID));
  p.push(str(0x45, 'printer-uri-supported', `ipp://127.0.0.1:${PORT}/ipp/print`));
  p.push(kw('uri-security-supported', 'none'));
  p.push(kw('uri-authentication-supported', 'none'));
  p.push(kw('ipp-versions-supported', '1.1'));
  p.push(kw('ipp-versions-supported', '2.0'));
  p.push(kw('ipp-features-supported', 'ipp-everywhere'));
  p.push(bool('printer-is-accepting-jobs', true));
  p.push(en('printer-state', 3));
  p.push(kw('printer-state-reasons', 'none'));
  p.push(bool('color-supported', false));
  p.push(kw('print-color-mode-supported', 'monochrome'));
  p.push(kw('print-color-mode-default', 'monochrome'));
  p.push(mime('document-format-supported', 'application/octet-stream'));
  p.push(mime('document-format-default', 'application/octet-stream'));
  p.push(kw('media-supported', 'iso_a4_210x297mm'));
  p.push(kw('media-supported', 'na_letter_8.5x11in'));
  p.push(kw('media-default', 'iso_a4_210x297mm'));
  p.push(kw('media-ready', 'iso_a4_210x297mm'));
  p.push(res('printer-resolution-supported', 300));
  p.push(res('printer-resolution-supported', 600));
  p.push(res('printer-resolution-default', 300));
  p.push(kw('sides-supported', 'one-sided'));
  p.push(kw('sides-supported', 'two-sided-long-edge'));
  p.push(kw('sides-default', 'one-sided'));
  p.push(en('copies-supported', 99));
  p.push(en('copies-default', 1));
  for (const op of [0x0002, 0x0004, 0x0005, 0x0006, 0x0008, 0x0009, 0x000a, 0x000b, 0x000d]) {
    p.push(en('operations-supported', op));
  }
  p.push(Buffer.from([0x03]));
  return Buffer.concat(p);
}

http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (d) => chunks.push(d));
  req.on('end', () => {
    const buf = Buffer.concat(chunks);
    console.log('IPP', req.method, req.url, buf.length, 'bytes');
    const requestId = buf.length >= 8 ? buf.readUInt32BE(4) : 1;
    const body = buildResponse(requestId);
    res.writeHead(200, { 'Content-Type': 'application/ipp', 'Content-Length': body.length });
    res.end(body);
  });
}).listen(PORT, () => console.log(`mock IPP printer on ${PORT} model=${MODEL}`));

net.createServer((sock) => {
  sock.on('data', (d) => console.log('RAW', d.length, 'bytes'));
  sock.on('error', () => {});
}).listen(9100, () => console.log('mock RAW on 9100'));
