import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:http/http.dart' as http;

import 'models.dart';
import 'store.dart';

class ApiException implements Exception {
  ApiException(this.message, {this.status = 0, this.code = ''});

  final String message;
  final int status;
  final String code;

  bool get unauthorized => status == 401 || status == 403;
  bool get notApproved => code == 'NOT_APPROVED';

  @override
  String toString() => message;
}

/// `/api/mp/me` 一起返回的用户与配置
class MeResult {
  MeResult(this.user, this.config);

  final PgUser user;
  final Map<String, dynamic> config;

  int get maxCopies => _int(config['maxCopies'], 99);
  int get maxFileMB => _int(config['maxFileMB'], 20);
  int get maxPages => _int(config['maxPages'], 50);
  bool get approveEachJob => config['approveEachJob'] == true;
  bool get advancedPrint => config['advancedPrint'] != false;

  static int _int(Object? v, int fallback) {
    if (v is int) return v;
    if (v is num) return v.toInt();
    return int.tryParse('${v ?? ''}') ?? fallback;
  }
}

/// 与小程序 `services/api.js` 一一对应的接口集合。后端零改动。
class Api {
  Api({String? baseUrl, String? token})
      : baseUrl = (baseUrl ?? Store.baseUrl).replaceAll(RegExp(r'/+$'), ''),
        token = token ?? Store.token;

  final String baseUrl;
  final String token;

  static const _timeout = Duration(seconds: 30);
  static const _uploadTimeout = Duration(minutes: 5);
  static const chunkLimit = 8 * 1024 * 1024;

  Map<String, String> get authHeaders => {
        'Accept': 'application/json',
        if (token.isNotEmpty) 'Authorization': 'Bearer $token',
      };

  Uri _u(String path, [Map<String, Object?>? query]) {
    final uri = Uri.parse('$baseUrl$path');
    if (query == null || query.isEmpty) return uri;
    final q = <String, String>{};
    query.forEach((k, v) {
      if (v != null && '$v'.isNotEmpty) q[k] = '$v';
    });
    return q.isEmpty ? uri : uri.replace(queryParameters: q);
  }

  // ---------- 基础 ----------
  Future<Map<String, dynamic>> _send(
    String method,
    String path, {
    Map<String, Object?>? body,
    Map<String, Object?>? query,
  }) async {
    if (baseUrl.isEmpty) throw ApiException('还没设置服务器地址');
    final uri = _u(path, query);
    final headers = <String, String>{
      ...authHeaders,
      if (body != null) 'Content-Type': 'application/json; charset=utf-8',
    };
    final payload = body == null ? null : jsonEncode(body);

    http.Response res;
    try {
      switch (method) {
        case 'GET':
          res = await http.get(uri, headers: headers).timeout(_timeout);
          break;
        case 'POST':
          res = await http.post(uri, headers: headers, body: payload).timeout(_timeout);
          break;
        case 'PUT':
          res = await http.put(uri, headers: headers, body: payload).timeout(_timeout);
          break;
        case 'DELETE':
          res = await http.delete(uri, headers: headers, body: payload).timeout(_timeout);
          break;
        default:
          throw ApiException('不支持的方法 $method');
      }
    } on SocketException {
      throw ApiException('连不上服务器，请检查地址和网络');
    } on TimeoutException {
      throw ApiException('服务器响应超时，请稍后重试');
    } on HandshakeException {
      throw ApiException('HTTPS 握手失败，内网请用 http 地址');
    } on http.ClientException catch (e) {
      throw ApiException('网络异常：${e.message}');
    }
    return _parse(res);
  }

  Map<String, dynamic> _parse(http.Response res) {
    final text = utf8.decode(res.bodyBytes, allowMalformed: true);
    Map<String, dynamic> data = const {};
    if (text.isNotEmpty) {
      try {
        final decoded = jsonDecode(text);
        if (decoded is Map<String, dynamic>) data = decoded;
      } catch (_) {}
    }
    final ok = data['ok'] != false && res.statusCode < 400;
    if (!ok) {
      throw ApiException(
        (data['msg']?.toString().isNotEmpty ?? false) ? data['msg'].toString() : '请求失败（HTTP ${res.statusCode}）',
        status: res.statusCode,
        code: data['code']?.toString() ?? '',
      );
    }
    return data;
  }

