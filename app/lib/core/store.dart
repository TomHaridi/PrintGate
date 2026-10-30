import 'package:shared_preferences/shared_preferences.dart';

/// 本地持久化：服务器地址（含历史）+ 登录令牌 + 主题。
/// PrintGate 是私有部署，一台手机通常只连一台服务器，所以主地址只存一条。
class Store {
  static const _kBase = 'pg.base.url';
  static const _kHistory = 'pg.base.history';
  static const _kToken = 'pg.token';
  static const _kThemeMode = 'pg_theme_mode';
  static const _kPrimary = 'pg_primary';

  static SharedPreferences? _p;

  static Future<void> init() async {
    _p ??= await SharedPreferences.getInstance();
  }

  // ---------- 服务器 ----------
  static String get baseUrl => _p?.getString(_kBase) ?? '';
  static bool get hasServer => baseUrl.isNotEmpty;

  static Future<void> setBaseUrl(String v) async {
    await _p?.setString(_kBase, v);
    await addHistory(v);
  }

  static List<String> get history => _p?.getStringList(_kHistory) ?? const [];

  static Future<void> addHistory(String v) async {
    if (v.isEmpty) return;
    final list = [...history]..remove(v);
    list.insert(0, v);
    await _p?.setStringList(_kHistory, list.take(6).toList());
  }

  static Future<void> clearHistory({required String keep}) async {
    await _p?.setStringList(_kHistory, [if (keep.isNotEmpty) keep]);
  }

  // ---------- 会话 ----------
  static String get token => _p?.getString(_kToken) ?? '';
  static bool get hasToken => token.isNotEmpty;

  static Future<void> setToken(String v) async {
    await _p?.setString(_kToken, v);
  }

  static Future<void> signOut() async {
    await _p?.remove(_kToken);
  }

  /// 换服务器：地址和令牌一起清（历史保留）
  static Future<void> forgetServer() async {
    await _p?.remove(_kToken);
    await _p?.remove(_kBase);
  }

  // ---------- 主题 ----------
  static String get themeMode => _p?.getString(_kThemeMode) ?? 'auto';

  static Future<void> setThemeMode(String v) async {
    await _p?.setString(_kThemeMode, v);
  }

  static String get primary => _p?.getString(_kPrimary) ?? '';

  static Future<void> setPrimary(String hex) async {
    await _p?.setString(_kPrimary, hex);
  }

  // ---------- 地址归一化 ----------
  /// 只输入 `192.168.1.10:8080` 也能用：补协议、去尾部斜杠。
  /// 内网默认 http，公网域名默认 https —— 与小程序端规则一致。
  static String normalize(String raw) {
    var s = raw.trim();
    if (s.isEmpty) return '';
    while (s.endsWith('/')) {
      s = s.substring(0, s.length - 1);
    }
    if (!s.toLowerCase().startsWith('http://') && !s.toLowerCase().startsWith('https://')) {
      final hostPart = s.split('/').first;
      final hostOnly = hostPart.split(':').first;
      final isLan = !hostOnly.contains('.') || _isPrivate(hostOnly);
      s = (isLan ? 'http://' : 'https://') + s;
    }
    final uri = Uri.tryParse(s);
    if (uri == null || uri.host.isEmpty) return '';
    return s;
  }

  static bool _isPrivate(String host) {
    if (host == 'localhost') return true;
    final parts = host.split('.');
    if (parts.length != 4) return false;
    final a = int.tryParse(parts[0]);
    final b = int.tryParse(parts[1]);
    if (a == null || b == null) return false;
    if (a == 10) return true;
    if (a == 192 && b == 168) return true;
    if (a == 172 && b >= 16 && b <= 31) return true;
    if (a == 127) return true;
    return false;
  }
}
