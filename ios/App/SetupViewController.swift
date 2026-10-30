import UIKit

/// 首次启动（或在 WebView 里点「服务器」）时的地址设置页。
/// 逻辑和 H5 里的「服务地址」一致：规范化 → 探活 /api/health → 保存。
final class SetupViewController: UIViewController, UITextFieldDelegate {

    /// 连接成功后回调（已保存到 Store）
    var onReady: ((URL) -> Void)?
    /// 作为弹窗出现时显示「取消」
    var showsCancel = false

    private let scroll = UIScrollView()
    private let stack = UIStackView()
    private let field = UITextField()
    private let statusLabel = UILabel()
    private let connectButton = UIButton(type: .system)
    private let spinner = UIActivityIndicatorView(style: .medium)

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemGroupedBackground
        title = "连接打印服务器"

        if showsCancel {
            navigationItem.leftBarButtonItem = UIBarButtonItem(
                title: "取消", style: .plain, target: self, action: #selector(cancelTapped))
        }

        buildUI()
        field.delegate = self
        field.text = Store.baseURL?.absoluteString

        NotificationCenter.default.addObserver(self, selector: #selector(kbShow(_:)),
                                               name: UIResponder.keyboardWillShowNotification, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(kbHide),
                                               name: UIResponder.keyboardWillHideNotification, object: nil)
    }

