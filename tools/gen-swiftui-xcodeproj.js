#!/usr/bin/env node
/**
 * 生成 ios-swiftui/PrintGate.xcodeproj —— 原生 SwiftUI 版客户端工程。
 *
 * 为什么手搓：Windows 上没有 Xcode / xcodegen，但 CI（Codemagic）只认 .xcodeproj。
 * 这里用纯 Node 生成一份等价工程，并把 DesignFoundation 作为 SPM 依赖挂进去。
 *
 * 用法：
 *   node tools/gen-swiftui-xcodeproj.js           生成并覆盖
 *   node tools/gen-swiftui-xcodeproj.js --check    只校验结构（大括号配对 + 引用完整性）
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const BASE = path.join(ROOT, 'ios-swiftui');
const SRC = path.join(BASE, 'PrintGate');
const PROJ_DIR = path.join(BASE, 'PrintGate.xcodeproj');
const PBXPROJ = path.join(PROJ_DIR, 'project.pbxproj');
const SCHEME = path.join(PROJ_DIR, 'xcshareddata', 'xcschemes', 'PrintGate.xcscheme');

const TARGET = 'PrintGate';
const BUNDLE_ID = 'com.printgate.app';
const DEPLOYMENT_TARGET = '18.0';
const MARKETING_VERSION = '1.1.0';
const BUILD_NUMBER = '1';

// DesignFoundation：SwiftUI 设计系统（MIT），iOS 18+ / Swift 6
const PKG_NAME = 'DesignFoundation';
const PKG_URL = 'https://github.com/NerdSnipe-Inc/design-foundation';
const PKG_MIN = '1.8.0';

let seq = 0;
const nextId = () => (++seq).toString(16).toUpperCase().padStart(24, '0');

// ---------- 收集源文件 ----------

function walk(dir, prefix = '') {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith('.')) continue;
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (entry.name === 'Assets.xcassets') continue; // 资源目录作为 folder.assetcatalog 的 fileReference 单独挂载，不当作 group
      out.push({ type: 'group', name: entry.name, path: rel, children: walk(path.join(dir, entry.name), rel) });
    } else if (entry.name.endsWith('.swift')) {
      out.push({ type: 'file', name: entry.name, path: rel });
    }
  }
  return out;
}

const tree = walk(SRC);
const swiftFiles = [];
(function collect(nodes) {
  for (const n of nodes) {
    if (n.type === 'file') swiftFiles.push(n);
    else collect(n.children);
  }
})(tree);

if (!swiftFiles.length) {
  console.error('没有找到任何 .swift 文件，检查目录：' + SRC);
  process.exit(1);
}

// ---------- info.plist ----------

const INFO_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleDevelopmentRegion</key>
	<string>zh_CN</string>
	<key>CFBundleDisplayName</key>
	<string>PrintGate</string>
	<key>CFBundleExecutable</key>
	<string>$(EXECUTABLE_NAME)</string>
	<key>CFBundleIdentifier</key>
	<string>$(PRODUCT_BUNDLE_IDENTIFIER)</string>
	<key>CFBundleInfoDictionaryVersion</key>
	<string>6.0</string>
	<key>CFBundleName</key>
	<string>$(PRODUCT_NAME)</string>
	<key>CFBundlePackageType</key>
	<string>APPL</string>
	<key>CFBundleShortVersionString</key>
	<string>${MARKETING_VERSION}</string>
	<key>CFBundleVersion</key>
	<string>${BUILD_NUMBER}</string>
	<key>LSRequiresIPhoneOS</key>
	<true/>
	<key>UILaunchScreen</key>
	<dict>
		<key>UIColorName</key>
		<string></string>
	</dict>
	<key>UIApplicationSceneManifest</key>
	<dict>
		<key>UIApplicationSupportsMultipleScenes</key>
		<false/>
	</dict>
	<key>UISupportedInterfaceOrientations</key>
	<array>
		<string>UIInterfaceOrientationPortrait</string>
	</array>
	<key>UISupportedInterfaceOrientations~ipad</key>
	<array>
		<string>UIInterfaceOrientationPortrait</string>
		<string>UIInterfaceOrientationPortraitUpsideDown</string>
		<string>UIInterfaceOrientationLandscapeLeft</string>
		<string>UIInterfaceOrientationLandscapeRight</string>
	</array>
	<key>NSPhotoLibraryUsageDescription</key>
	<string>选择照片和发票图片用于打印</string>
	<key>NSPhotoLibraryAddUsageDescription</key>
	<string>把预览图存到相册</string>
	<key>NSCameraUsageDescription</key>
	<string>扫描服务器二维码 / 网页登录二维码</string>
	<key>NSLocalNetworkUsageDescription</key>
	<string>连接局域网内的 PrintGate 服务器</string>
	<key>NSAppTransportSecurity</key>
	<dict>
		<key>NSAllowsArbitraryLoads</key>
		<true/>
		<key>NSAllowsLocalNetworking</key>
		<true/>
	</dict>
	<key>UIRequiresFullScreen</key>
	<true/>
	<key>UIStatusBarStyle</key>
	<string>UIStatusBarStyleDefault</string>
</dict>
</plist>
`;

// ---------- 生成 ----------


function generate() {
  seq = 0;
  const fileRef = {};
  const buildFile = {};
  const fileRefLines = [];
  const buildFileLines = [];

  for (const f of swiftFiles) {
    const ref = nextId();
    const bf = nextId();
    fileRef[f.path] = ref;
    buildFile[f.path] = bf;
    fileRefLines.push(`\t\t${ref} /* ${f.name} */ = {isa = PBXFileReference; lastKnownFileType = sourcecode.swift; path = ${f.name}; sourceTree = "<group>"; };`);
    buildFileLines.push(`\t\t${bf} /* ${f.name} in Sources */ = {isa = PBXBuildFile; fileRef = ${ref} /* ${f.name} */; };`);
  }

  const assetsRef = nextId();
  const assetsBf = nextId();
  fileRefLines.push(`\t\t${assetsRef} /* Assets.xcassets */ = {isa = PBXFileReference; lastKnownFileType = folder.assetcatalog; path = Assets.xcassets; sourceTree = "<group>"; };`);
  buildFileLines.push(`\t\t${assetsBf} /* Assets.xcassets in Resources */ = {isa = PBXBuildFile; fileRef = ${assetsRef} /* Assets.xcassets */; };`);

  const infoRef = nextId();
  fileRefLines.push(`\t\t${infoRef} /* Info.plist */ = {isa = PBXFileReference; lastKnownFileType = text.plist.xml; path = Info.plist; sourceTree = "<group>"; };`);

  const appRef = nextId();
  fileRefLines.push(`\t\t${appRef} /* ${TARGET}.app */ = {isa = PBXFileReference; explicitFileType = wrapper.application; includeInIndex = 0; path = ${TARGET}.app; sourceTree = BUILT_PRODUCTS_DIR; };`);

  const pkgRef = nextId();
  const pkgProduct = nextId();
  const pkgBuildFile = nextId();

  const targetGroup = nextId();
  const mainGroup = nextId();
  const productsGroup = nextId();
  const sourcesPhase = nextId();
  const frameworksPhase = nextId();
  const resourcesPhase = nextId();
  const target = nextId();
  const project = nextId();
  const projConfigList = nextId();
  const tgtConfigList = nextId();
  const projDebug = nextId();
  const projRelease = nextId();
  const tgtDebug = nextId();
  const tgtRelease = nextId();

  const groupLines = [];
  function emit(nodes, children) {
    for (const n of nodes) {
      if (n.type === 'file') {
        children.push(`\t\t\t\t${fileRef[n.path]} /* ${n.name} */,`);
        continue;
      }
      const gid = nextId();
      const sub = [];
      emit(n.children, sub);
      groupLines.push(`\t\t${gid} /* ${n.name} */ = {
\t\t\tisa = PBXGroup;
\t\t\tchildren = (
${sub.join('\n')}
\t\t\t);
\t\t\tpath = ${n.name};
\t\t\tsourceTree = "<group>";
\t\t};`);
      children.push(`\t\t\t\t${gid} /* ${n.name} */,`);
    }
  }

  const appChildren = [];
  emit(tree, appChildren);
  appChildren.push(`\t\t\t\t${assetsRef} /* Assets.xcassets */,`);
  appChildren.push(`\t\t\t\t${infoRef} /* Info.plist */,`);

  const srcBuildFiles = swiftFiles.map((f) => `\t\t\t\t${buildFile[f.path]} /* ${f.name} in Sources */,`).join('\n');
  buildFileLines.push(`\t\t${pkgBuildFile} /* ${PKG_NAME} in Frameworks */ = {isa = PBXBuildFile; productRef = ${pkgProduct} /* ${PKG_NAME} */; };`);

  const shared = `\t\t\t\tALWAYS_SEARCH_USER_PATHS = NO;
