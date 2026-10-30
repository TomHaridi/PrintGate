/* PrintGate 移动端（H5 / iOS 壳共用）
 * 直接用同源接口：页面由 PrintGate 服务自己托管在 /m/，所以 API 都是相对路径，
 * 没有 CORS、没有跨域 cookie 问题。登录走 /api/auth/account/login（用户名+密码），
 * 它签发的就是小程序令牌（scope=miniapp），因此可以完整复用 /api/mp/*。
 */
'use strict';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const state = {
  token: localStorage.getItem('pg_token') || '',
  user: null,
  config: {},
  file: null,          // { id, name, pages, size }
  page: 1,
  totalPages: 0,
  previewUrl: '',
  tab: 'print',
  advOpen: false
};

/* ---------------- 基础工具 ---------------- */
let toastTimer = 0;
function toast(msg, ms = 2200) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), ms);
}

function fmtSize(n) {
  const b = Number(n || 0);
  if (!b) return '—';
  if (b < 1024) return b + ' B';
  if (b < 1024 * 1024) return (b / 1024).toFixed(0) + ' KB';
  return (b / 1024 / 1024).toFixed(1) + ' MB';
}

function fmtTime(s) {
  if (!s) return '';
  const d = new Date(String(s).replace(' ', 'T'));
  if (isNaN(d.getTime())) return String(s);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

const STATUS_TEXT = {
  pending: '待审核', printing: '打印中', done: '已完成',
  failed: '失败', canceled: '已取消', rejected: '已拒绝', error: '出错'
};
const STATUS_CLASS = {
  pending: 'warn', printing: '', done: '', failed: 'bad',
  canceled: 'muted', rejected: 'bad', error: 'bad'
};

function setBanner(text) {
  const el = $('#banner');
  if (!text) { el.classList.add('hidden'); el.textContent = ''; return; }
  el.textContent = text;
  el.classList.remove('hidden');
}

/* ---------------- 接口封装 ---------------- */
async function api(path, { method = 'GET', body, form, raw = false } = {}) {
  const headers = {};
  if (state.token) headers.Authorization = 'Bearer ' + state.token;
  let payload;
  if (form) payload = form;
  else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(path, { method, headers, body: payload });
  } catch (e) {
    throw new Error('连不上服务器，请检查网络或服务是否在运行');
  }
  if (res.status === 401) {
    const d = await res.json().catch(() => ({}));
    logout(true, d.msg);
    throw new Error(d.msg || '登录已失效');
  }
  if (raw) return res;
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) {
    const err = new Error(data.msg || `请求失败（${res.status}）`);
    err.status = res.status;
    err.code = data.code;
    throw err;
  }
  return data;
}

/* ---------------- 登录 / 登出 ---------------- */
function showLogin() {
  $('#app').classList.add('hidden');
  $('#login').classList.remove('hidden');
}

async function enterApp() {
  $('#login').classList.add('hidden');
  $('#app').classList.remove('hidden');
  await loadMe();
  await Promise.all([loadPrinters(), refreshTab(state.tab)]);
}

function logout(silent, msg) {
  state.token = '';
  state.user = null;
  localStorage.removeItem('pg_token');
  showLogin();
  if (!silent) toast('已退出登录');
  else if (msg) toast(msg);
}

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('#lg-submit');
  const msg = $('#lg-msg');
  const username = $('#lg-user').value.trim();
  const password = $('#lg-pass').value;
  if (!username || !password) { msg.textContent = '请填写用户名和密码'; return; }
  btn.disabled = true;
  msg.textContent = '';
  try {
    const r = await fetch('/api/auth/account/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    }).then((x) => x.json());
    if (!r.ok) throw new Error(r.msg || '登录失败');
    state.token = r.token;
    state.user = r.user;
    localStorage.setItem('pg_token', r.token);
    $('#lg-pass').value = '';
    await enterApp();
    if (r.needApproval) {
      setBanner('账号还在待审批状态：可以浏览，但上传与打印需要管理员通过后才能使用。');
    }
  } catch (err) {
    msg.textContent = err.message;
  } finally {
    btn.disabled = false;
  }
});

