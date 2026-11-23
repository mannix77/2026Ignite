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
        let draft = CalendarExport.draft(for: held("a", code: "AIM320"), timeZone: vegas, eventName: "re:Invent 2026")
        XCTAssertEqual(draft, CalendarEventDraft(sessionID: "a", title: "AIM320 – Agents at scale",
                                                 start: dec2At1800Z, end: dec2At1900Z,
                                                 location: "Venetian, Level 3, Murano 3201",
                                                 notes: "re:Invent 2026 session AIM320"))
    }

    /// The whole draft expected for session "a", code "A", 10:00–11:00 on 2 Dec, at `location`.
    private func expected(location: String?, end: Date = dec2At1900Z) -> CalendarEventDraft {
        CalendarEventDraft(sessionID: "a", title: "A – Agents at scale", start: dec2At1800Z, end: end,
                           location: location, notes: "re:Invent 2026 session A")
    }

    func testTheLocationUsesWhateverOfVenueAndRoomIsGiven() {
        XCTAssertEqual(CalendarExport.draft(for: held("a", code: "A", room: nil), timeZone: vegas, eventName: "re:Invent 2026"),
                       expected(location: "Venetian"))
        XCTAssertEqual(CalendarExport.draft(for: held("a", code: "A", venue: nil), timeZone: vegas, eventName: "re:Invent 2026"),
                       expected(location: "Level 3, Murano 3201"))
        XCTAssertEqual(CalendarExport.draft(for: held("a", code: "A", venue: nil, room: nil), timeZone: vegas,
                                            eventName: "re:Invent 2026"), expected(location: nil))
        // Blank values count as missing.
        XCTAssertEqual(CalendarExport.draft(for: held("a", code: "A", room: "  "), timeZone: vegas, eventName: "re:Invent 2026"),
                       expected(location: "Venetian"))
    }

    func testASessionWithNoLengthTakesTheTwentyMinutesTheCalendarDrawsForIt() {
        XCTAssertEqual(CalendarExport.draft(for: held("a", code: "A", length: ""), timeZone: vegas, eventName: "re:Invent 2026"),
                       expected(location: "Venetian, Level 3, Murano 3201", end: dec2At1820Z))
    }

    func testASessionWithNoTimeOrAllDayIsNotDrafted() {
        // The precondition: the same session with a good time is drafted.
        XCTAssertNotNil(CalendarExport.draft(for: held("a", code: "A"), timeZone: vegas, eventName: "re:Invent 2026"))
        XCTAssertNil(CalendarExport.draft(for: held("a", code: "A", time: "25:00"), timeZone: vegas, eventName: "re:Invent 2026"))
        XCTAssertNil(CalendarExport.draft(for: held("a", code: "A", date: "2026-13-02"), timeZone: vegas, eventName: "re:Invent 2026"))
        XCTAssertNil(CalendarExport.draft(for: held("a", code: "A", allDay: true), timeZone: vegas, eventName: "re:Invent 2026"))
        var noTime = held("a", code: "A")
        noTime.sessionTime = nil
        XCTAssertNil(CalendarExport.draft(for: noTime, timeZone: vegas, eventName: "re:Invent 2026"))
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
                                                  draft: CalendarExport.draft(for: session, timeZone: vegas, eventName: "re:Invent 2026")!)
        }
        return out
    }

    func testTurningItOnAddsOnlyTheReservedSessions() {
        let snapshot = plan([aim, sec, fav], reserved: ["aim", "sec"], favorites: ["fav"], invited: [party])
        // Precondition: the favorite and the invitation are on his schedule too.
        XCTAssertEqual(snapshot.commitment(of: "fav"), .favorite)
        XCTAssertEqual(snapshot.commitment(of: "party"), .invited)

        let result = CalendarExport.plan(for: snapshot, records: [:], timeZone: vegas, eventName: "re:Invent 2026")
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
        let result = CalendarExport.plan(for: snapshot, records: existing, timeZone: vegas, eventName: "re:Invent 2026")
        XCTAssertEqual(result, ExportPlan(add: [], update: [], remove: [], skipped: 0))
        XCTAssertTrue(result.isEmpty)
    }

    func testAMovedSessionUpdatesItsOwnEvent() {
        let existing = records(for: [aim, sec])
        XCTAssertEqual(existing["aim"]?.draft.start, dec2At1800Z)
        var moved = aim
        moved.sessionTime = SessionTime(date: "2026-12-02", time: "13:00", length: "60")
        let result = CalendarExport.plan(for: plan([moved, sec], reserved: ["aim", "sec"]), records: existing,
                                         timeZone: vegas, eventName: "re:Invent 2026")
        XCTAssertEqual(result.update.map(\.eventID), ["event-aim"])
        XCTAssertEqual(result.update.map(\.draft.start), [dec2At2100Z])
        XCTAssertEqual(result.update.map(\.draft.end), [dec2At2200Z])
        XCTAssertEqual(result.add, [])
        XCTAssertEqual(result.remove, [])
        XCTAssertEqual(result.skipped, 0)
    }

    func testACancelledSessionIsRemovedAndTheOthersStay() {
        let existing = records(for: [aim, sec])
        XCTAssertEqual(Set(existing.keys), ["aim", "sec"])
        let result = CalendarExport.plan(for: plan([aim, sec], reserved: ["sec"]), records: existing, timeZone: vegas, eventName: "re:Invent 2026")
        XCTAssertEqual(result, ExportPlan(add: [], update: [], remove: ["event-aim"], skipped: 0))
    }

    func testAStillReservedSessionThatCameBackUnreadableIsLeftAlone() {
        let existing = records(for: [aim, sec])
        XCTAssertNotNil(existing["aim"])
        var garbled = aim
        garbled.sessionTime = SessionTime(date: "2026-12-02", time: "soon")
        let result = CalendarExport.plan(for: plan([garbled, sec], reserved: ["aim", "sec"]), records: existing,
                                         timeZone: vegas, eventName: "re:Invent 2026")
        XCTAssertEqual(result, ExportPlan(add: [], update: [], remove: [], skipped: 1))
    }

    func testAReservedSessionMissingFromTheCatalogIsLeftAloneAndCounted() {
        let existing = records(for: [aim, sec])
        XCTAssertNotNil(existing["aim"])
        // "aim" is still reserved, but the catalog no longer lists it.
        let result = CalendarExport.plan(for: plan([sec], reserved: ["aim", "sec"]), records: existing, timeZone: vegas, eventName: "re:Invent 2026")
        XCTAssertEqual(result, ExportPlan(add: [], update: [], remove: [], skipped: 1))
    }

    func testRemovalsComeInAFixedOrder() {
        // Twelve records, so a dictionary's own order can't match by luck.
        let many = (1...12).map { held(String(format: "s%02d", $0), code: "C\($0)") }
        let existing = records(for: many)
        XCTAssertEqual(existing.count, 12)
        let result = CalendarExport.plan(for: plan(many, reserved: []), records: existing, timeZone: vegas,
                                         eventName: "re:Invent 2026")
        XCTAssertEqual(result, ExportPlan(add: [], update: [], remove: (1...12).map { String(format: "event-s%02d", $0) },
                                          skipped: 0))
    }

    func testARepeatedOrBlankReservedIdAddsOneEventOnly() {
        // The site lists "aim" twice (once with spaces) and a blank id; "sec" once.
        let snapshot = plan([aim, sec], reserved: ["aim", " aim ", "", "  ", "sec", "sec"])
        let result = CalendarExport.plan(for: snapshot, records: [:], timeZone: vegas, eventName: "re:Invent 2026")
        XCTAssertEqual(result.add.map(\.sessionID), ["aim", "sec"])
        XCTAssertEqual(result.update, [])
        XCTAssertEqual(result.skipped, 0)
        XCTAssertEqual(result.remove, [])
    }
}

