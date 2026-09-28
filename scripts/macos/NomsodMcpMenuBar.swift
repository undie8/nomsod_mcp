import Cocoa
import Foundation

enum NomsodState {
    case online
    case agentOnly
    case offline
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    private var statusItem: NSStatusItem!
    private var timer: Timer?
    private var statusMenuItem: NSMenuItem!
    private var deviceMenuItem: NSMenuItem!
    private var gatewayMenuItem: NSMenuItem!
    private var restartAgentItem: NSMenuItem!
    private var restartSupervisorItem: NSMenuItem!

    private let repoRoot: String
    private var env: [String: String] = [:]

    override init() {
        if let configured = Bundle.main.object(forInfoDictionaryKey: "NomsodProjectRoot") as? String,
           !configured.isEmpty {
            repoRoot = configured
        } else {
            repoRoot = FileManager.default.currentDirectoryPath
        }
        super.init()
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)

        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        buildMenu()
        refreshStatus()

        timer = Timer.scheduledTimer(withTimeInterval: 5.0, repeats: true) { [weak self] _ in
            Task { @MainActor in
                self?.refreshStatus()
            }
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        timer?.invalidate()
    }

    private func buildMenu() {
        let menu = NSMenu()
        menu.autoenablesItems = false

        let header = NSMenuItem(title: "Nomsod MCP v\(appVersion())", action: nil, keyEquivalent: "")
        header.isEnabled = false
        menu.addItem(header)

        statusMenuItem = NSMenuItem(title: "Status: checking...", action: nil, keyEquivalent: "")
        statusMenuItem.isEnabled = false
        menu.addItem(statusMenuItem)

        deviceMenuItem = NSMenuItem(title: "Device: checking...", action: nil, keyEquivalent: "")
        deviceMenuItem.isEnabled = false
        menu.addItem(deviceMenuItem)

        gatewayMenuItem = NSMenuItem(title: "Gateway: checking...", action: nil, keyEquivalent: "")
        gatewayMenuItem.isEnabled = false
        menu.addItem(gatewayMenuItem)

        menu.addItem(.separator())

        let info = NSMenuItem(title: "Show Nomsod MCP info…", action: #selector(showInfo), keyEquivalent: "")
        info.target = self
        menu.addItem(info)

        let keys = NSMenuItem(title: "Reveal keys…", action: #selector(revealKeys), keyEquivalent: "")
        keys.target = self
        menu.addItem(keys)

        let enroll = NSMenuItem(title: "Add new computer", action: nil, keyEquivalent: "")
        let enrollMenu = NSMenu(title: "Add new computer")

        let enrollWindows = NSMenuItem(title: "Copy Windows install command", action: #selector(copyWindowsEnrollment), keyEquivalent: "")
        enrollWindows.target = self
        enrollMenu.addItem(enrollWindows)

        let enrollMac = NSMenuItem(title: "Copy macOS install command", action: #selector(copyMacEnrollment), keyEquivalent: "")
        enrollMac.target = self
        enrollMenu.addItem(enrollMac)

        enroll.submenu = enrollMenu
        menu.addItem(enroll)

        let copyUrl = NSMenuItem(title: "Copy MCP URL", action: #selector(copyMcpUrl), keyEquivalent: "")
        copyUrl.target = self
        menu.addItem(copyUrl)

        let openHealth = NSMenuItem(title: "Open MCP health", action: #selector(openHealth), keyEquivalent: "")
        openHealth.target = self
        menu.addItem(openHealth)

        menu.addItem(.separator())

        restartAgentItem = NSMenuItem(title: "Restart Agent", action: #selector(restartAgent), keyEquivalent: "")
        restartAgentItem.target = self
        menu.addItem(restartAgentItem)

        restartSupervisorItem = NSMenuItem(title: "Restart Supervisor", action: #selector(restartSupervisor), keyEquivalent: "")
        restartSupervisorItem.target = self
        menu.addItem(restartSupervisorItem)

        let restartAll = NSMenuItem(title: "Restart Nomsod MCP", action: #selector(restartAll), keyEquivalent: "")
        restartAll.target = self
        menu.addItem(restartAll)

        menu.addItem(.separator())

        let logs = NSMenuItem(title: "Open logs folder", action: #selector(openLogs), keyEquivalent: "")
        logs.target = self
        menu.addItem(logs)

        let quit = NSMenuItem(title: "Quit Control", action: #selector(quitControl), keyEquivalent: "q")
        quit.target = self
        menu.addItem(quit)

        statusItem.menu = menu
    }

    private func createStatusIcon(_ state: NomsodState) -> NSImage {
        if let iconPath = Bundle.main.path(forResource: "nomsod-mcp", ofType: "png"),
           let icon = NSImage(contentsOfFile: iconPath) {
            icon.size = NSSize(width: 18, height: 18)
            icon.isTemplate = false
            return icon
        }

        let image = NSImage(size: NSSize(width: 18, height: 18))
        image.lockFocus()
        guard let ctx = NSGraphicsContext.current?.cgContext else {
            image.unlockFocus()
            return image
        }

        let center = CGPoint(x: 9, y: 9)
        ctx.setStrokeColor(CGColor(gray: 0, alpha: 1))
        ctx.setFillColor(CGColor(gray: 0, alpha: 1))
        ctx.setLineWidth(1.2)

        // Milk drop outline.
        let p = CGMutablePath()
        p.move(to: CGPoint(x: center.x, y: 2.5))
        p.addCurve(
            to: CGPoint(x: 4.3, y: 10.5),
            control1: CGPoint(x: 7.2, y: 5.3),
            control2: CGPoint(x: 4.3, y: 7.7)
        )
        p.addCurve(
            to: CGPoint(x: 9, y: 15.5),
            control1: CGPoint(x: 4.3, y: 13.6),
            control2: CGPoint(x: 6.4, y: 15.5)
        )
        p.addCurve(
            to: CGPoint(x: 13.7, y: 10.5),
            control1: CGPoint(x: 11.6, y: 15.5),
            control2: CGPoint(x: 13.7, y: 13.6)
        )
        p.addCurve(
            to: CGPoint(x: 9, y: 2.5),
            control1: CGPoint(x: 13.7, y: 7.7),
            control2: CGPoint(x: 10.8, y: 5.3)
        )
        p.closeSubpath()

        switch state {
        case .online:
            ctx.addPath(p)
            ctx.fillPath()
            ctx.setBlendMode(.clear)
            ctx.fillEllipse(in: CGRect(x: 7.3, y: 9.0, width: 3.4, height: 3.4))
            ctx.setBlendMode(.normal)
        case .agentOnly:
            ctx.addPath(p)
            ctx.strokePath()
            ctx.fillEllipse(in: CGRect(x: 7.7, y: 9.4, width: 2.6, height: 2.6))
        case .offline:
            ctx.addPath(p)
            ctx.strokePath()
        }

        image.unlockFocus()
        image.isTemplate = true
        return image
    }

    private func refreshStatus() {
        env = readEnv()
        let port = Int(env["NOMSOD_AGENT_GUARDIAN_HEALTH_PORT"] ?? "34122") ?? 34122
        let agentJson = httpGet("http://127.0.0.1:\(port)/health")
        let agentOk = boolValue(agentJson, key: "ok")
        let connected = boolValue(agentJson, key: "gatewayConnected")

        let identity = readIdentity()
        let displayName = stringValue(identity, key: "displayName") ?? Host.current().localizedName ?? "Mac"
        let deviceId = stringValue(identity, key: "deviceId") ?? "(not paired)"

        let state: NomsodState
        if connected {
            state = .online
            statusMenuItem.title = "Status: Online"
        } else if agentOk {
            state = .agentOnly
            statusMenuItem.title = "Status: Agent running / Gateway offline"
        } else {
            state = .offline
            statusMenuItem.title = "Status: Offline"
        }

        deviceMenuItem.title = "Device: \(displayName) [\(shortId(deviceId))]"
        gatewayMenuItem.title = "Gateway: \(env["NOMSOD_GATEWAY_WS"] ?? "(not configured)")"

        if let button = statusItem.button {
            button.image = createStatusIcon(state)
            button.imagePosition = .imageOnly
            button.title = ""
            button.toolTip = connected
                ? "Nomsod MCP - Online"
                : "Nomsod MCP - Offline"
        }

        restartAgentItem.isEnabled = launchServiceExists("com.nomsod.mcp.agent", user: true)
        restartSupervisorItem.isEnabled =
            launchServiceExists("com.nomsod.mcp.supervisor", user: true) ||
            launchServiceExists("com.nomsod.mcp.supervisor", user: false)
    }

    private func appVersion() -> String {
        let path = repoRoot + "/VERSION"
        if let value = try? String(contentsOfFile: path, encoding: .utf8)
            .trimmingCharacters(in: .whitespacesAndNewlines),
           !value.isEmpty {
            return value
        }
        return "0.0.0"
    }

    private func readEnv() -> [String: String] {
        let path = repoRoot + "/.env"
        guard let text = try? String(contentsOfFile: path, encoding: .utf8) else { return [:] }

        var values: [String: String] = [:]
        for raw in text.components(separatedBy: .newlines) {
            let line = raw.trimmingCharacters(in: .whitespacesAndNewlines)
            if line.isEmpty || line.hasPrefix("#") { continue }
            guard let idx = line.firstIndex(of: "=") else { continue }
            let key = String(line[..<idx]).trimmingCharacters(in: .whitespaces)
            var value = String(line[line.index(after: idx)...]).trimmingCharacters(in: .whitespaces)
            if value.count >= 2,
               (value.hasPrefix("\"") && value.hasSuffix("\"")) ||
               (value.hasPrefix("'") && value.hasSuffix("'")) {
                value = String(value.dropFirst().dropLast())
            }
            values[key] = value
        }
        return values
    }

    private func identityPath() -> String {
        if let configured = env["NOMSOD_IDENTITY_PATH"], !configured.isEmpty {
            return NSString(string: configured).expandingTildeInPath
        }
        return NSString(string: "~/.nomsod-mcp/device.json").expandingTildeInPath
    }

    private func readIdentity() -> [String: Any] {
        guard let data = try? Data(contentsOf: URL(fileURLWithPath: identityPath())),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { return [:] }
        return object
    }

    private func boolValue(_ json: [String: Any]?, key: String) -> Bool {
        return json?[key] as? Bool ?? false
    }

    private func stringValue(_ json: [String: Any], key: String) -> String? {
        return json[key] as? String
    }

    private func shortId(_ id: String) -> String {
        if id.hasPrefix("(") || id.count <= 12 { return id }
        return String(id.prefix(12)) + "…"
    }

    private func httpGet(_ urlString: String) -> [String: Any]? {
        guard let url = URL(string: urlString) else { return nil }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/curl")
        process.arguments = ["-fsS", "--max-time", "2", url.absoluteString]
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = Pipe()

        do {
            try process.run()
            process.waitUntilExit()
            guard process.terminationStatus == 0 else { return nil }
            let data = pipe.fileHandleForReading.readDataToEndOfFile()
            return try JSONSerialization.jsonObject(with: data) as? [String: Any]
        } catch {
            return nil
        }
    }

    private func publicBaseUrl() -> String {
        if let configured = env["NOMSOD_PUBLIC_BASE_URL"], !configured.isEmpty {
            return configured.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        }
        if let ws = env["NOMSOD_GATEWAY_WS"], let url = URL(string: ws), let host = url.host {
            return (url.scheme == "ws" ? "http://" : "https://") + host
        }
        return "https://mcp.nomsod.net"
    }

    private func mcpUrl() -> String { publicBaseUrl() + "/mcp" }

    @objc private func showInfo() {
        refreshStatus()
        let identity = readIdentity()
        let name = stringValue(identity, key: "displayName") ?? "(not paired)"
        let id = stringValue(identity, key: "deviceId") ?? "(not paired)"

        let alert = NSAlert()
        alert.messageText = "Nomsod MCP v\(appVersion())"
        alert.informativeText = """
        Computer: \(Host.current().localizedName ?? "Mac")
        Device name: \(name)
        Device ID: \(id)
        Platform: macOS
        Gateway: \(env["NOMSOD_GATEWAY_WS"] ?? "(not configured)")
        MCP: \(mcpUrl())
        Project: \(repoRoot)
        """
        alert.runModal()
    }

    @objc private func revealKeys() {
        refreshStatus()

        let confirm = NSAlert()
        confirm.messageText = "Reveal sensitive keys?"
        confirm.informativeText = "Owner, pairing and device tokens are credentials. Only reveal them when you need to inspect or copy them."
        confirm.alertStyle = .warning
        confirm.addButton(withTitle: "Reveal")
        confirm.addButton(withTitle: "Cancel")
        guard confirm.runModal() == .alertFirstButtonReturn else { return }

        let identity = readIdentity()
        let owner = env["NOMSOD_OWNER_KEY"] ?? "(not stored on this computer)"
        let pairing = env["NOMSOD_PAIRING_TOKEN"] ?? "(not stored on this computer)"
        let deviceToken = stringValue(identity, key: "deviceToken") ?? "(not paired)"
        let value = """
        Owner key:
        \(owner)

        Pairing key:
        \(pairing)

        Device token:
        \(deviceToken)
        """

        let alert = NSAlert()
        alert.messageText = "Nomsod MCP - Sensitive Keys"
        alert.informativeText = value
        alert.alertStyle = .warning
        alert.addButton(withTitle: "Copy All")
        alert.addButton(withTitle: "Close")
        if alert.runModal() == .alertFirstButtonReturn {
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(value, forType: .string)
        }
    }

    @objc private func copyWindowsEnrollment() {
        Task { await copyEnrollmentCommand(platform: "windows") }
    }

    @objc private func copyMacEnrollment() {
        Task { await copyEnrollmentCommand(platform: "macos") }
    }

    private func copyEnrollmentCommand(platform: String) async {
        refreshStatus()

        guard let controlKey = readControlKey(), !controlKey.isEmpty else {
            showEnrollmentError("Local control key is unavailable. Restart Supervisor once and try again.")
            return
        }

        let controlPort = Int(env["NOMSOD_CONTROL_PORT"] ?? "34102") ?? 34102
        guard let url = URL(string: "http://127.0.0.1:\(controlPort)/enrollment/invite") else {
            showEnrollmentError("Invalid local control URL.")
            return
        }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.timeoutInterval = 5
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(controlKey, forHTTPHeaderField: "X-Nomsod-Control-Key")

        do {
            request.httpBody = try JSONSerialization.data(withJSONObject: [
                "platform": platform,
                "ttlSeconds": 600
            ])

            let (data, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
                showEnrollmentError("Supervisor rejected the enrollment request.")
                return
            }

            guard
                let json = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                let command = json[platform == "macos" ? "macosCommand" : "windowsCommand"] as? String,
                !command.isEmpty
            else {
                showEnrollmentError("Supervisor did not return an enrollment command.")
                return
            }

            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(command, forType: .string)

            let alert = NSAlert()
            alert.messageText = "Enrollment command copied"
            alert.informativeText = "\(platform == "macos" ? "macOS" : "Windows") install command is on the clipboard. The invite expires in 10 minutes."
            alert.runModal()
        } catch {
            showEnrollmentError(error.localizedDescription)
        }
    }

    @objc private func exportRecoveryKit() {
        let confirm = NSAlert()
        confirm.messageText = "Create sensitive recovery kit?"
        confirm.informativeText = "This ZIP can restore the same Nomsod cluster even if every Nomsod computer is wiped. Anyone who obtains it can restore the cluster. Save it only to protected external storage."
        confirm.alertStyle = .warning
        confirm.addButton(withTitle: "Export")
        confirm.addButton(withTitle: "Cancel")
        guard confirm.runModal() == .alertFirstButtonReturn else { return }

        let panel = NSSavePanel()
        panel.title = "Save Nomsod MCP Recovery Kit"
        panel.nameFieldStringValue = "Nomsod-Recovery-Kit-SENSITIVE.zip"
        panel.allowedContentTypes = []
        panel.canCreateDirectories = true
        guard panel.runModal() == .OK, let destination = panel.url?.path else { return }

        let script = repoRoot + "/scripts/recovery/export.sh"
        guard FileManager.default.fileExists(atPath: script) else {
            showEnrollmentError("Recovery exporter is not installed.")
            return
        }

        let code = run("/bin/sh", [script, repoRoot, destination])
        if code != 0 {
            showEnrollmentError("Recovery exporter failed with exit code \(code).")
            return
        }

        let alert = NSAlert()
        alert.messageText = "Recovery kit created"
        alert.informativeText = "Store this ZIP outside Nomsod computers. It is the credential backup used to restore the same cluster when no old machine is available."
        alert.runModal()
    }

    private func readControlKey() -> String? {
        let path = repoRoot + "/data/control.key"
        guard let value = try? String(contentsOfFile: path, encoding: .utf8) else { return nil }
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    private func showEnrollmentError(_ message: String) {
        let alert = NSAlert()
        alert.messageText = "Could not create enrollment command"
        alert.informativeText = message
        alert.alertStyle = .warning
        alert.runModal()
    }

    @objc private func copyMcpUrl() {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(mcpUrl(), forType: .string)
    }

    @objc private func openHealth() {
        if let url = URL(string: publicBaseUrl() + "/health") {
            NSWorkspace.shared.open(url)
        }
    }

    @objc private func openLogs() {
        let path = repoRoot + "/data/logs"
        try? FileManager.default.createDirectory(atPath: path, withIntermediateDirectories: true)
        NSWorkspace.shared.open(URL(fileURLWithPath: path))
    }

    private func launchServiceExists(_ label: String, user: Bool) -> Bool {
        let domain = user ? "gui/\(getuid())" : "system"
        return run("/bin/launchctl", ["print", "\(domain)/\(label)"]) == 0
    }

    private func restart(_ label: String) {
        if launchServiceExists(label, user: true) {
            _ = run("/bin/launchctl", ["kickstart", "-k", "gui/\(getuid())/\(label)"])
        } else if launchServiceExists(label, user: false) {
            _ = run("/bin/launchctl", ["kickstart", "-k", "system/\(label)"])
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) { [weak self] in self?.refreshStatus() }
    }

    @objc private func restartAgent() { restart("com.nomsod.mcp.agent") }
    @objc private func restartSupervisor() { restart("com.nomsod.mcp.supervisor") }

    @objc private func restartAll() {
        restart("com.nomsod.mcp.supervisor")
        restart("com.nomsod.mcp.agent")
    }

    private func run(_ executable: String, _ args: [String]) -> Int32 {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: executable)
        p.arguments = args
        p.standardOutput = Pipe()
        p.standardError = Pipe()
        do {
            try p.run()
            p.waitUntilExit()
            return p.terminationStatus
        } catch {
            return -1
        }
    }

    @objc private func quitControl() {
        NSApplication.shared.terminate(nil)
    }
}

@main
struct NomsodMcpControlApplication {
    @MainActor
    static func main() {
        let app = NSApplication.shared
        let delegate = AppDelegate()
        app.delegate = delegate
        app.run()
    }
}
