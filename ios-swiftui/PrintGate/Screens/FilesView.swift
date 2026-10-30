import SwiftUI
import UIKit
import PhotosUI
import UniformTypeIdentifiers
import DesignFoundation

struct FilesView: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dfTheme) private var theme
    @Environment(ImportInbox.self) private var inbox

    @State private var files: [PgFileItem] = []
    @State private var loading = true
    @State private var busy = false
    @State private var busyText = ""

    @State private var showPhotos = false
    @State private var showImport = false
    @State private var preview: PgFileItem?
    @State private var pendingDelete: PgFileItem?

    var body: some View {
        NavigationStack {
            Group {
                if loading && files.isEmpty {
                    VStack(spacing: 10) {
                        DFSkeleton().frame(height: 64)
                        DFSkeleton().frame(height: 64)
                        DFSkeleton().frame(height: 64)
                    }
                    .padding(16)
                } else if files.isEmpty {
                    VStack(spacing: 14) {
                        EmptyHint(icon: "folder", title: "还没有文件", message: "上传 PDF / 图片 / 视频 / Office 文档后就能在这里打印", actionTitle: "上传文件") {
                            showImport = true
                        }
                        HStack(spacing: 10) {
                            DFButton("从相册多选") { showPhotos = true }
                                .dfButtonStyle(.outlined)
                            DFButton("从微信导入") { showImport = true }
                            Spacer()
                        }
                        .padding(.horizontal, 16)
                        DFText("在微信里长按文件 →「用其他应用打开」也可以直接送到这里。", scale: .caption)
                            .dfTextViewStyle(.secondary)
                            .multilineTextAlignment(.center)
                            .padding(.horizontal, 24)
                    }
                    .padding(.bottom, 24)
                } else {
                    ScrollView {
                        LazyVStack(spacing: 10) {
                            HStack(spacing: 10) {
                                DFButton("相册多选") { showPhotos = true }
                                    .dfButtonStyle(.outlined)
                                DFButton("微信 / 文件") { showImport = true }
                                    .dfButtonStyle(.ghost)
                                Spacer()
                            }
                            .padding(.horizontal, 14)
                            ForEach(files) { f in
                                fileCard(f)
                            }
                        }
                        .padding(.horizontal, 14)
                        .padding(.vertical, 8)
                    }
                }
            }
            .screenBackground()
            .dfNavigationBar(title: "文件", displayMode: .inline) {
                Menu {
                    Button {
                        showPhotos = true
                    } label: {
                        Label("从相册选择（图片 / 视频）", systemImage: "photo.on.rectangle")
                    }
                    Button {
                        showImport = true
                    } label: {
                        Label("从微信 / 文件导入", systemImage: "folder")
                    }
                } label: {
                    DFIcon("plus", size: 18)
                        .iconTapTarget()
                }
            }
            .safeAreaInset(edge: .bottom) {
                if busy {
                    HStack(spacing: 10) {
                        ProgressView().controlSize(.small)
                        DFText(busyText, scale: .caption).dfTextViewStyle(.secondary)
                        Spacer()
                    }
                    .padding(.horizontal, 16)
                    .padding(.vertical, 10)
                    .background(.bar)
                }
            }
            .refreshable { await load() }
            .sheet(isPresented: $showPhotos) {
                MediaPicker(
                    allowVideo: true,
                    selectionLimit: 9,
                    onPick: { picked in
                        showPhotos = false
                        Task { await uploadMedia(picked) }
                    },
                    onCancel: { showPhotos = false }
                )
            }
            .fileImporter(isPresented: $showImport, allowedContentTypes: [.pdf, .image, .movie, .plainText, .data], allowsMultipleSelection: true) { result in
                Task { await importFiles(result) }
            }
            .dfSheet(isPresented: Binding(
                get: { preview != nil },
                set: { if !$0 { preview = nil } }
            )) {
                if let f = preview {
                    FilePreviewSheet(file: f) {
                        pendingDelete = f
                    }
                }
            }
            .dfAlert(
                isPresented: Binding(get: { pendingDelete != nil }, set: { if !$0 { pendingDelete = nil } }),
                configuration: DFAlertConfiguration(
                    title: "删除文件？",
                    message: "删除后无法恢复，已打印的记录不受影响。",
                    actions: [
                        DFAlertAction(title: "取消", role: .cancel),
                        DFAlertAction(title: "删除", role: .destructive) {
                            if let f = pendingDelete { Task { await delete(f) } }
                        },
                    ]
                )
            )
            .task { await load(); await drainInbox() }
            .onChange(of: inbox.urls.count) { _, _ in
                Task { await drainInbox() }
            }
        }
    }

    private func fileCard(_ f: PgFileItem) -> some View {
        DFCard {
            VStack(spacing: 10) {
                HStack(spacing: 12) {
                    ZStack {
                        RoundedRectangle(cornerRadius: 10)
                            .fill(theme.colors.surface)
                            .frame(width: 44, height: 44)
                        DFIcon(f.iconName, size: 20)
                            .foregroundStyle(theme.colors.primary)
                    }
                    VStack(alignment: .leading, spacing: 3) {
                        DFText(f.filename, scale: .body).lineLimit(2)
                        DFText("\(Fmt.size(f.size)) · \(f.pages > 0 ? "\(f.pages) 页" : "页数未知") · \(Fmt.relative(f.createdAt))", scale: .caption)
                            .dfTextViewStyle(.secondary)
                    }
                    Spacer(minLength: 4)
                    Button {
                        preview = f
                    } label: {
                        DFIcon("eye", size: 18)
                            .foregroundStyle(theme.colors.textSecondary)
                            .iconTapTarget()
                    }
                    .buttonStyle(.plain)
                }

                HStack(spacing: 8) {
                    DFButton("打印") { printDirect(f) }
                        .dfButtonStyle(.tinted)
                    DFButton("预览") { preview = f }
                        .dfButtonStyle(.outlined)
                    Spacer()
                    Button {
                        pendingDelete = f
                    } label: {
                        DFIcon("trash", size: 16)
                            .foregroundStyle(theme.colors.destructive)
                            .iconTapTarget()
                    }
                    .buttonStyle(.plain)
                }
            }
        }
        .swipeActionsIfAvailable()
    }

    // MARK: 数据

    private func load() async {
        do {
            files = try await API().files()
        } catch {
            DFToastQueue.shared.show(text: pgMessage(error), severity: .error)
        }
        loading = false
    }

    /// 处理从微信 / 其他 App「用其他应用打开」送进来的文件
    private func drainInbox() async {
        guard !inbox.urls.isEmpty else { return }
        let urls = inbox.urls
        inbox.urls = []
        busy = true
        var done = 0
        for (i, url) in urls.enumerated() {
            busyText = "导入 \(i + 1)/\(urls.count)…"
            let got = url.startAccessingSecurityScopedResource()
            defer { if got { url.stopAccessingSecurityScopedResource() } }
            do {
                let data = try Data(contentsOf: url)
                _ = try await API().upload(data: data, filename: url.lastPathComponent)
                done += 1
            } catch {
                DFToastQueue.shared.show(text: "\(url.lastPathComponent) 失败：\(pgMessage(error))", severity: .error)
            }
        }
        busy = false
        if done > 0 {
            DFToastQueue.shared.show(text: "已导入 \(done) 个文件", severity: .success)
            await load()
        }
    }

    private func delete(_ f: PgFileItem) async {
        do {
            try await API().deleteFile(f.id)
            files.removeAll { $0.id == f.id }
            DFToastQueue.shared.show(text: "已删除", severity: .success)
        } catch {
            DFToastQueue.shared.show(text: pgMessage(error), severity: .error)
        }
        pendingDelete = nil
    }

    private func printDirect(_ f: PgFileItem) {
        Task {
            do {
                let r = try await API().printers()
                guard let p = r.list.first(where: { $0.name == r.def }) ?? r.list.first else {
                    throw APIError(message: "没有可用打印机")
                }
                _ = try await API().print(fileId: f.id, printer: p.name, options: ["copies": 1])
                DFToastQueue.shared.show(text: "已提交到 \(p.name)", severity: .success)
            } catch {
                DFToastQueue.shared.show(text: pgMessage(error), severity: .error)
            }
        }
    }

    private func uploadMedia(_ items: [PickedMedia]) async {
        guard !items.isEmpty else { return }
        busy = true
        var done = 0
        for (i, m) in items.enumerated() {
            busyText = "上传 \(i + 1)/\(items.count)…"
            do {
                _ = try await API().upload(data: m.data, filename: m.filename)
                done += 1
            } catch {
                DFToastQueue.shared.show(text: "第 \(i + 1) 个失败：\(pgMessage(error))", severity: .error)
            }
        }
        busy = false
        if done > 0 {
            DFToastQueue.shared.show(text: "已上传 \(done) 个", severity: .success)
            await load()
        }
    }

    private func importFiles(_ result: Result<[URL], Error>) async {
        guard case let .success(urls) = result, !urls.isEmpty else { return }
        busy = true
        var done = 0
        for (i, url) in urls.enumerated() {
            busyText = "上传 \(i + 1)/\(urls.count)…"
            let got = url.startAccessingSecurityScopedResource()
            defer { if got { url.stopAccessingSecurityScopedResource() } }
            do {
                let data = try Data(contentsOf: url)
                _ = try await API().upload(data: data, filename: url.lastPathComponent)
                done += 1
            } catch {
                DFToastQueue.shared.show(text: "\(url.lastPathComponent) 失败：\(pgMessage(error))", severity: .error)
            }
        }
        busy = false
        if done > 0 {
            DFToastQueue.shared.show(text: "已上传 \(done) 个文件", severity: .success)
            await load()
        }
    }
}

