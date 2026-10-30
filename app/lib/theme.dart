import 'package:flutter/material.dart';

/// 品牌色与小程序 H5 一致，主色可被用户改（我的 → 主题色）
const String kDefaultPrimary = '#0C8B80';

const Map<String, String> kPrimaryPresets = {
  '#0C8B80': '青绿',
  '#2F6FED': '海蓝',
  '#00A9A5': '碧蓝',
  '#7C4DFF': '罗兰紫',
  '#F5793B': '暖橙',
  '#E4446B': '玫红',
  '#37474F': '石墨',
};

const Color pgDanger = Color(0xFFC0392B);
const Color pgWarn = Color(0xFFB26A00);

bool isHexColor(String? v) => RegExp(r'^#[0-9a-fA-F]{6}$').hasMatch(v ?? '');

Color hexColor(String hex) {
  final v = isHexColor(hex) ? hex : kDefaultPrimary;
  return Color(int.parse('FF${v.substring(1)}', radix: 16));
}

String colorHex(Color c) {
  String two(double v) => (v * 255).round().clamp(0, 255).toRadixString(16).padLeft(2, '0');
  return '#${two(c.r)}${two(c.g)}${two(c.b)}'.toUpperCase();
}

Color mixHex(Color a, Color target, double ratio) => Color.lerp(a, target, ratio)!;

/// 相对亮度（WCAG）：决定主色上的文字用白还是深色
double luminanceOf(Color c) {
  double f(double v) => v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) * ((v + 0.055) / 1.055) * 0.947;
  return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
}

Color onPrimaryOf(Color c) => luminanceOf(c) > 0.42 ? const Color(0xFF12262B) : Colors.white;

ThemeData buildTheme(Color primaryHex, Brightness brightness) {
  final dark = brightness == Brightness.dark;
  final main = dark ? mixHex(primaryHex, Colors.white, 0.14) : primaryHex;
  final scheme = ColorScheme.fromSeed(seedColor: primaryHex, brightness: brightness).copyWith(
    primary: main,
    onPrimary: onPrimaryOf(main),
    surface: dark ? const Color(0xFF16201E) : Colors.white,
  );

  return ThemeData(
    useMaterial3: true,
    colorScheme: scheme,
    scaffoldBackgroundColor: dark ? const Color(0xFF0E1514) : const Color(0xFFF4F7F6),
    appBarTheme: AppBarTheme(
      centerTitle: false,
      elevation: 0,
      scrolledUnderElevation: 0.5,
      backgroundColor: dark ? const Color(0xFF0E1514) : const Color(0xFFF4F7F6),
      foregroundColor: dark ? Colors.white : const Color(0xFF101B1A),
      titleTextStyle: TextStyle(
        fontSize: 18,
        fontWeight: FontWeight.w600,
        color: dark ? Colors.white : const Color(0xFF101B1A),
      ),
    ),
    inputDecorationTheme: InputDecorationTheme(
      filled: true,
      fillColor: dark ? const Color(0xFF16201E) : Colors.white,
      contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 16),
      border: _inputBorder(dark, null),
      enabledBorder: _inputBorder(dark, null),
      focusedBorder: _inputBorder(dark, scheme.primary),
    ),
    filledButtonTheme: FilledButtonThemeData(
      style: FilledButton.styleFrom(
        minimumSize: const Size.fromHeight(50),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
        textStyle: const TextStyle(fontSize: 16, fontWeight: FontWeight.w600),
      ),
    ),
    outlinedButtonTheme: OutlinedButtonThemeData(
      style: OutlinedButton.styleFrom(
        minimumSize: const Size.fromHeight(48),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
      ),
    ),
    snackBarTheme: SnackBarThemeData(
      behavior: SnackBarBehavior.floating,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
    ),
    dividerTheme: DividerThemeData(
      color: dark ? const Color(0xFF26332F) : const Color(0xFFE6ECEB),
      thickness: 1,
      space: 1,
    ),
    bottomNavigationBarTheme: BottomNavigationBarThemeData(
      backgroundColor: dark ? const Color(0xFF16201E) : Colors.white,
      selectedItemColor: main,
      unselectedItemColor: const Color(0xFF9AA8AE),
      type: BottomNavigationBarType.fixed,
      showUnselectedLabels: true,
    ),
  );
}

OutlineInputBorder _inputBorder(bool dark, Color? focus) => OutlineInputBorder(
      borderRadius: BorderRadius.circular(14),
      borderSide: BorderSide(
        color: focus ?? (dark ? const Color(0xFF26332F) : const Color(0xFFE6ECEB)),
        width: focus == null ? 1 : 1.6,
      ),
    );

/// 卡片统一外观
class PgCard extends StatelessWidget {
  const PgCard({
    super.key,
    required this.child,
    this.padding = const EdgeInsets.all(16),
    this.onTap,
  });

  final Widget child;
  final EdgeInsets padding;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final dark = Theme.of(context).brightness == Brightness.dark;
    final body = Container(
      padding: padding,
      decoration: BoxDecoration(
        color: dark ? const Color(0xFF16201E) : Colors.white,
        borderRadius: BorderRadius.circular(18),
        border: Border.all(color: dark ? const Color(0xFF26332F) : const Color(0xFFE6ECEB)),
      ),
      child: child,
    );
    if (onTap == null) return body;
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(18),
      child: body,
    );
  }
}

/// 状态色：绿=好、橙=等、红=坏、灰=中性
Color statusColor(String kind) {
  switch (kind) {
    case 'success':
      return const Color(0xFF1E8E3E);
    case 'primary':
      return const Color(0xFF0C8B80);
    case 'info':
      return const Color(0xFF2F6FED);
    case 'warning':
      return pgWarn;
    case 'danger':
      return pgDanger;
    default:
      return const Color(0xFF8A9C9A);
  }
}

/// 状态标签
class StatusTag extends StatelessWidget {
  const StatusTag({super.key, required this.text, required this.kind});

  final String text;
  final String kind;

  @override
  Widget build(BuildContext context) {
    final c = statusColor(kind);
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 3),
      decoration: BoxDecoration(
        color: c.withValues(alpha: 0.12),
        borderRadius: BorderRadius.circular(20),
      ),
      child: Text(text, style: TextStyle(fontSize: 12, color: c, fontWeight: FontWeight.w600)),
    );
  }
}
