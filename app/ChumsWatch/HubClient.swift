import Foundation
import Observation
#if os(watchOS)
import WatchKit
#else
import UIKit
#endif

struct SessionInfo: Decodable, Identifiable, Equatable {
    let id: String
    let name: String
    let status: String
    let lastLine: String?
    let subagents: Int?
}

/// One tool call a session made, from the Claude Code hooks: type is read, edit, bash, test, agent or stop.
struct ToolInfo: Decodable, Identifiable, Equatable {
    let id: String
    let session: String
    let type: String
    let text: String
    let ok: Bool?
    var at: Double? = nil       // when (ms since 1970)
}

struct Approval: Decodable, Identifiable, Equatable {
    let requestId: String
    let session: String
    let tool: String
    let description: String
    let preview: String
    let summary: String?
    var id: String { requestId }
}

struct Spoken: Decodable, Identifiable, Equatable {
    let id: String
    let session: String
    let text: String
    let kind: String
    let audio: String?          // the reply's voice, rendered on the Mac (GET it from the hub)
    var audioData: String? = nil // the same, in the answer that brought the line (base64 m4a): no second trip
    var device: String? = nil   // the device whose order this answers: it speaks it (none: the watch)
    /// Whether this device reads the line aloud: the one the order came from (lines with none are the watch's).
    var speaksHere: Bool { (device ?? "watch") == HubClient.device }
    let at: Double?             // when it was said (ms since 1970), to keep the conversation in order
    let artifact: Artifact?     // something it showed you (a screenshot, a page, an image)
    let agent: String?          // whose line it is (lines from before agents have none: they were the first agent's)
    /// The agent it belongs to.
    var owner: String { agent ?? Agents.fallback }
}

/// An agent: a character with its own Claude Code session and thread on the Mac (~/.chums/agents.json).
struct AgentInfo: Decodable, Identifiable, Equatable {
    let id: String
    let name: String
    let character: String
    let status: String          // idle, working, waiting, blocked, compacting, limited, offline
    let line: String?           // the last thing it said
    let needs: Bool             // it asks you something, or waits on an approval
    var owns: String? = nil     // what it looks after (its soul)
    var runtime: String? = nil  // claude or codex: what it runs on, switched on its soul screen
    var voice: String? = nil    // its voice on the Mac (a Kokoro voice id), chosen on its soul screen
    var model: String? = nil    // its model (an alias or a slug); nil: what its runtime is set to use
    var permission: String? = nil   // how it asks before acting (a mode id for its runtime); nil: its runtime's setting
}

/// How an agent may act, for a runtime: the modes it offers (Asks first, …) and what it uses when an agent has none.
struct PermissionChoices: Decodable, Equatable {
    let `default`: String?
    let modes: [ModelChoices.Model]
}

/// The models a runtime offers, and what it uses when an agent has none of its own ("Opus, 1M context").
struct ModelChoices: Decodable, Equatable {
    struct Model: Decodable, Identifiable, Equatable { let id: String; let name: String; var about: String? = nil }
    let `default`: String?
    let models: [Model]
}

/// One of the voices the Mac can speak in (Kokoro's English ones).
struct VoiceInfo: Decodable, Identifiable, Equatable {
    let id: String
    let name: String
    let grade: String
    let accent: String
    let gender: String
}

struct HubState: Decodable {
    let rev: Int
    let sessions: [SessionInfo]
    let approvals: [Approval]
    let spoken: [Spoken]
    let tools: [ToolInfo]?
    let agents: [AgentInfo]?
    var runtimes: [String]? = nil   // what an agent can be switched to on this Mac
}

/// An agent's soul as the watch shows it: who it is, what it looks after, what it refers to the others, its voice.
struct SoulCard: Decodable, Equatable {
    let id: String?
    let name: String
    let owns: String?
    let refers: String?
    let voice: String?
    var body: String? = nil
    let canUndo: Bool?
}

/// What you said on a soul screen, as a change to see before saving (or a question back, or why it failed).
struct SoulProposal: Decodable {
    let transcript: String?
    let proposal: String?
    let summary: String?
    let soul: SoulCard?
    let clarify: String?
    let error: String?
}

/// The hub's reason, when it says no.
struct HubFailure: Decodable { let error: String? }

struct RouteResult: Decodable {
    let transcript: String?
    let kind: String
    let echo: String?
    let target: String?
}

