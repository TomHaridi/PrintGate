/// 服务端返回的实体。字段名与 /api/mp/* 的 JSON 一致，少做一层映射，
/// 后端改名时这里会立刻报错，比静默取不到值好排查。
class PgUser {
  PgUser({
    required this.id,
    required this.nickname,
    required this.username,
    required this.role,
    required this.status,
    required this.phone,
    required this.avatar,
  });

  final int id;
  final String nickname;
  final String username;
  final String role;
  final String status;
  final String phone;
  final String avatar;

  bool get isAdmin => role == 'admin';
  bool get approved => status == 'approved';
  bool get pending => status == 'pending';
  bool get blocked => status == 'blocked';

  String get displayName => nickname.isNotEmpty ? nickname : (username.isNotEmpty ? username : '未命名用户');

  static PgUser fromJson(Map<String, dynamic> j) => PgUser(
        id: _int(j['id']),
        nickname: _str(j['nickname']),
        username: _str(j['username']),
        role: _str(j['role']),
        status: _str(j['status']),
        phone: _str(j['phone']),
        avatar: _str(j['avatar']),
      );
}

class PgFileItem {
  PgFileItem({
    required this.id,
    required this.filename,
    required this.size,
    required this.pages,
    required this.createdAt,
  });

  final int id;
  final String filename;
  final int size;
  final int pages;
  final String createdAt;

  String get ext {
    final i = filename.lastIndexOf('.');
    return i < 0 ? '' : filename.substring(i + 1).toLowerCase();
  }

  bool get isImage => const ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif', 'heic', 'heif'].contains(ext);

  String get sizeText {
    if (size <= 0) return '—';
    if (size < 1024) return '$size B';
    if (size < 1024 * 1024) return '${(size / 1024).toStringAsFixed(0)} KB';
    return '${(size / 1024 / 1024).toStringAsFixed(1)} MB';
  }

  static PgFileItem fromJson(Map<String, dynamic> j) => PgFileItem(
        id: _int(j['id']),
        filename: _str(j['filename']),
        size: _int(j['size']),
        pages: _int(j['pages']),
        createdAt: _str(j['created_at']),
      );
}

class PgTask {
  PgTask({
    required this.id,
    required this.filename,
    required this.printer,
    required this.status,
    required this.copies,
    required this.pages,
    required this.createdAt,
    required this.message,
  });

  final int id;
  final String filename;
  final String printer;
  final String status;
  final int copies;
  final int pages;
  final String createdAt;
  final String message;

  /// 状态文案与配色跟小程序/管理后台保持一致
  String get statusText {
    switch (status) {
      case 'pending':
        return '待审批';
      case 'queued':
        return '排队中';
      case 'printing':
        return '打印中';
      case 'done':
        return '已完成';
      case 'failed':
        return '失败';
      case 'canceled':
        return '已取消';
      default:
        return status.isEmpty ? '未知' : status;
    }
  }

  bool get canCancel => status == 'pending';

  static PgTask fromJson(Map<String, dynamic> j) {
    // publicTask 里文件名可能挂在 file 子对象上，两处都兼容
    final fileObj = j['file'];
    var name = _str(j['filename']);
    if (name.isEmpty && fileObj is Map) name = _str(fileObj['filename']);
    return PgTask(
      id: _int(j['id']),
      filename: name,
      printer: _str(j['printer']),
      status: _str(j['status']),
      copies: _int(j['copies']) == 0 ? 1 : _int(j['copies']),
      pages: _int(j['pages']),
      createdAt: _str(j['created_at']),
      message: _str(j['message']),
    );
  }
}

class PgPrinter {
  PgPrinter({
    required this.name,
    required this.state,
    required this.isDefault,
    required this.info,
    required this.location,
    required this.accepting,
  });

  final String name;
  final String state;
  final bool isDefault;
  final String info;
  final String location;
  final bool accepting;

  bool get usable => state == 'idle' || state == 'processing';

  String get stateText {
    if (!accepting) return '已停用';
    switch (state) {
      case 'idle':
        return '就绪';
      case 'processing':
        return '打印中';
      case 'stopped':
        return '已暂停';
      default:
        return state.isEmpty ? '未知' : state;
    }
  }

  static PgPrinter fromJson(Map<String, dynamic> j) => PgPrinter(
        name: _str(j['name']),
        state: _str(j['state']),
        isDefault: j['isDefault'] == true,
        info: _str(j['info']),
        location: _str(j['location']),
        accepting: j['accepting'] != false,
      );
}

String _str(Object? v) => v == null ? '' : v.toString();

int _int(Object? v) {
  if (v is int) return v;
  if (v is num) return v.toInt();
  return int.tryParse(_str(v)) ?? 0;
}
