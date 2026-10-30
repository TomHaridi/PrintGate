# Flutter 客户端（Windows 写代码 + 云端 mac 打包）

> 一句话：**后端一行不用改**，客户端用 Flutter 写一套，iOS/Android 共用；
> Windows 上写代码 + 本地 `flutter analyze` / `flutter test`，出 IPA 交给 GitHub Actions 或 Codemagic 的 macOS 机器。

## 为什么换成 Flutter

| 方案 | Windows 写代码 | 出 IPA | 依赖后端改动 | 结论 |
|---|---|---|---|---|
| WKWebView 壳加载 `/m/`（`ios/` 目录） | ✅ | 需要 mac 或 CI | 需要 2.4.23 的 `/m` 挂载 | 停用，留作备选 |
| KXBuild（Windows 直接编 ipa） | ✅ | Windows 直接出 | 无 | **暂不可用**：官方目前邀请制，`install.ps1` 只返回「内测中」占位脚本 |
| **Flutter + 云端 mac CI（本目录）** | ✅ | CI 出未签名 IPA | **无** | 采用 |

## 目录

```
app/                      Flutter 工程（本方案主体）
  lib/main.dart           启动分流：没配服务器→地址页；没登录→登录页；否则主界面
  lib/core/store.dart     本地存储（服务器地址 / 令牌）+ 地址归一化（补 http、去尾斜杠）
  lib/core/api.dart       所有接口调用（Bearer 令牌、上传、合并、打印、记录）
  lib/core/models.dart    实体（用户/文件/任务/打印机）
  lib/pages/setup_page.dart    首次填地址，靠 /api/health 校验对面确实是 PrintGate
  lib/pages/login_page.dart    账号密码登录（/api/auth/account/login）
  lib/pages/home_page.dart     四个 Tab 的壳
  lib/pages/print_tab.dart     选图/选 PDF → 上传 → 合并 → 参数 → 提交
  lib/pages/files_tab.dart     我的文件（打印 / 左滑删除）
  lib/pages/history_tab.dart   打印记录（状态、取消待审批）
  lib/pages/me_tab.dart        个人信息、换服务器、改密码、退出
  test/widget_test.dart        冒烟测试（不需要服务端）
  test/api_live_test.dart      联调测试（需要一台真服务端，PG_BASE 指定）
  ios/ android/            flutter create 生成的原生壳（已配好包名/权限/ATS）
codemagic.yaml             Codemagic 云端构建配置（mac_mini_m2，免费额度 500 分钟/月）
.github/workflows/flutter-ios.yml   GitHub Actions macOS runner 构建（免费/public 仓库不限）
```

## 与后端的关系（重要）

客户端**只用现有接口**，后端零改动：

| 用途 | 接口 |
|---|---|
| 探活 / 校验地址 | `GET /api/health`（公开） |
| 登录 | `POST /api/auth/account/login` → 返回的令牌与小程序同权 |
| 用户与配置 | `GET /api/mp/me`（含 maxCopies / approveEachJob / advancedPrint） |
| 打印机 | `GET /api/mp/printers` |
| 上传 | `POST /api/mp/files`（multipart 字段名 `file`，另带 `filename` 保留展示名） |
| 多图合成 | `POST /api/mp/files/merge`（`{ids, filename}`，服务端拼成多页 PDF） |
| 文件列表 / 删除 | `GET /api/mp/files`、`DELETE /api/mp/files/:id` |
| 提交打印 | `POST /api/mp/print`（`{fileId, printer, options}`） |
| 记录 / 取消 | `GET /api/mp/tasks`、`POST /api/mp/tasks/:id/cancel` |

鉴权头：`Authorization: Bearer <token>`。

所以 2.4.22 / 2.4.23 都能跑；2.4.23 多出来的 `/m` 静态挂载对 Flutter 版没有影响（不调用它）。

## 本机已验证（Windows，不需要 Mac）

```bash
cd app
flutter pub get
flutter analyze                 # No issues found!
flutter test                    # 冒烟测试通过

# 起一台服务端（访客模式 = 注册即通过审批），再跑真实联调
cd ../server && PG_DATA_DIR=/tmp/pg PORT=8099 GUEST_MODE=true PG_DEV_MODE=true node src/index.js
cd ../app && PG_BASE=http://127.0.0.1:8099 flutter test test/api_live_test.dart
```

`api_live_test.dart` 实测覆盖：注册 → `me` → 上传两张图 → 服务端合并成 2 页 PDF → 文件列表 → 打印机列表 → 记录列表 → 无打印机时的错误文案。**4/4 通过。**

## 出 IPA（两条路，任选一条）

### A. GitHub Actions（推荐，public 仓库免费）

1. 仓库推到 GitHub；
2. Actions → **Build iOS IPA (Flutter)** → Run workflow；
3. 跑完在 artifact 里下 `PrintGate-flutter-unsigned-ipa`。

### B. Codemagic

1. 把仓库连到 Codemagic，识别到根目录 `codemagic.yaml`；
2. 选 workflow `ios-unsigned` → Start new build；
3. 产物在 Artifacts 里。

两条路产出的都是**未签名** IPA，用 Sideloadly / AltStore / 爱思助手用自己的 Apple ID 签一次即可安装
（免费账号 7 天、付费开发者账号 1 年；自签不需要 App Store 审核）。

## 已知限制（如实说）

- **iOS 原生部分没法在本机验证**：`flutter analyze` / `flutter test` 覆盖的是 Dart 层；`ios/` 下的 Podfile、签名、真机安装必须第一次在 CI 或 Mac 上跑一遍，可能还要补一两处配置（最常见是 CocoaPods 首次安装）。
- **没有 Mac 就无法真机调试**：日志、崩溃只能靠 `flutter logs`（需 USB）或在 Mac/Xcode 上看。原生底层问题（CallKit、后台任务、蓝牙打印等）仍要回到 Mac。
- **Android 未验证**：本机没装 Android SDK，`build apk` 没跑过；代码是平台无关的，但插件（image_picker / file_picker）在 Android 上的权限声明还需要实测。
- **大文件上传**：小程序端超过 8MB 走分片（`/api/mp/upload/init|chunk|complete`）；Flutter 版目前只走直传，服务端默认上限 `maxFileMB`（一般 20MB）。要支持更大的 PDF 需要补分片。
- **多图合成上限**：一次最多 9 张（与相册多选一致），服务端上限 20 张、页数受 `maxPages` 限制。

## 和 `ios/`（WKWebView 壳）的关系

`ios/` 那套 Swift 壳仍然保留：它加载 `<服务器>/m/`，改动只在前端，适合「不想发版、要立刻改界面」的场景。
Flutter 版适合「要像原生 App、要长期维护、要上架」的场景。两者可以并存，共用同一套后端接口。

## 下一步建议

1. 先跑一次 CI，把未签名 IPA 拿到手（这步只能你来触发，我没法推仓库）；
2. 真机上重点验：相册多选 → 合并 → 提交打印 → 记录刷新；
3. 需要更省事的话，再补：扫码填服务器地址、大文件分片上传、打印记录下拉刷新（已有）、深色模式适配（已跟随系统）。