/// HTTP only: watchOS allows WebSockets only while streaming audio (TN3135), so state comes from a
/// long-poll that runs while Chums is on screen.
@MainActor @Observable
final class HubClient {
    private(set) var state: HubState?
    private(set) var connected = false
    private(set) var lastError: String?

    /// Fired for lines that arrive after the first load, so old lines are never re-spoken.
    var onSpoken: ((Spoken) -> Void)?
    var onApproval: ((Approval) -> Void)?

    private var rev = 0
    /// The first state since launch is in. Lines and approvals after it are news, those that came while the poll was
    /// stopped too (the app in the background, the Mac out of reach): a restarted poll doesn't mark them seen.
    @ObservationIgnored private var loaded = false
    private var seenSpoken = Set<String>()
    private var seenApprovals = Set<String>()
    private var pollTask: Task<Void, Never>?
    private var hostIndex = 0
    private var failingSince: Date?          // the first failure since the last success
    /// The hub's addresses to try. 127.0.0.1 is the Mac only in the Simulator; on a real watch it's the watch itself.
    private static let hosts: [String] = {
#if targetEnvironment(simulator)
        // Simulator captures: a stand-in hub playing a scripted session (-hub http://127.0.0.1:7799)
        if let h = UserDefaults.standard.string(forKey: "hub") { return [h] }
        return HubConfig.hosts
#else
        HubConfig.hosts.filter { !$0.contains("127.0.0.1") && !$0.contains("localhost") }
#endif
    }()
    private let urlSession: URLSession = {
        let c = URLSessionConfiguration.default
        c.timeoutIntervalForRequest = 30
        c.timeoutIntervalForResource = 40
        c.waitsForConnectivity = true          // watchOS brings a network path up on demand; wait for it instead of failing
        return URLSession(configuration: c)
    }()

    private var base: String { Self.hosts[hostIndex % Self.hosts.count] }

    /// Pings every address at once (4 s each) and keeps the first in the list that answers: the public one (Tailscale
    /// Funnel), then 127.0.0.1 (the Simulator's hub; a real watch or iPhone drops it). Asked again whenever requests
    /// start failing.
    private func pickHost() async {
        let hosts = Self.hosts
        let ok = await withTaskGroup(of: (Int, Bool).self) { g -> Set<Int> in
            for (i, h) in hosts.enumerated() { g.addTask { (i, await Self.ping(h)) } }
            var s = Set<Int>()
            for await (i, good) in g where good { s.insert(i) }
            return s
        }
        if let best = ok.min() { hostIndex = best } else { hostIndex = (hostIndex + 1) % hosts.count }
        let now = ok.isEmpty ? "none answered" : hosts[hostIndex]
        if now != route { route = now; if !ok.isEmpty { event("network: using \(now) (\(ok.count) of \(hosts.count) answered)") } }
    }
    /// Which address answered last, for the event log.
    private(set) var route = ""
    private nonisolated static let probeSession: URLSession = {
        let c = URLSessionConfiguration.ephemeral
        c.timeoutIntervalForRequest = 4; c.timeoutIntervalForResource = 4
        c.waitsForConnectivity = true
        return URLSession(configuration: c)
    }()
    private nonisolated static func ping(_ host: String) async -> Bool {
        guard let url = URL(string: host + "/v1/ping") else { return false }
        var r = URLRequest(url: url, timeoutInterval: 4)
        r.setValue("Bearer \(HubConfig.token)", forHTTPHeaderField: "Authorization")
        guard let (_, resp) = try? await probeSession.data(for: r) else { return false }
        return (resp as? HTTPURLResponse)?.statusCode == 200
    }

    /// Sent with each poll so the hub can log what keyring mode costs (~/.chums/watch-battery.csv).
    @ObservationIgnored var screen = "on"
    @ObservationIgnored var keyring = false
    private var deviceQuery: String {
#if os(watchOS)
        let d = WKInterfaceDevice.current()
        d.isBatteryMonitoringEnabled = true
        let charging = d.batteryState == .charging || d.batteryState == .full
        return "&battery=\(String(format: "%.2f", d.batteryLevel))&charging=\(charging ? 1 : 0)&screen=\(screen)&keyring=\(keyring ? 1 : 0)&device=watch"
#else
        return "&device=phone"
#endif
    }
    /// Which device this is, for the hub: a reply is spoken on the device the order came from.
#if os(watchOS)
    nonisolated static let device = "watch"
#else
    nonisolated static let device = "phone"
#endif

