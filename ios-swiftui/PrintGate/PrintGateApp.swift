import SwiftUI
import DesignFoundation

@main
struct PrintGateApp: App {
    @State private var app = AppModel()
    @State private var store = Store.shared

    init() {
        CrashReporter.install()
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(app)
                .environment(store)
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
