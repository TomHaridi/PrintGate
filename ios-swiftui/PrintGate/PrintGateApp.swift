import SwiftUI
import DesignFoundation

@main
struct PrintGateApp: App {
    @State private var app = AppModel()
    @State private var store = Store.shared

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
        }
    }
}