final class CalendarExportRecordTests: XCTestCase {
    private func record(_ eventID: String, for sessionID: String) -> ExportRecord {
        ExportRecord(eventID: eventID, draft: CalendarExport.draft(for: held(sessionID, code: "C"), timeZone: vegas,
                                                                   eventName: "re:Invent 2026")!)
    }

    func testGoodRecordsAreKept() {
        let saved = ["aim": record("e1", for: "aim"), "sec": record("e2", for: "sec")]
        let checked = CalendarExport.usableRecords(saved)
        XCTAssertEqual(checked, UsableRecords(records: saved, skipped: 0, isMostlyJunk: false))
    }

    func testARecordWithABlankEventOrAMismatchedSessionIsSkippedAndCounted() {
        let saved = [
            "aim": record("e1", for: "aim"),
            "sec": record("e2", for: "sec"),
            "dev": record("e3", for: "dev"),
            "blank": record("  ", for: "blank"),
            "other": record("e4", for: "sec"), // filed under one session, drafted for another
        ]
        let checked = CalendarExport.usableRecords(saved)
        XCTAssertEqual(checked.records, ["aim": saved["aim"]!, "sec": saved["sec"]!, "dev": saved["dev"]!])
        XCTAssertEqual(checked.skipped, 2)
        XCTAssertFalse(checked.isMostlyJunk)
    }

