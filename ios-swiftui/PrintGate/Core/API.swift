import Foundation

// MARK: - 错误

struct APIError: LocalizedError, Sendable {
    var message: String
    var status: Int = 0
    var code: String = ""

    var errorDescription: String? { message }
    var unauthorized: Bool { status == 401 || status == 403 }
    var notApproved: Bool { code == "NOT_APPROVED" }
}

// MARK: - 客户端

/// 与小程序 `services/api.js` 一一对应。后端零改动，2.4.22 / 2.4.23 都能用。
struct API: Sendable {
    var baseUrl: String
    var token: String

    static let chunkLimit = 8 * 1024 * 1024

    @MainActor
    init() {
        baseUrl = Store.shared.baseUrl
        token = Store.shared.token
    }

    /// 后台令牌（网页后台密码换来的），与用户令牌分开
    @MainActor
    init(adminToken: String) {
        baseUrl = Store.shared.baseUrl
        token = adminToken
    }

    init(baseUrl: String, token: String) {
        self.baseUrl = baseUrl
        self.token = token
    }

    // MARK: 底层

    private func makeURL(_ path: String, _ query: [String: String]? = nil) throws -> URL {
        guard !baseUrl.isEmpty else { throw APIError(message: "还没设置服务器地址") }
        guard var c = URLComponents(string: baseUrl + path) else {
            throw APIError(message: "服务器地址格式不对：\(baseUrl)")
        }
        if let q = query {
            let items = q.filter { !$0.value.isEmpty }.map { URLQueryItem(name: $0.key, value: $0.value) }
            if !items.isEmpty { c.queryItems = items }
        }
        guard let u = c.url else { throw APIError(message: "服务器地址格式不对：\(baseUrl)") }
        return u
    }

