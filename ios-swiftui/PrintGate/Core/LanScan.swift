import Foundation
import Observation

struct LanHit: Identifiable, Hashable, Sendable {
    var base: String
    var version: String
    var id: String { base }

    var display: String {
        base.replacingOccurrences(of: "http://", with: "")
    }
}

/// 局域网发现 PrintGate。
///
/// 与小程序同一套策略：猜网段 + 逐个 `GET /api/health`，
/// 不依赖 Bonjour / 私有 API，局域网 http 也不会被 ATS 拦。
@MainActor
@Observable
final class LanScanner {
    static let portMain = 8080
    static let altPorts = [80, 8000, 3000]

    static let subnets = [
        "192.168.1.", "192.168.0.", "192.168.31.", "192.168.2.", "192.168.3.", "192.168.4.",
        "10.0.0.", "10.0.1.", "10.1.1.", "172.16.0.",
    ]
    static let gatewayHosts = ["1", "254"]
    static let serverHosts = ["2", "10", "50", "100", "101", "102", "110", "200"]

    var hits: [LanHit] = []
    var scanned = 0
    var total = 0
    var running = false

    private var task: Task<Void, Never>?

    var progress: Double { total == 0 ? 0 : Double(scanned) / Double(total) }

    static func candidates(prefix: String) -> [String] {
        let p = prefix.trimmingCharacters(in: .whitespaces)
        if p.range(of: #"^\d{1,3}\.\d{1,3}\.\d{1,3}\.$"#, options: .regularExpression) != nil {
            return (1...254).map { "http://\(p)\($0):\(portMain)" }
        }
        var out: [String] = []
        out.append("http://127.0.0.1:\(portMain)")
        out.append("http://127.0.0.1:80")
        for sn in subnets {
            for h in gatewayHosts {
                out.append("http://\(sn)\(h):\(portMain)")
                for port in altPorts { out.append("http://\(sn)\(h):\(port)") }
            }
        }
        for sn in subnets {
            for h in serverHosts {
                out.append("http://\(sn)\(h):\(portMain)")
                out.append("http://\(sn)\(h):80")
            }
        }
        return out
    }

    func start(prefix: String = "") {
        guard !running else { return }
        let list = LanScanner.candidates(prefix: prefix)
        hits = []
        scanned = 0
        total = list.count
        running = true

        task = Task { [weak self] in
            await withTaskGroup(of: LanHit?.self) { group in
                var idx = 0
                let width = min(24, list.count)
                for _ in 0..<width {
                    if idx < list.count {
                        let base = list[idx]; idx += 1
                        group.addTask { await LanScanner.probe(base) }
                    }
                }
                while let result = await group.next() {
                    if Task.isCancelled { group.cancelAll(); break }
                    if let hit = result {
                        await MainActor.run { self?.appendHit(hit) }
                    }
                    await MainActor.run { self?.scanned += 1 }
                    if idx < list.count {
                        let base = list[idx]; idx += 1
                        group.addTask { await LanScanner.probe(base) }
                    }
                }
            }
            await MainActor.run {
                self?.running = false
                self?.scanned = self?.total ?? 0
            }
        }
    }

    func stop() {
        task?.cancel()
        task = nil
        running = false
    }

    private func appendHit(_ h: LanHit) {
        if !hits.contains(where: { $0.base == h.base }) { hits.append(h) }
    }

    nonisolated static func probe(_ base: String) async -> LanHit? {
        guard let url = URL(string: base + "/api/health") else { return nil }
        var req = URLRequest(url: url)
        req.timeoutInterval = 0.9
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        let cfg = URLSessionConfiguration.ephemeral
        cfg.timeoutIntervalForRequest = 0.9
        cfg.waitsForConnectivity = false
        cfg.requestCachePolicy = .reloadIgnoringLocalCacheData
        do {
            let (data, resp) = try await URLSession(configuration: cfg).data(for: req)
            guard let http = resp as? HTTPURLResponse, http.statusCode == 200 else { return nil }
            let raw = try? JSONSerialization.jsonObject(with: data)
            guard let obj = raw as? [String: Any] else { return nil }
            guard (obj["ok"] as? Bool) == true,
                  pgStr(obj["app"]).lowercased().contains("printgate")
            else { return nil }
            return LanHit(base: base, version: pgStr(obj["version"]))
        } catch {
            return nil
        }
    }
}
