import 'package:shared_preferences/shared_preferences.dart';

/// 本地持久化：服务器地址 + 登录令牌。
/// PrintGate 是私有部署，一台手机基本只连一台服务器，所以只存一条地址。
class Store {
  static const _kBase = 'pg.base.url';
  static const _kToken = 'pg.token';

  static SharedPreferences? _p;

  static Future<void> init() async {
    _p ??= await SharedPreferences.getInstance();
  }

  static String get baseUrl => _p?.getString(_kBase) ?? '';
  static bool get hasServer => baseUrl.isNotEmpty;

  static String get token => _p?.getString(_kToken) ?? '';
  static bool get hasToken => token.isNotEmpty;

  static Future<void> setBaseUrl(String v) async {
    await _p?.setString(_kBase, v);
  }

  static Future<void> setToken(String v) async {
    await _p?.setString(_kToken, v);
  }

  static Future<void> clearToken() async {
    await _p?.remove(_kToken);
  }

  /// 只清会话，保留服务器地址（下次打开直接回登录页）
  static Future<void> signOut() async {
    await _p?.remove(_kToken);
  }

  /// 换服务器：地址和令牌一起清
  static Future<void> forgetServer() async {
    await _p?.remove(_kToken);
    await _p?.remove(_kBase);
  }

  /// 用户可能只输入 `192.168.1.10:8080`：补协议、去尾部斜杠。
  /// 内网默认 http，公网域名默认 https —— 与小程序端规则一致。
  static String normalize(String raw) {
    var s = raw.trim();
    if (s.isEmpty) return '';
    if (!s.toLowerCase().startsWith('http://') && !s.toLowerCase().startsWith('https://')) {
      final hostPart = s.split('/').first;
      final hostOnly = hostPart.split(':').first;
      final isLan = !hostOnly.contains('.') || _isPrivate(hostOnly);
      s = (isLan ? 'http://' : 'https://') + s;
    }
    while (s.endsWith('/')) {
      s = s.substring(0, s.length - 1);
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
