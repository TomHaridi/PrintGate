'use strict';
// 直接向打印机的 IPP 端口发请求，看它到底返回什么。
// 用法：node ipp-probe.js <host> [port] [path]
const http = require('http');

const host = process.argv[2] || '192.168.31.38';
const port = Number(process.argv[3] || 631);
const ippPath = process.argv[4] || '/ipp/print';

const T = {
  charset: 0x47, naturalLanguage: 0x48, integer: 0x21, boolean: 0x22,
  keyword: 0x44, text: 0x41, uri: 0x45, operationAttrs: 0x01, printerAttrs: 0x04, end: 0x03
};

function strAttr(tag, name, value) {
  const n = Buffer.from(name, 'latin1');
  const v = Buffer.from(value, 'latin1');
  const head = Buffer.alloc(2); head.writeUInt16BE(n.length, 0);
  const vhead = Buffer.alloc(2); vhead.writeUInt16BE(v.length, 0);
  return Buffer.concat([Buffer.from([tag]), head, n, vhead, v]);
}

// Get-Printer-Attributes (0x000B)
function buildRequest(version) {
  const parts = [
    Buffer.from([version[0], version[1]]),
    (() => { const b = Buffer.alloc(2); b.writeUInt16BE(0x000b, 0); return b; })(),
    (() => { const b = Buffer.alloc(4); b.writeUInt32BE(1, 0); return b; })(),
    Buffer.from([T.operationAttrs]),
    strAttr(T.charset, 'attributes-charset', 'utf-8'),
    strAttr(T.naturalLanguage, 'attributes-natural-language', 'en'),
    strAttr(T.uri, 'printer-uri', `ipp://${host}:${port}${ippPath}`),
    strAttr(T.keyword, 'requested-attributes', 'printer-make-and-model'),
    strAttr(T.keyword, 'requested-attributes', 'ipp-versions-supported'),
    strAttr(T.keyword, 'requested-attributes', 'document-format-supported'),
    strAttr(T.keyword, 'requested-attributes', 'printer-state'),
    Buffer.from([T.end])
  ];
  return Buffer.concat(parts);
}

function describe(buf) {
  const out = [];
  if (buf.length < 8) return '（太短，不是 IPP）';
  out.push(`版本=${buf[0]}.${buf[1]} 状态=0x${buf.readUInt16BE(2).toString(16)} request-id=${buf.readUInt32BE(4)}`);
  let i = 8;
  let group = 'operation';
  while (i < buf.length) {
    const tag = buf[i]; i += 1;
    if (tag === 0x03) { out.push('  [end-of-attributes]'); break; }
    if (tag === 0x01) { group = 'operation'; continue; }
    if (tag === 0x02) { group = 'job'; continue; }
    if (tag === 0x04) { group = 'printer'; continue; }
    if (tag === 0x05) { group = 'unsupported'; continue; }
    if (i + 2 > buf.length) break;
    const nlen = buf.readUInt16BE(i); i += 2;
    const name = buf.slice(i, i + nlen).toString('latin1'); i += nlen;
    if (i + 2 > buf.length) break;
    const vlen = buf.readUInt16BE(i); i += 2;
    const val = buf.slice(i, i + vlen); i += vlen;
    let show;
    if (tag === T.integer) show = val.length >= 4 ? String(val.readInt32BE(0)) : '(?)';
    else if (tag === T.boolean) show = val.length ? String(val[0]) : '(?)';
    else show = JSON.stringify(val.toString('latin1'));
    out.push(`  [${group}] ${name} = ${show}   (tag=0x${tag.toString(16)})`);
  }
  return out.join('\n');
}

function attempt(version, label) {
  return new Promise((resolve) => {
    const req = http.request({
      host, port, path: ippPath, method: 'POST',
      headers: { 'Content-Type': 'application/ipp', 'Content-Length': buildRequest(version).length }
    }, (res) => {
      const chunks = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        console.log(`\n===== ${label}（IPP ${version[0]}.${version[1]}）=====`);
        console.log(`HTTP ${res.statusCode} ${res.statusMessage} | Content-Type=${res.headers['content-type']} | ${buf.length} 字节`);
        console.log(describe(buf));
        resolve();
      });
    });
    req.on('error', (e) => { console.log(`\n===== ${label} =====\n连接失败：${e.message}`); resolve(); });
    req.setTimeout(10000, () => { req.destroy(); console.log(`\n===== ${label} =====\n超时`); resolve(); });
    req.end(buildRequest(version));
  });
}

(async () => {
  console.log(`目标：http://${host}:${port}${ippPath}`);
  await attempt([2, 0], '先按 IPP 2.0 请求');
  await attempt([1, 1], '再按 IPP 1.1 请求（CUPS 2.x 常用）');
})();
