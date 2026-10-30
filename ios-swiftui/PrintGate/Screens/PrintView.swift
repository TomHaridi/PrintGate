import SwiftUI
import PhotosUI
import UniformTypeIdentifiers
import DesignFoundation

/// 打印参数（键名与小程序 / 后端 CUPS 选项一一对应）
struct PrintOptions {
    var copies = 1
    var color = "mono"
    var sides = "one-sided"
    var media = "A4"
    var orientation = "portrait"
    var numberUp = 1
    var scaling = "fit"
    var pageSet = "all"
    var mirror = false
    var pageBorder = false
    var watermark = ""
    var ranges = ""

    static let mediaList = ["A4", "A3", "A5", "A6", "Letter", "Legal", "B5", "16K"]
    static let numberUpList = [1, 2, 4, 6, 9, 16]

    func dict() -> [String: Any] {
        let r = Fmt.sanitizeRanges(ranges)
        var d: [String: Any] = [
            "copies": copies,
            "color": color,
            "sides": sides,
            "media": media,
            "orientation": orientation,
            "numberUp": numberUp,
            "numberUpLayout": "lrtb",
            "scaling": scaling,
            "pageSet": pageSet,
            "mirror": mirror,
            "pageBorder": pageBorder,
        ]
        if !r.isEmpty { d["pageRanges"] = r }
        let w = watermark.trimmingCharacters(in: .whitespacesAndNewlines)
        if !w.isEmpty { d["watermark"] = w }
        return d
    }
}

struct SegOption: Identifiable, Hashable {
    let id: String
    let title: String
    init(_ id: String, _ title: String) {
        self.id = id
        self.title = title
    }
}

struct PickedImage: Identifiable, Hashable {
    let id = UUID()
    var image: UIImage
    var name: String

    static func == (a: PickedImage, b: PickedImage) -> Bool { a.id == b.id }
    func hash(into h: inout Hasher) { h.combine(id) }
}

