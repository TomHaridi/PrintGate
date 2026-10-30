import 'package:flutter/material.dart';

import '../../core/api.dart';
import '../../core/format.dart';
import '../../core/models.dart';
import '../../theme.dart';

/// 任务审批：待审批（默认）/ 全部，逐单通过或拒绝
class AdminTasksPage extends StatefulWidget {
  const AdminTasksPage({super.key});

  @override
  State<AdminTasksPage> createState() => _AdminTasksPageState();
}

class _AdminTasksPageState extends State<AdminTasksPage> {
  String _status = 'pending';
  bool _loading = true;
  String _error = '';
  List<PgTask> _tasks = const [];

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
      final list = await Api().adminTasks(status: _status);
      if (!mounted) return;
      setState(() {
        _tasks = list;
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

  Future<void> _act(PgTask t, String action) async {
    try {
      await Api().adminTaskAction(t.id, action);
      _load();
    } on ApiException catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(e.message)));
    }
  }

  Future<void> _cleanup() async {
    final ok = await showDialog<String>(
      context: context,
      builder: (ctx) => SimpleDialog(
        title: const Text('清理历史'),
        children: [
          for (final e in const [
            ('done', '只清理已完成'),
            ('failed', '只清理失败/取消'),
            ('all', '清理全部已结束'),
          ])
            SimpleDialogOption(
              onPressed: () => Navigator.pop(ctx, e.$1),
              child: Padding(padding: const EdgeInsets.symmetric(vertical: 8), child: Text(e.$2)),
            ),
        ],
      ),
    );
    if (ok == null) return;
    try {
      final r = await Api().adminTaskCleanup(status: ok == 'all' ? null : ok);
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(r['msg']?.toString() ?? '已清理')));
      _load();
    } on ApiException catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(e.message)));
    }
  }

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Scaffold(
      appBar: AppBar(
        title: const Text('任务'),
        actions: [
          IconButton(tooltip: '清理历史', onPressed: _cleanup, icon: const Icon(Icons.cleaning_services_outlined)),
          IconButton(onPressed: _loading ? null : _load, icon: const Icon(Icons.refresh_rounded)),
        ],
      ),
      body: Column(
        children: [
          SizedBox(
            height: 46,
            child: ListView(
              scrollDirection: Axis.horizontal,
              padding: const EdgeInsets.symmetric(horizontal: 12),
              children: [
                for (final e in const [
                  ('pending', '待审批'),
                  ('all', '全部'),
                  ('printing', '打印中'),
                  ('done', '已完成'),
                ])
                  Padding(
                    padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 6),
                    child: ChoiceChip(
                      label: Text(e.$2, style: const TextStyle(fontSize: 13)),
                      selected: _status == e.$1,
                      showCheckmark: false,
                      onSelected: (_) {
                        setState(() => _status = e.$1);
                        _load();
                      },
                    ),
                  ),
              ],
            ),
          ),
          Expanded(
            child: _loading
                ? const Center(child: CircularProgressIndicator())
                : _error.isNotEmpty
                    ? Center(child: Text(_error))
                    : RefreshIndicator(
                        onRefresh: _load,
                        child: _tasks.isEmpty
                            ? ListView(children: const [
                                SizedBox(height: 100),
                                Center(child: Text('这个分类下没有任务')),
                              ])
                            : ListView.separated(
                                padding: const EdgeInsets.fromLTRB(16, 4, 16, 24),
                                itemCount: _tasks.length,
                                separatorBuilder: (_, __) => const SizedBox(height: 10),
                                itemBuilder: (context, i) {
                                  final t = _tasks[i];
                                  final st = Fmt.taskStatus(t.status);
                                  return PgCard(
                                    padding: const EdgeInsets.all(14),
                                    child: Column(
                                      crossAxisAlignment: CrossAxisAlignment.start,
                                      children: [
                                        Row(
                                          children: [
                                            Expanded(
                                              child: Text(
                                                t.displayName,
                                                maxLines: 1,
                                                overflow: TextOverflow.ellipsis,
                                                style: const TextStyle(fontWeight: FontWeight.w600),
                                              ),
                                            ),
                                            StatusTag(text: st.text, kind: st.kind),
                                          ],
                                        ),
                                        const SizedBox(height: 6),
                                        Text(
                                          '${t.nickname.isEmpty ? "用户#${t.id}" : t.nickname} · ${t.printer} · ${Fmt.optionsSummary(t.options)}',
                                          style: TextStyle(fontSize: 12.5, color: scheme.onSurfaceVariant),
                                        ),
                                        const SizedBox(height: 4),
                                        Text(
                                          '${Fmt.relative(t.createdAt)}${t.pages > 0 ? " · ${t.pages} 页" : ""}',
                                          style: TextStyle(fontSize: 11.5, color: scheme.onSurfaceVariant),
                                        ),
                                        if (t.status == 'pending') ...[
                                          const SizedBox(height: 10),
                                          Row(
                                            children: [
                                              Expanded(
                                                child: FilledButton(
                                                  onPressed: () => _act(t, 'approve'),
                                                  style: FilledButton.styleFrom(minimumSize: const Size(0, 40)),
                                                  child: const Text('通过'),
                                                ),
                                              ),
                                              const SizedBox(width: 10),
                                              Expanded(
                                                child: OutlinedButton(
                                                  onPressed: () => _act(t, 'reject'),
                                                  style: OutlinedButton.styleFrom(minimumSize: const Size(0, 40)),
                                                  child: const Text('拒绝'),
                                                ),
                                              ),
                                            ],
                                          ),
                                        ],
                                      ],
                                    ),
                                  );
                                },
                              ),
                      ),
          ),
        ],
      ),
    );
  }
}
