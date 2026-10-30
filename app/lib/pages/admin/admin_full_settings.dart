import 'package:flutter/material.dart';

import '../../core/api.dart';
import '../../theme.dart';

/// 完整后台设置：输入网页后台的管理密码换取 admin 令牌，
/// 然后按 `/api/settings` 返回的结构动态渲染**所有**开关（bool→开关、数字→步进、文本→输入框）。
/// 这样后端以后新增设置项，App 不用改代码就能改。
class AdminFullSettingsPage extends StatefulWidget {
  const AdminFullSettingsPage({super.key});

  @override
  State<AdminFullSettingsPage> createState() => _AdminFullSettingsPageState();
}

class _AdminFullSettingsPageState extends State<AdminFullSettingsPage> {
  final _pass = TextEditingController();
  String? _adminToken;

  bool _loading = false;
  bool _saving = false;
  String _error = '';
  Map<String, dynamic> _settings = {};
  Map<String, dynamic> _origin = {};
  String _version = '';

  Map<String, dynamic>? _office;
  bool _officeBusy = false;

  @override
  void dispose() {
    _pass.dispose();
    super.dispose();
  }

  Future<void> _elevate() async {
    final pwd = _pass.text;
    if (pwd.isEmpty) {
      setState(() => _error = '请输入后台管理密码');
      return;
    }
    setState(() {
      _loading = true;
      _error = '';
    });
    try {
      final token = await Api(token: '').adminLogin(pwd);
      if (!mounted) return;
      setState(() {
        _adminToken = token;
        _loading = false;
      });
      await _load();
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() {
        _error = e.message;
        _loading = false;
      });
    }
  }

  Api get _adminApi => Api(token: _adminToken ?? '');

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = '';
    });
    try {
      final d = await _adminApi.fullSettings();
      if (!mounted) return;
      final s = d['settings'];
      final map = s is Map ? Map<String, dynamic>.from(s) : <String, dynamic>{};
      setState(() {
        _settings = map;
        _origin = Map<String, dynamic>.from(map);
        _version = d['version']?.toString() ?? '';
        _loading = false;
      });
      await _loadOffice();
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() {
        _error = e.message;
        _loading = false;
      });
    }
  }

  Future<void> _loadOffice() async {
    try {
      final d = await _adminApi.officeStatus();
      if (!mounted) return;
      setState(() => _office = d);
    } on ApiException {
      // 拿不到状态不影响其他设置
    }
  }

  Future<void> _installOffice() async {
    setState(() => _officeBusy = true);
    try {
      final r = await _adminApi.officeInstall();
      if (!mounted) return;
      _toast(r['msg']?.toString() ?? '已开始安装');
      await _loadOffice();
    } on ApiException catch (e) {
      _toast(e.message);
    } finally {
      if (mounted) setState(() => _officeBusy = false);
    }
  }

  Future<void> _save() async {
    final patch = <String, Object?>{};
    for (final e in _settings.entries) {
      if ('${e.value}' != '${_origin[e.key]}') patch[e.key] = e.value;
    }
    if (patch.isEmpty) {
      _toast('没有改动');
      return;
    }
    setState(() => _saving = true);
    try {
      await _adminApi.saveFullSettings(patch);
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
    if (_adminToken == null) return _gate();
    return Scaffold(
      appBar: AppBar(
        title: const Text('完整后台设置'),
        actions: [
          if (_loading) const Padding(padding: EdgeInsets.all(16), child: SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2))),
          if (!_loading)
            TextButton(
              onPressed: _saving ? null : _save,
              child: _saving ? const SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2)) : const Text('保存'),
            ),
        ],
      ),
      body: _error.isNotEmpty && _settings.isEmpty
          ? Center(
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Text(_error),
                  const SizedBox(height: 12),
                  FilledButton.tonal(onPressed: _load, child: const Text('重试')),
                ],
              ),
            )
          : ListView(
              padding: const EdgeInsets.fromLTRB(16, 8, 16, 24),
              children: [
                _officeCard(),
                const SizedBox(height: 12),
                ..._section('开关', _boolKeys()),
                ..._section('数值', _numKeys()),
                ..._section('文本', _strKeys()),
                if (_version.isNotEmpty)
                  Padding(
                    padding: const EdgeInsets.only(top: 12),
                    child: Text(
                      '服务端 $_version',
                      style: TextStyle(fontSize: 12, color: Theme.of(context).colorScheme.onSurfaceVariant),
                    ),
                  ),
              ],
            ),
    );
  }

  Widget _gate() {
    final scheme = Theme.of(context).colorScheme;
    return Scaffold(
      appBar: AppBar(title: const Text('完整后台设置')),
      body: ListView(
        padding: const EdgeInsets.all(20),
        children: [
          PgCard(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    Icon(Icons.shield_outlined, color: scheme.primary),
                    const SizedBox(width: 10),
                    const Expanded(child: Text('需要网页后台的管理密码', style: TextStyle(fontWeight: FontWeight.w600))),
                  ],
                ),
                const SizedBox(height: 8),
                Text(
                  '完整设置（CUPS 地址、驱动、清理策略等）走的是后台管理接口，'
                  '要用后台密码换一个管理令牌。令牌只存在本次会话里，退出 App 即失效。',
                  style: TextStyle(fontSize: 12.5, color: scheme.onSurfaceVariant),
                ),
                const SizedBox(height: 16),
                TextField(
                  controller: _pass,
                  obscureText: true,
                  decoration: const InputDecoration(labelText: '后台管理密码', prefixIcon: Icon(Icons.lock_outline)),
                  onSubmitted: (_) => _elevate(),
                ),
                if (_error.isNotEmpty) ...[
                  const SizedBox(height: 10),
                  Text(_error, style: const TextStyle(color: pgDanger, fontSize: 13)),
                ],
                const SizedBox(height: 16),
                FilledButton(
                  onPressed: _loading ? null : _elevate,
                  child: _loading
                      ? const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white))
                      : const Text('进入完整设置'),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }

  Widget _officeCard() {
    final scheme = Theme.of(context).colorScheme;
    final o = _office;
    final available = o?['available'] == true;
    final installing = (o?['install'] is Map) && (o?['install']['running'] == true);
    return PgCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(Icons.description_outlined, size: 20, color: scheme.primary),
              const SizedBox(width: 10),
              const Expanded(child: Text('Office 转换组件', style: TextStyle(fontWeight: FontWeight.w600))),
              StatusTag(text: available ? '已安装' : (installing ? '安装中' : '未安装'), kind: available ? 'success' : 'warning'),
            ],
          ),
          const SizedBox(height: 6),
          Text(
            available
                ? 'Word / Excel / PPT 可以直接上传打印。版本：${o?['version'] ?? '—'}'
                : '未安装时只能打印 PDF 和图片；安装包会缓存在数据卷，换镜像后自动恢复。',
            style: TextStyle(fontSize: 12.5, color: scheme.onSurfaceVariant),
          ),
          const SizedBox(height: 10),
          Row(
            children: [
              FilledButton.tonal(
                onPressed: _officeBusy || installing ? null : _installOffice,
                style: FilledButton.styleFrom(minimumSize: const Size(0, 40)),
                child: Text(available ? '重新安装' : '一键安装'),
              ),
              const SizedBox(width: 10),
              OutlinedButton(
                onPressed: _officeBusy ? null : _loadOffice,
                style: OutlinedButton.styleFrom(minimumSize: const Size(0, 40)),
                child: const Text('刷新状态'),
              ),
            ],
          ),
        ],
      ),
    );
  }

  List<String> _boolKeys() => _settings.entries.where((e) => e.value is bool).map((e) => e.key).toList();
  List<String> _numKeys() => _settings.entries.where((e) => e.value is num).map((e) => e.key).toList();
  List<String> _strKeys() => _settings.entries.where((e) => e.value is String).map((e) => e.key).toList();

  List<Widget> _section(String title, List<String> keys) {
    if (keys.isEmpty) return const [];
    return [
      Padding(
        padding: const EdgeInsets.fromLTRB(4, 6, 4, 8),
        child: Text(title, style: TextStyle(fontSize: 13, fontWeight: FontWeight.w600, color: Theme.of(context).colorScheme.onSurfaceVariant)),
      ),
      PgCard(
        padding: EdgeInsets.zero,
        child: Column(
          children: [
            for (var i = 0; i < keys.length; i++) ...[
              _row(keys[i]),
              if (i != keys.length - 1) const Divider(height: 1),
            ],
          ],
        ),
      ),
      const SizedBox(height: 12),
    ];
  }

  Widget _row(String key) {
    final v = _settings[key];
    if (v is bool) {
      return SwitchListTile(
        value: v,
        onChanged: (nv) => setState(() => _settings[key] = nv),
        title: Text(_label(key), style: const TextStyle(fontSize: 14)),
        subtitle: Text(key, style: TextStyle(fontSize: 11.5, color: Theme.of(context).colorScheme.onSurfaceVariant)),
      );
    }
    if (v is num) {
      // 不在 build 里 new 控制器（会每次重建都丢焦点），点一下弹框改
      return ListTile(
        title: Text(_label(key), style: const TextStyle(fontSize: 14)),
        subtitle: Text(key, style: TextStyle(fontSize: 11.5, color: Theme.of(context).colorScheme.onSurfaceVariant)),
        trailing: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Text('$v', style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w600)),
            const SizedBox(width: 6),
            const Icon(Icons.edit_outlined, size: 18),
          ],
        ),
        onTap: () => _editNumber(key, v),
      );
    }
    return ListTile(
      title: Text(_label(key), style: const TextStyle(fontSize: 14)),
      subtitle: Text('$v', style: TextStyle(fontSize: 12, color: Theme.of(context).colorScheme.onSurfaceVariant)),
      trailing: const Icon(Icons.edit_outlined, size: 18),
      onTap: () => _editString(key, '$v'),
    );
  }

  Future<void> _editNumber(String key, num current) async {
    final ctrl = TextEditingController(text: '$current');
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text(_label(key)),
        content: TextField(
          controller: ctrl,
          keyboardType: TextInputType.number,
          autofocus: true,
          decoration: const InputDecoration(labelText: '数值'),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('取消')),
          TextButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('确定')),
        ],
      ),
    );
    if (ok != true) return;
    final n = num.tryParse(ctrl.text.trim());
    if (n == null) {
      _toast('请输入数字');
      return;
    }
    setState(() => _settings[key] = current is int ? n.toInt() : n);
  }

  Future<void> _editString(String key, String current) async {
    final ctrl = TextEditingController(text: current);
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text(_label(key)),
        content: TextField(controller: ctrl, decoration: const InputDecoration(labelText: '值')),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('取消')),
          TextButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('确定')),
        ],
      ),
    );
    if (ok == true) setState(() => _settings[key] = ctrl.text.trim());
  }

  /// 常见键给个人话标签，没收录的直接显示 key（后端加新字段也不会漏）
  static const _labels = {
    'defaultPrinter': '默认打印机',
    'cupsServer': 'CUPS 服务器地址',
    'cupsPort': 'CUPS 端口',
    'maxFileMB': '单文件上限(MB)',
    'maxCopies': '份数上限',
    'maxPages': '页数上限',
    'historyDays': '历史保留天数',
    'approveNewUser': '新用户需审批',
    'approveEachJob': '每单需审批',
    'guestMode': '访客模式（免审批）',
    'enableUserRegister': '允许用户自助注册',
    'enablePasswordLogin': '允许密码登录后台',
    'enableQrLogin': '允许扫码登录后台',
    'autoCleanHistory': '自动清理历史',
    'hideUserAdvanced': '对普通用户隐藏高级设置',
    'retainSourceFiles': '保留源文件',
    'watermarkDefault': '默认水印',
    'siteName': '站点名称',
  };

  String _label(String key) => _labels[key] ?? key;
}