/* ---------------- 我的 ---------------- */
async function loadMe() {
  try {
    const r = await api('/api/mp/me');
    state.user = r.user;
    state.config = r.config || {};
    renderMe();
    updateAdvVisibility();
    const st = r.user.status;
    if (st === 'pending') setBanner('账号待管理员审批：可以浏览，上传与打印暂不可用。');
    else if (st === 'blocked') setBanner('账号已被停用，请联系管理员。');
    else setBanner('');
  } catch (e) { /* 401 已在 api() 里处理 */ }
}

function renderMe() {
  const u = state.user || {};
  const name = u.nickname || u.username || '用户';
  $('#me-avatar').textContent = (name[0] || 'P').toUpperCase();
  $('#me-name').textContent = name;
  $('#me-sub').textContent = (u.role === 'admin' ? '管理员' : '普通用户') + ' · ' + (u.username || '微信账号');
  $('#me-origin').textContent = location.origin;
  $('#me-type').textContent = u.username ? '账号密码' : '微信';
  $('#me-status').textContent = u.status === 'approved' ? '已通过'
    : u.status === 'pending' ? '待审批' : u.status === 'blocked' ? '已停用' : (u.status || '—');
  $('#me-version').textContent = state.version ? 'v' + state.version : '—';
}

$('#btn-logout').addEventListener('click', () => {
  if (!confirm('确定退出登录？')) return;
  logout(false);
});

/* 服务器设置：仅在 iOS 壳里出现（原生桥）
   浏览器里换地址直接改地址栏，没必要给按钮 */
const nativeBridge = (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.pg) || null;
if (nativeBridge) {
  $('#btn-server').classList.remove('hidden');
  $('#btn-server').addEventListener('click', () => nativeBridge.postMessage('setup'));
}

/* 修改密码 */
$('#btn-pass').addEventListener('click', () => {
  openSheet('修改密码', `
    <label class="field"><span>当前密码</span>
      <input id="pw-old" type="password" placeholder="当前密码"></label>
    <label class="field"><span>新密码</span>
      <input id="pw-new" type="password" placeholder="至少 6 位"></label>
    <label class="field"><span>确认新密码</span>
      <input id="pw-new2" type="password" placeholder="再输一次"></label>
    <button class="btn btn-primary btn-block" id="pw-save">保存</button>
  `);
  $('#pw-save').addEventListener('click', async () => {
    const oldPassword = $('#pw-old').value;
    const p1 = $('#pw-new').value;
    const p2 = $('#pw-new2').value;
    if (!oldPassword || !p1) return toast('请填写完整');
    if (p1.length < 6) return toast('新密码至少 6 位');
    if (p1 !== p2) return toast('两次输入的新密码不一致');
    try {
      await api('/api/auth/account/password', { method: 'POST', body: { oldPassword, newPassword: p1 } });
      closeSheet();
      toast('密码已修改，请重新登录');
      setTimeout(() => logout(true), 900);
    } catch (e) { toast(e.message); }
  });
});

/* ---------------- 打印机 ---------------- */
async function loadPrinters() {
  try {
    const r = await api('/api/mp/printers');
    const sel = $('#opt-printer');
    const list = r.printers || [];
    if (!list.length) {
      sel.innerHTML = '<option value="">（没有可用打印机）</option>';
      return;
    }
    sel.innerHTML = list.map((p) => {
      const label = p.name + (p.state && p.state !== 'idle' ? `（${p.state}）` : '');
      return `<option value="${p.name}"${p.name === r.default ? ' selected' : ''}>${label}</option>`;
    }).join('');
  } catch (e) { /* 忽略 */ }
}

