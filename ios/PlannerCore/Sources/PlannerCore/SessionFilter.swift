import Foundation

/// Which sessions the session list shows.
public enum SessionFilter: String, CaseIterable, Identifiable, Sendable {
    case all = "All"
    case mine = "Mine"
    case open = "Seats open"

    public var id: String { rawValue }
}

extension PlanSnapshot {
    /// Seat bands that mean a seat can still be reserved.
    static let openSeatBands: Set<String> = ["available", "limited", "veryLimited"]

    /// The sessions for the list: filtered, searched (code, title, speaker or topic, ignoring
    /// case) and in day, time, code order with unscheduled sessions last. `commitments` takes
    /// the value of `commitmentsByID` when the caller already holds it.
    public func sessions(matching filter: SessionFilter, search: String = "",
                         commitments: [String: Commitment]? = nil) -> [Session] {
        let pool: [Session]
        let marks = commitments ?? commitmentsByID
        switch filter {
        case .all:
            pool = sessions
        case .mine:
            var seen = Set<String>()
            // The catalog comes first, so its copy of an invited session wins.
            pool = (sessions + schedule.invitedSessions).filter {
                marks[$0.sessionId] != nil && seen.insert($0.sessionId).inserted
            }
        case .open:
            // A seat he already holds is not one he can still reserve, and an invitation is
            // not reserved through the app.
            pool = sessions.filter {
                $0.isReservable == true && PlanSnapshot.openSeatBands.contains($0.seatAvailability ?? "")
                    && marks[$0.sessionId] != .reserved && marks[$0.sessionId] != .invited
            }
        }
        let needle = search.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let found = needle.isEmpty ? pool : pool.filter { session in
            ([session.title, session.code] + session.speakerNames + (session.topics ?? []))
                .contains { $0.lowercased().contains(needle) }
        }
        return found.sorted { PlanSnapshot.listOrder($0) < PlanSnapshot.listOrder($1) }
    }

    /// Day, start time, code, then id. A session with no date sorts after every dated one.
    static func listOrder(_ session: Session) -> (String, Int, String, String) {
        (session.sessionTime?.date ?? "9999", session.sessionTime?.startMinute ?? 0, session.code, session.sessionId)
    }
}
