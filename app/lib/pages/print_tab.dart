import 'dart:io';

import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';
import 'package:image_picker/image_picker.dart';

import '../core/api.dart';
import '../core/app_state.dart';
import '../core/compose.dart';
import '../core/format.dart';
import '../core/models.dart';
import '../theme.dart';

/// 打印页：标准打印 / 文字速印 / 发票合排 / 身份证（与小程序四种模式一一对应）
class PrintTab extends StatefulWidget {
  const PrintTab({
    super.key,
    required this.printers,
    required this.selected,
    required this.onRefreshPrinters,
    required this.onPrinted,
  });

  final List<PgPrinter> printers;
  final ValueNotifier<PgFileItem?> selected;
  final Future<void> Function() onRefreshPrinters;
  final VoidCallback onPrinted;

  @override
  State<PrintTab> createState() => _PrintTabState();
}

class _PrintTabState extends State<PrintTab> {
  static const _modes = [
    (key: 'file', label: '标准打印', icon: Icons.description_outlined),
    (key: 'text', label: '文字速印', icon: Icons.text_fields_rounded),
    (key: 'invoice', label: '发票合排', icon: Icons.receipt_outlined),
    (key: 'idcard', label: '身份证', icon: Icons.badge_outlined),
  ];
  static const _mediaList = ['A4', 'A3', 'A5', 'A6', 'Letter', 'Legal', 'B5', '16K'];
  static const _numberUpList = [1, 2, 4, 6, 9, 16];
  static const _maxImages = 9;

  String _mode = 'file';

  // 标准打印
  File? _preview;
  int _previewPage = 1;
  bool _previewLoading = false;
  String _previewErr = '';

  // 文字速印
  final _textCtrl = TextEditingController();
  final _titleCtrl = TextEditingController();
  double _fontSize = 12;
  int _textLines = 0;

  // 发票
  final List<String> _invoices = [];
  int _per = 2;

  // 身份证
  String? _front;
  String? _back;

  // 合成产物
  File? _composed;
  String _composedName = '';

  // 参数
  int _copies = 1;
  String _color = 'mono';
  String _sides = 'one-sided';
  String _media = 'A4';
  String _orientation = 'portrait';
  String _scaling = 'fit';
  String _pageSet = 'all';
  bool _mirror = false;
  bool _pageBorder = false;
  int _numberUp = 1;
  final _rangesCtrl = TextEditingController();
  final _watermarkCtrl = TextEditingController();

  String? _printer;
  bool _busy = false;
  String _busyText = '';

  AppCtl get _ctl => AppScope.read(context);

  @override
  void initState() {
    super.initState();
    widget.selected.addListener(_onFileChanged);
    _pickDefaultPrinter();
  }

  @override
  void dispose() {
    widget.selected.removeListener(_onFileChanged);
    _textCtrl.dispose();
    _titleCtrl.dispose();
    _rangesCtrl.dispose();
    _watermarkCtrl.dispose();
    super.dispose();
  }

  @override
  void didUpdateWidget(covariant PrintTab oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (_printer == null || !widget.printers.any((p) => p.name == _printer)) {
      _pickDefaultPrinter();
    }
  }

  void _pickDefaultPrinter() {
    if (widget.printers.isEmpty) {
      _printer = null;
      return;
    }
    final def = widget.printers.firstWhere(
      (p) => p.isDefault,
      orElse: () => widget.printers.first,
    );
    _printer = def.name;
  }

  void _onFileChanged() {
    _composed = null;
    _preview = null;
    _previewErr = '';
    _previewPage = 1;
    if (mounted) setState(() {});
    if (widget.selected.value != null) _loadPreview(1);
  }