\t\t\t\tCLANG_ENABLE_MODULES = YES;
\t\t\t\tCLANG_ENABLE_OBJC_ARC = YES;
\t\t\t\tCOPY_PHASE_STRIP = NO;
\t\t\t\tENABLE_STRICT_OBJC_MSGSEND = YES;
\t\t\t\tENABLE_USER_SCRIPT_SANDBOXING = NO;
\t\t\t\tGCC_NO_COMMON_BLOCKS = YES;
\t\t\t\tIPHONEOS_DEPLOYMENT_TARGET = ${DEPLOYMENT_TARGET};
\t\t\t\tSDKROOT = iphoneos;
\t\t\t\tSWIFT_STRICT_CONCURRENCY = minimal;
\t\t\t\tSWIFT_VERSION = 5.0;`;

  const tgt = `\t\t\t\tASSETCATALOG_COMPILER_APPICON_NAME = AppIcon;
\t\t\t\tCODE_SIGNING_ALLOWED = NO;
\t\t\t\tCODE_SIGNING_REQUIRED = NO;
\t\t\t\tCODE_SIGN_IDENTITY = "";
\t\t\t\tCODE_SIGN_STYLE = Manual;
\t\t\t\tCURRENT_PROJECT_VERSION = ${BUILD_NUMBER};
\t\t\t\tDEVELOPMENT_TEAM = "";
\t\t\t\tGENERATE_INFOPLIST_FILE = NO;
\t\t\t\tINFOPLIST_FILE = ${TARGET}/Info.plist;
\t\t\t\tIPHONEOS_DEPLOYMENT_TARGET = ${DEPLOYMENT_TARGET};
\t\t\t\tLD_RUNPATH_SEARCH_PATHS = (
\t\t\t\t\t"$(inherited)",
\t\t\t\t\t"@executable_path/Frameworks",
\t\t\t\t);
\t\t\t\tMARKETING_VERSION = ${MARKETING_VERSION};
\t\t\t\tPRODUCT_BUNDLE_IDENTIFIER = ${BUNDLE_ID};
\t\t\t\tPRODUCT_NAME = "$(TARGET_NAME)";
\t\t\t\tSUPPORTS_MACCATALYST = NO;
\t\t\t\tSWIFT_EMIT_LOC_STRINGS = NO;
\t\t\t\tSWIFT_STRICT_CONCURRENCY = minimal;
\t\t\t\tTARGETED_DEVICE_FAMILY = 1;`;

  return `// !$*UTF8*$!
{
\tarchiveVersion = 1;
\tclasses = {
\t};
\tobjectVersion = 56;
\tobjects = {

/* Begin PBXBuildFile section */
${buildFileLines.join('\n')}
/* End PBXBuildFile section */

/* Begin PBXFileReference section */
${fileRefLines.join('\n')}
/* End PBXFileReference section */

/* Begin PBXFrameworksBuildPhase section */
\t\t${frameworksPhase} /* Frameworks */ = {
\t\t\tisa = PBXFrameworksBuildPhase;
\t\t\tbuildActionMask = 2147483647;
\t\t\tfiles = (
\t\t\t\t${pkgBuildFile} /* ${PKG_NAME} in Frameworks */,
\t\t\t);
\t\t\trunOnlyForDeploymentPostprocessing = 0;
\t\t};
/* End PBXFrameworksBuildPhase section */

/* Begin PBXGroup section */
\t\t${mainGroup} = {
\t\t\tisa = PBXGroup;
\t\t\tchildren = (
\t\t\t\t${targetGroup} /* ${TARGET} */,
\t\t\t\t${productsGroup} /* Products */,
\t\t\t);
\t\t\tsourceTree = "<group>";
\t\t};
\t\t${targetGroup} /* ${TARGET} */ = {
\t\t\tisa = PBXGroup;
\t\t\tchildren = (
${appChildren.join('\n')}
\t\t\t);
\t\t\tpath = ${TARGET};
\t\t\tsourceTree = "<group>";
\t\t};
${groupLines.join('\n')}
\t\t${productsGroup} /* Products */ = {
\t\t\tisa = PBXGroup;
\t\t\tchildren = (
\t\t\t\t${appRef} /* ${TARGET}.app */,
\t\t\t);
\t\t\tname = Products;
\t\t\tsourceTree = "<group>";
\t\t};
/* End PBXGroup section */

/* Begin PBXNativeTarget section */
\t\t${target} /* ${TARGET} */ = {
\t\t\tisa = PBXNativeTarget;
\t\t\tbuildConfigurationList = ${tgtConfigList} /* Build configuration list for PBXNativeTarget "${TARGET}" */;
\t\t\tbuildPhases = (
\t\t\t\t${sourcesPhase} /* Sources */,
\t\t\t\t${frameworksPhase} /* Frameworks */,
\t\t\t\t${resourcesPhase} /* Resources */,
\t\t\t);
\t\t\tbuildRules = (
\t\t\t);
\t\t\tdependencies = (
\t\t\t);
\t\t\tname = ${TARGET};
\t\t\tpackageProductDependencies = (
\t\t\t\t${pkgProduct} /* ${PKG_NAME} */,
\t\t\t);
\t\t\tproductName = ${TARGET};
\t\t\tproductReference = ${appRef} /* ${TARGET}.app */;
\t\t\tproductType = "com.apple.product-type.application";
\t\t};
/* End PBXNativeTarget section */

/* Begin PBXProject section */
\t\t${project} /* Project object */ = {
\t\t\tisa = PBXProject;
\t\t\tattributes = {
\t\t\t\tBuildIndependentTargetsInParallel = 1;
\t\t\t\tLastSwiftUpdateCheck = 1600;
\t\t\t\tLastUpgradeCheck = 1600;
\t\t\t\tTargetAttributes = {
\t\t\t\t\t${target} = {
\t\t\t\t\t\tCreatedOnToolsVersion = 16.0;
\t\t\t\t\t};
\t\t\t\t};
\t\t\t};
\t\t\tbuildConfigurationList = ${projConfigList} /* Build configuration list for PBXProject "${TARGET}" */;
\t\t\tcompatibilityVersion = "Xcode 14.0";
\t\t\tdevelopmentRegion = zh_CN;
\t\t\thasScannedForEncodings = 0;
\t\t\tknownRegions = (
\t\t\t\tzh_CN,
\t\t\t\tBase,
\t\t\t);
\t\t\tmainGroup = ${mainGroup};
\t\t\tpackageReferences = (
\t\t\t\t${pkgRef} /* XCRemoteSwiftPackageReference "${PKG_NAME}" */,
\t\t\t);
\t\t\tproductRefGroup = ${productsGroup} /* Products */;
\t\t\tprojectDirPath = "";
\t\t\tprojectRoot = "";
\t\t\ttargets = (
\t\t\t\t${target} /* ${TARGET} */,
\t\t\t);
\t\t};
/* End PBXProject section */

/* Begin PBXResourcesBuildPhase section */
\t\t${resourcesPhase} /* Resources */ = {
\t\t\tisa = PBXResourcesBuildPhase;
\t\t\tbuildActionMask = 2147483647;
\t\t\tfiles = (
\t\t\t\t${assetsBf} /* Assets.xcassets in Resources */,
\t\t\t);
\t\t\trunOnlyForDeploymentPostprocessing = 0;
\t\t};
/* End PBXResourcesBuildPhase section */

/* Begin PBXSourcesBuildPhase section */
\t\t${sourcesPhase} /* Sources */ = {
\t\t\tisa = PBXSourcesBuildPhase;
\t\t\tbuildActionMask = 2147483647;
\t\t\tfiles = (
${srcBuildFiles}
\t\t\t);
\t\t\trunOnlyForDeploymentPostprocessing = 0;
\t\t};
/* End PBXSourcesBuildPhase section */

/* Begin XCBuildConfiguration section */
\t\t${projDebug} /* Debug */ = {
\t\t\tisa = XCBuildConfiguration;
\t\t\tbuildSettings = {
${shared}
\t\t\t\tDEBUG_INFORMATION_FORMAT = dwarf;
\t\t\t\tENABLE_TESTABILITY = YES;
\t\t\t\tGCC_OPTIMIZATION_LEVEL = 0;
\t\t\t\tONLY_ACTIVE_ARCH = YES;
\t\t\t\tSWIFT_ACTIVE_COMPILATION_CONDITIONS = DEBUG;
\t\t\t\tSWIFT_OPTIMIZATION_LEVEL = "-Onone";
\t\t\t};
\t\t\tname = Debug;
\t\t};
\t\t${projRelease} /* Release */ = {
\t\t\tisa = XCBuildConfiguration;
\t\t\tbuildSettings = {
${shared}
\t\t\t\tDEBUG_INFORMATION_FORMAT = "dwarf-with-dsym";
\t\t\t\tENABLE_NS_ASSERTIONS = NO;
\t\t\t\tSWIFT_COMPILATION_MODE = wholemodule;
\t\t\t\tVALIDATE_PRODUCT = YES;
\t\t\t};
\t\t\tname = Release;
\t\t};
\t\t${tgtDebug} /* Debug */ = {
\t\t\tisa = XCBuildConfiguration;
\t\t\tbuildSettings = {
${tgt}
\t\t\t};
\t\t\tname = Debug;
\t\t};
\t\t${tgtRelease} /* Release */ = {
\t\t\tisa = XCBuildConfiguration;
\t\t\tbuildSettings = {
${tgt}
\t\t\t};
\t\t\tname = Release;
\t\t};
/* End XCBuildConfiguration section */

/* Begin XCConfigurationList section */
\t\t${projConfigList} /* Build configuration list for PBXProject "${TARGET}" */ = {
\t\t\tisa = XCConfigurationList;
\t\t\tbuildConfigurations = (
\t\t\t\t${projDebug} /* Debug */,
\t\t\t\t${projRelease} /* Release */,
\t\t\t);
\t\t\tdefaultConfigurationIsVisible = 0;
\t\t\tdefaultConfigurationName = Release;
\t\t};
\t\t${tgtConfigList} /* Build configuration list for PBXNativeTarget "${TARGET}" */ = {
\t\t\tisa = XCConfigurationList;
\t\t\tbuildConfigurations = (
\t\t\t\t${tgtDebug} /* Debug */,
\t\t\t\t${tgtRelease} /* Release */,
\t\t\t);
\t\t\tdefaultConfigurationIsVisible = 0;
\t\t\tdefaultConfigurationName = Release;
\t\t};
/* End XCConfigurationList section */

/* Begin XCRemoteSwiftPackageReference section */
\t\t${pkgRef} /* XCRemoteSwiftPackageReference "${PKG_NAME}" */ = {
\t\t\tisa = XCRemoteSwiftPackageReference;
\t\t\trepositoryURL = "${PKG_URL}";
\t\t\trequirement = {
\t\t\t\tkind = upToNextMajorVersion;
\t\t\t\tminimumVersion = ${PKG_MIN};
\t\t\t};
\t\t};
/* End XCRemoteSwiftPackageReference section */

/* Begin XCSwiftPackageProductDependency section */
\t\t${pkgProduct} /* ${PKG_NAME} */ = {
\t\t\tisa = XCSwiftPackageProductDependency;
\t\t\tpackage = ${pkgRef} /* XCRemoteSwiftPackageReference "${PKG_NAME}" */;
\t\t\tproductName = ${PKG_NAME};
\t\t};
/* End XCSwiftPackageProductDependency section */
\t};
\trootObject = ${project} /* Project object */;
}
`;
}

const SCHEME_XML = `<?xml version="1.0" encoding="UTF-8"?>
<Scheme LastUpgradeVersion = "1600" version = "1.7">
   <BuildAction parallelizeBuildables = "YES" buildImplicitDependencies = "YES">
      <BuildActionEntries>
         <BuildActionEntry buildForTesting = "YES" buildForRunning = "YES" buildForProfiling = "YES" buildForArchiving = "YES" buildForAnalyzing = "YES">
            <BuildableReference
               BuildableIdentifier = "primary"
               BlueprintIdentifier = "__TARGET__"
               BuildableName = "${TARGET}.app"
               BlueprintName = "${TARGET}"
               ReferencedContainer = "container:${TARGET}.xcodeproj">
            </BuildableReference>
         </BuildActionEntry>
      </BuildActionEntries>
   </BuildAction>
   <TestAction buildConfiguration = "Debug" selectedDebuggerIdentifier = "Xcode.DebuggerFoundation.Debugger.LLDB" selectedLauncherIdentifier = "Xcode.DebuggerFoundation.Launcher.LLDB" shouldUseLaunchSchemeArgsEnv = "YES">
      <Testables>
      </Testables>
   </TestAction>
   <LaunchAction buildConfiguration = "Debug" selectedDebuggerIdentifier = "Xcode.DebuggerFoundation.Debugger.LLDB" selectedLauncherIdentifier = "Xcode.DebuggerFoundation.Launcher.LLDB" launchStyle = "0" useCustomWorkingDirectory = "NO" ignoresPersistentStateOnLaunch = "NO" debugDocumentVersioning = "YES" debugServiceExtension = "internal" allowLocationSimulation = "YES">
      <BuildableProductRunnable runnableDebuggingMode = "0">
         <BuildableReference
            BuildableIdentifier = "primary"
            BlueprintIdentifier = "__TARGET__"
            BuildableName = "${TARGET}.app"
            BlueprintName = "${TARGET}"
            ReferencedContainer = "container:${TARGET}.xcodeproj">
         </BuildableReference>
      </BuildableProductRunnable>
   </LaunchAction>
   <ProfileAction buildConfiguration = "Release" shouldUseLaunchSchemeArgsEnv = "YES" savedToolIdentifier = "" useCustomWorkingDirectory = "NO" debugDocumentVersioning = "YES">
      <BuildableProductRunnable runnableDebuggingMode = "0">
         <BuildableReference
            BuildableIdentifier = "primary"
            BlueprintIdentifier = "__TARGET__"
            BuildableName = "${TARGET}.app"
            BlueprintName = "${TARGET}"
            ReferencedContainer = "container:${TARGET}.xcodeproj">
         </BuildableReference>
      </BuildableProductRunnable>
   </ProfileAction>
   <AnalyzeAction buildConfiguration = "Debug"></AnalyzeAction>
   <ArchiveAction buildConfiguration = "Release" revealArchiveInOrganizer = "YES"></ArchiveAction>