/* ---------------- 选文件 / 上传 ---------------- */
$('#btn-pick').addEventListener('click', () => $('#file-input').click());
$('#btn-change').addEventListener('click', () => $('#file-input').click());
$('#btn-photos').addEventListener('click', () => $('#file-input').click());
$('#btn-camera').addEventListener('click', () => $('#camera-input').click());

$('#file-input').addEventListener('change', (e) => handlePicked(Array.from(e.target.files || [])));
$('#camera-input').addEventListener('change', (e) => handlePicked(Array.from(e.target.files || [])));

const MAX_MB = () => Number(state.config.maxFileMB || 200);
const IMG_RE = /\.(jpe?g|png|webp|bmp|gif|heic|heif|tiff?)$/i;

async function handlePicked(files) {
  if (!files.length) return;
  const tooBig = files.find((f) => f.size > MAX_MB() * 1024 * 1024);
  if (tooBig) return toast(`${tooBig.name} 超过 ${MAX_MB()} MB`);
  if (state.user && state.user.status !== 'approved') {
    return toast('账号待审批，暂时不能上传');
  }

  const bar = $('#upload-bar');
  const fill = $('#upload-fill');
  const text = $('#upload-text');
  bar.classList.remove('hidden');
  fill.style.width = '0%';

  try {
    const done = [];
    for (let i = 0; i < files.length; i++) {
      text.textContent = files.length > 1
        ? `上传中 ${i + 1}/${files.length}：${files[i].name}`
        : `上传中：${files[i].name}`;
      const r = await uploadOne(files[i], (pct) => {
        const per = 100 / files.length;
        fill.style.width = Math.min(99, (i * per + pct * per / 100)).toFixed(1) + '%';
      });
      done.push(r.file);
    }
    fill.style.width = '100%';

    // 全是图片且多于一张 → 合成一份多页 PDF（与小程序端一致）
    let file = done[0];
    if (done.length > 1) {
      const allImg = done.every((f) => IMG_RE.test(f.filename || ''));
      if (allImg) {
        text.textContent = '正在合成多页 PDF…';
        const m = await api('/api/mp/files/merge', {
          method: 'POST',
          body: { ids: done.map((f) => f.id), filename: `图片合并-${done.length}张.pdf` }
        });
        file = m.file;
        // 合成后原图没用了，删掉避免占空间
        for (const f of done) {
          api(`/api/mp/files/${f.id}`, { method: 'DELETE' }).catch(() => {});
        }
      } else {
        toast(`一次只能打印一个文档，已使用第一个（共选了 ${done.length} 个）`);
      }
    }

    useFile(file);
    toast('已就绪，可以打印');
  } catch (e) {
    toast(e.message || '上传失败');
  } finally {
    bar.classList.add('hidden');
    $('#file-input').value = '';
    $('#camera-input').value = '';
  }
}

function uploadOne(file, onProgress) {
  return new Promise((resolve, reject) => {
    const fd = new FormData();
    // 服务端按 filename 记展示名；iOS 给的是真实文件名，这里照传
    fd.append('filename', file.name || '文件');
    fd.append('file', file, file.name || 'file');

    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/mp/files');
    if (state.token) xhr.setRequestHeader('Authorization', 'Bearer ' + state.token);
    xhr.upload.onprogress = (ev) => {
      if (ev.lengthComputable && onProgress) onProgress((ev.loaded / ev.total) * 100);
    };
    xhr.onload = () => {
      let d = {};
      try { d = JSON.parse(xhr.responseText); } catch (_) {}
      if (xhr.status === 401) { logout(true); return reject(new Error('登录已失效')); }
      if (xhr.status >= 200 && xhr.status < 300 && d.ok) return resolve(d);
      reject(new Error(d.msg || `上传失败（${xhr.status}）`));
    };
    xhr.onerror = () => reject(new Error('上传失败，请检查网络'));
    xhr.ontimeout = () => reject(new Error('上传超时'));
    xhr.timeout = 180000;
    xhr.send(fd);
  });
}

