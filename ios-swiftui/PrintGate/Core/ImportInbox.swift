import SwiftUI
import Observation

/// 从微信 / 其他 App「用其他应用打开」送进来的文件暂存处。
/// 微信聊天里点文件 → 分享 →「用其他应用打开」→ 选 PrintGate，文件就会到这里。
@Observable
final class ImportInbox {
    static let shared = ImportInbox()

    var urls: [URL] = []

    /// 把系统给的 URL 拷到自己的临时目录：原 URL 只在会话期间可读，
    /// 而且权限 scope 一释放就失效，必须先落盘。
    func receive(_ url: URL) {
        guard url.isFileURL else { return }
        let got = url.startAccessingSecurityScopedResource()
        defer { if got { url.stopAccessingSecurityScopedResource() } }

        let name = url.lastPathComponent
        let dest = FileManager.default.temporaryDirectory
            .appendingPathComponent("pg_inbox_\(Int(Date().timeIntervalSince1970))_\(name)")
        do {
            if FileManager.default.fileExists(atPath: dest.path) {
                try FileManager.default.removeItem(at: dest)
            }
            try FileManager.default.copyItem(at: url, to: dest)
            urls.append(dest)
        } catch {
            print("ImportInbox 拷贝失败: \(error)")
        }
    }
}
