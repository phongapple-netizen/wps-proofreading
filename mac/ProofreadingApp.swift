import AppKit
import Darwin
import Foundation

private let addonName = "wps-text-proofreading"
private let serviceLabel = "net.wps-proofreading.web"
private let servicePort: UInt16 = 3891

private enum InstallerError: LocalizedError {
    case message(String)
    var errorDescription: String? {
        if case .message(let value) = self { return value }
        return nil
    }
}

private enum Paths {
    static var home: URL { FileManager.default.homeDirectoryForCurrentUser }
    static var executable: String { Bundle.main.executableURL!.path }
    static var addon: URL { Bundle.main.resourceURL!.appendingPathComponent("addon", isDirectory: true) }
    static var agent: URL {
        home.appendingPathComponent("Library/LaunchAgents/\(serviceLabel).plist")
    }
    static var logs: URL {
        home.appendingPathComponent("Library/Logs/wps-proofreading", isDirectory: true)
    }
    static var publishFiles: [URL] {
        [
            "Library/Containers/com.kingsoft.wpsoffice.mac/Data/.kingsoft/wps/jsaddons/publish.xml",
            "Library/Containers/com.kingsoft.wpsoffice.mac.global/Data/.kingsoft/wps/jsaddons/publish.xml",
            "Library/Application Support/Kingsoft/WPS/jsaddons/publish.xml"
        ].map { home.appendingPathComponent($0) }
    }
}

private enum WPSRegistration {
    static let entry = "  <jspluginonline name=\"\(addonName)\" type=\"wps\" url=\"http://127.0.0.1:\(servicePort)/\" debug=\"\" enable=\"enable_dev\" install=\"null\"/>"
    static let pattern = try! NSRegularExpression(
        pattern: "\\s*<jspluginonline\\b[^>]*\\bname=[\"'](?:wps-text-proofreading|wordollama-wps-native)[\"'][^>]*\\s*/>",
        options: [.caseInsensitive]
    )

    static func candidateFiles() -> [URL] {
        let fm = FileManager.default
        let existing = Paths.publishFiles.filter { url in
            let root: URL
            if url.path.contains("/Library/Containers/") {
                root = url.deletingLastPathComponent().deletingLastPathComponent()
                    .deletingLastPathComponent().deletingLastPathComponent()
            } else {
                root = url.deletingLastPathComponent().deletingLastPathComponent()
            }
            return fm.fileExists(atPath: url.path) || fm.fileExists(atPath: url.deletingLastPathComponent().path)
                || fm.fileExists(atPath: root.path)
        }
        return existing.isEmpty ? [Paths.publishFiles[0]] : existing
    }

    static func update(_ xml: String, install: Bool) -> String {
        let range = NSRange(xml.startIndex..<xml.endIndex, in: xml)
        let cleared = pattern.stringByReplacingMatches(in: xml, range: range, withTemplate: "")
        guard install else { return cleared }
        let base = cleared.isEmpty
            ? "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n<jsplugins>\n</jsplugins>\n"
            : cleared
        guard let closing = base.range(of: "</jsplugins>", options: [.caseInsensitive, .backwards]) else {
            return "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n<jsplugins>\n\(entry)\n</jsplugins>\n"
        }
        let prefix = String(base[..<closing.lowerBound]).trimmingCharacters(in: .whitespacesAndNewlines)
        return prefix + "\n" + entry + "\n" + String(base[closing.lowerBound...])
    }

    static func write(install: Bool) throws -> [URL] {
        let fm = FileManager.default
        let files = install ? candidateFiles() : Paths.publishFiles.filter { fm.fileExists(atPath: $0.path) }
        for file in files {
            let old = (try? String(contentsOf: file, encoding: .utf8)) ?? ""
            let next = update(old, install: install)
            if old == next { continue }
            try fm.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
            if !old.isEmpty {
                try? fm.copyItem(at: file, to: URL(fileURLWithPath: file.path + ".wps-text-proofreading.bak"))
            }
            try next.write(to: file, atomically: true, encoding: .utf8)
        }
        return files
    }
}

