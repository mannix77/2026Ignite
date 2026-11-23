import XCTest
@testable import PlannerCore

/// The re:Invent 2026 days the strip shows, Sunday 29 November to Friday 4 December.
private let week = ["2026-11-29", "2026-11-30", "2026-12-01", "2026-12-02", "2026-12-03", "2026-12-04"]

final class DayNavigationTests: XCTestCase {
    func testTheWeekIsTheSixConferenceDays() {
        // Precondition for the rest: the fixture really is Sunday to Friday, first to last.
        XCTAssertEqual(week.count, 6)
        XCTAssertEqual(week.first, "2026-11-29")
        XCTAssertEqual(week.last, "2026-12-04")
    }

    func testASwipeLeftFromWednesdayShowsThursday() {
        XCTAssertEqual(DayNavigation.day(from: "2026-12-02", by: 1, in: week), "2026-12-03")
    }

    func testASwipeRightFromWednesdayShowsTuesday() {
        XCTAssertEqual(DayNavigation.day(from: "2026-12-02", by: -1, in: week), "2026-12-01")
    }

    // Both sides of each end: the step onto the end day moves, the step past it does not.
    func testTheLastDayIsReachedAndNotPassed() {
        XCTAssertEqual(DayNavigation.day(from: "2026-12-03", by: 1, in: week), "2026-12-04")
        XCTAssertEqual(DayNavigation.day(from: "2026-12-04", by: 1, in: week), "2026-12-04")
    }

    func testTheFirstDayIsReachedAndNotPassed() {
        XCTAssertEqual(DayNavigation.day(from: "2026-11-30", by: -1, in: week), "2026-11-29")
        XCTAssertEqual(DayNavigation.day(from: "2026-11-29", by: -1, in: week), "2026-11-29")
    }

    func testTheEndsDoNotWrapAround() {
        XCTAssertNotEqual(DayNavigation.day(from: "2026-12-04", by: 1, in: week), "2026-11-29")
        XCTAssertNotEqual(DayNavigation.day(from: "2026-11-29", by: -1, in: week), "2026-12-04")
    }

    func testABigMoveStopsAtTheEnd() {
        XCTAssertEqual(DayNavigation.day(from: "2026-12-01", by: 10, in: week), "2026-12-04")
        XCTAssertEqual(DayNavigation.day(from: "2026-12-01", by: -10, in: week), "2026-11-29")
    }

    func testTheLargestPossibleMoveStopsAtTheEnd() {
        XCTAssertEqual(DayNavigation.day(from: "2026-12-01", by: .max, in: week), "2026-12-04")
        XCTAssertEqual(DayNavigation.day(from: "2026-12-01", by: .min, in: week), "2026-11-29")
    }

    func testNoMoveStaysOnTheDay() {
        XCTAssertEqual(DayNavigation.day(from: "2026-12-01", by: 0, in: week), "2026-12-01")
    }

    func testADayOutsideTheStripComesBackUnchanged() {
        XCTAssertEqual(DayNavigation.day(from: "2026-12-07", by: 1, in: week), "2026-12-07")
        XCTAssertEqual(DayNavigation.day(from: "2026-12-07", by: -1, in: week), "2026-12-07")
        // And with a strip of one day, there is nowhere to go either way.
        XCTAssertEqual(DayNavigation.day(from: "2026-12-02", by: 1, in: ["2026-12-02"]), "2026-12-02")
        XCTAssertEqual(DayNavigation.day(from: "2026-12-02", by: -1, in: ["2026-12-02"]), "2026-12-02")
    }

    func testNoDaysAtAllLeavesTheDayAlone() {
        XCTAssertEqual(DayNavigation.day(from: "2026-12-02", by: 1, in: []), "2026-12-02")
    }
}
