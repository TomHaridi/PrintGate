import 'package:flutter/material.dart';

import '../core/api.dart';
import '../core/store.dart';
import '../theme.dart';
import 'home_page.dart';
import 'setup_page.dart';

/// 账号密码登录。用的是后台「用户」里的账号（/api/auth/account/login），
/// 签发的令牌与小程序同权，所以直接复用 /api/mp/*。
class LoginPage extends StatefulWidget {
  const LoginPage({super.key});

  @override
  State<LoginPage> createState() => _LoginPageState();
}

class _LoginPageState extends State<LoginPage> {
  final _user = TextEditingController();
  final _pass = TextEditingController();
  bool _busy = false;
  bool _obscure = true;
  String _error = '';

  @override
  void dispose() {
    _user.dispose();
    _pass.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    final u = _user.text.trim().toLowerCase();
    final p = _pass.text;
    if (u.isEmpty || p.isEmpty) {
      setState(() => _error = '请输入用户名和密码');
      return;
    }
    setState(() {
      _busy = true;
      _error = '';
    });
    try {
      final api = Api(token: '');
      final d = await api.login(u, p);
      final token = d['token']?.toString() ?? '';
      if (token.isEmpty) throw ApiException('服务端没返回登录令牌');
      await Store.setToken(token);
      if (!mounted) return;
      Navigator.of(context).pushReplacement(MaterialPageRoute(builder: (_) => const HomePage()));
    } catch (e) {
      final msg = e is ApiException ? e.message : '$e';
      setState(() => _error = msg);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _switchServer() async {
    await Store.forgetServer();
    if (!mounted) return;
    Navigator.of(context).pushReplacement(MaterialPageRoute(builder: (_) => const SetupPage()));
  }

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Scaffold(
      body: SafeArea(
        child: SingleChildScrollView(
          padding: const EdgeInsets.fromLTRB(24, 40, 24, 24),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Center(
                child: Container(
                  width: 72,
                  height: 72,
                  decoration: BoxDecoration(
                    color: pgPrimarySoft,
                    borderRadius: BorderRadius.circular(20),
                  ),
                  child: const Icon(Icons.print_rounded, color: pgPrimary, size: 38),
                ),
              ),
              const SizedBox(height: 18),
              Text(
                '登录 PrintGate',
                textAlign: TextAlign.center,
                style: TextStyle(fontSize: 22, fontWeight: FontWeight.w700, color: scheme.onSurface),
              ),
              const SizedBox(height: 24),
              TextField(
                controller: _user,
                enabled: !_busy,
                autocorrect: false,
                textInputAction: TextInputAction.next,
                decoration: const InputDecoration(
                  labelText: '用户名',
                  prefixIcon: Icon(Icons.person_outline),
                ),
              ),
              const SizedBox(height: 12),
              TextField(
                controller: _pass,
                enabled: !_busy,
                obscureText: _obscure,
                textInputAction: TextInputAction.done,
                onSubmitted: (_) => _submit(),
                decoration: InputDecoration(
                  labelText: '密码',
                  prefixIcon: const Icon(Icons.lock_outline),
                  suffixIcon: IconButton(
                    icon: Icon(_obscure ? Icons.visibility_off_outlined : Icons.visibility_outlined),
                    onPressed: () => setState(() => _obscure = !_obscure),
                  ),
                ),
              ),
              if (_error.isNotEmpty) ...[
                const SizedBox(height: 10),
                Text(_error, style: const TextStyle(color: pgDanger, fontSize: 13)),
              ],
              const SizedBox(height: 20),
              FilledButton(
                onPressed: _busy ? null : _submit,
                child: _busy
                    ? const SizedBox(
                        width: 20,
                        height: 20,
                        child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white),
                      )
                    : const Text('登录'),
              ),
              const SizedBox(height: 14),
              Text(
                '没有账号？让管理员在网页后台「用户」里给你开一个。',
                textAlign: TextAlign.center,
                style: TextStyle(fontSize: 12.5, color: scheme.onSurfaceVariant),
              ),
              const SizedBox(height: 28),
              TextButton.icon(
                onPressed: _busy ? null : _switchServer,
                icon: const Icon(Icons.dns_outlined, size: 18),
                label: Text(
                  Store.baseUrl.isEmpty ? '设置服务器' : '服务器：${Store.baseUrl}',
                  overflow: TextOverflow.ellipsis,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
