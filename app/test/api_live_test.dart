// 联调测试：用真服务端跑一遍客户端的核心接口（登录→上传→合并→文件→记录）。
// 只在设置了 PG_BASE 时才执行，平时 `flutter test` 会跳过，不会因为没服务端而红。
//
//   PG_BASE=http://127.0.0.1:8099 flutter test test/api_live_test.dart
//
// 服务端要求：GUEST_MODE=true（注册即通过审批），否则新用户是 pending 状态，上传会被拒。

import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;

import 'package:printgate/core/api.dart';

const _png = 'C:/pg_rc_ext/Printgate/ios/App/Assets.xcassets/AppIcon.appiconset/icon-60x60@3x.png';

void main() {
  final base = Platform.environment['PG_BASE'] ?? '';
  final skip = base.isEmpty ? '未设置 PG_BASE，跳过联调' : null;

  group('真实服务端联调', () {
    late String token;
    late Api api;

    setUpAll(() async {
      final username = 'pg${DateTime.now().millisecondsSinceEpoch % 1000000}';
      final res = await http.post(
        Uri.parse('$base/api/auth/account/register'),
        headers: {'Content-Type': 'application/json'},
        body: jsonEncode({'username': username, 'password': 'Live2026test', 'confirm': 'Live2026test'}),
      );
      expect(res.statusCode, 200, reason: '注册失败：${utf8.decode(res.bodyBytes)}');
      final d = jsonDecode(utf8.decode(res.bodyBytes)) as Map<String, dynamic>;
      token = d['token'] as String;
      api = Api(baseUrl: base, token: token);
    });

    test('me 能拿到用户与配置', () async {
      final me = await api.me();
      expect(me.user.id, greaterThan(0));
      expect(me.user.approved, isTrue, reason: '注册后应为 approved（GUEST_MODE=true）');
      expect(me.maxCopies, greaterThan(0));
    });

    test('上传两张图 → 合并成一份多页 PDF', () async {
      if (!File(_png).existsSync()) {
        markTestSkipped('缺少测试图片 $_png');
        return;
      }
      final a = await api.upload(_png, '联调-1.png');
      final b = await api.upload(_png, '联调-2.png');
      expect(a.id, greaterThan(0));
      expect(b.id, greaterThan(0));

      final merged = await api.mergeImages([a.id, b.id], '联调-合并.pdf');
      expect(merged.filename, contains('联调'));
      expect(merged.pages, 2, reason: '两张图应该合成 2 页');

      final list = await api.files();
      expect(list.any((f) => f.id == merged.id), isTrue);
    });

    test('打印机列表与记录列表结构正常', () async {
      final printers = await api.printers();
      // Windows 本机没有 CUPS，列表可能为空 —— 只验证能解析、不抛异常
      expect(printers, isA<List>());

      final tasks = await api.tasks();
      expect(tasks, isA<List>());
    });

    test('没有打印机时提交打印要给出人话错误', () async {
      final printers = await api.printers();
      if (printers.isNotEmpty) {
        markTestSkipped('本机有打印机，跳过这条');
        return;
      }
      final files = await api.files();
      if (files.isEmpty) {
        markTestSkipped('没有文件可打印');
        return;
      }
      try {
        await api.print(files.first.id, '不存在的打印机', {'copies': 1});
        fail('应该报错');
      } on ApiException catch (e) {
        expect(e.message.isNotEmpty, isTrue);
      }
    });
  }, skip: skip);
}
