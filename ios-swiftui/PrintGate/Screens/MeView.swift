import SwiftUI
import UIKit
import PhotosUI
import DesignFoundation

struct MeView: View {
    @Environment(AppModel.self) private var app
    @Environment(Store.self) private var store
    @Environment(\.dfTheme) private var theme

    @State private var showTheme = false
    @State private var showServer = false
    @State private var showProfile = false
    @State private var showPassword = false
    @State private var showBind = false
    @State private var showQrLogin = false
    @State private var showLogout = false
    @State private var serverVersion = ""

    private var user: PgUser { app.user }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 14) {
                    profileCard

                    if user.pending {
                        DFBanner(icon: "hourglass", message: "账号还在等管理员审批，审批通过后才能打印。", severity: .warning, isDismissible: false, onDismiss: {})
                    }

                    if app.isAdmin {
                        adminEntry
                    }

                    settingsCard
                    aboutCard

                    DFButton("退出登录", style: .outlined, role: .destructive) {
                        showLogout = true
                    }
                    .padding(.top, 4)
                }
                .padding(.horizontal, 14)
                .padding(.top, 8)
                .padding(.bottom, 24)
            }
            .screenBackground()
            .dfNavigationBar(title: "我的", displayMode: .large)
            .task { await refreshVersion() }
            .dfSheet(isPresented: $showTheme) { ThemeSheet() }
            .dfSheet(isPresented: $showServer) { ServerSheet { _ in } }
            .dfSheet(isPresented: $showProfile) { ProfileSheet() }
            .dfSheet(isPresented: $showPassword) { PasswordSheet() }
            .dfSheet(isPresented: $showBind) { BindSheet() }
            .dfSheet(isPresented: $showQrLogin) {
                ScanSheet(title: "扫码登录网页", hint: "对着网页上的登录二维码") { code in
                    Task { await confirmLogin(code) }
                }
            }
            .dfAlert(
                isPresented: $showLogout,
                configuration: DFAlertConfiguration(
                    title: "退出登录",
                    message: "需要重新输入账号密码才能继续使用。",
                    actions: [
                        DFAlertAction(title: "取消", role: .cancel),
                        DFAlertAction(title: "退出", role: .destructive) { app.logout() },
                    ]
                )
            )
        }
    }

    // MARK: 资料卡

    private var profileCard: some View {
        DFCard {
            VStack(spacing: 12) {
                HStack(spacing: 14) {
                    avatar
                    VStack(alignment: .leading, spacing: 4) {
                        HStack(spacing: 6) {
                            DFText(user.displayName, scale: .headline)
                            if app.isAdmin {
                                StatusBadge(text: "管理员", color: theme.colors.primary)
                            }
                        }
                        DFText(user.username.isEmpty ? "未设置账号" : "@\(user.username)", scale: .caption)
                            .dfTextViewStyle(.secondary)
                        if !user.profileDone {
                            DFText("资料未完善", scale: .caption)
                                .foregroundStyle(theme.colors.warning)
                        }
                    }
                    Spacer()
                    Button {
                        showProfile = true
                    } label: {
                        DFIcon("square.and.pencil", size: 18)
                            .foregroundStyle(theme.colors.textSecondary)
                    }
                    .buttonStyle(.plain)
                }

                Divider().opacity(0.5)

                HStack(spacing: 0) {
                    miniStat("状态", user.statusText, user.statusTint)
                    Divider().frame(height: 26).opacity(0.5)
                    miniStat("角色", app.isAdmin ? "管理员" : "普通用户", theme.colors.textPrimary)
                    Divider().frame(height: 26).opacity(0.5)
                    miniStat("最近登录", user.lastLogin.isEmpty ? "—" : Fmt.relative(user.lastLogin), theme.colors.textPrimary)
                }
            }
        }
    }

    private var avatar: some View {
        Group {
            if let url = URL(string: avatarURL), !user.avatar.isEmpty {
                AsyncImage(url: url) { phase in
                    if let img = phase.image {
                        img.resizable().scaledToFill()
                    } else {
                        DFAvatar(user.initials, size: 56)
                    }
                }
                .frame(width: 56, height: 56)
                .clipShape(Circle())
            } else {
                DFAvatar(user.initials, size: 56)
            }
        }
    }

    private var avatarURL: String {
        guard !user.avatar.isEmpty else { return "" }
        if user.avatar.hasPrefix("http") { return user.avatar }
        return store.baseUrl + (user.avatar.hasPrefix("/") ? "" : "/") + user.avatar
    }

    private func miniStat(_ label: String, _ value: String, _ color: Color) -> some View {
        VStack(spacing: 3) {
            DFText(value, scale: .bodySmall).foregroundStyle(color)
            DFText(label, scale: .caption).dfTextViewStyle(.secondary)
        }
        .frame(maxWidth: .infinity)
    }

    // MARK: 管理台入口

    private var adminEntry: some View {
        NavigationLink {
            AdminHomeView()
        } label: {
            DFCard {
                HStack(spacing: 12) {
                    ZStack {
                        RoundedRectangle(cornerRadius: 10)
                            .fill(theme.colors.primary.opacity(0.13))
                            .frame(width: 40, height: 40)
                        DFIcon("gauge.with.needle.fill", size: 19)
                            .foregroundStyle(theme.colors.primary)
                    }
                    VStack(alignment: .leading, spacing: 2) {
                        DFText("管理台", scale: .body)
                        DFText("用户审批 · 打印队列 · 打印机 · 服务端开关", scale: .caption)
                            .dfTextViewStyle(.secondary)
                    }
                    Spacer()
                    DFIcon("chevron.right", size: 13)
                        .foregroundStyle(theme.colors.textSecondary)
                }
            }
        }
        .buttonStyle(.plain)
    }

    // MARK: 设置

    private var settingsCard: some View {
        DFCard {
            VStack(spacing: 2) {
                row("person.text.rectangle", "个人资料", user.profileDone ? "" : "待完善") { showProfile = true }
                divider
                row("key", "修改密码", "") { showPassword = true }
                divider
                row("link", "绑定管理员", app.isAdmin ? "已绑定" : "") { showBind = true }
                divider
                row("qrcode.viewfinder", "扫码登录网页后台", "") { showQrLogin = true }
                divider
                row("server.rack", "服务器地址", store.baseUrl.replacingOccurrences(of: "http://", with: "")) { showServer = true }
                divider
                row("paintpalette", "外观", AppTheme(rawValue: store.themeID)?.title ?? "青竹（默认）") { showTheme = true }
            }
        }
    }

    private var divider: some View {
        Divider().opacity(0.4)
    }

    private func row(_ icon: String, _ title: String, _ value: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 12) {
                DFIcon(icon, size: 17)
                    .foregroundStyle(theme.colors.textSecondary)
                    .frame(width: 22)
                DFText(title, scale: .body)
                    .foregroundStyle(theme.colors.textPrimary)
                Spacer()
                if !value.isEmpty {
                    DFText(value, scale: .caption)
                        .dfTextViewStyle(.secondary)
                        .lineLimit(1)
                }
                DFIcon("chevron.right", size: 12)
                    .foregroundStyle(theme.colors.textSecondary)
            }
            .padding(.vertical, 11)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    // MARK: 关于

    private var aboutCard: some View {
        DFCard {
            VStack(alignment: .leading, spacing: 8) {
                InfoRow(icon: "app.badge", label: "客户端版本", value: appVersion)
                InfoRow(icon: "server.rack", label: "服务端版本", value: serverVersion.isEmpty ? "—" : serverVersion)
                InfoRow(icon: "lock.shield", label: "令牌", value: store.hasToken ? "已登录" : "未登录")
            }
        }
    }

    private var appVersion: String {
        let v = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "1.0"
        let b = Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "1"
        return "\(v) (\(b))"
    }

    // MARK: 动作

    private func refreshVersion() async {
        await app.refreshMe()
        if let d = try? await API().health() {
            serverVersion = pgStr(d["version"])
        }
    }

    private func confirmLogin(_ code: String) async {
        let ticket = code.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !ticket.isEmpty else { return }
        do {
            try await API().qrScan(ticket)
            try await API().qrConfirm(ticket)
            DFToastQueue.shared.show(text: "网页已登录", severity: .success)
        } catch {
            DFToastQueue.shared.show(text: pgMessage(error), severity: .error)
        }
    }
}

