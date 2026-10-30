import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';
import 'package:image_picker/image_picker.dart';

import '../core/api.dart';
import '../core/models.dart';
import '../theme.dart';

/// 打印页：选文件（图片可多选、自动合成多页 PDF）→ 选打印机 → 参数 → 提交
class PrintTab extends StatefulWidget {
  const PrintTab({
    super.key,
    required this.me,
    required this.printers,
    required this.selected,
    required this.onRefreshPrinters,
    required this.onPrinted,
  });

  final MeResult? me;
  final List<PgPrinter> printers;
  final ValueNotifier<PgFileItem?> selected;
  final Future<void> Function() onRefreshPrinters;
  final VoidCallback onPrinted;

  @override
  State<PrintTab> createState() => _PrintTabState();
}

class _PrintTabState extends State<PrintTab> {
  static const _maxImages = 9;
  static const _mediaOptions = ['A4', 'A3', 'A5', 'A6', 'Letter', 'Legal', 'B5', '16K'];

  String? _printer;
  int _copies = 1;
  String _color = 'mono';
  String _sides = 'one-sided';
  String _media = 'A4';
  String _orientation = 'portrait';
  String _ranges = '';
  String _watermark = '';

  bool _busy = false;
  String _busyText = '';

  int get _maxCopies => (widget.me?.maxCopies ?? 99).clamp(1, 999);

