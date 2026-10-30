import 'package:flutter/material.dart';

import '../core/app_state.dart';
import '../theme.dart';

/// 主题切换面板（重新设计的一套，替换小程序里那种纯列表）：
/// 顶部是实时预览卡，中间三个「手机缩略图」切深浅模式，底部色板选主色。
/// 所有改动**立即生效并持久化**，不需要点确定。
class ThemeSheet extends StatefulWidget {
  const ThemeSheet({super.key});

  static Future<void> show(BuildContext context) {
    return showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      backgroundColor: Colors.transparent,
      builder: (_) => const ThemeSheet(),
    );
  }

  @override
  State<ThemeSheet> createState() => _ThemeSheetState();
}

class _ThemeSheetState extends State<ThemeSheet> {
  final _hexCtrl = TextEditingController();
  bool _hexOpen = false;

  @override
  void dispose() {
    _hexCtrl.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final ctl = AppScope.of(context);
    final dark = Theme.of(context).brightness == Brightness.dark;
    final primary = hexColor(ctl.primary);

    return Container(
      decoration: BoxDecoration(
        color: dark ? const Color(0xFF16201E) : Colors.white,
        borderRadius: const BorderRadius.vertical(top: Radius.circular(24)),
      ),
      child: SafeArea(
        top: false,
        child: SingleChildScrollView(
          padding: const EdgeInsets.fromLTRB(20, 10, 20, 20),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Center(
                child: Container(
                  width: 38,
                  height: 4,
                  decoration: BoxDecoration(
                    color: dark ? const Color(0xFF3A4A47) : const Color(0xFFDCE3E2),
                    borderRadius: BorderRadius.circular(2),
                  ),
                ),
              ),
              const SizedBox(height: 16),
              Row(
                children: [
                  Text('外观', style: TextStyle(fontSize: 19, fontWeight: FontWeight.w700, color: _ink(dark))),
                  const Spacer(),
                  TextButton(
                    onPressed: () async {
                      await ctl.setThemeMode('auto');
                      await ctl.setPrimary(kDefaultPrimary);
                      if (mounted) setState(() {});
                    },
                    child: const Text('恢复默认'),
                  ),
                ],
              ),
              const SizedBox(height: 4),
              _Preview(primary: primary, mode: ctl.themeMode, dark: dark),
              const SizedBox(height: 22),
              Text('模式', style: TextStyle(fontSize: 13, color: _ink2(dark), fontWeight: FontWeight.w600)),
              const SizedBox(height: 10),
              Row(
                children: [
                  for (final m in const [
                    (key: 'auto', label: '跟随系统', icon: Icons.brightness_auto_rounded),
                    (key: 'light', label: '浅色', icon: Icons.light_mode_rounded),
                    (key: 'dark', label: '深色', icon: Icons.dark_mode_rounded),
                  ])
                    Expanded(
                      child: Padding(
                        padding: const EdgeInsets.only(right: 10),
                        child: _ModeCard(
                          label: m.label,
                          icon: m.icon,
                          selected: ctl.themeMode == m.key,
                          primary: primary,
                          dark: dark,
                          onTap: () async {
                            await ctl.setThemeMode(m.key);
                            if (mounted) setState(() {});
                          },
                        ),
                      ),
                    ),
                ],
              ),
              const SizedBox(height: 22),
              Row(
                children: [
                  Text('主题色', style: TextStyle(fontSize: 13, color: _ink2(dark), fontWeight: FontWeight.w600)),
                  const SizedBox(width: 8),
                  Text('${ctl.primaryName} ${ctl.primary}', style: TextStyle(fontSize: 12, color: _ink3(dark))),
                  const Spacer(),
                  TextButton(
                    onPressed: () => setState(() {
                      _hexOpen = !_hexOpen;
                      _hexCtrl.text = ctl.primary;
                    }),
                    style: TextButton.styleFrom(visualDensity: VisualDensity.compact),
                    child: Text(_hexOpen ? '收起' : '自定义'),
                  ),
                ],
              ),
              if (_hexOpen) ...[
                const SizedBox(height: 6),
                Row(
                  children: [
                    Expanded(
                      child: TextField(
                        controller: _hexCtrl,
                        textCapitalization: TextCapitalization.characters,
                        decoration: const InputDecoration(
                          hintText: '#0C8B80',
                          isDense: true,
                          contentPadding: EdgeInsets.symmetric(horizontal: 14, vertical: 12),
                        ),
                        onSubmitted: (v) async {
                          if (!isHexColor(v.trim())) {
                            ScaffoldMessenger.of(context).showSnackBar(
                              const SnackBar(content: Text('色值格式应为 #RRGGBB')),
                            );
                            return;
                          }
                          await ctl.setPrimary(v.trim());
                          if (mounted) setState(() {});
                        },
                      ),
                    ),
                    const SizedBox(width: 10),
                    FilledButton(
                      onPressed: () async {
                        final v = _hexCtrl.text.trim();
                        if (!isHexColor(v)) {
                          ScaffoldMessenger.of(context).showSnackBar(
                            const SnackBar(content: Text('色值格式应为 #RRGGBB')),
                          );
                          return;
                        }
                        await ctl.setPrimary(v);
                        if (mounted) setState(() {});
                      },
                      style: FilledButton.styleFrom(minimumSize: const Size(76, 44)),
                      child: const Text('应用'),
                    ),
                  ],
                ),
              ],
              const SizedBox(height: 12),
              Wrap(
                spacing: 14,
                runSpacing: 14,
                children: [
                  for (final entry in kPrimaryPresets.entries)
                    _Swatch(
                      hex: entry.key,
                      name: entry.value,
                      selected: ctl.primary.toUpperCase() == entry.key.toUpperCase(),
                      onTap: () async {
                        await ctl.setPrimary(entry.key);
                        if (mounted) setState(() {});
                      },
                    ),
                ],
              ),
              const SizedBox(height: 18),
              Text(
                '主题（含主色）会记住，下次打开直接生效。',
                style: TextStyle(fontSize: 12, color: _ink3(dark)),
              ),
            ],
          ),
        ),
      ),
    );
  }

  static Color _ink(bool dark) => dark ? Colors.white : const Color(0xFF101B1A);
  static Color _ink2(bool dark) => dark ? const Color(0xFFB7C7C5) : const Color(0xFF3D5250);
  static Color _ink3(bool dark) => dark ? const Color(0xFF8A9C9A) : const Color(0xFF6B807E);
}

