import 'package:flutter/material.dart';

import 'core/api.dart';
import 'core/app_state.dart';
import 'core/store.dart';
import 'pages/home_page.dart';
import 'pages/login_page.dart';
import 'pages/setup_page.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await Store.init();
  runApp(PrintGateApp(ctl: AppCtl()));
}

class PrintGateApp extends StatefulWidget {
  const PrintGateApp({super.key, required this.ctl});

  final AppCtl ctl;

  @override
  State<PrintGateApp> createState() => _PrintGateAppState();
}

class _PrintGateAppState extends State<PrintGateApp> {
  @override
  Widget build(BuildContext context) {
    return AppScope(
      ctl: widget.ctl,
      child: AnimatedBuilder(
        animation: widget.ctl,
        builder: (context, _) => MaterialApp(
          title: 'PrintGate',
          debugShowCheckedModeBanner: false,
          theme: widget.ctl.themeOf(Brightness.light),
          darkTheme: widget.ctl.themeOf(Brightness.dark),
          themeMode: widget.ctl.materialMode,
          home: const Bootstrap(),
        ),
      ),
    );
  }
}

/// 启动分流：没配服务器 → 地址页；没登录 / 令牌失效 → 登录页；否则主界面
class Bootstrap extends StatefulWidget {
  const Bootstrap({super.key});

  @override
  State<Bootstrap> createState() => _BootstrapState();
}

class _BootstrapState extends State<Bootstrap> {
  Widget? _next;

  @override
  void initState() {
    super.initState();
    _decide();
  }

  Future<void> _decide() async {
    final ctl = AppScope.read(context);
    if (!ctl.hasServer) {
      setState(() => _next = const SetupPage());
      return;
    }
    if (!Store.hasToken) {
      setState(() => _next = const LoginPage());
      return;
    }
    try {
      await ctl.refreshUser();
      setState(() => _next = const HomePage());
    } on ApiException catch (e) {
      // 令牌过期 → 回登录；网络不通 → 先进主界面，让各页面自己提示
      setState(() => _next = e.unauthorized ? const LoginPage() : const HomePage());
    } catch (_) {
      setState(() => _next = const HomePage());
    }
  }

  @override
  Widget build(BuildContext context) {
    final next = _next;
    if (next == null) {
      return const Scaffold(body: Center(child: CircularProgressIndicator()));
    }
    return next;
  }
}
