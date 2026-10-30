import SwiftUI
import DesignFoundation

/// 主题：5 套 DesignFoundation 官方预设 + 一套 PrintGate 品牌主题。
/// 品牌色取自服务端 `mobile/app.css`（#0C8B80），保证 App / 小程序 / 网页后台看起来是同一个产品。
enum AppTheme: String, CaseIterable, Identifiable {
    case pg, slate, aurora, copper, sage, garnet

    var id: String { rawValue }

    var title: String {
        switch self {
        case .pg: return "青竹（默认）"
        case .slate: return "石板 Slate"
        case .aurora: return "极光 Aurora"
        case .copper: return "赤铜 Copper"
        case .sage: return "鼠尾草 Sage"
        case .garnet: return "石榴 Garnet"
        }
    }

    var note: String {
        switch self {
        case .pg: return "与小程序一致的主色"
        case .slate: return "中性，接近系统默认"
        case .aurora: return "紫调，圆角更柔和"
        case .copper: return "暖橙，直角利落"
        case .sage: return "低饱和绿，安静"
        case .garnet: return "正红，对比强"
        }
    }

    var preset: DFThemePreset {
        switch self {
        case .pg: return .printgate
        case .slate: return .slate
        case .aurora: return .aurora
        case .copper: return .copper
        case .sage: return .sage
        case .garnet: return .garnet
        }
    }

    /// 预览用的代表色（浅色主题下的主色）
    var swatch: Color {
        switch self {
        case .pg: return Color(red: 0.047, green: 0.545, blue: 0.502)
        case .slate: return Color(red: 0.188, green: 0.247, blue: 0.365)
        case .aurora: return Color(red: 0.427, green: 0.267, blue: 0.918)
        case .copper: return Color(red: 0.686, green: 0.400, blue: 0.196)
        case .sage: return Color(red: 0.176, green: 0.416, blue: 0.310)
        case .garnet: return Color(red: 0.784, green: 0.063, blue: 0.180)
        }
    }
}

// MARK: - PrintGate 品牌主题

extension DFThemePreset {
    static let printgate = DFThemePreset(light: .pgLight, dark: .pgDark)
}

extension DFTheme {
    static let pgLight = DFTheme(colors: .pgLight, radius: .pgRadius, shadows: .pgShadows)
    static let pgDark = DFTheme(colors: .pgDark, radius: .pgRadius, shadows: .pgShadows)
}

private extension DFRadiusTokens {
    static let pgRadius = DFRadiusTokens(none: 0, sm: 8, md: 14, lg: 20, full: 9999)
}

private extension DFShadowTokens {
    static let pgShadows = DFShadowTokens(
        none: .none,
        sm: DFShadow(color: .black.opacity(0.04), radius: 6, x: 0, y: 1),
        md: DFShadow(color: .black.opacity(0.07), radius: 14, x: 0, y: 3),
        lg: DFShadow(color: .black.opacity(0.10), radius: 24, x: 0, y: 6)
    )
}

private extension DFColorTokens {
    /// #0C8B80 / #076D64 / #E7F5F3 / #101B1A / #3D5250 / #E6ECEB / #F4F7F6
    static var pgLight: DFColorTokens {
        let primary = Color(red: 0.047, green: 0.545, blue: 0.502)
        return DFColorTokens(
            primary: primary,
            secondary: Color(red: 0.216, green: 0.396, blue: 0.380),
            accent: Color(red: 0.106, green: 0.678, blue: 0.612),
            background: Color(red: 0.957, green: 0.969, blue: 0.965),
            surface: Color(red: 0.925, green: 0.953, blue: 0.945),
            surfaceElevated: .white,
            textPrimary: Color(red: 0.063, green: 0.106, blue: 0.102),
            textSecondary: Color(red: 0.239, green: 0.322, blue: 0.314),
            textDisabled: Color(red: 0.604, green: 0.682, blue: 0.675),
            border: Color(red: 0.902, green: 0.925, blue: 0.922),
            interactiveFill: primary,
            interactiveHover: primary.opacity(0.85),
            interactivePressed: primary.opacity(0.70),
            interactiveDisabled: Color(red: 0.906, green: 0.961, blue: 0.953),
            destructive: Color(red: 0.753, green: 0.224, blue: 0.169),
            success: Color(red: 0.180, green: 0.545, blue: 0.298),
            warning: Color(red: 0.851, green: 0.467, blue: 0.024),
            info: Color(red: 0.114, green: 0.447, blue: 0.678),
            respectsColorScheme: false
        )
    }

    static var pgDark: DFColorTokens {
        let primary = Color(red: 0.290, green: 0.784, blue: 0.722)
        return DFColorTokens(
            primary: primary,
            secondary: Color(red: 0.451, green: 0.639, blue: 0.612),
            accent: Color(red: 0.408, green: 0.867, blue: 0.796),
            background: Color(red: 0.043, green: 0.086, blue: 0.082),
            surface: Color(red: 0.078, green: 0.137, blue: 0.129),
            surfaceElevated: Color(red: 0.110, green: 0.184, blue: 0.173),
            textPrimary: Color(red: 0.910, green: 0.945, blue: 0.937),
            textSecondary: Color(red: 0.545, green: 0.667, blue: 0.651),
            textDisabled: Color(red: 0.290, green: 0.376, blue: 0.365),
            border: Color(red: 0.137, green: 0.231, blue: 0.220),
            interactiveFill: primary,
            interactiveHover: primary.opacity(0.85),
            interactivePressed: primary.opacity(0.70),
            interactiveDisabled: Color(red: 0.086, green: 0.157, blue: 0.149),
            destructive: Color(red: 0.937, green: 0.400, blue: 0.361),
            success: Color(red: 0.400, green: 0.800, blue: 0.545),
            warning: Color(red: 0.965, green: 0.678, blue: 0.290),
            info: Color(red: 0.435, green: 0.722, blue: 0.937),
            respectsColorScheme: false
        )
    }
}

// MARK: - 便捷读取

extension View {
    /// 统一入口：按 Store 里的选择套主题（浅色/深色由 `preferredColorScheme` 决定）
    func appTheme(_ theme: AppTheme) -> some View {
        modifier(AppThemeModifier(theme: theme))
    }
}

private struct AppThemeModifier: ViewModifier {
    let theme: AppTheme

    func body(content: Content) -> some View {
        content.dfThemePreset(theme.preset)
    }
}
