import 'package:flutter/material.dart';

import '../core/api.dart';
import '../core/app_state.dart';
import '../core/lanscan.dart';
import '../core/store.dart';
import '../theme.dart';

/// 服务器地址面板：手填 + 最近使用历史 + 局域网扫描。
/// 小程序里这个弹层拆成了三个按钮，这里合成一个面板，扫描结果直接可点。
class ServerSheet extends StatefulWidget {
  const ServerSheet({super.key, this.initial, this.onSaved});

  final String? initial;
  final Future<void> Function(String url)? onSaved;

  static Future<void> show(BuildContext context, {String? initial, Future<void> Function(String url)? onSaved}) {
    return showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      backgroundColor: Colors.transparent,
      builder: (_) => ServerSheet(initial: initial, onSaved: onSaved),
    );
  }

  @override
  State<ServerSheet> createState() => _ServerSheetState();
}

class _ServerSheetState extends State<ServerSheet> {
  late final TextEditingController _ctrl = TextEditingController(text: widget.initial ?? Store.baseUrl);
  bool _busy = false;
  String _error = '';

  bool _scanning = false;
  int _done = 0;
  int _total = 0;
  List<({String base, String version})> _found = const [];
  bool _stopScan = false;

  @override
  void dispose() {
    _stopScan = true;
    _ctrl.dispose();
    super.dispose();
  }

