import Foundation

/// 服务器地址的本地存储与规范化。
/// 只存一个地址：PrintGate 是私有部署，一台设备一般就对应一台服务器。
enum Store {
    private static let key = "pg.base.url"

    static var baseURL: URL? {
        get {
            guard let s = UserDefaults.standard.string(forKey: key), !s.isEmpty else { return nil }
            return URL(string: s)
        }
        set {
            if let v = newValue?.absoluteString {
                UserDefaults.standard.set(v, forKey: key)
            } else {
                UserDefaults.standard.removeObject(forKey: key)
            }
        }
    }

    /// 用户可能只输入 `192.168.1.10:8080`，这里补协议、去尾部斜杠。
    /// 内网默认 http，公网默认 https —— 与小程序端的规则保持一致。
    static func normalize(_ raw: String) -> URL? {
        var s = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !s.isEmpty else { return nil }

        if !s.lowercased().hasPrefix("http://") && !s.lowercased().hasPrefix("https://") {
            let host = s.split(separator: "/").first.map(String.init) ?? s
            let hostOnly = host.split(separator: ":").first.map(String.init) ?? host
            let isPrivate = hostOnly.hasPrefix("192.168.") || hostOnly.hasPrefix("10.")
                || hostOnly.hasPrefix("127.") || hostOnly.hasPrefix("localhost")
                || hostOnly.hasPrefix("172.16.") || hostOnly.hasPrefix("172.17.")
                || hostOnly.hasPrefix("172.18.") || hostOnly.hasPrefix("172.19.")
                || hostOnly.range(of: #"^172\.(2[0-9]|3[01])\."#, options: .regularExpression) != nil
            s = (isPrivate ? "http://" : "https://") + s
        }
        while s.hasSuffix("/") { s.removeLast() }

        guard let url = URL(string: s), let host = url.host, !host.isEmpty else { return nil }
        return url
    }

    /// 探测是不是一台 PrintGate：GET /api/health，返回里必须有 app=PrintGate
    static func probe(_ base: URL, completion: @escaping (Result<String, String>) -> Void) {
        guard let url = URL(string: base.absoluteString + "/api/health") else {
            completion(.failure("地址格式不正确"))
            return
        }
        var req = URLRequest(url: url)
        req.timeoutInterval = 8
        req.cachePolicy = .reloadIgnoringLocalCacheData
        URLSession.shared.dataTask(with: req) { data, resp, err in
            DispatchQueue.main.async {
                if let err = err {
                    completion(.failure("连不上：\(err.localizedDescription)"))
                    return
                }
                guard let http = resp as? HTTPURLResponse, http.statusCode == 200,
                      let data = data,
                      let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                    completion(.failure("这个地址没有返回 PrintGate 的响应"))
                    return
                }
                if (obj["app"] as? String) != "PrintGate" {
                    completion(.failure("能连上，但对方不是 PrintGate 服务"))
                    return
                }
                let ver = obj["version"] as? String ?? ""
                completion(.success(ver))
            }
        }.resume()
    }
}
