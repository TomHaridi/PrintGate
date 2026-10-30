import SwiftUI
import DesignFoundation

struct LoginView: View {
    @Environment(AppModel.self) private var app
    @Environment(Store.self) private var store
    @Environment(\.dfTheme) private var theme

    @State private var username = ""
    @State private var password = ""
    @State private var busy = false
    @State private var error = ""
    @State private var showServer = false

    var body: some View {
        ScrollView {
            VStack(spacing: 18) {
                VStack(spacing: 10) {
                    Image("Logo")
                        .resizable()
                        .scaledToFill()
                        .frame(width: 72, height: 72)
                        .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
                        .shadow(color: .black.opacity(0.08), radius: 8, y: 3)

                    DFText("登录 PrintGate", scale: .headline)
                    Button {
                        showServer = true
                    } label: {
                        HStack(spacing: 4) {
                            DFIcon("server.rack", size: 12)
                            DFText(store.baseUrl.replacingOccurrences(of: "http://", with: ""), scale: .caption)
                            DFIcon("chevron.right", size: 10)
                        }
                        .foregroundStyle(theme.colors.primary)
                    }
                    .buttonStyle(.plain)
                }
                .padding(.top, 40)

                DFCard {
                    VStack(alignment: .leading, spacing: 14) {
                        DFTextField("账号", text: $username, placeholder: "账号")
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                        DFSecureField("密码", text: $password, placeholder: "密码")

                        if !error.isEmpty {
                            HStack(spacing: 6) {
                                DFIcon("exclamationmark.circle.fill", size: 14)
                                DFText(error, scale: .caption)
                            }
                            .foregroundStyle(theme.colors.destructive)
                        }

                        DFButton(busy ? "登录中…" : "登录") {
                            Task { await submit() }
                        }
                        .disabled(busy || username.isEmpty || password.isEmpty)

                        DFText("账号由管理员在网页后台创建；忘记密码请联系管理员重置。", scale: .caption)
                            .dfTextViewStyle(.secondary)
                    }
                    .padding(2)
                }

                HStack(spacing: 10) {
                    DFButton("换服务器") { showServer = true }
                        .dfButtonStyle(.outlined)
                    DFButton("重试连接") {
                        Task { await app.bootstrap() }
                    }
                    .dfButtonStyle(.ghost)
                }

                Spacer(minLength: 40)
            }
            .padding(.horizontal, 18)
        }
        .screenBackground()
        .dfSheet(isPresented: $showServer) {
            ServerSheet { _ in
                error = ""
            }
        }
        .onAppear {
            if username.isEmpty, !app.user.username.isEmpty { username = app.user.username }
        }
    }

    private func submit() async {
        busy = true
        error = ""
        do {
            try await app.login(username: username.trimmingCharacters(in: .whitespaces), password: password)
            DFToastQueue.shared.show(text: "欢迎回来", severity: .success)
        } catch {
            self.error = pgMessage(error)
        }
        busy = false
    }
}
