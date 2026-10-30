import SwiftUI
import DesignFoundation

@main
struct PrintGateApp: App {
    @State private var app = AppModel()
    @State private var store = Store.shared
    @State private var inbox = ImportInbox.shared

    init() {
        CrashReporter.install()
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(app)
                .environment(store)
                .environment(inbox)
                .appTheme(AppTheme(rawValue: store.themeID) ?? .pg)
                .preferredColorScheme(colorScheme)
                .dfToast()
        }
    }

    private var colorScheme: ColorScheme? {
        switch store.themeMode {
        case 1: return .light
        case 2: return .dark
        default: return nil
        }
    }
}

struct RootView: View {
    @Environment(AppModel.self) private var app
    @Environment(ImportInbox.self) private var inbox
    @State private var crashInfo: String?

    var body: some View {
        Group {
            switch app.route {
            case .setup:
                SetupView()
            case .login:
                LoginView()
            case .home:
                HomeView()
            }
        }
        .task {
            await app.bootstrap()
            if let info = CrashReporter.lastCrash() {
                crashInfo = info
                CrashReporter.clear()
            }
        }
        // 微信 / 文件 App 里「用其他应用打开 → PrintGate」会走这里
        .onOpenURL { url in
            inbox.receive(url)
        }
        .alert("检测到上次崩溃", isPresented: Binding(
            get: { crashInfo != nil },
            set: { if !$0 { crashInfo = nil } }
        )) {
            Button("知道了", role: .cancel) {}
        } message: {
            Text(crashInfo ?? "")
        }
    }
}
