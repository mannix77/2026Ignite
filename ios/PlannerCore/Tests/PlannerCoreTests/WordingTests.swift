import XCTest
@testable import PlannerCore

final class WordingTests: XCTestCase {
    func testClockTimes() {
        XCTAssertEqual(Wording.clock(0), "12:00 AM")
        XCTAssertEqual(Wording.clock(719), "11:59 AM")
        XCTAssertEqual(Wording.clock(720), "12:00 PM")
        XCTAssertEqual(Wording.clock(900), "3:00 PM")
        XCTAssertEqual(Wording.clock(1439), "11:59 PM")
        XCTAssertEqual(Wording.clock(1500), "1:00 AM")
    }

    func testTimeRanges() {
        XCTAssertEqual(Wording.timeRange(start: 900, end: 1020), "3:00 – 5:00 PM")
        XCTAssertEqual(Wording.timeRange(start: 690, end: 750), "11:30 AM – 12:30 PM")
        XCTAssertEqual(Wording.timeRange(start: 600, end: 600), "10:00 AM")
    }

    // 2 December 2026 is a Wednesday; 30 November 2026 is a Monday.
    func testDays() {
        XCTAssertEqual(Wording.day("2026-12-02"), "Wed, Dec 2")
        XCTAssertEqual(Wording.day("2026-11-30"), "Mon, Nov 30")
        XCTAssertEqual(Wording.day("soon"), "soon")
        XCTAssertEqual(Wording.dayChip("2026-12-02").weekday, "Wed")
        XCTAssertEqual(Wording.dayChip("2026-12-02").number, "2")
        XCTAssertEqual(Wording.dayChip("soon").weekday, "soon")
    }

    // 2026-12-02T07:30:00Z is 11:30 PM on 1 December in Las Vegas (UTC-8).
    func testNowIsReadInTheEventsTimeZoneNotThePhones() throws {
        let instant = Date(timeIntervalSince1970: 1_796_196_600)
        let vegas = Wording.eventNow(instant, timeZone: try XCTUnwrap(TimeZone(identifier: "America/Los_Angeles")))
        XCTAssertEqual(vegas.date, "2026-12-01")
        XCTAssertEqual(vegas.minute, 23 * 60 + 30)
        let utc = Wording.eventNow(instant, timeZone: try XCTUnwrap(TimeZone(identifier: "UTC")))
        XCTAssertEqual(utc.date, "2026-12-02")
        XCTAssertEqual(utc.minute, 7 * 60 + 30)
    }

    func testAHeldSeatIsNotCalledFull() {
        let full = Session(sessionId: "a", title: "T", isReservable: true, seatAvailability: "unavailable")
        XCTAssertEqual(Wording.seats(full, commitment: .reserved), "You hold a seat")
        XCTAssertEqual(Wording.seats(full, commitment: .favorite), "Full")
        XCTAssertEqual(Wording.seats(full, commitment: nil), "Full")
        let open = Session(sessionId: "b", title: "T", isReservable: true, seatAvailability: "veryLimited")
        XCTAssertEqual(Wording.seats(open, commitment: nil), "Very few seats")
        let walkIn = Session(sessionId: "c", title: "T", isReservable: false)
        XCTAssertEqual(Wording.seats(walkIn, commitment: .favorite), "Walk-in, no reservation")
        let unknown = Session(sessionId: "d", title: "T", isReservable: true, seatAvailability: "someNewBand")
        XCTAssertNil(Wording.seats(unknown, commitment: nil))
    }

    func testAClashNamesTheSessionsItClashesWith() {
        let codes = ["aim": "AIM442"]
        let clash = BulkFailure(sessionId: "pex", code: "scheduleConflict", conflictsWith: ["aim", "mystery"])
        XCTAssertEqual(Wording.refusal(clash) { codes[$0] }, "It clashes with AIM442, another session.")
        XCTAssertEqual(Wording.refusal(BulkFailure(sessionId: "pex", code: "scheduleConflict")) { codes[$0] },
                       "It clashes with a session you already hold.")
        XCTAssertEqual(Wording.refusal(BulkFailure(sessionId: "pex", code: "sessionFull")) { codes[$0] },
                       "This session is full.")
        XCTAssertEqual(Wording.refusal(BulkFailure(sessionId: "pex", code: "somethingNew")) { codes[$0] },
                       "The conference site refused this.")
    }

    func testProblemsAreExplained() {
        XCTAssertEqual(Wording.problem(APIError.signInNeeded), "Your sign-in has expired. Sign in again to update.")
        XCTAssertEqual(Wording.problem(APIError.catalogIncomplete(expected: 2849, got: 250)),
                       "The session list arrived incomplete, so the last good copy was kept.")
        XCTAssertEqual(Wording.problem(APIError.unconfirmed),
                       "The conference site did not confirm the change. Your schedule was read again: check whether it went through.")
        XCTAssertEqual(Wording.problem(URLError(.notConnectedToInternet)),
                       "Could not reach the conference site. Check your connection and try again.")
    }
}
