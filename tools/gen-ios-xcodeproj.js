#!/usr/bin/env node
/**
 * 生成 ios/PrintGate.xcodeproj（project.pbxproj + 共享 scheme）与 App/Info.plist。
 *
 * 为什么要这个脚本：工程原本只提供 project.yml，靠 macOS 上的 xcodegen 生成工程。
 * 但「在 Windows 上出 ipa」（KXBuild / 无 Mac 的 CI）没有 xcodegen，只认 .xcodeproj，
 * 所以这里用纯 Node 手搓一份等价工程，产物提交进仓库，xcodebuild / kxbuild 都能直接开。
 *
 * 用法：node tools/gen-ios-xcodeproj.js [--check]
 *   --check  只校验已有工程的括号/引用完整性，不重写文件
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const IOS = path.join(ROOT, 'ios');
const PROJ_DIR = path.join(IOS, 'PrintGate.xcodeproj');
const PBXPROJ = path.join(PROJ_DIR, 'project.pbxproj');
const SCHEME = path.join(PROJ_DIR, 'xcshareddata', 'xcschemes', 'PrintGate.xcscheme');
const INFO_PLIST = path.join(IOS, 'App', 'Info.plist');

/** 24 位十六进制 ID 生成器：Xcode 的 object identifier 就是这个形状 */
let seq = 0;
const nextId = () => (++seq).toString(16).toUpperCase().padStart(24, '0');

// ---------- 工程里要编的东西 ----------
const SWIFT_SOURCES = ['AppDelegate.swift', 'Store.swift', 'SetupViewController.swift', 'WebViewController.swift'];
const RESOURCES = ['Assets.xcassets'];

const TARGET_NAME = 'PrintGate';
const BUNDLE_ID = 'com.printgate.app';
const DEPLOYMENT_TARGET = '14.0';
const MARKETING_VERSION = '1.0.0';
const BUILD_NUMBER = '1';

// ---------- Info.plist ----------
const INFO_PLIST_XML = `<?xml version="1.0" encoding="UTF-8"?>
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
	<key>ITSAppUsesNonExemptEncryption</key>
	<false/>
	<key>LSRequiresIPhoneOS</key>
	<true/>
	<key>NSAppTransportSecurity</key>
	<dict>
		<key>NSAllowsArbitraryLoads</key>
		<true/>
		<key>NSAllowsLocalNetworking</key>
		<true/>
	</dict>
	<key>NSCameraUsageDescription</key>
	<string>拍照后直接上传打印，照片不会保存到相册。</string>
	<key>NSPhotoLibraryUsageDescription</key>
	<string>从相册选择图片上传打印。</string>
	<key>UILaunchScreen</key>
	<dict>
		<key>UIColorName</key>
		<string>LaunchBackground</string>
	</dict>
	<key>UISupportedInterfaceOrientations</key>
	<array>
		<string>UIInterfaceOrientationPortrait</string>
	</array>
	<key>UIUserInterfaceStyle</key>
	<string>Automatic</string>
</dict>
</plist>
`;

