/// 服务端实体（字段名与 /api/mp/* 的 JSON 一致，少做一层映射）
class PgUser {
  PgUser({
    required this.id,
    required this.nickname,
    required this.username,
    required this.role,
    required this.status,
    required this.phone,
    required this.avatar,
    required this.wechatId,
    required this.realName,
    required this.applyNote,
    required this.createdAt,
    required this.lastLogin,
  });

  final int id;
  final String nickname;
  final String username;
  final String role;
  final String status;
  final String phone;
  final String avatar;
  final String wechatId;
  final String realName;
  final String applyNote;
  final String createdAt;
  final String lastLogin;

  bool get isAdmin => role == 'admin';
  bool get approved => status == 'approved';
  bool get pending => status == 'pending';
  bool get blocked => status == 'blocked';

  String get displayName {
    if (nickname.isNotEmpty) return nickname;
    if (username.isNotEmpty) return username;
    if (realName.isNotEmpty) return realName;
    return '未命名用户';
  }

  /// 资料是否填过（微信号/手机/真实姓名任一）
  bool get profileDone => wechatId.isNotEmpty || phone.isNotEmpty || realName.isNotEmpty;

  static PgUser empty() => PgUser(
        id: 0,
        nickname: '',
        username: '',
        role: 'user',
        status: '',
        phone: '',
        avatar: '',
        wechatId: '',
        realName: '',
        applyNote: '',
        createdAt: '',
        lastLogin: '',
      );

  static PgUser fromJson(Map<String, dynamic> j) => PgUser(
        id: _int(j['id']),
        nickname: _str(j['nickname']),
        username: _str(j['username']),
        role: _str(j['role']),
        status: _str(j['status']),
        phone: _str(j['phone']),
        avatar: _str(j['avatar']),
        wechatId: _str(j['wechat_id']),
        realName: _str(j['real_name']),
        applyNote: _str(j['apply_note']),
        createdAt: _str(j['created_at']),
        lastLogin: _str(j['last_login']),
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
    required this.error,
    required this.options,
    required this.fileAvailable,
    required this.nickname,
    required this.size,
  });

  final int id;
  final String filename;
  final String printer;
  final String status;
  final int copies;
  final int pages;
  final String createdAt;
  final String error;
  final Map<String, dynamic> options;
  final bool fileAvailable;
  final String nickname;
  final int size;

  bool get canCancel => status == 'pending';
  bool get hasError => error.isNotEmpty;

  /// 源文件已被清理时，列表里要显式标出来，否则用户以为还能重打
  String get displayName {
    final base = filename.isEmpty ? '未命名文件' : filename;
    return fileAvailable ? base : '$base（源文件已清理）';
  }

  static PgTask fromJson(Map<String, dynamic> j) => PgTask(
        id: _int(j['id']),
        filename: _str(j['filename']),
        printer: _str(j['printer']),
        status: _str(j['status']),
        copies: _int(j['copies']) == 0 ? 1 : _int(j['copies']),
        pages: _int(j['pages']),
        createdAt: _str(j['created_at']),
        error: _str(j['error']),
        options: j['options'] is Map ? Map<String, dynamic>.from(j['options'] as Map) : <String, dynamic>{},
        fileAvailable: j['file_available'] != false,
        nickname: _str(j['nickname']),
        size: _int(j['size']),
      );
}

class PgPrinter {
  PgPrinter({
    required this.name,
    required this.state,
    required this.isDefault,
    required this.info,
    required this.location,
    required this.accepting,
    required this.model,
  });

  final String name;
  final String state;
  final bool isDefault;
  final String info;
  final String location;
  final bool accepting;
  final String model;

  static PgPrinter fromJson(Map<String, dynamic> j) => PgPrinter(
        name: _str(j['name']),
        state: _str(j['state']),
        isDefault: j['isDefault'] == true,
        info: _str(j['info']),
        location: _str(j['location']),
        accepting: j['accepting'] != false,
        model: _str(j['model']),
      );
}

String _str(Object? v) => v == null ? '' : v.toString();

int _int(Object? v) {
  if (v is int) return v;
  if (v is num) return v.toInt();
  return int.tryParse(_str(v)) ?? 0;
}
