# 把 PrintGate 装进 iPhone（未签名 IPA + 自签）

## 先说实话：Windows 上出不了 IPA

iOS 的 `.app` 只能由 **Xcode** 编译，而 Xcode 只有 macOS 版。这台机器是 Windows（实测没有
`xcodebuild`、没有 CocoaPods），所以「在本地直接生成 IPA」这件事做不到 —— 不是配置问题，是平台限制。

能做的是把**除了编译以外的事**全部做完：工程、代码、图标、资源、打包脚本、CI 工作流。
剩下最后一步「按下编译」交给任意一台 macOS，或者 GitHub 的免费 macOS runner。

## 这套方案怎么构成

```
iPhone App (Swift, 约 400 行)
   └── WKWebView ──►  http(s)://<你的服务器>/m/      ← 移动端界面（HTML/CSS/JS）
                        └── 同源调用 /api/mp/*       ← 与小程序完全同一套后端接口
```

为什么用「WebView + 服务端页面」而不是把界面编译进 App：

- 界面和打印逻辑都在服务端，改 UI 只更新容器镜像，App 不用重新签名（自签 7 天就要重签，很痛）
- H5 与接口同源，没有 CORS、没有 Cookie 问题
- 登录用 **用户名 + 密码**（`/api/auth/account/login`），签发的就是小程序令牌，`/api/mp/*` 全部可用
- 需要原生能力的地方（选文件、拍照、相册）WebView 用系统控件，体验与原生一致

## 一、编译（三选一）

### A. GitHub Actions（推荐，零成本）

```bash
# 仓库推到 GitHub 后
Actions → "Build unsigned iOS IPA" → Run workflow
# 跑完在 Artifacts 里下载 PrintGate-unsigned-ipa
```

工作流文件：`.github/workflows/ios-unsigned.yml`（`macos-14`，约 3-5 分钟）。
公开仓库免费；私有仓库 macOS runner 会消耗额度。

### B. 借一台 Mac

```bash
brew install xcodegen
bash ios/scripts/build-unsigned-ipa.sh
# → ios/build/PrintGate-unsigned.ipa
```

### C. 商业云编译

Codemagic / Appcircle / Bitrise 都有免费额度，选「原生 iOS 工程」，构建命令填
`bash ios/scripts/build-unsigned-ipa.sh`，产物同样是未签名 IPA。

## 二、自签（Windows 也能做）

未签名 IPA 不能直接装，需要用自己的 Apple ID 签一次名：

| 工具 | 平台 | 说明 |
| --- | --- | --- |
| **Sideloadly** | Windows / macOS | 拖入 IPA + Apple ID，自动签名并安装；免费账号 7 天有效，到期重签 |
| AltStore | Windows / macOS | 装到电脑做 AltServer，手机端 AltStore 7 天自动续签 |
| TrollStore | iOS 14.0-16.6.1（部分版本） | 不需要签名，永久安装；仅特定系统版本可用 |
| 付费开发者账号 | - | 签名 1 年有效，可 100 台设备 |

步骤（Sideloadly）：装 iTunes/iCloud → 插上 iPhone → 拖入 IPA → 填 Apple ID → Start。
首次运行需要在 **设置 → 通用 → VPN 与设备管理** 里信任你的证书。

## 三、App 里的功能对照

| 小程序里的能力 | iOS App | 说明 |
| --- | --- | --- |
| 微信一键登录 | ❌ | 换成用户名 + 密码；账号在后台「用户管理」里建 |
| 从聊天记录选文件 | ❌ | 微信的私有能力，第三方 App 拿不到 |
| 从「文件」App 选 PDF/Office | ✅ | 系统文件选择器，可多选 |
| 拍照 / 相册选图 | ✅ | 系统相机与相册，多选后自动合成多页 PDF |
| 文件预览、翻页 | ✅ | 服务端渲染 `/api/mp/files/:id/preview?page=N` |
| 打印机、份数、单双面、彩色、纸张 | ✅ | 与小程序同一套参数 |
| 打印记录、取消任务 | ✅ | 同 `/api/mp/tasks` |
| 修改密码 | ✅ | `/api/auth/account/password` |
| 服务地址 | ⚠️ | 首次启动填一次，之后在「我的 → 服务器设置」里改 |

## 四、网络要求

- App 里对局域网 http 开了 ATS 例外（`NSAllowsArbitraryLoads`），所以 `http://192.168.x.x:8080` 能直接用
- 换成公网 https 域名后，建议把 `ios/project.yml` 里那段 ATS 配置删掉，更安全
- 服务端必须带 `/m/` 路径（2.4.23 起内置；更早的镜像里没有）

## 五、只想「先装上用」，不想签名

也可以在 Safari 里打开 `http://<服务器>/m/`，点分享 → **添加到主屏幕**。
这用的是同一份 H5（`manifest.webmanifest` 已配 standalone），效果接近 App：
图标、全屏、无地址栏。缺点是没有独立的原生壳，卸载/清理 Safari 数据会丢登录态。

## 六、目录结构

```
ios/
├── project.yml                    # XcodeGen 工程描述（不提交 .xcodeproj）
├── App/
│   ├── AppDelegate.swift          # 入口：没配地址 → 设置页，配过 → WebView
│   ├── Store.swift                # 地址规范化 + /api/health 探活
│   ├── SetupViewController.swift  # 首次/切换服务器
│   ├── WebViewController.swift    # WKWebView、下拉刷新、JS 弹窗、原生桥
│   └── Assets.xcassets/           # AppIcon / Logo / 主题色（脚本生成）
└── scripts/
    ├── gen-ios-assets.js          # 从设计稿生成 App 图标（无透明通道）
    └── build-unsigned-ipa.sh      # xcodegen + xcodebuild + 打 Payload
```

## 七、改界面与改壳的边界

| 改动 | 要做什么 |
| --- | --- |
| 页面样式、交互、打印参数 | 改 `server/mobile/`，更新容器镜像即可，App 无需重签 |
| 启动页、图标、原生桥、权限 | 改 `ios/`，重新编译 + 重新签名 |
