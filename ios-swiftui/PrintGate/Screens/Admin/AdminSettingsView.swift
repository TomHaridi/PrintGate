import SwiftUI
import DesignFoundation

struct AdminSettingsView: View {
    @Environment(\.dfTheme) private var theme

    @State private var loading = true
    @State private var saving = false
    @State private var error = ""

    @State private var maxFileMB = "20"
    @State private var maxCopies = "99"
    @State private var maxPages = "50"
    @State private var historyDays = "30"

    @State private var approveNewUser = false
    @State private var approveEachJob = false
    @State private var enableQrLogin = true
    @State private var autoCleanHistory = true

    @State private var defaultPrinter = ""
    @State private var printers: [String] = []

    var body: some View {
        ScrollView {
            VStack(spacing: 14) {
                DFCard {
                    VStack(alignment: .leading, spacing: 12) {
                        DFText("限额", scale: .label).dfTextViewStyle(.secondary)
                        DFTextField("单文件上限（MB）", text: $maxFileMB, placeholder: "20")
                            .keyboardType(.numberPad)
                        DFTextField("单任务最多份数", text: $maxCopies, placeholder: "99")
                            .keyboardType(.numberPad)
                        DFTextField("单文件最多页数", text: $maxPages, placeholder: "50")
                            .keyboardType(.numberPad)
                        DFTextField("历史保留天数（0 = 永久）", text: $historyDays, placeholder: "30")
                            .keyboardType(.numberPad)
                    }
                }

                DFCard {
                    VStack(alignment: .leading, spacing: 4) {
                        DFText("审批与安全", scale: .label).dfTextViewStyle(.secondary)
                            .padding(.bottom, 4)
                        DFToggle("新用户需要管理员审批", isOn: $approveNewUser)
                        DFToggle("每个打印任务需管理员审批", isOn: $approveEachJob)
                        DFToggle("允许扫码登录网页后台", isOn: $enableQrLogin)
                        DFToggle("自动清理过期历史", isOn: $autoCleanHistory)
                    }
                }

                DFCard {
                    VStack(alignment: .leading, spacing: 10) {
                        DFText("默认打印机", scale: .label).dfTextViewStyle(.secondary)
                        if printers.isEmpty {
                            DFText("服务端没有可用打印机", scale: .caption).dfTextViewStyle(.secondary)
                        } else {
                            DFPicker("默认打印机", selection: $defaultPrinter) {
                                Text("不设置").tag("")
                                ForEach(printers, id: \.self) { p in
                                    Text(p).tag(p)
                                }
                            }
                        }
                    }
                }

                if !error.isEmpty {
                    DFBanner(icon: "exclamationmark.triangle.fill", message: error, severity: .error, isDismissible: false, onDismiss: {})
                }

                DFButton(saving ? "保存中…" : "保存设置") {
                    Task { await save() }
                }
                .disabled(saving || loading)

                DFText("保存后立即生效，不需要重启服务。", scale: .caption).dfTextViewStyle(.secondary)
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
        }
        .screenBackground()
        .dfNavigationBar(title: "常用设置", displayMode: .inline)
        .task { await load() }
    }

    private func load() async {
        do {
            let r = try await API().adminSettings()
            let s = r.settings
            maxFileMB = "\(pgInt(s["maxFileMB"]))"
            maxCopies = "\(pgInt(s["maxCopies"]))"
            maxPages = "\(pgInt(s["maxPages"]))"
            historyDays = "\(pgInt(s["historyDays"]))"
            approveNewUser = pgBool(s["approveNewUser"])
            approveEachJob = pgBool(s["approveEachJob"])
            enableQrLogin = pgBool(s["enableQrLogin"], true)
            autoCleanHistory = pgBool(s["autoCleanHistory"], true)
            defaultPrinter = pgStr(s["defaultPrinter"])
            printers = r.printers
            error = ""
        } catch {
            self.error = pgMessage(error)
        }
        loading = false
    }

    private func save() async {
        saving = true
        error = ""
        let patch: [String: Any] = [
            "maxFileMB": Int(maxFileMB.trimmingCharacters(in: .whitespaces)) ?? 20,
            "maxCopies": Int(maxCopies.trimmingCharacters(in: .whitespaces)) ?? 99,
            "maxPages": Int(maxPages.trimmingCharacters(in: .whitespaces)) ?? 50,
            "historyDays": Int(historyDays.trimmingCharacters(in: .whitespaces)) ?? 30,
            "approveNewUser": approveNewUser,
            "approveEachJob": approveEachJob,
            "enableQrLogin": enableQrLogin,
            "autoCleanHistory": autoCleanHistory,
            "defaultPrinter": defaultPrinter,
        ]
        do {
            try await API().adminSaveSettings(patch)
            DFToastQueue.shared.show(text: "设置已保存", severity: .success)
        } catch {
            self.error = pgMessage(error)
        }
        saving = false
    }
}
