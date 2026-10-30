import 'package:flutter/material.dart';

import '../../core/api.dart';
import '../../core/app_state.dart';
import '../../core/format.dart';
import '../../core/models.dart';
import '../../theme.dart';
import 'admin_full_settings.dart';
import 'admin_printers.dart';
import 'admin_settings.dart';
import 'admin_tasks.dart';
import 'admin_users.dart';

/// 管理台首页：概览 + 各功能入口（对应小程序 packageAdmin/pages/home）
class AdminHomePage extends StatefulWidget {
  const AdminHomePage({super.key});

  @override
  State<AdminHomePage> createState() => _AdminHomePageState();
}

class _AdminHomePageState extends State<AdminHomePage> {
  bool _loading = true;
  String _error = '';
  Map<String, dynamic> _ov = const {};
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
      final r = await Api().adminOverview();
      final printers = await Api().adminPrinters();
      if (!mounted) return;
      setState(() {
        _ov = r['overview'] as Map<String, dynamic>? ?? const {};
        _printers = printers;
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

  int _n(String k) => (int.tryParse('${_ov[k] ?? 0}') ?? 0);

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final ctl = AppScope.of(context);

    return Scaffold(
      appBar: AppBar(
        title: const Text('管理台'),
        actions: [IconButton(onPressed: _loading ? null : _load, icon: const Icon(Icons.refresh_rounded))],
      ),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : ListView(
              padding: const EdgeInsets.fromLTRB(16, 8, 16, 24),
              children: [
                if (_error.isNotEmpty)
                  PgCard(
                    child: Row(
                      children: [
                        const Icon(Icons.error_outline, color: pgDanger),
                        const SizedBox(width: 10),
                        Expanded(child: Text(_error)),
                        TextButton(onPressed: _load, child: const Text('重试')),
                      ],
                    ),
                  ),
                GridView.count(
                  crossAxisCount: 3,
                  shrinkWrap: true,
                  physics: const NeverScrollableScrollPhysics(),
                  mainAxisSpacing: 10,
                  crossAxisSpacing: 10,
                  childAspectRatio: 1.05,
                  children: [
                    _stat('待审批用户', _n('pendingUsers'), pgWarn, () => _push(const AdminUsersPage(initialStatus: 'pending'))),
                    _stat('用户总数', _n('totalUsers'), scheme.primary, () => _push(const AdminUsersPage())),
                    _stat('待审批任务', _n('pendingTasks'), pgWarn, () => _push(const AdminTasksPage())),
                    _stat('打印中', _n('printing'), scheme.primary, () => _push(const AdminTasksPage())),
                    _stat('今日任务', _n('todayTasks'), const Color(0xFF1E8E3E), null),
                    _stat('文件数', _n('files'), const Color(0xFF6B807E), null),
                  ],
                ),
                const SizedBox(height: 14),
                PgCard(
                  child: Row(
                    children: [
                      Icon(_ov['cupsOk'] == true ? Icons.check_circle_rounded : Icons.error_outline,
                          color: _ov['cupsOk'] == true ? const Color(0xFF1E8E3E) : pgDanger, size: 20),
                      const SizedBox(width: 10),
                      Expanded(
                        child: Text(
                          _ov['cupsOk'] == true ? 'CUPS 正常 · ${_n('printerCount')} 个队列' : 'CUPS 不可用',
                          style: const TextStyle(fontSize: 13.5),
                        ),
                      ),
                    ],
                  ),
                ),
                const SizedBox(height: 16),
                PgCard(
                  padding: EdgeInsets.zero,
                  child: Column(
                    children: [
                      _entry(Icons.people_outline, '用户管理', '审批 / 拉黑 / 删除', () => _push(const AdminUsersPage())),
                      const Divider(height: 1),
                      _entry(Icons.fact_check_outlined, '任务审批', '逐单放行或拒绝', () => _push(const AdminTasksPage())),
                      const Divider(height: 1),
                      _entry(Icons.local_print_shop_outlined, '打印机', '暂停 / 恢复 / 设为默认', () => _push(const AdminPrintersPage())),
                      const Divider(height: 1),
                      _entry(Icons.tune_rounded, '常用设置', '份数上限 / 文件大小 / 审批开关', () => _push(const AdminSettingsPage())),
                      const Divider(height: 1),
                      _entry(
                        Icons.admin_panel_settings_outlined,
                        '完整后台设置',
                        ctl.approved ? '需后台管理密码，可改全部开关' : '仅管理员可用',
                        () => _push(const AdminFullSettingsPage()),
                      ),
                    ],
                  ),
                ),
                const SizedBox(height: 16),
                if (_printers.isNotEmpty) ...[
                  Text('打印机状态', style: TextStyle(fontSize: 13, fontWeight: FontWeight.w600, color: scheme.onSurfaceVariant)),
                  const SizedBox(height: 8),
                  for (final p in _printers)
                    PgCard(
                      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
                      child: Row(
                        children: [
                          Expanded(child: Text(p.name, style: const TextStyle(fontSize: 13.5))),
                          StatusTag(
                            text: Fmt.printerState(p.state).text,
                            kind: Fmt.printerState(p.state).kind,
                          ),
                        ],
                      ),
                    ),
                ],
              ],
            ),
    );
  }

  void _push(Widget page) {
    Navigator.of(context).push(MaterialPageRoute(builder: (_) => page)).then((_) => _load());
  }

  Widget _stat(String label, int value, Color color, VoidCallback? onTap) {
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(16),
      child: Container(
        padding: const EdgeInsets.all(12),
        decoration: BoxDecoration(
          color: color.withValues(alpha: 0.08),
          borderRadius: BorderRadius.circular(16),
          border: Border.all(color: color.withValues(alpha: 0.18)),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Text('$value', style: TextStyle(fontSize: 22, fontWeight: FontWeight.w700, color: color)),
            const SizedBox(height: 2),
            Text(label, style: TextStyle(fontSize: 11.5, color: color.withValues(alpha: 0.9))),
          ],
        ),
      ),
    );
  }

  Widget _entry(IconData icon, String title, String subtitle, VoidCallback onTap) {
    return ListTile(
      leading: Icon(icon),
      title: Text(title, style: const TextStyle(fontSize: 14.5)),
      subtitle: Text(subtitle, style: const TextStyle(fontSize: 12)),
      trailing: const Icon(Icons.chevron_right_rounded),
      onTap: onTap,
    );
  }
}