  // ---------- 探活 / 版本 ----------
  Future<Map<String, dynamic>> health() => _send('GET', '/api/health');
  Future<Map<String, dynamic>> serverVersion() => _send('GET', '/api/mp/version');

  // ---------- 会话 ----------
  Future<Map<String, dynamic>> login(String username, String password) =>
      _send('POST', '/api/auth/account/login', body: {'username': username, 'password': password});

  Future<MeResult> me() async {
    final d = await _send('GET', '/api/mp/me');
    return MeResult(
      PgUser.fromJson(_map(d['user'])),
      _map(d['config']),
    );
  }

  Future<void> changePassword(String oldPassword, String newPassword) => _send(
        'POST',
        '/api/auth/account/password',
        body: {'oldPassword': oldPassword, 'newPassword': newPassword},
      );

  /// 保存资料（昵称必填，其余可空）
  Future<PgUser> saveProfile(Map<String, Object?> profile) async {
    final d = await _send('PUT', '/api/mp/profile', body: profile);
    return PgUser.fromJson(_map(d['user']));
  }

  Future<PgUser> uploadAvatar(String filePath) async {
    final req = http.MultipartRequest('POST', _u('/api/mp/avatar'));
    req.headers.addAll(authHeaders);
    req.files.add(await http.MultipartFile.fromPath('avatar', filePath, filename: 'avatar.jpg'));
    final res = await http.Response.fromStream(await req.send().timeout(_uploadTimeout));
    final d = _parse(res);
    final u = d['user'];
    return u is Map ? PgUser.fromJson(Map<String, dynamic>.from(u)) : PgUser.empty();
  }

  // ---------- 绑定 / 扫码 ----------
  Future<Map<String, dynamic>> bindAdmin(String bindToken) =>
      _send('POST', '/api/mp/bind', body: {'token': bindToken});

  Future<Map<String, dynamic>> bindUser(String ticket) =>
      _send('POST', '/api/mp/bind-user', body: {'ticket': ticket});

  Future<void> qrScan(String ticket) => _send('POST', '/api/mp/qr/scan', body: {'ticket': ticket});

  Future<void> qrConfirm(String ticket) => _send('POST', '/api/mp/qr/confirm', body: {'ticket': ticket});

  // ---------- 打印机 ----------
  Future<({List<PgPrinter> list, String def})> printers() async {
    final d = await _send('GET', '/api/mp/printers');
    final list = d['printers'];
    return (
      list: list is List
          ? list.whereType<Map>().map((e) => PgPrinter.fromJson(Map<String, dynamic>.from(e))).toList()
          : <PgPrinter>[],
      def: d['default']?.toString() ?? '',
    );
  }

  // ---------- 文件 ----------
  Future<List<PgFileItem>> files() async {
    final d = await _send('GET', '/api/mp/files');
    final list = d['files'];
    if (list is! List) return const [];
    return list.whereType<Map>().map((e) => PgFileItem.fromJson(Map<String, dynamic>.from(e))).toList();
  }

  Future<void> deleteFile(int id) => _send('DELETE', '/api/mp/files/$id');

  /// 上传：≤8MB 直传，超过走分片（与小程序同一套阈值，服务端接口相同）
  Future<PgFileItem> upload(String path, String filename, {void Function(int)? onProgress}) async {
    final file = File(path);
    final size = await file.length();
    if (size > chunkLimit) return _uploadChunked(file, filename, size, onProgress);
    return _uploadDirect(file, filename, onProgress);
  }

  Future<PgFileItem> _uploadDirect(File file, String filename, void Function(int)? onProgress) async {
    if (baseUrl.isEmpty) throw ApiException('还没设置服务器地址');
    final req = http.MultipartRequest('POST', _u('/api/mp/files'));
    req.headers.addAll(authHeaders);
    req.fields['filename'] = filename;
    req.files.add(await http.MultipartFile.fromPath('file', file.path, filename: filename));

    http.Response res;
    try {
      final streamed = await req.send().timeout(_uploadTimeout);
      onProgress?.call(100);
      res = await http.Response.fromStream(streamed);
    } on SocketException {
      throw ApiException('上传失败：连不上服务器');
    } on TimeoutException {
      throw ApiException('上传超时，文件可能太大');
    }
    final d = _parse(res);
    return _fileOf(d);
  }

