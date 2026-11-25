import XCTest
@testable import PlannerCore

final class WalkInTests: XCTestCase {
    private func walkUp(_ id: String, time: String) -> Session {
        var s = session(id, time: time)
        s.isReservable = false
        return s
    }

    private func reservable(_ id: String, time: String) -> Session {
        var s = session(id, time: time)
        s.isReservable = true
        return s
    }

    private func plan(_ sessions: [Session], reserved: [String] = [], favorites: [String] = [],
                      invited: [Session] = []) -> PlanSnapshot {
        PlanSnapshot(sessions: sessions, schedule: Schedule(reserved: reserved, favorites: favorites, invitedSessions: invited),
                     fetchedAt: Date(timeIntervalSince1970: 1_800_000_000))
    }

    func testAFavoriteThatCantBeReservedGoesOnTheCalendarAsAWalkIn() {
        let snapshot = plan([walkUp("dev", time: "12:00"), walkUp("other", time: "12:00"), session("seat", time: "09:00")],
                            reserved: ["seat"], favorites: ["dev", "other"])
        // Before: both favorites wait in the favorites column.
        let before = snapshot.agenda(on: "2026-12-02", includeFavorites: true)
        XCTAssertEqual(before.commitments.map(\.id), ["seat"])
        XCTAssertEqual(before.favoriteBuckets.flatMap { $0.entries.map(\.id) }, ["dev", "other"])

        let marks = snapshot.commitments(walkIns: ["dev"])
        XCTAssertEqual(marks, ["seat": .reserved, "dev": .walkIn, "other": .favorite])
        let after = snapshot.agenda(on: "2026-12-02", includeFavorites: true, commitments: marks)
        XCTAssertEqual(after.commitments.map(\.id), ["seat", "dev"])
        XCTAssertEqual(after.commitments.map(\.commitment), [.reserved, .walkIn])
        XCTAssertEqual(after.favoriteBuckets.flatMap { $0.entries.map(\.id) }, ["other"])
        // With favorites hidden, the walk-in is still drawn.
        let quiet = snapshot.agenda(on: "2026-12-02", includeFavorites: false, commitments: marks)
        XCTAssertEqual(quiet.commitments.map(\.id), ["seat", "dev"])
    }

    func testOnlyAFavoriteThatCantBeReservedCanBeAWalkIn() {
        var unknown = session("unknown", time: "12:00")
        unknown.isReservable = nil
        let snapshot = plan([reservable("aim", time: "12:00"), walkUp("dev", time: "13:00"), walkUp("notFav", time: "14:00"),
                             unknown, reservable("seat", time: "09:00")],
                            reserved: ["seat"], favorites: ["aim", "dev", "unknown", "seat"])
        XCTAssertFalse(snapshot.canBeWalkIn("aim"))
        XCTAssertTrue(snapshot.canBeWalkIn("dev"))
        XCTAssertFalse(snapshot.canBeWalkIn("notFav"))
        // The site doesn't say it can be reserved, so there is no seat to reserve.
        XCTAssertTrue(snapshot.canBeWalkIn("unknown"))
        XCTAssertFalse(snapshot.canBeWalkIn("seat"))
        // Asked for anyway, the reservable favorite stays a favorite and the seat stays reserved.
        XCTAssertEqual(snapshot.commitments(walkIns: ["aim", "dev", "notFav", "seat"]),
                       ["aim": .favorite, "dev": .walkIn, "unknown": .favorite, "seat": .reserved])
    }

    func testAWalkInIsGoneOnceItIsNoLongerAFavorite() {
        let favorited = plan([walkUp("dev", time: "12:00")], favorites: ["dev"])
        XCTAssertEqual(favorited.commitments(walkIns: ["dev"]), ["dev": .walkIn])
        let unfavorited = plan([walkUp("dev", time: "12:00")], favorites: [])
        XCTAssertEqual(unfavorited.commitments(walkIns: ["dev"]), [:])
        XCTAssertEqual(unfavorited.agenda(on: "2026-12-02", includeFavorites: true,
                                          commitments: unfavorited.commitments(walkIns: ["dev"])).timed, [])
    }

    func testAWalkInSplitsTheDaysFreeStretches() {
        let snapshot = plan([session("first", time: "08:00"), walkUp("dev", time: "12:00"), session("last", time: "17:00")],
                            favorites: ["dev"])
        XCTAssertEqual(snapshot.gaps(on: "2026-12-02").map { [$0.start, $0.end] }, [[480, 1080]])
        let gaps = snapshot.gaps(on: "2026-12-02", commitments: snapshot.commitments(walkIns: ["dev"]))
        XCTAssertEqual(gaps.map { [$0.start, $0.end] }, [[480, 720], [780, 1080]])
        // No line to stand in for a walk-in after the gap: that is for a reserved seat.
        XCTAssertEqual(gaps.map(\.lineUpAfter), [false, false])
        let offered = snapshot.offeredGaps(on: "2026-12-02", commitments: snapshot.commitments(walkIns: ["dev"]))
        XCTAssertEqual(offered.map { [$0.start, $0.end] }, [[480, 720], [780, 1080]])
    }

    func testAWalkInIsNotSuggestedAgain() {
        var dev = walkUp("dev", time: "12:00")
        dev.topics = ["X"]
        var like = walkUp("like", time: "12:00")
        like.topics = ["X"]
        var pick = session("pick", time: "09:00")
        pick.topics = ["X"]
        let others = (0..<4).map { i -> Session in var s = session("o\(i)", date: "2026-12-03"); s.topics = ["Y"]; return s }
        let snapshot = plan([dev, like, pick] + others, favorites: ["dev", "pick"])
        let gap = Gap(date: "2026-12-02", start: 600, end: 960, before: .open, after: .open, lineFrom: nil, lineUpAfter: false)
        XCTAssertEqual(Suggester(snapshot).suggestions(in: gap).map(\.id), ["dev", "like"])
        let marks = snapshot.commitments(walkIns: ["dev"])
        XCTAssertEqual(Suggester(snapshot, commitments: marks).suggestions(in: gap).map(\.id), ["like"])
    }

    func testAReservedSeatShowsTenMinutesToBeThere() {
        let snapshot = plan([session("seat", time: "10:00"), walkUp("dev", time: "10:00"), session("inv", time: "10:00")],
                            reserved: ["seat"], favorites: ["dev"], invited: [session("inv", time: "10:00")])
        let day = snapshot.agenda(on: "2026-12-02", includeFavorites: true, commitments: snapshot.commitments(walkIns: ["dev"]))
        XCTAssertEqual(day.commitments.map(\.id), ["seat", "inv", "dev"])
        XCTAssertEqual(day.commitments.map(\.start), [600, 600, 600])
        XCTAssertEqual(day.commitments.map(\.arrival), [590, 600, 600])
        XCTAssertEqual(AgendaEntry.reservedArrivalMinutes, 10)
        XCTAssertEqual(Wording.beThere(by: 590), "Be there by 9:50 AM")
    }
}