// ---------- project.pbxproj ----------
function buildPbxproj() {
  const fileRef = {};
  const buildFile = {};

  // 源文件 + 资源：一个文件引用 + 一个 build file
  const fileEntries = [];
  for (const name of SWIFT_SOURCES) {
    const ref = nextId();
    const bf = nextId();
    fileRef[name] = ref;
    buildFile[name] = bf;
    fileEntries.push(
      `\t\t${ref} /* ${name} */ = {isa = PBXFileReference; lastKnownFileType = sourcecode.swift; path = ${name}; sourceTree = "<group>"; };`
    );
    fileEntries.push(
      `\t\t${bf} /* ${name} in Sources */ = {isa = PBXBuildFile; fileRef = ${ref} /* ${name} */; };`
    );
  }
  for (const name of RESOURCES) {
    const ref = nextId();
    const bf = nextId();
    fileRef[name] = ref;
    buildFile[name] = bf;
    fileEntries.push(
      `\t\t${ref} /* ${name} */ = {isa = PBXFileReference; lastKnownFileType = folder.assetcatalog; path = ${name}; sourceTree = "<group>"; };`
    );
    fileEntries.push(
      `\t\t${bf} /* ${name} in Resources */ = {isa = PBXBuildFile; fileRef = ${ref} /* ${name} */; };`
    );
  }

  const infoRef = nextId();
  const appRef = nextId();
  fileEntries.push(
    `\t\t${infoRef} /* Info.plist */ = {isa = PBXFileReference; lastKnownFileType = text.plist.xml; path = Info.plist; sourceTree = "<group>"; };`
  );
  fileEntries.push(
    `\t\t${appRef} /* ${TARGET_NAME}.app */ = {isa = PBXFileReference; explicitFileType = wrapper.application; includeInIndex = 0; path = ${TARGET_NAME}.app; sourceTree = BUILT_PRODUCTS_DIR; };`
  );

  const mainGroup = nextId();
  const appGroup = nextId();
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

  const srcBuildFiles = SWIFT_SOURCES.map((n) => `\t\t\t\t${buildFile[n]} /* ${n} in Sources */,`).join('\n');
  const resBuildFiles = RESOURCES.map((n) => `\t\t\t\t${buildFile[n]} /* ${n} in Resources */,`).join('\n');
  const appChildren = [...SWIFT_SOURCES.map((n) => `\t\t\t\t${fileRef[n]} /* ${n} */,`), `\t\t\t\t${fileRef['Assets.xcassets']} /* Assets.xcassets */,`, `\t\t\t\t${infoRef} /* Info.plist */,`].join('\n');

  const sharedSettings = `\t\t\t\tALWAYS_SEARCH_USER_PATHS = NO;
\t\t\t\tCLANG_ENABLE_MODULES = YES;
\t\t\t\tCLANG_ENABLE_OBJC_ARC = YES;
\t\t\t\tCLANG_WARN_BOOL_CONVERSION = YES;
\t\t\t\tCLANG_WARN_DOCUMENTATION_COMMENTS = YES;
\t\t\t\tCLANG_WARN_UNREACHABLE_CODE = YES;
\t\t\t\tCODE_SIGN_STYLE = Manual;
\t\t\t\tCOPY_PHASE_STRIP = NO;
\t\t\t\tDEVELOPMENT_TEAM = "";
\t\t\t\tENABLE_STRICT_OBJC_MSGSEND = YES;
\t\t\t\tENABLE_USER_SCRIPT_SANDBOXING = NO;
\t\t\t\tGCC_C_LANGUAGE_STANDARD = gnu11;
\t\t\t\tGCC_NO_COMMON_BLOCKS = YES;
\t\t\t\tIPHONEOS_DEPLOYMENT_TARGET = ${DEPLOYMENT_TARGET};
\t\t\t\tMTL_FAST_MATH = YES;
\t\t\t\tSDKROOT = iphoneos;
\t\t\t\tSWIFT_VERSION = 5.0;`;

  const tgtSettings = `\t\t\t\tASSETCATALOG_COMPILER_APPICON_NAME = AppIcon;
\t\t\t\tASSETCATALOG_COMPILER_GLOBAL_ACCENT_COLOR_NAME = AccentColor;
\t\t\t\tCODE_SIGN_STYLE = Manual;
\t\t\t\tCURRENT_PROJECT_VERSION = ${BUILD_NUMBER};
\t\t\t\tDEVELOPMENT_TEAM = "";
\t\t\t\tGENERATE_INFOPLIST_FILE = NO;
\t\t\t\tINFOPLIST_FILE = App/Info.plist;
\t\t\t\tLD_RUNPATH_SEARCH_PATHS = (
\t\t\t\t\t"$(inherited)",
\t\t\t\t\t"@executable_path/Frameworks",
\t\t\t\t);
\t\t\t\tMARKETING_VERSION = ${MARKETING_VERSION};
\t\t\t\tPRODUCT_BUNDLE_IDENTIFIER = ${BUNDLE_ID};
\t\t\t\tPRODUCT_NAME = "$(TARGET_NAME)";
\t\t\t\tSUPPORTS_MACCATALYST = NO;
\t\t\t\tSWIFT_EMIT_LOC_STRINGS = NO;
\t\t\t\tTARGETED_DEVICE_FAMILY = 1;`;

  return `// !$*UTF8*$!
{
\tarchiveVersion = 1;
\tclasses = {
\t};
\tobjectVersion = 56;
\tobjects = {

/* Begin PBXBuildFile section */
${fileEntries.filter((l) => l.includes('PBXBuildFile')).join('\n')}
/* End PBXBuildFile section */

/* Begin PBXFileReference section */
${fileEntries.filter((l) => l.includes('PBXFileReference')).join('\n')}
/* End PBXFileReference section */

/* Begin PBXFrameworksBuildPhase section */
\t\t${frameworksPhase} /* Frameworks */ = {
\t\t\tisa = PBXFrameworksBuildPhase;
\t\t\tbuildActionMask = 2147483647;
\t\t\tfiles = (
\t\t\t);
\t\t\trunOnlyForDeploymentPostprocessing = 0;
\t\t};
/* End PBXFrameworksBuildPhase section */

/* Begin PBXGroup section */
\t\t${mainGroup} = {
\t\t\tisa = PBXGroup;
\t\t\tchildren = (
\t\t\t\t${appGroup} /* App */,
\t\t\t\t${productsGroup} /* Products */,
\t\t\t);
\t\t\tsourceTree = "<group>";
\t\t};
\t\t${appGroup} /* App */ = {
\t\t\tisa = PBXGroup;
\t\t\tchildren = (
${appChildren}
\t\t\t);
\t\t\tpath = App;
\t\t\tsourceTree = "<group>";
\t\t};
\t\t${productsGroup} /* Products */ = {
\t\t\tisa = PBXGroup;
\t\t\tchildren = (
\t\t\t\t${appRef} /* ${TARGET_NAME}.app */,
\t\t\t);
\t\t\tname = Products;
\t\t\tsourceTree = "<group>";
\t\t};
/* End PBXGroup section */

/* Begin PBXNativeTarget section */
\t\t${target} /* ${TARGET_NAME} */ = {
\t\t\tisa = PBXNativeTarget;
\t\t\tbuildConfigurationList = ${tgtConfigList} /* Build configuration list for PBXNativeTarget "${TARGET_NAME}" */;
\t\t\tbuildPhases = (
\t\t\t\t${sourcesPhase} /* Sources */,
\t\t\t\t${frameworksPhase} /* Frameworks */,
\t\t\t\t${resourcesPhase} /* Resources */,
\t\t\t);
\t\t\tbuildRules = (
\t\t\t);
\t\t\tdependencies = (
\t\t\t);
\t\t\tname = ${TARGET_NAME};
\t\t\tproductName = ${TARGET_NAME};
\t\t\tproductReference = ${appRef} /* ${TARGET_NAME}.app */;
\t\t\tproductType = "com.apple.product-type.application";
\t\t};
/* End PBXNativeTarget section */

/* Begin PBXProject section */
\t\t${project} /* Project object */ = {
\t\t\tisa = PBXProject;
\t\t\tattributes = {
\t\t\t\tBuildIndependentTargetsInParallel = 1;
\t\t\t\tLastSwiftUpdateCheck = 1500;
\t\t\t\tLastUpgradeCheck = 1500;
\t\t\t\tTargetAttributes = {
\t\t\t\t\t${target} = {
\t\t\t\t\t\tCreatedOnToolsVersion = 15.0;
\t\t\t\t\t};
\t\t\t\t};
\t\t\t};
\t\t\tbuildConfigurationList = ${projConfigList} /* Build configuration list for PBXProject "${TARGET_NAME}" */;
\t\t\tcompatibilityVersion = "Xcode 14.0";
\t\t\tdevelopmentRegion = zh_CN;
\t\t\thasScannedForEncodings = 0;
\t\t\tknownRegions = (
\t\t\t\tzh_CN,
\t\t\t\tBase,
\t\t\t);
\t\t\tmainGroup = ${mainGroup};
\t\t\tproductRefGroup = ${productsGroup} /* Products */;
\t\t\tprojectDirPath = "";
\t\t\tprojectRoot = "";
\t\t\ttargets = (
\t\t\t\t${target} /* ${TARGET_NAME} */,
\t\t\t);
\t\t};
/* End PBXProject section */

/* Begin PBXResourcesBuildPhase section */
\t\t${resourcesPhase} /* Resources */ = {
\t\t\tisa = PBXResourcesBuildPhase;
\t\t\tbuildActionMask = 2147483647;
\t\t\tfiles = (
${resBuildFiles}
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
${sharedSettings}
\t\t\t\tDEBUG_INFORMATION_FORMAT = dwarf;
\t\t\t\tENABLE_TESTABILITY = YES;
\t\t\t\tGCC_OPTIMIZATION_LEVEL = 0;
\t\t\t\tGCC_PREPROCESSOR_DEFINITIONS = (
\t\t\t\t\t"DEBUG=1",
\t\t\t\t\t"$(inherited)",
\t\t\t\t);
\t\t\t\tONLY_ACTIVE_ARCH = YES;
\t\t\t\tSWIFT_ACTIVE_COMPILATION_CONDITIONS = DEBUG;
\t\t\t\tSWIFT_OPTIMIZATION_LEVEL = "-Onone";
\t\t\t};
\t\t\tname = Debug;
\t\t};
\t\t${projRelease} /* Release */ = {
\t\t\tisa = XCBuildConfiguration;
\t\t\tbuildSettings = {
${sharedSettings}
\t\t\t\tDEBUG_INFORMATION_FORMAT = "dwarf-with-dsym";
\t\t\t\tENABLE_NS_ASSERTIONS = NO;
\t\t\t\tSWIFT_OPTIMIZATION_LEVEL = "-O";
\t\t\t\tVALIDATE_PRODUCT = YES;
\t\t\t};
\t\t\tname = Release;
\t\t};
\t\t${tgtDebug} /* Debug */ = {
\t\t\tisa = XCBuildConfiguration;
\t\t\tbuildSettings = {
${tgtSettings}
\t\t\t};
\t\t\tname = Debug;
\t\t};
\t\t${tgtRelease} /* Release */ = {
\t\t\tisa = XCBuildConfiguration;
\t\t\tbuildSettings = {
${tgtSettings}
\t\t\t};
\t\t\tname = Release;
\t\t};
/* End XCBuildConfiguration section */

/* Begin XCConfigurationList section */
\t\t${projConfigList} /* Build configuration list for PBXProject "${TARGET_NAME}" */ = {
\t\t\tisa = XCConfigurationList;
\t\t\tbuildConfigurations = (
\t\t\t\t${projDebug} /* Debug */,
\t\t\t\t${projRelease} /* Release */,
\t\t\t);
\t\t\tdefaultConfigurationIsVisible = 0;
\t\t\tdefaultConfigurationName = Release;
\t\t};
\t\t${tgtConfigList} /* Build configuration list for PBXNativeTarget "${TARGET_NAME}" */ = {
\t\t\tisa = XCConfigurationList;
\t\t\tbuildConfigurations = (
\t\t\t\t${tgtDebug} /* Debug */,
\t\t\t\t${tgtRelease} /* Release */,
\t\t\t);
\t\t\tdefaultConfigurationIsVisible = 0;
\t\t\tdefaultConfigurationName = Release;
\t\t};
/* End XCConfigurationList section */
\t};
\trootObject = ${project} /* Project object */;
}
`;
}

