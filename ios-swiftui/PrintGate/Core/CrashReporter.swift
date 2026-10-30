import Foundation

/// 轻量崩溃捕获：把崩溃信号写进临时目录日志文件，下次启动时读出并展示。
/// 真机闪退时能拿到 SIGABRT / SIGILL / SIGSEGV / SIGBUS / SIGTRAP 的类型，便于定位。
enum CrashReporter {
    static let logPath = NSTemporaryDirectory() + "printgate-crash.log"

    static func install() {
        let sigs: [Int32] = [SIGABRT, SIGILL, SIGSEGV, SIGBUS, SIGTRAP]
        for sig in sigs {
            signal(sig) { s in
                record(s)
                signal(s, SIG_DFL)
                raise(s)
            }
        }
    }

    static func record(_ sig: Int32) {
        let msg = "printgate crash: signal \(sig)\n"
        let fd = open(logPath, O_WRONLY | O_CREAT | O_APPEND, 0o644)
        if fd >= 0 {
            msg.withCString { ptr in
                _ = write(fd, ptr, strlen(ptr))
            }
            close(fd)
        }
    }

    static func lastCrash() -> String? {
        guard let s = try? String(contentsOfFile: logPath, encoding: .utf8), !s.isEmpty else { return nil }
        return s.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    static func clear() {
        try? FileManager.default.removeItem(atPath: logPath)
    }
}