// 预览拿不到时（服务端缺渲染器 / 格式不支持），用扩展名占位，别留白框
function thumbPlaceholder() {
  const img = $('#thumb-img');
  img.removeAttribute('src');
  const box = img.parentElement;
  const ext = (state.file && state.file.name ? state.file.name.split('.').pop() : 'file') || 'file';
  box.dataset.ext = ext.slice(0, 4).toUpperCase();
  box.classList.add('is-empty');
}

function useFile(f) {
  state.file = { id: f.id, name: f.filename || f.name || '文件', pages: f.pages || 0, size: f.size || 0 };
  state.page = 1;
  state.totalPages = f.pages || 1;
  $('#pick-empty').classList.add('hidden');
  $('#pick-file').classList.remove('hidden');
  $('#clear-file').classList.remove('hidden');
  $('#file-name').textContent = state.file.name;
  $('#file-sub').textContent = `${fmtSize(state.file.size)} · ${state.file.pages ? state.file.pages + ' 页' : '页数未知'}`;
  $('#pager').classList.toggle('hidden', !(state.file.pages > 1));
  thumbPlaceholder();
  loadPreview();
}

function clearFile() {
  state.file = null;
  state.page = 1;
  state.totalPages = 0;
  $('#pick-empty').classList.remove('hidden');
  $('#pick-file').classList.add('hidden');
  $('#clear-file').classList.add('hidden');
  const img = $('#thumb-img');
  img.removeAttribute('src');
  const ext = (state.file.name.split('.').pop() || 'file').slice(0, 4).toUpperCase();
  const box = img.parentElement;
  box.classList.add('is-empty');
  box.dataset.ext = ext;
}

$('#clear-file').addEventListener('click', clearFile);

/* 预览：分页拉图，需要带 Authorization，所以用 fetch → blob */
async function loadPreview() {
  if (!state.file) return;
  const id = state.file.id;
  const page = state.page;
  $('#pg-label').textContent = `${page} / ${state.totalPages || state.file.pages || 1}`;
  try {
    const res = await api(`/api/mp/files/${id}/preview?page=${page}`, { raw: true });
    if (!res.ok) throw new Error('预览不可用');
    const total = Number(res.headers.get('X-Total-Pages') || 0);
    if (total) {
      state.totalPages = total;
      $('#pg-label').textContent = `${page} / ${total}`;
      $('#pager').classList.toggle('hidden', total <= 1);
    }
    $('#thumb-img').parentElement.classList.remove('is-empty');
    const blob = await res.blob();
    if (state.previewUrl) URL.revokeObjectURL(state.previewUrl);
    state.previewUrl = URL.createObjectURL(blob);
    $('#thumb-img').src = state.previewUrl;
  } catch (e) {
    // 预览失败不阻塞打印（例如服务端缺 pdftoppm 渲染器）
    thumbPlaceholder();
  }
}

$('#pg-prev').addEventListener('click', () => {
  if (state.page <= 1) return;
  state.page--; loadPreview();
});
$('#pg-next').addEventListener('click', () => {
  if (state.page >= (state.totalPages || 1)) return;
  state.page++; loadPreview();
});

/* ---------------- 打印设置 ---------------- */
$$('.stepper button').forEach((b) => b.addEventListener('click', () => {
  const input = $('#opt-copies');
  const v = Math.max(1, Math.min(99, (parseInt(input.value, 10) || 1) + Number(b.dataset.step)));
  input.value = v;
}));

$$('.seg').forEach((seg) => seg.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-v]');
  if (!btn) return;
  $$('button', seg).forEach((b) => b.classList.toggle('on', b === btn));
}));

function segValue(id, fallback) {
  const on = $(`#${id} .on`);
  return on ? on.dataset.v : fallback;
}