private enum LoginService {
    static func launchctl(_ arguments: [String], allowFailure: Bool = false) throws {
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/bin/launchctl")
        task.arguments = arguments
        let errors = Pipe()
        task.standardError = errors
        task.standardOutput = Pipe()
        try task.run()
        task.waitUntilExit()
        if task.terminationStatus != 0 && !allowFailure {
            let detail = String(data: errors.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
            throw InstallerError.message("启动本机服务失败：\(detail.trimmingCharacters(in: .whitespacesAndNewlines))")
        }
    }

    static func install() throws {
        let fm = FileManager.default
        try fm.createDirectory(at: Paths.agent.deletingLastPathComponent(), withIntermediateDirectories: true)
        try fm.createDirectory(at: Paths.logs, withIntermediateDirectories: true)
        let domain = "gui/\(getuid())"
        if fm.fileExists(atPath: Paths.agent.path) {
            try launchctl(["bootout", domain, Paths.agent.path], allowFailure: true)
        }
        guard StaticServer.portIsAvailable(servicePort) else {
            throw InstallerError.message("端口 \(servicePort) 已被占用。请先关闭现有开发服务，再点击安装。")
        }
        let plist: [String: Any] = [
            "Label": serviceLabel,
            "ProgramArguments": [Paths.executable, "--serve"],
            "RunAtLoad": true,
            "KeepAlive": true,
            "ThrottleInterval": 30,
            "StandardOutPath": Paths.logs.appendingPathComponent("web.log").path,
            "StandardErrorPath": Paths.logs.appendingPathComponent("web.error.log").path
        ]
        let data = try PropertyListSerialization.data(fromPropertyList: plist, format: .xml, options: 0)
        try data.write(to: Paths.agent, options: .atomic)
        try fm.setAttributes([.posixPermissions: 0o600], ofItemAtPath: Paths.agent.path)
        try launchctl(["bootstrap", domain, Paths.agent.path])
    }

    static func remove() throws {
        if FileManager.default.fileExists(atPath: Paths.agent.path) {
            try launchctl(["bootout", "gui/\(getuid())", Paths.agent.path], allowFailure: true)
            try FileManager.default.removeItem(at: Paths.agent)
        }
    }
}

private enum StaticServer {
    static let types = ["html": "text/html", "css": "text/css", "js": "application/javascript",
                        "json": "application/json", "xml": "application/xml"]

