import 'package:flutter/material.dart';

import '../theme.dart';
import 'api.dart';
import 'models.dart';
import 'store.dart';

/// 全局状态：主题（模式 + 主色）、服务器地址、登录用户与配置。
/// 小程序用 `getApp().globalData` 存这些，这里换成 ChangeNotifier + InheritedNotifier。
class AppCtl extends ChangeNotifier {
  AppCtl() {
    _mode = Store.themeMode;
    _primary = isHexColor(Store.primary) ? Store.primary.toUpperCase() : kDefaultPrimary;
  }

  late String _mode;
  String _primary = kDefaultPrimary;

  PgUser? user;
  Map<String, dynamic> config = const {};

  String get baseUrl => Store.baseUrl;
  bool get hasServer => Store.hasServer;
  String get token => Store.token;

  String get themeMode => _mode;
  String get primary => _primary;
  String get primaryName => kPrimaryPresets[_primary] ?? _primary;

  ThemeMode get materialMode {
    switch (_mode) {
      case 'light':
        return ThemeMode.light;
      case 'dark':
        return ThemeMode.dark;
      default:
        return ThemeMode.system;
    }
  }

  ThemeData themeOf(Brightness b) => buildTheme(hexColor(_primary), b);

  bool get approved => user?.approved ?? false;
  bool get isAdmin => (user?.isAdmin ?? false) && (user?.approved ?? false);

  int get maxCopies => _int(config['maxCopies'], 99);
  int get maxFileMB => _int(config['maxFileMB'], 20);
  int get maxPages => _int(config['maxPages'], 50);
  bool get approveEachJob => config['approveEachJob'] == true;
  bool get advancedPrint => config['advancedPrint'] != false;

  Api get api => Api();

  // ---------- 主题 ----------
  Future<void> setThemeMode(String mode) async {
    final m = const ['auto', 'light', 'dark'].contains(mode) ? mode : 'auto';
    _mode = m;
    await Store.setThemeMode(m);
    notifyListeners();
  }

  Future<void> setPrimary(String hex) async {
    _primary = isHexColor(hex) ? hex.toUpperCase() : kDefaultPrimary;
    await Store.setPrimary(_primary);
    notifyListeners();
  }

  // ---------- 会话 ----------
  Future<void> setBaseUrl(String url) async {
    await Store.setBaseUrl(url);
    notifyListeners();
  }

  Future<void> setToken(String token) async {
    await Store.setToken(token);
    notifyListeners();
  }

  Future<void> applyUser(PgUser u, [Map<String, dynamic>? cfg]) async {
    user = u;
    if (cfg != null) config = cfg;
    notifyListeners();
  }

  /// 拉一次 /api/mp/me；令牌失效时清登录态并通知调用方跳登录页
  Future<PgUser?> refreshUser() async {
    try {
      final me = await Api().me();
      user = me.user;
      config = me.config;
      notifyListeners();
      return me.user;
    } on ApiException catch (e) {
      if (e.unauthorized) {
        await Store.signOut();
        user = null;
        notifyListeners();
      }
      rethrow;
    }
  }

  Future<void> logout() async {
    await Store.signOut();
    user = null;
    config = const {};
    notifyListeners();
  }

  static int _int(Object? v, int fallback) {
    if (v is int) return v;
    if (v is num) return v.toInt();
    return int.tryParse('${v ?? ''}') ?? fallback;
  }
}

/// 用 InheritedNotifier 把 AppCtl 往下传，任何页面 `AppScope.of(context)` 取用
class AppScope extends InheritedNotifier<AppCtl> {
  const AppScope({super.key, required AppCtl ctl, required super.child}) : super(notifier: ctl);

  static AppCtl of(BuildContext context) {
    final scope = context.dependOnInheritedWidgetOfExactType<AppScope>();
    assert(scope?.notifier != null, 'AppScope 没有挂在根节点上');
    return scope!.notifier!;
  }

  /// 只读不订阅（在 initState / 回调里用）
  static AppCtl read(BuildContext context) {
    final scope = context.getInheritedWidgetOfExactType<AppScope>();
    return scope!.notifier!;
  }
}