struct PrintView: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dfTheme) private var theme

    @State private var mode: PrintMode = .file
    @State private var options = PrintOptions()
    @State private var advanced = false

    @State private var printers: [PgPrinter] = []
    @State private var printer = ""

    @State private var picked: PgFileItem?
    @State private var showLibrary = false

    @State private var title = ""
    @State private var body_ = ""
    @State private var fontSize: Double = 12

    @State private var invoices: [PickedImage] = []
    @State private var perInvoice = 2
    @State private var idFront: PickedImage?
    @State private var idBack: PickedImage?

    @State private var photoItems: [PhotosPickerItem] = []
    @State private var photoTarget: PhotoTarget = .invoice
    @State private var showPhotos = false
    @State private var showFileImport = false

    @State private var busy = false
    @State private var busyText = ""

    private enum PhotoTarget { case invoice, front, back }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 14) {
                    // 用 AnyView 擦除每个卡片的返回类型：body 的返回类型原本是
                    // 6 个卡片完整嵌套类型的内联（20+ 层），运行时实例化会
                    // 在 swift_getTypeByMangledName 递归解析时栈溢出（SIGSEGV）。
                    // 擦除后 body 只剩浅层 VStack<TupleView<AnyView...>>。
                    AnyView(modeBar)
                    AnyView(contentCard)
                    AnyView(printerCard)
                    AnyView(commonCard)
                    AnyView(advancedCard)
                    AnyView(historyHint)
                }
                .padding(.horizontal, 14)
                .padding(.top, 6)
                .padding(.bottom, 18)
            }
            .screenBackground()
            .dfNavigationBar(title: "打印", displayMode: .inline) {
                Button {
                    Task { await loadPrinters() }
                } label: {
                    DFIcon("arrow.clockwise", size: 18)
                }
            }
            .safeAreaInset(edge: .bottom) {
                submitBar
            }
            .dfSheet(isPresented: $showLibrary) {
                FilePickerSheet { f in
                    picked = f
                    mode = .file
                }
            }
            .photosPicker(isPresented: $showPhotos, selection: $photoItems, maxSelectionCount: 9, matching: .images)
            .fileImporter(isPresented: $showFileImport, allowedContentTypes: [.pdf, .image, .plainText, .data], allowsMultipleSelection: false) { result in
                Task { await handleImport(result) }
            }
            .onChange(of: photoItems) { _, items in
                Task { await loadPhotos(items) }
            }
            .task {
                if printers.isEmpty { await loadPrinters() }
            }
        }
    }

    // MARK: 模式

    private var modeBar: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(PrintMode.allCases) { m in
                    Button {
                        mode = m
                    } label: {
                        DFChip(.selectable(m.title), isSelected: mode == m)
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.horizontal, 2)
            .padding(.vertical, 2)
        }
    }

    // MARK: 内容区

    @ViewBuilder
    private var contentCard: some View {
        DFCard {
            VStack(alignment: .leading, spacing: 12) {
                HStack(spacing: 8) {
                    DFIcon(mode.icon, size: 16)
                        .foregroundStyle(theme.colors.primary)
                    DFText(mode.title, scale: .labelLarge)
                    Spacer()
                }
                DFText(mode.hint, scale: .caption).dfTextViewStyle(.secondary)

                switch mode {
                case .file:
                    fileContent
                case .text:
                    textContent
                case .invoice:
                    invoiceContent
                case .idcard:
                    idCardContent
                }
            }
        }
    }

    private var fileContent: some View {
        VStack(alignment: .leading, spacing: 10) {
            if let f = picked {
                HStack(spacing: 10) {
                    DFIcon(f.iconName, size: 22).foregroundStyle(theme.colors.primary)
                    VStack(alignment: .leading, spacing: 2) {
                        DFText(f.filename, scale: .body)
                        DFText("\(Fmt.size(f.size)) · \(f.pages > 0 ? "\(f.pages) 页" : "页数未知")", scale: .caption)
                            .dfTextViewStyle(.secondary)
                    }
                    Spacer()
                    Button {
                        picked = nil
                    } label: {
                        DFIcon("xmark.circle.fill", size: 18)
                            .foregroundStyle(theme.colors.textSecondary)
                            .iconTapTarget()
                    }
                    .buttonStyle(.plain)
                }
                .padding(10)
                .background(theme.colors.surface, in: RoundedRectangle(cornerRadius: 10))
            }

            HStack(spacing: 10) {
                DFButton(picked == nil ? "从文件库选择" : "换一个文件") { showLibrary = true }
                    .dfButtonStyle(.outlined)
                DFButton("导入文件") { showFileImport = true }
                    .dfButtonStyle(.ghost)
                Spacer()
            }
        }
    }

    private var textContent: some View {
        VStack(alignment: .leading, spacing: 10) {
            DFTextField("标题（可留空）", text: $title, placeholder: "标题（可留空）")
            DFTextArea("正文", text: $body_, placeholder: "要打印的文字，支持换行", minLines: 6, maxLines: 14)

            HStack(spacing: 10) {
                DFText("字号", scale: .caption).dfTextViewStyle(.secondary)
                Slider(value: $fontSize, in: 8...28, step: 1)
                DFText("\(Int(fontSize)) pt", scale: .caption)
                    .frame(width: 44, alignment: .trailing)
            }
        }
    }

    private var invoiceContent: some View {
        VStack(alignment: .leading, spacing: 10) {
            imageStrip(invoices, removable: true) { idx in
                invoices.remove(at: idx)
            }
            HStack(spacing: 10) {
                DFButton("添加发票图") {
                    photoTarget = .invoice
                    photoItems = []
                    showPhotos = true
                }
                .dfButtonStyle(.outlined)
                Spacer()
                DFText("每页 \(perInvoice) 张", scale: .caption).dfTextViewStyle(.secondary)
            }
            HStack(spacing: 8) {
                ForEach([1, 2, 4], id: \.self) { n in
                    Button {
                        perInvoice = n
                    } label: {
                        DFChip(.selectable("\(n) 张/页"), isSelected: perInvoice == n)
                    }
                    .buttonStyle(.plain)
                }
            }
            DFText("多张发票排在同一页，省纸。最多 9 张。", scale: .caption).dfTextViewStyle(.secondary)
        }
    }

    private var idCardContent: some View {
        HStack(spacing: 12) {
            idSlot("正面", idFront) {
                photoTarget = .front
                photoItems = []
                showPhotos = true
            }
            idSlot("反面", idBack) {
                photoTarget = .back
                photoItems = []
                showPhotos = true
            }
        }
    }

    private func idSlot(_ label: String, _ img: PickedImage?, onTap: @escaping () -> Void) -> some View {
        Button(action: onTap) {
            VStack(spacing: 8) {
                if let img {
                    Image(uiImage: img.image)
                        .resizable()
                        .scaledToFill()
                        .frame(height: 92)
                        .clipped()
                        .clipShape(RoundedRectangle(cornerRadius: 10))
                } else {
                    RoundedRectangle(cornerRadius: 10)
                        .strokeBorder(style: StrokeStyle(lineWidth: 1, dash: [4, 3]))
                        .foregroundStyle(theme.colors.border)
                        .frame(height: 92)
                        .overlay(
                            VStack(spacing: 4) {
                                DFIcon("plus.viewfinder", size: 20)
                                    .foregroundStyle(theme.colors.textSecondary)
                                DFText(label, scale: .caption).dfTextViewStyle(.secondary)
                            }
                        )
                }
                DFText(img == nil ? "点选\(label)" : "重选\(label)", scale: .caption)
                    .foregroundStyle(theme.colors.primary)
            }
        }
        .buttonStyle(.plain)
    }

    private func imageStrip(_ items: [PickedImage], removable: Bool, onRemove: @escaping (Int) -> Void) -> some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(Array(items.enumerated()), id: \.element.id) { idx, item in
                    ZStack(alignment: .topTrailing) {
                        Image(uiImage: item.image)
                            .resizable()
                            .scaledToFill()
                            .frame(width: 72, height: 72)
                            .clipped()
                            .clipShape(RoundedRectangle(cornerRadius: 8))
                        if removable {
                            Button {
                                onRemove(idx)
                            } label: {
                                DFIcon("xmark.circle.fill", size: 16)
                                    .foregroundStyle(.white, .black.opacity(0.55))
                                    .iconTapTarget(36)
                            }
                            .buttonStyle(.plain)
                            .offset(x: 4, y: -4)
                        }
                    }
                }
            }
            .padding(2)
        }
    }

    // MARK: 打印机

    private var printerCard: some View {
        DFCard {
            VStack(alignment: .leading, spacing: 10) {
                HStack(spacing: 8) {
                    DFIcon("printer.fill", size: 16).foregroundStyle(theme.colors.primary)
                    DFText("目标打印机", scale: .labelLarge)
                    Spacer()
                    Button {
                        Task { await loadPrinters() }
                    } label: {
                        DFText("刷新", scale: .caption).foregroundStyle(theme.colors.primary)
                    }
                    .buttonStyle(.plain)
                }

                if printers.isEmpty {
                    HStack(spacing: 8) {
                        DFIcon("exclamationmark.triangle.fill", size: 14)
                            .foregroundStyle(theme.colors.warning)
                        DFText("没有可用打印机，检查服务端 CUPS", scale: .caption)
                            .dfTextViewStyle(.secondary)
                    }
                } else {
                    DFPicker("打印机", selection: Binding(
                        get: { printer.isEmpty ? (printers.first?.name ?? "") : printer },
                        set: { printer = $0 }
                    )) {
                        ForEach(printers) { p in
                            Text("\(p.name)\(p.isDefault ? "（默认）" : "")").tag(p.name)
                        }
                    }
                    if let p = printers.first(where: { $0.name == (printer.isEmpty ? (printers.first?.name ?? "") : printer) }) {
                        HStack(spacing: 6) {
                            StatusBadge(text: p.stateText, color: p.state.lowercased() == "idle" ? .green : .orange)
                            if !p.location.isEmpty {
                                DFText(p.location, scale: .caption).dfTextViewStyle(.secondary)
                            }
                        }
                    }
                }
            }
        }
    }

    // MARK: 常用参数

    private var commonCard: some View {
        DFCard {
            VStack(alignment: .leading, spacing: 14) {
                HStack {
                    DFText("份数", scale: .body)
                    Spacer()
                    Stepper(value: $options.copies, in: 1...max(1, app.me?.maxCopies ?? 99)) {
                        DFText("\(options.copies)", scale: .body)
                            .frame(minWidth: 30, alignment: .trailing)
                    }
                    .labelsHidden()
                }

                segRow("色彩", selection: $options.color, items: [SegOption("mono", "黑白"), SegOption("color", "彩色")])
                segRow("单双面", selection: $options.sides, items: [SegOption("one-sided", "单面"), SegOption("two-sided-long-edge", "双面长边"), SegOption("two-sided-short-edge", "双面短边")])

                HStack {
                    DFText("纸张", scale: .body)
                    Spacer()
                    DFPicker("纸张", selection: $options.media) {
                        ForEach(PrintOptions.mediaList, id: \.self) { m in
                            Text(m).tag(m)
                        }
                    }
                    .labelsHidden()
                    .frame(maxWidth: 150)
                }
            }
        }
    }

    private func segRow(_ label: String, selection: Binding<String>, items: [SegOption]) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            DFText(label, scale: .body)
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(items) { item in
                        Button {
                            selection.wrappedValue = item.id
                        } label: {
                            DFChip(.selectable(item.title), isSelected: selection.wrappedValue == item.id)
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
        }
    }

    // MARK: 高级

    private var advancedCard: some View {
        DFCard {
            DFAccordion("更多设置", subtitle: "方向 / 合并 / 缩放 / 页范围 / 水印", icon: "slider.horizontal.3", isExpanded: $advanced) {
                VStack(alignment: .leading, spacing: 14) {
                    segRow("方向", selection: $options.orientation, items: [SegOption("portrait", "纵向"), SegOption("landscape", "横向")])
                    segRow("缩放", selection: $options.scaling, items: [SegOption("auto", "自动"), SegOption("fit", "适应"), SegOption("fill", "填充"), SegOption("none", "原始")])
                    segRow("打印页", selection: $options.pageSet, items: [SegOption("all", "全部"), SegOption("odd", "奇数页"), SegOption("even", "偶数页")])

                    HStack {
                        DFText("每页页数", scale: .body)
                        Spacer()
                        DFPicker("每页页数", selection: $options.numberUp) {
                            ForEach(PrintOptions.numberUpList, id: \.self) { n in
                                Text("\(n) 页/张").tag(n)
                            }
                        }
                        .labelsHidden()
                        .frame(maxWidth: 150)
                    }

                    DFTextField("页范围（留空打印全部）", text: $options.ranges, placeholder: "例如 1-3,5")

                    DFTextField("水印文字（最多 40 字）", text: $options.watermark, placeholder: "例如 仅限内部使用")

                    DFToggle("镜像打印", isOn: $options.mirror)
                    DFToggle("页边框", isOn: $options.pageBorder)
                }
                .padding(.top, 4)
            }
        }
    }

    private var historyHint: some View {
        HStack(spacing: 6) {
            DFIcon("info.circle", size: 13)
            DFText("提交后在「记录」里看进度；待审批的任务可以撤回。", scale: .caption)
        }
        .foregroundStyle(theme.colors.textSecondary)
        .padding(.top, 2)
    }

    // MARK: 底部提交

    private var submitBar: some View {
        VStack(spacing: 0) {
            Divider().opacity(0.4)
            HStack(spacing: 12) {
                VStack(alignment: .leading, spacing: 2) {
                    DFText(busy ? busyText : "\(options.copies) 份 · \(options.media) · \(options.color == "color" ? "彩色" : "黑白")", scale: .caption)
                        .dfTextViewStyle(.secondary)
                    DFText(targetPrinterName, scale: .bodySmall)
                        .lineLimit(1)
                }
                Spacer()
                DFButton(busy ? "处理中…" : "开始打印") {
                    Task { await submit() }
                }
                .disabled(busy)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 10)
            .background(.bar)
        }
    }

    private var targetPrinterName: String {
        if !printer.isEmpty { return printer }
        return printers.first?.name ?? "未选择打印机"
    }

    // MARK: 数据

    private func loadPrinters() async {
        do {
            let r = try await API().printers()
            printers = r.list
            if printer.isEmpty {
                printer = r.list.first(where: { $0.name == r.def })?.name ?? r.list.first?.name ?? ""
            }
        } catch {
            DFToastQueue.shared.show(text: pgMessage(error), severity: .error)
        }
    }

    private func loadPhotos(_ items: [PhotosPickerItem]) async {
        guard !items.isEmpty else { return }
        var loaded: [PickedImage] = []
        for (i, item) in items.enumerated() {
            if let data = try? await item.loadTransferable(type: Data.self), let img = UIImage(data: data) {
                loaded.append(PickedImage(image: img, name: "照片\(i + 1).jpg"))
            }
        }
        switch photoTarget {
        case .invoice:
            invoices.append(contentsOf: loaded.prefix(9 - invoices.count))
        case .front:
            if let f = loaded.first { idFront = f }
        case .back:
            if let f = loaded.first { idBack = f }
        }
        photoItems = []
    }

    private func handleImport(_ result: Result<[URL], Error>) async {
        guard case let .success(urls) = result, let url = urls.first else { return }
        let got = url.startAccessingSecurityScopedResource()
        defer { if got { url.stopAccessingSecurityScopedResource() } }
        do {
            let data = try Data(contentsOf: url)
            busy = true
            busyText = "上传中…"
            let f = try await API().upload(data: data, filename: url.lastPathComponent)
            picked = f
            mode = .file
            DFToastQueue.shared.show(text: "已导入 \(f.filename)", severity: .success)
        } catch {
            DFToastQueue.shared.show(text: pgMessage(error), severity: .error)
        }
        busy = false
    }

    // MARK: 提交

    private func submit() async {
        guard !busy else { return }
        let target = targetPrinterName
        guard !printers.isEmpty, target != "未选择打印机" else {
            DFToastQueue.shared.show(text: "请先选择打印机", severity: .error)
            return
        }
        let ranges = Fmt.sanitizeRanges(options.ranges)
        guard Fmt.validRanges(ranges) else {
            DFToastQueue.shared.show(text: "页范围格式不对，例如 1-3,5", severity: .error)
            return
        }
        if options.watermark.count > 40 {
            DFToastQueue.shared.show(text: "水印不超过 40 个字符", severity: .error)
            return
        }

        busy = true
        defer { busy = false }
        do {
            let fileId: Int
            switch mode {
            case .file:
                guard let f = picked else { throw APIError(message: "请先选择文件") }
                fileId = f.id
            default:
                busyText = "排版合成…"
                let url = try await composeNow()
                busyText = "上传中…"
                let f = try await API().upload(path: url.path, filename: Compose.name(mode))
                fileId = f.id
            }

            busyText = "提交中…"
            let res = try await API().print(fileId: fileId, printer: target, options: options.dict())
            let msg = pgStr(res["msg"])
            DFToastQueue.shared.show(text: msg.isEmpty ? "已提交打印" : msg, severity: .success)
            resetAfterSubmit()
        } catch {
            DFToastQueue.shared.show(text: pgMessage(error), severity: .error)
        }
    }

    private func resetAfterSubmit() {
        picked = nil
        title = ""
        body_ = ""
        invoices = []
        idFront = nil
        idBack = nil
    }

    private func composeNow() async throws -> URL {
        switch mode {
        case .text:
            guard !body_.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
                throw APIError(message: "先输入要打印的文字")
            }
            return try Compose.text(body: body_, title: title, fontSize: CGFloat(fontSize), media: options.media)
        case .invoice:
            guard !invoices.isEmpty else { throw APIError(message: "先添加发票图片") }
            return try Compose.invoice(images: invoices.map(\.image), per: perInvoice, media: options.media)
        case .idcard:
            guard idFront != nil || idBack != nil else { throw APIError(message: "先选择身份证照片") }
            return try Compose.idCard(front: idFront?.image, back: idBack?.image, media: options.media)
        case .file:
            throw APIError(message: "无需合成")
        }
    }
}