  @override
  void initState() {
    super.initState();
    _pickDefaultPrinter();
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
      orElse: () => widget.printers.firstWhere((p) => p.usable, orElse: () => widget.printers.first),
    );
    _printer = def.name;
  }

  void _toast(String msg) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(msg)));
  }

  // ---------- 选文件 ----------
  Future<void> _pickImages() async {
    if (_busy) return;
    try {
      final picked = await ImagePicker().pickMultiImage(imageQuality: 92);
      if (picked.isEmpty) return;
      final files = picked.take(_maxImages).toList();
      await _uploadPaths(
        files.map((f) => f.path).toList(),
        files.map((f) => _baseName(f.path)).toList(),
      );
    } catch (e) {
      _toast('选择图片失败：$e');
    }
  }

  Future<void> _pickPdf() async {
    if (_busy) return;
    try {
      final r = await FilePicker.platform.pickFiles(
        type: FileType.custom,
        allowedExtensions: const ['pdf'],
        allowMultiple: false,
        withData: false,
      );
      final path = r?.files.firstOrNull?.path;
      if (path == null) return;
      await _uploadPaths([path], [_baseName(path)]);
    } catch (e) {
      _toast('选择文件失败：$e');
    }
  }

  /// 多张图片分别上传（服务端一次只收一个文件），再让服务端合成一份多页 PDF，
  /// 这样打印记录里是一条「N 页」文档，预览/计页与传一个真 PDF 完全一致。
  Future<void> _uploadPaths(List<String> paths, List<String> names) async {
    setState(() {
      _busy = true;
      _busyText = paths.length > 1 ? '上传 1/${paths.length}…' : '上传中…';
    });
    final api = Api();
    try {
      final ids = <int>[];
      PgFileItem? first;
      for (var i = 0; i < paths.length; i++) {
        if (mounted) setState(() => _busyText = '上传 ${i + 1}/${paths.length}…');
        final f = await api.upload(paths[i], names[i]);
        ids.add(f.id);
        first ??= f;
      }
      // 单张直接用上传结果；多张再让服务端合成（不要重复上传，服务端会多出一份垃圾文件）
      final result = ids.length > 1
          ? await api.mergeImages(ids, '图片合并-${ids.length}张.pdf')
          : first!;
      widget.selected.value = result;
      _toast('已就绪：${result.filename}');
    } on ApiException catch (e) {
      _toast(e.message);
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

  // ---------- 提交 ----------
  Future<void> _submit() async {
    final file = widget.selected.value;
    if (file == null) {
      _toast('先选一份文件');
      return;
    }
    final printer = _printer;
    if (printer == null || printer.isEmpty) {
      _toast('没有可用打印机，请联系管理员');
      return;
    }
    setState(() => _busy = true);
    try {
      await Api().print(file.id, printer, {
        'copies': _copies,
        'color': _color,
        'sides': _sides,
        'media': _media,
        'orientation': _orientation,
        if (_ranges.trim().isNotEmpty) 'pageRanges': _ranges.trim(),
        if (_watermark.trim().isNotEmpty) 'watermark': _watermark.trim(),
      });
      widget.selected.value = null;
      _toast(widget.me?.approveEachJob == true ? '已提交，等待管理员审批' : '已提交打印');
      widget.onPrinted();
    } on ApiException catch (e) {
      _toast(e.message);
    } catch (e) {
      _toast('提交失败：$e');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final pending = widget.me?.user.pending ?? false;

    return ListView(
      padding: const EdgeInsets.fromLTRB(16, 8, 16, 24),
      children: [
        if (pending) const _PendingNotice(),
        ValueListenableBuilder<PgFileItem?>(
          valueListenable: widget.selected,
          builder: (context, file, _) => _fileCard(file, scheme),
        ),
        const SizedBox(height: 12),
        PgCard(
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
              const SizedBox(height: 4),
              if (widget.printers.isEmpty)
                Text('还没有可用的打印队列，先在网页后台添加打印机', style: TextStyle(color: scheme.onSurfaceVariant, fontSize: 13))
              else
                DropdownButtonFormField<String>(
                  initialValue: _printer,
                  isExpanded: true,
                  decoration: const InputDecoration(prefixIcon: Icon(Icons.local_print_shop_outlined)),
                  items: widget.printers
                      .map((p) => DropdownMenuItem(
                            value: p.name,
                            child: Text('${p.name} · ${p.stateText}', overflow: TextOverflow.ellipsis),
                          ))
                      .toList(),
                  onChanged: (v) => setState(() => _printer = v),
                ),
            ],
          ),
        ),
        const SizedBox(height: 12),
        PgCard(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              _copiesRow(scheme),
              const Divider(height: 24),
              _labeled('颜色', SegmentedButton<String>(
                segments: const [
                  ButtonSegment(value: 'mono', label: Text('黑白')),
                  ButtonSegment(value: 'color', label: Text('彩色')),
                ],
                selected: {_color},
                onSelectionChanged: (s) => setState(() => _color = s.first),
              )),
              const SizedBox(height: 14),
              _labeled('单双面', SegmentedButton<String>(
                segments: const [
                  ButtonSegment(value: 'one-sided', label: Text('单面')),
                  ButtonSegment(value: 'two-sided-long-edge', label: Text('双面')),
                ],
                selected: {_sides},
                onSelectionChanged: (s) => setState(() => _sides = s.first),
              )),
              const SizedBox(height: 14),
              _labeled('纸张', DropdownButtonFormField<String>(
                initialValue: _media,
                isExpanded: true,
                items: _mediaOptions.map((m) => DropdownMenuItem(value: m, child: Text(m))).toList(),
                onChanged: (v) => setState(() => _media = v ?? 'A4'),
              )),
              const SizedBox(height: 6),
              Theme(
                data: Theme.of(context).copyWith(dividerColor: Colors.transparent),
                child: ExpansionTile(
                  tilePadding: EdgeInsets.zero,
                  childrenPadding: const EdgeInsets.only(bottom: 6),
                  title: Text('更多设置', style: TextStyle(fontSize: 14, color: scheme.onSurface)),
                  expandedAlignment: Alignment.centerLeft,
                  children: [
                    const SizedBox(height: 4),
                    _labeled('方向', SegmentedButton<String>(
                      segments: const [
                        ButtonSegment(value: 'portrait', label: Text('纵向')),
                        ButtonSegment(value: 'landscape', label: Text('横向')),
                      ],
                      selected: {_orientation},
                      onSelectionChanged: (s) => setState(() => _orientation = s.first),
                    )),
                    const SizedBox(height: 12),
                    TextField(
                      decoration: const InputDecoration(
                        labelText: '页范围（留空打印全部）',
                        hintText: '例如 1-3,5',
                      ),
                      keyboardType: TextInputType.text,
                      onChanged: (v) => _ranges = v,
                    ),
                    const SizedBox(height: 12),
                    TextField(
                      decoration: const InputDecoration(
                        labelText: '水印文字（可选，最多 40 字）',
                        hintText: '例如 内部资料',
                      ),
                      maxLength: 40,
                      onChanged: (v) => _watermark = v,
                    ),
                  ],
                ),
              ),
            ],
          ),
        ),
        const SizedBox(height: 16),
        FilledButton.icon(
          onPressed: _busy ? null : _submit,
          icon: const Icon(Icons.print_rounded),
          label: Text(_busy && _busyText.isEmpty ? '提交中…' : '开始打印'),
        ),
      ],
    );
  }

  Widget _fileCard(PgFileItem? file, ColorScheme scheme) {
    if (file == null) {
      return PgCard(
        padding: const EdgeInsets.symmetric(vertical: 26, horizontal: 16),
        child: Column(
          children: [
            Icon(Icons.add_photo_alternate_outlined, size: 40, color: scheme.primary),
            const SizedBox(height: 10),
            Text('选要打印的文件', style: TextStyle(fontWeight: FontWeight.w600, color: scheme.onSurface)),
            const SizedBox(height: 4),
            Text(
              '图片可多选（最多 $_maxImages 张），自动合成一份多页 PDF',
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
                    onPressed: _busy ? null : _pickPdf,
                    icon: const Icon(Icons.picture_as_pdf_outlined, size: 18),
                    label: const Text('PDF'),
                  ),
                ),
              ],
            ),
            if (_busy) ...[
              const SizedBox(height: 14),
              Row(
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  const SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2)),
                  const SizedBox(width: 8),
                  Text(_busyText.isEmpty ? '处理中…' : _busyText, style: TextStyle(fontSize: 13, color: scheme.onSurfaceVariant)),
                ],
              ),
            ],
          ],
        ),
      );
    }

    return PgCard(
      child: Row(
        children: [
          Container(
            width: 46,
            height: 46,
            decoration: BoxDecoration(color: pgPrimarySoft, borderRadius: BorderRadius.circular(12)),
            child: Icon(
              file.isImage ? Icons.image_outlined : Icons.description_outlined,
              color: pgPrimary,
            ),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(file.filename, maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontWeight: FontWeight.w600)),
                const SizedBox(height: 3),
                Text(
                  '${file.pages > 0 ? "${file.pages} 页 · " : ""}${file.sizeText}',
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
    );
  }

  Widget _copiesRow(ColorScheme scheme) {
    return Row(
      children: [
        Text('份数', style: TextStyle(fontWeight: FontWeight.w600, color: scheme.onSurface)),
        const Spacer(),
        IconButton(
          onPressed: _copies <= 1 ? null : () => setState(() => _copies -= 1),
          icon: const Icon(Icons.remove_circle_outline),
        ),
        SizedBox(
          width: 44,
          child: Text('$_copies', textAlign: TextAlign.center, style: const TextStyle(fontSize: 17, fontWeight: FontWeight.w600)),
        ),
        IconButton(
          onPressed: _copies >= _maxCopies ? null : () => setState(() => _copies += 1),
          icon: const Icon(Icons.add_circle_outline),
        ),
      ],
    );
  }

  Widget _labeled(String label, Widget child) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(label, style: TextStyle(fontSize: 13, color: Theme.of(context).colorScheme.onSurfaceVariant)),
        const SizedBox(height: 8),
        child,
      ],
    );
  }

  static String _baseName(String path) {
    final parts = path.split(RegExp(r'[\\/]'));
    return parts.isEmpty ? 'file' : parts.last;
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
