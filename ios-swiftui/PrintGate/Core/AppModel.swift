import SwiftUI
import Observation
import DesignFoundation

/// 全局会话：地址是否填了、有没有令牌、当前用户与后端下发的开关
@MainActor
@Observable
final class AppModel {
    enum Route {
        case setup
        case login
        case home
    }

    var route: Route = .setup
    var me: MeResult?
    var loading = false
    var banner: String = ""

    private let store = Store.shared

    var isAdmin: Bool { me?.user.isAdmin == true }
    var user: PgUser { me?.user ?? PgUser() }
    var theme: AppTheme {
        AppTheme(rawValue: store.themeID) ?? .pg
    }

    var colorScheme: ColorScheme? {
        switch store.themeMode {
        case 1: return .light
        case 2: return .dark
        default: return nil
        }
    }

    /// 启动时判断该进哪一屏：没地址 → 填地址；有令牌 → 校验；否则登录
    func bootstrap() async {
        if !store.hasServer {
            route = .setup
            return
        }
        guard store.hasToken else {
            route = .login
            return
        }
        do {
            me = try await API().me()
            route = .home
        } catch {
            // 令牌失效就回登录，其它错误（网络/服务端异常）也回登录但不粗暴清令牌
            if let e = error as? APIError, e.unauthorized {
                store.signOut()
            }
            route = .login
        }
    }

    func login(username: String, password: String) async throws {
        let d = try await API().login(username, password)
        let token = pgStr(d["token"])
        guard !token.isEmpty else { throw APIError(message: "登录失败：没拿到令牌") }
        store.setToken(token)
        me = try await API().me()
        route = .home
    }

    func refreshMe() async {
        guard store.hasToken else { return }
        do { me = try await API().me() } catch { /* 静默：下拉刷新失败不打断 */ }
    }

    func logout() {
        store.signOut()
        me = nil
        route = .login
    }

    func switchServer() {
        store.forgetServer()
        me = nil
        route = .setup
    }

    func toast(_ text: String) {
        DFToastQueue.shared.show(text: text, severity: .info)
    }

    func toastError(_ text: String) {
        DFToastQueue.shared.show(text: text, severity: .error)
    }
}

/// `try await` 的通用错误文案
func pgMessage(_ error: Error) -> String {
    if let e = error as? APIError { return e.message }
    return error.localizedDescription
}