    private func request(_ method: String, _ path: String, body: [String: Any]? = nil, query: [String: String]? = nil) throws -> URLRequest {
        var req = URLRequest(url: try makeURL(path, query))
        req.httpMethod = method
        req.timeoutInterval = 30
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        if !token.isEmpty { req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        if let body {
            req.setValue("application/json; charset=utf-8", forHTTPHeaderField: "Content-Type")
            req.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        return req
    }

    private func perform(_ req: URLRequest) async throws -> (Data, HTTPURLResponse) {
        do {
            let (data, resp) = try await URLSession.shared.data(for: req)
            guard let http = resp as? HTTPURLResponse else {
                throw APIError(message: "服务器响应异常")
            }
            return (data, http)
        } catch let e as APIError {
            throw e
        } catch let e as URLError {
            switch e.code {
            case .cannotConnectToHost, .cannotFindHost, .networkConnectionLost, .notConnectedToInternet:
                throw APIError(message: "连不上服务器，请检查地址和网络")
            case .timedOut:
                throw APIError(message: "服务器响应超时，请稍后重试")
            case .secureConnectionFailed, .serverCertificateUntrusted:
                throw APIError(message: "HTTPS 握手失败，内网请用 http 地址")
            default:
                throw APIError(message: "网络异常：\(e.localizedDescription)")
            }
        }
    }

    private func parse(_ data: Data, _ resp: HTTPURLResponse) throws -> [String: Any] {
        var dict: [String: Any] = [:]
        if !data.isEmpty, let obj = try? JSONSerialization.jsonObject(with: data), let m = obj as? [String: Any] {
            dict = m
        }
        let okFlag = (dict["ok"] as? Bool) != false
        if !okFlag || resp.statusCode >= 400 {
            let msg = pgStr(dict["msg"])
            throw APIError(
                message: msg.isEmpty ? "请求失败（HTTP \(resp.statusCode)）" : msg,
                status: resp.statusCode,
                code: pgStr(dict["code"])
            )
        }
        return dict
    }

    func send(_ method: String, _ path: String, body: [String: Any]? = nil, query: [String: String]? = nil) async throws -> [String: Any] {
        let (data, resp) = try await perform(try request(method, path, body: body, query: query))
        return try parse(data, resp)
    }

    // MARK: 探活 / 版本

    func health() async throws -> [String: Any] { try await send("GET", "/api/health") }
    func serverVersion() async throws -> [String: Any] { try await send("GET", "/api/mp/version") }

    /// 校验对面是不是 PrintGate（填地址时用）
    static func probe(_ rawBase: String, timeout: TimeInterval = 6) async -> (ok: Bool, version: String, message: String) {
        let base = Store.normalize(rawBase)
        guard !base.isEmpty, let url = URL(string: base + "/api/health") else {
            return (false, "", "地址格式不对")
        }
        var req = URLRequest(url: url)
        req.timeoutInterval = timeout
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        do {
            let (data, resp) = try await URLSession.shared.data(for: req)
            guard let http = resp as? HTTPURLResponse, http.statusCode == 200 else {
                return (false, "", "这个地址没有响应 PrintGate")
            }
            let obj = try? JSONSerialization.jsonObject(with: data)
            let m = (obj as? [String: Any]) ?? [:]
            let app = pgStr(m["app"]).lowercased()
            guard (m["ok"] as? Bool) != false else { return (false, "", "服务端返回异常") }
            guard app.contains("printgate") else {
                return (false, "", "这个地址不是 PrintGate 服务")
            }
            return (true, pgStr(m["version"]), "")
        } catch let e as URLError {
            switch e.code {
            case .timedOut: return (false, "", "连接超时，确认手机和服务器在同一网络")
            case .cannotConnectToHost, .cannotFindHost: return (false, "", "连不上，地址或端口不对")
            default: return (false, "", "网络错误：\(e.localizedDescription)")
            }
        } catch {
            return (false, "", "网络错误：\(error.localizedDescription)")
        }
    }

    // MARK: 会话

    func login(_ username: String, _ password: String) async throws -> [String: Any] {
        try await send("POST", "/api/auth/account/login", body: ["username": username, "password": password])
    }

    func me() async throws -> MeResult {
        let d = try await send("GET", "/api/mp/me")
        var r = MeResult()
        r.user = PgUser(pgMap(d["user"]))
        r.config = pgMap(d["config"])
        return r
    }

    func changePassword(_ old: String, _ new: String) async throws {
        _ = try await send("POST", "/api/auth/account/password", body: ["oldPassword": old, "newPassword": new])
    }

    func saveProfile(_ profile: [String: Any]) async throws -> PgUser {
        let d = try await send("PUT", "/api/mp/profile", body: profile)
        return PgUser(pgMap(d["user"]))
    }

    func uploadAvatar(_ data: Data, filename: String = "avatar.jpg") async throws -> PgUser {
        let mime = filename.lowercased().hasSuffix(".png") ? "image/png" : "image/jpeg"
        let d = try await uploadMultipart(path: "/api/mp/avatar", fields: [:], fileField: "avatar", filename: filename, mime: mime, data: data)
        return PgUser(pgMap(d["user"]))
    }

    // MARK: 绑定 / 扫码

    func bindAdmin(_ bindToken: String) async throws -> [String: Any] {
        try await send("POST", "/api/mp/bind", body: ["token": bindToken])
    }

    func bindUser(_ ticket: String) async throws -> [String: Any] {
        try await send("POST", "/api/mp/bind-user", body: ["ticket": ticket])
    }

    func qrScan(_ ticket: String) async throws { _ = try await send("POST", "/api/mp/qr/scan", body: ["ticket": ticket]) }
    func qrConfirm(_ ticket: String) async throws { _ = try await send("POST", "/api/mp/qr/confirm", body: ["ticket": ticket]) }

    // MARK: 打印机

    func printers() async throws -> (list: [PgPrinter], def: String) {
        let d = try await send("GET", "/api/mp/printers")
        return (pgMaps(d["printers"]).map(PgPrinter.init), pgStr(d["default"]))
    }

    // MARK: 文件

    func files() async throws -> [PgFileItem] {
        let d = try await send("GET", "/api/mp/files")
        return pgMaps(d["files"]).map(PgFileItem.init)
    }

    func deleteFile(_ id: Int) async throws { _ = try await send("DELETE", "/api/mp/files/\(id)") }

    func upload(path: String, filename: String) async throws -> PgFileItem {
        let data = try Data(contentsOf: URL(fileURLWithPath: path))
        return try await upload(data: data, filename: filename)
    }

    /// ≤8MB 直传，超过走分片（与小程序同一阈值、同一套接口）
    func upload(data: Data, filename: String) async throws -> PgFileItem {
        if data.count > API.chunkLimit {
            return try await uploadChunked(data, filename: filename)
        }
        let d = try await uploadMultipart(
            path: "/api/mp/files",
            fields: ["filename": filename],
            fileField: "file",
            filename: filename,
            mime: API.mimeOf(filename),
            data: data
        )
        return try fileOf(d)
    }

    func mergeImages(_ ids: [Int], filename: String) async throws -> PgFileItem {
        let d = try await send("POST", "/api/mp/files/merge", body: ["ids": ids, "filename": filename])
        return try fileOf(d)
    }

    func previewData(_ fileId: Int, page: Int = 1) async throws -> Data {
        var req = try request("GET", "/api/mp/files/\(fileId)/preview", query: ["page": "\(page)"])
        req.timeoutInterval = 40
        let (data, resp) = try await perform(req)
        guard resp.statusCode < 400 else {
            throw APIError(message: "预览失败（HTTP \(resp.statusCode)）", status: resp.statusCode)
        }
        return data
    }

    // MARK: 打印任务

    func print(fileId: Int, printer: String, options: [String: Any]) async throws -> [String: Any] {
        try await send("POST", "/api/mp/print", body: ["fileId": fileId, "printer": printer, "options": options])
    }

    func tasks() async throws -> [PgTask] {
        let d = try await send("GET", "/api/mp/tasks")
        return pgMaps(d["tasks"]).map(PgTask.init)
    }

    func cancelTask(_ id: Int) async throws { _ = try await send("POST", "/api/mp/tasks/\(id)/cancel") }

    // MARK: 管理台

    func adminOverview() async throws -> (overview: [String: Any], printers: [[String: Any]]) {
        let d = try await send("GET", "/api/mp/admin/overview")
        return (pgMap(d["overview"]), pgMaps(d["printers"]))
    }

    func adminUsers(status: String = "all", q: String = "") async throws -> [PgUser] {
        let d = try await send("GET", "/api/mp/admin/users", query: ["status": status, "q": q])
        return pgMaps(d["users"]).map(PgUser.init)
    }

    func adminUserAction(_ id: Int, _ action: String) async throws {
        _ = try await send("POST", "/api/mp/admin/users/\(id)/\(action)")
    }

    func adminTasks(status: String = "pending") async throws -> [PgTask] {
        let d = try await send("GET", "/api/mp/admin/tasks", query: ["status": status])
        return pgMaps(d["tasks"]).map(PgTask.init)
    }

    func adminTaskAction(_ id: Int, _ action: String) async throws {
        _ = try await send("POST", "/api/mp/admin/tasks/\(id)/\(action)")
    }

    func adminTaskCleanup(status: String?) async throws -> [String: Any] {
        try await send("POST", "/api/mp/admin/tasks/cleanup", body: status == nil ? [:] : ["status": status!])
    }

    func adminPrinters() async throws -> [PgPrinter] {
        let d = try await send("GET", "/api/mp/admin/printers")
        return pgMaps(d["printers"]).map(PgPrinter.init)
    }

    func adminPrinterAction(_ name: String, _ action: String) async throws {
        let enc = name.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? name
        _ = try await send("POST", "/api/mp/admin/printers/\(enc)/\(action)")
    }

    func adminSettings() async throws -> (settings: [String: Any], printers: [String], schema: [String]) {
        let d = try await send("GET", "/api/mp/admin/settings")
        let printers = (d["printers"] as? [Any])?.map { pgStr($0) } ?? []
        let schema = (d["schema"] as? [Any])?.map { pgStr($0) } ?? []
        return (pgMap(d["settings"]), printers, schema)
    }

    func adminSaveSettings(_ patch: [String: Any]) async throws {
        _ = try await send("PUT", "/api/mp/admin/settings", body: patch)
    }

    // MARK: 完整后台（admin scope）

    /// 用后台管理密码换 admin 令牌（与用户令牌分开保存，只活在本会话）
    func adminLogin(_ password: String) async throws -> String {
        let d = try await send("POST", "/api/auth/login", body: ["password": password])
        let t = pgStr(d["token"])
        guard !t.isEmpty else { throw APIError(message: "后台登录失败：没拿到令牌") }
        return t
    }

    /// 全量设置：key 由后端决定，App 动态渲染，后端加字段不用发版
    func fullSettings() async throws -> [String: Any] {
        try await send("GET", "/api/settings")
    }

    func saveFullSettings(_ patch: [String: Any]) async throws {
        _ = try await send("PUT", "/api/settings", body: patch)
    }

    func officeStatus() async throws -> [String: Any] {
        try await send("GET", "/api/settings/office/status")
    }

    func officeInstall() async throws -> [String: Any] {
        try await send("POST", "/api/settings/office/install")
    }

    // MARK: 上传内部

    private func uploadChunked(_ data: Data, filename: String) async throws -> PgFileItem {
        let initResp = try await send("POST", "/api/mp/upload/init", body: [
            "filename": filename,
            "size": data.count,
            "mime": API.mimeOf(filename),
        ])
        let uploadId = pgStr(initResp["uploadId"])
        guard !uploadId.isEmpty else { throw APIError(message: "分片上传初始化失败") }
        let chunkSize = pgInt(initResp["chunkSize"]) == 0 ? 4 * 1024 * 1024 : pgInt(initResp["chunkSize"])
        let total = pgInt(initResp["total"]) == 0 ? 1 : pgInt(initResp["total"])

        do {
            for i in 0..<total {
                let start = i * chunkSize
                let end = min(start + chunkSize, data.count)
                let chunk = data.subdata(in: start..<end)
                _ = try await uploadMultipart(
                    path: "/api/mp/upload/chunk",
                    fields: ["uploadId": uploadId, "index": "\(i)"],
                    fileField: "chunk",
                    filename: "chunk.part",
                    mime: "application/octet-stream",
                    data: chunk
                )
            }
        } catch {
            // 失败要清掉服务端会话，否则临时目录堆垃圾
            _ = try? await send("DELETE", "/api/mp/upload/\(uploadId)")
            throw error
        }

        let done = try await send("POST", "/api/mp/upload/complete", body: ["uploadId": uploadId])
        return try fileOf(done)
    }

    private func uploadMultipart(
        path: String,
        fields: [String: String],
        fileField: String,
        filename: String,
        mime: String,
        data: Data
    ) async throws -> [String: Any] {
        let boundary = "----PrintGate\(Int(Date().timeIntervalSince1970 * 1000))\(Int.random(in: 1000...9999))"
        var body = Data()
        for (k, v) in fields {
            body.append("--\(boundary)\r\n".data(using: .utf8)!)
            body.append("Content-Disposition: form-data; name=\"\(k)\"\r\n\r\n".data(using: .utf8)!)
            body.append(v.data(using: .utf8)!)
            body.append("\r\n".data(using: .utf8)!)
        }
        body.append("--\(boundary)\r\n".data(using: .utf8)!)
        body.append("Content-Disposition: form-data; name=\"\(fileField)\"; filename=\"\(filename)\"\r\n".data(using: .utf8)!)
        body.append("Content-Type: \(mime)\r\n\r\n".data(using: .utf8)!)
        body.append(data)
        body.append("\r\n--\(boundary)--\r\n".data(using: .utf8)!)

        var req = try request("POST", path)
        req.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        req.httpBody = body
        req.timeoutInterval = 300
        let (respData, resp) = try await perform(req)
        return try parse(respData, resp)
    }

    private func fileOf(_ d: [String: Any]) throws -> PgFileItem {
        guard let f = d["file"] as? [String: Any] else {
            throw APIError(message: "服务端没返回文件信息")
        }
        return PgFileItem(f)
    }

    static func mimeOf(_ name: String) -> String {
        let ext = (name.split(separator: ".").last.map(String.init) ?? "").lowercased()
        switch ext {
        case "pdf": return "application/pdf"
        case "png": return "image/png"
        case "jpg", "jpeg": return "image/jpeg"
        case "webp": return "image/webp"
        case "gif": return "image/gif"
        case "heic": return "image/heic"
        case "doc": return "application/msword"
        case "docx": return "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        case "xls": return "application/vnd.ms-excel"
        case "xlsx": return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        case "ppt": return "application/vnd.ms-powerpoint"
        case "pptx": return "application/vnd.openxmlformats-officedocument.presentationml.presentation"
        case "txt": return "text/plain"
        default: return "application/octet-stream"
        }
    }
}
