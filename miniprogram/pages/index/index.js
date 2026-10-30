// 发起打印（首页）：标准打印 / 文字速印 / 发票合排 / 身份证打印，卡片风格 + 暗夜
// 文字/发票/身份证后端是 requireAdmin 接口（小程序 token 不认），改为端上 canvas 合成后
// 走既有 /api/mp/files + /api/mp/print，后端零改动。
const api = require('../../services/api');
const { formatSize, printerState, optionsSummary, extOf } = require('../../utils/format');
const comp = require('../../utils/compose');

const MEDIA_LIST = ['A4', 'A3', 'A5', 'A6', 'Letter', 'Legal', 'B5', '16K'];
const NUMBER_UP_LIST = [1, 2, 4, 6, 9, 16];
const SCALING_LIST = [{ v: 'auto', t: '自动' }, { v: 'fit', t: '适应' }, { v: 'fill', t: '填充' }, { v: 'none', t: '原始' }];

const DEFAULT_OPTIONS = {
  copies: 1, color: 'mono', sides: 'one-sided', media: 'A4', orientation: 'portrait',
  pageRanges: '', numberUp: 1, numberUpLayout: 'lrtb', scaling: 'fit',
  pageSet: 'all', mirror: false, pageBorder: false, watermark: ''
};

const PAGE_SET_LIST = [
  { v: 'all', t: '全部' }, { v: 'odd', t: '奇数页' }, { v: 'even', t: '偶数页' }, { v: 'even-reverse', t: '偶数倒序' }
];

const MODES = [
  { key: 'file', label: '标准打印' },
  { key: 'text', label: '文字速印' },
  { key: 'invoice', label: '发票合排' },
  { key: 'idcard', label: '身份证' }
];

// 发票每页张数
const INVOICE_PER = [
  { v: 1, t: '1 张/页' }, { v: 2, t: '2 张/页' }, { v: 4, t: '4 张/页' }
];

// WXML 不能调用页面方法，展示字段一律在 JS 里算好
function decorateFileCard(f) {
  if (!f) return f;
  return Object.assign({}, f, {
    _ext: (extOf(f.filename) || 'bin').toUpperCase(),
    _sizeMeta: `${formatSize(f.size)}${f.pages ? ` · ${f.pages} 页` : ''}`
  });
}

function decoratePrinter(p) {
  const st = printerState(p.state);
  return Object.assign({}, p, { _state: st.text, _stateKind: st.kind });
}

