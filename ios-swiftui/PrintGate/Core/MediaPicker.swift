import SwiftUI
import PhotosUI
import UIKit
import UniformTypeIdentifiers

/// 一次选中的媒体（图片统一转 JPEG，视频保留原始容器）
struct PickedMedia {
    var filename: String
    var data: Data
    var isVideo: Bool
}

/// 系统相册 / 文件选择器（UIKit 版）。
///
/// 用 PHPickerViewController 而不是 SwiftUI 的 `.photosPicker`：
/// 后者在 iOS 26 上挂到带 `safeAreaInset` 的 ScrollView 时经常弹不出来，
/// 而且不方便同时支持「图片 + 视频」。这里直接走 UIKit，行为稳定。
struct MediaPicker: UIViewControllerRepresentable {
    /// true = 图片+视频，false = 只要图片
    var allowVideo: Bool
    /// 0 = 不限数量
    var selectionLimit: Int
    var onPick: ([PickedMedia]) -> Void
    var onCancel: () -> Void

    func makeUIViewController(context: Context) -> PHPickerViewController {
        var config = PHPickerConfiguration(photoLibrary: .shared())
        config.filter = allowVideo ? .any(of: [.images, .videos]) : .images
        config.selectionLimit = selectionLimit
        config.preferredAssetRepresentationMode = .current
        let vc = PHPickerViewController(configuration: config)
        vc.delegate = context.coordinator
        return vc
    }

    func updateUIViewController(_ uiViewController: PHPickerViewController, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    final class Coordinator: NSObject, PHPickerViewControllerDelegate {
        private let parent: MediaPicker

        init(_ parent: MediaPicker) { self.parent = parent }

        func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
            guard !results.isEmpty else {
                parent.onCancel()
                return
            }
            let providers = results.map { $0.itemProvider }
            Task { @MainActor in
                var out: [PickedMedia] = []
                for (i, p) in providers.enumerated() {
                    if let m = await Self.load(p, index: i) { out.append(m) }
                }
                parent.onPick(out)
            }
        }

        private static func load(_ p: NSItemProvider, index: Int) async -> PickedMedia? {
            // 图片：走 UIImage，统一转 JPEG，避免 HEIC 服务端不认
            if p.canLoadObject(ofClass: UIImage.self) {
                let img = await withCheckedContinuation { (c: CheckedContinuation<UIImage?, Never>) in
                    p.loadObject(ofClass: UIImage.self) { obj, _ in
                        c.resume(returning: obj as? UIImage)
                    }
                }
                if let img {
                    if let data = img.jpegData(compressionQuality: 0.92) {
                        return PickedMedia(filename: "照片_\(stamp())_\(index + 1).jpg", data: data, isVideo: false)
                    }
                }
            }

            // 视频 / 其他：按文件表示取，回调给的 URL 是临时的，先拷出来
            let movieType = p.registeredTypeIdentifiers.first { UTType($0)?.conforms(to: .movie) == true }
            let type = movieType ?? p.registeredTypeIdentifiers.first { UTType($0)?.conforms(to: .data) == true }
            guard let type else { return nil }

            let url: URL? = await withCheckedContinuation { c in
                p.loadFileRepresentation(forTypeIdentifier: type) { u, _ in c.resume(returning: u) }
            }
            guard let url else { return nil }

            let tmp = FileManager.default.temporaryDirectory
                .appendingPathComponent("pg_pick_\(stamp())_\(index + 1)_\(url.lastPathComponent)")
            try? FileManager.default.copyItem(at: url, to: tmp)
            guard let data = try? Data(contentsOf: tmp) else { return nil }
            try? FileManager.default.removeItem(at: tmp)

            let ext = (tmp.pathExtension.isEmpty ? "mp4" : tmp.pathExtension).lowercased()
            let isVideo = UTType(filenameExtension: ext)?.conforms(to: .movie) == true
            return PickedMedia(filename: "视频_\(stamp())_\(index + 1).\(ext)", data: data, isVideo: isVideo)
        }

        private static func stamp() -> String {
            let f = DateFormatter()
            f.dateFormat = "yyyyMMdd_HHmmss"
            return f.string(from: Date())
        }
    }
}
