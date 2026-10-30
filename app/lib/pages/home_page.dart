import 'package:flutter/material.dart';

import '../core/api.dart';
import '../core/models.dart';
import '../core/store.dart';
import 'files_tab.dart';
import 'history_tab.dart';
import 'login_page.dart';
import 'me_tab.dart';
import 'print_tab.dart';

/// 主界面：底部四个 Tab，与 H5 版一致（打印 / 文件 / 记录 / 我的）
class HomePage extends StatefulWidget {
  const HomePage({super.key});

  @override
  State<HomePage> createState() => _HomePageState();
}

class _HomePageState extends State<HomePage> {
  int _index = 0;
  bool _loading = true;
  String _error = '';
  MeResult? _me;
  List<PgPrinter> _printers = const [];

  /// 「文件」页选中后，自动切到「打印」页 —— 用一个 ValueNotifier 在两个 Tab 之间传
  final ValueNotifier<PgFileItem?> _selected = ValueNotifier<PgFileItem?>(null);
  final GlobalKey<HistoryTabState> _historyKey = GlobalKey<HistoryTabState>();

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    _selected.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    if (mounted) {
      setState(() {
        _loading = true;
        _error = '';
      });
    }
    final api = Api();
    try {
      final me = await api.me();
      final printers = await api.printers();
      if (!mounted) return;
      setState(() {
        _me = me;
        _printers = printers;
        _loading = false;
      });
    } on ApiException catch (e) {
      if (!mounted) return;
      if (e.unauthorized) {
        await Store.signOut();
        if (!mounted) return;
        Navigator.of(context).pushReplacement(MaterialPageRoute(builder: (_) => const LoginPage()));
        return;
      }
      setState(() {
        _error = e.message;
        _loading = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _error = '$e';
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
    final me = _me;
    final body = _loading
        ? const Center(child: CircularProgressIndicator())
        : IndexedStack(
            index: _index,
            children: [
              PrintTab(
                me: me,
                printers: _printers,
                selected: _selected,
                onRefreshPrinters: _load,
                onPrinted: _afterPrinted,
              ),
              FilesTab(selected: _selected, onUse: _useFile),
              HistoryTab(key: _historyKey),
              MeTab(me: me, onRefresh: _load),
            ],
          );

    return Scaffold(
      appBar: AppBar(
        title: Text(_title()),
        actions: [
          if (_index == 0)
            IconButton(
              tooltip: '刷新',
              onPressed: _loading ? null : _load,
              icon: const Icon(Icons.refresh_rounded),
            ),
        ],
      ),
      body: _error.isNotEmpty && _index == 0
          ? _ErrorView(message: _error, onRetry: _load)
          : body,
      bottomNavigationBar: NavigationBar(
        selectedIndex: _index,
        onDestinationSelected: (i) {
          setState(() => _index = i);
          if (i == 2) _historyKey.currentState?.reload();
        },
        destinations: const [
          NavigationDestination(icon: Icon(Icons.print_outlined), selectedIcon: Icon(Icons.print_rounded), label: '打印'),
          NavigationDestination(icon: Icon(Icons.folder_outlined), selectedIcon: Icon(Icons.folder_rounded), label: '文件'),
          NavigationDestination(icon: Icon(Icons.receipt_long_outlined), selectedIcon: Icon(Icons.receipt_long_rounded), label: '记录'),
          NavigationDestination(icon: Icon(Icons.person_outline), selectedIcon: Icon(Icons.person_rounded), label: '我的'),
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