// MARK: - 预览

struct FilePreviewSheet: View {
    var file: PgFileItem
    var onDelete: () -> Void

    @Environment(\.dismiss) private var dismiss
    @Environment(\.dfTheme) private var theme

    @State private var page = 1
    @State private var image: UIImage?
    @State private var loading = true
    @State private var error = ""

    private var pageCount: Int { max(1, file.pages) }

    var body: some View {
        NavigationStack {
            VStack(spacing: 12) {
                ZStack {
                    RoundedRectangle(cornerRadius: 12)
                        .fill(theme.colors.surface)
                    if loading {
                        ProgressView()
                    } else if let image {
                        Image(uiImage: image)
                            .resizable()
                            .scaledToFit()
                            .padding(6)
                    } else {
                        VStack(spacing: 10) {
                            DFIcon("exclamationmark.triangle", size: 24)
                                .foregroundStyle(theme.colors.warning)
                            DFText(error.isEmpty ? "无法预览" : error, scale: .caption)
                                .dfTextViewStyle(.secondary)
                                .multilineTextAlignment(.center)
                                .padding(.horizontal, 16)
                            DFButton("重试") { Task { await load() } }
                                .dfButtonStyle(.outlined)
                        }
                    }
                }
                .frame(maxHeight: .infinity)

                if pageCount > 1 {
                    HStack(spacing: 16) {
                        DFButton("上一页") { page = max(1, page - 1); Task { await load() } }
                            .dfButtonStyle(.outlined)
                            .disabled(page <= 1)
                        DFText("\(page) / \(pageCount)", scale: .caption)
                        DFButton("下一页") { page = min(pageCount, page + 1); Task { await load() } }
                            .dfButtonStyle(.outlined)
                            .disabled(page >= pageCount)
                    }
                }

                HStack(spacing: 10) {
                    DFButton("存到相册") { saveToAlbum() }
                        .dfButtonStyle(.ghost)
                        .disabled(image == nil)
                    DFButton("删除", style: .ghost, role: .destructive) {
                        dismiss()
                        onDelete()
                    }
                    Spacer()
                }
            }
            .padding(.horizontal, 16)
            .padding(.top, 16)
            .safeBottomPadding()
            .screenBackground()
            .dfNavigationBar(title: file.filename, displayMode: .inline) {
                DFButton("关闭") { dismiss() }.dfButtonStyle(.ghost)
            }
            .task { await load(); await drainInbox() }
            .onChange(of: inbox.urls.count) { _, _ in
                Task { await drainInbox() }
            }
        }
    }

