#!/usr/bin/env bash
# 打一个「未签名」的 IPA。三种环境都能跑：
#   1) KXBuild（Windows / Linux / macOS，不需要 Xcode）  ← 首选，见 docs/IOS-APP.md
#   2) xcodebuild（macOS + Xcode）
#   3) 都没有 → 只做工程自检，给出可执行的下一步
#
# 产物：ios/build/PrintGate-unsigned.ipa
# 未签名 IPA 不能直接装，需要用 Sideloadly / AltStore / 爱思助手用自己的 Apple ID 签一次名
# （免费账号 7 天有效，付费开发者账号 1 年）。
set -euo pipefail

cd "$(dirname "$0")/.."          # → ios/
ROOT="$(cd .. && pwd)"

echo "==> 图标资源（已提交，缺失时补生成）"
if [ ! -f "App/Assets.xcassets/AppIcon.appiconset/icon-1024x1024@1x.png" ]; then
  ( cd "$ROOT" && NODE_PATH="${NODE_PATH:-}" node ios/scripts/gen-ios-assets.js ) || \
    echo "跳过：生成图标需要 node + sharp，可先在开发机跑一次"
fi

# 工程文件（.xcodeproj）已提交，xcodegen 只在缺工程时才需要
if [ ! -f "PrintGate.xcodeproj/project.pbxproj" ]; then
  echo "==> 生成 Xcode 工程（缺 .xcodeproj）"
  if command -v node >/dev/null; then
    ( cd "$ROOT" && node tools/gen-ios-xcodeproj.js )
  elif command -v xcodegen >/dev/null; then
    xcodegen generate
  else
    echo "缺少 PrintGate.xcodeproj，且本机没有 node / xcodegen，无法生成工程"; exit 1
  fi
fi

echo "==> 工程自检"
( cd "$ROOT" && node tools/gen-ios-xcodeproj.js --check ) || echo "（跳过：没有 node）"

rm -rf build

if command -v kxbuild >/dev/null; then
  # KXBuild：不签名出 ipa 用 --export 的空签名配置；这里直接 build 后自己打包，
  # 与下面 xcodebuild 分支保持同一套产物路径，方便签名工具统一处理。
  echo "==> kxbuild 编译（Release / iphoneos，关闭签名）"
  kxbuild build ./PrintGate.xcodeproj \
    -s PrintGate \
    -c Release \
    --sdk iphoneos \
    --build-dir ./build \
    --no-sign
  APP="$(find build -type d -name "PrintGate.app" | head -1)"
elif command -v xcodebuild >/dev/null; then
  echo "==> xcodebuild 编译（Release / iphoneos，关闭签名）"
  xcodebuild \
    -project PrintGate.xcodeproj \
    -scheme PrintGate \
    -configuration Release \
    -sdk iphoneos \
    -derivedDataPath build \
    CODE_SIGNING_ALLOWED=NO \
    CODE_SIGNING_REQUIRED=NO \
    CODE_SIGN_IDENTITY="" \
    PROVISIONING_PROFILE_SPECIFIER="" \
    build | tail -20
  APP="build/Build/Products/Release-iphoneos/PrintGate.app"
else
  echo
  echo "本机既没有 kxbuild 也没有 xcodebuild，无法编译。可选："
  echo "  · Windows/Linux 出 ipa：装 KXBuild（见 docs/IOS-APP.md 的「KXBuild」一节）"
  echo "  · macOS：xcode-select --install 后重跑本脚本"
  echo "  · 没有 Mac 也没有 KXBuild：用 .github/workflows/ios-unsigned.yml（GitHub Actions macos runner）"
  exit 1
fi

[ -n "${APP:-}" ] && [ -d "$APP" ] || { echo "没找到产物：${APP:-<build 下没有 PrintGate.app>}"; exit 1; }

echo "==> 打包 Payload"
rm -rf build/Payload build/PrintGate-unsigned.ipa
mkdir -p build/Payload
cp -R "$APP" build/Payload/
( cd build && zip -qry PrintGate-unsigned.ipa Payload )

echo
echo "完成：$(pwd)/build/PrintGate-unsigned.ipa"
ls -lh build/PrintGate-unsigned.ipa | awk '{print "大小：" $5}'
echo "下一步：用 Sideloadly（Windows 也能用）把它签进手机，见 docs/IOS-APP.md"
