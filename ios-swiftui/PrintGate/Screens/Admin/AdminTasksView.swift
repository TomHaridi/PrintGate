import SwiftUI
import DesignFoundation

struct AdminTasksView: View {
    @Environment(\.dfTheme) private var theme

    @State private var tasks: [PgTask] = []
    @State private var loading = true
    @State private var status = "pending"
    @State private var busyId: Int?
    @State private var showCleanup = false
    @State private var cleanupStatus = ""

    private let filters: [SegOption] = [
        SegOption("pending", "待审批"),
        SegOption("printing", "打印中"),
        SegOption("done", "已完成"),
        SegOption("failed", "失败"),
        SegOption("all", "全部"),
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

            if loading && tasks.isEmpty {
                VStack(spacing: 10) {
                    DFSkeleton().frame(height: 76)
                    DFSkeleton().frame(height: 76)
                }
                .padding(16)
                Spacer()
            } else if tasks.isEmpty {
                Spacer()
                EmptyHint(icon: "tray", title: "队列是空的", message: "这个状态下没有任务")
                Spacer()
            } else {
                ScrollView {
                    LazyVStack(spacing: 10) {
                        ForEach(tasks) { t in
                            taskCard(t)
                        }
                    }
                    .padding(.horizontal, 14)
                    .padding(.bottom, 16)
                }
                .refreshable { await load() }
            }
        }
        .screenBackground()
        .dfNavigationBar(title: "打印队列", displayMode: .inline) {
            Button {
                showCleanup = true
            } label: {
                DFIcon("trash", size: 17)
            }
        }
        .task { await load() }
        .dfAlert(
            isPresented: $showCleanup,
            configuration: DFAlertConfiguration(
                title: "清理历史任务",
                message: cleanupStatus.isEmpty ? "删除已结束的任务记录（不影响文件）。" : "只清理「\(cleanupStatus)」状态的任务。",
                actions: [
                    DFAlertAction(title: "取消", role: .cancel),
                    DFAlertAction(title: "清理已完成", role: .destructive) { Task { await cleanup("done") } },
                    DFAlertAction(title: "清理失败", role: .destructive) { Task { await cleanup("failed") } },
                ]
            )
        )
    }

    private func taskCard(_ t: PgTask) -> some View {
        DFCard {
            VStack(alignment: .leading, spacing: 10) {
                HStack(spacing: 8) {
                    DFIcon(t.statusIcon, size: 16).foregroundStyle(t.tint)
                    DFText(t.displayName, scale: .body).lineLimit(2)
                    Spacer(minLength: 4)
                    StatusBadge(text: t.statusText, color: t.tint)
                }
                HStack(spacing: 6) {
                    if !t.nickname.isEmpty {
                        DFText(t.nickname, scale: .caption)
                    }
                    DFText("\(t.copies) 份 · \(t.pages) 页", scale: .caption)
                    DFText("·", scale: .caption)
                    DFText(t.printer.isEmpty ? "默认" : t.printer, scale: .caption).lineLimit(1)
                    Spacer()
                    DFText(Fmt.relative(t.createdAt), scale: .caption)
                }
                .dfTextViewStyle(.secondary)

                if t.hasError {
                    DFText(t.error, scale: .caption)
                        .foregroundStyle(theme.colors.destructive)
                        .lineLimit(3)
                }

                if t.status == "pending" || busyId == t.id {
                    HStack(spacing: 8) {
                        if busyId == t.id {
                            ProgressView().controlSize(.small)
                        } else {
                            DFButton("通过并打印") { Task { await act(t, "approve") } }
                                .dfButtonStyle(.tinted)
                            DFButton("拒绝") { Task { await act(t, "reject") } }
                                .dfButtonStyle(.outlined)
                        }
                        Spacer()
                    }
                }
            }
        }
    }

    private func load() async {
        do {
            tasks = try await API().adminTasks(status: status)
        } catch {
            DFToastQueue.shared.show(text: pgMessage(error), severity: .error)
        }
        loading = false
    }

    private func act(_ t: PgTask, _ action: String) async {
        busyId = t.id
        do {
            try await API().adminTaskAction(t.id, action)
            DFToastQueue.shared.show(text: action == "approve" ? "已放行" : "已拒绝", severity: .success)
            await load()
        } catch {
            DFToastQueue.shared.show(text: pgMessage(error), severity: .error)
        }
        busyId = nil
    }

    private func cleanup(_ s: String) async {
        do {
            let r = try await API().adminTaskCleanup(status: s)
            let n = pgInt(r["deleted"])
            DFToastQueue.shared.show(text: n > 0 ? "已清理 \(n) 条" : "没有可清理的任务", severity: .success)
            await load()
        } catch {
            DFToastQueue.shared.show(text: pgMessage(error), severity: .error)
        }
    }
}