// MARK: - 文件库选择

struct FilePickerSheet: View {
    var onPick: (PgFileItem) -> Void

    @Environment(\.dismiss) private var dismiss
    @Environment(\.dfTheme) private var theme

    @State private var files: [PgFileItem] = []
    @State private var loading = true
    @State private var query = ""

    var filtered: [PgFileItem] {
        guard !query.isEmpty else { return files }
        return files.filter { $0.filename.localizedCaseInsensitiveContains(query) }
    }

    var body: some View {
        NavigationStack {
            Group {
                if loading {
                    VStack(spacing: 10) {
                        DFProgressBar(variant: .indeterminate)
                        DFText("加载文件…", scale: .caption).dfTextViewStyle(.secondary)
                    }
                    .padding(24)
                } else if filtered.isEmpty {
                    EmptyHint(icon: "folder", title: "文件库是空的", message: "先到「文件」页上传，或直接从相册/文件导入")
                } else {
                    ScrollView {
                        VStack(spacing: 8) {
                            ForEach(filtered) { f in
                                DFCard(action: {
                                    onPick(f)
                                    dismiss()
                                }) {
                                    HStack(spacing: 12) {
                                        DFIcon(f.iconName, size: 20).foregroundStyle(theme.colors.primary)
                                        VStack(alignment: .leading, spacing: 2) {
                                            DFText(f.filename, scale: .body).lineLimit(1)
                                            DFText("\(Fmt.size(f.size)) · \(f.pages) 页", scale: .caption)
                                                .dfTextViewStyle(.secondary)
                                        }
                                        Spacer()
                                        DFIcon("chevron.right", size: 12).foregroundStyle(theme.colors.textSecondary)
                                    }
                                }
                            }
                        }
                        .padding(14)
                    }
                }
            }
            .screenBackground()
            .dfNavigationBar(title: "选择文件", displayMode: .inline) {
                DFButton("关闭") { dismiss() }.dfButtonStyle(.ghost)
            }
            .searchable(text: $query, prompt: "搜索文件名")
            .task {
                do { files = try await API().files() } catch {
                    DFToastQueue.shared.show(text: pgMessage(error), severity: .error)
                }
                loading = false
            }
        }
    }
}