    func start() {
        guard pollTask == nil else { return }
        pollTask = Task { await pollLoop() }
    }

    func stop() {
        pollTask?.cancel()
        pollTask = nil
    }

    private func request(_ path: String, method: String = "GET", body: Data? = nil,
                         contentType: String = "application/json", timeout: TimeInterval = 30) -> URLRequest {
        var r = URLRequest(url: URL(string: base + path)!, timeoutInterval: timeout)
        r.httpMethod = method
        r.setValue("Bearer \(HubConfig.token)", forHTTPHeaderField: "Authorization")
        if let body {
            r.httpBody = body
            r.setValue(contentType, forHTTPHeaderField: "Content-Type")
        }
        return r
    }

    private func pollLoop() async {
        var first = true, failures = 0          // first: this poll's first request asks for the whole state at once
        await pickHost()
        while !Task.isCancelled {
            do {
                let (data, resp) = try await urlSession.data(for: request("/v1/state?since=\(first ? 0 : rev)\(deviceQuery)", timeout: 28))
                let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
                guard code == 200 else { throw code == 401 ? URLError(.userAuthenticationRequired) : URLError(.badServerResponse) }
                apply(try JSONDecoder().decode(HubState.self, from: data), initial: !loaded)
                first = false; loaded = true
                connected = true
                lastError = nil
                failingSince = nil
                failures = 0
            } catch {
                if Task.isCancelled { break }
                // A request fails every time the watch sleeps and wakes, so one failure says nothing. Stay on the
                // address that worked and retry it; only say the Mac is unreachable after 8 s of failing, and only
                // move to the next address after a couple of failures in a row on this one.
                let now = Date(), since = failingSince ?? now
                failingSince = since
                let refused = (error as? URLError)?.code == .userAuthenticationRequired
                if refused || now.timeIntervalSince(since) > 8 {
                    connected = false
                    lastError = refused ? "Hub refused the token" : (error.localizedDescription.isEmpty ? "Can't reach your Mac" : error.localizedDescription)
                }
                failures += 1
                if failures >= 2 { failures = 0; await pickHost() }      // the path changed: find the address that answers now
                else { try? await Task.sleep(for: .seconds(1)) }
            }
        }
    }

    private func apply(_ s: HubState, initial: Bool) {
        rev = s.rev
        state = s
        for line in s.spoken where !seenSpoken.contains(line.id) {
            seenSpoken.insert(line.id)
            if !initial { onSpoken?(line) }
        }
        for a in s.approvals where !seenApprovals.contains(a.requestId) {
            seenApprovals.insert(a.requestId)
            if !initial { onApproval?(a) }
        }
        // the hub only ever sends the last few lines and the open approvals, so older ids can go
        if seenSpoken.count > 300 { seenSpoken = Set(s.spoken.map(\.id)) }
        if seenApprovals.count > 100 { seenApprovals = Set(s.approvals.map(\.requestId)) }
    }

    /// `approval` is the approval card that was on screen while you spoke: a spoken yes or no answers that one.
    /// What you said, for the agent you were talking to when you started (and the approval card that was on screen).
    func send(audio url: URL, approval: String?, agent: String) async -> RouteResult? {
        guard let data = try? Data(contentsOf: url) else { return nil }
        var h = ["X-Chums-Agent": agent, "X-Chums-Device": Self.device]
        if let approval { h["X-Chums-Approval"] = approval }
        return await post("/v1/utterance", body: data, contentType: "audio/m4a", headers: h)
    }

    /// One line for the hub's log (~/.chums/watch-events.log): what the watch did, so it can be checked from the Mac.
    func event(_ text: String) {
#if targetEnvironment(simulator)
        let text = "[sim] " + text                                   // the Simulator reports to the same hub
#endif
        guard let body = try? JSONSerialization.data(withJSONObject: ["text": text]) else { return }
        let r = request("/v1/event", method: "POST", body: body, timeout: 5)
        Task { _ = try? await urlSession.data(for: r) }
    }

