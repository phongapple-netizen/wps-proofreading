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

private enum InstallTransaction {
    static func run(preflight: () throws -> Void, register: () throws -> Void,
                    start: () throws -> Void, rollback: () throws -> Void) throws {
        try preflight()
        try register()
        do { try start() }
        catch {
            let failure = error
            do { try rollback() }
            catch { throw InstallerError.message("安装失败（\(failure.localizedDescription)），回滚也失败（\(error.localizedDescription)）。") }
            throw failure
        }
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

private final class XMLRootVerifier: NSObject, XMLParserDelegate {
    var root: String?
    func parser(_ parser: XMLParser, didStartElement elementName: String,
                namespaceURI: String?, qualifiedName qName: String?, attributes attributeDict: [String: String]) {
        if root == nil { root = elementName.lowercased() }
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

    static func update(_ xml: String, install: Bool) throws -> String {
        if !xml.isEmpty {
            guard xml.range(of: "<jsplugins\\b[^>]*>", options: [.regularExpression, .caseInsensitive]) != nil,
                  xml.range(of: "</jsplugins>", options: [.regularExpression, .caseInsensitive]) != nil,
                  let data = xml.data(using: .utf8) else {
                throw InstallerError.message("WPS publish.xml 格式异常，已停止修改以保护其他加载项。")
            }
            let parser = XMLParser(data: data)
            let verifier = XMLRootVerifier()
            parser.delegate = verifier
            guard parser.parse(), verifier.root == "jsplugins" else {
                throw InstallerError.message("WPS publish.xml 格式异常，已停止修改以保护其他加载项。")
            }
        }
        let range = NSRange(xml.startIndex..<xml.endIndex, in: xml)
        let cleared = pattern.stringByReplacingMatches(in: xml, range: range, withTemplate: "")
        guard install else { return cleared }
        let base = cleared.isEmpty
            ? "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n<jsplugins>\n</jsplugins>\n"
            : cleared
        guard let closing = base.range(of: "</jsplugins>", options: [.caseInsensitive, .backwards]) else { throw InstallerError.message("WPS publish.xml 缺少结束标签，已停止修改。") }
        let prefix = String(base[..<closing.lowerBound]).trimmingCharacters(in: .whitespacesAndNewlines)
        return prefix + "\n" + entry + "\n" + String(base[closing.lowerBound...])
    }

    static func write(install: Bool, files overrideFiles: [URL]? = nil) throws -> (files: [URL], previous: [URL: Data?]) {
        let fm = FileManager.default
        let files = overrideFiles ?? (install ? candidateFiles() : Paths.publishFiles.filter { fm.fileExists(atPath: $0.path) })
        var previous: [URL: Data?] = [:]
        do {
            for file in files {
                let fileExists = fm.fileExists(atPath: file.path)
                let data = try? Data(contentsOf: file)
                if fileExists && data == nil { throw InstallerError.message("无法读取 WPS publish.xml，已停止修改。") }
                previous[file] = .some(data)
                let old = data.flatMap { String(data: $0, encoding: .utf8) } ?? ""
                if let data, !data.isEmpty, old.isEmpty { throw InstallerError.message("WPS publish.xml 不是有效 UTF-8，已停止修改。") }
                let next = try update(old, install: install)
                if old == next { continue }
                try fm.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
                if !old.isEmpty {
                    // Replace the single rolling backup atomically. Backup failures abort the update.
                    try data!.write(to: URL(fileURLWithPath: file.path + ".wps-text-proofreading.bak"), options: .atomic)
                }
                try next.write(to: file, atomically: true, encoding: .utf8)
            }
        } catch {
            let failure = error
            do { try rollback(previous) }
            catch { throw InstallerError.message("写入 WPS 注册项失败（\(failure.localizedDescription)），恢复原配置也失败（\(error.localizedDescription)）。") }
            throw failure
        }
        return (files, previous)
    }

    static func rollback(_ previous: [URL: Data?]) throws {
        var failures: [String] = []
        for (url, data) in previous {
            do {
                if let data { try data.write(to: url, options: .atomic) }
                else if FileManager.default.fileExists(atPath: url.path) { try FileManager.default.removeItem(at: url) }
            } catch { failures.append("\(url.path): \(error.localizedDescription)") }
        }
        if !failures.isEmpty { throw InstallerError.message(failures.joined(separator: "；")) }
    }

    static func restorePluginEntries() throws {
        _ = try write(install: false)
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
        let agentExists = fm.fileExists(atPath: Paths.agent.path)
        let oldAgent = try? Data(contentsOf: Paths.agent)
        if agentExists && oldAgent == nil { throw InstallerError.message("无法读取现有 LaunchAgent，已停止安装。") }
        do {
            if oldAgent != nil { try launchctl(["bootout", domain, Paths.agent.path], allowFailure: true) }
            let portDeadline = Date().addingTimeInterval(3)
            while !StaticServer.portIsAvailable(servicePort) && Date() < portDeadline {
                Thread.sleep(forTimeInterval: 0.1)
            }
            guard StaticServer.portIsAvailable(servicePort) else {
                throw InstallerError.message("端口 3891 已被其他程序占用，无法安装本机服务。")
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
            guard StaticServer.waitForHealth(timeout: 8) else {
                throw InstallerError.message("本机服务启动后未能通过健康检查。")
            }
        } catch {
            let failure = error
            var rollbackErrors: [String] = []
            do { try launchctl(["bootout", domain, Paths.agent.path], allowFailure: true) }
            catch { rollbackErrors.append(error.localizedDescription) }
            do { if fm.fileExists(atPath: Paths.agent.path) { try fm.removeItem(at: Paths.agent) } }
            catch { rollbackErrors.append(error.localizedDescription) }
            if let oldAgent {
                do { try oldAgent.write(to: Paths.agent, options: .atomic) }
                catch { rollbackErrors.append(error.localizedDescription) }
                do { try launchctl(["bootstrap", domain, Paths.agent.path]) }
                catch { rollbackErrors.append(error.localizedDescription) }
            }
            if !rollbackErrors.isEmpty {
                throw InstallerError.message("服务安装失败（\(failure.localizedDescription)）；恢复原 LaunchAgent 也失败：\(rollbackErrors.joined(separator: "；"))")
            }
            throw failure
        }
    }

    static func remove() throws {
        if FileManager.default.fileExists(atPath: Paths.agent.path) {
            try launchctl(["bootout", "gui/\(getuid())", Paths.agent.path], allowFailure: true)
            try FileManager.default.removeItem(at: Paths.agent)
        }
    }
}

private enum NativeOpenCode {
    enum Health: Equatable { case ready, absent, conflict }
    struct HealthResult { let state: Health; let version: String }
    private static let lock = NSLock()
    private static var child: Process?
    private static let logLimit = 1024 * 1024

    fileprivate static func searchDirectories(path: String, home: String,
                                              homebrewArm: String = "/opt/homebrew/bin",
                                              usrLocal: String = "/usr/local/bin") -> [String] {
        var dirs = path.split(separator: ":").map(String.init)
        dirs += ["\(home)/.opencode/bin", "\(home)/.local/bin", "\(home)/bin", "\(home)/.npm-global/bin", homebrewArm, usrLocal]
        var seen = Set<String>()
        return dirs.filter { seen.insert($0).inserted }
    }

    fileprivate static func findExecutable(directories: [String], isExecutable: (String) -> Bool) -> URL? {
        directories.map { URL(fileURLWithPath: $0).appendingPathComponent("opencode") }
            .first { isExecutable($0.path) }
    }

    private static func executable() -> URL? {
        let home = Paths.home.path
        let path = ProcessInfo.processInfo.environment["PATH"] ?? ""
        return findExecutable(directories: searchDirectories(path: path, home: home)) {
            FileManager.default.isExecutableFile(atPath: $0)
        }
    }

    private static func version(_ executable: URL) -> String {
        let process = Process()
        process.executableURL = executable
        process.arguments = ["--version"]
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = pipe
        let outputLock = NSLock()
        var output = Data()
        let readerFinished = DispatchSemaphore(value: 0)
        do {
            DispatchQueue.global(qos: .utility).async {
                while true {
                    guard let data = try? pipe.fileHandleForReading.read(upToCount: 2048), !data.isEmpty else { break }
                    outputLock.lock()
                    if output.count < 256 { output.append(data.prefix(256 - output.count)) }
                    outputLock.unlock()
                }
                readerFinished.signal()
            }
            let completed = DispatchSemaphore(value: 0)
            process.terminationHandler = { _ in completed.signal() }
            try process.run()
            if completed.wait(timeout: .now() + 3) == .timedOut {
                if process.isRunning { process.terminate() }
                if completed.wait(timeout: .now() + 0.25) == .timedOut && process.isRunning {
                    _ = Darwin.kill(process.processIdentifier, SIGKILL)
                    _ = completed.wait(timeout: .now() + 0.25)
                }
                pipe.fileHandleForReading.closeFile()
                return ""
            }
            _ = readerFinished.wait(timeout: .now() + 0.2)
            guard process.terminationStatus == 0 else { return "" }
            outputLock.lock(); defer { outputLock.unlock() }
            return String(data: output, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        } catch { pipe.fileHandleForReading.closeFile(); return "" }
    }

    static func health() -> HealthResult {
        guard let url = URL(string: "http://127.0.0.1:4096/global/health") else { return HealthResult(state: .absent, version: "") }
        var request = URLRequest(url: url, timeoutInterval: 1.5)
        request.httpMethod = "GET"
        let semaphore = DispatchSemaphore(value: 0)
        var result = HealthResult(state: .absent, version: "")
        URLSession.shared.dataTask(with: request) { data, response, error in
            defer { semaphore.signal() }
            result = classifyHealth(status: (response as? HTTPURLResponse)?.statusCode, body: data,
                                    errorCode: (error as NSError?)?.code)
        }.resume()
        if semaphore.wait(timeout: .now() + 2) == .timedOut { return HealthResult(state: .conflict, version: "") }
        return result
    }

    fileprivate static func classifyHealth(status: Int?, body: Data?, errorCode: Int?) -> HealthResult {
        if let status {
            guard (200..<300).contains(status), let body,
                  let json = try? JSONSerialization.jsonObject(with: body) as? [String: Any],
                  json["healthy"] as? Bool == true,
                  let version = json["version"] as? String,
                  !version.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
                return HealthResult(state: .conflict, version: "")
            }
            return HealthResult(state: .ready, version: version)
        }
        if errorCode == NSURLErrorTimedOut || errorCode == NSURLErrorNetworkConnectionLost {
            return HealthResult(state: .conflict, version: "")
        }
        return HealthResult(state: .absent, version: "")
    }

    private static func response(state: String, found: Bool, version: String = "", managed: Bool = false) -> Data {
        let body: [String: Any] = ["state": state, "found": found, "version": version, "managed": managed]
        return (try? JSONSerialization.data(withJSONObject: body)) ?? Data("{}".utf8)
    }

    static func status() -> Data {
        let executable = executable()
        let current = health()
        let version = current.state == .ready ? current.version : (executable.map(version) ?? "")
        switch current.state {
        case .ready: return response(state: "ready", found: executable != nil, version: version, managed: child?.isRunning == true)
        case .conflict: return response(state: "port_conflict", found: executable != nil, version: version)
        case .absent: return response(state: executable == nil ? "missing" : "stopped", found: executable != nil, version: version)
        }
    }

    static func start() -> Data {
        let current = health()
        if case .ready = current.state {
            let executable = executable()
            return response(state: "ready", found: executable != nil, version: current.version, managed: child?.isRunning == true)
        }
        if case .conflict = current.state { return response(state: "port_conflict", found: executable() != nil) }
        guard let executable = executable() else { return response(state: "missing", found: false) }
        lock.lock(); defer { lock.unlock() }
        if child?.isRunning != true {
            let process = Process()
            process.executableURL = executable
            process.arguments = ["serve", "--hostname", "127.0.0.1", "--port", "4096", "--cors", "http://127.0.0.1:3891"]
            let pipe = Pipe(); process.standardOutput = pipe; process.standardError = pipe
            do {
                try FileManager.default.createDirectory(at: Paths.logs, withIntermediateDirectories: true)
                let log = Paths.logs.appendingPathComponent("opencode.log")
                if let size = (try? FileManager.default.attributesOfItem(atPath: log.path)[.size] as? NSNumber)?.intValue, size >= logLimit {
                    try? FileManager.default.removeItem(at: log)
                }
                FileManager.default.createFile(atPath: log.path, contents: nil, attributes: [.posixPermissions: 0o600])
                let output = try FileHandle(forWritingTo: log)
                DispatchQueue.global(qos: .utility).async {
                    while true {
                        let data = pipe.fileHandleForReading.readData(ofLength: 4096)
                        if data.isEmpty { break }
                        let current = (try? FileManager.default.attributesOfItem(atPath: log.path)[.size] as? NSNumber)?.intValue ?? 0
                        if current + data.count > logLimit { try? output.truncate(atOffset: 0); try? output.seek(toOffset: 0) }
                        try? output.write(contentsOf: data)
                    }
                    try? output.close()
                }
                try process.run(); child = process
            } catch { return response(state: "error", found: true, version: version(executable)) }
        }
        let deadline = Date().addingTimeInterval(15)
        while Date() < deadline {
            let current = health()
            if case .ready = current.state { return response(state: "ready", found: true, version: current.version, managed: child?.isRunning == true) }
            Thread.sleep(forTimeInterval: 0.25)
        }
        return response(state: "error", found: true, version: version(executable), managed: child?.isRunning == true)
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

    static func waitForPort(_ port: UInt16, timeout: TimeInterval) -> Bool {
        let until = Date().addingTimeInterval(timeout)
        repeat {
            if !portIsAvailable(port) { return true }
            Thread.sleep(forTimeInterval: 0.1)
        } while Date() < until
        return false
    }

    static func waitForHealth(timeout: TimeInterval) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            guard let url = URL(string: "http://127.0.0.1:\(servicePort)/api/health") else { return false }
            let semaphore = DispatchSemaphore(value: 0)
            var healthy = false
            URLSession.shared.dataTask(with: url) { data, response, _ in
                if let http = response as? HTTPURLResponse, http.statusCode == 200,
                   let data, String(data: data, encoding: .utf8) == "wps-proofreading-ready" { healthy = true }
                semaphore.signal()
            }.resume()
            _ = semaphore.wait(timeout: .now() + 0.5)
            if healthy { return true }
            Thread.sleep(forTimeInterval: 0.15)
        }
        return false
    }

    static func isOwnServerHealthy() -> Bool {
        guard let url = URL(string: "http://127.0.0.1:\(servicePort)/api/health") else { return false }
        let semaphore = DispatchSemaphore(value: 0)
        var healthy = false
        URLSession.shared.dataTask(with: url) { data, response, _ in
            if let http = response as? HTTPURLResponse, http.statusCode == 200,
               let data, String(data: data, encoding: .utf8) == "wps-proofreading-ready" { healthy = true }
            semaphore.signal()
        }.resume()
        _ = semaphore.wait(timeout: .now() + 1)
        return healthy
    }

    fileprivate static func validHostHeaders(_ values: [String], port: UInt16) -> Bool {
        values.count == 1 && values[0] == "127.0.0.1:\(port)"
    }

    fileprivate static func validStartHeaders(origins: [String], contentLengths: [String], transferEncodings: [String], body: String) -> Bool {
        origins.count == 1 && origins[0] == "http://127.0.0.1:3891" && transferEncodings.isEmpty
            && contentLengths.count <= 1 && (contentLengths.first == nil || contentLengths.first == "0") && body.isEmpty
    }

    static func allowsMethod(_ method: String, path: String) -> Bool {
        if path == "/api/opencode/status" { return method == "GET" }
        if path == "/api/opencode/start" { return method == "POST" }
        if path == "/api/health" { return method == "GET" }
        return method == "GET" || method == "HEAD"
    }

    private static func headerValues(_ lines: [String], named name: String) -> [String] {
        lines.dropFirst().compactMap { line in
            guard let separator = line.firstIndex(of: ":"),
                  line[..<separator].trimmingCharacters(in: .whitespaces).caseInsensitiveCompare(name) == .orderedSame else { return nil }
            return line[line.index(after: separator)...].trimmingCharacters(in: .whitespaces)
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
        guard first.count == 3 else {
            respond(fd, status: "405 Method Not Allowed", body: Data())
            return
        }
        let rawPath = String(first[1]).components(separatedBy: "?")[0]
        let hosts = headerValues(lines, named: "host")
        guard validHostHeaders(hosts, port: port) else {
            respond(fd, status: "403 Forbidden", body: Data())
            return
        }
        guard allowsMethod(String(first[0]), path: rawPath) else {
            respond(fd, status: "405 Method Not Allowed", body: Data()); return
        }
        if rawPath == "/api/opencode/status" || rawPath == "/api/opencode/start" {
            if rawPath == "/api/opencode/start" {
                let origins = headerValues(lines, named: "origin")
                let lengths = headerValues(lines, named: "content-length")
                let encodings = headerValues(lines, named: "transfer-encoding")
                let separator = source.range(of: "\r\n\r\n")!.upperBound
                let trailingBody = source[separator...]
                guard validStartHeaders(origins: origins, contentLengths: lengths,
                                        transferEncodings: encodings, body: String(trailingBody)) else {
                    respond(fd, status: "403 Forbidden", body: Data()); return
                }
            }
            let body = rawPath.hasSuffix("/start") ? NativeOpenCode.start() : NativeOpenCode.status()
            respond(fd, status: "200 OK", body: body, type: "application/json; charset=utf-8", head: head)
            return
        }
        if rawPath == "/api/health" {
            respond(fd, status: "200 OK", body: Data("wps-proofreading-ready".utf8), type: "text/plain; charset=utf-8")
            return
        }
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
            let originalAgent = try? Data(contentsOf: Paths.agent)
            if FileManager.default.fileExists(atPath: Paths.agent.path) && originalAgent == nil {
                throw InstallerError.message("无法读取现有 LaunchAgent，已停止安装。")
            }
            var registrationSnapshot: [URL: Data?] = [:]
            try InstallTransaction.run(preflight: {
                guard StaticServer.portIsAvailable(servicePort) || StaticServer.isOwnServerHealthy()
                        || FileManager.default.fileExists(atPath: Paths.agent.path) else {
                    throw InstallerError.message("端口 3891 已被占用，无法安装本机服务。")
                }
                for name in ["index.html", "main.js", "ribbon.xml", "package.json", "ui/taskpane.html",
                             "ui/taskpane.css", "js/taskpane.js", "js/proofreading-integration.js",
                             "js/opencode-client.js", "rules/catalog.json"] {
                    guard FileManager.default.fileExists(atPath: Paths.addon.appendingPathComponent(name).path) else {
                        throw InstallerError.message("安装包缺少加载项文件：\(name)。")
                    }
                }
            }, register: {
                let result = try WPSRegistration.write(install: true)
                registrationSnapshot = result.previous
                status.stringValue = "已安装并启动。已注册 \(result.files.count) 个 WPS 目录；请重启 WPS。"
            }, start: {
                try LoginService.install()
            }, rollback: {
                try WPSRegistration.rollback(registrationSnapshot)
                try LoginService.remove()
                if let originalAgent {
                    try originalAgent.write(to: Paths.agent, options: .atomic)
                    try LoginService.launchctl(["bootstrap", "gui/\(getuid())", Paths.agent.path])
                }
            })
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
    let multiple = "<?xml version=\"1.0\"?><jsplugins><jspluginonline name=\"other-addon\"/><jspluginonline name=\"second-addon\"/></jsplugins>"
    let added = try! WPSRegistration.update(multiple, install: true)
    let repeated = try! WPSRegistration.update(added, install: true)
    let removed = try! WPSRegistration.update(repeated, install: false)
    let removedAgain = try! WPSRegistration.update(removed, install: false)
    let migrated = try! WPSRegistration.update("<jsplugins><jspluginonline name=\"wordollama-wps-native\"/></jsplugins>", install: true)
    let malformedRejected = (try? WPSRegistration.update("<jsplugins><jspluginonline name=\"other-addon\"/>", install: true)) == nil
    let brokenRejected = (try? WPSRegistration.update("<jsplugins><broken></jsplugins>", install: false)) == nil
    let wrongRootRejected = (try? WPSRegistration.update("<other><jsplugins></jsplugins></other>", install: true)) == nil
    let emptyCreated = (try? WPSRegistration.update("", install: true))?.contains("<jsplugins>") == true
    let temp = FileManager.default.temporaryDirectory.appendingPathComponent("wps-proofreading-selftest-\(UUID().uuidString)", isDirectory: true)
    try! FileManager.default.createDirectory(at: temp, withIntermediateDirectories: true)
    let tempPublish = temp.appendingPathComponent("publish.xml")
    let backup = URL(fileURLWithPath: tempPublish.path + ".wps-text-proofreading.bak")
    let original = Data("<jsplugins><jspluginonline name=\"keep-me\"/></jsplugins>".utf8)
    try! original.write(to: tempPublish)
    try! Data("stale backup".utf8).write(to: backup)
    _ = try! WPSRegistration.write(install: true, files: [tempPublish])
    let backupUpdated = (try? Data(contentsOf: backup)) == original
    let fileAfterInstall = try! String(contentsOf: tempPublish, encoding: .utf8)
    _ = try! WPSRegistration.write(install: true, files: [tempPublish])
    let installIdempotent = (try! String(contentsOf: tempPublish, encoding: .utf8)) == fileAfterInstall
    _ = try! WPSRegistration.write(install: false, files: [tempPublish])
    let onceUninstalled = try! String(contentsOf: tempPublish, encoding: .utf8)
    _ = try! WPSRegistration.write(install: false, files: [tempPublish])
    let uninstallIdempotent = (try! String(contentsOf: tempPublish, encoding: .utf8)) == onceUninstalled
    var registeredDuringFailure = false
    let startupFailed: Bool
    let installFailureTarget = temp.appendingPathComponent("startup-failure.xml")
    try! original.write(to: installFailureTarget)
    var installRegistrationSnapshot: [URL: Data?] = [:]
    do {
        try InstallTransaction.run(preflight: {}, register: {
            let result = try WPSRegistration.write(install: true, files: [installFailureTarget])
            installRegistrationSnapshot = result.previous
            registeredDuringFailure = true
        }, start: { throw InstallerError.message("stub startup failure") }, rollback: {
            try! WPSRegistration.rollback(installRegistrationSnapshot)
        })
        startupFailed = false
    } catch { startupFailed = true }
    let registrationUntouched = registeredDuringFailure && (try! Data(contentsOf: installFailureTarget)) == original
    let damagedPublish = temp.appendingPathComponent("damaged.xml")
    let damagedBytes = Data("<jsplugins><broken></jsplugins>".utf8)
    try! damagedBytes.write(to: damagedPublish)
    _ = try? WPSRegistration.write(install: true, files: [damagedPublish])
    let damagedUnchanged = (try? Data(contentsOf: damagedPublish)) == damagedBytes
    let batchTarget = temp.appendingPathComponent("batch.xml")
    try! original.write(to: batchTarget)
    _ = try? WPSRegistration.write(install: true, files: [batchTarget, damagedPublish])
    let batchRolledBack = (try? Data(contentsOf: batchTarget)) == original
    let emptyTarget = temp.appendingPathComponent("empty.xml")
    try! Data().write(to: emptyTarget)
    _ = try! WPSRegistration.write(install: true, files: [emptyTarget])
    let emptyFileCreated = ((try? String(contentsOf: emptyTarget, encoding: .utf8)) ?? "").contains("<jsplugins>")

    let userHome = temp.appendingPathComponent("home").path
    let pathDir = temp.appendingPathComponent("path-opencode").path
    let brewDir = temp.appendingPathComponent("brew").path
    let localDir = temp.appendingPathComponent("local-bin").path
    let pathSearch = NativeOpenCode.searchDirectories(path: pathDir, home: userHome, homebrewArm: brewDir, usrLocal: localDir)
    let pathFound = NativeOpenCode.findExecutable(directories: pathSearch) { $0 == pathDir + "/opencode" }?.path == pathDir + "/opencode"
    let hiddenDir = userHome + "/.opencode/bin"
    let hiddenFound = NativeOpenCode.findExecutable(directories: NativeOpenCode.searchDirectories(path: "", home: userHome, homebrewArm: brewDir, usrLocal: localDir)) { $0 == hiddenDir + "/opencode" }?.path == hiddenDir + "/opencode"
    let brewFound = NativeOpenCode.findExecutable(directories: [brewDir, localDir]) { $0 == brewDir + "/opencode" }?.path == brewDir + "/opencode"
    let usrLocalFound = NativeOpenCode.findExecutable(directories: [localDir]) { $0 == localDir + "/opencode" }?.path == localDir + "/opencode"
    let notFound = NativeOpenCode.findExecutable(directories: pathSearch) { _ in false } == nil
    let healthyBody = Data("{\"healthy\":true,\"version\":\"1.2.3\"}".utf8)
    let healthyStatus = NativeOpenCode.classifyHealth(status: 200, body: healthyBody, errorCode: nil)
    let noProcessStatus = NativeOpenCode.classifyHealth(status: nil, body: nil, errorCode: NSURLErrorCannotConnectToHost)
    let timeoutStatus = NativeOpenCode.classifyHealth(status: nil, body: nil, errorCode: NSURLErrorTimedOut)
    let httpErrorStatus = NativeOpenCode.classifyHealth(status: 503, body: Data(), errorCode: nil)
    let nonOpenCodeStatus = NativeOpenCode.classifyHealth(status: 200, body: Data("{}".utf8), errorCode: nil)
    let healthChecks = healthyStatus.state == .ready && healthyStatus.version == "1.2.3"
        && noProcessStatus.state == .absent && timeoutStatus.state == .conflict
        && httpErrorStatus.state == .conflict && nonOpenCodeStatus.state == .conflict
    let methodChecks = StaticServer.allowsMethod("POST", path: "/api/opencode/start")
        && !StaticServer.allowsMethod("POST", path: "/api/opencode/status")
        && StaticServer.validHostHeaders(["127.0.0.1:3891"], port: 3891)
        && !StaticServer.validHostHeaders(["127.0.0.1:3891", "evil.invalid"], port: 3891)
        && StaticServer.validStartHeaders(origins: ["http://127.0.0.1:3891"], contentLengths: ["0"], transferEncodings: [], body: "")
        && !StaticServer.validStartHeaders(origins: ["http://127.0.0.1:3891", "https://evil.invalid"], contentLengths: [], transferEncodings: [], body: "")
    try? FileManager.default.removeItem(at: temp)
    guard added.contains("name=\"other-addon\""), added.contains("name=\"second-addon\""), repeated == added,
          removed.contains("name=\"other-addon\""), removed.contains("name=\"second-addon\""), !removed.contains("name=\"\(addonName)\""), removedAgain == removed,
          migrated.contains("name=\"\(addonName)\""), !migrated.contains("wordollama-wps-native"), malformedRejected, brokenRejected, wrongRootRejected, emptyCreated,
          backupUpdated, installIdempotent, uninstallIdempotent, startupFailed, registrationUntouched,
          damagedUnchanged, batchRolledBack, emptyFileCreated, pathFound, hiddenFound, brewFound, usrLocalFound,
          notFound, healthChecks, methodChecks else {
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