    static func portIsAvailable(_ port: UInt16) -> Bool {
        let fd = socket(AF_INET, SOCK_STREAM, 0)
        guard fd >= 0 else { return false }
        defer { close(fd) }
        var reuse: Int32 = 1
        _ = setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &reuse, socklen_t(MemoryLayout<Int32>.size))
        var address = sockaddr_in()
        address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        address.sin_family = sa_family_t(AF_INET)
        address.sin_port = port.bigEndian
        address.sin_addr = in_addr(s_addr: inet_addr("127.0.0.1"))
        return withUnsafePointer(to: &address) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) == 0
            }
        }
    }

    static func run(port: UInt16) throws -> Never {
        let fd = socket(AF_INET, SOCK_STREAM, 0)
        guard fd >= 0 else { throw InstallerError.message("无法创建本机服务套接字。") }
        var reuse: Int32 = 1
        _ = setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &reuse, socklen_t(MemoryLayout<Int32>.size))
        var address = sockaddr_in()
        address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        address.sin_family = sa_family_t(AF_INET)
        address.sin_port = port.bigEndian
        address.sin_addr = in_addr(s_addr: inet_addr("127.0.0.1"))
        let bound = withUnsafePointer(to: &address) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
            }
        }
        guard bound == 0, listen(fd, 32) == 0 else {
            close(fd)
            throw InstallerError.message("端口 \(port) 已被占用，或本机服务无法启动。")
        }
        while true {
            let client = accept(fd, nil, nil)
            if client < 0 { continue }
            var noSigpipe: Int32 = 1
            _ = setsockopt(client, SOL_SOCKET, SO_NOSIGPIPE, &noSigpipe, socklen_t(MemoryLayout<Int32>.size))
            DispatchQueue.global(qos: .utility).async {
                handle(client, port: port)
                close(client)
            }
        }
    }

    private static func sendAll(_ fd: Int32, _ data: Data) {
        data.withUnsafeBytes { bytes in
            guard let base = bytes.baseAddress else { return }
            var offset = 0
            while offset < data.count {
                let count = Darwin.send(fd, base.advanced(by: offset), data.count - offset, 0)
                if count <= 0 { break }
                offset += count
            }
        }
    }

    private static func respond(_ fd: Int32, status: String, body: Data, type: String = "text/plain; charset=utf-8", head: Bool = false) {
        let header = "HTTP/1.1 \(status)\r\nContent-Type: \(type)\r\nContent-Length: \(body.count)\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n"
        sendAll(fd, Data(header.utf8))
        if !head { sendAll(fd, body) }
    }

    private static func handle(_ fd: Int32, port: UInt16) {
        var timeout = timeval(tv_sec: 3, tv_usec: 0)
        _ = setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))
        var request = Data()
        var buffer = [UInt8](repeating: 0, count: 2048)
        while request.count < 8192 && request.range(of: Data("\r\n\r\n".utf8)) == nil {
            let count = recv(fd, &buffer, buffer.count, 0)
            if count <= 0 { return }
            request.append(contentsOf: buffer[..<count])
        }
        guard request.count < 8192, let source = String(data: request, encoding: .utf8) else {
            respond(fd, status: "400 Bad Request", body: Data())
            return
        }
        let lines = source.components(separatedBy: "\r\n")
        let first = lines.first?.split(separator: " ") ?? []
        let head = first.first == "HEAD"
        guard first.count == 3, first[0] == "GET" || head else {
            respond(fd, status: "405 Method Not Allowed", body: Data())
            return
        }
        guard lines.contains(where: { $0.lowercased() == "host: 127.0.0.1:\(port)" }) else {
            respond(fd, status: "403 Forbidden", body: Data())
            return
        }
        let rawPath = String(first[1]).components(separatedBy: "?")[0]
        guard let decoded = rawPath.removingPercentEncoding, decoded.hasPrefix("/"),
              !decoded.contains("\\"), !decoded.contains("\0") else {
            respond(fd, status: "400 Bad Request", body: Data())
            return
        }
        let path = decoded == "/" ? "index.html" : String(decoded.dropFirst())
        let segments = path.split(separator: "/", omittingEmptySubsequences: false).map(String.init)
        guard !segments.contains(where: { $0.isEmpty || $0 == "." || $0 == ".." || $0.hasPrefix(".") }),
              let firstSegment = segments.first,
              (["index.html", "main.js", "ribbon.xml", "package.json"].contains(path)
                || ["ui", "js", "rules"].contains(firstSegment)),
              let ext = path.split(separator: ".").last.map(String.init), types[ext] != nil else {
            respond(fd, status: "400 Bad Request", body: Data())
            return
        }
        let file = Paths.addon.appendingPathComponent(path)
        guard let data = try? Data(contentsOf: file, options: .mappedIfSafe) else {
            respond(fd, status: "404 Not Found", body: Data())
            return
        }
        respond(fd, status: "200 OK", body: data, type: types[ext]! + "; charset=utf-8", head: head)
    }
}

private final class AppController: NSObject, NSApplicationDelegate {
    private var window: NSWindow!
    private var status: NSTextField!

