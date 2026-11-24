import Foundation

/// What he tells the app about the sessions he wants (#197), set in Settings. Every part is
/// optional; what he sets wins over what is inferred from his picks.
public struct SessionPreferences: Codable, Equatable, Sendable {
    /// The levels Settings offers (owner's decision: 100 to 400; the catalog also has 500).
    public static let offeredLevels = ["100 – Foundational", "200 – Intermediate", "300 – Advanced", "400 – Expert"]

    /// The levels he prefers, in `offeredLevels` order.
    public private(set) var levels: [String] = []
    /// The formats he prefers and the ones he skips, by name; never the same format in both.
    public private(set) var preferredFormats: [String] = []
    public private(set) var skippedFormats: [String] = []

    public init() {}

    /// A level Settings doesn't offer is ignored.
    public mutating func setLevel(_ level: String, chosen: Bool) {
        let others = levels.filter { $0 != level }
        levels = SessionPreferences.offeredLevels.filter { chosen ? others.contains($0) || $0 == level : others.contains($0) }
    }

    /// Preferring a format stops skipping it.
    public mutating func setPreferred(_ format: String, _ on: Bool) {
        guard let format = Identifier.clean(format) else { return }
        preferredFormats = SessionPreferences.toggled(preferredFormats, format, on)
        if on { skippedFormats.removeAll { $0 == format } }
    }

    /// Skipping a format stops preferring it.
    public mutating func setSkipped(_ format: String, _ on: Bool) {
        guard let format = Identifier.clean(format) else { return }
        skippedFormats = SessionPreferences.toggled(skippedFormats, format, on)
        if on { preferredFormats.removeAll { $0 == format } }
    }

    private static func toggled(_ list: [String], _ item: String, _ on: Bool) -> [String] {
        let others = list.filter { $0 != item }
        return (on ? others + [item] : others).sorted()
    }

    // MARK: Saved on the phone

    /// What is saved on the phone.
    public var saved: Data { (try? JSONEncoder().encode(self)) ?? Data() }

    private enum CodingKeys: String, CodingKey { case levels, preferredFormats, skippedFormats }

    /// A saved copy, read as far as it can be: a level Settings doesn't offer or an unusable
    /// entry is dropped, and a format in both lists is skipped. Nothing readable gives none.
    public init(saved data: Data?) {
        self = data.flatMap { try? JSONDecoder().decode(SessionPreferences.self, from: $0) } ?? SessionPreferences()
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        func names(_ key: CodingKeys) -> [String] {
            ((try? c.decodeIfPresent([Lossy<String>].self, forKey: key)) ?? []).compactMap { Identifier.clean($0.value) }
        }
        var read = SessionPreferences()
        names(.levels).forEach { read.setLevel($0, chosen: true) }
        names(.preferredFormats).forEach { read.setPreferred($0, true) }
        names(.skippedFormats).forEach { read.setSkipped($0, true) }
        self = read
    }

    /// The formats Settings offers: the catalog's own, most common first, then by name, and
    /// any he chose that the catalog no longer has, so he can clear them.
    public static func formats(in sessions: [Session], keeping preferences: SessionPreferences) -> [String] {
        var counts: [String: Int] = [:]
        for session in sessions {
            if let type = Identifier.clean(session.type) { counts[type, default: 0] += 1 }
        }
        let catalog = counts.sorted { ($0.value, $1.key) > ($1.value, $0.key) }.map(\.key)
        let chosen = (preferences.preferredFormats + preferences.skippedFormats).filter { counts[$0] == nil }.sorted()
        return catalog + chosen
    }
}

/// Where a line of the profile came from.
public enum ProfileSource: String, Equatable, Sendable {
    case settings, inferred
}

/// Which lines a profile held, for the logs: never their text.
public struct ProfileUse: Equatable, Sendable {
    public var interestsNamed: Int
    public var levels: ProfileSource?
    public var formats: ProfileSource?
    public var skips: Bool
    public var reservedToday: Bool

    public init(interestsNamed: Int, levels: ProfileSource?, formats: ProfileSource?, skips: Bool, reservedToday: Bool) {
        self.interestsNamed = interestsNamed
        self.levels = levels
        self.formats = formats
        self.skips = skips
        self.reservedToday = reservedToday
    }
}

/// What the on-device model is told about him: his interests, the levels and formats he
/// chooses, what he skips, and how full the day already is. Built on the phone, kept within
/// `PromptBudget.profileTokenLimit`.
public struct AttendeeProfile: Equatable, Sendable {
    public var text: String
    public var use: ProfileUse

