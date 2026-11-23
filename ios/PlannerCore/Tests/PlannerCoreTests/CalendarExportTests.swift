import XCTest
@testable import PlannerCore

// Las Vegas is on Pacific Standard Time (UTC-8) in December, so 10:00 there is 18:00 UTC.
// Each instant below is UTC seconds since 1970, worked out with Python's datetime, not here.
private let dec2At1800Z = Date(timeIntervalSince1970: 1_796_234_400) // 2026-12-02 18:00 UTC
private let dec2At1820Z = Date(timeIntervalSince1970: 1_796_235_600) // 2026-12-02 18:20 UTC
private let dec2At1900Z = Date(timeIntervalSince1970: 1_796_238_000) // 2026-12-02 19:00 UTC
private let dec2At2100Z = Date(timeIntervalSince1970: 1_796_245_200) // 2026-12-02 21:00 UTC
private let dec2At2200Z = Date(timeIntervalSince1970: 1_796_248_800) // 2026-12-02 22:00 UTC
private let dec3At1730Z = Date(timeIntervalSince1970: 1_796_319_000) // 2026-12-03 17:30 UTC
private let dec3At1830Z = Date(timeIntervalSince1970: 1_796_322_600) // 2026-12-03 18:30 UTC

private let vegas = TimeZone(identifier: "America/Los_Angeles")!

private func held(_ id: String, code: String, title: String = "Agents at scale", date: String = "2026-12-02",
                  time: String = "10:00", length: String = "60", venue: String? = "Venetian",
                  room: String? = "Level 3, Murano 3201", allDay: Bool = false) -> Session {
    Session(sessionId: id, title: title, abbreviation: code, venue: venue, room: room, isAllDaySession: allDay,
            sessionTime: SessionTime(date: date, time: time, length: length))
}

private func plan(_ sessions: [Session], reserved: [String], favorites: [String] = [],
                  invited: [Session] = []) -> PlanSnapshot {
    PlanSnapshot(sessions: sessions,
                 schedule: Schedule(reserved: reserved, favorites: favorites, invitedSessions: invited),
                 fetchedAt: Date(timeIntervalSince1970: 0))
}

final class CalendarExportDraftTests: XCTestCase {
    func testAReservedSessionBecomesAnEventInLasVegasTime() {
        let draft = CalendarExport.draft(for: held("a", code: "AIM320"), timeZone: vegas)
        XCTAssertEqual(draft, CalendarEventDraft(sessionID: "a", title: "AIM320 – Agents at scale",
                                                 start: dec2At1800Z, end: dec2At1900Z,
                                                 location: "Venetian, Level 3, Murano 3201",
                                                 notes: "re:Invent session AIM320"))
    }

    func testTheLocationUsesWhateverOfVenueAndRoomIsGiven() {
        XCTAssertEqual(CalendarExport.draft(for: held("a", code: "A", room: nil), timeZone: vegas)?.location, "Venetian")
        XCTAssertEqual(CalendarExport.draft(for: held("a", code: "A", venue: nil), timeZone: vegas)?.location,
                       "Level 3, Murano 3201")
        XCTAssertNil(CalendarExport.draft(for: held("a", code: "A", venue: nil, room: nil), timeZone: vegas)?.location)
        // Blank values count as missing.
        XCTAssertEqual(CalendarExport.draft(for: held("a", code: "A", room: "  "), timeZone: vegas)?.location, "Venetian")
    }

    func testASessionWithNoLengthTakesTheTwentyMinutesTheCalendarDrawsForIt() {
        let draft = CalendarExport.draft(for: held("a", code: "A", length: ""), timeZone: vegas)
        XCTAssertEqual(draft?.start, dec2At1800Z)
        XCTAssertEqual(draft?.end, dec2At1820Z)
    }

    func testASessionWithNoTimeOrAllDayIsNotDrafted() {
        // The precondition: the same session with a good time is drafted.
        XCTAssertNotNil(CalendarExport.draft(for: held("a", code: "A"), timeZone: vegas))
        XCTAssertNil(CalendarExport.draft(for: held("a", code: "A", time: "25:00"), timeZone: vegas))
        XCTAssertNil(CalendarExport.draft(for: held("a", code: "A", date: "2026-13-02"), timeZone: vegas))
        XCTAssertNil(CalendarExport.draft(for: held("a", code: "A", allDay: true), timeZone: vegas))
        var noTime = held("a", code: "A")
        noTime.sessionTime = nil
        XCTAssertNil(CalendarExport.draft(for: noTime, timeZone: vegas))
    }
}

final class CalendarExportPlanTests: XCTestCase {
    private let aim = held("aim", code: "AIM320")
    private let sec = held("sec", code: "SEC340", title: "Incident response", date: "2026-12-03", time: "09:30")
    private let fav = held("fav", code: "DEV201", title: "A favorite", time: "14:00")
    private let party = held("party", code: "PARTY", title: "Reception", time: "19:00")

