import SwiftUI
import DesignFoundation

/// 服务器地址编辑器：手动输入 / 扫码 / 扫局域网 / 历史地址
struct ServerSheet: View {
    var onSaved: (String) -> Void

    @Environment(Store.self) private var store
    @Environment(\.dfTheme) private var theme
    @Environment(\.dismiss) private var dismiss

    @State private var text = ""
    @State private var busy = false
    @State private var error = ""
    @State private var showScan = false
    @State private var showLan = false

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    DFCard {
                        VStack(alignment: .leading, spacing: 12) {
                            DFTextField("服务器地址", text: $text, placeholder: "192.168.1.10:8080")
                                .textInputAutocapitalization(.never)
                                .autocorrectionDisabled()
                                .keyboardType(.URL)
                            DFText("内网一般填 `IP:8080`，不用写 http://。HTTPS 请写完整地址。", scale: .caption)
                                .dfTextViewStyle(.secondary)

                            if !error.isEmpty {
                                HStack(spacing: 6) {
                                    DFIcon("exclamationmark.circle.fill", size: 14)
                                    DFText(error, scale: .caption)
                                }
                                .foregroundStyle(theme.colors.destructive)
                            }

                            HStack(spacing: 10) {
                                DFButton("连接") { Task { await connect() } }
                                    .disabled(busy || text.trimmingCharacters(in: .whitespaces).isEmpty)
                                DFButton("扫码") { showScan = true }
                                    .dfButtonStyle(.outlined)
                                DFButton("扫局域网") { showLan = true }
                                    .dfButtonStyle(.ghost)
                            }

                            if busy {
                                HStack(spacing: 8) {
                                    ProgressView().controlSize(.small)
                                    DFText("正在校验…", scale: .caption).dfTextViewStyle(.secondary)
                                }
                            }
                        }
                    }

                    if !store.history.isEmpty {
                        VStack(alignment: .leading, spacing: 10) {
                            DFText("最近用过", scale: .label).dfTextViewStyle(.secondary)
                            FlowChips(items: store.history) { v in
                                text = v
                                Task { await connect() }
                            }
                        }
                    }

                    DFCard {
                        VStack(alignment: .leading, spacing: 8) {
                            DFText("怎么拿到地址", scale: .label)
                            DFText("在跑 PrintGate 的服务器上执行 `docker ps`，看 8080 端口映射到的宿主机 IP；手机与服务器需在同一个 Wi-Fi。", scale: .caption)
                                .dfTextViewStyle(.secondary)
                        }
                    }
                }
                .padding(16)
            }
            .screenBackground()
            .dfNavigationBar(title: "服务器", displayMode: .inline) {
                DFButton("关闭") { dismiss() }.dfButtonStyle(.ghost)
            }
            .dfSheet(isPresented: $showScan) {
                ScanSheet(title: "扫描服务器二维码") { code in
                    text = extractURL(code)
                    Task { await connect() }
                }
            }
            .dfSheet(isPresented: $showLan) {
                LanSheet { base in
                    text = base
                    Task { await connect() }
                }
            }
            .onAppear { text = store.baseUrl }
        }
    }

    private func connect() async {
        let raw = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !raw.isEmpty else { return }
        busy = true
        error = ""
        let r = await API.probe(raw)
        busy = false
        guard r.ok else {
            error = r.message.isEmpty ? "连接失败" : r.message
            return
        }
        let base = Store.normalize(raw)
        store.setBaseUrl(base)
        onSaved(base)
        DFToastQueue.shared.show(text: "已连接 \(Store.normalize(raw))", severity: .success)
        dismiss()
    }

    /// 二维码里可能是纯地址，也可能是带参数的登录串
    private func extractURL(_ code: String) -> String {
        if let r = code.range(of: "http://"), code[r.lowerBound...].hasPrefix("http") {
            let tail = String(code[r.lowerBound...])
            return tail.split(separator: "?").first.map(String.init) ?? tail
        }
        if let r = code.range(of: "https://") {
            let tail = String(code[r.lowerBound...])
            return tail.split(separator: "?").first.map(String.init) ?? tail
        }
        return code
    }
}

/// 局域网扫描
struct LanSheet: View {
    var onPick: (String) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var scanner = LanScanner()
    @State private var prefix = ""

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    DFCard {
                        VStack(alignment: .leading, spacing: 12) {
                            DFTextField("网段（可留空）", text: $prefix, placeholder: "192.168.1.")
                                .keyboardType(.numbersAndPunctuation)
                            DFText("留空会扫常见网段；填 `192.168.1.` 会把这个网段 254 个地址全扫一遍（较慢但最准）。", scale: .caption)
                                .dfTextViewStyle(.secondary)
                            HStack(spacing: 10) {
                                if scanner.running {
                                    DFButton("停止") { scanner.stop() }.dfButtonStyle(.outlined)
                                } else {
                                    DFButton("开始扫描") { scanner.start(prefix: prefix) }
                                }
                                DFText("\(scanner.scanned)/\(scanner.total)", scale: .caption)
                                    .dfTextViewStyle(.secondary)
                            }
                            if scanner.running || scanner.total > 0 {
                                DFProgressBar(value: scanner.progress)
                            }
                        }
                    }

                    if scanner.hits.isEmpty {
                        if scanner.running {
                            DFCard {
                                HStack(spacing: 10) {
                                    ProgressView().controlSize(.small)
                                    DFText("正在探测…", scale: .body).dfTextViewStyle(.secondary)
                                }
                            }
                        } else if scanner.scanned > 0 {
                            DFEmptyState(icon: "wifi.slash", title: "没找到 PrintGate", message: "确认手机和服务器在同一 Wi-Fi，或手动填地址")
                        }
                    } else {
                        ForEach(scanner.hits) { hit in
                            DFCard(action: {
                                onPick(hit.base)
                                dismiss()
                            }) {
                                HStack(spacing: 12) {
                                    DFIcon("server.rack", size: 22)
                                    VStack(alignment: .leading, spacing: 2) {
                                        DFText(hit.display, scale: .labelLarge)
                                        DFText("版本 \(hit.version.isEmpty ? "未知" : hit.version)", scale: .caption)
                                            .dfTextViewStyle(.secondary)
                                    }
                                    Spacer()
                                    DFButton("使用") {
                                        onPick(hit.base)
                                        dismiss()
                                    }
                                    .dfButtonStyle(.tinted)
                                }
                            }
                        }
                    }
                }
                .padding(16)
            }
            .screenBackground()
            .dfNavigationBar(title: "局域网扫描", displayMode: .inline) {
                DFButton("关闭") { dismiss() }.dfButtonStyle(.ghost)
            }
            .onDisappear { scanner.stop() }
        }
    }
}

/// 简单的流式 chip 布局（历史地址）
struct FlowChips: View {
    var items: [String]
    var onTap: (String) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(items, id: \.self) { v in
                Button {
                    onTap(v)
                } label: {
                    DFChip(v.replacingOccurrences(of: "http://", with: ""))
                }
                .buttonStyle(.plain)
            }
        }
    }
}
