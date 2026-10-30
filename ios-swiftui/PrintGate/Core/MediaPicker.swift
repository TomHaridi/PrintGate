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

/// 系统相册选择器（UIKit 版）。
///
/// 用 PHPickerViewController 而不是 SwiftUI 的 `.photosPicker`：
/// 后者挂到带 `safeAreaInset` 的 ScrollView 上时常弹不出来，
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

    /// 回调只会在主线程触发；标 @unchecked Sendable 是为了让加载过程能安全跨线程，
    /// 不引 async/await，避免 Swift 严格并发检查带来的编译问题。
    final class Coordinator: NSObject, PHPickerViewControllerDelegate, @unchecked Sendable {
        private let parent: MediaPicker

        init(_ parent: MediaPicker) { self.parent = parent }

        func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
            guard !results.isEmpty else {
                DispatchQueue.main.async { self.parent.onCancel() }
                return
            }

            let providers = results.map { $0.itemProvider }
            let lock = NSLock()
            var collected: [PickedMedia] = []

            DispatchQueue.global(qos: .userInitiated).async {
                let group = DispatchGroup()
                for (i, p) in providers.enumerated() {
                    group.enter()
                    Self.load(p, index: i) { media in
                        if let media {
                            lock.lock()
                            collected.append(media)
                            lock.unlock()
                        }
                        group.leave()
                    }
                }
                group.wait()
                let out = collected
                DispatchQueue.main.async { self.parent.onPick(out) }
            }
        }

        /// 图片走 UIImage（统一转 JPEG，避免 HEIC 服务端不认）；视频按文件表示取
        private static func load(_ p: NSItemProvider, index: Int, done: @escaping (PickedMedia?) -> Void) {
            if p.canLoadObject(ofClass: UIImage.self) {
                p.loadObject(ofClass: UIImage.self) { obj, _ in
                    if let img = obj as? UIImage, let data = img.jpegData(compressionQuality: 0.92) {
                        done(PickedMedia(filename: "照片_\(stamp())_\(index + 1).jpg", data: data, isVideo: false))
                    } else {
                        loadFile(p, index: index, done: done)
                    }
                }
                return
            }
            loadFile(p, index: index, done: done)
        }

        private static func loadFile(_ p: NSItemProvider, index: Int, done: @escaping (PickedMedia?) -> Void) {
            let movie = p.registeredTypeIdentifiers.first { UTType($0)?.conforms(to: .movie) == true }
            guard let type = movie ?? p.registeredTypeIdentifiers.first else {
                done(nil)
                return
            }
            p.loadFileRepresentation(forTypeIdentifier: type) { url, _ in
                guard let url else { done(nil); return }
                // loadFileRepresentation 给的 URL 是临时的，先拷出来再读
                let tmp = FileManager.default.temporaryDirectory
                    .appendingPathComponent("pg_pick_\(stamp())_\(index + 1)_\(url.lastPathComponent)")
                try? FileManager.default.copyItem(at: url, to: tmp)
                guard let data = try? Data(contentsOf: tmp) else { done(nil); return }
                try? FileManager.default.removeItem(at: tmp)

                let ext = (tmp.pathExtension.isEmpty ? "mp4" : tmp.pathExtension).lowercased()
                let isVideo = UTType(filenameExtension: ext)?.conforms(to: .movie) == true
                let base = isVideo ? "视频" : "文件"
                done(PickedMedia(filename: "\(base)_\(stamp())_\(index + 1).\(ext)", data: data, isVideo: isVideo))
            }
        }

        private static func stamp() -> String {
            let f = DateFormatter()
            f.dateFormat = "yyyyMMdd_HHmmss"
            return f.string(from: Date())
        }
    }
}
