// Office 组件安装进度 + 数据卷持久化验证（对着真容器跑）
// 用法：
//   BASE=http://127.0.0.1:18100 PG_PASS=LocalTest2026 node tools/office-progress-test.js install
//   BASE=... node tools/office-progress-test.js watch      # 只观察（容器重启后自动恢复）
const B = process.env.BASE || 'http://127.0.0.1:18100';
const PW = process.env.PG_PASS || 'LocalTest2026';
const MODE = process.argv[2] || 'install';
const MAX_WAIT_MS = Number(process.env.MAX_WAIT_MS || 45 * 60 * 1000);

let pass = 0, fail = 0;
const rec = (n, ok, d = '') => {
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'} | ${n}${d ? ' | ' + d : ''}`);
};

const j = async (m, p, b, t) => {
  const h = {};
  if (t) h.Authorization = 'Bearer ' + t;
  if (b !== undefined) h['Content-Type'] = 'application/json';
  const r = await fetch(B + p, { method: m, headers: h, body: b === undefined ? undefined : JSON.stringify(b) });
  return { s: r.status, d: await r.json().catch(() => ({})) };
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const login = await j('POST', '/api/auth/login', { password: PW });
  if (!login.d.token) { console.error('登录失败：', JSON.stringify(login.d)); process.exit(1); }
  const tok = login.d.token;

  const before = await j('GET', '/api/settings/office/status', undefined, tok);
  if (!before.d.install) {
    console.error('状态接口异常：', before.s, JSON.stringify(before.d).slice(0, 200));
    process.exit(1);
  }
  console.log('初始状态：available=' + before.d.available + ' cache=' + JSON.stringify(before.d.install.cache));

  if (MODE === 'install') {
    const start = await j('POST', '/api/settings/office/install', undefined, tok);
    rec('安装接口受理', start.s === 200 && start.d.started === true, `${start.s} ${start.d.msg || ''}`);
  }

  const t0 = Date.now();
  let last = -1, samples = 0, sawRunning = false, sawNonZero = false, moved = 0;
  let st = null;
  while (Date.now() - t0 < MAX_WAIT_MS) {
    const r = await j('GET', '/api/settings/office/status', undefined, tok);
    st = r.d.install || {};
    samples++;
    if (st.running) {
      sawRunning = true;
      if (st.percent > 0) sawNonZero = true;
      if (st.percent > last) moved++;
      if (st.percent !== last) {
        console.log(`  [${String(Math.round((Date.now() - t0) / 1000)).padStart(4)}s] ${st.percent}% ${st.phase}`
          + ` ${st.done}/${st.total}${st.restoring ? ' (restore)' : ''}`);
      }
      last = Math.max(last, st.percent);
    } else if (st.finishedAt) {
      break;
    }
    await sleep(3000);
  }

  const total = Math.round((Date.now() - t0) / 1000);
  rec('任务确实跑起来了', sawRunning, `采样 ${samples} 次`);
  rec('进度有推进（不是一条假进度条）', moved >= 2 && sawNonZero, `推进 ${moved} 次`);
  rec('最终可用', st && st.ok === true, `${st && st.msg} (${total}s)`);

  const after = await j('GET', '/api/settings/office/status', undefined, tok);
  rec('检测到 soffice', after.d.available === true, after.d.version || '');
  const cache = (after.d.install && after.d.install.cache) || {};
  rec('安装包已缓存到数据卷', cache.count > 0 && cache.bytes > 0,
    `${cache.count} 个 / ${Math.round((cache.bytes || 0) / 1048576)} MB`);

  console.log(`\n合计 ${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('异常:', e); process.exit(1); });
