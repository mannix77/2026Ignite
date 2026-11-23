import EventKit
import Foundation
import PlannerCore

/// Writes his reserved sessions into a calendar of the app's own, on the phone. What to add,
/// change and remove is decided by `CalendarExport` in PlannerCore; this only talks to EventKit
/// and keeps the record of which events the app made, so it never touches any other event.
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
            try write(saved)
        }

        let plan = CalendarExport.plan(for: snapshot, records: saved.records, timeZone: timeZone)
        // Progress is recorded even if a later step fails, so the next run doesn't add twice.
        defer { try? write(saved) }

        for draft in plan.add {
            saved.records[draft.sessionID] = ExportRecord(eventID: try save(draft, into: nil, calendar: calendar, timeZone: timeZone),
                                                          draft: draft)
        }
        for change in plan.update {
            let event = ownEvent(change.eventID, in: calendar)
            saved.records[change.draft.sessionID] = ExportRecord(
                eventID: try save(change.draft, into: event, calendar: calendar, timeZone: timeZone), draft: change.draft)
        }
        for eventID in plan.remove {
            if let event = ownEvent(eventID, in: calendar) { try store.remove(event, span: .thisEvent, commit: true) }
            saved.records = saved.records.filter { $0.value.eventID != eventID }
        }
        return saved.records.count
    }

    /// The event the app made, if it is still in the app's calendar. One he moved to another
    /// calendar is his now and is left alone.
    private func ownEvent(_ id: String, in calendar: EKCalendar) -> EKEvent? {
        guard let event = store.event(withIdentifier: id),
              event.calendar?.calendarIdentifier == calendar.calendarIdentifier else { return nil }
        return event
    }

    private func save(_ draft: CalendarEventDraft, into existing: EKEvent?, calendar: EKCalendar,
                      timeZone: TimeZone) throws -> String {
        let event = existing ?? EKEvent(eventStore: store)
        event.calendar = calendar
        event.title = draft.title
        event.startDate = draft.start
        event.endDate = draft.end
        event.timeZone = timeZone
        event.location = draft.location
        event.notes = draft.notes
        try store.save(event, span: .thisEvent, commit: true)
        return event.eventIdentifier
    }

    private func makeCalendar(named name: String) throws -> EKCalendar {
        let calendar = EKCalendar(for: .event, eventStore: store)
        calendar.title = name
        guard let source = store.defaultCalendarForNewEvents?.source
                ?? store.sources.first(where: { $0.sourceType == .local }) else { throw Failure.noCalendarSource }
        calendar.source = source
        try store.saveCalendar(calendar, commit: true)
        return calendar
    }

    private func load() throws -> Saved {
        guard let data = try? Data(contentsOf: CalendarExporter.url) else { return Saved(calendarID: nil, records: [:]) }
        guard let saved = try? JSONDecoder().decode(Saved.self, from: data) else { throw Failure.unreadableRecords }
        return saved
    }

    private func write(_ saved: Saved) throws {
        let url = CalendarExporter.url
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try JSONEncoder().encode(saved).write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }
}
