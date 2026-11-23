import Foundation

/// Door-to-door minutes between re:Invent venues. Estimates, not measurements: the retired web
/// planner's Las Vegas model (LAS_VEGAS_DEF), with the venue names the Events API sends. The
/// MGM Grand is about two miles south of the rest, so every move to or from it is the shuttle.
public enum Walks {
    /// Inside one venue. The API gives no floor, so this assumes a change of floor.
    public static let sameVenue = 8
    /// When either venue is missing or not in the table.
    public static let unknown = 15

    static let pairs: [Set<String>: Int] = [
        ["Venetian", "Wynn/Encore"]: 15, ["Caesars Forum", "Venetian"]: 15,
        ["Caesars Palace", "Caesars Forum"]: 10, ["Caesars Palace", "Venetian"]: 15,
        ["Caesars Palace", "Wynn/Encore"]: 25, ["Caesars Forum", "Wynn/Encore"]: 20,
        ["Caesars Palace", "MGM Grand"]: 35, ["Caesars Forum", "MGM Grand"]: 35,
        ["MGM Grand", "Venetian"]: 35, ["MGM Grand", "Wynn/Encore"]: 35,
    ]

    public static func minutes(from: String?, to: String?) -> Int {
        guard let from, let to else { return unknown }
        if from == to { return sameVenue }
        return pairs[[from, to]] ?? unknown
    }
}

/// Where he is at one end of a gap.
public enum Place: Equatable, Sendable {
    /// The start or end of the day: nothing to walk from or to.
    case open
    /// A commitment at this venue; nil when the site gives none.
    case at(String?)

    func walk(to venue: String?) -> Int {
        switch self {
        case .open: 0
        case let .at(here): Walks.minutes(from: here, to: venue)
        }
    }
}

/// Free time between commitments on one day, in event-local minutes after midnight.
public struct Gap: Equatable, Sendable {
    public var date: String
    public var start: Int
    public var end: Int
    public var before: Place
    public var after: Place

    public init(date: String, start: Int, end: Int, before: Place, after: Place) {
        self.date = date
        self.start = start
        self.end = end
        self.before = before
        self.after = after
    }
}

/// What he can do to get into a suggested session.
public enum SeatOutlook: Int, Comparable, Sendable {
    /// The site shows a seat he can still reserve.
    case reserve = 0
    /// No seat to reserve: the walk-up line, if there is one.
    case walkUp = 1

    public static func < (a: SeatOutlook, b: SeatOutlook) -> Bool { a.rawValue < b.rawValue }
}

/// A session that fits a gap, with how much it is like his picks.
public struct Suggestion: Equatable, Identifiable, Sendable {
    public var session: Session
    /// Similarity to his picks; above zero for every suggestion.
    public var score: Double
    /// Up to three traits it shares with his picks, the strongest first.
    public var shared: [String]
    public var seat: SeatOutlook
    public var isFavorite: Bool
    /// Another run of a session he has favorited.
    public var isRepeatOfFavorite: Bool

    public var id: String { session.sessionId }
}

extension Session {
    /// The code without its repeat or simulcast suffix ("AIM320-R1" and "AIM110-S-SC2" become
    /// "AIM320" and "AIM110-S"): runs of one session share it. "-S" is part of a code, not a run.
    /// A session without a code is a family of its own, named by its id.
    public var family: String {
        guard let code = Identifier.clean(abbreviation) else { return sessionId }
        var parts = code.split(separator: "-", omittingEmptySubsequences: false).map(String.init)
        while parts.count > 1, let last = parts.last, Session.isRunSuffix(last) { parts.removeLast() }
        return parts.joined(separator: "-")
    }

    /// "R", "R1", "SC2": a letter tag followed by nothing but digits.
    static func isRunSuffix(_ part: String) -> Bool {
        for tag in ["SC", "R"] where part.hasPrefix(tag) {
            if part.dropFirst(tag.count).allSatisfy({ $0.isASCII && $0.isNumber }) { return true }
        }
        return false
    }

    /// The level the site gives a session that has none. It says nothing about his interests.
    static let noLevel = "No Level"

    /// What suggestions are ranked on: topics, areas of interest, services, level and type.
    var traits: Set<Trait> {
        var all = Set<Trait>()
        func add(_ kind: Trait.Kind, _ values: [String]?) {
            for value in values ?? [] { if let clean = Identifier.clean(value) { all.insert(Trait(kind: kind, value: clean)) } }
        }
        add(.topic, topics)
        add(.area, areasOfInterest)
        add(.service, services)
        add(.level, level.map { [$0] }?.filter { $0 != Session.noLevel })
        add(.type, type.map { [$0] })
        return all
    }
}

struct Trait: Hashable, Comparable, Sendable {
    enum Kind: Int, Sendable { case topic, area, service, level, type }
    var kind: Kind
    var value: String

    static func < (a: Trait, b: Trait) -> Bool { (a.kind.rawValue, a.value) < (b.kind.rawValue, b.value) }
}

extension PlanSnapshot {
    /// How much a reserved seat counts in his picks, against 1 for a favorite.
    static let reservedWeight = 2.0