Page({
  data: {
    dark: false,
    primaryStyle: '', user: null, approved: false, baseReady: true,
    greeting: '你好', today: '',
    printers: [], selectedPrinter: '',
    // 模式
    modes: MODES, mode: 'file',
    // 标准打印
    file: null, previewPath: '', previewLoading: false, previewErr: '',
    previewPage: 1,        // 多页文档当前预览页（原生预览只能看一张，这里手动翻）
    // 文字速印
    textBody: '', textTitle: '', textFont: 12, textLines: 0,
    // 发票
    invoiceImages: [], invoicePer: 2,
    // 身份证
    idFront: null, idBack: null,
    // 合成产物（文字/发票/身份证共用）
    composedPath: '',
    options: Object.assign({}, DEFAULT_OPTIONS),
    maxCopies: 99, maxFileMB: 20,
    uploading: false, submitting: false, composing: false,
    mediaList: MEDIA_LIST, numberUpList: NUMBER_UP_LIST, scalingList: SCALING_LIST,
    pageSetList: PAGE_SET_LIST, invoicePerList: INVOICE_PER,
    summaryLine1: '未选择打印机', summaryLine2: '', canSubmit: false
  },

  onLoad() {
    const d = new Date();
    const h = d.getHours();
    this.setData({
      greeting: h < 6 ? '夜深了' : h < 11 ? '早上好' : h < 14 ? '中午好' : h < 18 ? '下午好' : '晚上好',
      today: `${d.getMonth() + 1}月${d.getDate()}日`
    });
  },

  onShow() {
    const app = getApp();
    this.setData({ dark: app.isDark(), primaryStyle: app.primaryStyle() });
    if (!app.globalData.token) { wx.reLaunch({ url: '/pages/login/login' }); return; }
    this.setData({ baseReady: !!app.globalData.baseUrl });
    this.syncAll();
    const pending = app.takePendingFile();
    if (pending && pending.id) {
      // 从「我的文件」带过来的对象没有 _ext/_sizeMeta，必须补齐，否则卡片上体积页数是空的
      this.setData({ mode: 'file', file: decorateFileCard(pending), previewPage: 1 }, () => {
        this.loadPreview();
        this.refreshSummary();
      });
    }
  },

  onPullDownRefresh() { this.syncAll().finally(() => wx.stopPullDownRefresh()); },

  syncAll() {
    const app = getApp();
    return Promise.all([
      app.refreshUser().then((u) => {
        if (!u) return;
        const c = app.globalData.config || {};
        const maxCopies = c.maxCopies || 99;
        this.setData({
          user: u, approved: u.status === 'approved', maxCopies,
          maxFileMB: c.maxFileMB || 20,
          options: Object.assign({}, this.data.options, { copies: Math.min(this.data.options.copies, maxCopies) })
        });
      }),
      app.refreshPrinters().then((d) => this.applyPrinters(d))
    ]).then(() => this.refreshSummary());
  },

  applyPrinters(d, cb) {
    const printers = ((d && d.printers) || []).filter((p) => p && p.name).map(decoratePrinter);
    let sel = this.data.selectedPrinter;
    if (!printers.some((p) => p.name === sel)) {
      const dftName = (d && d.default) || (printers.find((p) => p.isDefault) || {}).name || '';
      sel = printers.some((p) => p.name === dftName) ? dftName : ((printers[0] || {}).name || '');
    }
    this.setData({ printers, selectedPrinter: sel }, cb);
  },

  // 当前模式是否已有可提交内容
  hasContent() {
    const m = this.data.mode;
    if (m === 'file') return !!(this.data.file && this.data.file.id);
    if (m === 'text') return !!(this.data.textBody || '').trim();
    if (m === 'invoice') return this.data.invoiceImages.length > 0;
    if (m === 'idcard') return !!(this.data.idFront || this.data.idBack);
    return false;
  },

  refreshSummary() {
    const { selectedPrinter, options, approved, baseReady } = this.data;
    // 折叠状态下也要能一眼看到当前设置
    const paperSummary = `${options.media} · ${options.orientation === 'landscape' ? '横向' : '纵向'} · ${options.numberUp}页/张`;
    const advBits = [];
    if (options.pageRanges) advBits.push('页范围 ' + options.pageRanges);
    if (options.mirror) advBits.push('镜像');
    if (options.pageBorder) advBits.push('页边框');
    const advSummary = advBits.length ? advBits.join(' · ') : '默认';
    if (paperSummary !== this.data.paperSummary || advSummary !== this.data.advSummary) {
      this.setData({ paperSummary, advSummary });
    }
    const printers = this.data.printers || [];
    const p = printers.find((x) => x && x.name === selectedPrinter);
    const line1 = selectedPrinter && p ? `打印到 ${selectedPrinter}` : (printers.length ? '请选择打印机' : '暂无可用打印机');
    const line2 = optionsSummary(options);
    this.setData({
      summaryLine1: p && printerState(p.state).kind === 'danger' ? `${line1}（已暂停）` : line1,
      summaryLine2: line2,
      canSubmit: !!(this.hasContent() && selectedPrinter && approved && baseReady && !this.data.submitting && !this.data.composing)
    });
  },

  // ---------- 模式切换 ----------
  // 合成图（文字/发票/身份证共用 composedPath）一旦内容变了就必须作废，
  // 否则提交时用的是上一份旧图：改了文字还是打旧内容、切到发票却打出刚才的文字页。
  invalidateCompose() {
    if (this.data.composedPath) this.setData({ composedPath: '' }, () => this.refreshSummary());
  },

  switchMode(e) {
    const m = e.currentTarget.dataset.key;
    if (m === this.data.mode) return;
    this.setData({ mode: m, composedPath: '' }, () => this.refreshSummary());
  },

  // ---------- 标准打印：文件 ----------
  checkSize(size) {
    const max = this.data.maxFileMB * 1024 * 1024;
    if (size > max) { wx.showToast({ title: `文件超过 ${this.data.maxFileMB} MB 上限`, icon: 'none' }); return false; }
    return true;
  },

  // 聊天记录：图片消息也要能选（type: 'all'），最多 9 个；视频不参与打印
  chooseFromChat() {
    if (!this.guardReady()) return;
    wx.chooseMessageFile({
      count: 9, type: 'all',
      success: (res) => {
        const files = (res.tempFiles || []).filter((f) => f && f.path && f.type !== 'video');
        if (!files.length) return;
        this.uploadMany(files.map((f) => ({ path: f.path, name: f.name, size: f.size })));
      }
    });
  },

  // 相册 / 拍照：最多 9 张，多张自动合成一个多页 PDF
  chooseFromAlbum() {
    if (!this.guardReady()) return;
    wx.chooseImage({
      count: 9, sizeType: ['original', 'compressed'],
      success: (res) => {
        const paths = res.tempFilePaths || [];
        const metas = res.tempFiles || [];
        if (!paths.length) return;
        const stamp = Date.now();
        this.uploadMany(paths.map((p, i) => {
          const ext = (String(p).split('.').pop() || 'jpg').toLowerCase();
          return {
            path: p,
            name: `图片-${stamp}-${i + 1}.${/^[a-z0-9]{2,5}$/.test(ext) ? ext : 'jpg'}`,
            size: (metas[i] && metas[i].size) || 0
          };
        }));
      }
    });
  },

  // 批量上传：微信一次只能传一个文件，所以逐个传；全是图片就合成一份多页 PDF
  async uploadMany(items) {
    const list = (items || []).filter((x) => x && x.path);
    if (!list.length) return;
    if (list.length === 1) return this.doUpload(list[0].path, list[0].name, list[0].size);

    const max = (Number(this.data.maxFileMB) || 20) * 1024 * 1024;
    const tooBig = list.find((x) => x.size && x.size > max);
    if (tooBig) {
      wx.showToast({ title: `「${tooBig.name || '文件'}」超过 ${this.data.maxFileMB} MB`, icon: 'none' });
      return;
    }

    this.setData({ uploading: true });
    const done = [];
    try {
      for (let i = 0; i < list.length; i++) {
        wx.showLoading({ title: `上传中 ${i + 1}/${list.length}`, mask: true });
        const res = await api.uploadFile(list[i].path, {}, { size: list[i].size, filename: list[i].name });
        const f = res.file || {};
        done.push(Object.assign({}, f, { filename: f.filename || list[i].name || '' }));
      }

      const allImages = done.every((f) => /\.(jpe?g|png|webp|bmp|gif|heic|heif)$/i.test(f.filename || ''));
      if (!allImages) {
        // 混了 PDF/Office：一次只能打一个文档，保留第一个，其余回收
        for (const f of done.slice(1)) { try { await api.deleteFile(f.id); } catch (_) {} }
        this.applyFile(decorateFileCard(Object.assign({}, done[0], { displayName: done[0].filename })));
        wx.showToast({ title: '一次只能打印一个文档，已保留第一个', icon: 'none' });
        return;
      }

      wx.showLoading({ title: `正在合并 ${done.length} 页`, mask: true });
      const r = await api.mergeImages(done.map((f) => f.id), `图片合并-${done.length}张.pdf`);
      this.applyFile(decorateFileCard(Object.assign({}, r.file, { displayName: `图片合并（${done.length} 张）` })));
    } catch (e) {
      // 失败把已传的回收掉，别在「我的文件」里留一堆没用上的图
      for (const f of done) { try { await api.deleteFile(f.id); } catch (_) {} }
      this.setData({ uploading: false });
      if (!this.handleNotApproved(e)) {
        wx.showModal({ title: '上传失败', content: e.message || '请重试', showCancel: false, confirmText: '知道了' });
      }
    } finally {
      wx.hideLoading();
    }
  },

  // 设为当前打印对象（统一入口，避免各处 setData 漏字段）
  applyFile(f) {
    this.setData({ file: f, previewPath: '', previewErr: '', previewPage: 1, uploading: false }, () => this.refreshSummary());
    this.loadPreview();
  },

  // 后端 2.3+ 起：未审批用户上传/打印返回 403 + code=NOT_APPROVED。
  // 统一转成「待审批」态并提示，再拉一次用户信息，管理员一放行页面就恢复。
  handleNotApproved(e) {
    if (!e || e.code !== 'NOT_APPROVED') return false;
    this.setData({ approved: false });
    wx.showToast({ title: '账号待管理员审批，通过后才能打印', icon: 'none' });
    this.syncAll();
    return true;
  },

  togglePaper() { this.setData({ showPaper: !this.data.showPaper }); },
  toggleAdv() { this.setData({ showAdv: !this.data.showAdv }); },

  guardReady() {
    const app = getApp();
    if (!app.globalData.baseUrl) { wx.showToast({ title: '请先配置服务地址', icon: 'none' }); return false; }
    if (!this.data.approved) { wx.showToast({ title: '账号待管理员授权', icon: 'none' }); return false; }
    return true;
  },

  async doUpload(path, name, size) {
    this.setData({ uploading: true });
    wx.showLoading({ title: '上传中', mask: true });
    try {
      // 大文件会自动走分片（微信 wx.uploadFile 单次有约 10MB 上限）
      const res = await api.uploadFile(path, {}, {
        size,
        filename: name,
        onProgress: (pct) => wx.showLoading({ title: `上传中 ${pct}%`, mask: true })
      });
      this.applyFile(decorateFileCard(Object.assign({}, res.file, { displayName: name || res.file.filename })));
    } catch (e) {
      this.setData({ uploading: false });
      if (!this.handleNotApproved(e)) {
        const big = size && size > 10 * 1024 * 1024;
        wx.showToast({ title: e.message || (big ? '文件较大，上传失败，请重试' : '上传失败'), icon: 'none' });
      }
    } finally { wx.hideLoading(); }
  },

  // 预览：服务端按 ?page=N 逐页渲染，这里记住当前页，翻页只换图不重新上传
  loadPreview(page) {
    const file = this.data.file;
    if (!file || !file.id) return;
    const total = Number(file.pages) || 0;
    let p = Number(page) || this.data.previewPage || 1;
    if (p < 1) p = 1;
    if (total && p > total) p = total;
    this.setData({ previewLoading: true, previewErr: '', previewPage: p });
    this._pvSeq = (this._pvSeq || 0) + 1;
    const seq = this._pvSeq;
    api.downloadFile(file.id, p).then((path) => {
      if (seq !== this._pvSeq) return;
      this.setData({ previewPath: path, previewLoading: false, previewErr: '' });
    }).catch((e) => {
      if (seq !== this._pvSeq) return;
      this.setData({ previewPath: '', previewLoading: false, previewErr: e.message || '预览失败' });
    });
  },

  // 多页 PDF 翻页（原生 previewImage 只能看一张，所以自己做页码）
  prevPage() {
    const p = (this.data.previewPage || 1) - 1;
    if (p < 1) return;
    this.loadPreview(p);
  },

  nextPage() {
    const total = Number((this.data.file || {}).pages) || 0;
    const p = (this.data.previewPage || 1) + 1;
    if (total && p > total) return;
    this.loadPreview(p);
  },

  retryPreview() { this.loadPreview(); },

  removeFile() {
    this._pvSeq = (this._pvSeq || 0) + 1;
    this.setData({ file: null, previewPath: '', previewErr: '', previewPage: 1 }, () => this.refreshSummary());
  },

  previewFile() {
    const file = this.data.file;
    if (!file) return;
    if (!this.data.previewPath) { wx.showToast({ title: '预览生成中，请稍候', icon: 'none' }); return; }
    wx.previewImage({ urls: [this.data.previewPath], fail: () => wx.showToast({ title: '无法打开预览', icon: 'none' }) });
  },

  // ---------- 文字速印 ----------
  // 文字一改，之前合成的图就过期了：必须一起清掉，否则提交的是旧内容
  onTextInput(e) { this.setData({ textBody: e.detail.value, composedPath: '' }, () => this.refreshSummary()); },
  onTitleInput(e) { this.setData({ textTitle: e.detail.value, composedPath: '' }); },
  onTextFont(e) {
    const f = parseInt(e.detail.value, 10) || 12;
    this.setData({ textFont: Math.min(Math.max(f, 6), 48), composedPath: '' });
  },

  async composeText() {
    const body = (this.data.textBody || '').trim();
    if (!body) { wx.showToast({ title: '请输入要打印的文字', icon: 'none' }); return; }
    this.setData({ composing: true });
    wx.showLoading({ title: '排版中', mask: true });
    try {
      const { W, H } = comp.pagePx(this.data.options.media);
      const { canvas, ctx } = await comp.getCtx('#compose-canvas', this, W, H);
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = '#000000';
      const margin = 56;
      let y = margin;
      if (this.data.textTitle.trim()) {
        ctx.font = `${Math.min(this.data.textFont * 1.6, 30)}px sans-serif`;
        ctx.textAlign = 'center';
        ctx.fillText(this.data.textTitle.trim(), W / 2, y + this.data.textFont);
        y += this.data.textFont * 1.6 + 8;
      }
      ctx.textAlign = 'left';
      ctx.font = `${this.data.textFont}px sans-serif`;
      const lh = this.data.textFont + 5;
      const lines = comp.wrapText(ctx, body, this.data.textFont, W - margin * 2);
      for (const line of lines) {
        if (y + lh > H - margin) { y = margin; } // 单页超出则从头（端上仅合成首页预览，打印仍走 PDF 分页由后端预览接口处理）
        ctx.fillText(line === '' ? ' ' : line, margin, y);
        y += lh;
      }
      const path = await comp.exportPng(canvas, W, H);
      this.setData({ textLines: lines.length, composedPath: path }, () => this.refreshSummary());
    } catch (e) {
      wx.showToast({ title: '排版失败：' + (e.message || '请重试'), icon: 'none' });
    } finally {
      this.setData({ composing: false });
      wx.hideLoading();
    }
  },

  // ---------- 发票合排 ----------
  chooseInvoice() {
    if (!this.guardReady()) return;
    wx.chooseImage({
      count: 6, sizeType: ['original', 'compressed'],
      success: (res) => {
        const paths = res.tempFilePaths || [];
        if (!paths.length) return;
        this.setData({ invoiceImages: this.data.invoiceImages.concat(paths).slice(0, 12), composedPath: '' }, () => this.refreshSummary());
      }
    });
  },
  removeInvoice(e) {
    const i = e.currentTarget.dataset.i;
    const arr = this.data.invoiceImages.slice();
    arr.splice(i, 1);
    this.setData({ invoiceImages: arr, composedPath: '' }, () => this.refreshSummary());
  },
  onInvoicePer(e) {
    const v = parseInt(e.currentTarget.dataset.v, 10);
    this.setData({ invoicePer: v, composedPath: '' });
  },

  async composeInvoice() {
    const imgs = this.data.invoiceImages;
    if (!imgs.length) { wx.showToast({ title: '请先选择发票图片', icon: 'none' }); return; }
    this.setData({ composing: true });
    wx.showLoading({ title: '合排中', mask: true });
    try {
      const per = this.data.invoicePer;
      const { W, H } = comp.pagePx(this.data.options.media);
      const { canvas, ctx } = await comp.getCtx('#compose-canvas', this, W, H);
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, W, H);
      const margin = 28, gap = 14;
      const uw = W - margin * 2, uh = H - margin * 2;
      // grid 等分
      const cols = per === 4 ? 2 : per === 2 ? 1 : 1;
      const rows = per === 4 ? 2 : per === 2 ? 2 : 1;
      const cellW = (uw - gap * (cols - 1)) / cols;
      const cellH = (uh - gap * (rows - 1)) / rows;
      for (let i = 0; i < per && i < imgs.length; i++) {
        const img = await comp.loadImage(ctx, imgs[i]);
        const c = i % cols, r = Math.floor(i / cols);
        const x = margin + c * (cellW + gap), y = margin + r * (cellH + gap);
        comp.drawCover(ctx, img, x, y, cellW, cellH);
      }
      const path = await comp.exportPng(canvas, W, H);
      this.setData({ composedPath: path }, () => this.refreshSummary());
    } catch (e) {
      wx.showToast({ title: '合排失败：' + (e.message || '请重试'), icon: 'none' });
    } finally {
      this.setData({ composing: false });
      wx.hideLoading();
    }
  },

  // ---------- 身份证 ----------
  chooseIdCard(e) {
    if (!this.guardReady()) return;
    const side = e.currentTarget.dataset.side;
    wx.chooseImage({
      count: 1, sizeType: ['original', 'compressed'],
      success: (res) => {
        const p = (res.tempFilePaths || [])[0];
        if (!p) return;
        this.setData({ [side === 'front' ? 'idFront' : 'idBack']: p, composedPath: '' }, () => this.refreshSummary());
      }
    });
  },
  clearIdCard(e) {
    const side = e.currentTarget.dataset.side;
    this.setData({ [side === 'front' ? 'idFront' : 'idBack']: null, composedPath: '' }, () => this.refreshSummary());
  },

  async composeIdCard() {
    if (!this.data.idFront && !this.data.idBack) { wx.showToast({ title: '请先上传身份证照片', icon: 'none' }); return; }
    this.setData({ composing: true });
    wx.showLoading({ title: '合排中', mask: true });
    try {
      const { W, H } = comp.pagePx(this.data.options.media);
      const { canvas, ctx } = await comp.getCtx('#compose-canvas', this, W, H);
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, W, H);
      const margin = 36, gap = 18;
      const uw = W - margin * 2, uh = H - margin * 2;
      const slotH = (uh - gap) / 2;
      const slots = [
        { src: this.data.idFront, top: margin, label: '正面' },
        { src: this.data.idBack, top: margin + slotH + gap, label: '反面' }
      ];
      for (const s of slots) {
        // 淡裁切线
        ctx.strokeStyle = '#cbd5e1';
        ctx.lineWidth = 0.5;
        ctx.strokeRect(margin, s.top, uw, slotH);
        if (s.src) {
          const img = await comp.loadImage(ctx, s.src);
          comp.drawCover(ctx, img, margin, s.top, uw, slotH);
        } else {
          ctx.fillStyle = '#94a3b8';
          ctx.font = '11px sans-serif';
          ctx.textAlign = 'center';
          ctx.fillText(`（未上传${s.label}）`, W / 2, s.top + slotH / 2);
        }
      }
      const path = await comp.exportPng(canvas, W, H);
      this.setData({ composedPath: path }, () => this.refreshSummary());
    } catch (e) {
      wx.showToast({ title: '合排失败：' + (e.message || '请重试'), icon: 'none' });
    } finally {
      this.setData({ composing: false });
      wx.hideLoading();
    }
  },

  // ---------- 打印机 ----------
  selectPrinter(e) {
    const name = e.currentTarget.dataset.name;
    this.setData({ selectedPrinter: name }, () => this.refreshSummary());
  },
  refreshPrinters() {
    const app = getApp();
    app.refreshPrinters().then((d) => this.applyPrinters(d, () => this.refreshSummary()));
  },

  // ---------- 参数 ----------
  setOpt(e) {
    const { k, v } = e.currentTarget.dataset;
    if (!k) return;
    let val = v;
    if (k === 'numberUp') val = parseInt(v, 10) || 1;
    else if (k === 'mirror' || k === 'pageBorder') val = (v === true || v === 'true');
    this.setData({ [`options.${k}`]: val }, () => this.refreshSummary());
  },
  onCopies(e) { this.setData({ 'options.copies': e.detail.value }, () => this.refreshSummary()); },
  // 这里以前不刷新底部摘要，页范围 / 水印改完摘要还显示旧值
  onPageRanges(e) { this.setData({ 'options.pageRanges': e.detail.value }, () => this.refreshSummary()); },
  onWatermark(e) { this.setData({ 'options.watermark': e.detail.value }, () => this.refreshSummary()); },

  // ---------- 提交 ----------
  async submitPrint() {
    const { selectedPrinter, options, canSubmit } = this.data;
    if (!canSubmit || this.data.submitting || this.data.composing) return;
    if (!selectedPrinter) { wx.showToast({ title: '请先选择打印机', icon: 'none' }); return; }
    if (options.watermark && options.watermark.length > 40) { wx.showToast({ title: '水印不超过 40 个字符', icon: 'none' }); return; }

    const mode = this.data.mode;
    let file = null;
    this.setData({ submitting: true, canSubmit: false });
    try {
      if (mode === 'file') {
        file = this.data.file;
        if (!file || !file.id) throw new Error('请先选择文件');
      } else {
        // 文字/发票/身份证：先本地合成图片（若尚未合成则自动触发）
        if (!this.data.composedPath) {
          if (mode === 'text') await this.composeText();
          else if (mode === 'invoice') await this.composeInvoice();
          else await this.composeIdCard();
        }
        if (!this.data.composedPath) throw new Error('合成失败，请重试');
        wx.showLoading({ title: '上传中', mask: true });
        const up = await this.uploadComposed(this.data.composedPath, mode);
        wx.hideLoading();
        file = Object.assign({}, up.file, { displayName: this.composedName(mode) });
      }
      const res = await api.print(file.id, selectedPrinter, options);
      wx.showToast({ title: res.msg || '已提交', icon: 'none' });
      this.setData({ submitting: false, file: null, previewPath: '', previewErr: '', composedPath: '' }, () => this.refreshSummary());
      setTimeout(() => wx.switchTab({ url: '/pages/tasks/tasks' }), 800);
    } catch (e) {
      wx.hideLoading();
      wx.showToast({ title: e.message || '提交失败', icon: 'none' });
      this.setData({ submitting: false }, () => this.refreshSummary());
    }
  },

  // 合成的 PNG 上传：带上真实体积（决定是否走分片）和可读文件名。
  // 不传名字时服务端只能拿到临时路径名，打印记录里就会显示 tmp_xxxx.png。
  uploadComposed(path, mode) {
    const name = this.composedName(mode);
    return new Promise((resolve) => {
      wx.getFileSystemManager().getFileInfo({
        filePath: path,
        success: (r) => resolve(Number(r.size) || 0),
        fail: () => resolve(0)
      });
    }).then((size) => api.uploadFile(path, { filename: name }, { size, filename: name }));
  },

  composedName(mode) {
    if (mode === 'text') return '文字速印.png';
    if (mode === 'invoice') return '发票合排.png';
    if (mode === 'idcard') return '身份证合排.png';
    return '打印.png';
  },

  // ---------- 视图辅助 ----------
  stateText(p) { return printerState(p.state).text; },
  stateKind(p) { return printerState(p.state).kind; },
  extText(file) { return (extOf(file.filename) || 'bin').toUpperCase(); },
  sizeText(file) { return formatSize(file.size); },
  pagesText(file) { return file.pages ? ` · ${file.pages} 页` : ''; },

  goMine() { wx.switchTab({ url: '/pages/mine/mine' }); }
});