  Future<void> _startScan() async {
    if (_scanning) {
      setState(() => _stopScan = true);
      return;
    }
    setState(() {
      _scanning = true;
      _stopScan = false;
      _done = 0;
      _total = 0;
      _found = const [];
      _error = '';
    });
    try {
      final r = await LanScan.scan(
        prefix: _ctrl.text.trim(),
        concurrency: 16,
        shouldStop: () => _stopScan,
        onProgress: (done, total, found) {
          if (!mounted || _stopScan) return;
          setState(() {
            _done = done;
            _total = total;
            _found = List.of(found);
          });
        },
      );
      if (!mounted) return;
      setState(() {
        _scanning = false;
        _found = r.found;
      });
      if (r.found.isEmpty) {
        _toast('没扫到，试试填网段前缀（如 192.168.1.）或手动输入');
      } else if (r.found.length == 1) {
        _ctrl.text = r.found.first.base;
      }
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _scanning = false;
        _error = '扫描失败：$e';
      });
    }
  }

  Future<void> _save() async {
    final raw = _ctrl.text.trim();
    if (raw.isEmpty) {
      setState(() => _error = '请填写服务器地址');
      return;
    }
    final url = Store.normalize(raw);
    if (url.isEmpty) {
      setState(() => _error = '地址格式不对，例如 192.168.1.10:8080');
      return;
    }
    setState(() {
      _busy = true;
      _error = '';
    });
    try {
      final info = await Api(baseUrl: url, token: '').health();
      if (info['app'] != 'PrintGate') throw ApiException('这个地址不像是 PrintGate 服务器');
      await AppScope.read(context).setBaseUrl(url);
      if (!mounted) return;
      Navigator.of(context).pop();
      await widget.onSaved?.call(url);
    } catch (e) {
      if (!mounted) return;
      setState(() => _error = e is ApiException ? e.message : '$e');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  void _toast(String msg) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(msg)));
  }

  @override
  Widget build(BuildContext context) {
    final dark = Theme.of(context).brightness == Brightness.dark;
    final ink = dark ? Colors.white : const Color(0xFF101B1A);
    final sub = dark ? const Color(0xFF8A9C9A) : const Color(0xFF6B807E);
    final history = Store.history;

    return Padding(
      padding: EdgeInsets.only(bottom: MediaQuery.of(context).viewInsets.bottom),
      child: Container(
        decoration: BoxDecoration(
          color: dark ? const Color(0xFF16201E) : Colors.white,
          borderRadius: const BorderRadius.vertical(top: Radius.circular(24)),
        ),
        child: SafeArea(
          top: false,
          child: SingleChildScrollView(
            padding: const EdgeInsets.fromLTRB(20, 10, 20, 20),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Center(
                  child: Container(
                    width: 38,
                    height: 4,
                    decoration: BoxDecoration(
                      color: dark ? const Color(0xFF3A4A47) : const Color(0xFFDCE3E2),
                      borderRadius: BorderRadius.circular(2),
                    ),
                  ),
                ),
                const SizedBox(height: 16),
                Text('服务器地址', style: TextStyle(fontSize: 19, fontWeight: FontWeight.w700, color: ink)),
                const SizedBox(height: 4),
                Text('内网直接填 IP:端口，公网填域名', style: TextStyle(fontSize: 12.5, color: sub)),
                const SizedBox(height: 16),
                TextField(
                  controller: _ctrl,
                  enabled: !_busy,
                  keyboardType: TextInputType.url,
                  autocorrect: false,
                  decoration: const InputDecoration(
                    labelText: '地址',
                    hintText: '192.168.1.10:8080',
                    prefixIcon: Icon(Icons.dns_outlined),
                  ),
                ),
                if (_error.isNotEmpty) ...[
                  const SizedBox(height: 10),
                  Text(_error, style: const TextStyle(color: pgDanger, fontSize: 13)),
                ],
                const SizedBox(height: 12),
                Row(
                  children: [
                    Expanded(
                      child: OutlinedButton.icon(
                        onPressed: _busy ? null : _startScan,
                        icon: Icon(_scanning ? Icons.stop_circle_outlined : Icons.radar_rounded, size: 18),
                        label: Text(_scanning ? '停止扫描' : '扫描局域网'),
                      ),
                    ),
                    const SizedBox(width: 10),
                    Expanded(
                      child: FilledButton(
                        onPressed: _busy ? null : _save,
                        child: _busy
                            ? const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white))
                            : const Text('连接'),
                      ),
                    ),
                  ],
                ),
                if (_scanning) ...[
                  const SizedBox(height: 12),
                  ClipRRect(
                    borderRadius: BorderRadius.circular(4),
                    child: LinearProgressIndicator(value: _total == 0 ? null : _done / _total),
                  ),
                  const SizedBox(height: 6),
                  Text('已探测 $_done / $_total，命中 ${_found.length} 个', style: TextStyle(fontSize: 12, color: sub)),
                ],
                if (_found.isNotEmpty) ...[
                  const SizedBox(height: 14),
                  Text('扫到的服务器', style: TextStyle(fontSize: 13, fontWeight: FontWeight.w600, color: ink)),
                  const SizedBox(height: 8),
                  for (final f in _found)
                    PgCard(
                      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
                      onTap: () => setState(() => _ctrl.text = f.base),
                      child: Row(
                        children: [
                          const Icon(Icons.check_circle_rounded, color: Color(0xFF1E8E3E), size: 18),
                          const SizedBox(width: 10),
                          Expanded(child: Text(f.base, style: TextStyle(fontSize: 13.5, color: ink))),
                          Text(f.version, style: TextStyle(fontSize: 12, color: sub)),
                        ],
                      ),
                    ),
                ],
                if (history.isNotEmpty) ...[
                  const SizedBox(height: 16),
                  Row(
                    children: [
                      Text('最近使用', style: TextStyle(fontSize: 13, fontWeight: FontWeight.w600, color: ink)),
                      const Spacer(),
                      TextButton(
                        onPressed: () async {
                          await Store.clearHistory(keep: Store.baseUrl);
                          if (mounted) setState(() {});
                        },
                        style: TextButton.styleFrom(visualDensity: VisualDensity.compact),
                        child: const Text('清除'),
                      ),
                    ],
                  ),
                  Wrap(
                    spacing: 8,
                    runSpacing: 8,
                    children: [
                      for (final h in history)
                        ActionChip(
                          label: Text(h, style: const TextStyle(fontSize: 12.5)),
                          onPressed: () => setState(() => _ctrl.text = h),
                        ),
                    ],
                  ),
                ],
                const SizedBox(height: 10),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
