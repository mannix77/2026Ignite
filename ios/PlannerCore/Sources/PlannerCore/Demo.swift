import Foundation

/// A made-up conference held entirely in memory, so the app can be tried without a
/// conference sign-in. Nothing here is sent anywhere.
public actor DemoBackend: PlanBackend {
    private let catalog: [Session]
    private var schedule: Schedule

    public init() {
        catalog = DemoBackend.sessions
        schedule = Schedule(
            reserved: ["demo-103", "demo-201", "demo-204"],
            favorites: ["demo-101", "demo-104", "demo-105", "demo-202", "demo-301"],
            invitedSessions: [
                Session(sessionId: "demo-900", title: "Welcome reception", abbreviation: "RECEPTION",
                        type: "Reception", room: "Harbor Terrace",
                        sessionTime: SessionTime(date: "2027-03-09", time: "18:00", length: "120")),
            ]
        )
    }

    public func loadCatalog() -> Catalog { Catalog(sessions: catalog) }

    public func loadSchedule() -> Schedule { schedule }

    public func reserve(_ sessionIds: [String]) -> BulkResult {
        var result = BulkResult()
        for id in sessionIds {
            guard let session = catalog.first(where: { $0.sessionId == id }), session.isReservable == true else {
                result.failed.append(BulkFailure(sessionId: id, code: "sessionNotReservable"))
                continue
            }
            if schedule.reserved.contains(id) {
                result.failed.append(BulkFailure(sessionId: id, code: "alreadyScheduled"))
                continue
            }
            if session.seatAvailability == "unavailable" {
                result.failed.append(BulkFailure(sessionId: id, code: "sessionFull"))
                continue
            }
            let clashes = schedule.reserved.filter { other in
                guard let held = catalog.first(where: { $0.sessionId == other }) else { return false }
                return DemoBackend.overlap(session, held)
            }
            if !clashes.isEmpty {
                result.failed.append(BulkFailure(sessionId: id, code: "scheduleConflict", conflictsWith: clashes))
                continue
            }
            schedule.reserved.append(id)
            result.successful.append(id)
        }
        return result
    }

    public func cancelReservation(_ sessionId: String) {
        schedule.reserved.removeAll { $0 == sessionId }
    }

    public func favorite(_ sessionIds: [String]) -> BulkResult {
        var result = BulkResult()
        for id in sessionIds {
            if schedule.favorites.contains(id) {
                result.failed.append(BulkFailure(sessionId: id, code: "alreadyFavorited"))
            } else if catalog.contains(where: { $0.sessionId == id }) {
                schedule.favorites.append(id)
                result.successful.append(id)
            } else {
                result.failed.append(BulkFailure(sessionId: id, code: "other"))
            }
        }
        return result
    }

    public func unfavorite(_ sessionId: String) {
        schedule.favorites.removeAll { $0 == sessionId }
    }

    static func overlap(_ a: Session, _ b: Session) -> Bool {
        guard let ta = a.sessionTime, let tb = b.sessionTime, ta.date == tb.date,
              let sa = ta.startMinute, let sb = tb.startMinute else { return false }
        return sa < sb + tb.lengthMinutes && sb < sa + ta.lengthMinutes
    }

    private static func make(_ id: String, _ code: String, _ title: String, _ type: String, _ level: String,
                             _ venue: String, _ room: String, _ date: String, _ time: String, _ length: String,
                             seats: String?, topics: [String], speakers: [String]) -> Session {
        Session(sessionId: id, title: title, abbreviation: code,
                abstract: "A sample session for trying the app. \(title) is not a real session.",
                type: type, level: level, venue: venue, room: room, isAllDaySession: false,
                isReservable: seats != nil, seatAvailability: seats,
                sessionTime: SessionTime(date: date, time: time, length: length),
                speakers: speakers.map { Speaker(name: $0) }, topics: topics)
    }

    static let sessions: [Session] = [
        make("demo-101", "KEY101", "Opening keynote", "Keynote", "100 – Foundational", "North Hall", "Main Stage",
             "2027-03-09", "09:00", "90", seats: nil, topics: ["Strategy"], speakers: ["Avery Stone"]),
        make("demo-102", "OPS210", "Runbooks that people actually follow", "Breakout", "200 – Intermediate",
             "North Hall", "Room 204", "2027-03-09", "11:00", "60", seats: nil, topics: ["Operations"],
             speakers: ["Jordan Reyes"]),
        make("demo-103", "DAT310", "Hands-on: modelling time series", "Workshop", "300 – Advanced", "South Pavilion",
             "Lab 3", "2027-03-09", "11:00", "120", seats: "limited", topics: ["Data"], speakers: ["Priya Nair", "Sam Okafor"]),
        make("demo-104", "SEC220", "Threat modelling in an afternoon", "Chalk talk", "200 – Intermediate",
             "South Pavilion", "Room 12", "2027-03-09", "13:30", "60", seats: "available", topics: ["Security"],
             speakers: ["Morgan Li"]),
        make("demo-105", "ARC330", "Designing for regional failure", "Breakout", "300 – Advanced", "North Hall",
             "Room 110", "2027-03-09", "13:30", "60", seats: nil, topics: ["Architecture"], speakers: ["Dana Whitfield"]),
        make("demo-106", "DEV240", "Faster feedback loops", "Lightning talk", "200 – Intermediate", "North Hall",
             "Expo Theater", "2027-03-09", "15:00", "20", seats: nil, topics: ["Developer Tools"], speakers: ["Chris Tanaka"]),
        make("demo-107", "AIM350", "Evaluating assistants before launch", "Workshop", "300 – Advanced",
             "South Pavilion", "Lab 1", "2027-03-09", "15:30", "120", seats: "unavailable", topics: ["AI"],
             speakers: ["Noor Haddad"]),
        make("demo-201", "AIM410", "Hands-on: agents with guardrails", "Workshop", "400 – Expert", "South Pavilion",
             "Lab 2", "2027-03-10", "08:30", "120", seats: "veryLimited", topics: ["AI"], speakers: ["Elena Marsh"]),
        make("demo-202", "OBS320", "Tracing a request end to end", "Breakout", "300 – Advanced", "North Hall",
             "Room 204", "2027-03-10", "10:00", "60", seats: nil, topics: ["Observability"], speakers: ["Tomás Vega"]),
        make("demo-203", "COP230", "Cost reviews that stick", "Chalk talk", "200 – Intermediate", "North Hall",
             "Room 118", "2027-03-10", "11:30", "60", seats: "available", topics: ["Operations"], speakers: ["Ife Adeyemi"]),
        make("demo-204", "SEC340", "Incident response game day", "Workshop", "300 – Advanced", "North Hall",
             "Room 301", "2027-03-10", "10:30", "120", seats: "limited", topics: ["Security"], speakers: ["Kai Brennan"]),
        make("demo-205", "DAT250", "Choosing a database on purpose", "Breakout", "200 – Intermediate",
             "South Pavilion", "Room 12", "2027-03-10", "14:00", "60", seats: nil, topics: ["Data"], speakers: ["Lena Fischer"]),
        make("demo-206", "ARC420", "Hands-on: multi-region drills", "Workshop", "400 – Expert", "South Pavilion",
             "Lab 3", "2027-03-10", "09:00", "120", seats: "available", topics: ["Architecture"], speakers: ["Ravi Menon"]),
        make("demo-301", "KEY301", "Closing keynote", "Keynote", "100 – Foundational", "North Hall", "Main Stage",
             "2027-03-11", "09:00", "90", seats: nil, topics: ["Strategy"], speakers: ["Avery Stone"]),
        make("demo-302", "DEV360", "Hands-on: test data you can trust", "Workshop", "300 – Advanced",
             "South Pavilion", "Lab 1", "2027-03-11", "11:00", "120", seats: "available", topics: ["Developer Tools"],
             speakers: ["Mina Castillo"]),
        make("demo-303", "OPS270", "On-call without burnout", "Breakout", "200 – Intermediate", "North Hall",
             "Room 110", "2027-03-11", "13:30", "60", seats: nil, topics: ["Operations"], speakers: ["Bo Lindqvist"]),
    ]
}
