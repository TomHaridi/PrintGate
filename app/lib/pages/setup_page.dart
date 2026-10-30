import 'package:flutter/material.dart';

import '../core/api.dart';
import '../core/store.dart';
import 'login_page.dart';

/// 首次启动 / 换服务器：填地址 → 试连 /api/health 确认对面是 PrintGate → 存下来
class SetupPage extends StatefulWidget {
  const SetupPage({super.key});

  @override
  State<SetupPage> createState() => _SetupPageState();
}

class _SetupPageState extends State<SetupPage> {
  late final TextEditingController _ctrl = TextEditingController(text: Store.baseUrl);
  bool _busy = false;
  String _error = '';

  @override
  void dispose() {
    _ctrl.dispose();
    super.dispose();
  }

  Future<void> _connect() async {
    final raw = _ctrl.text.trim();
    if (raw.isEmpty) {
      setState(() => _error = '请填写服务器地址');
      return;
    }
    final normalized = Store.normalize(raw);
    if (normalized.isEmpty) {
      setState(() => _error = '地址格式不对，例如 192.168.1.10:8080');
      return;
    }

    setState(() {
      _busy = true;
      _error = '';
    });

    try {
      final api = Api(baseUrl: normalized, token: '');
      final info = await api.health();
      // /api/health 会带 app=PrintGate，防止填了别的 Web 服务
      if (info['app'] != 'PrintGate') {
        throw ApiException('这个地址不像是 PrintGate 服务器');
      }
      await Store.setBaseUrl(normalized);
      if (!mounted) return;
      Navigator.of(context).pushReplacement(
        MaterialPageRoute(builder: (_) => const LoginPage()),
      );
    } catch (e) {
      final msg = e is ApiException ? e.message : '$e';
      setState(() => _error = msg);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Scaffold(
      body: SafeArea(
        child: SingleChildScrollView(
          padding: const EdgeInsets.fromLTRB(24, 48, 24, 24),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Center(
                child: Container(
                  width: 84,
                  height: 84,
                  decoration: BoxDecoration(
                    gradient: const LinearGradient(
                      colors: [Color(0xFF0C8B80), Color(0xFF12A597)],
                      begin: Alignment.topLeft,
                      end: Alignment.bottomRight,
                    ),
                    borderRadius: BorderRadius.circular(22),
                  ),
                  child: const Icon(Icons.print_rounded, color: Colors.white, size: 44),
                ),
              ),
              const SizedBox(height: 20),
              Text(
                'PrintGate',
                textAlign: TextAlign.center,
                style: TextStyle(fontSize: 26, fontWeight: FontWeight.w700, color: scheme.onSurface),
              ),
              const SizedBox(height: 6),
              Text(
                '先填一下打印服务器的地址',
                textAlign: TextAlign.center,
                style: TextStyle(fontSize: 14, color: scheme.onSurfaceVariant),
              ),
              const SizedBox(height: 32),
              TextField(
                controller: _ctrl,
                enabled: !_busy,
                keyboardType: TextInputType.url,
                autocorrect: false,
                textInputAction: TextInputAction.done,
                onSubmitted: (_) => _connect(),
                decoration: const InputDecoration(
                  labelText: '服务器地址',
                  hintText: '192.168.1.10:8080',
                  prefixIcon: Icon(Icons.dns_outlined),
                ),
              ),
              if (_error.isNotEmpty) ...[
                const SizedBox(height: 10),
                Text(_error, style: const TextStyle(color: pgDangerText, fontSize: 13)),
              ],
              const SizedBox(height: 20),
              FilledButton.icon(
                onPressed: _busy ? null : _connect,
                icon: _busy
                    ? const SizedBox(
                        width: 18,
                        height: 18,
                        child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white),
                      )
                    : const Icon(Icons.bolt_rounded),
                label: Text(_busy ? '连接中…' : '连接服务器'),
              ),
              const SizedBox(height: 24),
              Container(
                padding: const EdgeInsets.all(14),
                decoration: BoxDecoration(
                  color: scheme.surface,
                  borderRadius: BorderRadius.circular(14),
                  border: Border.all(color: scheme.outlineVariant),
                ),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text('地址怎么填', style: TextStyle(fontWeight: FontWeight.w600, color: scheme.onSurface)),
                    const SizedBox(height: 8),
                    Text(
                      '· 局域网：192.168.1.10:8080 或自动补成 http://\n'
                      '· 公网：printer.example.com（自动补 https://）\n'
                      '· 端口没改过就是 8080；地址填错会提示连不上',
                      style: TextStyle(fontSize: 13, height: 1.6, color: scheme.onSurfaceVariant),
                    ),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

const Color pgDangerText = Color(0xFFC0392B);
