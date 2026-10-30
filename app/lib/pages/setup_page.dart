import 'package:flutter/material.dart';

import '../widgets/server_sheet.dart';
import 'login_page.dart';

/// 首次启动：还没配过服务器地址。
/// 打开后直接弹地址面板（不用先点按钮再弹），用户只要填一次。
class SetupPage extends StatelessWidget {
  const SetupPage({super.key});

  @override
  Widget build(BuildContext context) {
    final dark = Theme.of(context).brightness == Brightness.dark;
    return Scaffold(
      body: SafeArea(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(24, 40, 24, 24),
          child: Column(
            children: [
              const Spacer(),
              ClipRRect(
                borderRadius: BorderRadius.circular(26),
                child: Image.asset('assets/logo.png', width: 108, height: 108, fit: BoxFit.cover),
              ),
              const SizedBox(height: 22),
              Text('PrintGate', style: TextStyle(fontSize: 27, fontWeight: FontWeight.w700, color: dark ? Colors.white : const Color(0xFF101B1A))),
              const SizedBox(height: 8),
              Text(
                '先连上打印服务器，之后就一键进入',
                textAlign: TextAlign.center,
                style: TextStyle(fontSize: 14, color: dark ? const Color(0xFF8A9C9A) : const Color(0xFF6B807E)),
              ),
              const Spacer(),
              FilledButton.icon(
                onPressed: () => _open(context),
                icon: const Icon(Icons.dns_outlined),
                label: const Text('填写服务器地址'),
              ),
              const SizedBox(height: 12),
              OutlinedButton.icon(
                onPressed: () => _open(context),
                icon: const Icon(Icons.radar_rounded, size: 18),
                label: const Text('扫描局域网'),
              ),
              const SizedBox(height: 18),
              Text(
                '地址示例：192.168.1.10:8080　·　端口没改过就是 8080',
                style: TextStyle(fontSize: 12, color: dark ? const Color(0xFF6A7C7A) : const Color(0xFF9AAEAC)),
              ),
              const SizedBox(height: 8),
            ],
          ),
        ),
      ),
    );
  }

  void _open(BuildContext context) {
    ServerSheet.show(
      context,
      onSaved: (url) async {
        if (!context.mounted) return;
        Navigator.of(context).pushReplacement(MaterialPageRoute(builder: (_) => const LoginPage()));
      },
    );
  }
}
