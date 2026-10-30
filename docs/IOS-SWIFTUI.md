# iOS 原生客户端（DesignFoundation）

用 [DesignFoundation](https://github.com/NerdSnipe-Inc/design-foundation)（SwiftUI 设计系统，MIT）重写的原生 iOS 客户端。
与 Flutter 版 `app/` **并存**，二者选一个用即可；后端零改动（都只调 `/api/mp/*`）。

## 为什么是原生 SwiftUI

DesignFoundation 是纯 SwiftUI 组件库（DFButton / DFCard / DFText / DFChip / DFPicker / DFAccordion /
DFEmptyState / DFBanner / DFAlert / DFSheet / DFTabBar / DFToastQueue 等），Flutter 无法直接消费，
所以这一版从 Flutter 换成了原生 SwiftUI。代价是：

- 部署目标 **iOS 18.0**（DesignFoundation 要求）；Swift 5 语言模式 + minimal 严格并发。
- 本地 Windows 无法编译，出包走云端 macOS（Codemagic / GitHub Actions）。

## 目录

```
ios-swiftui/
  PrintGate.xcodeproj/          手搓工程（tools/gen-swiftui-xcodeproj.js 生成，含 SPM 依赖）
  PrintGate/
    Core/     API / Models / Store / Fmt / Compose / LanScan / AppModel
    Theme/    AppTheme（品牌主题 + DF 五套预设）/ ThemeSheet / UI
    Screens/  Setup / Login / Home / Print / Files / History / Me + Admin 6 页
    Assets.xcassets/  AppIcon + Logo
```

## 功能对齐（与小程序一致）

- 4 Tab：打印 / 文件 / 记录 / 我的（DFTabBar）
- 打印页 4 模式：文件打印 / 文字速印 / 发票合排 / 身份证；参数（份数、黑白彩色、单双面、纸张、
  方向、每页页数、缩放、页范围、镜像、页边框、水印）；端上 1240px 画布合成后走 `/api/mp/files` + `/api/mp/print`
- 文件：上传（照片多选 + 文件导入）、预览翻页、存相册、删除、直接打印
- 记录：5 个筛选页签、相对时间、撤回待审批
- 我的：头像/资料/改密码/绑定管理员/扫码登录网页/服务器地址/外观/关于
- 管理台（管理员）：概览、用户审批/封禁/删除、队列审批/清理、打印机暂停恢复默认、
  常用设置（限额/审批开关/默认打印机）、**完整后台设置**（后台密码换 admin 令牌后动态渲染 `/api/settings` 全量键 + Office 一键安装）
- 大文件分片上传、局域网扫描、主题（模式 + 6 套预设）持久化

## 出包

两条路，二选一：

1. **Codemagic**（当前可用）：仓库 → PrintGate → Start new build → 选 `PrintGate SwiftUI (DesignFoundation...)` → Start。
   产物 `PrintGate-unsigned.ipa` 在 Artifacts。免费 500 分钟/月，一次约 6-10 分钟。
2. **GitHub Actions**：`.github/workflows/ios-swiftui.yml`（`macos-15`）。
   ⚠️ 当前账号 Actions 被平台禁用，解封后可用。

产物是**未签名** IPA，用 Sideloadly / 爱思助手自签安装（免费 Apple ID 7 天 / 付费 1 年）。

## 重新生成工程

`node tools/gen-swiftui-xcodeproj.js`（新增/删除 .swift 后重跑，产物直接提交仓库）。
`--check` 只校验结构。