function buildScheme(targetId) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Scheme LastUpgradeVersion = "1500" version = "1.7">
   <BuildAction parallelizeBuildables = "YES" buildImplicitDependencies = "YES">
      <BuildActionEntries>
         <BuildActionEntry buildForTesting = "YES" buildForRunning = "YES" buildForProfiling = "YES" buildForArchiving = "YES" buildForAnalyzing = "YES">
            <BuildableReference
               BuildableIdentifier = "primary"
               BlueprintIdentifier = "${targetId}"
               BuildableName = "${TARGET_NAME}.app"
               BlueprintName = "${TARGET_NAME}"
               ReferencedContainer = "container:PrintGate.xcodeproj">
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
            BlueprintIdentifier = "${targetId}"
            BuildableName = "${TARGET_NAME}.app"
            BlueprintName = "${TARGET_NAME}"
            ReferencedContainer = "container:PrintGate.xcodeproj">
         </BuildableReference>
      </BuildableProductRunnable>
   </LaunchAction>
   <ProfileAction buildConfiguration = "Release" shouldUseLaunchSchemeArgsEnv = "YES" savedToolIdentifier = "" useCustomWorkingDirectory = "NO" debugDocumentVersioning = "YES">
      <BuildableProductRunnable runnableDebuggingMode = "0">
         <BuildableReference
            BuildableIdentifier = "primary"
            BlueprintIdentifier = "${targetId}"
            BuildableName = "${TARGET_NAME}.app"
            BlueprintName = "${TARGET_NAME}"
            ReferencedContainer = "container:PrintGate.xcodeproj">
         </BuildableReference>
      </BuildableProductRunnable>
   </ProfileAction>
   <AnalyzeAction buildConfiguration = "Debug">
   </AnalyzeAction>
   <ArchiveAction buildConfiguration = "Release" revealArchiveInOrganizer = "YES">
   </ArchiveAction>
