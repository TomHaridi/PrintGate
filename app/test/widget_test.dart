// 冒烟测试：没配服务器时应该停在「填服务器地址」这一步，而不是白屏或崩溃。
// 真正的接口联调放在 tools/ 下的脚本里跑（需要一台真实服务端）。

import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:printgate/main.dart';

void main() {
  testWidgets('没配服务器 → 先进地址页', (WidgetTester tester) async {
    SharedPreferences.setMockInitialValues(<String, Object>{});
    await tester.pumpWidget(const PrintGateApp());
    await tester.pump();

    expect(find.text('PrintGate'), findsWidgets);
    expect(find.text('连接服务器'), findsOneWidget);
  });
}
