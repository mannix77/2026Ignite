import Foundation

/// Whether he agreed to share the model's records with Honeycomb (#193). Nothing is sent
/// until he says yes.
public enum EventSharing: String, Equatable, Sendable {
    case notAsked, allowed, declined

    /// The answer as saved; anything unreadable counts as not asked, so it sends nothing.
    public init(saved: Any?) {
        self = (saved as? String).flatMap(EventSharing.init(rawValue:)) ?? .notAsked
    }

    public var saved: String { rawValue }

    /// His answer, and the install id to keep: a yes keeps the one he has; a no forgets it, so
    /// a later yes starts a new one.
    public static func answer(_ allowed: Bool, installID: String?) -> (sharing: EventSharing, installID: String?) {
        allowed ? (.allowed, InstallID.usable(installID)) : (.declined, nil)
    }
}

/// Where events go: the build's send-only Honeycomb ingest key and dataset. A build made
/// without them has none, and sends nothing.
public struct HoneycombConfig: Equatable, Sendable {
    /// Honeycomb's Events API, US region (docs.honeycomb.io/api/events).
    public static let host = URL(string: "https://api.honeycomb.io")!

    public let key: String
    public let dataset: String

    /// Usable only as trimmed, non-blank strings: a key with no whitespace or control character
    /// inside, and a dataset of letters, digits, ".", "_" and "-", not dots alone ("..")
    /// so it can't change the address.
    public init?(key: Any?, dataset: Any?) {
        guard let key = (key as? String)?.trimmingCharacters(in: .whitespacesAndNewlines), !key.isEmpty,
              key.rangeOfCharacter(from: .whitespacesAndNewlines.union(.controlCharacters)) == nil,
              let dataset = (dataset as? String)?.trimmingCharacters(in: .whitespacesAndNewlines), !dataset.isEmpty,
              dataset.unicodeScalars.allSatisfy({ HoneycombConfig.datasetCharacters.contains($0) }),
              dataset.contains(where: { $0 != "." })
        else { return nil }
        self.key = key
        self.dataset = dataset
    }

    /// From the file the release build carries (`Honeycomb.plist`, written by `archive.sh`).
    public init?(file: [String: Any]?) {
        self.init(key: file?["IngestKey"], dataset: file?["Dataset"])
    }

    private static let datasetCharacters = CharacterSet(charactersIn:
        "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-")

    /// `POST /1/events/{dataset}`: one event per request.
    public var url: URL { HoneycombConfig.host.appendingPathComponent("1/events/\(dataset)") }
}

/// The app's version and build, sent with every event.
public struct AppBuild: Equatable, Sendable {
    public var version: String
    public var build: String

    public init(version: String, build: String) {
        self.version = version
        self.build = build
    }
}

/// A random id for this install, never his AWS identity. He can reset it in Settings.
public enum InstallID {
    /// The saved id when it is one: a UUID, in its usual upper-case form.
    public static func usable(_ saved: Any?) -> String? {
        guard let text = (saved as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) else { return nil }
        return UUID(uuidString: text)?.uuidString
    }

    public static func make() -> String { UUID().uuidString }

    /// The id an event carries: the saved one when usable, otherwise a new one (to be saved).
    public static func forSending(_ saved: Any?) -> String { usable(saved) ?? make() }
}

/// What became of one event.
public enum EventDelivery: Equatable, Sendable {
    /// Not sent: he hasn't said yes, the build has no key, or there is no usable install id.
    case notSent
    case sent
    /// Honeycomb answered with this status. The event is dropped.
    case refused(Int)
    /// Honeycomb couldn't be reached. The event is dropped.
    case unreachable
}

/// Sends the model's records to Honeycomb, one event per request, only with his yes (#193).
/// Every event is sent (no sampling); one that fails is dropped, never retried or kept.
public struct EventLog: Sendable {
    /// Seconds a request is given before it is dropped.
    public static let requestTimeout: TimeInterval = 10
    /// The event's name in Honeycomb.
    public static let modelEvent = "suggest.model"

    let config: HoneycombConfig?
    let transport: HTTPTransport

    public init(config: HoneycombConfig?, transport: HTTPTransport) {
        self.config = config
        self.transport = transport
    }

    /// Whether to ask him on opening the app: only a build that can send asks, and only once.
    public static func asksOnLaunch(_ sharing: EventSharing, config: HoneycombConfig?) -> Bool {
        config != nil && sharing == .notAsked
    }

    /// Sends `run` as one event, when he said yes and the build has a key. `duration` is how
    /// long the model step took, when it was timed.
    public func send(_ run: ModelRun, duration: Duration?, sharing: EventSharing, installID: String,
                     app: AppBuild) async -> EventDelivery {
        guard sharing == .allowed, let config, let id = InstallID.usable(installID),
              let body = try? JSONSerialization.data(withJSONObject: EventLog.fields(run, duration: duration, installID: id, app: app),
                                                     options: [.sortedKeys])
        else { return .notSent }
        var request = URLRequest(url: config.url, timeoutInterval: EventLog.requestTimeout)
        request.httpMethod = "POST"
        request.setValue(config.key, forHTTPHeaderField: "X-Honeycomb-Team")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = body
        do {
            let (_, response) = try await transport.send(request)
            return (200..<300).contains(response.statusCode) ? .sent : .refused(response.statusCode)
        } catch {
            return .unreachable
        }
    }

    /// The event's fields: outcomes, counts and timings only. Never the prompt, the reasons,
    /// his picks, his profile's text, his sign-in or anything he typed.
    static func fields(_ run: ModelRun, duration: Duration?, installID: String, app: AppBuild) -> [String: Any] {
        var fields: [String: Any] = [
            "name": modelEvent, "app.version": app.version, "app.build": app.build, "install_id": installID,
            "outcome": run.outcome.rawValue, "remembered": run.remembered, "placed": run.placed, "ignored": run.ignored,
        ]
        fields["unavailable_reason"] = run.unavailableReason
        fields["duration_ms"] = duration.map(milliseconds)
        fields["model.prompt_tokens"] = run.modelPromptTokens
        fields["model.answer_tokens"] = run.modelAnswerTokens
        if let prompt = run.prompt {
            fields["prompt.estimated_tokens"] = prompt.estimatedTokens
            fields["prompt.window"] = prompt.window
            fields["prompt.answer_reserve"] = prompt.answerReserve
            fields["prompt.headroom"] = prompt.headroom
            fields["prompt.sessions_in_block"] = prompt.sessionsInBlock
            fields["prompt.sessions_sent"] = prompt.sessionsSent
            fields["prompt.sessions_left_out"] = prompt.sessionsLeftOut
            fields["prompt.abstracts_cut"] = prompt.abstractsCut
            fields["prompt.profile_tokens"] = prompt.profileTokens
            fields["profile.interests_named"] = prompt.profile.interestsNamed
            fields["profile.levels"] = prompt.profile.levels?.rawValue ?? "none"
            fields["profile.formats"] = prompt.profile.formats?.rawValue ?? "none"
            fields["profile.skips"] = prompt.profile.skips
            fields["profile.reserved_today"] = prompt.profile.reservedToday
        }
        return fields
    }

    static func milliseconds(_ duration: Duration) -> Int {
        let (seconds, attoseconds) = duration.components
        return Int(seconds) * 1000 + Int(attoseconds / 1_000_000_000_000_000)
    }
}
