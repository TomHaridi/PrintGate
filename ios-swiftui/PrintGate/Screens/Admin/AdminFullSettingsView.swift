import SwiftUI
import DesignFoundation

/// 完整后台设置：用网页后台的管理密码换 admin 令牌，然后动态渲染 `/api/settings`
/// 的全部键。后端加字段，App 不用发版。
struct AdminFullSettingsView: View {
    @Environment(\.dfTheme) private var theme

    @State private var unlocked = false
    @State private var password = ""
    @State private var adminToken = ""
    @State private var settings: [String: Any] = [:]
    @State private var original: [String: Any] = [:]
    @State private var loading = false
    @State private var saving = false
    @State private var error = ""
    @State private var editKey: String?
    @State private var editText = ""
    @State private var office: [String: Any] = [:]
    @State private var officeBusy = false

    private var keys: [String] {
        settings.keys.sorted()
    }

    var body: some View {
        ScrollView {
            VStack(spacing: 14) {
                if !unlocked {
                    lockCard
                } else {
                    officeCard
                    settingsCards
                    if !error.isEmpty {
                        DFBanner(icon: "exclamationmark.triangle.fill", message: error, severity: .error, isDismissible: false, onDismiss: {})
                    }
                    DFButton(saving ? "保存中…" : "保存全部改动") {
                        Task { await saveAll() }
                    }
                    .disabled(saving || loading)
                    DFText("这些是服务端全部可配置项，改动立即生效。", scale: .caption).dfTextViewStyle(.secondary)
                }
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
        }
        .screenBackground()
        .dfNavigationBar(title: "完整后台设置", displayMode: .inline)
        .dfSheet(isPresented: Binding(get: { editKey != nil }, set: { if !$0 { editKey = nil } })) {
            editSheet
        }
    }

    // MARK: 解锁

    private var lockCard: some View {
        DFCard {
            VStack(alignment: .leading, spacing: 12) {
                HStack(spacing: 8) {
                    DFIcon("lock.shield.fill", size: 18).foregroundStyle(theme.colors.primary)
                    DFText("需要后台管理密码", scale: .labelLarge)
                }
                DFText("这里改的是网页后台的全部配置（含仅管理员可见的项），所以要再确认一次身份。密码只用于换一次令牌，不会保存在手机上。", scale: .caption)
                    .dfTextViewStyle(.secondary)
                DFSecureField("后台管理密码", text: $password, placeholder: "后台管理密码")
                if !error.isEmpty {
                    DFText(error, scale: .caption).foregroundStyle(theme.colors.destructive)
                }
                DFButton(loading ? "验证中…" : "解锁") {
                    Task { await unlock() }
                }
                .disabled(loading || password.isEmpty)
            }
        }
    }

    // MARK: Office

    private var officeCard: some View {
        DFCard {
            VStack(alignment: .leading, spacing: 10) {
                HStack(spacing: 8) {
                    DFIcon("doc.badge.gearshape", size: 16).foregroundStyle(theme.colors.primary)
                    DFText("Office 转换组件", scale: .labelLarge)
                    Spacer()
                    StatusBadge(text: pgBool(office["available"]) ? "已安装" : "未安装",
                                color: pgBool(office["available"]) ? .green : .orange)
                }
                DFText("Word / Excel / PPT 转 PDF 依赖 LibreOffice。镜像默认不内置，按需一键安装，安装包会缓存在数据卷里。", scale: .caption)
                    .dfTextViewStyle(.secondary)
                if !pgStr(office["version"]).isEmpty {
                    DFText("版本 \(pgStr(office["version"]))", scale: .caption).dfTextViewStyle(.secondary)
                }
                HStack(spacing: 10) {
                    DFButton(officeBusy ? "安装中…" : (pgBool(office["available"]) ? "重新安装" : "一键安装")) {
                        Task { await installOffice() }
                    }
                    .dfButtonStyle(.outlined)
                    .disabled(officeBusy)
                    DFButton("刷新状态") { Task { await loadOffice() } }
                        .dfButtonStyle(.ghost)
                        .disabled(officeBusy)
                }
                if officeBusy {
                    DFProgressBar(variant: .indeterminate)
                }
            }
        }
    }

    // MARK: 动态表单

    private var settingsCards: some View {
        VStack(spacing: 10) {
            if loading {
                DFSkeleton().frame(height: 120)
            } else {
                ForEach(groupedKeys.indices, id: \.self) { i in
                    let group = groupedKeys[i]
                    AnyView(
                        DFCard {
                            VStack(alignment: .leading, spacing: 6) {
                                DFText(group.0, scale: .label).dfTextViewStyle(.secondary)
                                    .padding(.bottom, 2)
                                ForEach(group.1, id: \.self) { key in
                                    row(key)
                                }
                            }
                        }
                    )
                }
            }
        }
    }

    /// 按前缀分组（print.* / auth.* 之类），没有点的归到「其他」
    private var groupedKeys: [(String, [String])] {
        var buckets: [String: [String]] = [:]
        for k in keys {
            let group = k.contains(".") ? String(k.split(separator: ".")[0]) : "其他"
            buckets[group, default: []].append(k)
        }
        return buckets.sorted { $0.key < $1.key }.map { ($0.key, $0.value.sorted()) }
    }

    /// 返回 AnyView 擦除类型：本页会按 /api/settings 动态渲染几十个设置项，
    /// 若每项的具体类型都内联进 ForEach 的 TupleView，实例化时极易栈溢出。
    private func row(_ key: String) -> AnyView {
        let value = settings[key]
        if let b = value as? Bool {
            return AnyView(
                DFToggle(label(key), isOn: Binding(
                    get: { settings[key] as? Bool ?? b },
                    set: { settings[key] = $0 }
                ))
                .padding(.vertical, 2)
            )
        }
        if let n = value as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID() {
            return AnyView(EditableRow(label: label(key), value: "\(n)") {
                editText = "\(n)"
                editKey = key
            })
        }
        if let s = value as? String {
            return AnyView(EditableRow(label: label(key), value: s.isEmpty ? "（空）" : s) {
                editText = s
                editKey = key
            })
        }
        if value is [Any] || value is [String: Any] {
            return AnyView(EditableRow(label: label(key), value: "复杂值，App 内不改") { })
        }
        return AnyView(EditableRow(label: label(key), value: pgStr(value)) {
            editText = pgStr(value)
            editKey = key
        })
    }

    /// `maxCopies` → `maxCopies`，保持原文（配置键国际化没意义，但把驼峰拆开更好读）
    private func label(_ key: String) -> String {
        key
    }

    private var editSheet: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 14) {
                DFText(editKey ?? "", scale: .caption).dfTextViewStyle(.secondary)
                DFTextField("值", text: $editText, placeholder: "值")
                    .keyboardType(.default)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                HStack(spacing: 10) {
                    DFButton("保存") {
                        if let k = editKey {
                            if let n = Int(editText.trimmingCharacters(in: .whitespaces)) {
                                settings[k] = n
                            } else {
                                settings[k] = editText
                            }
                        }
                        editKey = nil
                    }
                    DFButton("取消") { editKey = nil }.dfButtonStyle(.ghost)
                    Spacer()
                }
                Spacer()
            }
            .padding(16)
            .screenBackground()
            .dfNavigationBar(title: "修改", displayMode: .inline)
        }
    }

    // MARK: 网络

    private func unlock() async {
        loading = true
        error = ""
        do {
            adminToken = try await API().adminLogin(password)
            password = ""
            unlocked = true
            await loadSettings()
            await loadOffice()
        } catch {
            self.error = pgMessage(error)
        }
        loading = false
    }

    private func loadSettings() async {
        loading = true
        do {
            let s = try await API(adminToken: adminToken).fullSettings()
            var clean: [String: Any] = [:]
            for (k, v) in s {
                if v is [Any] || v is [String: Any] { continue }
                clean[k] = v
            }
            settings = clean
            original = clean
            error = ""
        } catch {
            self.error = pgMessage(error)
        }
        loading = false
    }

    private func loadOffice() async {
        officeBusy = true
        do {
            office = try await API(adminToken: adminToken).officeStatus()
        } catch {
            DFToastQueue.shared.show(text: pgMessage(error), severity: .error)
        }
        officeBusy = false
    }

    private func installOffice() async {
        officeBusy = true
        do {
            _ = try await API(adminToken: adminToken).officeInstall()
            DFToastQueue.shared.show(text: "已开始安装，稍后刷新状态", severity: .info)
        } catch {
            DFToastQueue.shared.show(text: pgMessage(error), severity: .error)
        }
        officeBusy = false
    }

    private func saveAll() async {
        saving = true
        error = ""
        var patch: [String: Any] = [:]
        for (k, v) in settings where !valuesEqual(v, original[k]) {
            patch[k] = v
        }
        guard !patch.isEmpty else {
            DFToastQueue.shared.show(text: "没有改动", severity: .info)
            saving = false
            return
        }
        do {
            try await API(adminToken: adminToken).saveFullSettings(patch)
            original = settings
            DFToastQueue.shared.show(text: "已保存 \(patch.count) 项", severity: .success)
        } catch {
            self.error = pgMessage(error)
        }
        saving = false
    }

    private func valuesEqual(_ a: Any?, _ b: Any?) -> Bool {
        switch (a, b) {
        case let (x as Bool, y as Bool): return x == y
        case let (x as NSNumber, y as NSNumber): return x.doubleValue == y.doubleValue
        case let (x as String, y as String): return x == y
        case (nil, nil): return true
        default: return false
        }
    }
}
