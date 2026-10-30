import Foundation
import Observation

/// 本地持久化 + 全局会话状态。
///
/// 键名沿用 Flutter 版（`pg.base.url` 等），两边装在同一台机器上也不冲突，
/// 换回 Flutter 客户端时用户不用重新填服务器。
@MainActor
@Observable
final class Store {
    static let shared = Store()

    private let d = UserDefaults.standard

    private enum Key {
        static let base = "pg.base.url"
        static let history = "pg.base.history"
        static let token = "pg.token"
        static let theme = "pg.theme.id"
        static let mode = "pg.theme.mode"
    }

    var baseUrl: String
    var token: String
    var history: [String]
    /// 主题预设 id：pg / slate / aurora / copper / sage / garnet
    var themeID: String
    /// 0 跟随系统 1 浅色 2 深色
    var themeMode: Int

    private init() {
        baseUrl = d.string(forKey: Key.base) ?? ""
        token = d.string(forKey: Key.token) ?? ""
        history = d.stringArray(forKey: Key.history) ?? []
        themeID = d.string(forKey: Key.theme) ?? "pg"
        themeMode = d.integer(forKey: Key.mode)
    }

    var hasServer: Bool { !baseUrl.isEmpty }
    var hasToken: Bool { !token.isEmpty }

    // MARK: 服务器

    func setBaseUrl(_ v: String) {
        let clean = Store.normalize(v)
        baseUrl = clean
        d.set(clean, forKey: Key.base)
        addHistory(clean)
    }

    func addHistory(_ v: String) {
        guard !v.isEmpty else { return }
        var list = history.filter { $0 != v }
        list.insert(v, at: 0)
        history = Array(list.prefix(6))
        d.set(history, forKey: Key.history)
    }

    func clearHistory(keep: String) {
        history = keep.isEmpty ? [] : [keep]
        d.set(history, forKey: Key.history)
    }

    /// `192.168.1.5:8080` → `http://192.168.1.5:8080`，去掉尾部斜杠
    nonisolated static func normalize(_ raw: String) -> String {
        var v = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !v.isEmpty else { return "" }
        if !v.lowercased().hasPrefix("http://") && !v.lowercased().hasPrefix("https://") {
            v = "http://" + v
        }
        while v.hasSuffix("/") { v.removeLast() }
        return v
    }

    // MARK: 会话

    func setToken(_ v: String) {
        token = v
        d.set(v, forKey: Key.token)
    }

    func signOut() {
        token = ""
        d.removeObject(forKey: Key.token)
    }

    /// 换服务器：地址与令牌一起清，历史保留
    func forgetServer() {
        token = ""
        baseUrl = ""
        d.removeObject(forKey: Key.token)
        d.removeObject(forKey: Key.base)
    }

    // MARK: 外观

    func setTheme(_ id: String) {
        themeID = id
        d.set(id, forKey: Key.theme)
    }

    func setThemeMode(_ mode: Int) {
        themeMode = mode
        d.set(mode, forKey: Key.mode)
    }
}