    func testTwoRecordsClaimingOneEventAreBothSkipped() {
        let saved = ["aim": record("same", for: "aim"), "sec": record("same", for: "sec"),
                     "dev": record("e3", for: "dev"), "ops": record("e4", for: "ops"),
                     "net": record("e5", for: "net")]
        let checked = CalendarExport.usableRecords(saved)
        XCTAssertEqual(checked.records, ["dev": saved["dev"]!, "ops": saved["ops"]!, "net": saved["net"]!])
        XCTAssertEqual(checked.skipped, 2)
        XCTAssertFalse(checked.isMostlyJunk)
    }

    // Both sides of "more than half": 1 bad of 2 is kept, 2 bad of 3 is refused.
    func testAHalfBadRecordIsKeptAndAMostlyBadOneRefused() {
        let half = CalendarExport.usableRecords(["aim": record("e1", for: "aim"), "x": record("", for: "x")])
        XCTAssertEqual(half.records.keys.sorted(), ["aim"])
        XCTAssertEqual(half.skipped, 1)
        XCTAssertFalse(half.isMostlyJunk)

        let mostly = CalendarExport.usableRecords(["aim": record("e1", for: "aim"), "x": record("", for: "x"),
                                                   "y": record("e2", for: "z")])
        XCTAssertEqual(mostly.records.keys.sorted(), ["aim"])
        XCTAssertEqual(mostly.skipped, 2)
        XCTAssertTrue(mostly.isMostlyJunk)
    }

    func testTwoRecordsForTheSameSessionOnceCleanedAreBothSkipped() {
        let saved = ["aim": record("e1", for: "aim"), " aim ": record("e2", for: "aim"),
                     "sec": record("e3", for: "sec"), "dev": record("e4", for: "dev"),
                     "ops": record("e5", for: "ops")]
        let checked = CalendarExport.usableRecords(saved)
        XCTAssertEqual(checked, UsableRecords(records: ["sec": saved["sec"]!, "dev": saved["dev"]!, "ops": saved["ops"]!],
                                              skipped: 2, isMostlyJunk: false))
    }

    private func file(_ records: String, calendar: String = #""cal-1""#) -> Data {
        Data(#"{"calendarID":\#(calendar),"records":{\#(records)}}"#.utf8)
    }

    private func json(_ eventID: String, for sessionID: String) -> String {
        let data = try! JSONEncoder().encode(record(eventID, for: sessionID))
        return #""\#(sessionID)":"# + String(decoding: data, as: UTF8.self)
    }

    func testAFileWithOneMalformedRecordKeepsTheOthers() {
        let read = CalendarExport.readFile(file([json("e1", for: "aim"), json("e2", for: "sec"), #""bad":null"#]
            .joined(separator: ",")))
        XCTAssertEqual(read?.calendarID, "cal-1")
        XCTAssertEqual(read?.checked.records.keys.sorted(), ["aim", "sec"])
        XCTAssertEqual(read?.checked.skipped, 1)
        XCTAssertEqual(read?.checked.isMostlyJunk, false)
    }

    func testAFileOfMostlyMalformedRecordsIsRefused() {
        let read = CalendarExport.readFile(file([json("e1", for: "aim"), #""bad":null"#, #""worse":{"eventID":7}"#]
            .joined(separator: ",")))
        XCTAssertEqual(read?.checked.records.keys.sorted(), ["aim"])
        XCTAssertEqual(read?.checked.skipped, 2)
        XCTAssertEqual(read?.checked.isMostlyJunk, true)
    }

    func testAFileThatIsNotARecordFileAtAllIsUnreadable() {
        XCTAssertNotNil(CalendarExport.readFile(file(json("e1", for: "aim"))))
        XCTAssertNil(CalendarExport.readFile(Data("not json".utf8)))
        XCTAssertNil(CalendarExport.readFile(Data()))
        XCTAssertNil(CalendarExport.readFile(Data(#"{"calendarID":"cal-1"}"#.utf8)))
    }

    func testABlankOrMissingCalendarIDCountsAsNone() {
        XCTAssertNil(CalendarExport.readFile(file(json("e1", for: "aim"), calendar: #""  ""#))?.calendarID)
        XCTAssertNil(CalendarExport.readFile(file(json("e1", for: "aim"), calendar: "null"))?.calendarID)
        XCTAssertEqual(CalendarExport.readFile(file(json("e1", for: "aim"), calendar: "null"))?.checked.records.count, 1)
    }

    func testNoRecordsIsFine() {
        XCTAssertEqual(CalendarExport.usableRecords([:]), UsableRecords(records: [:], skipped: 0, isMostlyJunk: false))
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
