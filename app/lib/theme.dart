import 'package:flutter/material.dart';

/// 品牌色与小程序的 H5 版一致（server/mobile/app.css 的 --pg-primary）
const Color pgPrimary = Color(0xFF0C8B80);
const Color pgPrimaryDark = Color(0xFF076D64);
const Color pgPrimarySoft = Color(0xFFE7F5F3);
const Color pgDanger = Color(0xFFC0392B);
const Color pgWarn = Color(0xFFB26A00);

ThemeData buildTheme(Brightness brightness) {
  final dark = brightness == Brightness.dark;
  final scheme = ColorScheme.fromSeed(
    seedColor: pgPrimary,
    brightness: brightness,
  ).copyWith(
    primary: dark ? const Color(0xFF4FD1C5) : pgPrimary,
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
      border: OutlineInputBorder(
        borderRadius: BorderRadius.circular(14),
        borderSide: BorderSide(color: dark ? const Color(0xFF26332F) : const Color(0xFFE6ECEB)),
      ),
      enabledBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(14),
        borderSide: BorderSide(color: dark ? const Color(0xFF26332F) : const Color(0xFFE6ECEB)),
      ),
      focusedBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(14),
        borderSide: BorderSide(color: scheme.primary, width: 1.6),
      ),
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
  );
}

/// 卡片统一用这个，省得每处重复写圆角 + 边框
class PgCard extends StatelessWidget {
  const PgCard({super.key, required this.child, this.padding = const EdgeInsets.all(16)});

  final Widget child;
  final EdgeInsets padding;

  @override
  Widget build(BuildContext context) {
    final dark = Theme.of(context).brightness == Brightness.dark;
    return Container(
      padding: padding,
      decoration: BoxDecoration(
        color: dark ? const Color(0xFF16201E) : Colors.white,
        borderRadius: BorderRadius.circular(18),
        border: Border.all(color: dark ? const Color(0xFF26332F) : const Color(0xFFE6ECEB)),
      ),
      child: child,
    );
  }
}

/// 任务状态 → 颜色（涨红跌绿那套是行情，这里是状态语义：绿=好，橙=等，红=坏）
Color statusColor(String status) {
  switch (status) {
    case 'done':
      return const Color(0xFF1E8E3E);
    case 'printing':
    case 'queued':
      return pgPrimary;
    case 'pending':
      return pgWarn;
    case 'failed':
      return pgDanger;
    case 'canceled':
      return const Color(0xFF8A9C9A);
    default:
      return const Color(0xFF8A9C9A);
  }
}
