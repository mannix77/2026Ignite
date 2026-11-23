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

    private struct Saved: Codable {
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
            // First time, or he deleted the calendar: its events went with it, so the old
            // records mean nothing and a fresh calendar starts from none.
            calendar = try makeCalendar(named: calendarName)
            saved = Saved(calendarID: calendar.calendarIdentifier, records: [:])
            do {
                try write(saved)
            } catch {
                // Without its record the next run would make yet another calendar: take this
                // one back and stop.
                try? store.removeCalendar(calendar, commit: true)
                throw Failure.unwritableRecords
            }
        }

        let plan = CalendarExport.plan(for: snapshot, records: saved.records, timeZone: timeZone,
                                       eventName: calendarName)
        guard !plan.isEmpty else { return saved.records.count }

        // Progress is recorded even if a step fails part way, so the next run doesn't add twice.
        // If the record itself can't be saved, that is reported above any other failure: the
        // caller must stop writing until it can be, or every event made here would be added again.
        var failure: Error?
        do {
            for draft in plan.add {
                saved.records[draft.sessionID] = ExportRecord(eventID: try save(draft, into: nil, calendar: calendar,
                                                                                timeZone: timeZone), draft: draft)
            }
            for change in plan.update {
                // An event the app made is found again wherever he moved it, and updated there;
                // only one that is gone altogether is made again.
                let event = saved.records[change.draft.sessionID].flatMap { find($0, in: calendar) }
                saved.records[change.draft.sessionID] = ExportRecord(
                    eventID: try save(change.draft, into: event, calendar: calendar, timeZone: timeZone), draft: change.draft)
            }
            for eventID in plan.remove {
                guard let (sessionID, record) = saved.records.first(where: { $0.value.eventID == eventID }) else { continue }
                if let event = find(record, in: calendar) { try store.remove(event, span: .thisEvent, commit: true) }
                saved.records[sessionID] = nil
            }
        } catch {
            failure = error
        }
        do { try write(saved) } catch { throw Failure.unwritableRecords }
        if let failure { throw failure }
        return saved.records.count
    }

    /// The event the app made for a record. Its identifier is tried first; since a calendar
    /// sync can change that, the app's calendar is then searched around the event's time for
    /// the session key the app wrote into it. No other event can carry that key.
    private func find(_ record: ExportRecord, in calendar: EKCalendar) -> EKEvent? {
        if let event = store.event(withIdentifier: record.eventID) { return event }
        let key = CalendarExporter.key(for: record.draft.sessionID)
        let day: TimeInterval = 24 * 60 * 60
        let around = store.predicateForEvents(withStart: record.draft.start.addingTimeInterval(-day),
                                              end: record.draft.end.addingTimeInterval(day), calendars: [calendar])
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
    /// The next time it is turned on, a new calendar is started.
    func forget() {
        try? FileManager.default.removeItem(at: CalendarExporter.url)
    }

    /// The record, or none if it was never written. One that is there but can't be read (locked,
    /// damaged) is not taken as none: starting over would make a second copy of every event.
    private func load() throws -> Saved {
        let url = CalendarExporter.url
        guard FileManager.default.fileExists(atPath: url.path) else { return Saved(calendarID: nil, records: [:]) }
        guard let data = try? Data(contentsOf: url), let saved = try? JSONDecoder().decode(Saved.self, from: data) else { throw Failure.unreadableRecords }
        return saved
    }

    private func write(_ saved: Saved) throws {
        let url = CalendarExporter.url
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try JSONEncoder().encode(saved).write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }
}
