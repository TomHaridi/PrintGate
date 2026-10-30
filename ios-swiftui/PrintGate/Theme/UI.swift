import SwiftUI
import DesignFoundation

// MARK: - 统一背景

extension View {
    /// 页面底色（跟随主题，忽略安全区）
    func screenBackground() -> some View {
        modifier(ScreenBackground())
    }

    /// 卡片内的标准间距
    func cardPadding() -> some View {
        padding(16)
    }

    /// 底部留出 Home 指示条的手势区。
    /// 贴着屏幕最下沿的按钮会被系统「返回主屏」手势吃掉点击（表现为点不中），
    /// 所以内容末尾一律用这个代替普通 bottom padding。
    func safeBottomPadding(_ extra: CGFloat = 0) -> some View {
        padding(.bottom, 34 + extra)
    }

    /// 纯图标按钮的最小可点击区（Apple HIG 44pt）。
    /// 只有 16~18pt 的图标按钮热区太小，手指很容易点空，必须套上这个。
    func iconTapTarget(_ size: CGFloat = 44) -> some View {
        frame(minWidth: size, minHeight: size)
            .contentShape(Rectangle())
    }
}

private struct ScreenBackground: ViewModifier {
    @Environment(\.dfTheme) private var theme

    func body(content: Content) -> some View {
        content
            .background(theme.colors.background.ignoresSafeArea())
    }
}

// MARK: - 区块标题

struct SectionTitle: View {
    var text: String
    var trailing: String? = nil
    var action: (() -> Void)? = nil

    @Environment(\.dfTheme) private var theme

    var body: some View {
        HStack(alignment: .firstTextBaseline) {
            DFText(text, scale: .label)
                .dfTextViewStyle(.secondary)
            Spacer()
            if let t = trailing, let action {
                Button(action: action) {
                    DFText(t, scale: .caption)
                        .foregroundStyle(theme.colors.primary)
                }
                .buttonStyle(.plain)
            }
        }
        .padding(.horizontal, 4)
        .padding(.top, 6)
    }
}

// MARK: - 图标 + 标题 + 值 的行

struct InfoRow: View {
    var icon: String
    var label: String
    var value: String
    var tint: Color? = nil

    @Environment(\.dfTheme) private var theme

    var body: some View {
        HStack(spacing: 12) {
            DFIcon(icon, size: 18)
                .foregroundStyle(tint ?? theme.colors.textSecondary)
                .frame(width: 22)
            DFText(label, scale: .body)
            Spacer(minLength: 8)
            DFText(value, scale: .bodySmall)
                .dfTextViewStyle(.secondary)
                .multilineTextAlignment(.trailing)
        }
        .padding(.vertical, 7)
    }
}

// MARK: - 状态徽标

struct StatusBadge: View {
    var text: String
    var color: Color

    var body: some View {
        Text(text)
            .font(.caption2.weight(.semibold))
            .foregroundStyle(color)
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .background(color.opacity(0.12), in: Capsule())
    }
}

extension PgTask {
    var tint: Color {
        switch status {
        case "pending": return .orange
        case "queued": return .blue
        case "printing": return .teal
        case "done", "completed": return .green
        case "failed", "error": return .red
        case "canceled", "cancelled": return .gray
        case "rejected": return .pink
        default: return .secondary
        }
    }
}

extension PgUser {
    var statusText: String {
        switch status {
        case "approved": return "已通过"
        case "pending": return "待审批"
        case "blocked": return "已禁用"
        default: return status.isEmpty ? "未知" : status
        }
    }

    var statusTint: Color {
        switch status {
        case "approved": return .green
        case "pending": return .orange
        case "blocked": return .red
        default: return .secondary
        }
    }
}

// MARK: - 空态占位（带刷新）

struct EmptyHint: View {
    var icon: String
    var title: String
    var message: String
    var actionTitle: String? = nil
    var onAction: (@MainActor @Sendable () -> Void)? = nil

    var body: some View {
        DFEmptyState(
            icon: icon,
            title: title,
            message: message,
            actionTitle: actionTitle,
            onAction: onAction
        )
        .padding(.vertical, 24)
    }
}

// MARK: - 键值编辑（后台设置）
struct EditableRow: View {
    var label: String
    var value: String
    var onTap: () -> Void

    @Environment(\.dfTheme) private var theme

    var body: some View {
        Button(action: onTap) {
            HStack {
                DFText(label, scale: .body)
                    .foregroundStyle(theme.colors.textPrimary)
                Spacer()
                DFText(value, scale: .bodySmall)
                    .dfTextViewStyle(.secondary)
                DFIcon("chevron.right", size: 12)
                    .foregroundStyle(theme.colors.textSecondary)
            }
            .padding(.vertical, 8)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}