    /// A level or format is inferred when at least this many picks share it…
    static let minimumPicks = 3
    /// …and they are at least this share of his picks, in percent.
    static let minimumShare = 20
    static let maxLevels = 2
    static let maxFormats = 3
    /// Characters of a level or format name sent at most.
    static let valueLimit = 60
    /// Interests kept before the other lines are cut, when over the cap.
    static let minInterests = 5
    /// Levels the site uses that aren't a level.
    static let notALevel: Set<String> = ["No Level"]

    /// `picks` are his reserved sessions and favorites (`PlanSnapshot.picks`); `reservedToday`
    /// how many he has reserved on the block's day.
    public static func build(picks: [Session], preferences: SessionPreferences, reservedToday: Int,
                             budget: PromptBudget = PromptBudget()) -> AttendeeProfile {
        var interests = ModelPrompt.interestCounts(of: picks, limit: budget.maxInterests, nameLimit: budget.interestNameLimit,
                                                   nameByteLimit: budget.interestNameByteLimit)
        let hadInterests = !interests.isEmpty
        var levels: (names: [String], source: ProfileSource)?
        if !preferences.levels.isEmpty {
            levels = (preferences.levels, .settings)
        } else {
            let inferred = infer(picks.compactMap(\.level), of: picks.count, max: maxLevels, excluding: notALevel)
            levels = inferred.isEmpty ? nil : (inferred, .inferred)
        }
        var formats: (names: [String], source: ProfileSource)?
        if !preferences.preferredFormats.isEmpty {
            formats = (preferences.preferredFormats, .settings)
        } else {
            let inferred = infer(picks.compactMap(\.type), of: picks.count, max: maxFormats)
            formats = inferred.isEmpty ? nil : (inferred, .inferred)
        }
        let skips = preferences.skippedFormats
        var reserved = reservedToday

        func assemble() -> AttendeeProfile {
            var lines = ["About them:"]
            if !interests.isEmpty {
                lines.append("Interests: " + interests.map { "\($0.name) (\($0.count))" }.joined(separator: ", "))
            } else if !hadInterests {
                lines.append("Interests: none yet")
            }
            if let levels { lines.append("Levels they choose: " + named(levels.names)) }
            if let formats { lines.append("Formats they choose: " + named(formats.names)) }
            if !skips.isEmpty { lines.append("They skip: " + named(skips)) }
            if reserved > 0 { lines.append("Already reserved today: \(reserved) session" + (reserved == 1 ? "" : "s")) }
            return AttendeeProfile(text: lines.joined(separator: "\n"),
                                   use: ProfileUse(interestsNamed: interests.count, levels: levels?.source,
                                                   formats: formats?.source, skips: !skips.isEmpty,
                                                   reservedToday: reserved > 0))
        }
        func over() -> Bool { TokenEstimate.tokens(assemble().text) > budget.profileTokenLimit }

        // Over the cap: interests from the bottom to `minInterests`, then the reserved-today
        // line, then inferred levels and formats, then interests below `minInterests`. What
        // he set is never cut.
        while over(), interests.count > minInterests { interests.removeLast() }
        if over() { reserved = 0 }
        if over(), levels?.source == .inferred { levels = nil }
        if over(), formats?.source == .inferred { formats = nil }
        while over(), !interests.isEmpty { interests.removeLast() }
        return assemble()
    }

    /// Values shared by at least `minimumPicks` picks and `minimumShare` percent of `total`,
    /// most common first, then by name, at most `max`.
    private static func infer(_ values: [String], of total: Int, max: Int, excluding: Set<String> = []) -> [String] {
        var counts: [String: Int] = [:]
        for value in values {
            if let value = Identifier.clean(value), !excluding.contains(value) { counts[value, default: 0] += 1 }
        }
        return counts.filter { $0.value >= minimumPicks && $0.value * 100 >= total * minimumShare }
            .sorted { ($0.value, $1.key) > ($1.value, $0.key) }
            .prefix(max)
            .map(\.key)
    }

    private static func named(_ values: [String]) -> String {
        values.map { ModelPrompt.cut(ModelPrompt.clean($0), to: valueLimit) }.joined(separator: ", ")
    }
}

extension PlanSnapshot {
    /// His reserved sessions and favorites, each once, reserved first; ids the catalog doesn't
    /// have are left out.
    public var picks: [Session] {
        let index = sessionsByID
        var seen: Set<String> = []
        return (schedule.reserved + schedule.favorites).compactMap { id in
            guard seen.insert(id).inserted else { return nil }
            return index[id]
        }
    }

    /// How many sessions he has reserved on `date` ("YYYY-MM-DD").
    public func reservedCount(on date: String) -> Int {
        let index = sessionsByID
        return Set(schedule.reserved).filter { index[$0]?.sessionTime?.date == date }.count
    }
}
