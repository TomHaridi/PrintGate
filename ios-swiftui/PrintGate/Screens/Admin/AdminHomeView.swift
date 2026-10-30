import SwiftUI
import DesignFoundation

struct AdminHomeView: View {
    @Environment(\.dfTheme) private var theme

    @State private var overview: [String: Any] = [:]
    @State private var printers: [[String: Any]] = []
    @State private var loading = true
    @State private var error = ""

    var body: some View {
        ScrollView {
            VStack(spacing: 14) {
                if loading {
                    HStack(spacing: 10) {
                        ProgressView().controlSize(.small)
                        DFText("读取概览…", scale: .caption).dfTextViewStyle(.secondary)
                        Spacer()
                    }
                    .padding(.horizontal, 4)
                } else if !error.isEmpty {
                    DFBanner(icon: "exclamationmark.triangle.fill", message: error, severity: .error, isDismissible: false, onDismiss: {})
                }

                // AnyView 擦除：本页曾因内联 6 张统计卡 + 5 个导航项 + 2 张信息卡，
                // 在 push 时计算 preference 递归爆栈（SIGSEGV, excessive recursion）。
                AnyView(
                    LazyVGrid(columns: [GridItem(.flexible(), spacing: 10), GridItem(.flexible(), spacing: 10)], spacing: 10) {
                        stat("待审批用户", pgInt(overview["pendingUsers"]), "person.badge.clock", .orange)
                        stat("待审批任务", pgInt(overview["pendingTasks"]), "doc.badge.clock", .orange)
                        stat("打印中", pgInt(overview["printing"]), "printer.fill", .teal)
                        stat("今日任务", pgInt(overview["todayTasks"]), "calendar", theme.colors.primary)
                        stat("用户总数", pgInt(overview["totalUsers"]), "person.2.fill", .blue)
                        stat("文件总数", pgInt(overview["files"]), "folder.fill", .purple)
                    }
                )

                AnyView(
                    DFCard {
                        VStack(spacing: 2) {
                            nav("用户管理", "person.2.fill", "审批 · 封禁 · 删除") { AdminUsersView() }
                            Divider().opacity(0.4)
                            nav("打印队列", "list.bullet.rectangle", "审批任务 · 清理历史") { AdminTasksView() }
                            Divider().opacity(0.4)
                            nav("打印机", "printer.fill", "\(printers.count) 台 · 暂停 / 恢复 / 设默认") { AdminPrintersView() }
                            Divider().opacity(0.4)
                            nav("常用设置", "slider.horizontal.3", "限额 · 审批开关 · 默认打印机") { AdminSettingsView() }
                            Divider().opacity(0.4)
                            nav("完整后台设置", "gearshape.2.fill", "需后台密码 · 全部开关") { AdminFullSettingsView() }
                        }
                    }
                )

                AnyView(
                    DFCard {
                        VStack(alignment: .leading, spacing: 8) {
                            InfoRow(icon: "checkmark.seal", label: "CUPS 状态", value: pgBool(overview["cupsOk"]) ? "正常" : "异常")
                            InfoRow(icon: "printer", label: "打印机数量", value: "\(printers.count)")
                        }
                    }
                )
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
        }
        .screenBackground()
        .dfNavigationBar(title: "管理台", displayMode: .inline)
        .task { await load() }
        .refreshable { await load() }
    }

    private func stat(_ label: String, _ value: Int, _ icon: String, _ tint: Color) -> some View {
        DFCard {
            VStack(alignment: .leading, spacing: 6) {
                HStack {
                    DFIcon(icon, size: 15).foregroundStyle(tint)
                    Spacer()
                }
                DFText("\(value)", scale: .title)
                DFText(label, scale: .caption).dfTextViewStyle(.secondary)
            }
        }
    }

    private func nav<Destination: View>(_ title: String, _ icon: String, _ subtitle: String, @ViewBuilder destination: () -> Destination) -> some View {
        NavigationLink {
            destination()
        } label: {
            HStack(spacing: 12) {
                DFIcon(icon, size: 17)
                    .foregroundStyle(theme.colors.textSecondary)
                    .frame(width: 22)
                VStack(alignment: .leading, spacing: 2) {
                    DFText(title, scale: .body).foregroundStyle(theme.colors.textPrimary)
                    DFText(subtitle, scale: .caption).dfTextViewStyle(.secondary)
                }
                Spacer()
                DFIcon("chevron.right", size: 12).foregroundStyle(theme.colors.textSecondary)
            }
            .padding(.vertical, 11)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private func load() async {
        do {
            let r = try await API().adminOverview()
            overview = r.overview
            printers = r.printers
            error = ""
        } catch {
            self.error = pgMessage(error)
        }
        loading = false
    }
}
