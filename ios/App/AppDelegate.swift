import UIKit

@main
final class AppDelegate: UIResponder, UIApplicationDelegate {
    var window: UIWindow?

    func application(_ application: UIApplication,
                     didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        let window = UIWindow(frame: UIScreen.main.bounds)
        window.rootViewController = RootBuilder.makeRoot()
        window.makeKeyAndVisible()
        self.window = window
        return true
    }
}

/// 根控制器：没配过服务器地址 → 先让用户填；配过 → 直接进 WebView 里的 /m/
enum RootBuilder {
    static func makeRoot() -> UIViewController {
        if let base = Store.baseURL {
            return makeApp(base: base)
        }
        let setup = SetupViewController()
        setup.onReady = { base in
            guard let window = (UIApplication.shared.delegate as? AppDelegate)?.window else { return }
            window.rootViewController = makeApp(base: base)
            UIView.transition(with: window, duration: 0.3, options: .transitionCrossDissolve, animations: nil)
        }
        return setup
    }

    static func makeApp(base: URL) -> UIViewController {
        // 不套 UINavigationController：H5 自己已有顶栏，两层标题会挤占空间。
        // 「切换服务器」走 H5 里的原生桥（我的 → 服务器设置）。
        return WebViewController(baseURL: base)
    }
}
