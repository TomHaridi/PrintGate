import UIKit

/// 端上排版合成：文字速印 / 发票合排 / 身份证合排。
///
/// 后端的 textPdf / imagesPdf / idcardPdf 是 requireAdmin 接口，小程序令牌不认，
/// 所以客户端先在本地合成图片，再走 `/api/mp/files` + `/api/mp/print`。
/// 画布固定 1240px 宽（按纸张比例算高），与小程序 canvas 出来的图完全一致。
enum Compose {
    static let pageWidth: CGFloat = 1240

    private static let ratio: [String: CGFloat] = [
        "A4": 210.0 / 297.0,
        "A3": 297.0 / 420.0,
        "A5": 148.0 / 210.0,
        "A6": 105.0 / 148.0,
        "Letter": 216.0 / 279.0,
        "Legal": 216.0 / 356.0,
        "B5": 176.0 / 250.0,
        "16K": 195.0 / 270.0,
    ]

    static func pageSize(_ media: String) -> CGSize {
        let r = ratio[media] ?? ratio["A4"]!
        return CGSize(width: pageWidth, height: (pageWidth / r).rounded())
    }

    // MARK: 文字速印

    static func text(body: String, title: String, fontSize: CGFloat, media: String) throws -> URL {
        let size = pageSize(media)
        let margin: CGFloat = 56
        let width = size.width - margin * 2

        let url = try render(size: size) { ctx in
            UIColor.white.setFill()
            ctx.fill(CGRect(origin: .zero, size: size))

            var y = margin
            let trimmedTitle = title.trimmingCharacters(in: .whitespacesAndNewlines)
            if !trimmedTitle.isEmpty {
                let titleSize = min(max(fontSize * 1.6, 8), 30)
                let para = NSMutableParagraphStyle()
                para.alignment = .center
                para.lineHeightMultiple = 1.42
                let attrs: [NSAttributedString.Key: Any] = [
                    .font: UIFont.systemFont(ofSize: titleSize),
                    .foregroundColor: UIColor.black,
                    .paragraphStyle: para,
                ]
                let rect = CGRect(x: margin, y: y, width: width, height: size.height)
                (trimmedTitle as NSString).draw(with: rect, options: [.usesLineFragmentOrigin], attributes: attrs, context: nil)
                y += fontSize * 1.6 + 8
            }

            let para = NSMutableParagraphStyle()
            para.lineHeightMultiple = 1.42
            let attrs: [NSAttributedString.Key: Any] = [
                .font: UIFont.systemFont(ofSize: fontSize),
                .foregroundColor: UIColor.black,
                .paragraphStyle: para,
            ]
            let rect = CGRect(x: margin, y: y, width: width, height: size.height - y - margin)
            (body as NSString).draw(with: rect, options: [.usesLineFragmentOrigin], attributes: attrs, context: nil)
        }
        return url
    }

    // MARK: 发票合排

    static func invoice(images: [UIImage], per: Int, media: String) throws -> URL {
        let size = pageSize(media)
        let margin: CGFloat = 28
        let gap: CGFloat = 14
        let uw = size.width - margin * 2
        let uh = size.height - margin * 2
        let cols = per == 4 ? 2 : 1
        let rows = per == 4 ? 2 : (per == 2 ? 2 : 1)
        let cellW = (uw - gap * CGFloat(cols - 1)) / CGFloat(cols)
        let cellH = (uh - gap * CGFloat(rows - 1)) / CGFloat(rows)

        return try render(size: size) { ctx in
            UIColor.white.setFill()
            ctx.fill(CGRect(origin: .zero, size: size))
            for i in 0..<min(per, images.count) {
                let c = i % cols
                let r = i / cols
                let rect = CGRect(
                    x: margin + CGFloat(c) * (cellW + gap),
                    y: margin + CGFloat(r) * (cellH + gap),
                    width: cellW,
                    height: cellH
                )
                drawCover(images[i], in: rect, ctx: ctx)
            }
        }
    }

