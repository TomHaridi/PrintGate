import 'dart:io';

import 'package:flutter/material.dart';
import 'package:image_picker/image_picker.dart';

import '../core/api.dart';
import '../core/app_state.dart';
import '../core/models.dart';
import '../core/store.dart';
import '../theme.dart';
import '../widgets/server_sheet.dart';
import 'home_page.dart';

/// 账号密码登录（与小程序同一套 users 表，令牌同权）
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

  Future<void> _login() async {
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
    final ctl = AppScope.read(context);
    try {
      final d = await Api(token: '').login(u, p);
      final token = d['token']?.toString() ?? '';
      if (token.isEmpty) throw ApiException('服务端没返回登录令牌');
      await ctl.setToken(token);
      final me = await ctl.refreshUser();
      if (!mounted) return;
      // 与小程序一致：昵称还没补的话，进首页前引导填一次（可跳过）
      if (me != null && me.nickname.trim().isEmpty) {
        await _askProfile(me);
      }
      if (!mounted) return;
      Navigator.of(context).pushReplacement(MaterialPageRoute(builder: (_) => const HomePage()));
    } catch (e) {
      if (!mounted) return;
      setState(() => _error = e is ApiException ? e.message : '$e');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _askProfile(PgUser user) async {
    final nick = TextEditingController(text: user.nickname);
    String? avatarPath;
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => StatefulBuilder(
        builder: (ctx, setLocal) => AlertDialog(
          title: const Text('完善资料'),
          content: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              GestureDetector(
                onTap: () async {
                  final picked = await ImagePicker().pickImage(source: ImageSource.gallery, imageQuality: 85);
                  if (picked != null) setLocal(() => avatarPath = picked.path);
                },
                child: CircleAvatar(
                  radius: 34,
                  backgroundColor: Theme.of(ctx).colorScheme.primary.withValues(alpha: 0.12),
                  backgroundImage: avatarPath != null ? FileImage(File(avatarPath!)) : null,
                  child: avatarPath == null ? const Icon(Icons.add_a_photo_outlined) : null,
                ),
              ),
              const SizedBox(height: 14),
              TextField(
                controller: nick,
                decoration: const InputDecoration(labelText: '昵称（必填）'),
              ),
              const SizedBox(height: 8),
              Text('资料可以稍后在「我的」里完善', style: TextStyle(fontSize: 12, color: Theme.of(ctx).colorScheme.onSurfaceVariant)),
            ],
          ),
          actions: [
            TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('跳过')),
            TextButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('保存')),
          ],
        ),
      ),
    );
    if (ok != true) return;
    final ctl = AppScope.read(context);
    try {
      if (avatarPath != null) {
        final u = await Api().uploadAvatar(avatarPath!);
        if (u.id > 0) await ctl.applyUser(u);
      }
      final name = nick.text.trim();
      if (name.isNotEmpty) {
        final u = await Api().saveProfile({'nickname': name});
        await ctl.applyUser(u);
      }
    } on ApiException catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('资料保存失败：${e.message}')));
    }
  }

  Future<void> _openServer() async {
    await ServerSheet.show(
      context,
      onSaved: (_) async {
        if (mounted) setState(() => _error = '');
      },
    );
    if (mounted) setState(() {});
  }

  @override
  Widget build(BuildContext context) {
    final dark = Theme.of(context).brightness == Brightness.dark;
    final ink = dark ? Colors.white : const Color(0xFF101B1A);
    final sub = dark ? const Color(0xFF8A9C9A) : const Color(0xFF6B807E);

    return Scaffold(
      body: SafeArea(
        child: SingleChildScrollView(
          padding: const EdgeInsets.fromLTRB(24, 48, 24, 24),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Center(
                child: ClipRRect(
                  borderRadius: BorderRadius.circular(22),
                  child: Image.asset('assets/logo.png', width: 84, height: 84, fit: BoxFit.cover),
                ),
              ),
              const SizedBox(height: 18),
              Text('登录 PrintGate', textAlign: TextAlign.center, style: TextStyle(fontSize: 22, fontWeight: FontWeight.w700, color: ink)),
              const SizedBox(height: 28),
              TextField(
                controller: _user,
                enabled: !_busy,
                autocorrect: false,
                textInputAction: TextInputAction.next,
                decoration: const InputDecoration(labelText: '用户名', prefixIcon: Icon(Icons.person_outline)),
              ),
              const SizedBox(height: 12),
              TextField(
                controller: _pass,
                enabled: !_busy,
                obscureText: _obscure,
                textInputAction: TextInputAction.done,
                onSubmitted: (_) => _login(),
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
                onPressed: _busy ? null : _login,
                child: _busy
                    ? const SizedBox(width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white))
                    : const Text('登录'),
              ),
              const SizedBox(height: 12),
              Text(
                '没有账号？让管理员在网页后台「用户」里开一个。',
                textAlign: TextAlign.center,
                style: TextStyle(fontSize: 12.5, color: sub),
              ),
              const SizedBox(height: 26),
              PgCard(
                padding: EdgeInsets.zero,
                child: ListTile(
                  leading: const Icon(Icons.dns_outlined),
                  title: const Text('服务器', style: TextStyle(fontSize: 14)),
                  subtitle: Text(Store.baseUrl.isEmpty ? '未设置' : Store.baseUrl, maxLines: 1, overflow: TextOverflow.ellipsis),
                  trailing: const Icon(Icons.chevron_right_rounded),
                  onTap: _busy ? null : _openServer,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