/// 实时预览：一张迷你卡片 + 主按钮 + 状态标签，选色/切模式立刻能看到效果
class _Preview extends StatelessWidget {
  const _Preview({required this.primary, required this.mode, required this.dark});

  final Color primary;
  final String mode;
  final bool dark;

  @override
  Widget build(BuildContext context) {
    final previewDark = mode == 'dark' || (mode == 'auto' && dark);
    final bg = previewDark ? const Color(0xFF0E1514) : const Color(0xFFF4F7F6);
    final ink = previewDark ? Colors.white : const Color(0xFF101B1A);
    final sub = previewDark ? const Color(0xFF8A9C9A) : const Color(0xFF6B807E);
    final shown = previewDark ? mixHex(primary, Colors.white, 0.14) : primary;

    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: bg,
        borderRadius: BorderRadius.circular(18),
        border: Border.all(color: previewDark ? const Color(0xFF26332F) : const Color(0xFFE6ECEB)),
      ),
      child: Row(
        children: [
          Container(
            width: 44,
            height: 44,
            decoration: BoxDecoration(color: shown.withValues(alpha: 0.14), borderRadius: BorderRadius.circular(12)),
            child: Icon(Icons.print_rounded, color: shown, size: 24),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Container(
                  height: 9,
                  width: 120,
                  decoration: BoxDecoration(color: ink.withValues(alpha: 0.85), borderRadius: BorderRadius.circular(5)),
                ),
                const SizedBox(height: 7),
                Container(
                  height: 8,
                  width: 76,
                  decoration: BoxDecoration(color: sub.withValues(alpha: 0.6), borderRadius: BorderRadius.circular(4)),
                ),
              ],
            ),
          ),
          const SizedBox(width: 10),
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
            decoration: BoxDecoration(color: shown, borderRadius: BorderRadius.circular(10)),
            child: Text(
              '打印',
              style: TextStyle(color: onPrimaryOf(shown), fontSize: 13, fontWeight: FontWeight.w600),
            ),
          ),
        ],
      ),
    );
  }
}

class _ModeCard extends StatelessWidget {
  const _ModeCard({
    required this.label,
    required this.icon,
    required this.selected,
    required this.primary,
    required this.dark,
    required this.onTap,
  });

  final String label;
  final IconData icon;
  final bool selected;
  final Color primary;
  final bool dark;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final border = selected ? primary : (dark ? const Color(0xFF2C3A37) : const Color(0xFFE6ECEB));
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(14),
      child: AnimatedContainer(
        duration: const Duration(milliseconds: 160),
        padding: const EdgeInsets.symmetric(vertical: 14),
        decoration: BoxDecoration(
          borderRadius: BorderRadius.circular(14),
          border: Border.all(color: border, width: selected ? 1.8 : 1),
          color: selected ? primary.withValues(alpha: 0.08) : Colors.transparent,
        ),
        child: Column(
          children: [
            Icon(icon, size: 22, color: selected ? primary : (dark ? const Color(0xFF8A9C9A) : const Color(0xFF6B807E))),
            const SizedBox(height: 6),
            Text(
              label,
              style: TextStyle(
                fontSize: 12.5,
                fontWeight: selected ? FontWeight.w600 : FontWeight.w400,
                color: selected ? primary : (dark ? const Color(0xFFB7C7C5) : const Color(0xFF3D5250)),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _Swatch extends StatelessWidget {
  const _Swatch({required this.hex, required this.name, required this.selected, required this.onTap});

  final String hex;
  final String name;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final c = hexColor(hex);
    return GestureDetector(
      onTap: onTap,
      child: Column(
        children: [
          AnimatedContainer(
            duration: const Duration(milliseconds: 160),
            width: 46,
            height: 46,
            decoration: BoxDecoration(
              color: c,
              shape: BoxShape.circle,
              border: Border.all(
                color: selected ? onPrimaryOf(c).withValues(alpha: 0.9) : Colors.transparent,
                width: 2.5,
              ),
              boxShadow: [
                BoxShadow(color: c.withValues(alpha: 0.32), blurRadius: selected ? 14 : 8, offset: const Offset(0, 4)),
              ],
            ),
            child: selected ? Icon(Icons.check_rounded, color: onPrimaryOf(c), size: 22) : null,
          ),
          const SizedBox(height: 6),
          Text(
            name,
            style: TextStyle(
              fontSize: 11.5,
              fontWeight: selected ? FontWeight.w600 : FontWeight.w400,
              color: Theme.of(context).brightness == Brightness.dark
                  ? (selected ? Colors.white : const Color(0xFF8A9C9A))
                  : (selected ? const Color(0xFF101B1A) : const Color(0xFF6B807E)),
            ),
          ),
        ],
      ),
    );
  }
}
