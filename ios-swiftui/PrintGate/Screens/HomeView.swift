import SwiftUI
import DesignFoundation

struct HomeView: View {
    @Environment(AppModel.self) private var app
    @State private var tab = "print"

    private let items = [
        DFTabItem(id: "print", icon: "printer.fill", label: "打印"),
        DFTabItem(id: "files", icon: "folder.fill", label: "文件"),
        DFTabItem(id: "history", icon: "clock.fill", label: "记录"),
        DFTabItem(id: "me", icon: "person.crop.circle.fill", label: "我的"),
    ]

    var body: some View {
        DFTabBar(selection: $tab, items: items) { id in
            switch id {
            case "files": FilesView()
            case "history": HistoryView()
            case "me": MeView()
            default: PrintView()
            }
        }
        .task { await app.refreshMe() }
    }
}
