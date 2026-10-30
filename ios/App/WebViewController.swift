import UIKit
import WebKit

/// 直接把 PrintGate 服务上的 /m/ 装进 App。
/// 好处：界面和二维码/文件/打印逻辑都在服务端演进，App 壳不用跟着改版本。
final class WebViewController: UIViewController {

    private let baseURL: URL
    private var webView: WKWebView!
    private let refresh = UIRefreshControl()
    private lazy var errorView = makeErrorView()

    init(baseURL: URL) {
        self.baseURL = baseURL
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        title = baseURL.host ?? "PrintGate"

        let config = WKWebViewConfiguration()
        // 默认数据仓库：登录令牌存在 localStorage，重启 App 不用重新登录
        config.websiteDataStore = .default()
        config.allowsInlineMediaPlayback = true
        config.defaultWebpagePreferences.allowsContentJavaScript = true
        // 原生桥：H5 的「我的 → 服务器设置」里调用
        config.userContentController.add(self, name: "pg")

        webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsBackForwardNavigationGestures = true
        webView.scrollView.bounces = true
        webView.isOpaque = false
        webView.backgroundColor = .systemBackground
        webView.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(webView)
        // 铺满整屏：页面用 env(safe-area-inset-*) 自己让开刘海和底部小黑条
        NSLayoutConstraint.activate([
            webView.topAnchor.constraint(equalTo: view.topAnchor),
            webView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            webView.bottomAnchor.constraint(equalTo: view.bottomAnchor)
        ])

        refresh.addTarget(self, action: #selector(reload), for: .valueChanged)
        webView.scrollView.refreshControl = refresh

        errorView.isHidden = true
        view.addSubview(errorView)
        NSLayoutConstraint.activate([
            errorView.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            errorView.centerYAnchor.constraint(equalTo: view.centerYAnchor),
            errorView.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 32),
            errorView.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -32)
        ])

        load()
    }

    // MARK: - 加载

    private func load() {
        errorView.isHidden = true
        guard let url = URL(string: baseURL.absoluteString + "/m/") else { return }
        webView.load(URLRequest(url: url))
    }

    @objc private func reload() {
        if webView.url == nil { load() } else { webView.reload() }
    }

    @objc func changeServer() {
        let setup = SetupViewController()
        setup.showsCancel = true
        setup.onReady = { [weak self] url in
            self?.dismiss(animated: true) {
                guard let self = self else { return }
                // 换服务器等于换一套账号，把本地令牌清掉，免得串号
                WKWebsiteDataStore.default().removeData(
                    ofTypes: WKWebsiteDataStore.allWebsiteDataTypes(),
                    modifiedSince: .distantPast) { }
                self.title = url.host ?? "PrintGate"
                self.load()
            }
        }
        let nav = UINavigationController(rootViewController: setup)
        present(nav, animated: true)
    }

    private func makeErrorView() -> UIView {
        let box = UIView()
        box.translatesAutoresizingMaskIntoConstraints = false

        let label = UILabel()
        label.numberOfLines = 0
        label.textAlignment = .center
        label.font = .systemFont(ofSize: 15)
        label.textColor = .secondaryLabel
        label.text = "打不开页面。请确认手机与服务器在同一网络，或服务器还在运行。"

        let retry = UIButton(type: .system)
        retry.setTitle("重试", for: .normal)
        retry.titleLabel?.font = .systemFont(ofSize: 17, weight: .semibold)
        retry.addTarget(self, action: #selector(reload), for: .touchUpInside)

        let change = UIButton(type: .system)
        change.setTitle("修改服务器地址", for: .normal)
        change.addTarget(self, action: #selector(changeServer), for: .touchUpInside)

        let stack = UIStackView(arrangedSubviews: [label, retry, change])
        stack.axis = .vertical
        stack.spacing = 14
        stack.alignment = .center
        stack.translatesAutoresizingMaskIntoConstraints = false
        box.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.topAnchor.constraint(equalTo: box.topAnchor),
            stack.bottomAnchor.constraint(equalTo: box.bottomAnchor),
            stack.leadingAnchor.constraint(equalTo: box.leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: box.trailingAnchor)
        ])
        return box
    }
}

// MARK: - 导航
extension WebViewController: WKNavigationDelegate {
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        refresh.endRefreshing()
        errorView.isHidden = true
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        refresh.endRefreshing()
        if (error as NSError).code == NSURLErrorCancelled { return }
        errorView.isHidden = false
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        refresh.endRefreshing()
        if (error as NSError).code == NSURLErrorCancelled { return }
        errorView.isHidden = false
    }

    func webView(_ webView: WKWebView,
                 decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else { return decisionHandler(.allow) }
        // mailto/tel 之类交给系统
        if let scheme = url.scheme?.lowercased(), !["http", "https", "about", "blob", "data"].contains(scheme) {
            UIApplication.shared.open(url)
            return decisionHandler(.cancel)
        }
        // 外部站点用 Safari 打开（比如文档里的链接）
        if let host = url.host, let baseHost = baseURL.host, host != baseHost {
            UIApplication.shared.open(url)
            return decisionHandler(.cancel)
        }
        decisionHandler(.allow)
    }
}

// MARK: - JS 弹窗（H5 里用了 confirm/alert）
extension WebViewController: WKUIDelegate {
    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "好", style: .default) { _ in completionHandler() })
        present(alert, animated: true)
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "取消", style: .cancel) { _ in completionHandler(false) })
        alert.addAction(UIAlertAction(title: "确定", style: .default) { _ in completionHandler(true) })
        present(alert, animated: true)
    }

    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String,
                 defaultText: String?, initiatedByFrame frame: WKFrameInfo,
                 completionHandler: @escaping (String?) -> Void) {
        let alert = UIAlertController(title: nil, message: prompt, preferredStyle: .alert)
        alert.addTextField { $0.text = defaultText }
        alert.addAction(UIAlertAction(title: "取消", style: .cancel) { _ in completionHandler(nil) })
        alert.addAction(UIAlertAction(title: "确定", style: .default) { _ in
            completionHandler(alert.textFields?.first?.text)
        })
        present(alert, animated: true)
    }

    // target=_blank / window.open：留在同一个 WebView
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if navigationAction.targetFrame == nil, let url = navigationAction.request.url {
            webView.load(URLRequest(url: url))
        }
        return nil
    }
}

// MARK: - 原生桥（H5 里的「服务器设置」）
extension WebViewController: WKScriptMessageHandler {
    func userContentController(_ userContentController: WKUserContentController,
                               didReceive message: WKScriptMessage) {
        guard message.name == "pg" else { return }
        guard let cmd = message.body as? String else { return }
        if cmd == "setup" { changeServer() }
    }
}