</Scheme>
`;
}

// ---------- 校验 ----------
function check(projectFile, pbxText) {
  const problems = [];
  const opens = (pbxText.match(/\{/g) || []).length;
  const closes = (pbxText.match(/\}/g) || []).length;
  if (opens !== closes) problems.push(`花括号不配对：${opens} 个 { / ${closes} 个 }`);
  if ((pbxText.match(/\(/g) || []).length !== (pbxText.match(/\)/g) || []).length) {
    problems.push('圆括号不配对');
  }

  // 所有被引用的 24 位 ID 必须有定义
  const defined = new Set();
  for (const m of pbxText.matchAll(/^\t\t([0-9A-F]{24})[^\n]*= \{/gm)) defined.add(m[1]);
  const referenced = new Set(pbxText.match(/[0-9A-F]{24}/g) || []);
  for (const id of referenced) if (!defined.has(id)) problems.push(`引用了不存在的对象：${id}`);
  if (!/rootObject = [0-9A-F]{24}/.test(pbxText)) problems.push('缺 rootObject');

  // 源文件是否都在工程里
  for (const name of SWIFT_SOURCES) {
    const p = path.join(IOS, 'App', name);
    if (!fs.existsSync(p)) problems.push(`缺源文件：App/${name}`);
    if (!pbxText.includes(`path = ${name};`)) problems.push(`工程里没登记源文件：${name}`);
  }
  if (!fs.existsSync(INFO_PLIST)) problems.push('缺 App/Info.plist');
  if (!fs.existsSync(SCHEME)) problems.push('缺共享 scheme');
  if (!pbxText.includes(`INFOPLIST_FILE = App/Info.plist;`)) problems.push('没设置 INFOPLIST_FILE');

  return problems;
}

// ---------- 主流程 ----------
function main() {
  const checkOnly = process.argv.includes('--check');

  if (checkOnly) {
    if (!fs.existsSync(PBXPROJ)) {
      console.error('✗ 没有 ios/PrintGate.xcodeproj/project.pbxproj');
      process.exit(1);
    }
    const problems = check(PBXPROJ, fs.readFileSync(PBXPROJ, 'utf8'));
    if (problems.length) {
      console.error('✗ 工程文件有问题：');
      for (const p of problems) console.error('   - ' + p);
      process.exit(1);
    }
    console.log('✓ 工程文件校验通过');
    return;
  }

  if (!fs.existsSync(path.join(IOS, 'App'))) {
    console.error('✗ 找不到 ios/App');
    process.exit(1);
  }

  // 先生成 pbxproj 拿到 target id，scheme 要引用它
  const pbx = buildPbxproj();
  const targetId = pbx.match(/targets = \(\n\t\t\t\t([0-9A-F]{24})/)[1];

  fs.writeFileSync(INFO_PLIST, INFO_PLIST_XML, 'utf8');
  fs.mkdirSync(path.join(PROJ_DIR, 'project.xcworkspace'), { recursive: true });
  fs.mkdirSync(path.dirname(SCHEME), { recursive: true });
  fs.writeFileSync(SCHEME, buildScheme(targetId), 'utf8');
  fs.writeFileSync(path.join(PROJ_DIR, 'project.xcworkspace', 'contents.xcworkspacedata'), `<?xml version="1.0" encoding="UTF-8"?>
<Workspace version = "1.0">
   <FileRef location = "self:">
   </FileRef>
</Workspace>
`, 'utf8');
  fs.writeFileSync(PBXPROJ, pbx, 'utf8');

  console.log('✓ ios/App/Info.plist');
  console.log('✓ ios/PrintGate.xcodeproj/project.pbxproj');
  console.log('✓ ios/PrintGate.xcodeproj/xcshareddata/xcschemes/PrintGate.xcscheme');

  const problems = check(PBXPROJ, pbx);
  if (problems.length) {
    console.error('✗ 生成后自检失败：');
    for (const p of problems) console.error('   - ' + p);
    process.exit(1);
  }
  console.log('✓ 自检通过（括号配对 / 引用完整 / 源文件齐全）');
}

main();
