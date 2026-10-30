import SwiftUI
import DesignFoundation

struct SetupView: View {
    @Environment(AppModel.self) private var app
    @Environment(Store.self) private var store
    @Environment(\.dfTheme) private var theme

    @State private var server = ""
    @State private var busy = false
    @State private var error = ""
    @State private var showScan = false
    @State private var showLan = false

    var body: some View {
        ScrollView {
            VStack(spacing: 20) {
                VStack(spacing: 12) {
                    Image("Logo")
                        .resizable()
                        .scaledToFill()
                        .frame(width: 84, height: 84)
                        .clipShape(RoundedRectangle(cornerRadius: 20, style: .continuous))
                        .overlay(
                            RoundedRectangle(cornerRadius: 20, style: .continuous)
                                .strokeBorder(theme.colors.border, lineWidth: 0.5)
                        )
                        .shadow(color: .black.opacity(0.08), radius: 10, y: 4)

                    DFText("PrintGate", scale: .title)
                    DFText("远程打印 · 先连接你的服务器", scale: .bodySmall)
                        .dfTextViewStyle(.secondary)
                }
                .padding(.top, 48)

                DFCard {
                    VStack(alignment: .leading, spacing: 14) {
                        DFText("服务器地址", scale: .label).dfTextViewStyle(.secondary)
                        DFTextField("例如 192.168.1.10:8080", text: $server, placeholder: "192.168.1.10:8080")
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .keyboardType(.URL)

                        if !error.isEmpty {
                            HStack(spacing: 6) {
                                DFIcon("exclamationmark.circle.fill", size: 14)
                                DFText(error, scale: .caption)
                            }
                            .foregroundStyle(theme.colors.destructive)
                        }

                        DFButton(busy ? "校验中…" : "连接服务器") {
                            Task { await connect() }
                        }
                        .disabled(busy || server.trimmingCharacters(in: .whitespaces).isEmpty)

                        HStack(spacing: 10) {
                            DFButton("扫码") { showScan = true }
                                .dfButtonStyle(.outlined)
                            DFButton("扫局域网") { showLan = true }
                                .dfButtonStyle(.ghost)
                            Spacer()
                        }
                    }
                    .padding(2)
                }

                if !store.history.isEmpty {
                    DFCard {
                        VStack(alignment: .leading, spacing: 10) {
                            DFText("最近连接", scale: .label).dfTextViewStyle(.secondary)
                            ForEach(store.history, id: \.self) { v in
                                Button {
                                    server = v
                                    Task { await connect() }
                                } label: {
                                    HStack {
                                        DFIcon("clock.arrow.circlepath", size: 16)
                                            .foregroundStyle(theme.colors.textSecondary)
                                        DFText(v.replacingOccurrences(of: "http://", with: ""), scale: .body)
                                        Spacer()
                                        DFIcon("chevron.right", size: 12)
                                            .foregroundStyle(theme.colors.textSecondary)
                                    }
                                    .contentShape(Rectangle())
                                }
                                .buttonStyle(.plain)
                            }
                        }
                    }
                }

                DFCard {
                    VStack(alignment: .leading, spacing: 8) {
                        HStack(spacing: 6) {
                            DFIcon("info.circle", size: 15)
                            DFText("找不到地址？", scale: .label)
                        }
                        .foregroundStyle(theme.colors.textSecondary)

                        DFText("在跑 PrintGate 的服务器上执行 `docker ps`，看 8080 端口对应的宿主机 IP。手机要和服务器连同一个 Wi-Fi；也可以点「扫局域网」自动找。", scale: .caption)
                            .dfTextViewStyle(.secondary)
                    }
                }

                DFText("服务器版本 2.4.23 起支持全部功能", scale: .caption)
                    .dfTextViewStyle(.muted)
                    .padding(.bottom, 32)
            }
            .padding(.horizontal, 18)
        }
        .screenBackground()
        .dfSheet(isPresented: $showScan) {
            ScanSheet(title: "扫描服务器二维码") { code in
                server = extractURL(code)
                Task { await connect() }
            }
        }
        .dfSheet(isPresented: $showLan) {
            LanSheet { base in
                server = base
                Task { await connect() }
            }
        }
    }

    private func connect() async {
        let raw = server.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !raw.isEmpty else { return }
        busy = true
        error = ""
        let r = await API.probe(raw)
        busy = false
        guard r.ok else {
            error = r.message.isEmpty ? "连接失败，检查地址" : r.message
            return
        }
        store.setBaseUrl(Store.normalize(raw))
        DFToastQueue.shared.show(text: "已连接，版本 \(r.version)", severity: .success)
        app.route = .login
    }

    private func extractURL(_ code: String) -> String {
        let s = code.trimmingCharacters(in: .whitespacesAndNewlines)
        for prefix in ["http://", "https://"] {
            if let r = s.range(of: prefix) {
                let tail = String(s[r.lowerBound...])
                return tail.split(separator: "?").first.map(String.init) ?? tail
            }
        }
        return s
    }
}
