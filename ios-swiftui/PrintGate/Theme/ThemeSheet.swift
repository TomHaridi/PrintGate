import SwiftUI
import DesignFoundation

/// 外观：模式（跟随系统 / 浅色 / 深色）+ 主题预设，带实时预览
struct ThemeSheet: View {
    @Environment(Store.self) private var store
    @Environment(\.dfTheme) private var theme
    @Environment(\.dismiss) private var dismiss

    private let modes: [(Int, String, String)] = [
        (0, "跟随系统", "circle.lefthalf.filled"),
        (1, "浅色", "sun.max.fill"),
        (2, "深色", "moon.fill"),
    ]

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    preview

                    SectionTitle(text: "显示模式")
                    HStack(spacing: 10) {
                        ForEach(modes, id: \.0) { mode in
                            modeCard(mode.0, mode.1, mode.2)
                        }
                    }

                    SectionTitle(text: "主题配色")
                    VStack(spacing: 8) {
                        ForEach(AppTheme.allCases) { t in
                            themeRow(t)
                        }
                    }

                    DFText("主题会同时影响按钮、卡片、开关、提示条与表单；切换立即生效，下次打开保持一致。", scale: .caption)
                        .dfTextViewStyle(.secondary)
                        .padding(.top, 4)
                }
                .padding(16)
            }
            .screenBackground()
            .dfNavigationBar(title: "外观", displayMode: .inline) {
                DFButton("完成") { dismiss() }.dfButtonStyle(.ghost)
            }
        }
    }

    // MARK: 预览

    private var preview: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 10) {
                ZStack {
                    RoundedRectangle(cornerRadius: 12, style: .continuous)
                        .fill(theme.colors.primary.opacity(0.14))
                        .frame(width: 42, height: 42)
                    DFIcon("printer.fill", size: 20)
                        .foregroundStyle(theme.colors.primary)
                }
                VStack(alignment: .leading, spacing: 3) {
                    DFText("期末复习提纲.pdf", scale: .body)
                    DFText("2 份 · A4 · 双面长边", scale: .caption)
                        .dfTextViewStyle(.secondary)
                }
                Spacer()
                StatusBadge(text: "打印中", color: theme.colors.primary)
            }

            HStack(spacing: 8) {
                Text("主按钮")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(.white)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 8)
                    .background(theme.colors.primary, in: RoundedRectangle(cornerRadius: theme.radius.sm))
                Text("次按钮")
                    .font(.subheadline)
                    .foregroundStyle(theme.colors.primary)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 8)
                    .overlay(
                        RoundedRectangle(cornerRadius: theme.radius.sm)
                            .stroke(theme.colors.primary.opacity(0.4), lineWidth: 1)
                    )
                Spacer()
                DFChip(.selectable("已选"), isSelected: true)
            }

            DFChip(.label("普通标签"))
        }
        .padding(16)
        .background(theme.colors.surfaceElevated, in: RoundedRectangle(cornerRadius: theme.radius.lg, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: theme.radius.lg, style: .continuous)
                .strokeBorder(theme.colors.border, lineWidth: 0.6)
        )
    }

    // MARK: 模式卡

    private func modeCard(_ value: Int, _ title: String, _ icon: String) -> some View {
        let selected = store.themeMode == value
        return Button {
            store.setThemeMode(value)
        } label: {
            VStack(spacing: 8) {
                DFIcon(icon, size: 18)
                    .foregroundStyle(selected ? theme.colors.primary : theme.colors.textSecondary)
                DFText(title, scale: .caption)
                    .foregroundStyle(selected ? theme.colors.textPrimary : theme.colors.textSecondary)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 14)
            .background(
                RoundedRectangle(cornerRadius: theme.radius.md, style: .continuous)
                    .fill(selected ? theme.colors.primary.opacity(0.10) : theme.colors.surfaceElevated)
            )
            .overlay(
                RoundedRectangle(cornerRadius: theme.radius.md, style: .continuous)
                    .strokeBorder(selected ? theme.colors.primary : theme.colors.border, lineWidth: selected ? 1.4 : 0.6)
            )
        }
        .buttonStyle(.plain)
    }

    // MARK: 预设行

    private func themeRow(_ t: AppTheme) -> some View {
        let selected = store.themeID == t.rawValue
        return Button {
            store.setTheme(t.rawValue)
        } label: {
            HStack(spacing: 12) {
                ZStack {
                    Circle().fill(t.swatch).frame(width: 26, height: 26)
                    if selected {
                        DFIcon("checkmark", size: 13).foregroundStyle(.white)
                    }
                }
                VStack(alignment: .leading, spacing: 2) {
                    DFText(t.title, scale: .body)
                        .foregroundStyle(theme.colors.textPrimary)
                    DFText(t.note, scale: .caption)
                        .dfTextViewStyle(.secondary)
                }
                Spacer()
                if selected {
                    DFBadge(text: "使用中")
                }
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 12)
            .background(
                RoundedRectangle(cornerRadius: theme.radius.md, style: .continuous)
                    .fill(theme.colors.surfaceElevated)
            )
            .overlay(
                RoundedRectangle(cornerRadius: theme.radius.md, style: .continuous)
                    .strokeBorder(selected ? theme.colors.primary.opacity(0.6) : theme.colors.border, lineWidth: selected ? 1.2 : 0.6)
            )
        }
        .buttonStyle(.plain)
    }
}