    private func records(for sessions: [Session]) -> [String: ExportRecord] {
        var out: [String: ExportRecord] = [:]
        for session in sessions {
            out[session.sessionId] = ExportRecord(eventID: "event-\(session.sessionId)",
                                                  draft: CalendarExport.draft(for: session, timeZone: vegas)!)
        }
        return out
    }

    func testTurningItOnAddsOnlyTheReservedSessions() {
        let snapshot = plan([aim, sec, fav], reserved: ["aim", "sec"], favorites: ["fav"], invited: [party])
        // Precondition: the favorite and the invitation are on his schedule too.
        XCTAssertEqual(snapshot.commitment(of: "fav"), .favorite)
        XCTAssertEqual(snapshot.commitment(of: "party"), .invited)

        let result = CalendarExport.plan(for: snapshot, records: [:], timeZone: vegas)
        XCTAssertEqual(result.add.map(\.sessionID), ["aim", "sec"])
        XCTAssertEqual(result.add.map(\.start), [dec2At1800Z, dec3At1730Z])
        XCTAssertEqual(result.add.map(\.end), [dec2At1900Z, dec3At1830Z])
        XCTAssertEqual(result.update, [])
        XCTAssertEqual(result.remove, [])
        XCTAssertEqual(result.skipped, 0)
    }

    func testRunningItAgainChangesNothing() {
        let snapshot = plan([aim, sec], reserved: ["aim", "sec"])
        let existing = records(for: [aim, sec])
        XCTAssertEqual(existing.count, 2)
        let result = CalendarExport.plan(for: snapshot, records: existing, timeZone: vegas)
        XCTAssertEqual(result, ExportPlan(add: [], update: [], remove: [], skipped: 0))
        XCTAssertTrue(result.isEmpty)
    }

    func testAMovedSessionUpdatesItsOwnEvent() {
        let existing = records(for: [aim, sec])
        XCTAssertEqual(existing["aim"]?.draft.start, dec2At1800Z)
        var moved = aim
        moved.sessionTime = SessionTime(date: "2026-12-02", time: "13:00", length: "60")
        let result = CalendarExport.plan(for: plan([moved, sec], reserved: ["aim", "sec"]), records: existing,
                                         timeZone: vegas)
        XCTAssertEqual(result.update.map(\.eventID), ["event-aim"])
        XCTAssertEqual(result.update.map(\.draft.start), [dec2At2100Z])
        XCTAssertEqual(result.update.map(\.draft.end), [dec2At2200Z])
        XCTAssertEqual(result.add, [])
        XCTAssertEqual(result.remove, [])
    }

    func testACancelledSessionIsRemovedAndTheOthersStay() {
        let existing = records(for: [aim, sec])
        XCTAssertEqual(Set(existing.keys), ["aim", "sec"])
        let result = CalendarExport.plan(for: plan([aim, sec], reserved: ["sec"]), records: existing, timeZone: vegas)
        XCTAssertEqual(result.remove, ["event-aim"])
        XCTAssertEqual(result.add, [])
        XCTAssertEqual(result.update, [])
    }

    func testAStillReservedSessionThatCameBackUnreadableIsLeftAlone() {
        let existing = records(for: [aim, sec])
        XCTAssertNotNil(existing["aim"])
        var garbled = aim
        garbled.sessionTime = SessionTime(date: "2026-12-02", time: "soon")
        let result = CalendarExport.plan(for: plan([garbled, sec], reserved: ["aim", "sec"]), records: existing,
                                         timeZone: vegas)
        XCTAssertEqual(result, ExportPlan(add: [], update: [], remove: [], skipped: 1))
    }

    func testAReservedSessionMissingFromTheCatalogIsLeftAloneAndCounted() {
        let existing = records(for: [aim, sec])
        XCTAssertNotNil(existing["aim"])
        // "aim" is still reserved, but the catalog no longer lists it.
        let result = CalendarExport.plan(for: plan([sec], reserved: ["aim", "sec"]), records: existing, timeZone: vegas)
        XCTAssertEqual(result, ExportPlan(add: [], update: [], remove: [], skipped: 1))
    }

    func testRemovalsComeInAFixedOrder() {
        let existing = records(for: [aim, sec, fav])
        let result = CalendarExport.plan(for: plan([aim, sec, fav], reserved: []), records: existing, timeZone: vegas)
        XCTAssertEqual(result.remove, ["event-aim", "event-fav", "event-sec"])
    }
}

final class CalendarExportWordingTests: XCTestCase {
    func testWhatTheSettingSaysAfterAnUpdate() {
        XCTAssertEqual(Wording.calendarExport(count: 0, calendar: "re:Invent 2026"),
                       "No reserved sessions to add to “re:Invent 2026”.")
        XCTAssertEqual(Wording.calendarExport(count: 1, calendar: "re:Invent 2026"),
                       "1 reserved session is in your “re:Invent 2026” calendar.")
        XCTAssertEqual(Wording.calendarExport(count: 11, calendar: "re:Invent 2026"),
                       "11 reserved sessions are in your “re:Invent 2026” calendar.")
    }
}