  Future<PgFileItem> _uploadChunked(File file, String filename, int size, void Function(int)? onProgress) async {
    final init = await _send('POST', '/api/mp/upload/init', body: {
      'filename': filename,
      'size': size,
      'mime': _mimeOf(filename),
    });
    final uploadId = init['uploadId']?.toString() ?? '';
    final chunkSize = (init['chunkSize'] as num?)?.toInt() ?? 4 * 1024 * 1024;
    final total = (init['total'] as num?)?.toInt() ?? 1;
    if (uploadId.isEmpty) throw ApiException('分片上传初始化失败');

    final raf = await file.open();
    try {
      for (var i = 0; i < total; i++) {
        final start = i * chunkSize;
        final len = (size - start) < chunkSize ? (size - start) : chunkSize;
        await raf.setPosition(start);
        final bytes = await raf.read(len);
        final req = http.MultipartRequest('POST', _u('/api/mp/upload/chunk'));
        req.headers.addAll(authHeaders);
        req.fields['uploadId'] = uploadId;
        req.fields['index'] = '$i';
        req.files.add(http.MultipartFile.fromBytes('chunk', bytes, filename: 'chunk.part'));
        final res = await http.Response.fromStream(await req.send().timeout(_uploadTimeout));
        _parse(res);
        onProgress?.call(((i + 1) / total * 100).round());
      }
    } catch (e) {
      // 失败要把服务端会话清掉，否则临时目录会堆垃圾
      try {
        await _send('DELETE', '/api/mp/upload/$uploadId');
      } catch (_) {}
      rethrow;
    } finally {
      await raf.close();
    }

    final done = await _send('POST', '/api/mp/upload/complete', body: {'uploadId': uploadId});
    return _fileOf(done);
  }

  Future<PgFileItem> mergeImages(List<int> ids, String filename) async {
    final d = await _send('POST', '/api/mp/files/merge', body: {'ids': ids, 'filename': filename});
    return _fileOf(d);
  }

  String previewUrl(int fileId, {int page = 1}) => '$baseUrl/api/mp/files/$fileId/preview?page=$page';

  /// 下载预览图到本地临时文件（多页 PDF 靠 ?page=N 翻页）
  Future<File> downloadPreview(int fileId, int page) async {
    final res = await http.get(_u('/api/mp/files/$fileId/preview', {'page': page}), headers: authHeaders).timeout(_timeout);
    if (res.statusCode >= 400) {
      String msg = '预览失败（HTTP ${res.statusCode}）';
      try {
        final d = jsonDecode(utf8.decode(res.bodyBytes));
        if (d is Map && d['msg'] != null) msg = d['msg'].toString();
      } catch (_) {}
      throw ApiException(msg, status: res.statusCode);
    }
    final dir = Directory.systemTemp.createTempSync('pg_prev');
    final ext = _extFromContentType(res.headers['content-type']);
    final f = File('${dir.path}/preview.$ext');
    await f.writeAsBytes(res.bodyBytes);
    return f;
  }

  // ---------- 打印任务 ----------
  Future<Map<String, dynamic>> print(int fileId, String printer, Map<String, Object?> options) =>
      _send('POST', '/api/mp/print', body: {'fileId': fileId, 'printer': printer, 'options': options});

  Future<List<PgTask>> tasks() async {
    final d = await _send('GET', '/api/mp/tasks');
    final list = d['tasks'];
    if (list is! List) return const [];
    return list.whereType<Map>().map((e) => PgTask.fromJson(Map<String, dynamic>.from(e))).toList();
  }

  Future<void> cancelTask(int id) => _send('POST', '/api/mp/tasks/$id/cancel');

  // ---------- 管理台 ----------
  Future<Map<String, dynamic>> adminOverview() async {
    final d = await _send('GET', '/api/mp/admin/overview');
    final ov = _map(d['overview']);
    final printers = d['printers'];
    return {
      'overview': ov,
      'printers': printers is List ? printers.whereType<Map>().map((e) => Map<String, dynamic>.from(e)).toList() : <Map<String, dynamic>>[],
    };
  }