    // MARK: 身份证正反合排

    static func idCard(front: UIImage?, back: UIImage?, media: String) throws -> URL {
        let size = pageSize(media)
        let margin: CGFloat = 36
        let gap: CGFloat = 18
        let uw = size.width - margin * 2
        let uh = size.height - margin * 2
        let slotH = (uh - gap) / 2

        return try render(size: size) { ctx in
            UIColor.white.setFill()
            ctx.fill(CGRect(origin: .zero, size: size))

            let slots: [(img: UIImage?, top: CGFloat, label: String)] = [
                (front, margin, "正面"),
                (back, margin + slotH + gap, "反面"),
            ]

            for s in slots {
                let rect = CGRect(x: margin, y: s.top, width: uw, height: slotH)
                // 淡裁切线，方便沿边裁
                ctx.setStrokeColor(UIColor(red: 0.796, green: 0.835, blue: 0.882, alpha: 1).cgColor)
                ctx.setLineWidth(0.5)
                ctx.stroke(rect)

                if let img = s.img {
                    drawCover(img, in: rect, ctx: ctx)
                } else {
                    let para = NSMutableParagraphStyle()
                    para.alignment = .center
                    let attrs: [NSAttributedString.Key: Any] = [
                        .font: UIFont.systemFont(ofSize: 11),
                        .foregroundColor: UIColor(red: 0.580, green: 0.639, blue: 0.722, alpha: 1),
                        .paragraphStyle: para,
                    ]
                    let box = CGRect(x: margin, y: s.top + slotH / 2 - 8, width: uw, height: 20)
                    ("（未上传\(s.label)）" as NSString).draw(in: box, withAttributes: attrs)
                }
            }
        }
    }

    static func name(_ mode: PrintMode) -> String {
        switch mode {
        case .text: return "文字速印.png"
        case .invoice: return "发票合排.png"
        case .idcard: return "身份证合排.png"
        case .file: return "打印.png"
        }
    }

    // MARK: 内部

    private static func render(size: CGSize, _ draw: (CGContext) -> Void) throws -> URL {
        let format = UIGraphicsImageRendererFormat.default()
        format.scale = 1
        format.opaque = true
        let renderer = UIGraphicsImageRenderer(size: size, format: format)
        let image = renderer.image { ctx in draw(ctx.cgContext) }
        guard let data = image.pngData() else { throw APIError(message: "合成失败：无法导出图片") }

        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("pg-compose-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let url = dir.appendingPathComponent("composed.png")
        try data.write(to: url)
        return url
    }

    /// cover：等比放大铺满矩形后居中裁切
    private static func drawCover(_ img: UIImage, in rect: CGRect, ctx: CGContext) {
        let iw = img.size.width
        let ih = img.size.height
        guard iw > 0, ih > 0 else { return }
        let scale = max(rect.width / iw, rect.height / ih)
        let dw = iw * scale
        let dh = ih * scale
        let target = CGRect(x: rect.midX - dw / 2, y: rect.midY - dh / 2, width: dw, height: dh)

        ctx.saveGState()
        ctx.clip(to: rect)
        img.draw(in: target)
        ctx.restoreGState()
    }
}

enum PrintMode: String, CaseIterable, Identifiable {
    case file, text, invoice, idcard

    var id: String { rawValue }

    var title: String {
        switch self {
        case .file: return "文件打印"
        case .text: return "文字速印"
        case .invoice: return "发票合排"
        case .idcard: return "身份证"
        }
    }

    var icon: String {
        switch self {
        case .file: return "doc.fill"
        case .text: return "text.alignleft"
        case .invoice: return "doc.on.doc.fill"
        case .idcard: return "person.text.rectangle.fill"
        }
    }

    var hint: String {
        switch self {
        case .file: return "从文件库或相册选文件，直接打印"
        case .text: return "输入文字，端上排成图片再打印"
        case .invoice: return "多张发票合成一页，省纸"
        case .idcard: return "身份证正反面排在同一张纸上"
        }
    }
}
