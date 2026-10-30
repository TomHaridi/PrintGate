import SwiftUI
import DesignFoundation

struct AdminUsersView: View {
    @Environment(\.dfTheme) private var theme

    @State private var users: [PgUser] = []
    @State private var loading = true
    @State private var status = "all"
    @State private var query = ""
    @State private var busyId: Int?
    @State private var confirm: (PgUser, String)?

    private let filters: [SegOption] = [
        SegOption("all", "全部"),
        SegOption("pending", "待审批"),
        SegOption("approved", "已通过"),
        SegOption("blocked", "已禁用"),
    ]

    var body: some View {
        VStack(spacing: 0) {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(filters) { f in
                        Button {
                            status = f.id
                            Task { await load() }
                        } label: {
                            DFChip(.selectable(f.title), isSelected: status == f.id)
                        }
                        .buttonStyle(.plain)
                    }
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 8)
            }

            if loading && users.isEmpty {
                VStack(spacing: 10) {
                    DFSkeleton().frame(height: 76)
                    DFSkeleton().frame(height: 76)
                }
                .padding(16)
                Spacer()
            } else if users.isEmpty {
                Spacer()
                EmptyHint(icon: "person.2", title: "没有用户", message: "换个筛选，或确认搜索词")
                Spacer()
            } else {
                ScrollView {
                    LazyVStack(spacing: 10) {
                        ForEach(users) { u in
                            userCard(u)
                        }
                    }
                    .padding(.horizontal, 14)
                    .safeBottomPadding()
                }
                .refreshable { await load() }
            }
        }
        .screenBackground()
        .dfNavigationBar(title: "用户管理", displayMode: .inline)
        .searchable(text: $query, prompt: "搜索昵称 / 账号 / 手机")
        .onSubmit(of: .search) { Task { await load() } }
        .task { await load() }
        .dfAlert(
            isPresented: Binding(get: { confirm != nil }, set: { if !$0 { confirm = nil } }),
            configuration: DFAlertConfiguration(
                title: confirmTitle,
                message: "操作立即生效，可在审计日志里追溯。",
                actions: [
                    DFAlertAction(title: "取消", role: .cancel),
                    DFAlertAction(title: "确定", role: confirmRole) {
                        if let c = confirm { Task { await act(c.0, c.1) } }
                    },
                ]
            )
        )
    }

    private var confirmRole: DFAlertActionRole? {
        guard let c = confirm else { return nil }
        return (c.1 == "delete" || c.1 == "block") ? .destructive : nil
    }

    private var confirmTitle: String {
        guard let c = confirm else { return "" }
        switch c.1 {
        case "approve": return "通过 \(c.0.displayName) 的申请？"
        case "reject": return "拒绝 \(c.0.displayName) 的申请？"
        case "block": return "禁用 \(c.0.displayName)？"
        case "unblock": return "恢复 \(c.0.displayName)？"
        case "delete": return "删除 \(c.0.displayName)？"
        default: return "确定操作？"
        }
    }

    private func userCard(_ u: PgUser) -> some View {
        DFCard {
            VStack(alignment: .leading, spacing: 10) {
                HStack(spacing: 12) {
                    DFAvatar(u.initials, size: 40)
                    VStack(alignment: .leading, spacing: 3) {
                        HStack(spacing: 6) {
                            DFText(u.displayName, scale: .body)
                            if u.isAdmin {
                                StatusBadge(text: "管理员", color: theme.colors.primary)
                            }
                            StatusBadge(text: u.statusText, color: u.statusTint)
                        }
                        DFText("@\(u.username.isEmpty ? "—" : u.username) · ID \(u.id)", scale: .caption)
                            .dfTextViewStyle(.secondary)
                    }
                    Spacer()
                    if busyId == u.id {
                        ProgressView().controlSize(.small)
                    }
                }

                if !u.phone.isEmpty || !u.realName.isEmpty || !u.applyNote.isEmpty {
                    VStack(alignment: .leading, spacing: 3) {
                        if !u.realName.isEmpty {
                            DFText("姓名：\(u.realName)", scale: .caption).dfTextViewStyle(.secondary)
                        }
                        if !u.phone.isEmpty {
                            DFText("手机：\(u.phone)", scale: .caption).dfTextViewStyle(.secondary)
                        }
                        if !u.applyNote.isEmpty {
                            DFText("申请说明：\(u.applyNote)", scale: .caption).dfTextViewStyle(.secondary)
                        }
                    }
                }

                HStack(spacing: 8) {
                    if u.pending {
                        DFButton("通过") { confirm = (u, "approve") }.dfButtonStyle(.tinted)
                        DFButton("拒绝") { confirm = (u, "reject") }.dfButtonStyle(.outlined)
                    } else if u.blocked {
                        DFButton("恢复") { confirm = (u, "unblock") }.dfButtonStyle(.outlined)
                    } else if !u.isAdmin {
                        DFButton("禁用") { confirm = (u, "block") }.dfButtonStyle(.ghost)
                    }
                    Spacer()
                    DFText(Fmt.relative(u.createdAt), scale: .caption).dfTextViewStyle(.muted)
                }
            }
        }
    }

    private func load() async {
        do {
            users = try await API().adminUsers(status: status, q: query)
        } catch {
            DFToastQueue.shared.show(text: pgMessage(error), severity: .error)
        }
        loading = false
    }

    private func act(_ u: PgUser, _ action: String) async {
        confirm = nil
        busyId = u.id
        do {
            try await API().adminUserAction(u.id, action)
            DFToastQueue.shared.show(text: "已\(actionText(action))", severity: .success)
            await load()
        } catch {
            DFToastQueue.shared.show(text: pgMessage(error), severity: .error)
        }
        busyId = nil
    }

    private func actionText(_ a: String) -> String {
        switch a {
        case "approve": return "通过"
        case "reject": return "拒绝"
        case "block": return "禁用"
        case "unblock": return "恢复"
        case "delete": return "删除"
        default: return "处理"
        }
    }
}
