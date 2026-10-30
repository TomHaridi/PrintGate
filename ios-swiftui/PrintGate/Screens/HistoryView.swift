import SwiftUI
import DesignFoundation

struct HistoryView: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dfTheme) private var theme

    @State private var tasks: [PgTask] = []
    @State private var loading = true
    @State private var filter = "all"

    private let filters: [SegOption] = [
        SegOption("all", "全部"),
        SegOption("pending", "待审批"),
        SegOption("active", "进行中"),
        SegOption("done", "已完成"),
        SegOption("failed", "失败"),
    ]

    private var filtered: [PgTask] {
        switch filter {
        case "pending": return tasks.filter { $0.status == "pending" }
        case "active": return tasks.filter { ["queued", "printing"].contains($0.status) }
        case "done": return tasks.filter { ["done", "completed"].contains($0.status) }
        case "failed": return tasks.filter { ["failed", "error", "rejected"].contains($0.status) }
        default: return tasks
        }
    }

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        ForEach(filters) { f in
                            Button {
                                filter = f.id
                            } label: {
                                DFChip(.selectable(f.title), isSelected: filter == f.id)
                            }
                            .buttonStyle(.plain)
                        }
                    }
                    .padding(.horizontal, 14)
                    .padding(.vertical, 8)
                }

                if loading && tasks.isEmpty {
                    VStack(spacing: 10) {
                        DFSkeleton().frame(height: 72)
                        DFSkeleton().frame(height: 72)
                    }
                    .padding(16)
                    Spacer()
                } else if filtered.isEmpty {
                    Spacer()
                    EmptyHint(icon: "clock.badge.questionmark", title: "没有记录", message: filter == "all" ? "打印过的任务会出现在这里" : "这个筛选下暂时没有任务")
                    Spacer()
                } else {
                    ScrollView {
                        LazyVStack(spacing: 10) {
                            ForEach(filtered) { t in
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
            .dfNavigationBar(title: "记录", displayMode: .inline) {
                Button {
                    Task { await load() }
                } label: {
                    DFIcon("arrow.clockwise", size: 18)
                }
            }
            .task { await load() }
        }
    }

    private func taskCard(_ t: PgTask) -> some View {
        DFCard {
            VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: 8) {
                    DFIcon(t.statusIcon, size: 16)
                        .foregroundStyle(t.tint)
                    DFText(t.displayName, scale: .body).lineLimit(2)
                    Spacer(minLength: 4)
                    StatusBadge(text: t.statusText, color: t.tint)
                }

                HStack(spacing: 6) {
                    DFText("\(t.copies) 份 · \(t.pages > 0 ? "\(t.pages) 页" : "页数未知")", scale: .caption)
                    DFText("·", scale: .caption)
                    DFText(t.printer.isEmpty ? "默认打印机" : t.printer, scale: .caption).lineLimit(1)
                    Spacer()
                    DFText(Fmt.relative(t.createdAt), scale: .caption)
                }
                .dfTextViewStyle(.secondary)

                if t.hasError {
                    HStack(spacing: 6) {
                        DFIcon("exclamationmark.triangle.fill", size: 12)
                        DFText(t.error, scale: .caption).lineLimit(3)
                    }
                    .foregroundStyle(theme.colors.destructive)
                }

                if t.canCancel {
                    HStack {
                        Spacer()
                        DFButton("撤回", style: .outlined, role: .cancel) {
                            Task { await cancel(t) }
                        }
                    }
                }
            }
        }
    }

    private func load() async {
        do {
            tasks = try await API().tasks()
        } catch {
            DFToastQueue.shared.show(text: pgMessage(error), severity: .error)
        }
        loading = false
    }

    private func cancel(_ t: PgTask) async {
        do {
            try await API().cancelTask(t.id)
            DFToastQueue.shared.show(text: "已撤回", severity: .success)
            await load()
        } catch {
            DFToastQueue.shared.show(text: pgMessage(error), severity: .error)
        }
    }
}