  Future<List<PgUser>> adminUsers({String status = 'all', String q = ''}) async {
    final d = await _send('GET', '/api/mp/admin/users', query: {'status': status, 'q': q});
    final list = d['users'];
    if (list is! List) return const [];
    return list.whereType<Map>().map((e) => PgUser.fromJson(Map<String, dynamic>.from(e))).toList();
  }

  Future<void> adminUserAction(int id, String action) => _send('POST', '/api/mp/admin/users/$id/$action');

  Future<List<PgTask>> adminTasks({String status = 'pending'}) async {
    final d = await _send('GET', '/api/mp/admin/tasks', query: {'status': status});
    final list = d['tasks'];
    if (list is! List) return const [];
    return list.whereType<Map>().map((e) => PgTask.fromJson(Map<String, dynamic>.from(e))).toList();
  }

  Future<void> adminTaskAction(int id, String action) => _send('POST', '/api/mp/admin/tasks/$id/$action');

  Future<Map<String, dynamic>> adminTaskCleanup({String? status}) =>
      _send('POST', '/api/mp/admin/tasks/cleanup', body: status == null ? {} : {'status': status});

  Future<List<PgPrinter>> adminPrinters() async {
    final d = await _send('GET', '/api/mp/admin/printers');
    final list = d['printers'];
    if (list is! List) return const [];
    return list.whereType<Map>().map((e) => PgPrinter.fromJson(Map<String, dynamic>.from(e))).toList();
  }

  Future<void> adminPrinterAction(String name, String action) =>
      _send('POST', '/api/mp/admin/printers/${Uri.encodeComponent(name)}/$action');

  Future<({Map<String, dynamic> settings, List<String> printers, List<String> schema})> adminSettings() async {
    final d = await _send('GET', '/api/mp/admin/settings');
    final printers = d['printers'];
    final schema = d['schema'];
    return (
      settings: _map(d['settings']),
      printers: printers is List ? printers.map((e) => '$e').toList() : <String>[],
      schema: schema is List ? schema.map((e) => '$e').toList() : <String>[],
    );
  }

  Future<void> adminSaveSettings(Map<String, Object?> patch) =>
      _send('PUT', '/api/mp/admin/settings', body: patch);

  // ---------- 完整后台（admin scope，需要后台管理密码换令牌） ----------
  /// 用后台管理密码换 admin 令牌；与用户令牌分开保存，只活在本会话里
  Future<String> adminLogin(String password) async {
    final d = await _send('POST', '/api/auth/login', body: {'password': password});
    final t = d['token']?.toString() ?? '';
    if (t.isEmpty) throw ApiException('后台登录失败：没拿到令牌');
    return t;
  }

  /// 后台全量设置（key 由后端决定，App 端动态渲染，不用跟着发版）
  Future<Map<String, dynamic>> fullSettings() => _send('GET', '/api/settings');

  Future<void> saveFullSettings(Map<String, Object?> patch) => _send('PUT', '/api/settings', body: patch);

  Future<Map<String, dynamic>> officeStatus() => _send('GET', '/api/settings/office/status');

  Future<Map<String, dynamic>> officeInstall() => _send('POST', '/api/settings/office/install');

  // ---------- 小工具 ----------
  PgFileItem _fileOf(Map<String, dynamic> d) {
    final f = d['file'];
    if (f is! Map) throw ApiException('服务端没返回文件信息');
    return PgFileItem.fromJson(Map<String, dynamic>.from(f));
  }

  static Map<String, dynamic> _map(Object? v) =>
      v is Map ? Map<String, dynamic>.from(v) : <String, dynamic>{};

  static String _mimeOf(String name) {
    switch (name.split('.').last.toLowerCase()) {
      case 'pdf':
        return 'application/pdf';
      case 'png':
        return 'image/png';
      case 'jpg':
      case 'jpeg':
        return 'image/jpeg';
      case 'doc':
        return 'application/msword';
      case 'docx':
        return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
      default:
        return 'application/octet-stream';
    }
  }

  static String _extFromContentType(String? ct) {
    final v = (ct ?? '').toLowerCase();
    if (v.contains('jpeg') || v.contains('jpg')) return 'jpg';
    if (v.contains('png')) return 'png';
    if (v.contains('gif')) return 'gif';
    if (v.contains('webp')) return 'webp';
    return 'png';
  }
}
