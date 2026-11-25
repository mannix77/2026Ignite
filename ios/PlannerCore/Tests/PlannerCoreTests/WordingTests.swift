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

    func testTheRefreshButtonWarmsEveryFiveMinutesUntilAnHour() {
        let fetched = Date(timeIntervalSince1970: 1_800_000_000)
        func level(_ seconds: TimeInterval) -> Double { Wording.staleness(fetched, now: fetched + seconds) }
        XCTAssertEqual(level(-5), 0)
        XCTAssertEqual(level(0), 0)
        XCTAssertEqual(level(299), 0)
        XCTAssertEqual(level(300), 1.0 / 12, accuracy: 1e-12)
        XCTAssertEqual(level(599), 1.0 / 12, accuracy: 1e-12)
        XCTAssertEqual(level(600), 2.0 / 12, accuracy: 1e-12)
        // Each 5-minute step, just before and at it.
        let steps: [(seconds: TimeInterval, before: Double, at: Double)] = [
            (900, 2, 3), (1200, 3, 4), (1500, 4, 5), (1800, 5, 6), (2100, 6, 7),
            (2400, 7, 8), (2700, 8, 9), (3000, 9, 10), (3300, 10, 11),
        ]
        for step in steps {
            XCTAssertEqual(level(step.seconds - 1), step.before / 12, accuracy: 1e-12, "\(step.seconds - 1) s")
            XCTAssertEqual(level(step.seconds), step.at / 12, accuracy: 1e-12, "\(step.seconds) s")
        }
        XCTAssertEqual(level(3599), 11.0 / 12, accuracy: 1e-12)
        XCTAssertEqual(level(3600), 1)
        XCTAssertEqual(level(86400), 1)
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

    func testAFullSessionCantBeReserved() {
        func session(_ band: String?) -> Session {
            Session(sessionId: "a", title: "T", isReservable: true, seatAvailability: band)
        }
        XCTAssertFalse(Wording.canReserve(session("unavailable")))
        XCTAssertFalse(Wording.canReserve(session("walkUp")))
        XCTAssertTrue(Wording.canReserve(session("available")))
        XCTAssertTrue(Wording.canReserve(session("limited")))
        XCTAssertTrue(Wording.canReserve(session("veryLimited")))
        // A band the app doesn't know, or none, leaves the choice to the site.
        XCTAssertTrue(Wording.canReserve(session("someNewBand")))
        XCTAssertTrue(Wording.canReserve(session(nil)))
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
        XCTAssertEqual(Wording.problem(APIError.scheduleMostlyJunk(skipped: 2, total: 3)),
                       "Your schedule arrived mostly unreadable, so the last good copy was kept.")
        XCTAssertEqual(Wording.problem(APIError.unconfirmed),
                       "The conference site did not confirm the change. Your schedule was read again: check whether it went through.")
        XCTAssertEqual(Wording.problem(URLError(.notConnectedToInternet)),
                       "Could not reach the conference site. Check your connection and try again.")
    }

    // 2026-12-03T17:00:00Z, 09:00 in Las Vegas; the wording depends only on the difference.
    private let updated = Date(timeIntervalSince1970: 1_796_317_200)

    private func freshness(after seconds: TimeInterval, sample: Bool = false) -> String {
        Wording.lastUpdated(updated, now: updated.addingTimeInterval(seconds), sample: sample)
    }

    func testLastUpdatedSaysHowLongAgoAndHowToUpdate() {
        XCTAssertEqual(freshness(after: 12 * 60), "Updated 12 min ago")
        XCTAssertEqual(freshness(after: 0), "Updated just now")
        XCTAssertEqual(freshness(after: 2 * 3600), "Updated 2 hr ago")
    }

    func testLastUpdatedThresholds() {
        XCTAssertEqual(freshness(after: 59), "Updated just now")
        XCTAssertEqual(freshness(after: 60), "Updated 1 min ago")
        XCTAssertEqual(freshness(after: 3599), "Updated 59 min ago")
        XCTAssertEqual(freshness(after: 3600), "Updated 1 hr ago")
        XCTAssertEqual(freshness(after: 86399), "Updated 23 hr ago")
        XCTAssertEqual(freshness(after: 86400), "Updated 1 day ago")
        XCTAssertEqual(freshness(after: 2 * 86400 + 5), "Updated 2 days ago")
    }

    func testLastUpdatedWithTheClockMovedBackGivesNoAge() {
        XCTAssertEqual(freshness(after: -1800), "Updated from AWS")
        XCTAssertEqual(freshness(after: -1), "Updated from AWS")
    }

    func testLastUpdatedForTheSampleConference() {
        XCTAssertEqual(freshness(after: 0, sample: true), "Sample, updated just now")
        XCTAssertEqual(freshness(after: -5, sample: true), "Sample conference")
    }

    func testTheCalendarSaysWhenItIsUpdating() {
        XCTAssertEqual(Wording.calendarStatus(refreshing: true, fetchedAt: updated, now: updated, sample: false),
                       "Updating from AWS…")
        XCTAssertEqual(Wording.calendarStatus(refreshing: true, fetchedAt: updated, now: updated, sample: true),
                       "Updating the sample…")
        XCTAssertEqual(Wording.calendarStatus(refreshing: false, fetchedAt: updated, now: updated.addingTimeInterval(720), sample: false),
                       "Updated 12 min ago")
        XCTAssertEqual(Wording.calendarStatus(refreshing: false, fetchedAt: updated, now: updated, sample: true),
                       "Sample, updated just now")
    }
}