    private func buildUI() {
        scroll.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(scroll)
        NSLayoutConstraint.activate([
            scroll.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            scroll.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            scroll.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            scroll.bottomAnchor.constraint(equalTo: view.bottomAnchor)
        ])

        stack.axis = .vertical
        stack.spacing = 14
        stack.alignment = .fill
        stack.translatesAutoresizingMaskIntoConstraints = false
        scroll.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.topAnchor.constraint(equalTo: scroll.contentLayoutGuide.topAnchor, constant: 32),
            stack.bottomAnchor.constraint(equalTo: scroll.contentLayoutGuide.bottomAnchor, constant: -32),
            stack.leadingAnchor.constraint(equalTo: scroll.frameLayoutGuide.leadingAnchor, constant: 24),
            stack.trailingAnchor.constraint(equalTo: scroll.frameLayoutGuide.trailingAnchor, constant: -24)
        ])

        // 图标
        let logo = UIImageView(image: UIImage(named: "Logo"))
        logo.contentMode = .scaleAspectFit
        logo.layer.cornerRadius = 22
        logo.clipsToBounds = true
        logo.translatesAutoresizingMaskIntoConstraints = false
        logo.heightAnchor.constraint(equalToConstant: 96).isActive = true
        logo.widthAnchor.constraint(equalToConstant: 96).isActive = true

        let logoWrap = UIView()
        logoWrap.addSubview(logo)
        NSLayoutConstraint.activate([
            logo.centerXAnchor.constraint(equalTo: logoWrap.centerXAnchor),
            logo.topAnchor.constraint(equalTo: logoWrap.topAnchor),
            logo.bottomAnchor.constraint(equalTo: logoWrap.bottomAnchor)
        ])

        let titleLabel = UILabel()
        titleLabel.text = "PrintGate 云打印"
        titleLabel.font = .systemFont(ofSize: 22, weight: .bold)
        titleLabel.textAlignment = .center

        let subLabel = UILabel()
        subLabel.text = "输入打印服务器地址，之后一直记住它"
        subLabel.font = .systemFont(ofSize: 14)
        subLabel.textColor = .secondaryLabel
        subLabel.textAlignment = .center
        subLabel.numberOfLines = 0

        field.placeholder = "192.168.1.10:8080"
        field.borderStyle = .none
        field.keyboardType = .URL
        field.autocapitalizationType = .none
        field.autocorrectionType = .no
        field.spellCheckingType = .no
        field.clearButtonMode = .whileEditing
        field.returnKeyType = .go
        field.font = .systemFont(ofSize: 16)
        field.backgroundColor = .secondarySystemGroupedBackground
        field.layer.cornerRadius = 12
        field.layer.borderWidth = 1
        field.layer.borderColor = UIColor.separator.cgColor
        field.leftView = UIView(frame: CGRect(x: 0, y: 0, width: 14, height: 1))
        field.leftViewMode = .always
        field.translatesAutoresizingMaskIntoConstraints = false
        field.heightAnchor.constraint(equalToConstant: 50).isActive = true

        connectButton.setTitle("连接", for: .normal)
        connectButton.titleLabel?.font = .systemFont(ofSize: 17, weight: .semibold)
        connectButton.backgroundColor = UIColor(red: 0.047, green: 0.545, blue: 0.502, alpha: 1)
        connectButton.setTitleColor(.white, for: .normal)
        connectButton.layer.cornerRadius = 14
        connectButton.translatesAutoresizingMaskIntoConstraints = false
        connectButton.heightAnchor.constraint(equalToConstant: 50).isActive = true
        connectButton.addTarget(self, action: #selector(connectTapped), for: .touchUpInside)

        statusLabel.font = .systemFont(ofSize: 13)
        statusLabel.textColor = .secondaryLabel
        statusLabel.numberOfLines = 0
        statusLabel.textAlignment = .center

        let hint = UILabel()
        hint.font = .systemFont(ofSize: 12)
        hint.textColor = .tertiaryLabel
        hint.numberOfLines = 0
        hint.text = """
        局域网部署填 IP 和端口，例如 192.168.1.10:8080（会自动补 http）。
        公网部署填域名，自动补 https。

        小提示：手机和电脑要在同一个 Wi-Fi 下；服务器换了地址后，随时可以在右上角「服务器」里改。
        """

        spinner.hidesWhenStopped = true
        spinner.translatesAutoresizingMaskIntoConstraints = false
        connectButton.addSubview(spinner)
        NSLayoutConstraint.activate([
            spinner.centerYAnchor.constraint(equalTo: connectButton.centerYAnchor),
            spinner.trailingAnchor.constraint(equalTo: connectButton.trailingAnchor, constant: -16)
        ])

        [logoWrap, titleLabel, subLabel, field, connectButton, statusLabel, hint].forEach {
            stack.addArrangedSubview($0)
        }
        stack.setCustomSpacing(6, after: logoWrap)
        stack.setCustomSpacing(24, after: subLabel)
        stack.setCustomSpacing(10, after: connectButton)
    }

    // MARK: - 动作

    @objc private func connectTapped() {
        view.endEditing(true)
        guard let raw = field.text, let url = Store.normalize(raw) else {
            statusLabel.textColor = .systemRed
            statusLabel.text = "地址格式不对，例如 192.168.1.10:8080 或 https://print.example.com"
            return
        }
        field.text = url.absoluteString
        statusLabel.textColor = .secondaryLabel
        statusLabel.text = "正在连接 \(url.absoluteString)…"
        connectButton.isEnabled = false
        spinner.startAnimating()

        Store.probe(url) { [weak self] result in
            guard let self = self else { return }
            self.connectButton.isEnabled = true
            self.spinner.stopAnimating()
            switch result {
            case .success(let ver):
                Store.baseURL = url
                self.statusLabel.textColor = .systemGreen
                self.statusLabel.text = ver.isEmpty ? "连接成功" : "连接成功（v\(ver)）"
                self.onReady?(url)
            case .failure(let msg):
                self.statusLabel.textColor = .systemRed
                self.statusLabel.text = msg
            }
        }
    }

    @objc private func cancelTapped() {
        dismiss(animated: true)
    }

    func textFieldShouldReturn(_ textField: UITextField) -> Bool {
        connectTapped()
        return true
    }

    @objc private func kbShow(_ note: Notification) {
        guard let frame = note.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? CGRect else { return }
        scroll.contentInset.bottom = frame.height
        scroll.verticalScrollIndicatorInsets.bottom = frame.height
    }

    @objc private func kbHide() {
        scroll.contentInset.bottom = 0
        scroll.verticalScrollIndicatorInsets.bottom = 0
    }
}
