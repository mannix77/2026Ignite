import XCTest
@testable import PlannerCore

final class LineUpTests: XCTestCase {
    func testHeGetsThirtyMinutesUntilHeChangesIt() {
        XCTAssertEqual(LineUp().minutes, 30)
        XCTAssertEqual(LineUp(saved: nil).minutes, 30)
    }

    func testSettingsOffersOneToSixtyMinutes() {
        XCTAssertEqual(LineUp.allowedMinutes.lowerBound, 1)
        XCTAssertEqual(LineUp.allowedMinutes.upperBound, 60)
        // Both ends are kept; one past either end is brought back to it.
        XCTAssertEqual(LineUp(minutes: 1).minutes, 1)
        XCTAssertEqual(LineUp(minutes: 60).minutes, 60)
        XCTAssertEqual(LineUp(minutes: 0).minutes, 1)
        XCTAssertEqual(LineUp(minutes: 61).minutes, 60)
        XCTAssertEqual(LineUp(minutes: -5).minutes, 1)
    }

    func testASavedValueOutsideTheRangeIsReadAsTheNearestLimitAndAnUnreadableOneAsThirty() {
        XCTAssertEqual(LineUp(saved: NSNumber(value: 10)).minutes, 10)
        XCTAssertEqual(LineUp(saved: 10).minutes, 10)
        XCTAssertEqual(LineUp(saved: 0).minutes, 1)
        XCTAssertEqual(LineUp(saved: 75).minutes, 60)
        XCTAssertEqual(LineUp(saved: 1e20).minutes, 60)
        XCTAssertEqual(LineUp(saved: -1e20).minutes, 1)
        // A whole number saved as a decimal is still read; anything else is not.
        XCTAssertEqual(LineUp(saved: 15.0).minutes, 15)
        XCTAssertEqual(LineUp(saved: 12.5).minutes, 30)
        XCTAssertEqual(LineUp(saved: "10").minutes, 30)
        XCTAssertEqual(LineUp(saved: true).minutes, 30)
        XCTAssertEqual(LineUp(saved: Double.nan).minutes, 30)
    }

    func testAWalkUpSessionAllowsFiveMinutesOrHisTimeIfShorter() {
        var reservable = session("r")
        reservable.isReservable = true
        let unknown = session("u")
        XCTAssertNil(unknown.isReservable)
        var walkUpMarked = session("w")
        walkUpMarked.isReservable = false

        XCTAssertEqual(LineUp().minutes(for: reservable), 30)
        XCTAssertEqual(LineUp().minutes(for: unknown), 30)
        XCTAssertEqual(LineUp().minutes(for: walkUpMarked), 5)
        XCTAssertEqual(LineUp(minutes: 10).minutes(for: reservable), 10)
        XCTAssertEqual(LineUp(minutes: 10).minutes(for: walkUpMarked), 5)
        // Both sides of 5: his own time wins only when it is shorter.
        XCTAssertEqual(LineUp(minutes: 5).minutes(for: walkUpMarked), 5)
        XCTAssertEqual(LineUp(minutes: 4).minutes(for: walkUpMarked), 4)
        XCTAssertEqual(LineUp(minutes: 6).minutes(for: walkUpMarked), 5)
        XCTAssertEqual(LineUp(minutes: 3).minutes(for: walkUpMarked), 3)
        // What Settings shows for walk-ups.
        XCTAssertEqual(LineUp().walkUp, 5)
        XCTAssertEqual(LineUp(minutes: 3).walkUp, 3)
    }
}