    /// The voices the Mac can speak in; nil when it can't say.
    func voices() async -> [VoiceInfo]? {
        struct R: Decodable { let voices: [VoiceInfo] }
        let r: (R?, String?) = await exchange(request("/v1/voices", timeout: 10))
        return r.0?.voices
    }
    /// The models each runtime offers ("claude", "codex").
    func models() async -> [String: ModelChoices]? {
        await exchange(request("/v1/models", timeout: 10)).0
    }
    /// The permission modes each runtime offers ("claude", "codex").
    func permissions() async -> [String: PermissionChoices]? {
        await exchange(request("/v1/permissions", timeout: 10)).0
    }
    /// An agent's permission mode (nil: its runtime's own): it restarts with it. nil once it has, else why not.
    func setPermission(_ agent: String, mode: String?) async -> String? {
        let body = try? JSONSerialization.data(withJSONObject: ["mode": mode.map { $0 as Any } ?? NSNull()])
        let req = request("/v1/agents/\(agent)/permission", method: "POST", body: body, timeout: 90)
        guard let (data, resp) = try? await urlSession.data(for: req) else { return "Can't reach your Mac" }
        if (resp as? HTTPURLResponse)?.statusCode == 200 { return nil }
        return (try? JSONDecoder().decode([String: String].self, from: data))?["error"] ?? "Couldn't change it"
    }
    /// An agent's model (nil: its runtime's own): it restarts on it. nil once it has, else why not.
    func setModel(_ agent: String, model: String?) async -> String? {
        let body = try? JSONSerialization.data(withJSONObject: ["model": model.map { $0 as Any } ?? NSNull()])
        let req = request("/v1/agents/\(agent)/model", method: "POST", body: body, timeout: 90)
        guard let (data, resp) = try? await urlSession.data(for: req) else { return "Can't reach your Mac" }
        if (resp as? HTTPURLResponse)?.statusCode == 200 { return nil }
        return (try? JSONDecoder().decode([String: String].self, from: data))?["error"] ?? "Couldn't change it"
    }
    /// An agent's voice; nil once the hub has it, else why not.
    func setVoice(_ agent: String, voice: String) async -> String? {
        let req = request("/v1/agents/\(agent)/voice", method: "POST", body: try? JSONEncoder().encode(["voice": voice]), timeout: 10)
        guard let (data, resp) = try? await urlSession.data(for: req) else { return "Can't reach your Mac" }
        if (resp as? HTTPURLResponse)?.statusCode == 200 { return nil }
        return (try? JSONDecoder().decode([String: String].self, from: data))?["error"] ?? "Couldn't change it"
    }

    /// A reply's voice from the hub, nil when there's none or it can't be fetched.
    /// A file from the hub (an artifact's original, for the iPhone's viewers): nil when it can't be had. Big files take time.
    func fetch(_ path: String, timeout: Double = 90) async -> Data? {
        guard let (data, resp) = try? await urlSession.data(for: request(path, timeout: timeout)),
              (resp as? HTTPURLResponse)?.statusCode == 200 else { return nil }
        return data
    }
    func speech(_ path: String) async -> Data? {
        guard let (data, resp) = try? await urlSession.data(for: request(path, timeout: 8)),
              (resp as? HTTPURLResponse)?.statusCode == 200 else { return nil }
        return data
    }

    // MARK: souls

    func soul(_ agent: String) async -> SoulCard? { await exchange(request("/v1/agents/\(agent)/soul", timeout: 10)).0 }
    /// What you said about an agent's soul: the hub transcribes it and proposes a change (nothing is saved yet).
    func sendSoul(audio url: URL, agent: String) async -> SoulProposal? {
        guard let data = try? Data(contentsOf: url) else { return nil }
        var r = request("/v1/utterance", method: "POST", body: data, contentType: "audio/m4a", timeout: 90)
        r.setValue(agent, forHTTPHeaderField: "X-Chums-Soul")
        return await exchange(r).0
    }
    /// Typed words to an agent, as if said (the iPhone's composer, Siri, the widget).
    func say(_ text: String, agent: String, approval: String? = nil, files: [String] = []) async -> RouteResult? {
        var body: [String: Any] = ["text": text, "agent": agent, "device": Self.device]
        if let approval { body["approval"] = approval }
        if !files.isEmpty { body["files"] = files }
        return await exchange(request("/v1/say", method: "POST", body: try? JSONSerialization.data(withJSONObject: body), timeout: 30)).0
    }

    /// A picture or a file, to the Mac (the hub keeps it in ~/.chums/uploads); its path there goes with the next order.
    struct Upload: Decodable { let path: String; let name: String; let artifact: Artifact? }
    func upload(_ data: Data, name: String, type: String) async -> Upload? {
        let q = name.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? "file"
        let req = request("/v1/upload?name=\(q)", method: "POST", body: data, contentType: type, timeout: 120)
        guard let (d, resp) = try? await urlSession.data(for: req), (resp as? HTTPURLResponse)?.statusCode == 200 else { return nil }
        return try? JSONDecoder().decode(Upload.self, from: d)
    }