// MARK: - 个人资料

struct ProfileSheet: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dfTheme) private var theme
    @Environment(\.dismiss) private var dismiss

    @State private var nickname = ""
    @State private var phone = ""
    @State private var realName = ""
    @State private var wechatId = ""
    @State private var busy = false
    @State private var error = ""
    @State private var photoItem: PhotosPickerItem?
    @State private var showPhoto = false

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    DFCard {
                        VStack(alignment: .leading, spacing: 12) {
                            DFTextField("昵称（必填）", text: $nickname, placeholder: "昵称")
                            DFTextField("手机号", text: $phone, placeholder: "手机号")
                                .keyboardType(.phonePad)
                            DFTextField("真实姓名", text: $realName, placeholder: "真实姓名")
                            DFTextField("微信号", text: $wechatId, placeholder: "微信号")

                            if !error.isEmpty {
                                DFText(error, scale: .caption).foregroundStyle(theme.colors.destructive)
                            }

                            DFButton(busy ? "保存中…" : "保存") {
                                Task { await save() }
                            }
                            .disabled(busy || nickname.trimmingCharacters(in: .whitespaces).isEmpty)
                        }
                    }

                    DFCard {
                        HStack {
                            DFText("头像", scale: .body)
                            Spacer()
                            DFButton("从相册选择") { showPhoto = true }
                                .dfButtonStyle(.outlined)
                        }
                    }
                }
                .padding(16)
            }
            .screenBackground()
            .dfNavigationBar(title: "个人资料", displayMode: .inline) {
                DFButton("关闭") { dismiss() }.dfButtonStyle(.ghost)
            }
            .photosPicker(isPresented: $showPhoto, selection: $photoItem, matching: .images)
            .onChange(of: photoItem) { _, item in
                Task { await uploadAvatar(item) }
            }
            .onAppear {
                nickname = app.user.nickname
                phone = app.user.phone
                realName = app.user.realName
                wechatId = app.user.wechatId
            }
        }
    }

    private func save() async {
        busy = true
        error = ""
        do {
            let u = try await API().saveProfile([
                "nickname": nickname.trimmingCharacters(in: .whitespaces),
                "phone": phone,
                "real_name": realName,
                "wechat_id": wechatId,
            ])
            app.me?.user = u
            DFToastQueue.shared.show(text: "已保存", severity: .success)
            dismiss()
        } catch {
            self.error = pgMessage(error)
        }
        busy = false
    }

    private func uploadAvatar(_ item: PhotosPickerItem?) async {
        guard let item, let data = try? await item.loadTransferable(type: Data.self) else { return }
        do {
            let u = try await API().uploadAvatar(data)
            app.me?.user = u
            DFToastQueue.shared.show(text: "头像已更新", severity: .success)
        } catch {
            DFToastQueue.shared.show(text: pgMessage(error), severity: .error)
        }
        photoItem = nil
    }
}

