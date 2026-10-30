import 'dart:math' as math;

/// 与小程序 `utils/format.js` 一一对应，保证两端口径一致（状态文案、摘要、相对时间）。
class Fmt {
  static String size(num? bytes) {
    final b = (bytes ?? 0).toDouble();
    if (b < 1024) return '${b.toInt()} B';
    if (b < 1024 * 1024) return '${(b / 1024).toStringAsFixed(1)} KB';
    return '${(b / 1024 / 1024).toStringAsFixed(2)} MB';
  }

  static String _pad(int n) => n < 10 ? '0$n' : '$n';

  /// 后端存 UTC，可能带 Z / 偏移，也可能是 SQLite 风格 `YYYY-MM-DD HH:MM:SS`
  static DateTime? parse(String? v) {
    if (v == null || v.trim().isEmpty) return null;
    var s = v.trim();
    final m = RegExp(r'^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?\s*(Z|[+-]\d{2}:?\d{2})?$')
        .firstMatch(s);
    if (m != null) {
      final tz = m.group(7) ?? 'Z';
      final sec = m.group(6) ?? '00';
      s = '${m.group(1)}-${m.group(2)}-${m.group(3)}T${m.group(4)}:${m.group(5)}:$sec'
          '${tz == 'Z' ? 'Z' : tz.replaceFirst(RegExp(r'([+-]\d{2})(\d{2})$'), r'$1:$2')}';
    }
    final d = DateTime.tryParse(s);
    return d?.toLocal();
  }

  static String time(String? iso, {bool withYear = false}) {
    if (iso == null || iso.isEmpty) return '';
    final d = parse(iso);
    if (d == null) return iso.length > 16 ? iso.substring(0, 16) : iso;
    final ymd = withYear ? '${d.year}-${_pad(d.month)}-${_pad(d.day)}' : '${_pad(d.month)}-${_pad(d.day)}';
    return '$ymd ${_pad(d.hour)}:${_pad(d.minute)}';
  }

  static String relative(String? iso) {
    if (iso == null || iso.isEmpty) return '';
    final d = parse(iso);
    if (d == null) return '';
    final diff = DateTime.now().difference(d);
    if (diff.inMinutes < 1) return '刚刚';
    if (diff.inHours < 1) return '${diff.inMinutes} 分钟前';
    if (diff.inDays < 1) return '${diff.inHours} 小时前';
    if (diff.inDays < 7) return '${diff.inDays} 天前';
    return time(iso, withYear: true);
  }

  // ---------- 状态 ----------
  static const _taskStatus = {
    'pending': ('待审批', 'warning'),
    'approved': ('已放行', 'info'),
    'printing': ('打印中', 'primary'),
    'done': ('已完成', 'success'),
    'failed': ('失败', 'danger'),
    'rejected': ('已拒绝', 'plain'),
    'canceled': ('已取消', 'plain'),
  };

  static ({String text, String kind}) taskStatus(String? s) {
    final hit = _taskStatus[s ?? ''];
    if (hit != null) return (text: hit.$1, kind: hit.$2);
    return (text: (s == null || s.isEmpty) ? '未知' : s, kind: 'plain');
  }

  static const _userStatus = {
    'pending': ('待审批', 'warning'),
    'approved': ('已授权', 'success'),
    'rejected': ('已拒绝', 'plain'),
    'blocked': ('已拉黑', 'danger'),
  };

  static ({String text, String kind}) userStatus(String? s) {
    final hit = _userStatus[s ?? ''];
    if (hit != null) return (text: hit.$1, kind: hit.$2);
    return (text: (s == null || s.isEmpty) ? '未知' : s, kind: 'plain');
  }

  static ({String text, String kind}) printerState(Object? s) {
    final byName = {
      'idle': ('空闲', 'success'),
      'printing': ('打印中', 'primary'),
      'stopped': ('已暂停', 'danger'),
      'processing': ('处理中', 'primary'),
    };
    final byCode = {'3': 'idle', '4': 'printing', '5': 'stopped'};
    final key = s == null ? '' : '$s'.trim().toLowerCase();
    final name = byName[key] ?? byName[byCode[key] ?? ''];
    if (name != null) return (text: name.$1, kind: name.$2);
    return (text: key.isEmpty ? '未知' : key, kind: 'plain');
  }

  // ---------- 打印参数摘要 ----------
  static const _sides = {
    'one-sided': '单面',
    'two-sided-long-edge': '双面长边',
    'two-sided-short-edge': '双面短边',
  };
  static const _pageSet = {'odd': '奇数页', 'even': '偶数页', 'even-reverse': '偶数倒序'};

  static String optionsSummary(Map<String, dynamic> o) {
    final parts = <String>[];
    parts.add('${_int(o['copies'], 1)} 份');
    parts.add(o['color'] == 'color' ? '彩色' : '黑白');
    parts.add(_sides[o['sides']] ?? '单面');
    final media = '${o['media'] ?? 'A4'}';
    if (media != 'A4') parts.add(media);
    if (o['orientation'] == 'landscape') parts.add('横向');
    final nup = _int(o['numberUp'], 1);
    if (nup > 1) parts.add('每页 $nup 张');
    final ranges = '${o['pageRanges'] ?? ''}';
    if (ranges.isNotEmpty) parts.add('页码 $ranges');
    final ps = _pageSet['${o['pageSet'] ?? ''}'];
    if (ps != null) parts.add(ps);
    if (o['mirror'] == true) parts.add('镜像');
    if (o['pageBorder'] == true) parts.add('页边框');
    final wm = '${o['watermark'] ?? ''}';
    if (wm.isNotEmpty) parts.add('水印');
    return parts.join(' · ');
  }

  static int _int(Object? v, int fallback) {
    if (v is int) return v;
    if (v is num) return v.toInt();
    return int.tryParse('${v ?? ''}') ?? fallback;
  }

  // ---------- 文件类型 ----------
  static String ext(String? name) {
    final m = RegExp(r'\.([a-z0-9]+)$', caseSensitive: false).firstMatch(name ?? '');
    return m == null ? '' : m.group(1)!.toLowerCase();
  }

  static bool isImageName(String? name) =>
      const ['jpg', 'jpeg', 'png', 'bmp', 'gif', 'tif', 'tiff', 'webp', 'heic', 'heif'].contains(ext(name));

  static String kindOf(String? name) {
    final e = ext(name);
    if (const ['jpg', 'jpeg', 'png', 'bmp', 'gif', 'tif', 'tiff', 'webp'].contains(e)) return 'image';
    if (e == 'pdf') return 'pdf';
    if (e == 'doc' || e == 'docx') return 'doc';
    if (e == 'xls' || e == 'xlsx') return 'xls';
    if (e == 'ppt' || e == 'pptx') return 'ppt';
    if (e == 'txt') return 'txt';
    return 'other';
  }

  static String greeting() {
    final h = DateTime.now().hour;
    if (h < 6) return '夜深了';
    if (h < 11) return '早上好';
    if (h < 14) return '中午好';
    if (h < 18) return '下午好';
    return '晚上好';
  }

  static String today(DateTime now) => '${now.month}月${now.day}日';

  /// 页范围与后端同规则：只允许数字、逗号、短横线
  static String sanitizeRanges(String raw) => raw.replaceAll(RegExp(r'\s+'), '');

  static bool validRanges(String v) => v.isEmpty || RegExp(r'^[0-9][0-9,-]{0,80}$').hasMatch(v);

  static double clampDouble(double v, double lo, double hi) => math.min(math.max(v, lo), hi);
}
