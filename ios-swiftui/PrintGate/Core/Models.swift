import Foundation

// MARK: - JSON 宽松取值（服务端字段可能给 int/string/null 混用）

func pgStr(_ v: Any?) -> String {
    switch v {
    case let s as String: return s
    case let n as NSNumber:
        if CFGetTypeID(n) == CFBooleanGetTypeID() { return n.boolValue ? "true" : "false" }
        return n.stringValue
    case is NSNull, nil: return ""
    case let d as [String: Any]: return d.isEmpty ? "" : "\(d)"
    case let a as [Any]: return a.isEmpty ? "" : "\(a)"
    default: return "\(String(describing: v))"
    }
}

func pgInt(_ v: Any?) -> Int {
    switch v {
    case let i as Int: return i
    case let n as NSNumber: return n.intValue
    case let s as String: return Int(s) ?? 0
    default: return 0
    }
}

func pgBool(_ v: Any?, _ fallback: Bool = false) -> Bool {
    switch v {
    case let b as Bool: return b
    case let n as NSNumber: return n.boolValue
    case let s as String: return s == "true" || s == "1"
    default: return fallback
    }
}

func pgMap(_ v: Any?) -> [String: Any] { (v as? [String: Any]) ?? [:] }

func pgMaps(_ v: Any?) -> [[String: Any]] {
    guard let list = v as? [Any] else { return [] }
    return list.compactMap { $0 as? [String: Any] }
}

// MARK: - 用户

struct PgUser: Identifiable, Hashable {
    var id: Int = 0
    var nickname: String = ""
    var username: String = ""
    var role: String = "user"
    var status: String = ""
    var phone: String = ""
    var avatar: String = ""
    var wechatId: String = ""
    var realName: String = ""
    var applyNote: String = ""
    var createdAt: String = ""
    var lastLogin: String = ""

    init() {}

    init(_ j: [String: Any]) {
        id = pgInt(j["id"])
        nickname = pgStr(j["nickname"])
        username = pgStr(j["username"])
        role = pgStr(j["role"])
        status = pgStr(j["status"])
        phone = pgStr(j["phone"])
        avatar = pgStr(j["avatar"])
        wechatId = pgStr(j["wechat_id"])
        realName = pgStr(j["real_name"])
        applyNote = pgStr(j["apply_note"])
        createdAt = pgStr(j["created_at"])
        lastLogin = pgStr(j["last_login"])
    }

    var isAdmin: Bool { role == "admin" }
    var approved: Bool { status == "approved" }
    var pending: Bool { status == "pending" }
    var blocked: Bool { status == "blocked" }

    var displayName: String {
        if !nickname.isEmpty { return nickname }
        if !username.isEmpty { return username }
        if !realName.isEmpty { return realName }
        return "未命名用户"
    }

    var profileDone: Bool { !wechatId.isEmpty || !phone.isEmpty || !realName.isEmpty }

    /// 头像首字（DFAvatar 要 initials）
    var initials: String {
        let n = displayName
        guard let c = n.first else { return "?" }
        return String(c)
    }
}

// MARK: - 文件

struct PgFileItem: Identifiable, Hashable {
    var id: Int = 0
    var filename: String = ""
    var size: Int = 0
    var pages: Int = 0
    var createdAt: String = ""

    init() {}

    init(_ j: [String: Any]) {
        id = pgInt(j["id"])
        filename = pgStr(j["filename"])
        size = pgInt(j["size"])
        pages = pgInt(j["pages"])
        createdAt = pgStr(j["created_at"])
    }

    var ext: String {
        guard let i = filename.lastIndex(of: ".") else { return "" }
        return String(filename[filename.index(after: i)...]).lowercased()
    }

    var isImage: Bool {
        ["png", "jpg", "jpeg", "webp", "bmp", "gif", "heic", "heif"].contains(ext)
    }

