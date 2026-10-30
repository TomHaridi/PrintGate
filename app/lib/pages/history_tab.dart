import 'package:flutter/material.dart';

import '../core/api.dart';
import '../core/models.dart';
import '../theme.dart';

class HistoryTab extends StatefulWidget {
  const HistoryTab({super.key});

  @override
  State<HistoryTab> createState() => HistoryTabState();
}

class HistoryTabState extends State<HistoryTab> {
  bool _loading = true;
  String _error = '';
  List<PgTask> _tasks = const [];

  @override
  void initState() {
    super.initState();
    reload();
  }

  Future<void> reload() async {
    if (mounted) setState(() => _loading = _tasks.isEmpty);
    try {
      final list = await Api().tasks();
      if (!mounted) return;
      setState(() {
        _tasks = list;
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

  Future<void> _cancel(PgTask t) async {
    try {
      await Api().cancelTask(t.id);
      await reload();
    } on ApiException catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(e.message)));
    }
  }

  @override
  Widget build(BuildContext context) {
    if (_loading) return const Center(child: CircularProgressIndicator());

    final scheme = Theme.of(context).colorScheme;
    if (_error.isNotEmpty && _tasks.isEmpty) {
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
              FilledButton.tonal(onPressed: reload, child: const Text('重试')),
            ],
          ),
        ),
      );
    }

    return RefreshIndicator(
      onRefresh: reload,
      child: _tasks.isEmpty
          ? ListView(
              children: const [
                SizedBox(height: 120),
                Icon(Icons.receipt_long_outlined, size: 44, color: Color(0xFF8A9C9A)),
                SizedBox(height: 12),
                Center(child: Text('还没有打印记录')),
              ],
            )
          : ListView.separated(
              padding: const EdgeInsets.fromLTRB(16, 8, 16, 24),
              itemCount: _tasks.length,
              separatorBuilder: (_, __) => const SizedBox(height: 10),
              itemBuilder: (context, i) {
                final t = _tasks[i];
                final color = statusColor(t.status);
                return PgCard(
                  padding: const EdgeInsets.all(14),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Row(
                        children: [
                          Expanded(
                            child: Text(
                              t.filename.isEmpty ? '任务 #${t.id}' : t.filename,
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style: const TextStyle(fontWeight: FontWeight.w600),
                            ),
                          ),
                          Container(
                            padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 3),
                            decoration: BoxDecoration(
                              color: color.withValues(alpha: 0.12),
                              borderRadius: BorderRadius.circular(20),
                            ),
                            child: Text(
                              t.statusText,
                              style: TextStyle(fontSize: 12, color: color, fontWeight: FontWeight.w600),
                            ),
                          ),
                        ],
                      ),
                      const SizedBox(height: 8),
                      Text(
                        '${t.printer.isEmpty ? "未指定打印机" : t.printer} · ${t.copies} 份'
                        '${t.pages > 0 ? " · ${t.pages} 页" : ""}',
                        style: TextStyle(fontSize: 12.5, color: scheme.onSurfaceVariant),
                      ),
                      const SizedBox(height: 4),
                      Row(
                        children: [
                          Text(_timeText(t.createdAt), style: TextStyle(fontSize: 12, color: scheme.onSurfaceVariant)),
                          const Spacer(),
                          if (t.canCancel)
                            TextButton(
                              onPressed: () => _cancel(t),
                              style: TextButton.styleFrom(visualDensity: VisualDensity.compact),
                              child: const Text('取消'),
                            ),
                        ],
                      ),
                      if (t.message.isNotEmpty) ...[
                        const SizedBox(height: 6),
                        Text(t.message, style: const TextStyle(fontSize: 12.5, color: pgDanger)),
                      ],
                    ],
                  ),
                );
              },
            ),
    );
  }

  /// 服务端给的是 ISO8601（UTC），这里换成「MM-dd HH:mm」的本地时间
  static String _timeText(String iso) {
    if (iso.isEmpty) return '';
    final dt = DateTime.tryParse(iso)?.toLocal();
    if (dt == null) return iso;
    String two(int n) => n.toString().padLeft(2, '0');
    return '${two(dt.month)}-${two(dt.day)} ${two(dt.hour)}:${two(dt.minute)}';
  }
}
