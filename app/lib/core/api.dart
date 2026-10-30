import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:http/http.dart' as http;

import 'models.dart';
import 'store.dart';

class ApiException implements Exception {
  ApiException(this.message, {this.status = 0});

  final String message;
  final int status;

  /// 令牌失效（过期 / 被踢 / 用户被删）——调用方据此回登录页
  bool get unauthorized => status == 401 || status == 403;

  @override
  String toString() => message;
}

/// 服务端返回体：/api/mp/me 同时带 user 与 config
class MeResult {
  MeResult(this.user, this.config);

  final PgUser user;
  final Map<String, dynamic> config;

  int get maxCopies => _intOf(config['maxCopies'], 99);
  int get maxFileMB => _intOf(config['maxFileMB'], 20);
  bool get approveEachJob => config['approveEachJob'] == true;
  bool get advancedPrint => config['advancedPrint'] != false;

  static int _intOf(Object? v, int fallback) {
    if (v is int) return v;
    if (v is num) return v.toInt();
    return int.tryParse('${v ?? ''}') ?? fallback;
  }
}

/// 所有请求都走这里：相对路径 + Bearer 令牌，与小程序端是同一套接口。
class Api {
  Api({String? baseUrl, String? token})
      : baseUrl = (baseUrl ?? Store.baseUrl).replaceAll(RegExp(r'/+$'), ''),
        token = token ?? Store.token;

  final String baseUrl;
  final String token;

  static const _timeout = Duration(seconds: 20);
  static const _uploadTimeout = Duration(minutes: 3);

  Map<String, String> get authHeaders => {
        'Accept': 'application/json',
        if (token.isNotEmpty) 'Authorization': 'Bearer $token',
      };

  Uri _u(String path, [Map<String, Object?>? query]) {
    final uri = Uri.parse('$baseUrl$path');
    if (query == null || query.isEmpty) return uri;
    final q = <String, String>{};
    query.forEach((k, v) {
      if (v != null) q[k] = '$v';
    });
    return uri.replace(queryParameters: q);
  }

  // ---------- 基础请求 ----------
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
      } catch (_) {
        // 非 JSON（网关错误页 / 空响应）
      }
    }
    final ok = data['ok'] != false && res.statusCode < 400;
    if (!ok) {
      final msg = data['msg']?.toString();
      throw ApiException(
        (msg != null && msg.isNotEmpty) ? msg : '请求失败（HTTP ${res.statusCode}）',
        status: res.statusCode,
      );
    }
    return data;
  }

  // ---------- 探活 ----------
  /// 地址页「测试连接」用：/api/health 是公开接口，能确认对面确实是 PrintGate
  Future<Map<String, dynamic>> health() => _send('GET', '/api/health');

  Future<Map<String, dynamic>> serverVersion() => _send('GET', '/api/mp/version');

  // ---------- 会话 ----------
  /// 账号密码登录：返回的令牌就是小程序令牌（scope=miniapp），能直接调 /api/mp/*
  Future<Map<String, dynamic>> login(String username, String password) =>
      _send('POST', '/api/auth/account/login', body: {'username': username, 'password': password});

  Future<MeResult> me() async {
    final d = await _send('GET', '/api/mp/me');
    final user = d['user'];
    final config = d['config'];
    return MeResult(
      PgUser.fromJson(user is Map ? Map<String, dynamic>.from(user) : const {}),
      config is Map ? Map<String, dynamic>.from(config) : const {},
    );
  }

  Future<void> changePassword(String oldPassword, String newPassword) =>
      _send('POST', '/api/auth/account/password', body: {
        'oldPassword': oldPassword,
        'newPassword': newPassword,
      });

  // ---------- 打印机 ----------
  Future<List<PgPrinter>> printers() async {
    final d = await _send('GET', '/api/mp/printers');
    final list = d['printers'];
    if (list is! List) return const [];
    return list
        .whereType<Map>()
        .map((e) => PgPrinter.fromJson(Map<String, dynamic>.from(e)))
        .toList();
  }

  // ---------- 文件 ----------
  Future<List<PgFileItem>> files() async {
    final d = await _send('GET', '/api/mp/files');
    final list = d['files'];
    if (list is! List) return const [];
    return list
        .whereType<Map>()
        .map((e) => PgFileItem.fromJson(Map<String, dynamic>.from(e)))
        .toList();
  }

  Future<void> deleteFile(int id) => _send('DELETE', '/api/mp/files/$id');

  /// 上传单个文件。filename 一定要带：手机给的临时名是随机串，
  /// 不带的话打印记录里就是 tmp_xxxx，用户根本认不出自己传了什么。
  Future<PgFileItem> upload(String filePath, String filename) async {
    if (baseUrl.isEmpty) throw ApiException('还没设置服务器地址');
    final req = http.MultipartRequest('POST', _u('/api/mp/files'));
    req.headers.addAll(authHeaders);
    req.fields['filename'] = filename;
    req.files.add(await http.MultipartFile.fromPath('file', filePath, filename: filename));

    http.Response res;
    try {
      final streamed = await req.send().timeout(_uploadTimeout);
      res = await http.Response.fromStream(streamed);
    } on SocketException {
      throw ApiException('上传失败：连不上服务器');
    } on TimeoutException {
      throw ApiException('上传超时，文件可能太大，试试压缩后再传');
    }

    final d = _parse(res);
    final f = d['file'];
    if (f is! Map) throw ApiException('服务端没返回文件信息');
    return PgFileItem.fromJson(Map<String, dynamic>.from(f));
  }

  /// 多张图片 → 一份多页 PDF（每张一页），打印记录里是一条「N 页」文档
  Future<PgFileItem> mergeImages(List<int> ids, String? filename) async {
    final d = await _send('POST', '/api/mp/files/merge', body: {
      'ids': ids,
      if (filename != null && filename.isNotEmpty) 'filename': filename,
    });
    final f = d['file'];
    if (f is! Map) throw ApiException('服务端没返回文件信息');
    return PgFileItem.fromJson(Map<String, dynamic>.from(f));
  }

  String previewUrl(int fileId, {int page = 1}) => '$baseUrl/api/mp/files/$fileId/preview?page=$page';

  // ---------- 打印任务 ----------
  Future<List<PgTask>> tasks() async {
    final d = await _send('GET', '/api/mp/tasks');
    final list = d['tasks'];
    if (list is! List) return const [];
    return list
        .whereType<Map>()
        .map((e) => PgTask.fromJson(Map<String, dynamic>.from(e)))
        .toList();
  }

  Future<Map<String, dynamic>> print(int fileId, String printer, Map<String, Object?> options) =>
      _send('POST', '/api/mp/print', body: {
        'fileId': fileId,
        'printer': printer,
        'options': options,
      });

  Future<void> cancelTask(int id) => _send('POST', '/api/mp/tasks/$id/cancel');
}
