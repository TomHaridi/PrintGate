import 'package:flutter/material.dart';

import '../../core/api.dart';
import '../../core/format.dart';
import '../../core/models.dart';
import '../../theme.dart';

/// 用户管理：状态筛选 + 关键字搜索 + 授权/拒绝/拉黑/解封/删除
class AdminUsersPage extends StatefulWidget {
  const AdminUsersPage({super.key, this.initialStatus = 'all'});

  final String initialStatus;

  @override
  State<AdminUsersPage> createState() => _AdminUsersPageState();
}

class _AdminUsersPageState extends State<AdminUsersPage> {
  static const _filters = [
    (key: 'all', label: '全部'),
    (key: 'pending', label: '待审批'),
    (key: 'approved', label: '已授权'),
    (key: 'rejected', label: '已拒绝'),
    (key: 'blocked', label: '已拉黑'),
  ];

  late String _status = widget.initialStatus;
  final _search = TextEditingController();
  bool _loading = true;
  String _error = '';
  List<PgUser> _users = const [];

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    _search.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = '';
    });
    try {
      final list = await Api().adminUsers(status: _status, q: _search.text.trim());
      if (!mounted) return;
      setState(() {
        _users = list;
        _loading = false;
      });
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() {
        _error = e.message;
        _loading = false;
      });
    }
  }

  Future<void> _action(PgUser u, String action, String label) async {
    final danger = action == 'delete' || action == 'block';
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text('$label用户'),
        content: Text('确定要$label「${u.displayName}」吗？'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('取消')),
          TextButton(
            onPressed: () => Navigator.pop(ctx, true),
            child: Text(label, style: danger ? const TextStyle(color: pgDanger) : null),
          ),
        ],
      ),
    );
    if (ok != true) return;
    try {
      await Api().adminUserAction(u.id, action);
      _load();
    } on ApiException catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(e.message)));
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('用户管理')),
      body: Column(
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 8, 16, 0),
            child: TextField(
              controller: _search,
              textInputAction: TextInputAction.search,
              decoration: InputDecoration(
                hintText: '搜索昵称 / 微信号 / 手机 / 姓名',
                prefixIcon: const Icon(Icons.search_rounded),
                isDense: true,
                suffixIcon: IconButton(icon: const Icon(Icons.refresh_rounded), onPressed: _load),
              ),
              onSubmitted: (_) => _load(),
            ),
          ),
          SizedBox(
            height: 46,
            child: ListView(
              scrollDirection: Axis.horizontal,
              padding: const EdgeInsets.symmetric(horizontal: 12),
              children: [
                for (final f in _filters)
                  Padding(
                    padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 6),
                    child: ChoiceChip(
                      label: Text(f.label, style: const TextStyle(fontSize: 13)),
                      selected: _status == f.key,
                      showCheckmark: false,
                      onSelected: (_) {
                        setState(() => _status = f.key);
                        _load();
                      },
                    ),
                  ),
              ],
            ),
          ),
          Expanded(
            child: _loading
                ? const Center(child: CircularProgressIndicator())
                : _error.isNotEmpty
                    ? Center(
                        child: Column(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            Text(_error),
                            const SizedBox(height: 10),
                            FilledButton.tonal(onPressed: _load, child: const Text('重试')),
                          ],
                        ),
                      )
                    : RefreshIndicator(
                        onRefresh: _load,
                        child: _users.isEmpty
                            ? ListView(children: const [
                                SizedBox(height: 100),
                                Center(child: Text('没有符合条件的用户')),
                              ])
                            : ListView.separated(
                                padding: const EdgeInsets.fromLTRB(16, 4, 16, 24),
                                itemCount: _users.length,
                                separatorBuilder: (_, __) => const SizedBox(height: 10),
                                itemBuilder: (context, i) => _card(_users[i]),
                              ),
                      ),
          ),
        ],
      ),
    );
  }

  Widget _card(PgUser u) {
    final scheme = Theme.of(context).colorScheme;
    final st = Fmt.userStatus(u.status);
    return PgCard(
      padding: const EdgeInsets.all(14),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(
                child: Text(u.displayName, maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontWeight: FontWeight.w600)),
              ),
              StatusTag(text: st.text, kind: st.kind),
              if (u.isAdmin) ...[
                const SizedBox(width: 6),
                const StatusTag(text: '管理员', kind: 'info'),
              ],
            ],
          ),
          const SizedBox(height: 6),
          Text(
            [
              if (u.username.isNotEmpty) '账号 ${u.username}',
              if (u.wechatId.isNotEmpty) '微信 ${u.wechatId}',
              if (u.phone.isNotEmpty) u.phone,
              if (u.realName.isNotEmpty) u.realName,
            ].join(' · '),
            style: TextStyle(fontSize: 12.5, color: scheme.onSurfaceVariant),
          ),
          if (u.applyNote.isNotEmpty) ...[
            const SizedBox(height: 4),
            Text('申请说明：${u.applyNote}', style: TextStyle(fontSize: 12, color: scheme.onSurfaceVariant)),
          ],
          const SizedBox(height: 4),
          Text('注册于 ${Fmt.time(u.createdAt, withYear: true)}', style: TextStyle(fontSize: 11.5, color: scheme.onSurfaceVariant)),
          const SizedBox(height: 8),
          Wrap(
            spacing: 8,
            children: [
              if (u.pending)
                OutlinedButton(
                  onPressed: () => _action(u, 'approve', '授权'),
                  style: _btn(),
                  child: const Text('授权'),
                ),
              if (u.status == 'pending')
                OutlinedButton(onPressed: () => _action(u, 'reject', '拒绝'), style: _btn(), child: const Text('拒绝')),
              if (u.status != 'blocked')
                OutlinedButton(onPressed: () => _action(u, 'block', '拉黑'), style: _btn(), child: const Text('拉黑')),
              if (u.status == 'blocked' || u.status == 'rejected')
                OutlinedButton(onPressed: () => _action(u, 'unblock', '解封'), style: _btn(), child: const Text('解封')),
              OutlinedButton(
                onPressed: () => _action(u, 'delete', '删除'),
                style: _btn(danger: true),
                child: const Text('删除'),
              ),
            ],
          ),
        ],
      ),
    );
  }

  ButtonStyle _btn({bool danger = false}) => OutlinedButton.styleFrom(
        minimumSize: const Size(72, 34),
        padding: const EdgeInsets.symmetric(horizontal: 12),
        foregroundColor: danger ? pgDanger : null,
        visualDensity: VisualDensity.compact,
      );
}