$('#toggle-adv').addEventListener('click', () => {
  state.advOpen = !state.advOpen;
  $('#adv').classList.toggle('hidden', !state.advOpen);
  $('#toggle-adv').textContent = state.advOpen ? '收起' : '高级';
});

function updateAdvVisibility() {
  // 服务端若对普通用户隐藏高级参数，这里也不展示过多选项
  const show = state.config.advancedPrint !== false || (state.user && state.user.role === 'admin');
  $('#toggle-adv').classList.toggle('hidden', !show);
  if (!show) { $('#adv').classList.add('hidden'); state.advOpen = false; }
  updateAdvVisibility.done = true;
}

$('#btn-print').addEventListener('click', async () => {
  if (!state.file) return toast('请先选择文件');
  const printer = $('#opt-printer').value;
  if (!printer) return toast('没有可用打印机');
  const btn = $('#btn-print');
  btn.disabled = true;
  const payload = {
    fileId: state.file.id,
    printer,
    options: {
      copies: parseInt($('#opt-copies').value, 10) || 1,
      sides: $('#opt-sides').value,
      color: segValue('opt-color', 'mono'),
      media: state.advOpen ? $('#opt-media').value : 'A4',
      orientation: state.advOpen ? segValue('opt-orient', 'portrait') : 'portrait',
      pageRanges: state.advOpen ? $('#opt-ranges').value.trim() : '',
      numberUp: state.advOpen ? Number($('#opt-numberup').value) : 1,
      watermark: state.advOpen ? $('#opt-watermark').value.trim() : ''
    }
  };
  try {
    const r = await api('/api/mp/print', { method: 'POST', body: payload });
    toast(r.approvalRequired ? '已提交，等待管理员审核' : '已提交打印');
    state.file = null;
    clearFile();
    switchTab('tasks');
    loadTasks();
  } catch (e) {
    toast(e.message);
  } finally {
    btn.disabled = false;
  }
});

/* ---------------- 文件列表 ---------------- */
async function loadFiles() {
  const box = $('#files-list');
  try {
    const r = await api('/api/mp/files');
    const list = r.files || [];
    if (!list.length) {
      box.innerHTML = '<div class="empty">还没有上传过文件</div>';
      return;
    }
    box.innerHTML = list.map((f) => `
      <div class="item" data-id="${f.id}">
        <div class="item-top">
          <div class="item-name" title="${esc(f.filename)}">${esc(f.filename)}</div>
          <span class="badge muted">${f.pages ? f.pages + ' 页' : '—'}</span>
        </div>
        <div class="item-sub">${fmtSize(f.size)} · ${fmtTime(f.created_at)}</div>
        <div class="item-actions">
          <button class="mini-btn" data-act="print">打印</button>
          <button class="mini-btn danger" data-act="del">删除</button>
        </div>
      </div>`).join('');
  } catch (e) {
    box.innerHTML = `<div class="empty">${esc(e.message)}</div>`;
  }
}

$('#files-list').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const card = btn.closest('.item');
  const id = Number(card.dataset.id);
  const name = $('.item-name', card).textContent;
  if (btn.dataset.act === 'del') {
    if (!confirm(`删除「${name}」？`)) return;
    try {
      await api(`/api/mp/files/${id}`, { method: 'DELETE' });
      toast('已删除');
      loadFiles();
    } catch (err) { toast(err.message); }
    return;
  }
  // 打印：取该文件信息后回到打印页
  try {
    const r = await api('/api/mp/files');
    const f = (r.files || []).find((x) => x.id === id);
    if (!f) return toast('文件不存在');
    useFile(f);
    switchTab('print');
  } catch (err) { toast(err.message); }
});

