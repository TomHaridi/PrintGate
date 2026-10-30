import 'package:flutter/material.dart';
import 'package:image_picker/image_picker.dart';

import '../core/api.dart';
import '../core/app_state.dart';
import '../core/format.dart';
import '../core/models.dart';
import '../theme.dart';
import '../widgets/scan_page.dart';
import '../widgets/server_sheet.dart';
import '../widgets/theme_sheet.dart';
import 'admin/admin_home.dart';
import 'login_page.dart';

/// 我的：资料 / 头像 / 绑定 / 扫码 / 服务地址 / 主题 / 关于 / 退出
class MeTab extends StatefulWidget {
  const MeTab({super.key, required this.onRefreshAll});

  final Future<void> Function() onRefreshAll;

  @override
  State<MeTab> createState() => _MeTabState();
}

class _MeTabState extends State<MeTab> {
  String _version = '';
  bool _uploadingAvatar = false;

  @override
  void initState() {
    super.initState();
    _loadVersion();
  }

  Future<void> _loadVersion() async {
    try {
      final d = await Api().serverVersion();
      if (!mounted) return;
      setState(() => _version = d['version']?.toString() ?? '');
    } on ApiException {
      // 版本号拿不到不影响使用
    }
  }

  void _toast(String msg) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(msg)));
  }

  String _avatarUrl(PgUser u, String base) {
    final a = u.avatar;
    if (a.isEmpty) return '';
    if (a.startsWith('http://') || a.startsWith('https://')) return a;
    return '$base${a.startsWith('/') ? '' : '/'}$a';
  }

  // ---------- 头像 ----------
  Future<void> _changeAvatar() async {
    if (_uploadingAvatar) return;
    final picked = await ImagePicker().pickImage(source: ImageSource.gallery, imageQuality: 85);
    if (picked == null) return;
    setState(() => _uploadingAvatar = true);
    final ctl = AppScope.read(context);
    try {
      final u = await Api().uploadAvatar(picked.path);
      if (u.id > 0) await ctl.applyUser(u);
      _toast('头像已更新');
    } on ApiException catch (e) {
      _toast(e.message);
    } finally {
      if (mounted) setState(() => _uploadingAvatar = false);
    }
  }

  // ---------- 资料 ----------
  Future<void> _editProfile(PgUser u) async {
    final ctrls = {
      'nickname': TextEditingController(text: u.nickname),
      'wechat_id': TextEditingController(text: u.wechatId),
      'phone': TextEditingController(text: u.phone),
      'real_name': TextEditingController(text: u.realName),
      'apply_note': TextEditingController(text: u.applyNote),
    };
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('编辑资料'),
        content: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              for (final e in const [
                ('nickname', '昵称（必填）'),
                ('real_name', '真实姓名'),
                ('wechat_id', '微信号'),
                ('phone', '手机号'),
                ('apply_note', '申请说明'),
              ])
                Padding(
                  padding: const EdgeInsets.only(bottom: 10),
                  child: TextField(
                    controller: ctrls[e.$1],
                    decoration: InputDecoration(labelText: e.$2, isDense: true),
                  ),
                ),
            ],
          ),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('取消')),
          TextButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('保存')),
        ],
      ),
    );
    if (ok != true) return;
    if (ctrls['nickname']!.text.trim().isEmpty) {
      _toast('请填写昵称');
      return;
    }
    try {
      final nu = await Api().saveProfile({
        'nickname': ctrls['nickname']!.text.trim(),
        'wechat_id': ctrls['wechat_id']!.text.trim(),
        'phone': ctrls['phone']!.text.trim(),
        'real_name': ctrls['real_name']!.text.trim(),
        'apply_note': ctrls['apply_note']!.text.trim(),
      });
      await AppScope.read(context).applyUser(nu);
      _toast('资料已保存');
    } on ApiException catch (e) {
      _toast(e.message);
    }
  }

  // ---------- 绑定管理员 ----------
  Future<void> _bindAdmin() async {
    final ctrl = TextEditingController();
    String? scanned;
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => StatefulBuilder(
        builder: (ctx, setLocal) => AlertDialog(
          title: const Text('绑定管理员'),
          content: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Text(
                '在网页后台「微信对接」页生成绑定码，填到这里即可把当前账号绑成管理员。',
                style: TextStyle(fontSize: 12.5, color: Theme.of(ctx).colorScheme.onSurfaceVariant),
              ),
              const SizedBox(height: 12),
              TextField(
                controller: ctrl,
                decoration: InputDecoration(
                  labelText: '绑定码',
                  isDense: true,
                  suffixIcon: IconButton(
                    icon: const Icon(Icons.qr_code_scanner_rounded),
                    onPressed: () async {
                      final r = await ScanPage.open(ctx, hint: '扫后台的绑定二维码');
                      if (r != null) {
                        setLocal(() {
                          scanned = r;
                          ctrl.text = _extractToken(r) ?? r;
                        });
                      }
                    },
                  ),
                ),
              ),
              if (scanned != null)
                Padding(
                  padding: const EdgeInsets.only(top: 6),
                  child: Text('已扫码填入', style: TextStyle(fontSize: 12, color: Theme.of(ctx).colorScheme.primary)),
                ),
            ],
          ),
          actions: [
            TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('取消')),
            TextButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('绑定')),
          ],
        ),
      ),
    );
    if (ok != true) return;
    final token = ctrl.text.trim();
    if (token.isEmpty) {
      _toast('请输入绑定码');
      return;
    }
    try {
      final d = await Api().bindAdmin(token);
      final u = await AppScope.read(context).refreshUser();
      if (u != null) _toast('绑定成功');
      widget.onRefreshAll();
      if (d['msg'] != null) _toast(d['msg'].toString());
    } on ApiException catch (e) {
      _toast(e.message);
    }
  }

  /// 二维码可能包在 URL 里（?token= / ?ticket=），把参数抠出来
  String? _extractToken(String raw) {
    final m = RegExp(r'[?&](?:token|ticket)=([^&]+)').firstMatch(raw);
    return m == null ? null : Uri.decodeComponent(m.group(1)!);
  }

  // ---------- 扫码绑定账号 ----------
  Future<void> _scanBindAccount() async {
    final raw = await ScanPage.open(context, hint: '扫后台为用户生成的绑定二维码');
    if (raw == null) return;
    final ticket = _extractToken(raw) ?? raw;
    try {
      final d = await Api().bindUser(ticket);
      final token = d['token']?.toString() ?? '';
      final ctl = AppScope.read(context);
      if (token.isNotEmpty) await ctl.setToken(token);
      await ctl.refreshUser();
      _toast(d['msg']?.toString() ?? '绑定成功');
      widget.onRefreshAll();
    } on ApiException catch (e) {
      _toast(e.message);
    }
  }

  // ---------- 扫码登录网页后台 ----------
  Future<void> _scanLoginWeb() async {
    final raw = await ScanPage.open(context, hint: '扫网页登录页的二维码');
    if (raw == null) return;
    final ticket = _extractToken(raw) ?? raw;
    try {
      await Api().qrScan(ticket);
      if (!mounted) return;
      final ok = await showDialog<bool>(
        context: context,
        builder: (ctx) => AlertDialog(
          title: const Text('确认登录'),
          content: const Text('确认在网页后台登录？确认后网页会自动登录。'),
          actions: [
            TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('取消')),
            TextButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('确认登录')),
          ],
        ),
      );
      if (ok != true) return;
      await Api().qrConfirm(ticket);
      _toast('已确认，网页将自动登录');
    } on ApiException catch (e) {
      _toast(e.message);
    }
  }

  Future<void> _logout() async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('退出登录'),
        content: const Text('退出后需要重新登录，继续吗？'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('取消')),
          TextButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('退出')),
        ],
      ),
    );
    if (ok != true) return;
    await AppScope.read(context).logout();
    if (!mounted) return;
    Navigator.of(context).pushAndRemoveUntil(MaterialPageRoute(builder: (_) => const LoginPage()), (_) => false);
  }

  void _about() {
    showAboutDialog(
      context: context,
      applicationName: 'PrintGate',
      applicationVersion: _version.isEmpty ? '—' : _version,
      applicationIcon: ClipRRect(
        borderRadius: BorderRadius.circular(12),
        child: Image.asset('assets/logo.png', width: 44, height: 44, fit: BoxFit.cover),
      ),
      children: const [
        Text('CUPS 打印网关 · iOS 客户端', style: TextStyle(fontSize: 13)),
        SizedBox(height: 6),
        Text('与微信小程序共用同一套账号与打印接口，数据实时同步。', style: TextStyle(fontSize: 12.5)),
      ],
    );
  }

  @override
  Widget build(BuildContext context) {
    final ctl = AppScope.of(context);
    final u = ctl.user ?? PgUser.empty();
    final scheme = Theme.of(context).colorScheme;
    final st = Fmt.userStatus(u.status);

    return ListView(
      padding: const EdgeInsets.fromLTRB(16, 12, 16, 28),
      children: [
        PgCard(
          onTap: () => _editProfile(u),
          child: Row(
            children: [
              GestureDetector(
                onTap: _changeAvatar,
                child: Stack(
                  children: [
                    CircleAvatar(
                      radius: 29,
                      backgroundColor: scheme.primary.withValues(alpha: 0.12),
                      backgroundImage: _avatarUrl(u, ctl.baseUrl).isEmpty
                          ? null
                          : NetworkImage(_avatarUrl(u, ctl.baseUrl)),
                      child: _avatarUrl(u, ctl.baseUrl).isEmpty
                          ? Icon(Icons.person_rounded, size: 30, color: scheme.primary)
                          : null,
                    ),
                    Positioned(
                      right: 0,
                      bottom: 0,
                      child: Container(
                        padding: const EdgeInsets.all(3),
                        decoration: BoxDecoration(color: scheme.primary, shape: BoxShape.circle),
                        child: const Icon(Icons.camera_alt_rounded, size: 11, color: Colors.white),
                      ),
                    ),
                  ],
                ),
              ),
              const SizedBox(width: 14),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      children: [
                        Flexible(
                          child: Text(
                            u.displayName,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: const TextStyle(fontSize: 17, fontWeight: FontWeight.w600),
                          ),
                        ),
                        const SizedBox(width: 8),
                        StatusTag(text: st.text, kind: st.kind),
                        if (u.isAdmin) ...[
                          const SizedBox(width: 6),
                          const StatusTag(text: '管理员', kind: 'info'),
                        ],
                      ],
                    ),
                    const SizedBox(height: 4),
                    Text(
                      u.username.isEmpty ? (u.profileDone ? '资料已填写' : '点这里完善资料') : '账号：${u.username}',
                      style: TextStyle(fontSize: 12.5, color: scheme.onSurfaceVariant),
                    ),
                  ],
                ),
              ),
              IconButton(
                tooltip: '刷新',
                onPressed: () async {
                  try {
                    await ctl.refreshUser();
                  } on ApiException catch (e) {
                    _toast(e.message);
                  }
                },
                icon: const Icon(Icons.refresh_rounded),
              ),
            ],
          ),
        ),
        if (u.pending) ...[
          const SizedBox(height: 12),
          Container(
            padding: const EdgeInsets.all(12),
            decoration: BoxDecoration(
              color: const Color(0xFFFFF7E6),
              borderRadius: BorderRadius.circular(12),
              border: Border.all(color: const Color(0xFFFFE0A3)),
            ),
            child: const Row(
              children: [
                Icon(Icons.hourglass_top_rounded, size: 16, color: pgWarn),
                SizedBox(width: 8),
                Expanded(child: Text('账号待审批：管理员放行后才能上传和打印', style: TextStyle(fontSize: 12.5, color: Color(0xFF6B4A00)))),
              ],
            ),
          ),
        ],
        const SizedBox(height: 12),
        PgCard(
          padding: EdgeInsets.zero,
          child: Column(
            children: [
              _item(Icons.edit_outlined, '编辑资料', onTap: () => _editProfile(u)),
              const Divider(height: 1),
              _item(Icons.verified_user_outlined, '绑定管理员', onTap: _bindAdmin),
              const Divider(height: 1),
              _item(Icons.qr_code_2_rounded, '扫码绑定账号', onTap: _scanBindAccount),
              const Divider(height: 1),
              _item(Icons.login_rounded, '扫码登录网页后台', onTap: _scanLoginWeb),
            ],
          ),
        ),
        const SizedBox(height: 12),
        PgCard(
          padding: EdgeInsets.zero,
          child: Column(
            children: [
              _item(Icons.dns_outlined, '服务器', subtitle: ctl.baseUrl, onTap: () => _openServer(context)),
              const Divider(height: 1),
              _item(
                Icons.palette_outlined,
                '外观',
                subtitle: '${_modeLabel(ctl.themeMode)} · ${ctl.primaryName}',
                onTap: () => ThemeSheet.show(context),
              ),
              if (ctl.isAdmin) ...[
                const Divider(height: 1),
                _item(
                  Icons.admin_panel_settings_outlined,
                  '管理台',
                  subtitle: '用户审批 · 打印机 · 设置',
                  onTap: () => Navigator.of(context).push(MaterialPageRoute(builder: (_) => const AdminHomePage())),
                ),
              ],
              const Divider(height: 1),
              _item(Icons.info_outline, '关于', subtitle: _version.isEmpty ? '' : '服务端 $_version', onTap: _about),
            ],
          ),
        ),
        const SizedBox(height: 20),
        OutlinedButton(
          onPressed: _logout,
          style: OutlinedButton.styleFrom(foregroundColor: pgDanger),
          child: const Text('退出登录'),
        ),
        const SizedBox(height: 18),
        Center(
          child: Text('PrintGate · Flutter 客户端', style: TextStyle(fontSize: 12, color: scheme.onSurfaceVariant)),
        ),
      ],
    );
  }

  String _modeLabel(String mode) {
    switch (mode) {
      case 'light':
        return '浅色';
      case 'dark':
        return '深色';
      default:
        return '跟随系统';
    }
  }

  Widget _item(IconData icon, String title, {String? subtitle, VoidCallback? onTap}) {
    return ListTile(
      leading: Icon(icon),
      title: Text(title, style: const TextStyle(fontSize: 14.5)),
      subtitle: subtitle == null || subtitle.isEmpty
          ? null
          : Text(subtitle, maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 12)),
      trailing: const Icon(Icons.chevron_right_rounded),
      onTap: onTap,
    );
  }

  Future<void> _openServer(BuildContext context) async {
    await ServerSheet.show(
      context,
      onSaved: (_) async {
        await widget.onRefreshAll();
      },
    );
  }
}