  void _toast(String msg) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(msg)));
  }

  // ---------- 内容是否齐备 ----------
  bool get _hasContent {
    switch (_mode) {
      case 'file':
        return widget.selected.value != null;
      case 'text':
        return _textCtrl.text.trim().isNotEmpty;
      case 'invoice':
        return _invoices.isNotEmpty;
      case 'idcard':
        return _front != null || _back != null;
      default:
        return false;
    }
  }

  bool get _canSubmit =>
      _hasContent && _printer != null && _ctl.approved && !_busy;

  /// 内容一改，之前合成的图就过期了（否则会打出上一次的内容）
  void _invalidate() {
    if (_composed != null) {
      setState(() => _composed = null);
    }
  }

  // ---------- 标准打印：选文件 ----------
  Future<void> _pickImages() async {
    if (!_guard()) return;
    try {
      final picked = await ImagePicker().pickMultiImage(imageQuality: 92);
      if (picked.isEmpty) return;
      final files = picked.take(_maxImages).toList();
      final stamp = DateTime.now().millisecondsSinceEpoch;
      await _uploadMany(
        files.map((f) => f.path).toList(),
        [for (var i = 0; i < files.length; i++) '图片-$stamp-${i + 1}.${Fmt.ext(files[i].path).isEmpty ? 'jpg' : Fmt.ext(files[i].path)}'],
      );
    } catch (e) {
      _toast('选择图片失败：$e');
    }
  }

  Future<void> _pickDocs() async {
    if (!_guard()) return;
    try {
      final r = await FilePicker.platform.pickFiles(allowMultiple: true, withData: false);
      final paths = (r?.files ?? []).where((f) => f.path != null).map((f) => f.path!).toList();
      if (paths.isEmpty) return;
      await _uploadMany(paths.take(_maxImages).toList(), paths.take(_maxImages).map(_baseName).toList());
    } catch (e) {
      _toast('选择文件失败：$e');
    }
  }

  bool _guard() {
    if (!_ctl.hasServer) {
      _toast('请先配置服务地址');
      return false;
    }
    if (!_ctl.approved) {
      _toast('账号待管理员授权');
      return false;
    }
    return true;
  }

  /// 批量上传：全是图片 → 合成一份多页 PDF；混了 PDF/Office → 只留第一个，其余回收
  Future<void> _uploadMany(List<String> paths, List<String> names) async {
    final maxBytes = _ctl.maxFileMB * 1024 * 1024;
    for (var i = 0; i < paths.length; i++) {
      final len = await File(paths[i]).length();
      if (len > maxBytes) {
        _toast('「${names[i]}」超过 ${_ctl.maxFileMB} MB');
        return;
      }
    }
    setState(() {
      _busy = true;
      _busyText = '上传 1/${paths.length}';
    });
    final api = Api();
    final done = <PgFileItem>[];
    try {
      for (var i = 0; i < paths.length; i++) {
        if (mounted) setState(() => _busyText = '上传 ${i + 1}/${paths.length}');
        done.add(await api.upload(paths[i], names[i]));
      }
      final allImages = done.every((f) => Fmt.isImageName(f.filename));
      if (!allImages) {
        for (final f in done.skip(1)) {
          try {
            await api.deleteFile(f.id);
          } catch (_) {}
        }
        widget.selected.value = done.first;
        _toast('一次只能打印一个文档，已保留第一个');
      } else if (done.length > 1) {
        if (mounted) setState(() => _busyText = '合成 ${done.length} 页');
        final merged = await api.mergeImages(done.map((f) => f.id).toList(), '图片合并-${done.length}张.pdf');
        widget.selected.value = merged;
      } else {
        widget.selected.value = done.first;
      }
    } on ApiException catch (e) {
      // 失败把已传的回收掉，别在「我的文件」里留一堆没用上的图
      for (final f in done) {
        try {
          await api.deleteFile(f.id);
        } catch (_) {}
      }
      _toast(e.notApproved ? '账号待管理员审批，通过后才能打印' : e.message);
    } catch (e) {
      _toast('上传失败：$e');
    } finally {
      if (mounted) {
        setState(() {
          _busy = false;
          _busyText = '';
        });
      }
    }
  }

  // ---------- 预览 ----------
  Future<void> _loadPreview(int page) async {
    final file = widget.selected.value;
    if (file == null) return;
    var p = page < 1 ? 1 : page;
    if (file.pages > 0 && p > file.pages) p = file.pages;
    setState(() {
      _previewLoading = true;
      _previewErr = '';
      _previewPage = p;
    });
    try {
      final f = await Api().downloadPreview(file.id, p);
      if (!mounted) return;
      setState(() {
        _preview = f;
        _previewLoading = false;
      });
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() {
        _previewErr = e.message;
        _previewLoading = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _previewErr = '$e';
        _previewLoading = false;
      });
    }
  }

  // ---------- 文字速印 / 发票 / 身份证 ----------
  Future<void> _composeNow() async {
    setState(() {
      _busy = true;
      _busyText = '排版中';
    });
    try {
      switch (_mode) {
        case 'text':
          final body = _textCtrl.text.trim();
          if (body.isEmpty) throw ApiException('请输入要打印的文字');
          _composed = await Compose.text(
            body: body,
            title: _titleCtrl.text,
            fontSize: _fontSize,
            media: _media,
          );
          _textLines = body.split('\n').length;
          break;
        case 'invoice':
          if (_invoices.isEmpty) throw ApiException('请先选择发票图片');
          _composed = await Compose.invoice(images: _invoices, per: _per, media: _media);
          break;
        case 'idcard':
          if (_front == null && _back == null) throw ApiException('请先上传身份证照片');
          _composed = await Compose.idCard(front: _front, back: _back, media: _media);
          break;
      }
      _composedName = Compose.nameOf(_mode);
    } catch (e) {
      _toast(e is ApiException ? e.message : '排版失败：$e');
    } finally {
      if (mounted) {
        setState(() {
          _busy = false;
          _busyText = '';
        });
      }
    }
  }

  // ---------- 提交 ----------
  Future<void> _submit() async {
    if (_busy) return;
    final printer = _printer;
    if (printer == null) {
      _toast('请先选择打印机');
      return;
    }
    final watermark = _watermarkCtrl.text.trim();
    if (watermark.length > 40) {
      _toast('水印不超过 40 个字符');
      return;
    }
    final ranges = Fmt.sanitizeRanges(_rangesCtrl.text);
    if (!Fmt.validRanges(ranges)) {
      _toast('页范围格式不对，例如 1-3,5');
      return;
    }

    setState(() {
      _busy = true;
      _busyText = '提交中';
    });
    try {
      int fileId;
      if (_mode == 'file') {
        final f = widget.selected.value;
        if (f == null) throw ApiException('请先选择文件');
        fileId = f.id;
      } else {
        if (_composed == null) {
          await _composeNow();
          if (_composed == null) throw ApiException('合成失败，请重试');
        }
        setState(() => _busyText = '上传中');
        final up = await Api().upload(_composed!.path, _composedName);
        fileId = up.id;
      }

      final res = await Api().print(fileId, printer, {
        'copies': _copies,
        'color': _color,
        'sides': _sides,
        'media': _media,
        'orientation': _orientation,
        'numberUp': _numberUp,
        'numberUpLayout': 'lrtb',
        'scaling': _scaling,
        'pageSet': _pageSet,
        'mirror': _mirror,
        'pageBorder': _pageBorder,
        if (ranges.isNotEmpty) 'pageRanges': ranges,
        if (watermark.isNotEmpty) 'watermark': watermark,
      });
      _toast(res['msg']?.toString() ?? '已提交');
      widget.selected.value = null;
      setState(() {
        _composed = null;
        _textCtrl.clear();
        _titleCtrl.clear();
        _invoices.clear();
        _front = null;
        _back = null;
        _preview = null;
      });
      widget.onPrinted();
    } on ApiException catch (e) {
      _toast(e.notApproved ? '账号待管理员审批，通过后才能打印' : e.message);
    } catch (e) {
      _toast('提交失败：$e');
    } finally {
      if (mounted) {
        setState(() {
          _busy = false;
          _busyText = '';
        });
      }
    }
  }

  static String _baseName(String path) => path.split(RegExp(r'[\\/]')).last;

  // ---------- UI ----------
  @override
  Widget build(BuildContext context) {
    return ListView(
      padding: const EdgeInsets.fromLTRB(16, 8, 16, 28),
      children: [
        _modeBar(),
        const SizedBox(height: 12),
        if (!_ctl.approved) const _PendingNotice(),
        ..._contentForMode(),
        const SizedBox(height: 12),
        _printerCard(),
        const SizedBox(height: 12),
        _optionsCard(),
        const SizedBox(height: 14),
        _summaryBar(),
        const SizedBox(height: 12),
        FilledButton.icon(
          onPressed: _canSubmit ? _submit : null,
          icon: Icon(_busy ? Icons.hourglass_top_rounded : Icons.print_rounded),
          label: Text(_busy ? (_busyText.isEmpty ? '处理中…' : _busyText) : '开始打印'),
        ),
      ],
    );
  }

  Widget _modeBar() {
    final primary = Theme.of(context).colorScheme.primary;
    return SingleChildScrollView(
      scrollDirection: Axis.horizontal,
      child: Row(
        children: [
          for (final m in _modes)
            Padding(
              padding: const EdgeInsets.only(right: 8),
              child: InkWell(
                borderRadius: BorderRadius.circular(12),
                onTap: () {
                  if (_mode == m.key) return;
                  setState(() {
                    _mode = m.key;
                    _composed = null;
                  });
                },
                child: AnimatedContainer(
                  duration: const Duration(milliseconds: 150),
                  padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 9),
                  decoration: BoxDecoration(
                    color: _mode == m.key ? primary : primary.withValues(alpha: 0.06),
                    borderRadius: BorderRadius.circular(12),
                  ),
                  child: Row(
                    children: [
                      Icon(m.icon, size: 16, color: _mode == m.key ? Colors.white : primary),
                      const SizedBox(width: 6),
                      Text(
                        m.label,
                        style: TextStyle(
                          fontSize: 13,
                          fontWeight: _mode == m.key ? FontWeight.w600 : FontWeight.w500,
                          color: _mode == m.key ? Colors.white : primary,
                        ),
                      ),
                    ],
                  ),
                ),
              ),
            ),
        ],
      ),
    );
  }

  List<Widget> _contentForMode() {
    switch (_mode) {
      case 'text':
        return _textMode();
      case 'invoice':
        return _invoiceMode();
      case 'idcard':
        return _idCardMode();
      default:
        return _fileMode();
    }
  }

  // ---------- 标准打印 UI ----------
  List<Widget> _fileMode() {
    return [
      ValueListenableBuilder<PgFileItem?>(
        valueListenable: widget.selected,
        builder: (context, file, _) => file == null ? _emptyPicker() : _fileCard(file),
      ),
    ];
  }

  Widget _emptyPicker() {
    final scheme = Theme.of(context).colorScheme;
    return PgCard(
      padding: const EdgeInsets.symmetric(vertical: 24, horizontal: 16),
      child: Column(
        children: [
          Icon(Icons.upload_file_rounded, size: 38, color: scheme.primary),
          const SizedBox(height: 10),
          Text('选要打印的文件', style: TextStyle(fontWeight: FontWeight.w600, color: scheme.onSurface)),
          const SizedBox(height: 4),
          Text(
            '图片可多选（最多 $_maxImages 张），自动合成多页 PDF',
            textAlign: TextAlign.center,
            style: TextStyle(fontSize: 12.5, color: scheme.onSurfaceVariant),
          ),
          const SizedBox(height: 16),
          Row(
            children: [
              Expanded(
                child: OutlinedButton.icon(
                  onPressed: _busy ? null : _pickImages,
                  icon: const Icon(Icons.photo_library_outlined, size: 18),
                  label: const Text('相册'),
                ),
              ),
              const SizedBox(width: 10),
              Expanded(
                child: OutlinedButton.icon(
                  onPressed: _busy ? null : _pickDocs,
                  icon: const Icon(Icons.folder_open_rounded, size: 18),
                  label: const Text('文件'),
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }

  Widget _fileCard(PgFileItem file) {
    final scheme = Theme.of(context).colorScheme;
    return PgCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Container(
                width: 44,
                height: 44,
                decoration: BoxDecoration(color: scheme.primary.withValues(alpha: 0.1), borderRadius: BorderRadius.circular(12)),
                child: Icon(Fmt.isImageName(file.filename) ? Icons.image_outlined : Icons.description_outlined, color: scheme.primary),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(file.filename, maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontWeight: FontWeight.w600)),
                    const SizedBox(height: 3),
                    Text(
                      '${file.pages > 0 ? "${file.pages} 页 · " : ""}${Fmt.size(file.size)}',
                      style: TextStyle(fontSize: 12.5, color: scheme.onSurfaceVariant),
                    ),
                  ],
                ),
              ),
              TextButton(
                onPressed: _busy
                    ? null
                    : () {
                        widget.selected.value = null;
                      },
                child: const Text('移除'),
              ),
            ],
          ),
          const SizedBox(height: 12),
          Container(
            height: 210,
            width: double.infinity,
            decoration: BoxDecoration(
              color: scheme.surfaceContainerHighest.withValues(alpha: 0.35),
              borderRadius: BorderRadius.circular(12),
            ),
            child: _previewArea(file),
          ),
          if (file.pages > 1) ...[
            const SizedBox(height: 8),
            Row(
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                IconButton(
                  onPressed: _previewPage <= 1 ? null : () => _loadPreview(_previewPage - 1),
                  icon: const Icon(Icons.chevron_left_rounded),
                ),
                Text('第 $_previewPage / ${file.pages} 页', style: const TextStyle(fontSize: 13)),
                IconButton(
                  onPressed: _previewPage >= file.pages ? null : () => _loadPreview(_previewPage + 1),
                  icon: const Icon(Icons.chevron_right_rounded),
                ),
              ],
            ),
          ],
        ],
      ),
    );
  }

  Widget _previewArea(PgFileItem file) {
    if (_previewLoading) return const Center(child: CircularProgressIndicator());
    if (_previewErr.isNotEmpty) {
      return Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(_previewErr, style: const TextStyle(fontSize: 12.5, color: Color(0xFF8A9C9A))),
            const SizedBox(height: 8),
            TextButton(onPressed: () => _loadPreview(_previewPage), child: const Text('重试')),
          ],
        ),
      );
    }
    final p = _preview;
    if (p == null) return const Center(child: Text('预览生成中', style: TextStyle(fontSize: 12.5, color: Color(0xFF8A9C9A))));
    return ClipRRect(
      borderRadius: BorderRadius.circular(12),
      child: Image.file(p, fit: BoxFit.contain, errorBuilder: (_, __, ___) => const Center(child: Text('无法显示预览'))),
    );
  }

  // ---------- 文字速印 UI ----------
  List<Widget> _textMode() {
    final scheme = Theme.of(context).colorScheme;
    return [
      PgCard(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            TextField(
              controller: _titleCtrl,
              decoration: const InputDecoration(labelText: '标题（可选，居中加粗）', isDense: true),
              onChanged: (_) => _invalidate(),
            ),
            const SizedBox(height: 12),
            TextField(
              controller: _textCtrl,
              minLines: 8,
              maxLines: 16,
              decoration: const InputDecoration(
                labelText: '正文',
                alignLabelWithHint: true,
                hintText: '要打印的文字，回车换行',
              ),
              onChanged: (_) {
                _invalidate();
                setState(() => _textLines = _textCtrl.text.split('\n').length);
              },
            ),
            const SizedBox(height: 12),
            Row(
              children: [
                Text('字号', style: TextStyle(fontSize: 13, color: scheme.onSurfaceVariant)),
                Expanded(
                  child: Slider(
                    value: _fontSize,
                    min: 6,
                    max: 48,
                    divisions: 42,
                    label: '${_fontSize.round()}',
                    onChanged: (v) {
                      setState(() => _fontSize = v);
                      _invalidate();
                    },
                  ),
                ),
                Text('${_fontSize.round()}', style: const TextStyle(fontWeight: FontWeight.w600)),
              ],
            ),
            Text(
              '约 $_textLines 行 · 超出一页会按纸张自动分页打印',
              style: TextStyle(fontSize: 12, color: scheme.onSurfaceVariant),
            ),
          ],
        ),
      ),
    ];
  }

  // ---------- 发票 UI ----------
  List<Widget> _invoiceMode() {
    final scheme = Theme.of(context).colorScheme;
    return [
      PgCard(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Text('发票图片（最多 12 张）', style: TextStyle(fontWeight: FontWeight.w600, color: scheme.onSurface)),
                const Spacer(),
                TextButton.icon(
                  onPressed: _busy
                      ? null
                      : () async {
                          if (!_guard()) return;
                          final picked = await ImagePicker().pickMultiImage(imageQuality: 92);
                          if (picked.isEmpty) return;
                          setState(() {
                            _invoices.addAll(picked.map((p) => p.path));
                            if (_invoices.length > 12) _invoices.removeRange(12, _invoices.length);
                            _composed = null;
                          });
                        },
                  icon: const Icon(Icons.add_photo_alternate_outlined, size: 18),
                  label: const Text('添加'),
                ),
              ],
            ),
            const SizedBox(height: 6),
            if (_invoices.isEmpty)
              Text('还没有发票图片', style: TextStyle(fontSize: 12.5, color: scheme.onSurfaceVariant))
            else
              Wrap(
                spacing: 8,
                runSpacing: 8,
                children: [
                  for (var i = 0; i < _invoices.length; i++)
                    Stack(
                      children: [
                        ClipRRect(
                          borderRadius: BorderRadius.circular(10),
                          child: Image.file(File(_invoices[i]), width: 74, height: 74, fit: BoxFit.cover),
                        ),
                        Positioned(
                          right: 0,
                          top: 0,
                          child: GestureDetector(
                            onTap: () => setState(() {
                              _invoices.removeAt(i);
                              _composed = null;
                            }),
                            child: Container(
                              decoration: const BoxDecoration(color: Colors.black54, shape: BoxShape.circle),
                              padding: const EdgeInsets.all(2),
                              child: const Icon(Icons.close_rounded, size: 14, color: Colors.white),
                            ),
                          ),
                        ),
                      ],
                    ),
                ],
              ),
            const SizedBox(height: 14),
            Text('每页张数', style: TextStyle(fontSize: 13, color: scheme.onSurfaceVariant)),
            const SizedBox(height: 8),
            SegmentedButton<int>(
              segments: const [
                ButtonSegment(value: 1, label: Text('1 张/页')),
                ButtonSegment(value: 2, label: Text('2 张/页')),
                ButtonSegment(value: 4, label: Text('4 张/页')),
              ],
              selected: {_per},
              onSelectionChanged: (s) => setState(() {
                _per = s.first;
                _composed = null;
              }),
            ),
          ],
        ),
      ),
    ];
  }

  // ---------- 身份证 UI ----------
  List<Widget> _idCardMode() {
    final scheme = Theme.of(context).colorScheme;
    Widget slot(String label, String? path, VoidCallback onPick, VoidCallback onClear) {
      return Expanded(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(label, style: TextStyle(fontSize: 13, color: scheme.onSurfaceVariant)),
            const SizedBox(height: 6),
            InkWell(
              onTap: onPick,
              child: Container(
                height: 96,
                decoration: BoxDecoration(
                  color: scheme.surfaceContainerHighest.withValues(alpha: 0.35),
                  borderRadius: BorderRadius.circular(12),
                  border: Border.all(color: scheme.outlineVariant),
                ),
                child: path == null
                    ? Center(child: Icon(Icons.add_a_photo_outlined, color: scheme.primary))
                    : ClipRRect(
                        borderRadius: BorderRadius.circular(12),
                        child: Image.file(File(path), width: double.infinity, fit: BoxFit.cover),
                      ),
              ),
            ),
            if (path != null)
              TextButton(onPressed: onClear, style: TextButton.styleFrom(visualDensity: VisualDensity.compact), child: const Text('清除')),
          ],
        ),
      );
    }

    Future<void> pick(bool front) async {
      if (!_guard()) return;
      final p = await ImagePicker().pickImage(source: ImageSource.gallery, imageQuality: 92);
      if (p == null) return;
      setState(() {
        if (front) {
          _front = p.path;
        } else {
          _back = p.path;
        }
        _composed = null;
      });
    }

    return [
      PgCard(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('身份证正反面（A4 上下两格，沿虚线裁切）', style: TextStyle(fontSize: 12.5, color: scheme.onSurfaceVariant)),
            const SizedBox(height: 12),
            Row(
              children: [
                slot('正面（人像面）', _front, () => pick(true), () => setState(() {
                  _front = null;
                  _composed = null;
                })),
                const SizedBox(width: 12),
                slot('反面（国徽面）', _back, () => pick(false), () => setState(() {
                  _back = null;
                  _composed = null;
                })),
              ],
            ),
          ],
        ),
      ),
    ];
  }

  // ---------- 打印机 ----------
  Widget _printerCard() {
    final scheme = Theme.of(context).colorScheme;
    return PgCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Text('打印机', style: TextStyle(fontWeight: FontWeight.w600, color: scheme.onSurface)),
              const Spacer(),
              TextButton.icon(
                onPressed: _busy ? null : () => widget.onRefreshPrinters(),
                icon: const Icon(Icons.refresh_rounded, size: 16),
                label: const Text('刷新'),
                style: TextButton.styleFrom(visualDensity: VisualDensity.compact),
              ),
            ],
          ),
          if (widget.printers.isEmpty)
            Text('还没有可用的打印队列，先在网页后台添加打印机', style: TextStyle(color: scheme.onSurfaceVariant, fontSize: 13))
          else
            DropdownButtonFormField<String>(
              initialValue: _printer,
              isExpanded: true,
              decoration: const InputDecoration(prefixIcon: Icon(Icons.local_print_shop_outlined), isDense: true),
              items: widget.printers
                  .map((p) => DropdownMenuItem(
                        value: p.name,
                        child: Text('${p.name} · ${Fmt.printerState(p.state).text}', overflow: TextOverflow.ellipsis),
                      ))
                  .toList(),
              onChanged: (v) => setState(() => _printer = v),
            ),
        ],
      ),
    );
  }

  // ---------- 参数 ----------
  Widget _optionsCard() {
    final scheme = Theme.of(context).colorScheme;
    final advanced = _ctl.advancedPrint;
    return PgCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Text('份数', style: TextStyle(fontWeight: FontWeight.w600, color: scheme.onSurface)),
              const Spacer(),
              IconButton(
                onPressed: _copies <= 1 ? null : () => setState(() => _copies -= 1),
                icon: const Icon(Icons.remove_circle_outline),
              ),
              SizedBox(
                width: 40,
                child: Text('$_copies', textAlign: TextAlign.center, style: const TextStyle(fontSize: 17, fontWeight: FontWeight.w600)),
              ),
              IconButton(
                onPressed: _copies >= _ctl.maxCopies ? null : () => setState(() => _copies += 1),
                icon: const Icon(Icons.add_circle_outline),
              ),
            ],
          ),
          if (advanced) ...[
            const Divider(height: 22),
            _label('颜色'),
            SegmentedButton<String>(
              segments: const [
                ButtonSegment(value: 'mono', label: Text('黑白')),
                ButtonSegment(value: 'color', label: Text('彩色')),
              ],
              selected: {_color},
              onSelectionChanged: (s) => setState(() => _color = s.first),
            ),
            const SizedBox(height: 12),
            _label('单双面'),
            SegmentedButton<String>(
              segments: const [
                ButtonSegment(value: 'one-sided', label: Text('单面')),
                ButtonSegment(value: 'two-sided-long-edge', label: Text('双面长边')),
                ButtonSegment(value: 'two-sided-short-edge', label: Text('双面短边')),
              ],
              selected: {_sides},
              onSelectionChanged: (s) => setState(() => _sides = s.first),
            ),
          ],
          const SizedBox(height: 12),
          _label('纸张'),
          DropdownButtonFormField<String>(
            initialValue: _media,
            isExpanded: true,
            decoration: const InputDecoration(isDense: true),
            items: _mediaList.map((m) => DropdownMenuItem(value: m, child: Text(m))).toList(),
            onChanged: (v) => setState(() {
              _media = v ?? 'A4';
              _composed = null;
            }),
          ),
          if (advanced) ...[
            Theme(
              data: Theme.of(context).copyWith(dividerColor: Colors.transparent),
              child: ExpansionTile(
                tilePadding: EdgeInsets.zero,
                childrenPadding: const EdgeInsets.only(bottom: 4),
                title: Text('更多设置', style: TextStyle(fontSize: 14, color: scheme.onSurface)),
                expandedAlignment: Alignment.centerLeft,
                children: [
                  _label('方向'),
                  SegmentedButton<String>(
                    segments: const [
                      ButtonSegment(value: 'portrait', label: Text('纵向')),
                      ButtonSegment(value: 'landscape', label: Text('横向')),
                    ],
                    selected: {_orientation},
                    onSelectionChanged: (s) => setState(() => _orientation = s.first),
                  ),
                  const SizedBox(height: 12),
                  _label('每页张数（合并打印）'),
                  DropdownButtonFormField<int>(
                    initialValue: _numberUp,
                    decoration: const InputDecoration(isDense: true),
                    items: _numberUpList.map((n) => DropdownMenuItem(value: n, child: Text('$n 页/张'))).toList(),
                    onChanged: (v) => setState(() => _numberUp = v ?? 1),
                  ),
                  const SizedBox(height: 12),
                  _label('缩放'),
                  SegmentedButton<String>(
                    segments: const [
                      ButtonSegment(value: 'auto', label: Text('自动')),
                      ButtonSegment(value: 'fit', label: Text('适应')),
                      ButtonSegment(value: 'fill', label: Text('填充')),
                      ButtonSegment(value: 'none', label: Text('原始')),
                    ],
                    selected: {_scaling},
                    onSelectionChanged: (s) => setState(() => _scaling = s.first),
                  ),
                  const SizedBox(height: 12),
                  _label('页范围（留空打印全部）'),
                  TextField(
                    controller: _rangesCtrl,
                    decoration: const InputDecoration(hintText: '例如 1-3,5', isDense: true),
                    onChanged: (_) => setState(() {}),
                  ),
                  const SizedBox(height: 12),
                  _label('奇偶页'),
                  SegmentedButton<String>(
                    segments: const [
                      ButtonSegment(value: 'all', label: Text('全部')),
                      ButtonSegment(value: 'odd', label: Text('奇数页')),
                      ButtonSegment(value: 'even', label: Text('偶数页')),
                      ButtonSegment(value: 'even-reverse', label: Text('偶数倒序')),
                    ],
                    selected: {_pageSet},
                    onSelectionChanged: (s) => setState(() => _pageSet = s.first),
                  ),
                  const SizedBox(height: 8),
                  SwitchListTile(
                    contentPadding: EdgeInsets.zero,
                    title: const Text('镜像打印', style: TextStyle(fontSize: 14)),
                    value: _mirror,
                    onChanged: (v) => setState(() => _mirror = v),
                  ),
                  SwitchListTile(
                    contentPadding: EdgeInsets.zero,
                    title: const Text('页边框', style: TextStyle(fontSize: 14)),
                    value: _pageBorder,
                    onChanged: (v) => setState(() => _pageBorder = v),
                  ),
                  TextField(
                    controller: _watermarkCtrl,
                    maxLength: 40,
                    decoration: const InputDecoration(labelText: '水印文字（可选）', isDense: true),
                    onChanged: (_) => setState(() {}),
                  ),
                ],
              ),
            ),
          ],
        ],
      ),
    );
  }

  Widget _label(String text) => Padding(
        padding: const EdgeInsets.only(bottom: 6),
        child: Text(text, style: TextStyle(fontSize: 13, color: Theme.of(context).colorScheme.onSurfaceVariant)),
      );

  // ---------- 摘要 + 提交 ----------
  Widget _summaryBar() {
    final scheme = Theme.of(context).colorScheme;
    final p = widget.printers.where((x) => x.name == _printer).toList();
    final paused = p.isNotEmpty && Fmt.printerState(p.first.state).kind == 'danger';
    final line1 = _printer == null
        ? (widget.printers.isEmpty ? '暂无可用打印机' : '请选择打印机')
        : '打印到 $_printer${paused ? '（已暂停）' : ''}';
    final line2 = Fmt.optionsSummary({
      'copies': _copies,
      'color': _color,
      'sides': _sides,
      'media': _media,
      'orientation': _orientation,
      'numberUp': _numberUp,
      'pageRanges': Fmt.sanitizeRanges(_rangesCtrl.text),
      'pageSet': _pageSet,
      'mirror': _mirror,
      'pageBorder': _pageBorder,
      'watermark': _watermarkCtrl.text.trim(),
    });
    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: scheme.primary.withValues(alpha: 0.07),
        borderRadius: BorderRadius.circular(14),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(Icons.local_print_shop_outlined, size: 16, color: scheme.primary),
              const SizedBox(width: 8),
              Expanded(child: Text(line1, style: TextStyle(fontWeight: FontWeight.w600, color: scheme.primary, fontSize: 13.5))),
            ],
          ),
          const SizedBox(height: 4),
          Text(line2, style: TextStyle(fontSize: 12.5, color: scheme.onSurfaceVariant)),
        ],
      ),
    );
  }
}

class _PendingNotice extends StatelessWidget {
  const _PendingNotice();

  @override
  Widget build(BuildContext context) {
    return Container(
      margin: const EdgeInsets.only(bottom: 12),
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: const Color(0xFFFFF7E6),
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: const Color(0xFFFFE0A3)),
      ),
      child: const Row(
        children: [
          Icon(Icons.hourglass_top_rounded, color: pgWarn, size: 18),
          SizedBox(width: 10),
          Expanded(
            child: Text('账号还在等管理员审批，审批通过后才能打印', style: TextStyle(fontSize: 13, color: Color(0xFF6B4A00))),
          ),
        ],
      ),
    );
  }
}
