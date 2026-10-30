import 'package:flutter/material.dart';

import '../../core/api.dart';
import '../../theme.dart';

/// 常用设置（走 /api/mp/admin/settings，字段由服务端 schema 驱动）
class AdminSettingsPage extends StatefulWidget {
  const AdminSettingsPage({super.key});

  @override
  State<AdminSettingsPage> createState() => _AdminSettingsPageState();
}

class _AdminSettingsPageState extends State<AdminSettingsPage> {
  bool _loading = true;
  bool _saving = false;
  String _error = '';
  Map<String, dynamic> _settings = {};
  Map<String, dynamic> _origin = {};
  List<String> _printers = const [];

  static const _intRules = {
    'maxFileMB': ('单文件上限（MB）', 1, 500),
    'maxCopies': ('单任务份数上限', 1, 99),
    'maxPages': ('单任务页数上限', 1, 2000),
    'historyDays': ('历史保留天数（0=不限）', 0, 3650),
  };

  static const _boolRules = {
    'approveNewUser': '新用户需管理员审批',
    'approveEachJob': '每个打印任务都要审批',
    'enableQrLogin': '允许扫码登录网页后台',
    'autoCleanHistory': '自动清理历史',
  };

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
      final r = await Api().adminSettings();
      if (!mounted) return;
      setState(() {
        _settings = Map<String, dynamic>.from(r.settings);
        _origin = Map<String, dynamic>.from(r.settings);
        _printers = r.printers;
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

  Future<void> _save() async {
    final patch = <String, Object?>{};
    for (final k in _settings.keys) {
      if (_settings[k] != _origin[k]) patch[k] = _settings[k];
    }
    if (patch.isEmpty) {
      _toast('没有改动');
      return;
    }
    setState(() => _saving = true);
    try {
      await Api().adminSaveSettings(patch);
      _toast('已保存并生效');
      await _load();
    } on ApiException catch (e) {
      _toast(e.message);
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  void _toast(String msg) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(msg)));
  }

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Scaffold(
      appBar: AppBar(
        title: const Text('常用设置'),
        actions: [
          TextButton(
            onPressed: _saving || _loading ? null : _save,
            child: _saving ? const SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2)) : const Text('保存'),
          ),
        ],
      ),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : _error.isNotEmpty
              ? Center(child: Text(_error))
              : ListView(
                  padding: const EdgeInsets.fromLTRB(16, 8, 16, 24),
                  children: [
                    PgCard(
                      padding: EdgeInsets.zero,
                      child: Column(
                        children: [
                          for (final e in _boolRules.entries) ...[
                            SwitchListTile(
                              value: _settings[e.key] == true,
                              onChanged: (v) => setState(() => _settings[e.key] = v),
                              title: Text(e.value, style: const TextStyle(fontSize: 14)),
                              subtitle: Text(e.key, style: TextStyle(fontSize: 11.5, color: scheme.onSurfaceVariant)),
                            ),
                            if (e.key != _boolRules.keys.last) const Divider(height: 1),
                          ],
                        ],
                      ),
                    ),
                    const SizedBox(height: 12),
                    PgCard(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          for (final e in _intRules.entries) ...[
                            _intRow(e.key, e.value.$1, e.value.$2, e.value.$3),
                            if (e.key != _intRules.keys.last) const SizedBox(height: 14),
                          ],
                        ],
                      ),
                    ),
                    const SizedBox(height: 12),
                    PgCard(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text('默认打印机', style: TextStyle(fontSize: 13, color: scheme.onSurfaceVariant)),
                          const SizedBox(height: 8),
                          DropdownButtonFormField<String>(
                            initialValue: '${_settings['defaultPrinter'] ?? ''}',
                            isExpanded: true,
                            decoration: const InputDecoration(isDense: true),
                            items: [
                              const DropdownMenuItem(value: '', child: Text('（不指定）')),
                              for (final p in _printers) DropdownMenuItem(value: p, child: Text(p)),
                            ],
                            onChanged: (v) => setState(() => _settings['defaultPrinter'] = v ?? ''),
                          ),
                        ],
                      ),
                    ),
                    const SizedBox(height: 14),
                    Text(
                      '这些是手机端能改的部分。要改 CUPS 地址、驱动、更细的开关，去「完整后台设置」（需后台管理密码）。',
                      style: TextStyle(fontSize: 12, color: scheme.onSurfaceVariant),
                    ),
                  ],
                ),
    );
  }

  Widget _intRow(String key, String label, int min, int max) {
    final v = int.tryParse('${_settings[key] ?? 0}') ?? 0;
    return Row(
      children: [
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(label, style: const TextStyle(fontSize: 14)),
              Text(key, style: TextStyle(fontSize: 11.5, color: Theme.of(context).colorScheme.onSurfaceVariant)),
            ],
          ),
        ),
        IconButton(
          onPressed: v <= min ? null : () => setState(() => _settings[key] = v - 1),
          icon: const Icon(Icons.remove_circle_outline),
        ),
        SizedBox(
          width: 56,
          child: Text('$v', textAlign: TextAlign.center, style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w600)),
        ),
        IconButton(
          onPressed: v >= max ? null : () => setState(() => _settings[key] = v + 1),
          icon: const Icon(Icons.add_circle_outline),
        ),
      ],
    );
  }
}
