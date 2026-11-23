import EventKit
import Foundation
import PlannerCore

/// Writes his reserved sessions into a calendar of the app's own, on the phone. What to add,
/// change and remove is decided by `CalendarExport` in PlannerCore; this only talks to EventKit
/// and keeps the record of which events the app made, so it never touches any other event. An
/// event it made stays its to update or remove even if he moves it to another calendar.
///
/// Full access is asked for, not write-only: keeping the events matching means finding the
/// app's own events again by identifier to move or remove them, which write-only access can't.
@MainActor
final class CalendarExporter {
    enum Failure: Error {
        case denied
        /// The record of which events the app made can't be read. Writing anyway could add a
        /// second copy of every event, so nothing is written.
        case unreadableRecords
        /// The record of the events just written couldn't be saved. Writing again before it
        /// can be would add every one of them a second time.
        case unwritableRecords
        case noCalendarSource
    }

    private let store = EKEventStore()

    private struct Saved: Encodable {
        var calendarID: String?
        var records: [String: ExportRecord]
    }

    private static var url: URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("calendar-export.json")
    }

    static var hasAccess: Bool { EKEventStore.authorizationStatus(for: .event) == .fullAccess }

    func requestAccess() async -> Bool {
        (try? await store.requestFullAccessToEvents()) ?? false
    }

    /// Brings the app's calendar up to date with the reserved sessions in `snapshot`. Returns
    /// how many reserved sessions are now in it.
    func sync(_ snapshot: PlanSnapshot, calendarName: String, timeZone: TimeZone) throws -> Int {
        guard CalendarExporter.hasAccess else { throw Failure.denied }
        var saved = try load()
        let calendar: EKCalendar
        if let id = saved.calendarID, let existing = store.calendar(withIdentifier: id) {
            calendar = existing
        } else {
            // First time, or he deleted the calendar. Its events went with it, except any he had
            // moved to another calendar: those records are kept, the rest start afresh.
            calendar = try makeCalendar(named: calendarName)
            saved = Saved(calendarID: calendar.calendarIdentifier,
                          records: saved.records.filter { find($0.value) != nil })
            do {
                try write(saved)
            } catch {
                // Without its record the next run would make yet another calendar: take this
                // one back and stop.
                try? store.removeCalendar(calendar, commit: true)
                throw Failure.unwritableRecords
            }
        }

        // An event he deleted while its session is still reserved is made again: its record
        // is dropped, so the plan adds it.
        let present = saved.records.filter { find($0.value) != nil }
        if present.count != saved.records.count {
            saved.records = present
            try writeOrStop(saved)
        }

        let plan = CalendarExport.plan(for: snapshot, records: saved.records, timeZone: timeZone,
                                       eventName: calendarName)
        // The record is saved after every event written, so whatever happens next (a failed
        // step, the app quitting) it matches what is in Calendar and nothing is added twice.
        for draft in plan.add {
            // An event already in this export's calendar for this session (its record lost) is
            // reused. Only this calendar: an earlier attendee's calendar is never adopted. It is
            // searched a year either side, since the session may have moved since the event was
            // made; the calendar holds only the app's few events, so this stays cheap.
            let existing = findByKey(sessionID: draft.sessionID, around: draft, in: [calendar], within: 365)
            saved.records[draft.sessionID] = ExportRecord(
                eventID: try save(draft, into: existing, calendar: calendar, timeZone: timeZone), draft: draft)
            try writeOrStop(saved)
        }
        for change in plan.update {
            // Found again wherever he moved it, and updated there; made again only if gone.
            let event = saved.records[change.draft.sessionID].flatMap { find($0) }
            saved.records[change.draft.sessionID] = ExportRecord(
                eventID: try save(change.draft, into: event, calendar: calendar, timeZone: timeZone), draft: change.draft)
            try writeOrStop(saved)
        }
        for eventID in plan.remove {
            guard let (sessionID, record) = saved.records.first(where: { $0.value.eventID == eventID }) else { continue }
            if let event = find(record) { try store.remove(event, span: .thisEvent, commit: true) }
            saved.records[sessionID] = nil
            try writeOrStop(saved)
        }
        return saved.records.count
    }

    /// Saves the record, or stops everything: writing on without it would add events twice.
    private func writeOrStop(_ saved: Saved) throws {
        do { try write(saved) } catch { throw Failure.unwritableRecords }
    }

    /// The event the app made for a record this export owns. Its identifier is tried first,
    /// and the event must carry the record's session key: an identifier alone never proves the
    /// app made it. Since a calendar sync or a move between calendars can change the
    /// identifier, every calendar is then searched around the event's time for that key.
    private func find(_ record: ExportRecord) -> EKEvent? {
        guard let key = CalendarExporter.key(for: record.draft.sessionID) else { return nil }
        if let event = store.event(withIdentifier: record.eventID), event.url == key { return event }
        return findByKey(sessionID: record.draft.sessionID, around: record.draft, in: nil, within: 1)
    }

    /// An event carrying the app's key for `sessionID`, within `days` either side of `draft`, in
    /// `calendars` (nil for all). Other events in that window are looked at only to compare
    /// their key; none is changed.
    private func findByKey(sessionID: String, around draft: CalendarEventDraft, in calendars: [EKCalendar]?,
                           within days: Double) -> EKEvent? {
        guard let key = CalendarExporter.key(for: sessionID) else { return nil }
        let span = days * 24 * 60 * 60
        let around = store.predicateForEvents(withStart: draft.start.addingTimeInterval(-span),
                                              end: draft.end.addingTimeInterval(span), calendars: calendars)
        return store.events(matching: around).first { $0.url == key }
    }

    /// The key written into each event the app makes, naming its session.
    private static func key(for sessionID: String) -> URL? {
        var parts = URLComponents()
        parts.scheme = "sessionplanner"
        parts.host = "session"
        parts.path = "/" + sessionID
        return parts.url
    }

    private func save(_ draft: CalendarEventDraft, into existing: EKEvent?, calendar: EKCalendar,
                      timeZone: TimeZone) throws -> String {
        let event = existing ?? EKEvent(eventStore: store)
        // A new event goes in the app's calendar; one he moved stays where he put it.
        if existing == nil { event.calendar = calendar }
        event.title = draft.title
        event.startDate = draft.start
        event.endDate = draft.end
        event.timeZone = timeZone
        event.location = draft.location
        event.notes = draft.notes
        event.url = CalendarExporter.key(for: draft.sessionID)
        try store.save(event, span: .thisEvent, commit: true)
        return event.eventIdentifier
    }

    /// A new calendar in the account new events go to; if that account won't take one (some
    /// Exchange and CalDAV accounts), in iCloud, then on the phone alone.
    private func makeCalendar(named name: String) throws -> EKCalendar {
        var candidates: [EKSource] = []
        for source in [store.defaultCalendarForNewEvents?.source]
            + store.sources.filter({ $0.sourceType == .calDAV && $0.title == "iCloud" })
            + store.sources.filter({ $0.sourceType == .local }) {
            if let source, !candidates.contains(where: { $0.sourceIdentifier == source.sourceIdentifier }) {
                candidates.append(source)
            }
        }
        var lastError: Error = Failure.noCalendarSource
        for source in candidates {
            let calendar = EKCalendar(for: .event, eventStore: store)
            calendar.title = name
            calendar.source = source
            do {
                try store.saveCalendar(calendar, commit: true)
                return calendar
            } catch {
                lastError = error
            }
        }
        throw lastError
    }

    /// Forgets the app's calendar and its record of events, leaving both in the Calendar app.
    /// The next time it is turned on, a new calendar is started. If the file can't be removed it
    /// is overwritten with a record of nothing (no calendar, no events), which starts afresh the
    /// same way; false when neither worked and the old record could still be used.
    @discardableResult
    func forget() -> Bool {
        let url = CalendarExporter.url
        guard FileManager.default.fileExists(atPath: url.path) else { return true }
        if (try? FileManager.default.removeItem(at: url)) != nil { return true }
        return (try? write(Saved(calendarID: nil, records: [:]))) != nil
    }

    /// The record, or none if it was never written. One that is there but can't be read (locked,
    /// damaged) is not taken as none: starting over would make a second copy of every event.
    private func load() throws -> Saved {
        let url = CalendarExporter.url
        guard FileManager.default.fileExists(atPath: url.path) else { return Saved(calendarID: nil, records: [:]) }
        // Read back like any other untrusted input: a bad or malformed record is skipped, and a
        // file that is mostly bad, or not such a file at all, is not acted on.
        guard let data = try? Data(contentsOf: url), let read = CalendarExport.readFile(data),
              !read.checked.isMostlyJunk else { throw Failure.unreadableRecords }
        return Saved(calendarID: read.calendarID, records: read.checked.records)
    }

    /// True when a record file is there but can't be used.
    var hasUnreadableRecord: Bool {
        guard FileManager.default.fileExists(atPath: CalendarExporter.url.path) else { return false }
        do { _ = try load(); return false } catch { return true }
    }

    private func write(_ saved: Saved) throws {
        let url = CalendarExporter.url
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try JSONEncoder().encode(saved).write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }
}
