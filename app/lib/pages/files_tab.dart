import 'dart:io';

import 'package:flutter/material.dart';
import 'package:gal/gal.dart';

import '../core/api.dart';
import '../core/format.dart';
import '../core/models.dart';
import '../theme.dart';

/// 我的文件：预览（可翻页/存相册）、去打印、删除
class FilesTab extends StatefulWidget {
  const FilesTab({
    super.key,
    required this.selected,
    required this.onUse,
    required this.onUpload,
  });

  final ValueNotifier<PgFileItem?> selected;
  final void Function(PgFileItem) onUse;
  final VoidCallback onUpload;

  @override
  State<FilesTab> createState() => _FilesTabState();
}

class _FilesTabState extends State<FilesTab> {
  bool _loading = true;
  String _error = '';
  List<PgFileItem> _files = const [];

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    if (mounted) setState(() => _loading = _files.isEmpty);
    try {
      final list = await Api().files();
      if (!mounted) return;
      setState(() {
        _files = list;
        _loading = false;
        _error = '';
      });
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() {
        _error = e.message;
        _loading = false;
      });
    }
  }

  Future<void> _delete(PgFileItem f) async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('删除文件'),
        content: Text('「${f.filename}」删除后不能恢复，确定吗？'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('取消')),
          TextButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('删除')),
        ],
      ),
    );
    if (ok != true) return;
    try {
      await Api().deleteFile(f.id);
      if (widget.selected.value?.id == f.id) widget.selected.value = null;
      _load();
    } on ApiException catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(e.message)));
    }
  }

  Future<void> _openPreview(PgFileItem f) async {
    await showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      backgroundColor: Colors.transparent,
      builder: (_) => _PreviewSheet(
        file: f,
        onPrint: () {
          Navigator.pop(context);
          widget.onUse(f);
        },
        onDelete: () async {
          Navigator.pop(context);
          await _delete(f);
        },
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    if (_loading) return const Center(child: CircularProgressIndicator());

    if (_error.isNotEmpty && _files.isEmpty) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(32),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              const Icon(Icons.cloud_off_rounded, size: 44, color: Color(0xFF8A9C9A)),
              const SizedBox(height: 12),
              Text(_error, textAlign: TextAlign.center),
              const SizedBox(height: 18),
              FilledButton.tonal(onPressed: _load, child: const Text('重试')),
            ],
          ),
        ),
      );
    }

    if (_files.isEmpty) {
      return Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Icon(Icons.folder_open_rounded, size: 44, color: Color(0xFF8A9C9A)),
            const SizedBox(height: 12),
            const Text('还没有文件'),
            const SizedBox(height: 14),
            FilledButton.tonal(onPressed: widget.onUpload, child: const Text('去上传')),
          ],
        ),
      );
    }

    return RefreshIndicator(
      onRefresh: _load,
      child: ListView.separated(
        padding: const EdgeInsets.fromLTRB(16, 8, 16, 24),
        itemCount: _files.length,
        separatorBuilder: (_, __) => const SizedBox(height: 10),
        itemBuilder: (context, i) {
          final f = _files[i];
          final scheme = Theme.of(context).colorScheme;
          return PgCard(
            padding: const EdgeInsets.all(12),
            onTap: () => _openPreview(f),
            child: Row(
              children: [
                Container(
                  width: 44,
                  height: 44,
                  decoration: BoxDecoration(color: scheme.primary.withValues(alpha: 0.1), borderRadius: BorderRadius.circular(12)),
                  child: Icon(Fmt.isImageName(f.filename) ? Icons.image_outlined : Icons.description_outlined, color: scheme.primary),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(f.filename, maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontWeight: FontWeight.w600)),
                      const SizedBox(height: 3),
                      Text(
                        '${f.pages > 0 ? "${f.pages} 页 · " : ""}${Fmt.size(f.size)} · ${Fmt.time(f.createdAt)}',
                        style: TextStyle(fontSize: 12.5, color: scheme.onSurfaceVariant),
                      ),
                    ],
                  ),
                ),
                TextButton(onPressed: () => widget.onUse(f), child: const Text('打印')),
                IconButton(
                  tooltip: '删除',
                  onPressed: () => _delete(f),
                  icon: const Icon(Icons.delete_outline, size: 20),
                ),
              ],
            ),
          );
        },
      ),
    );
  }
}

/// 预览弹层：服务端按 ?page=N 逐页渲染，可翻页 / 存相册 / 直接打印
class _PreviewSheet extends StatefulWidget {
  const _PreviewSheet({required this.file, required this.onPrint, required this.onDelete});

  final PgFileItem file;
  final VoidCallback onPrint;
  final VoidCallback onDelete;

