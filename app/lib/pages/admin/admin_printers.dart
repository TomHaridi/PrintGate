import 'package:flutter/material.dart';

import '../../core/api.dart';
import '../../core/format.dart';
import '../../core/models.dart';
import '../../theme.dart';

/// 打印机管理：暂停 / 恢复 / 设为默认
class AdminPrintersPage extends StatefulWidget {
  const AdminPrintersPage({super.key});

  @override
  State<AdminPrintersPage> createState() => _AdminPrintersPageState();
}

class _AdminPrintersPageState extends State<AdminPrintersPage> {
  bool _loading = true;
  String _error = '';
  List<PgPrinter> _printers = const [];

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
      final list = await Api().adminPrinters();
      if (!mounted) return;
      setState(() {
        _printers = list;
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

  Future<void> _act(PgPrinter p, String action, String label) async {
    try {
      await Api().adminPrinterAction(p.name, action);
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
        title: const Text('打印机'),
        actions: [IconButton(onPressed: _loading ? null : _load, icon: const Icon(Icons.refresh_rounded))],
      ),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : _error.isNotEmpty
              ? Center(child: Text(_error))
              : RefreshIndicator(
                  onRefresh: _load,
                  child: _printers.isEmpty
                      ? ListView(children: const [
                          SizedBox(height: 100),
                          Center(child: Text('还没有打印队列，去网页后台添加')),
                        ])
                      : ListView.separated(
                          padding: const EdgeInsets.fromLTRB(16, 8, 16, 24),
                          itemCount: _printers.length,
                          separatorBuilder: (_, __) => const SizedBox(height: 10),
                          itemBuilder: (context, i) {
                            final p = _printers[i];
                            final st = Fmt.printerState(p.state);
                            final stopped = p.state == 'stopped';
                            return PgCard(
                              padding: const EdgeInsets.all(14),
                              child: Column(
                                crossAxisAlignment: CrossAxisAlignment.start,
                                children: [
                                  Row(
                                    children: [
                                      Expanded(
                                        child: Text(p.name, maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontWeight: FontWeight.w600)),
                                      ),
                                      if (p.isDefault) const Padding(
                                        padding: EdgeInsets.only(right: 6),
                                        child: StatusTag(text: '默认', kind: 'info'),
                                      ),
                                      StatusTag(text: st.text, kind: st.kind),
                                    ],
                                  ),
                                  if (p.model.isNotEmpty || p.location.isNotEmpty) ...[
                                    const SizedBox(height: 4),
                                    Text(
                                      [p.model, p.location].where((e) => e.isNotEmpty).join(' · '),
                                      style: TextStyle(fontSize: 12, color: scheme.onSurfaceVariant),
                                    ),
                                  ],
                                  const SizedBox(height: 10),
                                  Row(
                                    children: [
                                      OutlinedButton(
                                        onPressed: () => _act(p, stopped ? 'resume' : 'pause', stopped ? '恢复' : '暂停'),
                                        style: OutlinedButton.styleFrom(minimumSize: const Size(0, 36), visualDensity: VisualDensity.compact),
                                        child: Text(stopped ? '恢复' : '暂停'),
                                      ),
                                      const SizedBox(width: 8),
                                      if (!p.isDefault)
                                        OutlinedButton(
                                          onPressed: () => _act(p, 'default', '设为默认'),
                                          style: OutlinedButton.styleFrom(minimumSize: const Size(0, 36), visualDensity: VisualDensity.compact),
                                          child: const Text('设为默认'),
                                        ),
                                    ],
                                  ),
                                ],
                              ),
                            );
                          },
                        ),
                ),
    );
  }
}