</Scheme>
`;

// ---------- 校验 ----------

function check() {
  if (!fs.existsSync(PBXPROJ)) {
    console.error('缺少 ' + PBXPROJ);
    process.exit(1);
  }
  const src = fs.readFileSync(PBXPROJ, 'utf8');
  const open = (src.match(/\{/g) || []).length;
  const close = (src.match(/\}/g) || []).length;
  if (open !== close) {
    console.error(`大括号不配对：{ ${open} 个，} ${close} 个`);
    process.exit(1);
  }
  // 所有被引用的 24 位 ID 都应有定义
  const defined = new Set();
  const defRe = /^\t\t([0-9A-F]{24}) /gm;
  let m;
  while ((m = defRe.exec(src))) defined.add(m[1]);
  const used = new Set((src.match(/[0-9A-F]{24}/g) || []));
  const missing = [...used].filter((id) => !defined.has(id));
  if (missing.length) {
    console.error('引用了未定义的 ID：' + missing.join(', '));
    process.exit(1);
  }
  for (const f of swiftFiles) {
    if (!src.includes(`path = ${f.name};`)) {
      console.error('工程里漏了源文件：' + f.name);
      process.exit(1);
    }
  }
  console.log(`校验通过：${swiftFiles.length} 个 Swift 文件，${defined.size} 个对象，括号配对正常`);
}

// ---------- 入口 ----------

const args = process.argv.slice(2);
if (args.includes('--check')) {
  check();
  process.exit(0);
}

fs.mkdirSync(path.join(PROJ_DIR, 'xcshareddata', 'xcschemes'), { recursive: true });
fs.writeFileSync(path.join(SRC, 'Info.plist'), INFO_PLIST, 'utf8');

const pbx = generate();
const targetMatch = pbx.match(/([0-9A-F]{24}) \/\* PrintGate \*\/ = \{\n\t\t\tisa = PBXNativeTarget;/);
const targetId = targetMatch ? targetMatch[1] : 'AAAAAAAAAAAAAAAAAAAAAAAA';
fs.writeFileSync(PBXPROJ, pbx, 'utf8');
fs.writeFileSync(SCHEME, SCHEME_XML.replace(/__TARGET__/g, targetId), 'utf8');

console.log(`已生成 ${path.relative(ROOT, PBXPROJ)}`);
console.log(`  Swift 文件 ${swiftFiles.length} 个，SPM 依赖 ${PKG_NAME} >= ${PKG_MIN}`);
check();