    /// The agent the iPhone shows now: the widgets show it too, when no agent is picked in them.
    func focus(_ agent: String) async {
        let body = try? JSONEncoder().encode(["agent": agent])
        _ = try? await urlSession.data(for: request("/v1/focus", method: "POST", body: body, timeout: 10))
    }

    /// The address the hub answers at now, and how long it takes to answer (ms; nil: it didn't).
    var address: String { base }
    func ping() async -> Double? {
        let t0 = Date()
        guard let (_, resp) = try? await urlSession.data(for: request("/v1/ping", timeout: 10)),
              (resp as? HTTPURLResponse)?.statusCode == 200 else { return nil }
        return Date().timeIntervalSince(t0) * 1000
    }

    /// The same with typed words (Simulator captures: -soulSay "…").
    func soulFromText(_ text: String, agent: String) async -> SoulProposal? {
        await exchange(request("/v1/say", method: "POST", body: try? JSONEncoder().encode(["soul": agent, "text": text]), timeout: 90)).0
    }
    func saveSoul(_ agent: String, proposal: String) async -> (SoulCard?, String?) {
        await exchange(request("/v1/agents/\(agent)/soul/save", method: "POST", body: try? JSONEncoder().encode(["proposal": proposal]), timeout: 20))
    }
    /// Switches an agent to Claude Code ("claude") or Codex ("codex"); nil once it runs on it, else why not.
    func setRuntime(_ agent: String, runtime: String) async -> String? {
        let req = request("/v1/agents/\(agent)/runtime", method: "POST", body: try? JSONEncoder().encode(["runtime": runtime]), timeout: 150)
        guard let (data, resp) = try? await urlSession.data(for: req) else { return "Can't reach your Mac" }
        if (resp as? HTTPURLResponse)?.statusCode == 200 { return nil }
        return (try? JSONDecoder().decode([String: String].self, from: data))?["error"] ?? "Couldn't switch it"
    }
    /// One part of a soul (name, owns, refers, voice, body), written as given.
    func setSoul(_ agent: String, field: String, value: String) async -> (SoulCard?, String?) {
        await exchange(request("/v1/agents/\(agent)/soul/set", method: "POST",
                               body: try? JSONEncoder().encode(["field": field, "value": value]), timeout: 20))
    }
    func undoSoul(_ agent: String) async -> (SoulCard?, String?) {
        await exchange(request("/v1/agents/\(agent)/soul/undo", method: "POST", body: Data("{}".utf8), timeout: 20))
    }
    /// A request whose failure has a reason worth showing (the hub's error message).
    private func exchange<T: Decodable>(_ r: URLRequest) async -> (T?, String?) {
        guard let (data, resp) = try? await urlSession.data(for: r) else { return (nil, "Can't reach your Mac") }
        let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
        if code == 200, let v = try? JSONDecoder().decode(T.self, from: data) { return (v, nil) }
        return (nil, (try? JSONDecoder().decode(HubFailure.self, from: data))?.error ?? "Something went wrong (\(code))")
    }

    /// True once the hub has the verdict.
    func verdict(_ requestId: String, allow: Bool) async -> Bool {
        let body = try? JSONEncoder().encode(["requestId": requestId, "behavior": allow ? "allow" : "deny"])
        let r: RouteResult? = await post("/v1/verdict", body: body ?? Data())
        return r != nil
    }

    /// The screen woke or you touched it while the Mac was out of reach: look again now instead of after the timeout.
    func nudge() {
        guard pollTask != nil, !connected || lastError != nil else { return }
        stop(); start()
    }

    private func post<T: Decodable>(_ path: String, body: Data, contentType: String = "application/json", headers: [String: String] = [:]) async -> T? {
        var r = request(path, method: "POST", body: body, contentType: contentType)
        for (k, v) in headers { r.setValue(v, forHTTPHeaderField: k) }
        do {
            let (data, resp) = try await urlSession.data(for: r)
            let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
            if code == 401 { lastError = "Hub refused the token"; return nil }
            guard code == 200 else { return nil }
            return try JSONDecoder().decode(T.self, from: data)
        } catch {
            return nil
        }
    }
}
