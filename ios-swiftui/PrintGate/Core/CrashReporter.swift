import Foundation

/// 崩溃信号处理：必须是顶层函数（C 函数指针不能捕获上下文）。
private func printgateCrashHandler(_ sig: Int32) {
    let msg = "printgate crash: signal \(sig)\n"
    let path = NSTemporaryDirectory() + "printgate-crash.log"
    let fd = open(path, O_WRONLY | O_CREAT | O_APPEND, 0o644)
    if fd >= 0 {
        msg.withCString { ptr in _ = write(fd, ptr, strlen(ptr)) }
        close(fd)
    }
    signal(sig, SIG_DFL)
    raise(sig)
}

/// 轻量崩溃捕获：把崩溃信号写进临时目录日志文件，下次启动时读出并展示。
enum CrashReporter {
    static let logPath = NSTemporaryDirectory() + "printgate-crash.log"

    static func install() {
        for sig in [SIGABRT, SIGILL, SIGSEGV, SIGBUS, SIGTRAP] {
            signal(sig, printgateCrashHandler)
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
