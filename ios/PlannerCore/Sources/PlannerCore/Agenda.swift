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
    /// When his schedule was last read from the conference site.
    public var fetchedAt: Date
    /// Catalog records dropped on the last fetch because they were unusable.
    public var skipped: Int
    /// When the whole catalog was last downloaded; it is downloaded less often than his schedule.
    public var catalogFetchedAt: Date
    /// Sessions on his schedule that the catalog lacked right after it was last downloaded.
    /// They don't make the catalog download early again: downloading didn't find them.
    public var catalogMissing: [String]

    /// `catalogFetchedAt` defaults to `fetchedAt`: both read together.
    public init(sessions: [Session], schedule: Schedule, fetchedAt: Date, skipped: Int = 0, catalogFetchedAt: Date? = nil,
                catalogMissing: [String] = []) {
        self.sessions = sessions
        self.schedule = schedule
        self.fetchedAt = fetchedAt
        self.skipped = skipped
        self.catalogFetchedAt = catalogFetchedAt ?? fetchedAt
        self.catalogMissing = catalogMissing
    }

    private enum CodingKeys: String, CodingKey {
        case sessions, schedule, fetchedAt, skipped, catalogFetchedAt, catalogMissing
    }

    /// A calendar saved before the catalog's own time was kept reads as both fetched together,
    /// so it still opens.
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        sessions = try c.decode([Session].self, forKey: .sessions)
        schedule = try c.decode(Schedule.self, forKey: .schedule)
        fetchedAt = try c.decode(Date.self, forKey: .fetchedAt)
        skipped = try c.decode(Int.self, forKey: .skipped)
        catalogFetchedAt = try c.decodeIfPresent(Date.self, forKey: .catalogFetchedAt) ?? fetchedAt
        // Only a hint for when to download early: a bad entry is dropped, never fatal.
        let rawMissing = (try? c.decodeIfPresent([Lossy<String>].self, forKey: .catalogMissing)) ?? []
        catalogMissing = rawMissing.compactMap { Identifier.clean($0.value) }
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

    /// Every session on the attendee's schedule with how firmly it is there. A reserved seat
    /// outranks an invitation, which outranks a favorite.
    public var commitmentsByID: [String: Commitment] {
        var map: [String: Commitment] = [:]
        for id in schedule.favorites { map[id] = .favorite }
        for session in schedule.invitedSessions { map[session.sessionId] = .invited }
        for id in schedule.reserved { map[id] = .reserved }
        return map
    }

    /// The day to open on: today when the conference is on, otherwise the first day with
    /// something on his schedule, otherwise the first day of the catalog.
    public func defaultDay(today: String) -> String? {
        let all = days()
        if all.contains(today) { return today }
        return days(committedOnly: true).first ?? all.first
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
            // Through the index, so the catalog's copy of an invited session decides its date,
            // as it does everywhere else.
            for session in schedule.invitedSessions { add(known[session.sessionId]) }
        } else {
            for session in known.values { add(session) }
        }
        return dates.sorted()
    }

    /// What is on the calendar for one day: reserved and invited sessions, plus favorites when asked.
    /// `index` and `commitments` take the values of `sessionsByID` and `commitmentsByID` when
    /// the caller already holds them, so a redraw does not rebuild them.
    public func agenda(on date: String, includeFavorites: Bool, index: [String: Session]? = nil,
                       commitments: [String: Commitment]? = nil) -> DayAgenda {
        let known = index ?? sessionsByID
        let chosen = (commitments ?? commitmentsByID).filter { includeFavorites || $0.value != .favorite }

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

    /// A commitment in a different venue from the one he is coming from, with less than
    /// `tightTransferMinutes` between them. "Coming from" is the earlier commitment that ends
    /// last, so an overlapping or venue-less entry in between does not hide the walk. Entries
    /// must be in start order. Sessions without a venue are not judged.
    static func transferWarnings(_ entries: [AgendaEntry]) -> [TransferWarning] {
        var warnings: [TransferWarning] = []
        var comingFrom: AgendaEntry?
        for entry in entries {
            guard let to = entry.session.venue else { continue }
            if let previous = comingFrom, let from = previous.session.venue, from != to {
                let gap = entry.start - previous.end
                if gap < tightTransferMinutes {
                    warnings.append(TransferWarning(fromID: previous.id, toID: entry.id, fromVenue: from, toVenue: to,
                                                    gapMinutes: gap))
                }
            }
            if comingFrom.map({ entry.end >= $0.end }) ?? true { comingFrom = entry }
        }
        return warnings
    }
}

/// What came of one change on the conference site.
public struct ChangeOutcome: Sendable {
    /// The schedule as read back afterwards; nil when it could not be read.
    public var schedule: Schedule?
    /// Why the conference site refused the change, when it did.
    public var refusal: BulkFailure?
    /// What went wrong: sending the change if that failed, otherwise reading the schedule back.
    public var problem: Error?
    /// What went wrong reading the schedule back, even when the change itself also failed.
    /// A rejected sign-in shows up here, so the caller can ask for sign-in either way.
    public var readBackProblem: Error?
}

