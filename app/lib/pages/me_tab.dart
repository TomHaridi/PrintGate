import 'package:flutter/material.dart';

import '../core/api.dart';
import '../core/models.dart';
import '../core/store.dart';
import '../theme.dart';
import 'login_page.dart';
import 'setup_page.dart';

class MeTab extends StatelessWidget {
  const MeTab({super.key, required this.me, required this.onRefresh});

  final MeResult? me;
  final Future<void> Function() onRefresh;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final user = me?.user;

    return ListView(
      padding: const EdgeInsets.fromLTRB(16, 12, 16, 24),
      children: [
        PgCard(
          child: Row(
            children: [
              Container(
                width: 54,
                height: 54,
                decoration: BoxDecoration(color: pgPrimarySoft, borderRadius: BorderRadius.circular(16)),
                child: const Icon(Icons.person_rounded, color: pgPrimary, size: 30),
              ),
              const SizedBox(width: 14),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      user?.displayName ?? '未登录',
                      style: const TextStyle(fontSize: 17, fontWeight: FontWeight.w600),
                    ),
                    const SizedBox(height: 4),
                    Text(
                      _subtitle(user),
                      style: TextStyle(fontSize: 12.5, color: scheme.onSurfaceVariant),
                    ),
                  ],
                ),
              ),
              IconButton(
                tooltip: '刷新',
                onPressed: () => onRefresh(),
                icon: const Icon(Icons.refresh_rounded),
              ),
            ],
          ),
        ),
        const SizedBox(height: 12),
        PgCard(
          padding: EdgeInsets.zero,
          child: Column(
            children: [
              ListTile(
                leading: const Icon(Icons.dns_outlined),
                title: const Text('服务器'),
                subtitle: Text(Store.baseUrl, maxLines: 1, overflow: TextOverflow.ellipsis),
                trailing: const Icon(Icons.chevron_right_rounded),
                onTap: () => _changeServer(context),
              ),
              const Divider(height: 1),
              ListTile(
                leading: const Icon(Icons.lock_outline),
                title: const Text('修改密码'),
                trailing: const Icon(Icons.chevron_right_rounded),
                onTap: () => _changePassword(context),
              ),
              const Divider(height: 1),
              ListTile(
                leading: const Icon(Icons.info_outline),
                title: const Text('接口版本'),
                subtitle: const Text('与后端 /api/mp/version 校验'),
                trailing: const Icon(Icons.chevron_right_rounded),
                onTap: () => _checkVersion(context),
              ),
            ],
          ),
        ),
        const SizedBox(height: 20),
        OutlinedButton(
          onPressed: () => _signOut(context),
          style: OutlinedButton.styleFrom(foregroundColor: pgDanger),
          child: const Text('退出登录'),
        ),
        const SizedBox(height: 24),
        Center(
          child: Text(
            'PrintGate · Flutter 客户端',
            style: TextStyle(fontSize: 12, color: scheme.onSurfaceVariant),
          ),
        ),
      ],
    );
  }

  String _subtitle(PgUser? u) {
    if (u == null) return '—';
    final bits = <String>[];
    if (u.username.isNotEmpty) bits.add('账号：${u.username}');
    if (u.isAdmin) bits.add('管理员');
    switch (u.status) {
      case 'approved':
        bits.add('已通过审批');
        break;
      case 'pending':
        bits.add('待审批');
        break;
      case 'blocked':
        bits.add('已停用');
        break;
      default:
        bits.add(u.status);
    }
    return bits.join(' · ');
  }

  Future<void> _changeServer(BuildContext context) async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('更换服务器'),
        content: const Text('换服务器需要重新登录，继续吗？'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('取消')),
          TextButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('继续')),
        ],
      ),
    );
    if (ok != true || !context.mounted) return;
    await Store.forgetServer();
    if (!context.mounted) return;
    Navigator.of(context).pushAndRemoveUntil(
      MaterialPageRoute(builder: (_) => const SetupPage()),
      (_) => false,
    );
  }

  Future<void> _changePassword(BuildContext context) async {
    final oldCtrl = TextEditingController();
    final newCtrl = TextEditingController();
    final againCtrl = TextEditingController();
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('修改密码'),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            TextField(controller: oldCtrl, obscureText: true, decoration: const InputDecoration(labelText: '当前密码')),
            const SizedBox(height: 10),
            TextField(controller: newCtrl, obscureText: true, decoration: const InputDecoration(labelText: '新密码（至少 8 位，含字母和数字）')),
            const SizedBox(height: 10),
            TextField(controller: againCtrl, obscureText: true, decoration: const InputDecoration(labelText: '再输一次新密码')),
          ],
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('取消')),
          TextButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('保存')),
        ],
      ),
    );
    if (ok != true) return;
    if (newCtrl.text != againCtrl.text) {
      if (context.mounted) {
        ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('两次输入的新密码不一致')));
      }
      return;
    }
    try {
      await Api().changePassword(oldCtrl.text, newCtrl.text);
      if (!context.mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('密码已修改，下次用新密码登录')));
    } on ApiException catch (e) {
      if (!context.mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(e.message)));
    }
  }

  Future<void> _checkVersion(BuildContext context) async {
    try {
      final d = await Api().serverVersion();
      if (!context.mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('服务端版本 ${d['version'] ?? '未知'}')),
      );
    } on ApiException catch (e) {
      if (!context.mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(e.message)));
    }
  }

  Future<void> _signOut(BuildContext context) async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('退出登录'),
        content: const Text('退出后需要重新输入密码，继续吗？'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('取消')),
          TextButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('退出')),
        ],
      ),
    );
    if (ok != true) return;
    await Store.signOut();
    if (!context.mounted) return;
    Navigator.of(context).pushAndRemoveUntil(
      MaterialPageRoute(builder: (_) => const LoginPage()),
      (_) => false,
    );
  }
}
