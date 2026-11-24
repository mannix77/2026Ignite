import XCTest
@testable import PlannerCore

final class AutoRefreshTests: XCTestCase {
    // 2026-12-03T17:00:00Z is 09:00 on 3 December in Las Vegas.
    private let nine = Date(timeIntervalSince1970: 1_796_317_200)

    func testBackAfterFiveMinutesUpdates() {
        XCTAssertTrue(AutoRefresh.isDue(lastUpdated: nine, now: nine.addingTimeInterval(300)))
        XCTAssertTrue(AutoRefresh.isDue(lastUpdated: nine, now: nine.addingTimeInterval(3600)))
    }

    func testBackJustUnderFiveMinutesDoesNot() {
        XCTAssertFalse(AutoRefresh.isDue(lastUpdated: nine, now: nine.addingTimeInterval(299)))
        XCTAssertFalse(AutoRefresh.isDue(lastUpdated: nine, now: nine))
        // The same calendar is due once five minutes have passed (rule 2).
        XCTAssertTrue(AutoRefresh.isDue(lastUpdated: nine, now: nine.addingTimeInterval(300)))
    }

    func testAClockMovedBackUpdates() {
        XCTAssertTrue(AutoRefresh.isDue(lastUpdated: nine, now: nine.addingTimeInterval(-1800)))
        XCTAssertTrue(AutoRefresh.isDue(lastUpdated: nine, now: nine.addingTimeInterval(-1)))
    }

    func testNoCalendarYetUpdates() {
        XCTAssertTrue(AutoRefresh.isDue(lastUpdated: nil, now: nine))
    }

    func testNoConnectionIsQuietButOtherProblemsAreShown() {
        XCTAssertFalse(AutoRefresh.shouldReport(URLError(.notConnectedToInternet)))
        XCTAssertFalse(AutoRefresh.shouldReport(URLError(.timedOut)))
        XCTAssertFalse(AutoRefresh.shouldReport(URLError(.networkConnectionLost)))
        XCTAssertTrue(AutoRefresh.shouldReport(APIError.signInNeeded))
        XCTAssertTrue(AutoRefresh.shouldReport(APIError.catalogShrank(previous: 2861, got: 250)))
        XCTAssertTrue(AutoRefresh.shouldReport(APIError.busy))
    }
}
