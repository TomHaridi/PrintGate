import 'package:flutter/material.dart';

import '../core/api.dart';
import '../core/app_state.dart';
import '../core/models.dart';
import '../widgets/theme_sheet.dart';
import 'admin/admin_home.dart';
import 'files_tab.dart';
import 'history_tab.dart';
import 'me_tab.dart';
import 'print_tab.dart';

/// 主界面：打印 / 文件 / 记录 / 我的（与小程序 tabBar 一致）
class HomePage extends StatefulWidget {
  const HomePage({super.key});

  @override
  State<HomePage> createState() => _HomePageState();
}

class _HomePageState extends State<HomePage> {
  int _index = 0;
  bool _loading = true;
  String _error = '';
  List<PgPrinter> _printers = const [];

  /// 「文件」页选中后自动切到「打印」页：用一个 ValueNotifier 在两页之间传
  final ValueNotifier<PgFileItem?> _selected = ValueNotifier<PgFileItem?>(null);
  final GlobalKey<HistoryTabState> _historyKey = GlobalKey<HistoryTabState>();

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _bootstrap());
  }

  @override
  void dispose() {
    _selected.dispose();
    super.dispose();
  }

  Future<void> _bootstrap() async {
    final ctl = AppScope.read(context);
    if (mounted) {
      setState(() {
        _loading = true;
        _error = '';
      });
    }
    try {
      await ctl.refreshUser();
      final p = await Api().printers();
      if (!mounted) return;
      setState(() {
        _printers = p.list;
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

  void _useFile(PgFileItem f) {
    _selected.value = f;
    setState(() => _index = 0);
  }

  void _afterPrinted() {
    setState(() => _index = 2);
    _historyKey.currentState?.reload();
  }

  @override
  Widget build(BuildContext context) {
    final ctl = AppScope.of(context);

    final body = _loading
        ? const Center(child: CircularProgressIndicator())
        : IndexedStack(
            index: _index,
            children: [
              PrintTab(
                printers: _printers,
                selected: _selected,
                onRefreshPrinters: _bootstrap,
                onPrinted: _afterPrinted,
              ),
              FilesTab(selected: _selected, onUse: _useFile, onUpload: () => setState(() => _index = 0)),
              HistoryTab(key: _historyKey),
              MeTab(onRefreshAll: _bootstrap),
            ],
          );

    return Scaffold(
      appBar: AppBar(
        title: Text(_title()),
        actions: [
          if (_index == 0)
            IconButton(tooltip: '刷新', onPressed: _loading ? null : _bootstrap, icon: const Icon(Icons.refresh_rounded)),
          if (ctl.isAdmin)
            IconButton(
              tooltip: '管理台',
              onPressed: () => Navigator.of(context).push(MaterialPageRoute(builder: (_) => const AdminHomePage())),
              icon: const Icon(Icons.admin_panel_settings_outlined),
            ),
          IconButton(
            tooltip: '外观',
            onPressed: () => ThemeSheet.show(context),
            icon: const Icon(Icons.palette_outlined),
          ),
        ],
      ),
      body: _error.isNotEmpty && _index == 0
          ? _ErrorView(message: _error, onRetry: _bootstrap)
          : body,
      bottomNavigationBar: BottomNavigationBar(
        currentIndex: _index,
        onTap: (i) {
          setState(() => _index = i);
          if (i == 2) _historyKey.currentState?.reload();
        },
        items: const [
          BottomNavigationBarItem(icon: Icon(Icons.print_outlined), activeIcon: Icon(Icons.print_rounded), label: '打印'),
          BottomNavigationBarItem(icon: Icon(Icons.folder_outlined), activeIcon: Icon(Icons.folder_rounded), label: '文件'),
          BottomNavigationBarItem(icon: Icon(Icons.receipt_long_outlined), activeIcon: Icon(Icons.receipt_long_rounded), label: '记录'),
          BottomNavigationBarItem(icon: Icon(Icons.person_outline), activeIcon: Icon(Icons.person_rounded), label: '我的'),
        ],
      ),
    );
  }

  String _title() {
    switch (_index) {
      case 1:
        return '我的文件';
      case 2:
        return '打印记录';
      case 3:
        return '我的';
      default:
        return '打印';
    }
  }
}

class _ErrorView extends StatelessWidget {
  const _ErrorView({required this.message, required this.onRetry});

  final String message;
  final Future<void> Function() onRetry;

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(32),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Icon(Icons.cloud_off_rounded, size: 48, color: Color(0xFF8A9C9A)),
            const SizedBox(height: 12),
            Text(message, textAlign: TextAlign.center),
            const SizedBox(height: 20),
            FilledButton.tonal(onPressed: () => onRetry(), child: const Text('重试')),
          ],
        ),
      ),
    );
  }
}
