import Foundation

/// How firmly a session is on the attendee's calendar. Lower sorts first.
public enum Commitment: Int, Comparable, Codable, Sendable {
    case reserved = 0
    case invited = 1
    case favorite = 2

    public static func < (a: Commitment, b: Commitment) -> Bool { a.rawValue < b.rawValue }
}

/// One block on a day.
public struct AgendaEntry: Identifiable, Equatable, Sendable {
    public var session: Session
    public var commitment: Commitment
    /// Minutes after midnight, event-local.
    public var start: Int
    /// The real end. Equal to `start` for the few sessions the site lists with no length.
    public var end: Int

    public var id: String { session.sessionId }

    /// Shortest block the calendar draws, so a zero-length session is still visible.
    public static let minimumDrawnMinutes = 20
    public var drawnEnd: Int { max(end, start + AgendaEntry.minimumDrawnMinutes) }
}

/// A change of venue between two commitments with too little time to make it.
public struct TransferWarning: Equatable, Identifiable, Sendable {
    public var fromID: String
    public var toID: String
    public var fromVenue: String
    public var toVenue: String
    public var gapMinutes: Int

    public var id: String { "\(fromID)>\(toID)" }
}

/// The favorites that start within one clock hour, shown as a single marker.
public struct FavoriteBucket: Equatable, Identifiable, Sendable {
    /// Hour of the day the favorites start in (13 for 1:00–1:59 PM).
    public var hour: Int
    public var entries: [AgendaEntry]

    public var id: Int { hour }
}

public struct DayAgenda: Equatable, Sendable {
    public var date: String
    public var timed: [AgendaEntry]
    public var allDay: [AgendaEntry]
    public var warnings: [TransferWarning]

    /// Reserved and invited sessions: what is drawn as blocks on the timeline.
    public var commitments: [AgendaEntry] { timed.filter { $0.commitment != .favorite } }

    /// Favorites grouped by the hour they start in, earliest hour first. A day can hold dozens
    /// of overlapping favorites, so they are never drawn as blocks beside the commitments.
    public var favoriteBuckets: [FavoriteBucket] {
        var buckets: [FavoriteBucket] = []
        for entry in timed where entry.commitment == .favorite {
            let hour = entry.start / 60
            if let last = buckets.indices.last, buckets[last].hour == hour {
                buckets[last].entries.append(entry)
            } else {
                buckets.append(FavoriteBucket(hour: hour, entries: [entry]))
            }
        }
        return buckets
    }
}

/// The catalog plus what the conference site holds for the attendee, as last fetched.
public struct PlanSnapshot: Codable, Equatable, Sendable {
    public var sessions: [Session]
    public var schedule: Schedule
    public var fetchedAt: Date
    /// Catalog records dropped on the last fetch because they were unusable.
    public var skipped: Int

    public init(sessions: [Session], schedule: Schedule, fetchedAt: Date, skipped: Int = 0) {
        self.sessions = sessions
        self.schedule = schedule
        self.fetchedAt = fetchedAt
        self.skipped = skipped
    }

    /// A change of venue with less than this many minutes between commitments is flagged.
    public static let tightTransferMinutes = 30

    /// Catalog sessions and invited sessions by id. The catalog wins when both have one.
    public var sessionsByID: [String: Session] {
        var map: [String: Session] = [:]
        for session in schedule.invitedSessions { map[session.sessionId] = session }
        for session in sessions { map[session.sessionId] = session }
        return map
    }

    public func commitment(of sessionID: String) -> Commitment? {
        if schedule.reserved.contains(sessionID) { return .reserved }
        if schedule.invitedSessions.contains(where: { $0.sessionId == sessionID }) { return .invited }
        if schedule.favorites.contains(sessionID) { return .favorite }
        return nil
    }

    /// Favorites and reservations the site lists that are in neither the catalog nor the
    /// invitations (usually a session withdrawn after it was favorited).
    public var unresolvedIDs: [String] {
        let known = sessionsByID
        var missing: [String] = []
        for id in schedule.reserved + schedule.favorites where known[id] == nil && !missing.contains(id) {
            missing.append(id)
        }
        return missing
    }

    /// Every date the attendee has something on, or all catalog dates when asked.
    public func days(committedOnly: Bool = false) -> [String] {
        let known = sessionsByID
        var dates = Set<String>()
        func add(_ session: Session?) {
            if let time = session?.sessionTime, time.hasValidDate { dates.insert(time.date) }
        }
        if committedOnly {
            for id in schedule.reserved + schedule.favorites { add(known[id]) }
            for session in schedule.invitedSessions { add(session) }
        } else {
            for session in known.values { add(session) }
        }
        return dates.sorted()
    }

    /// What is on the calendar for one day: reserved and invited sessions, plus favorites when asked.
    public func agenda(on date: String, includeFavorites: Bool) -> DayAgenda {
        let known = sessionsByID
        var chosen: [String: Commitment] = [:]
        func choose(_ id: String, _ commitment: Commitment) {
            if let existing = chosen[id], existing <= commitment { return }
            chosen[id] = commitment
        }
        for id in schedule.reserved { choose(id, .reserved) }
        for session in schedule.invitedSessions { choose(session.sessionId, .invited) }
        if includeFavorites { for id in schedule.favorites { choose(id, .favorite) } }

        var timed: [AgendaEntry] = []
        var allDay: [AgendaEntry] = []
        for (id, commitment) in chosen {
            guard let session = known[id], let time = session.sessionTime, time.hasValidDate, time.date == date,
                  let start = time.startMinute else { continue }
            let entry = AgendaEntry(session: session, commitment: commitment, start: start,
                                    end: start + time.lengthMinutes)
            if session.isAllDaySession == true { allDay.append(entry) } else { timed.append(entry) }
        }
        let order: (AgendaEntry, AgendaEntry) -> Bool = { a, b in
            (a.start, a.commitment.rawValue, a.session.code, a.id) < (b.start, b.commitment.rawValue, b.session.code, b.id)
        }
        timed.sort(by: order)
        allDay.sort(by: order)
        return DayAgenda(date: date, timed: timed, allDay: allDay,
                         warnings: PlanSnapshot.transferWarnings(timed.filter { $0.commitment != .favorite }))
    }

    /// Consecutive commitments in different venues with less than `tightTransferMinutes` between
    /// them. Entries must be in start order. Sessions without a venue are not judged.
    static func transferWarnings(_ entries: [AgendaEntry]) -> [TransferWarning] {
        var warnings: [TransferWarning] = []
        for (a, b) in zip(entries, entries.dropFirst()) {
            guard let from = a.session.venue, let to = b.session.venue, from != to else { continue }
            let gap = b.start - a.end
            if gap < tightTransferMinutes {
                warnings.append(TransferWarning(fromID: a.id, toID: b.id, fromVenue: from, toVenue: to, gapMinutes: gap))
            }
        }
        return warnings
    }
}

public enum Sync {
    /// Fetches the catalog and the schedule and builds a snapshot. Throws, leaving `previous`
    /// in place, when either fetch fails or the new catalog is under half the size of the one held.
    public static func refresh(backend: PlanBackend, previous: PlanSnapshot?, now: Date) async throws -> PlanSnapshot {
        let catalog = try await backend.loadCatalog()
        if let previous, catalog.sessions.count * 2 < previous.sessions.count {
            throw APIError.catalogShrank(previous: previous.sessions.count, got: catalog.sessions.count)
        }
        let schedule = try await backend.loadSchedule()
        return PlanSnapshot(sessions: catalog.sessions, schedule: schedule, fetchedAt: now, skipped: catalog.skipped)
    }
}
