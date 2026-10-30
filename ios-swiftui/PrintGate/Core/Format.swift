import Foundation

/// 展示层格式化：与小程序 `utils/format.js` 输出完全一致
enum Fmt {
    static func size(_ bytes: Int) -> String {
        if bytes <= 0 { return "0 B" }
        let units = ["B", "KB", "MB", "GB"]
        var v = Double(bytes)
        var i = 0
        while v >= 1024 && i < units.count - 1 {
            v /= 1024
            i += 1
        }
        if i == 0 { return "\(Int(v)) B" }
        return String(format: v >= 10 ? "%.0f %@" : "%.1f %@", v, units[i])
    }

    private static let serverFmt: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "yyyy-MM-dd HH:mm:ss"
        f.timeZone = .current
        return f
    }()

    private static let isoFmt: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()

    static func date(_ text: String) -> Date? {
        if text.isEmpty { return nil }
        if let d = serverFmt.date(from: text) { return d }
        if let d = isoFmt.date(from: text) { return d }
        let f = ISO8601DateFormatter()
        return f.date(from: text)
    }

    /// "3 分钟前" / "昨天 14:20" / "10-28 14:20"
    static func relative(_ text: String) -> String {
        guard let d = date(text) else { return text }
        let now = Date()
        let diff = now.timeIntervalSince(d)
        if diff < 60 { return "刚刚" }
        if diff < 3600 { return "\(Int(diff / 60)) 分钟前" }
        if diff < 86400 && Calendar.current.isDateInToday(d) {
            return "今天 " + hhmm(d)
        }
        if Calendar.current.isDateInYesterday(d) { return "昨天 " + hhmm(d) }
        if diff < 86400 * 7 { return "\(Int(diff / 86400)) 天前" }
        let f = DateFormatter()
        f.dateFormat = Calendar.current.component(.year, from: d) == Calendar.current.component(.year, from: now)
            ? "MM-dd HH:mm" : "yyyy-MM-dd"
        return f.string(from: d)
    }

    static func hhmm(_ d: Date) -> String {
        let f = DateFormatter()
        f.dateFormat = "HH:mm"
        return f.string(from: d)
    }

    static func stamp(_ d: Date = Date()) -> String {
        let f = DateFormatter()
        f.dateFormat = "MM-dd HH:mm:ss"
        return f.string(from: d)
    }

    /// 页范围：只留数字、逗号、短横线，全角标点归一
    static func sanitizeRanges(_ raw: String) -> String {
        var s = raw
        for (a, b) in [("，", ","), ("－", "-"), ("—", "-"), ("–", "-"), ("、", ","), (" ", ""), ("　", "")] {
            s = s.replacingOccurrences(of: a, with: b)
        }
        let allowed = Set("0123456789,-")
        return String(s.filter { allowed.contains($0) })
    }

    /// 1-3,5 / 2 / 1- / 空
    static func validRanges(_ s: String) -> Bool {
        if s.isEmpty { return true }
        for part in s.split(separator: ",") {
            if part.isEmpty { return false }
            let segs = part.split(separator: "-", omittingEmptySubsequences: false)
            if segs.count > 2 { return false }
            for seg in segs where !seg.isEmpty {
                guard let n = Int(seg), n > 0 else { return false }
            }
            if segs.count == 2 {
                let a = Int(segs[0]) ?? 0
                let b = Int(segs[1]) ?? 0
                if a == 0 || b == 0 || a > b { return false }
            }
        }
        return true
    }

    static func plural(_ n: Int, _ unit: String) -> String { "\(n) \(unit)" }
}
