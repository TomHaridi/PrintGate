import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';

import 'core/api.dart';
import 'core/store.dart';
import 'pages/home_page.dart';
import 'pages/login_page.dart';
import 'pages/setup_page.dart';
import 'theme.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await Store.init();
  runApp(const PrintGateApp());
}

class PrintGateApp extends StatelessWidget {
  const PrintGateApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'PrintGate',
      debugShowCheckedModeBanner: false,
      theme: buildTheme(Brightness.light),
      darkTheme: buildTheme(Brightness.dark),
      home: const Bootstrap(),
    );
  }
}

/// 启动分流：没配服务器 → 地址页；配了但没登录 → 登录页；都齐了 → 主界面
class Bootstrap extends StatefulWidget {
  const Bootstrap({super.key});

  @override
  State<Bootstrap> createState() => _BootstrapState();
}

class _BootstrapState extends State<Bootstrap> {
  Widget? _next;
  String? _hint;

  @override
  void initState() {
    super.initState();
    _decide();
  }

  Future<void> _decide() async {
    if (!Store.hasServer) {
      setState(() => _next = const SetupPage());
      return;
    }
    if (!Store.hasToken) {
      setState(() => _next = const LoginPage());
      return;
    }
    // 有令牌但可能已过期：静默验一次，过期就回登录页
    try {
      await Api().me();
      setState(() => _next = const HomePage());
    } on ApiException catch (e) {
      if (e.unauthorized) {
        await Store.clearToken();
        setState(() => _next = const LoginPage());
      } else {
        // 服务器暂时连不上：不把用户踢出去，先当已登录进主界面，各页面自己报错
        setState(() {
          _hint = e.message;
          _next = const HomePage();
        });
      }
    } catch (e) {
      setState(() => _next = const LoginPage());
    }
  }

  @override
  Widget build(BuildContext context) {
    final next = _next;
    if (next == null) {
      return const Scaffold(body: Center(child: CircularProgressIndicator()));
    }
    if (_hint != null && kDebugMode) {
      debugPrint('[bootstrap] ${_hint!}');
    }
    return next;
  }
}
