import 'dart:async';
import 'dart:convert';

import 'package:http/http.dart' as http;

/// 局域网发现 PrintGate 服务。
///
/// 小程序没有 raw socket，只能"猜网段 + 逐个 HTTP 探测 /api/health"。
/// iOS 端虽然能拿到真实 IP，但为了与小程序行为一致（也为了避免私有 API），
/// 仍然用同一套候选地址探测；好处是不需要任何额外权限，局域网 http 也不会被 ATS 拦。
class LanScan {
  static const int portMain = 8080;
  static const List<int> altPorts = [80, 8000, 3000];

  static const List<String> subnets = [
    '192.168.1.', '192.168.0.', '192.168.31.', '192.168.2.', '192.168.3.', '192.168.4.',
    '10.0.0.', '10.0.1.', '10.1.1.', '172.16.0.',
  ];
  static const List<String> gatewayHosts = ['1', '254'];
  static const List<String> serverHosts = ['2', '10', '50', '100', '101', '102', '110', '200'];

  /// 候选地址：给了 `192.168.123.` 这种前缀就整段扫（只探 8080，否则数量爆炸）
  static List<String> candidates(String prefix) {
    final p = prefix.trim();
    final out = <String>[];
    if (RegExp(r'^\d{1,3}\.\d{1,3}\.\d{1,3}\.$').hasMatch(p)) {
      for (var i = 1; i <= 254; i++) {
        out.add('http://$p$i:$portMain');
      }
      return out;
    }
    out.add('http://127.0.0.1:$portMain');
    out.add('http://127.0.0.1:80');
    for (final sn in subnets) {
      for (final h in gatewayHosts) {
        out.add('http://$sn$h:$portMain');
        for (final port in altPorts) {
          out.add('http://$sn$h:$port');
        }
      }
    }
    for (final sn in subnets) {
      for (final h in serverHosts) {
        out.add('http://$sn$h:$portMain');
        out.add('http://$sn$h:80');
      }
    }
    return out;
  }

  static Future<({bool ok, String base, String version})> probe(
    String base, {
    Duration timeout = const Duration(milliseconds: 900),
  }) async {
    try {
      final res = await http.get(Uri.parse('$base/api/health')).timeout(timeout);
      if (res.statusCode == 200) {
        final d = jsonDecode(utf8.decode(res.bodyBytes));
        if (d is Map && d['ok'] == true &&
            RegExp('printgate', caseSensitive: false).hasMatch('${d['app'] ?? ''}')) {
          return (ok: true, base: base, version: '${d['version'] ?? ''}');
        }
      }
    } catch (_) {
      // 超时/拒连/不是 http 服务，都当未命中
    }
    return (ok: false, base: base, version: '');
  }

  /// 有限并发探测；命中立刻回调，用户能边扫边选
  static Future<({List<({String base, String version})> found, int total})> scan({
    String prefix = '',
    int concurrency = 16,
    void Function(int done, int total, List<({String base, String version})> found)? onProgress,
    bool Function()? shouldStop,
  }) async {
    final list = candidates(prefix);
    final found = <({String base, String version})>[];
    var idx = 0;
    var scanned = 0;

    Future<void> worker() async {
      while (idx < list.length) {
        if (shouldStop?.call() ?? false) return;
        final base = list[idx++];
        final r = await probe(base);
        scanned++;
        if (r.ok && !found.any((x) => x.base == r.base)) {
          found.add((base: r.base, version: r.version));
        }
        if (onProgress != null && (scanned % 3 == 0 || scanned == list.length)) {
          onProgress(scanned, list.length, List.of(found));
        }
      }
    }

    await Future.wait(List.generate(concurrency < list.length ? concurrency : list.length, (_) => worker()));
    return (found: found, total: list.length);
  }

  /// 单个地址校验（点历史地址时用）
  static Future<bool> check(String base) async {
    final b = base.replaceAll(RegExp(r'/+$'), '');
    if (b.isEmpty) return false;
    final r = await probe(b, timeout: const Duration(seconds: 3));
    return r.ok;
  }
}
