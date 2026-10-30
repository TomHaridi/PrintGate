import 'package:flutter/material.dart';

import '../core/api.dart';
import '../core/format.dart';
import '../core/models.dart';
import '../theme.dart';

class HistoryTab extends StatefulWidget {
  const HistoryTab({super.key});

  @override
  State<HistoryTab> createState() => HistoryTabState();
}

class HistoryTabState extends State<HistoryTab> {
  static const _tabs = [
    (key: 'all', label: '全部'),
    (key: 'pending', label: '待审批'),
    (key: 'printing', label: '打印中'),
    (key: 'done', label: '已完成'),
    (key: 'failed', label: '未完成'),
  ];

  bool _loading = true;
  String _error = '';
  String _tab = 'all';
  List<PgTask> _all = const [];

  @override
  void initState() {
    super.initState();
    reload();
  }

  Future<void> reload() async {
    if (mounted) setState(() => _loading = _all.isEmpty);
    try {
      final list = await Api().tasks();
      if (!mounted) return;
      setState(() {
        _all = list;
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

  /// 后端状态生命周期：pending → approved → printing → done。
  /// approved 归到「打印中」，failed/rejected/canceled 归到「未完成」，与小程序一致。
  bool _match(PgTask t) {
    switch (_tab) {
      case 'all':
        return true;
      case 'printing':
        return t.status == 'approved' || t.status == 'printing';
      case 'failed':
        return t.status == 'failed' || t.status == 'rejected' || t.status == 'canceled';
      default:
        return t.status == _tab;
    }
  }

  Future<void> _cancel(PgTask t) async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('取消任务'),
        content: Text('取消「${t.displayName}」这份打印任务？'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('再想想')),
          TextButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('取消任务')),
        ],
      ),
    );
    if (ok != true) return;
    try {
      await Api().cancelTask(t.id);
      await reload();
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('已取消')));
    } on ApiException catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(e.message)));
    }
  }

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final tasks = _all.where(_match).toList();

    return Column(
      children: [
        SizedBox(
          height: 46,
          child: ListView(
            scrollDirection: Axis.horizontal,
            padding: const EdgeInsets.symmetric(horizontal: 12),
            children: [
              for (final t in _tabs)
                Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 6),
                  child: ChoiceChip(
                    label: Text(t.label, style: const TextStyle(fontSize: 13)),
                    selected: _tab == t.key,
                    onSelected: (_) => setState(() => _tab = t.key),
                    showCheckmark: false,
                  ),
                ),
            ],
          ),
        ),
        Expanded(
          child: _loading
              ? const Center(child: CircularProgressIndicator())
              : RefreshIndicator(
                  onRefresh: reload,
                  child: tasks.isEmpty
                      ? ListView(
                          children: [
                            const SizedBox(height: 100),
                            Icon(Icons.receipt_long_outlined, size: 44, color: scheme.onSurfaceVariant),
                            const SizedBox(height: 12),
                            Center(
                              child: Text(
                                _error.isNotEmpty ? _error : (_tab == 'all' ? '还没有打印记录' : '这个分类下没有记录'),
                                style: TextStyle(color: scheme.onSurfaceVariant),
                              ),
                            ),
                          ],
                        )
                      : ListView.separated(
                          padding: const EdgeInsets.fromLTRB(16, 6, 16, 24),
                          itemCount: tasks.length,
                          separatorBuilder: (_, __) => const SizedBox(height: 10),
                          itemBuilder: (context, i) => _taskCard(tasks[i]),
                        ),
                ),
        ),
      ],
    );
  }

  Widget _taskCard(PgTask t) {
    final scheme = Theme.of(context).colorScheme;
    final st = Fmt.taskStatus(t.status);
    return PgCard(
      padding: const EdgeInsets.all(14),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(
                child: Text(t.displayName, maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontWeight: FontWeight.w600)),
              ),
              const SizedBox(width: 8),
              StatusTag(text: st.text, kind: st.kind),
            ],
          ),
          const SizedBox(height: 8),
          Text(
            '${t.printer.isEmpty ? '默认打印机' : t.printer} · ${Fmt.optionsSummary(t.options)}',
            style: TextStyle(fontSize: 12.5, color: scheme.onSurfaceVariant),
          ),
          const SizedBox(height: 4),
          Row(
            children: [
              Text('${Fmt.relative(t.createdAt)}${t.pages > 0 ? " · ${t.pages} 页" : ""}', style: TextStyle(fontSize: 12, color: scheme.onSurfaceVariant)),
              const Spacer(),
              if (t.canCancel)
                TextButton(
                  onPressed: () => _cancel(t),
                  style: TextButton.styleFrom(visualDensity: VisualDensity.compact),
                  child: const Text('取消'),
                ),
            ],
          ),
          if (t.hasError) ...[
            const SizedBox(height: 6),
            Text(t.error, style: const TextStyle(fontSize: 12.5, color: pgDanger)),
          ],
        ],
      ),
    );
  }
}