    /// The free stretches of one day around his reserved and invited sessions. The day runs from
    /// the first session the site lists that day to the end of the last one. After overlapping
    /// commitments he is where the one that ends last is.
    public func gaps(on date: String) -> [Gap] {
        let known = sessionsByID
        var dayStart: Int?
        var dayEnd: Int?
        for session in known.values {
            guard let time = session.sessionTime, time.hasValidDate, time.date == date,
                  session.isAllDaySession != true, let start = time.startMinute else { continue }
            dayStart = min(dayStart ?? start, start)
            dayEnd = max(dayEnd ?? start, start + time.lengthMinutes)
        }
        guard let dayStart, let dayEnd else { return [] }

        var gaps: [Gap] = []
        var free = dayStart
        var here = Place.open
        for entry in agenda(on: date, includeFavorites: false, index: known).timed {
            if entry.start > free {
                gaps.append(Gap(date: date, start: free, end: entry.start, before: here, after: .at(entry.session.venue)))
            }
            if entry.end >= free {
                free = entry.end
                here = .at(entry.session.venue)
            }
        }
        if dayEnd > free { gaps.append(Gap(date: date, start: free, end: dayEnd, before: here, after: .open)) }
        return gaps
    }

    /// Catalog sessions he could get to in the gap and back from, most like his picks first.
    /// For several gaps, build one `Suggester` and ask it for each.
    public func suggestions(in gap: Gap) -> [Suggestion] { Suggester(self).suggestions(in: gap) }

}

/// Ranks sessions for gaps against one snapshot. Everything that doesn't depend on the gap
/// (trait weights, his profile, what he holds) is worked out once, here. Sums run in a fixed
/// order, so equal sessions get bit-for-bit equal scores on every launch.
public struct Suggester: Sendable {
    let sessions: [Session]
    let marks: [String: Commitment]
    let weights: [Trait: Double]
    let profile: [Trait: Double]
    let held: Set<String>
    let favoriteFamilies: [String: Set<String>]

    public init(_ plan: PlanSnapshot) {
        sessions = plan.sessions
        let known = plan.sessionsByID
        let marks = plan.commitmentsByID
        self.marks = marks
        let weights = Suggester.traitWeights(plan.sessions)
        self.weights = weights

        var profile: [Trait: Double] = [:]
        var held = Set<String>()
        var favoriteFamilies: [String: Set<String>] = [:]
        for id in marks.keys.sorted() {
            guard let mark = marks[id], let session = known[id] else { continue }
            if mark == .favorite { favoriteFamilies[session.family, default: []].insert(id) } else { held.insert(session.family) }
            // Invitations are not picks: a reception says nothing about what he wants to learn.
            guard mark != .invited else { continue }
            let weight = mark == .reserved ? PlanSnapshot.reservedWeight : 1
            for (trait, value) in Suggester.vector(session, weights) { profile[trait, default: 0] += weight * value }
        }
        self.profile = profile
        self.held = held
        self.favoriteFamilies = favoriteFamilies
    }

    /// Nothing he holds a seat in or is invited to is suggested, nor another run of it. A
    /// session sharing nothing with his picks is left out. Equal scores put a session with a
    /// seat to reserve first, then earlier, then by code.
    public func suggestions(in gap: Gap) -> [Suggestion] {
        var found: [(suggestion: Suggestion, start: Int)] = []
        for session in sessions {
            // A reserved or invited session is in a held family, so this also leaves it out.
            guard !held.contains(session.family), session.isAllDaySession != true,
                  let time = session.sessionTime, time.hasValidDate, time.date == gap.date,
                  let start = time.startMinute else { continue }
            let end = start + time.lengthMinutes
            guard start >= gap.start + gap.before.walk(to: session.venue),
                  end + gap.after.walk(to: session.venue) <= gap.end else { continue }

            let parts = Suggester.vector(session, weights).compactMap { trait, value in
                profile[trait].map { (trait: trait, value: value * $0) }
            }.sorted { $0.trait < $1.trait }
            let score = parts.reduce(0) { $0 + $1.value }
            guard score > 0 else { continue }
            let strongest = parts.sorted { ($0.value, $1.trait) > ($1.value, $0.trait) }

            let open = session.isReservable == true && PlanSnapshot.openSeatBands.contains(session.seatAvailability ?? "")
            let runs = favoriteFamilies[session.family] ?? []
            found.append((Suggestion(session: session, score: score, shared: strongest.prefix(3).map(\.trait.value),
                                     seat: open ? .reserve : .walkUp, isFavorite: marks[session.sessionId] == .favorite,
                                     isRepeatOfFavorite: !runs.subtracting([session.sessionId]).isEmpty), start))
        }
        return found.sorted { a, b in
            if a.suggestion.score != b.suggestion.score { return a.suggestion.score > b.suggestion.score }
            return (a.suggestion.seat.rawValue, a.start, a.suggestion.session.code, a.suggestion.id)
                < (b.suggestion.seat.rawValue, b.start, b.suggestion.session.code, b.suggestion.id)
        }.map(\.suggestion)
    }

    /// How telling each trait is: the log of how many catalog sessions there are over how many
    /// carry it, so a trait on every session counts for nothing.
    static func traitWeights(_ sessions: [Session]) -> [Trait: Double] {
        var counts: [Trait: Int] = [:]
        for session in sessions { for trait in session.traits { counts[trait, default: 0] += 1 } }
        let total = Double(sessions.count)
        return counts.mapValues { log(total / Double($0)) }
    }

    /// A session's traits, weighted and scaled to length 1. Traits the catalog doesn't carry
    /// (an invitation's) weigh nothing.
    static func vector(_ session: Session, _ weights: [Trait: Double]) -> [Trait: Double] {
        var vector: [Trait: Double] = [:]
        for trait in session.traits.sorted() { if let weight = weights[trait], weight > 0 { vector[trait] = weight } }
        let length = vector.keys.sorted().reduce(0) { $0 + vector[$1]! * vector[$1]! }.squareRoot()
        return length > 0 ? vector.mapValues { $0 / length } : [:]
    }
}