// MARK: - 修改密码

struct PasswordSheet: View {
    @Environment(\.dfTheme) private var theme
    @Environment(\.dismiss) private var dismiss

    @State private var old = ""
    @State private var new = ""
    @State private var confirm = ""
    @State private var busy = false
    @State private var error = ""

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    DFCard {
                        VStack(alignment: .leading, spacing: 12) {
                            DFSecureField("当前密码", text: $old, placeholder: "当前密码")
                            DFSecureField("新密码", text: $new, placeholder: "新密码（至少 6 位）")
                            DFSecureField("确认新密码", text: $confirm, placeholder: "再输入一次")

                            if !error.isEmpty {
                                DFText(error, scale: .caption).foregroundStyle(theme.colors.destructive)
                            }

                            DFButton(busy ? "提交中…" : "确认修改") {
                                Task { await submit() }
                            }
                            .disabled(busy || old.isEmpty || new.isEmpty)
                        }
                    }
                }
                .padding(16)
            }
            .screenBackground()
            .dfNavigationBar(title: "修改密码", displayMode: .inline) {
                DFButton("关闭") { dismiss() }.dfButtonStyle(.ghost)
            }
        }
    }

    private func submit() async {
        guard new == confirm else {
            error = "两次输入的新密码不一致"
            return
        }
        guard new.count >= 6 else {
            error = "新密码至少 6 位"
            return
        }
        busy = true
        error = ""
        do {
            try await API().changePassword(old, new)
            DFToastQueue.shared.show(text: "密码已修改", severity: .success)
            dismiss()
        } catch {
            self.error = pgMessage(error)
        }
        busy = false
    }
}

// MARK: - 绑定管理员

struct BindSheet: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dfTheme) private var theme
    @Environment(\.dismiss) private var dismiss

    @State private var token = ""
    @State private var busy = false
    @State private var error = ""
    @State private var showScan = false

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    DFCard {
                        VStack(alignment: .leading, spacing: 12) {
                            DFText("把网页后台「我的 → 绑定移动端」里的绑定码贴进来，或直接扫那个二维码。绑定后这个账号就能在 App 里管理后台。", scale: .caption)
                                .dfTextViewStyle(.secondary)
                            DFTextField("绑定码", text: $token, placeholder: "粘贴绑定码")
                                .textInputAutocapitalization(.never)
                                .autocorrectionDisabled()

                            if !error.isEmpty {
                                DFText(error, scale: .caption).foregroundStyle(theme.colors.destructive)
                            }

                            HStack(spacing: 10) {
                                DFButton(busy ? "绑定中…" : "绑定") { Task { await bind() } }
                                    .disabled(busy || token.isEmpty)
                                DFButton("扫码") { showScan = true }
                                    .dfButtonStyle(.outlined)
                                Spacer()
                            }
                        }
                    }
                }
                .padding(16)
            }
            .screenBackground()
            .dfNavigationBar(title: "绑定管理员", displayMode: .inline) {
                DFButton("关闭") { dismiss() }.dfButtonStyle(.ghost)
            }
            .dfSheet(isPresented: $showScan) {
                ScanSheet(title: "扫描绑定码") { code in
                    token = code
                    Task { await bind() }
                }
            }
        }
    }

    private func bind() async {
        busy = true
        error = ""
        do {
            _ = try await API().bindAdmin(token.trimmingCharacters(in: .whitespacesAndNewlines))
            await app.refreshMe()
            DFToastQueue.shared.show(text: "绑定成功", severity: .success)
            dismiss()
        } catch {
            self.error = pgMessage(error)
        }
        busy = false
    }
}
