// 局域网发现 PrintGate 服务
//
// 先说清能力边界：微信小程序没有 raw socket，拿不到本机 IP / 网关（wx.getConnectedWifi
// 只给 SSID/BSSID），也不能发 UDP 广播或 ARP。所以"扫描"只能是**对候选地址做 HTTP 探测**：
// 猜常见的私有网段 + 常见主机位 + 常见端口，请求 /api/health，返回里带 app=PrintGate 才算命中。
//
// 另一个硬限制：真机上只有备案过的 https 域名能发请求（局域网 http 会被域名校验拦掉），
// 所以这个功能在「开发者工具（勾了不校验合法域名）」或「真机调试模式」下才真正有意义。
const PORT_MAIN = 8080;
const PORT_ALT = [80, 8000, 3000];

// 常见家用/办公网段
const SUBNETS = [
  '192.168.1.', '192.168.0.', '192.168.31.', '192.168.2.', '192.168.3.', '192.168.4.',
  '10.0.0.', '10.0.1.', '10.1.1.', '172.16.0.'
];
// 网关位（路由器/服务器常在这两个位置）
const GATEWAY_HOSTS = ['1', '254'];
// 常见服务器位（NAS、服务器、虚拟机常分配到低位或 .100 段）
const SERVER_HOSTS = ['2', '10', '50', '100', '101', '102', '110', '200'];

function probe(base, timeout = 800) {
  return new Promise((resolve) => {
    wx.request({
      url: `${base}/api/health`,
      method: 'GET',
      timeout,
      success: (r) => {
        const d = r.data || {};
        if (r.statusCode === 200 && d.ok && /printgate/i.test(String(d.app || ''))) {
          resolve({ ok: true, base, version: d.version || '' });
        } else {
          resolve({ ok: false });
        }
      },
      fail: () => resolve({ ok: false })
    });
  });
}

// 生成候选地址；prefix 形如 "192.168.123." 时按该网段全扫（只探 8080，否则数量爆炸）
function candidates(prefix) {
  const p = String(prefix || '').trim();
  const out = [];
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.$/.test(p)) {
    for (let i = 1; i <= 254; i++) out.push(`http://${p}${i}:${PORT_MAIN}`);
    return out;
  }
  // 本机联调（开发者工具里最先命中，省得等）
  out.push(`http://127.0.0.1:${PORT_MAIN}`, 'http://127.0.0.1:80');
  // 第一轮：网关位（快，几十个请求就出结果）
  for (const sn of SUBNETS) {
    for (const h of GATEWAY_HOSTS) {
      out.push(`http://${sn}${h}:${PORT_MAIN}`);
      for (const port of PORT_ALT) out.push(`http://${sn}${h}:${port}`);
    }
  }
  // 第二轮：常见服务器位
  for (const sn of SUBNETS) {
    for (const h of SERVER_HOSTS) {
      out.push(`http://${sn}${h}:${PORT_MAIN}`);
      out.push(`http://${sn}${h}:80`);
    }
  }
  return out;
}

// 有限并发跑探测池：命中立刻回调，用户可以边扫边选
async function scan({ prefix = '', concurrency = 8, onProgress, onFound, shouldStop } = {}) {
  const list = candidates(prefix);
  let idx = 0;
  let scanned = 0;
  const found = [];

  const worker = async () => {
    while (idx < list.length) {
      if (shouldStop && shouldStop()) return;
      const base = list[idx++];
      const r = await probe(base);
      scanned++;
      if (r.ok && !found.some((x) => x.base === r.base)) {
        found.push(r);
        if (onFound) onFound(r, found);
      }
      if (onProgress && (scanned % 3 === 0 || scanned === list.length)) {
        onProgress(scanned, list.length, found.length);
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, list.length) }, worker));
  return { found, total: list.length };
}

// 校验单个地址（用户从历史里点选时用）
async function check(base) {
  const b = String(base || '').replace(/\/+$/, '');
  if (!b) return { ok: false };
  return probe(b, 3000);
}

module.exports = { scan, check, candidates };