    private func load() async {
        loading = true
        error = ""
        do {
            let data = try await API().previewData(file.id, page: page)
            image = UIImage(data: data)
            if image == nil { error = "服务端返回的不是图片" }
        } catch {
            self.error = Self.previewErrorText(error)
            image = nil
        }
        loading = false
    }

    /// 把 HTTP 状态码翻成能看懂的原因，便于判断是文件没了还是服务端缺转换组件
    private static func previewErrorText(_ e: Error) -> String {
        guard let apiErr = e as? APIError else { return e.localizedDescription }
        switch apiErr.status {
        case 401, 403: return "登录已失效，请重新登录后再预览"
        case 404: return "文件不存在或已被删除"
        case 410: return "源文件已清理，无法预览"
        case 415: return "服务端生成预览失败（PDF 需要 poppler-utils，Office 文档需要先装 LibreOffice 转换组件）"
        default: return apiErr.message.isEmpty ? "预览失败（HTTP \(apiErr.status)）" : apiErr.message
        }
    }

    private func saveToAlbum() {
        guard let img = image else { return }
        UIImageWriteToSavedPhotosAlbum(img, nil, nil, nil)
        DFToastQueue.shared.show(text: "已存入相册", severity: .success)
    }
}

// MARK: - 便捷

extension View {
    /// 预留：暂时不接 swipe 手势，保持卡片结构简单
    func swipeActionsIfAvailable() -> some View { self }
}
