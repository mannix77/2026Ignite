import XCTest
@testable import PlannerCore

/// The re:Invent 2026 days the strip shows, Sunday 29 November to Friday 4 December.
private let week = ["2026-11-29", "2026-11-30", "2026-12-01", "2026-12-02", "2026-12-03", "2026-12-04"]

/// The precondition each test relies on: the days it starts from (and expects) are in `week`,
/// at the place the test assumes. Asserted in every test, so a changed fixture fails loudly
/// instead of passing through the "day not in the strip" path.
private func assertInWeek(_ day: String, at position: Int, file: StaticString = #filePath, line: UInt = #line) {
    XCTAssertEqual(week.firstIndex(of: day), position, "\(day) is not day \(position) of the fixture week",
                   file: file, line: line)
}

final class DayNavigationTests: XCTestCase {
    func testASwipeLeftFromWednesdayShowsThursday() {
        assertInWeek("2026-12-02", at: 3)
        assertInWeek("2026-12-03", at: 4)
        XCTAssertEqual(DayNavigation.day(from: "2026-12-02", by: 1, in: week), "2026-12-03")
    }

    func testASwipeRightFromWednesdayShowsTuesday() {
        assertInWeek("2026-12-02", at: 3)
        assertInWeek("2026-12-01", at: 2)
        XCTAssertEqual(DayNavigation.day(from: "2026-12-02", by: -1, in: week), "2026-12-01")
    }

    // Both sides of each end: the step onto the end day moves, the step past it does not.
    func testTheLastDayIsReachedAndNotPassed() {
        assertInWeek("2026-12-03", at: 4)
        assertInWeek("2026-12-04", at: week.count - 1)
        XCTAssertEqual(DayNavigation.day(from: "2026-12-03", by: 1, in: week), "2026-12-04")
        XCTAssertEqual(DayNavigation.day(from: "2026-12-04", by: 1, in: week), "2026-12-04")
    }

    func testTheFirstDayIsReachedAndNotPassed() {
        assertInWeek("2026-11-30", at: 1)
        assertInWeek("2026-11-29", at: 0)
        XCTAssertEqual(DayNavigation.day(from: "2026-11-30", by: -1, in: week), "2026-11-29")
        XCTAssertEqual(DayNavigation.day(from: "2026-11-29", by: -1, in: week), "2026-11-29")
    }

    func testTheLargestPossibleMoveStopsAtTheEnd() {
        assertInWeek("2026-12-01", at: 2)
        assertInWeek("2026-11-29", at: 0)
        assertInWeek("2026-12-04", at: week.count - 1)
        XCTAssertEqual(DayNavigation.day(from: "2026-12-01", by: .max, in: week), "2026-12-04")
        XCTAssertEqual(DayNavigation.day(from: "2026-12-01", by: .min, in: week), "2026-11-29")
    }

    func testNoMoveStaysOnTheDay() {
        assertInWeek("2026-12-01", at: 2)
        XCTAssertEqual(DayNavigation.day(from: "2026-12-01", by: 0, in: week), "2026-12-01")
    }

    func testADayOutsideTheStripComesBackUnchanged() {
        XCTAssertFalse(week.contains("2026-12-07"), "the outside day must not be in the fixture week")
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
