import 'package:flutter/material.dart';

import '../core/api.dart';
import '../core/models.dart';
import '../theme.dart';

/// 文件页：只列自己的文件，点一下就能拿去打印，左滑删除
class FilesTab extends StatefulWidget {
  const FilesTab({super.key, required this.selected, required this.onUse});

  final ValueNotifier<PgFileItem?> selected;
  final void Function(PgFileItem) onUse;

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
    setState(() {
      _loading = true;
      _error = '';
    });
    try {
      final list = await Api().files();
      if (!mounted) return;
      setState(() {
        _files = list;
        _loading = false;
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

  @override
  Widget build(BuildContext context) {
    if (_loading) return const Center(child: CircularProgressIndicator());

    if (_error.isNotEmpty) {
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

    return RefreshIndicator(
      onRefresh: _load,
      child: _files.isEmpty
          ? ListView(
              children: const [
                SizedBox(height: 120),
                Icon(Icons.folder_open_rounded, size: 44, color: Color(0xFF8A9C9A)),
                SizedBox(height: 12),
                Center(child: Text('还没有文件，去「打印」页选一份')),
              ],
            )
          : ListView.separated(
              padding: const EdgeInsets.fromLTRB(16, 8, 16, 24),
              itemCount: _files.length,
              separatorBuilder: (_, __) => const SizedBox(height: 10),
              itemBuilder: (context, i) {
                final f = _files[i];
                final scheme = Theme.of(context).colorScheme;
                return Dismissible(
                  key: ValueKey('file-${f.id}'),
                  direction: DismissDirection.endToStart,
                  confirmDismiss: (_) async {
                    await _delete(f);
                    return false; // 删除后由 _load 刷新列表，Dismissible 不自己移除
                  },
                  background: Container(
                    alignment: Alignment.centerRight,
                    padding: const EdgeInsets.only(right: 20),
                    decoration: BoxDecoration(color: pgDanger, borderRadius: BorderRadius.circular(18)),
                    child: const Icon(Icons.delete_outline, color: Colors.white),
                  ),
                  child: PgCard(
                    padding: const EdgeInsets.all(12),
                    child: Row(
                      children: [
                        Container(
                          width: 44,
                          height: 44,
                          decoration: BoxDecoration(color: pgPrimarySoft, borderRadius: BorderRadius.circular(12)),
                          child: Icon(f.isImage ? Icons.image_outlined : Icons.description_outlined, color: pgPrimary),
                        ),
                        const SizedBox(width: 12),
                        Expanded(
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Text(f.filename, maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontWeight: FontWeight.w600)),
                              const SizedBox(height: 3),
                              Text(
                                '${f.pages > 0 ? "${f.pages} 页 · " : ""}${f.sizeText}',
                                style: TextStyle(fontSize: 12.5, color: scheme.onSurfaceVariant),
                              ),
                            ],
                          ),
                        ),
                        TextButton(
                          onPressed: () => widget.onUse(f),
                          child: const Text('打印'),
                        ),
                      ],
                    ),
                  ),
                );
              },
            ),
    );
  }
}