public enum Sync {
    /// Sends one change, then reads the schedule back: the conference site's answer is what is
    /// shown, never a guess. The change is sent once. When its answer never arrives, the
    /// schedule is still read, and the change is not sent again.
    public static func change(backend: PlanBackend, sessionID: String,
                              _ action: @Sendable (PlanBackend) async throws -> BulkResult) async -> ChangeOutcome {
        var outcome = ChangeOutcome()
        do {
            let result = try await action(backend)
            // Only a refusal of this session counts; another session's is not this one's answer.
            outcome.refusal = result.failed.first { $0.sessionId == sessionID }
            // The site is meant to answer for every session. One it says nothing about is
            // neither done nor refused, and must not pass for done.
            if outcome.refusal == nil, !result.successful.contains(sessionID) {
                outcome.problem = APIError.unconfirmed
            }
        } catch {
            outcome.problem = error
        }
        do {
            outcome.schedule = try await backend.loadSchedule()
        } catch {
            outcome.readBackProblem = error
            if outcome.problem == nil { outcome.problem = error }
        }
        return outcome
    }

    /// Fetches the catalog and the schedule and builds a snapshot. Throws, leaving `previous`
    /// in place, when either fetch fails or the new catalog is under half the size of the one held.
    public static func refresh(backend: PlanBackend, previous: PlanSnapshot?, now: Date) async throws -> PlanSnapshot {
        let catalog = try await loadCatalog(backend, previous: previous)
        let schedule = try await backend.loadSchedule()
        var snapshot = PlanSnapshot(sessions: catalog.sessions, schedule: schedule, fetchedAt: now, skipped: catalog.skipped)
        snapshot.catalogMissing = snapshot.unresolvedIDs
        return snapshot
    }

    /// What an update brought back.
    public struct UpdateResult: Sendable {
        public var snapshot: PlanSnapshot
        /// Why the catalog couldn't be downloaded, when it was tried and failed; his schedule
        /// was still read, and the catalog held is kept.
        public var catalogProblem: Error?
        /// Whether the catalog was tried, so the caller can wait before trying it again.
        public var triedCatalog: Bool
    }

    /// Reads his schedule, and downloads the whole catalog too when `wholeCatalog` asks for it,
    /// when nothing is held, when `RefreshPlan.catalogDue`, or when his schedule names a session
    /// the catalog lacks that downloading hasn't already failed to find
    /// (`RefreshPlan.catalogWantedFor`). The schedule is always read last, so it is the newest
    /// answer. Throws, leaving `previous` in place, when the schedule can't be read, or when
    /// nothing is held and the catalog can't be downloaded. If reading the schedule again after
    /// an early download fails, the first read is kept with the new catalog.
    public static func update(backend: PlanBackend, previous: PlanSnapshot?, now: Date, wholeCatalog: Bool = false,
                              catalogLastTried: Date?) async throws -> UpdateResult {
        guard let previous else {
            return UpdateResult(snapshot: try await refresh(backend: backend, previous: nil, now: now),
                                catalogProblem: nil, triedCatalog: true)
        }
        var updated = previous
        var problem: Error?
        var tried = false
        /// Downloads the catalog into `updated`, or notes why it couldn't.
        func download() async throws {
            tried = true
            do {
                let catalog = try await loadCatalog(backend, previous: previous)
                updated.sessions = catalog.sessions
                updated.skipped = catalog.skipped
                updated.catalogFetchedAt = now
            } catch is CancellationError {
                throw CancellationError()
            } catch {
                problem = error
            }
        }
        if triesCatalogFirst(previous: previous, wholeCatalog: wholeCatalog, catalogLastTried: catalogLastTried, now: now) {
            try await download()
        }
        updated.schedule = try await backend.loadSchedule()
        updated.fetchedAt = now
        if !tried, RefreshPlan.catalogWantedFor(updated, lastAttempt: catalogLastTried, now: now) {
            try await download()
            // Read again, so the schedule is still the newest answer; if that fails, the first
            // read (moments old) stands.
            if problem == nil {
                do {
                    updated.schedule = try await backend.loadSchedule()
                } catch is CancellationError {
                    throw CancellationError()
                } catch {}
            }
        }
        if tried, problem == nil { updated.catalogMissing = updated.unresolvedIDs }
        return UpdateResult(snapshot: updated, catalogProblem: problem, triedCatalog: tried)
    }

    /// Whether `update` will try the whole catalog before reading his schedule. Known before it
    /// runs, so the caller can record the attempt even if the update then fails.
    public static func triesCatalogFirst(previous: PlanSnapshot?, wholeCatalog: Bool, catalogLastTried: Date?,
                                         now: Date) -> Bool {
        previous == nil || wholeCatalog || RefreshPlan.catalogDue(previous, lastAttempt: catalogLastTried, now: now)
    }

    /// What to show when an update lands. If a reserve, favorite or cancel read his schedule
    /// back while the update ran (`changedDuring`), that schedule and its time are kept: it was
    /// read after his own change, which the update's read may have missed, and the next read
    /// brings in anything newer. The update's catalog is shown either way.
    public static func landed(_ update: PlanSnapshot, current: PlanSnapshot?, changedDuring: Bool) -> PlanSnapshot {
        guard changedDuring, let current else { return update }
        var shown = update
        shown.schedule = current.schedule
        shown.fetchedAt = current.fetchedAt
        return shown
    }

    /// The catalog, refused when it is under half the size of the one held.
    private static func loadCatalog(_ backend: PlanBackend, previous: PlanSnapshot?) async throws -> Catalog {
        let catalog = try await backend.loadCatalog()
        if let previous, catalog.sessions.count * 2 < previous.sessions.count {
            throw APIError.catalogShrank(previous: previous.sessions.count, got: catalog.sessions.count)
        }
        return catalog
    }
}
