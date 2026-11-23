import Foundation

public struct CalendarEventDraft: Codable, Equatable, Sendable {
    public var sessionID: String
    public var title: String
    public var start: Date
    public var end: Date
    public var location: String?
    public var notes: String
}

public struct ExportRecord: Codable, Equatable, Sendable {
    public var eventID: String
    public var draft: CalendarEventDraft
    public init(eventID: String, draft: CalendarEventDraft) { self.eventID = eventID; self.draft = draft }
}

public struct ExportUpdate: Equatable, Sendable {
    public var eventID: String
    public var draft: CalendarEventDraft
}

public struct ExportPlan: Equatable, Sendable {
    public var add: [CalendarEventDraft]
    public var update: [ExportUpdate]
    public var remove: [String]
    public var skipped: Int
    public var isEmpty: Bool { add.isEmpty && update.isEmpty && remove.isEmpty }
}

/// The records from the app's saved file that can be trusted, and how many could not.
public struct UsableRecords: Equatable, Sendable {
    public var records: [String: ExportRecord]
    public var skipped: Int
    /// More than half the records were unusable: the file is not to be acted on at all.
    public var isMostlyJunk: Bool
}

public enum CalendarExport {
    /// Checks the records read back from the app's own file before any is acted on. A record
    /// is used only if its session id is usable and matches its draft's, and its event id is
    /// usable and claimed by no other record; the rest are skipped and counted.
    public static func usableRecords(_ saved: [String: ExportRecord]) -> UsableRecords {
        var claims: [String: Int] = [:]
        for record in saved.values {
            if let event = Identifier.clean(record.eventID) { claims[event, default: 0] += 1 }
        }
        var kept: [String: ExportRecord] = [:]
        for (key, record) in saved {
            guard let id = Identifier.clean(key), id == Identifier.clean(record.draft.sessionID),
                  let event = Identifier.clean(record.eventID), claims[event] == 1 else { continue }
            kept[id] = ExportRecord(eventID: event, draft: record.draft)
        }
        let skipped = saved.count - kept.count
        return UsableRecords(records: kept, skipped: skipped, isMostlyJunk: skipped * 2 > saved.count)
    }

    /// The Calendar event for one session: "CODE – Title", from its start to its end in the
    /// conference's time zone, at "Venue, Room", with "<event> session CODE" in the notes. A
    /// session with no length gets the minutes the
    /// app's own calendar draws for it. Nil for a session with no readable time, or one that
    /// lasts all day.
    public static func draft(for session: Session, timeZone: TimeZone, eventName: String) -> CalendarEventDraft? {
        guard session.isAllDaySession != true, let time = session.sessionTime, time.hasValidDate,
              let startMinute = time.startMinute else { return nil }
        let parts = time.date.split(separator: "-").compactMap { Int($0) }
        guard parts.count == 3 else { return nil }
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        guard let start = calendar.date(from: DateComponents(year: parts[0], month: parts[1], day: parts[2],
                                                              hour: startMinute / 60, minute: startMinute % 60)),
              // A day that doesn't exist ("2026-02-31") must not roll over into another.
              calendar.component(.day, from: start) == parts[2] else { return nil }
        let minutes = max(time.lengthMinutes, AgendaEntry.minimumDrawnMinutes)
        let place = [session.venue, session.room].compactMap { Identifier.clean($0) }
        return CalendarEventDraft(sessionID: session.sessionId, title: "\(session.code) – \(session.title)",
                                  start: start, end: start.addingTimeInterval(TimeInterval(minutes * 60)),
                                  location: place.isEmpty ? nil : place.joined(separator: ", "),
                                  notes: "\(eventName) session \(session.code)")
    }
    /// What to change in the app's own Calendar events so they match his reserved sessions.
    /// `records` are the events the app made before, by session id; nothing else is touched.
    /// Only reserved seats are exported: favorites, invitations and personal time stay out.
    /// A reserved session that can't be drafted (no readable time, or gone from the catalog) is
    /// counted in `skipped` and its event, if any, is left as it was: an unreadable answer is
    /// never a reason to delete.
    public static func plan(for snapshot: PlanSnapshot, records: [String: ExportRecord],
                            timeZone: TimeZone, eventName: String) -> ExportPlan {
        let catalog = snapshot.sessionsByID
        var result = ExportPlan(add: [], update: [], remove: [], skipped: 0)
        var stillReserved = Set<String>()
        for raw in snapshot.schedule.reserved {
            guard let id = Identifier.clean(raw), stillReserved.insert(id).inserted else { continue }
            guard let session = catalog[id], let draft = draft(for: session, timeZone: timeZone, eventName: eventName) else {
                result.skipped += 1
                continue
            }
            if let record = records[id] {
                if record.draft != draft { result.update.append(ExportUpdate(eventID: record.eventID, draft: draft)) }
            } else {
                result.add.append(draft)
            }
        }
        result.remove = records.filter { !stillReserved.contains($0.key) }.map(\.value.eventID).sorted()
        return result
    }
}

extension Wording {
    /// What the Calendar setting says after an update.
    public static func calendarExport(count: Int, calendar: String) -> String {
        switch count {
        case 0: return "No reserved sessions to add to “\(calendar)”."
        case 1: return "1 reserved session is in your “\(calendar)” calendar."
        default: return "\(count) reserved sessions are in your “\(calendar)” calendar."
        }
    }
}
