import SwiftUI
import DesignFoundation

struct AdminPrintersView: View {
    @Environment(\.dfTheme) private var theme

    @State private var printers: [PgPrinter] = []
    @State private var loading = true
    @State private var busy: String?

    var body: some View {
        ScrollView {
            VStack(spacing: 10) {
                if loading && printers.isEmpty {
                    DFSkeleton().frame(height: 84)
                    DFSkeleton().frame(height: 84)
                } else if printers.isEmpty {
                    EmptyHint(icon: "printer.slash", title: "没有打印机", message: "在服务端 CUPS 里添加打印机后刷新")
                } else {
                    ForEach(printers) { p in
                        printerCard(p)
                    }
                }
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
        }
        .screenBackground()
        .dfNavigationBar(title: "打印机", displayMode: .inline) {
            Button {
                Task { await load() }
            } label: {
                DFIcon("arrow.clockwise", size: 17)
            }
        }
        .task { await load() }
        .refreshable { await load() }
    }

    private func printerCard(_ p: PgPrinter) -> some View {
        DFCard {
            VStack(alignment: .leading, spacing: 10) {
                HStack(spacing: 10) {
                    ZStack {
                        RoundedRectangle(cornerRadius: 10)
                            .fill(theme.colors.primary.opacity(0.12))
                            .frame(width: 40, height: 40)
                        DFIcon("printer.fill", size: 18).foregroundStyle(theme.colors.primary)
                    }
                    VStack(alignment: .leading, spacing: 2) {
                        HStack(spacing: 6) {
                            DFText(p.name, scale: .body).lineLimit(1)
                            if p.isDefault {
                                StatusBadge(text: "默认", color: theme.colors.primary)
                            }
                        }
                        DFText([p.stateText, p.location, p.model].filter { !$0.isEmpty }.joined(separator: " · "), scale: .caption)
                            .dfTextViewStyle(.secondary)
                            .lineLimit(1)
                    }
                    Spacer()
                    if busy == p.name {
                        ProgressView().controlSize(.small)
                    }
                }

                HStack(spacing: 8) {
                    if p.state.lowercased() == "stopped" {
                        DFButton("恢复") { Task { await act(p, "resume") } }.dfButtonStyle(.tinted)
                    } else {
                        DFButton("暂停") { Task { await act(p, "pause") } }.dfButtonStyle(.outlined)
                    }
                    if !p.isDefault {
                        DFButton("设为默认") { Task { await act(p, "default") } }.dfButtonStyle(.ghost)
                    }
                    Spacer()
                }
            }
        }
    }

    private func load() async {
        do {
            printers = try await API().adminPrinters()
        } catch {
            DFToastQueue.shared.show(text: pgMessage(error), severity: .error)
        }
        loading = false
    }

    private func act(_ p: PgPrinter, _ action: String) async {
        busy = p.name
        do {
            try await API().adminPrinterAction(p.name, action)
            DFToastQueue.shared.show(text: "已处理", severity: .success)
            await load()
        } catch {
            DFToastQueue.shared.show(text: pgMessage(error), severity: .error)
        }
        busy = nil
    }
}