  @override
  State<_PreviewSheet> createState() => _PreviewSheetState();
}

class _PreviewSheetState extends State<_PreviewSheet> {
  File? _img;
  bool _loading = true;
  String _err = '';
  int _page = 1;

  int get _total => widget.file.pages;

  @override
  void initState() {
    super.initState();
    _fetch(1);
  }

  Future<void> _fetch(int page) async {
    setState(() {
      _loading = true;
      _err = '';
      _page = page;
    });
    try {
      final f = await Api().downloadPreview(widget.file.id, page);
      if (!mounted) return;
      setState(() {
        _img = f;
        _loading = false;
      });
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() {
        _err = e.message;
        _loading = false;
      });
    }
  }

  Future<void> _saveToAlbum() async {
    final img = _img;
    if (img == null) return;
    try {
      if (!await Gal.hasAccess()) {
        final ok = await Gal.requestAccess();
        if (!ok) {
          if (!mounted) return;
          ScaffoldMessenger.of(context).showSnackBar(
            const SnackBar(content: Text('没有相册权限，去「设置 → PrintGate → 照片」里打开')),
          );
          return;
        }
      }
      await Gal.putImage(img.path, album: 'PrintGate');
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('已保存到相册')));
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('保存失败：$e')));
    }
  }

  @override
  Widget build(BuildContext context) {
    final dark = Theme.of(context).brightness == Brightness.dark;
    return Container(
      height: MediaQuery.of(context).size.height * 0.86,
      decoration: BoxDecoration(
        color: dark ? const Color(0xFF16201E) : Colors.white,
        borderRadius: const BorderRadius.vertical(top: Radius.circular(24)),
      ),
      child: SafeArea(
        top: false,
        child: Column(
          children: [
            const SizedBox(height: 10),
            Container(
              width: 38,
              height: 4,
              decoration: BoxDecoration(color: dark ? const Color(0xFF3A4A47) : const Color(0xFFDCE3E2), borderRadius: BorderRadius.circular(2)),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(20, 12, 12, 6),
              child: Row(
                children: [
                  Expanded(
                    child: Text(
                      widget.file.filename,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 15),
                    ),
                  ),
                  IconButton(onPressed: () => Navigator.pop(context), icon: const Icon(Icons.close_rounded)),
                ],
              ),
            ),
            Expanded(
              child: Padding(
                padding: const EdgeInsets.symmetric(horizontal: 16),
                child: Container(
                  width: double.infinity,
                  decoration: BoxDecoration(
                    color: dark ? const Color(0xFF0E1514) : const Color(0xFFF4F7F6),
                    borderRadius: BorderRadius.circular(16),
                  ),
                  child: _body(),
                ),
              ),
            ),
            if (_total > 1)
              Padding(
                padding: const EdgeInsets.only(top: 6),
                child: Row(
                  mainAxisAlignment: MainAxisAlignment.center,
                  children: [
                    IconButton(onPressed: _page <= 1 ? null : () => _fetch(_page - 1), icon: const Icon(Icons.chevron_left_rounded)),
                    Text('第 $_page / $_total 页'),
                    IconButton(onPressed: _page >= _total ? null : () => _fetch(_page + 1), icon: const Icon(Icons.chevron_right_rounded)),
                  ],
                ),
              ),
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 8, 16, 12),
              child: Row(
                children: [
                  Expanded(
                    child: OutlinedButton.icon(
                      onPressed: _img == null ? null : _saveToAlbum,
                      icon: const Icon(Icons.download_rounded, size: 18),
                      label: const Text('存相册'),
                    ),
                  ),
                  const SizedBox(width: 10),
                  Expanded(
                    child: FilledButton.icon(
                      onPressed: widget.onPrint,
                      icon: const Icon(Icons.print_rounded, size: 18),
                      label: const Text('打印'),
                    ),
                  ),
                  const SizedBox(width: 10),
                  IconButton(onPressed: widget.onDelete, icon: const Icon(Icons.delete_outline)),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _body() {
    if (_loading) return const Center(child: CircularProgressIndicator());
    if (_err.isNotEmpty) {
      return Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(_err, style: const TextStyle(fontSize: 12.5, color: Color(0xFF8A9C9A))),
            const SizedBox(height: 8),
            TextButton(onPressed: () => _fetch(_page), child: const Text('重试')),
          ],
        ),
      );
    }
    final img = _img;
    if (img == null) return const SizedBox.shrink();
    return ClipRRect(
      borderRadius: BorderRadius.circular(16),
      child: InteractiveViewer(
        minScale: 1,
        maxScale: 4,
        child: Image.file(img, fit: BoxFit.contain, width: double.infinity),
      ),
    );
  }
}