/* ---------------- 打印记录 ---------------- */
async function loadTasks() {
  const box = $('#tasks-list');
  try {
    const r = await api('/api/mp/tasks');
    const list = r.tasks || [];
    state.tasks = list;
    if (!list.length) {
      box.innerHTML = '<div class="empty">还没有打印记录</div>';
      return;
    }
    box.innerHTML = list.map((t) => {
      const st = STATUS_TEXT[t.status] || t.status;
      const cls = STATUS_CLASS[t.status] || 'muted';
      const canCancel = ['pending', 'printing'].includes(t.status);
      return `
        <div class="item" data-id="${t.id}">
          <div class="item-top">
            <div class="item-name" title="${esc(t.filename || '')}">${esc(t.filename || '（文件已删除）')}</div>
            <span class="badge ${cls}">${esc(st)}</span>
          </div>
          <div class="item-sub">${esc(t.printer || '—')} · ${t.copies || 1} 份 · ${fmtTime(t.created_at)}</div>
          ${t.error ? `<div class="item-sub" style="color:var(--pg-danger)">${esc(t.error)}</div>` : ''}
          ${canCancel ? `<div class="item-actions"><button class="mini-btn danger" data-act="cancel">取消打印</button></div>` : ''}
        </div>`;
    }).join('');
  } catch (e) {
    box.innerHTML = `<div class="empty">${esc(e.message)}</div>`;
  }
}

$('#tasks-list').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-act="cancel"]');
  if (!btn) return;
  const id = Number(btn.closest('.item').dataset.id);
  if (!confirm('取消这个打印任务？')) return;
  try {
    await api(`/api/mp/tasks/${id}/cancel`, { method: 'POST' });
    toast('已取消');
    loadTasks();
  } catch (err) { toast(err.message); }
});

/* ---------------- 弹层 ---------------- */
function openSheet(title, html) {
  $('#sheet-title').textContent = title;
  $('#sheet-body').innerHTML = html;
  $('#sheet').classList.remove('hidden');
  $('#sheet-mask').classList.remove('hidden');
}
function closeSheet() {
  $('#sheet').classList.add('hidden');
  $('#sheet-mask').classList.add('hidden');
  $('#sheet-body').innerHTML = '';
}
$('#sheet-close').addEventListener('click', closeSheet);
$('#sheet-mask').addEventListener('click', closeSheet);

/* ---------------- Tab ---------------- */
const TAB_TITLE = { print: '打印', files: '我的文件', tasks: '打印记录', me: '我的' };

function switchTab(tab) {
  state.tab = tab;
  $$('.tabbar button').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
  ['print', 'files', 'tasks', 'me'].forEach((t) => {
    $('#v-' + t).classList.toggle('hidden', t !== tab);
  });
  $('#tb-title').textContent = TAB_TITLE[tab] || '';
  $('#tb-sub').textContent = tab === 'print'
    ? (state.user ? `当前账号：${state.user.nickname || state.user.username || ''}` : '')
    : tab === 'me' ? '' : '点右上角刷新可更新';
  window.scrollTo(0, 0);
}

function refreshTab(tab) {
  if (tab === 'files') return loadFiles();
  if (tab === 'tasks') return loadTasks();
  if (tab === 'me') return loadMe();
  return Promise.resolve();
}

$('#tabbar').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-tab]');
  if (!btn) return;
  switchTab(btn.dataset.tab);
  refreshTab(btn.dataset.tab);
});

$('#tb-refresh').addEventListener('click', async () => {
  await refreshTab(state.tab);
  toast('已刷新');
});

/* ---------------- 启动 ---------------- */
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

(async function boot() {
  // 版本号展示
  try {
    const v = await fetch('/api/health').then((r) => r.json());
    state.version = v.version || '';
    $('#lg-ver').textContent = v.app === 'PrintGate' ? `服务：PrintGate v${v.version}` : '';
  } catch (_) { /* 忽略 */ }

  if (!state.token) { showLogin(); return; }
  try {
    await enterApp();
  } catch (e) {
    showLogin();
  }
})();