    func applicationDidFinishLaunching(_ notification: Notification) {
        let width: CGFloat = 520
        let height: CGFloat = 310
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: width, height: height),
                          styleMask: [.titled, .closable, .miniaturizable], backing: .buffered, defer: false)
        window.title = "WPS 文本校对 · Mac 安装"
        window.center()
        let content = window.contentView!
        func label(_ text: String, y: CGFloat, size: CGFloat, bold: Bool = false) -> NSTextField {
            let view = NSTextField(labelWithString: text)
            view.frame = NSRect(x: 28, y: y, width: width - 56, height: 45)
            view.font = bold ? .boldSystemFont(ofSize: size) : .systemFont(ofSize: size)
            view.maximumNumberOfLines = 3
            view.lineBreakMode = .byWordWrapping
            content.addSubview(view)
            return view
        }
        _ = label("WPS 文本校对", y: 250, size: 20, bold: true)
        _ = label("将本应用放进“应用程序”后点击安装。安装会注册 WPS 加载项，并启动本机网页服务。", y: 192, size: 13)
        _ = label("校对模型请在 WPS 任务窗格内连接 OpenCode、Ollama 或兼容接口。安装后请完全退出并重新打开 WPS。", y: 133, size: 13)
        status = label("尚未安装", y: 85, size: 12)
        let install = NSButton(title: "安装并启动", target: self, action: #selector(installClicked))
        install.frame = NSRect(x: 28, y: 26, width: 130, height: 32)
        content.addSubview(install)
        let remove = NSButton(title: "卸载服务", target: self, action: #selector(removeClicked))
        remove.frame = NSRect(x: 170, y: 26, width: 110, height: 32)
        content.addSubview(remove)
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        if FileManager.default.fileExists(atPath: Paths.agent.path) { status.stringValue = "已安装。若移动过应用，请再次点击“安装并启动”。" }
    }

    @objc private func installClicked() {
        if Paths.executable.hasPrefix("/Volumes/") {
            status.stringValue = "请先把应用拖入“应用程序”，再打开安装。"
            return
        }
        do {
            guard FileManager.default.fileExists(atPath: Paths.addon.appendingPathComponent("index.html").path) else {
                throw InstallerError.message("安装包缺少加载项文件。")
            }
            let files = try WPSRegistration.write(install: true)
            try LoginService.install()
            status.stringValue = "已安装并启动。已注册 \(files.count) 个 WPS 目录；请重启 WPS。"
        } catch {
            status.stringValue = error.localizedDescription
        }
    }

    @objc private func removeClicked() {
        do {
            try LoginService.remove()
            _ = try WPSRegistration.write(install: false)
            status.stringValue = "已移除登录服务和 WPS 注册项，可以删除本应用。"
        } catch {
            status.stringValue = error.localizedDescription
        }
    }
}

if CommandLine.arguments.contains("--self-test") {
    let old = "<?xml version=\"1.0\"?><jsplugins><jspluginonline name=\"other-addon\" url=\"http://example.test/\"/></jsplugins>"
    let added = WPSRegistration.update(old, install: true)
    let repeated = WPSRegistration.update(added, install: true)
    let removed = WPSRegistration.update(repeated, install: false)
    guard added.contains("name=\"other-addon\""), repeated == added,
          removed.contains("name=\"other-addon\""), !removed.contains("name=\"\(addonName)\"") else {
        fputs("WPS 注册项自检失败。\n", stderr)
        exit(1)
    }
    print("WPS 注册项自检通过。")
} else if CommandLine.arguments.contains("--serve") {
    let args = CommandLine.arguments
    let index = args.firstIndex(of: "--port")
    let port = index.flatMap { $0 + 1 < args.count ? UInt16(args[$0 + 1]) : nil } ?? servicePort
    do { try StaticServer.run(port: port) }
    catch { fputs(error.localizedDescription + "\n", stderr); exit(1) }
} else {
    let app = NSApplication.shared
    let controller = AppController()
    app.delegate = controller
    app.setActivationPolicy(.regular)
    app.run()
}
