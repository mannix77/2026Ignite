import XCTest
@testable import PlannerCore

/// Two reserved seats on 2 Dec: 09:00–10:00, then one starting at `secondStart` for an hour.
private func dayWithSeats(secondStart: String) -> PlanSnapshot {
    let first = session("first", time: "09:00", length: "60", venue: "MGM Grand")
    let second = session("second", time: secondStart, length: "60", venue: "MGM Grand")
    return PlanSnapshot(sessions: [first, second],
                        schedule: Schedule(reserved: ["first", "second"], favorites: []),
                        fetchedAt: Date(timeIntervalSince1970: 0))
}

final class GapOfferTests: XCTestCase {
    // Both sides of the 30-minute threshold, with the gap itself asserted first.
    func testAThirtyMinuteGapIsOffered() {
        let plan = dayWithSeats(secondStart: "10:30")
        XCTAssertEqual(plan.gaps(on: "2026-12-02").map { [$0.start, $0.end] }, [[600, 630]])
        XCTAssertEqual(plan.offeredGaps(on: "2026-12-02").map { [$0.start, $0.end] }, [[600, 630]])
    }

    func testATwentyNineMinuteGapIsNotOffered() {
        let plan = dayWithSeats(secondStart: "10:29")
        XCTAssertEqual(plan.gaps(on: "2026-12-02").map { [$0.start, $0.end] }, [[600, 629]])
        XCTAssertEqual(plan.offeredGaps(on: "2026-12-02").map { [$0.start, $0.end] }, [])
    }

    func testOnlyTheShortGapIsDroppedAndTheOthersKept() {
        // 09:00–10:00 held, 10:00–10:29 free (too short), 10:29–11:29 held, then a free hour to
        // the end of a catalog session that runs until 12:30.
        var plan = dayWithSeats(secondStart: "10:29")
        plan.sessions.append(session("late", time: "11:30", length: "60", venue: "MGM Grand"))
        XCTAssertEqual(plan.gaps(on: "2026-12-02").map { [$0.start, $0.end] }, [[600, 629], [689, 750]])
        XCTAssertEqual(plan.offeredGaps(on: "2026-12-02").map { [$0.start, $0.end] }, [[689, 750]])
    }

    func testAnIndexPassedInGivesTheSameGaps() {
        let plan = dayWithSeats(secondStart: "10:30")
        XCTAssertEqual(plan.offeredGaps(on: "2026-12-02", index: plan.sessionsByID).map { [$0.start, $0.end] },
                       [[600, 630]])
        XCTAssertEqual(plan.gaps(on: "2026-12-02", index: plan.sessionsByID).map { [$0.start, $0.end] }, [[600, 630]])
    }

    func testTheGapIsWordedAsFreeTime() {
        let gap = Gap(date: "2026-12-02", start: 600, end: 630, before: .open, after: .open)
        XCTAssertEqual(Wording.gap(gap), "Free 10:00 – 10:30 AM")
        let acrossNoon = Gap(date: "2026-12-02", start: 690, end: 810, before: .open, after: .open)
        XCTAssertEqual(Wording.gap(acrossNoon), "Free 11:30 AM – 1:30 PM")
    }

    func testHowHeCanGetInAndWhatItShares() {
        let base = Suggestion(session: session("s"), score: 1, shared: ["Agentic AI", "Amazon Bedrock"],
                              seat: .reserve, isFavorite: false, isRepeatOfFavorite: false)
        XCTAssertEqual(Wording.outlook(base), "Seat to reserve")
        XCTAssertEqual(Wording.reasons(base), "Shares Agentic AI, Amazon Bedrock")

        var walkUp = base
        walkUp.seat = .walkUp
        XCTAssertEqual(Wording.outlook(walkUp), "Walk-up line")

        var favorite = walkUp
        favorite.isFavorite = true
        XCTAssertEqual(Wording.outlook(favorite), "Your favorite · Walk-up line")

        var repeatRun = base
        repeatRun.isRepeatOfFavorite = true
        XCTAssertEqual(Wording.outlook(repeatRun), "Another run of a favorite · Seat to reserve")

        var nothingShared = base
        nothingShared.shared = []
        XCTAssertNil(Wording.reasons(nothingShared))
    }
}

final class GapStagingTests: XCTestCase {
    private let morning = Gap(date: "2027-03-09", start: 540, end: 660, before: .open, after: .at("South Pavilion"))
    private let afternoon = Gap(date: "2027-03-09", start: 780, end: 1080, before: .at("South Pavilion"), after: .open)

    func testTheRequestedDayOpensItsFirstFreeStretch() {
        XCTAssertEqual(GapStaging.gapToOpen(requestedDay: "2027-03-09", in: [morning, afternoon]), morning)
    }

    func testNoRequestOpensNothing() {
        XCTAssertEqual(GapStaging.gapToOpen(requestedDay: "2027-03-09", in: [morning]), morning) // precondition
        XCTAssertNil(GapStaging.gapToOpen(requestedDay: nil, in: [morning, afternoon]))
    }

    func testAnotherDayOrNoFreeStretchOpensNothing() {
        XCTAssertEqual(GapStaging.gapToOpen(requestedDay: "2027-03-09", in: [morning]), morning) // precondition
        XCTAssertNil(GapStaging.gapToOpen(requestedDay: "2027-03-10", in: [morning, afternoon]))
        XCTAssertNil(GapStaging.gapToOpen(requestedDay: "2027-03-09", in: []))
        XCTAssertNil(GapStaging.gapToOpen(requestedDay: "  ", in: [morning]))
    }
}