    var iconName: String {
        if isImage { return "photo" }
        if ext == "pdf" { return "doc.richtext" }
        if ["doc", "docx"].contains(ext) { return "doc.text" }
        if ["xls", "xlsx"].contains(ext) { return "tablecells" }
        if ["ppt", "pptx"].contains(ext) { return "rectangle.on.rectangle" }
        return "doc"
    }
}

// MARK: - 打印任务

struct PgTask: Identifiable, Hashable {
    var id: Int = 0
    var filename: String = ""
    var printer: String = ""
    var status: String = ""
    var copies: Int = 1
    var pages: Int = 0
    var createdAt: String = ""
    var error: String = ""
    var options: [String: Any] = [:]
    var fileAvailable: Bool = true
    var nickname: String = ""
    var size: Int = 0

    init() {}

    init(_ j: [String: Any]) {
        id = pgInt(j["id"])
        filename = pgStr(j["filename"])
        printer = pgStr(j["printer"])
        status = pgStr(j["status"])
        let c = pgInt(j["copies"])
        copies = c == 0 ? 1 : c
        pages = pgInt(j["pages"])
        createdAt = pgStr(j["created_at"])
        error = pgStr(j["error"])
        options = pgMap(j["options"])
        fileAvailable = j["file_available"] as? Bool != false
        nickname = pgStr(j["nickname"])
        size = pgInt(j["size"])
    }

    var canCancel: Bool { status == "pending" }
    var hasError: Bool { !error.isEmpty }

    var displayName: String {
        let base = filename.isEmpty ? "未命名文件" : filename
        return fileAvailable ? base : "\(base)（源文件已清理）"
    }

    var statusText: String {
        switch status {
        case "pending": return "待审批"
        case "queued": return "排队中"
        case "printing": return "打印中"
        case "done", "completed": return "已完成"
        case "failed", "error": return "失败"
        case "canceled", "cancelled": return "已取消"
        case "rejected": return "已拒绝"
        default: return status.isEmpty ? "未知" : status
        }
    }

    var statusIcon: String {
        switch status {
        case "pending": return "clock"
        case "queued": return "hourglass"
        case "printing": return "printer.fill"
        case "done", "completed": return "checkmark.circle.fill"
        case "failed", "error": return "exclamationmark.triangle.fill"
        case "canceled", "cancelled": return "xmark.circle"
        case "rejected": return "hand.raised.fill"
        default: return "questionmark.circle"
        }
    }

    static func == (a: PgTask, b: PgTask) -> Bool { a.id == b.id && a.status == b.status }
    func hash(into h: inout Hasher) { h.combine(id) }
}

// MARK: - 打印机

struct PgPrinter: Identifiable, Hashable {
    var name: String = ""
    var state: String = ""
    var isDefault: Bool = false
    var info: String = ""
    var location: String = ""
    var accepting: Bool = true
    var model: String = ""

    var id: String { name }

    init() {}

    init(_ j: [String: Any]) {
        name = pgStr(j["name"])
        state = pgStr(j["state"])
        isDefault = j["isDefault"] as? Bool == true
        info = pgStr(j["info"])
        location = pgStr(j["location"])
        accepting = j["accepting"] as? Bool != false
        model = pgStr(j["model"])
    }

    var stateText: String {
        switch state.lowercased() {
        case "idle": return "空闲"
        case "processing", "printing": return "打印中"
        case "stopped": return "已停止"
        case "": return "未知"
        default: return state
        }
    }
}

// MARK: - /api/mp/me

struct MeResult {
    var user = PgUser()
    var config: [String: Any] = [:]

    var maxCopies: Int { pgInt(config["maxCopies"]) == 0 ? 99 : pgInt(config["maxCopies"]) }
    var maxFileMB: Int { pgInt(config["maxFileMB"]) == 0 ? 20 : pgInt(config["maxFileMB"]) }
    var maxPages: Int { pgInt(config["maxPages"]) == 0 ? 50 : pgInt(config["maxPages"]) }
    var approveEachJob: Bool { pgBool(config["approveEachJob"]) }
    var advancedPrint: Bool { config["advancedPrint"] as? Bool != false }
}
