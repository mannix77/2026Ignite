import XCTest
@testable import PlannerCore

/// A catalog session with the traits suggestions are ranked on.
private func offered(_ id: String, code: String? = nil, time: String = "12:00", length: String = "60",
                     date: String = "2026-12-02", venue: String? = "Caesars Forum", topics: [String] = [],
                     areas: [String] = [], services: [String] = [], level: String? = nil, type: String? = nil,
                     seats: String? = nil, reservable: Bool? = nil, allDay: Bool = false) -> Session {
    Session(sessionId: id, title: "Title \(id)", abbreviation: code ?? id.uppercased(), type: type, level: level,
            venue: venue, isAllDaySession: allDay, isReservable: reservable, seatAvailability: seats,
            sessionTime: SessionTime(date: date, time: time, length: length), topics: topics,
            areasOfInterest: areas, services: services)
}

/// Sessions that only fill out the catalog, so that "Filler" is a common trait and the traits
/// under test are rare. They sit on another day, so they are never in the gap.
private func filler(_ count: Int) -> [Session] {
    (0..<count).map { offered("f\($0)", date: "2026-12-03", topics: ["Filler"]) }
}

private func snapshot(_ sessions: [Session], reserved: [String] = [], favorites: [String] = [],
                      invited: [Session] = []) -> PlanSnapshot {
    PlanSnapshot(sessions: sessions,
                 schedule: Schedule(reserved: reserved, favorites: favorites, invitedSessions: invited),
                 fetchedAt: Date(timeIntervalSince1970: 0))
}

/// 10:00 to 16:00 on 2 Dec, coming from a seat at the Forum and going back to another there.
private let forumGap = Gap(date: "2026-12-02", start: 600, end: 960,
                           before: .at("Caesars Forum"), after: .at("Caesars Forum"),
                           lineFrom: 600, lineUpAfter: true)

private func ids(_ suggestions: [Suggestion]) -> [String] { suggestions.map(\.session.sessionId) }

final class WalkTests: XCTestCase {
    func testWalksAreThePlannersPublishedEstimatesInBothDirections() {
        // From the retired web planner's Las Vegas model (assets/js/conferences.js, LAS_VEGAS_DEF,
        // removed in #173), with the venue names the Events API sends.
        let table: [(String, String, Int)] = [
            ("Venetian", "Wynn/Encore", 15), ("Caesars Forum", "Venetian", 15),
            ("Caesars Palace", "Caesars Forum", 10), ("Caesars Palace", "Venetian", 15),
            ("Caesars Palace", "Wynn/Encore", 25), ("Caesars Forum", "Wynn/Encore", 20),
            ("Caesars Palace", "MGM Grand", 35), ("Caesars Forum", "MGM Grand", 35),
            ("MGM Grand", "Venetian", 35), ("MGM Grand", "Wynn/Encore", 35),
        ]
        for (a, b, minutes) in table {
            XCTAssertEqual(Walks.minutes(from: a, to: b), minutes, "\(a) to \(b)")
            XCTAssertEqual(Walks.minutes(from: b, to: a), minutes, "\(b) to \(a)")
        }
        // Every pair of the five venues is covered.
        let venues = ["Venetian", "Wynn/Encore", "Caesars Forum", "Caesars Palace", "MGM Grand"]
        XCTAssertEqual(Set(table.map { Set([$0.0, $0.1]) }).count, venues.count * (venues.count - 1) / 2)
    }

    func testInsideOneVenueAndUnknownVenues() {
        XCTAssertEqual(Walks.minutes(from: "MGM Grand", to: "MGM Grand"), 8)
        XCTAssertEqual(Walks.minutes(from: "MGM Grand", to: nil), 15)
        XCTAssertEqual(Walks.minutes(from: nil, to: "Venetian"), 15)
        XCTAssertEqual(Walks.minutes(from: nil, to: nil), 15)
        XCTAssertEqual(Walks.minutes(from: "Sphere", to: "Venetian"), 15)
    }
}

final class GapTests: XCTestCase {
    func testAFreeDayIsOneGapFromTheFirstSessionToTheLastWithNoWalk() {
        // An all-day session (the expo) does not stretch the day.
        let plan = snapshot([offered("a", time: "08:00", length: "60", topics: ["X"]),
                             offered("b", time: "17:00", length: "120", topics: ["X"]),
                             offered("expo", time: "00:00", length: "1440", allDay: true),
                             offered("other", time: "06:00", length: "60", date: "2026-12-03")])
        XCTAssertEqual(plan.gaps(on: "2026-12-02"),
                       [Gap(date: "2026-12-02", start: 480, end: 1140, before: .open, after: .open,
                            lineFrom: nil, lineUpAfter: false)])
    }

    func testGapsSitBeforeBetweenAndAfterCommitmentsWithTheirVenues() {
        let plan = snapshot([offered("early", time: "08:00", length: "30"),
                             offered("late", time: "18:00", length: "60"),
                             offered("seat1", time: "10:00", length: "60", venue: "MGM Grand"),
                             offered("seat2", time: "13:00", length: "60", venue: nil),
                             offered("fav", time: "11:00", length: "60")],
                            reserved: ["seat1", "seat2"], favorites: ["fav"],
                            invited: [offered("party", time: "15:00", length: "60", venue: "Venetian")])
        // He lines up inside every gap but the one that opens the day, and for the seats after a
        // gap but not for the invitation.
        XCTAssertEqual(plan.gaps(on: "2026-12-02"), [
            Gap(date: "2026-12-02", start: 480, end: 600, before: .open, after: .at("MGM Grand"),
                lineFrom: nil, lineUpAfter: true),
            Gap(date: "2026-12-02", start: 660, end: 780, before: .at("MGM Grand"), after: .at(nil),
                lineFrom: 660, lineUpAfter: true),
            Gap(date: "2026-12-02", start: 840, end: 900, before: .at(nil), after: .at("Venetian"),
                lineFrom: 840, lineUpAfter: false),
            Gap(date: "2026-12-02", start: 960, end: 1140, before: .at("Venetian"), after: .open,
                lineFrom: 960, lineUpAfter: false),
        ])
    }

    func testAfterOverlappingCommitmentsTheGapStartsWhenTheLaterOneEnds() {
        let plan = snapshot([offered("day", time: "08:00", length: "600"),
                             offered("long", time: "09:00", length: "180", venue: "Wynn/Encore"),
                             offered("short", time: "10:00", length: "30", venue: "Venetian")],
                            reserved: ["long", "short"])
        XCTAssertEqual(plan.gaps(on: "2026-12-02"), [
            Gap(date: "2026-12-02", start: 480, end: 540, before: .open, after: .at("Wynn/Encore"),
                lineFrom: nil, lineUpAfter: true),
            Gap(date: "2026-12-02", start: 720, end: 1080, before: .at("Wynn/Encore"), after: .open,
                lineFrom: 720, lineUpAfter: false),
        ])
    }

    func testACommitmentListedWithNoLengthBlocksTheTimeTheCalendarDrawsIt() {
        let party = offered("party", time: "10:00", length: "0", venue: "MGM Grand")
        XCTAssertEqual(party.sessionTime?.lengthMinutes, 0) // precondition: the 20 minutes come from the drawing
        let plan = snapshot([offered("a", time: "08:00", length: "60"), offered("b", time: "18:00", length: "60")],
                            invited: [party])
        XCTAssertEqual(plan.gaps(on: "2026-12-02"), [
            Gap(date: "2026-12-02", start: 480, end: 600, before: .open, after: .at("MGM Grand"),
                lineFrom: nil, lineUpAfter: false),
            Gap(date: "2026-12-02", start: 620, end: 1140, before: .at("MGM Grand"), after: .open,
                lineFrom: 620, lineUpAfter: false),
        ])
    }

    func testAnInvitationLaterThanEverySessionStretchesTheDay() {
        let plan = snapshot([offered("a", time: "08:00", length: "60")],
                            invited: [offered("party", time: "20:00", length: "180", venue: "Venetian")])
        XCTAssertEqual(plan.gaps(on: "2026-12-02"),
                       [Gap(date: "2026-12-02", start: 480, end: 1200, before: .open, after: .at("Venetian"),
                            lineFrom: nil, lineUpAfter: false)])
    }

    func testOfCommitmentsEndingTogetherHeIsAtTheOneThatStartedLater() {
        let plan = snapshot([offered("day", time: "08:00", length: "600"),
                             offered("long", time: "09:00", length: "120", venue: "Wynn/Encore"),
                             offered("short", time: "10:00", length: "60", venue: "Venetian")],
                            reserved: ["long", "short"])
        XCTAssertEqual(plan.gaps(on: "2026-12-02").last,
                       Gap(date: "2026-12-02", start: 660, end: 1080, before: .at("Venetian"), after: .open,
                           lineFrom: 660, lineUpAfter: false))
    }

    func testBackToBackCommitmentsLeaveNoGapAndADayWithNoSessionsHasNone() {
        let plan = snapshot([offered("a", time: "09:00", length: "60"), offered("b", time: "10:00", length: "60")],
                            reserved: ["a", "b"])
        XCTAssertEqual(plan.gaps(on: "2026-12-02"), [])
        XCTAssertEqual(plan.gaps(on: "2026-12-05"), [])
    }
}

final class SuggestionTests: XCTestCase {
    func testASessionMustLeaveTimeForTheWalkAndTheLineThereAndBack() {
        // Forum to Wynn is 20 minutes each way, and he is in line 30 minutes before each start.
        // The seat ends at 10:00 and the next is at 16:00: in by 10:50, out by 15:10.
        let plan = snapshot(filler(4) + [
            offered("pick", time: "09:00", topics: ["Rare"]),
            offered("onTime", time: "10:50", venue: "Wynn/Encore", topics: ["Rare"]),
            offered("oneShort", time: "10:49", venue: "Wynn/Encore", topics: ["Rare"]),
            offered("backInTime", time: "14:10", venue: "Wynn/Encore", topics: ["Rare"]),
            offered("backLate", time: "14:11", venue: "Wynn/Encore", topics: ["Rare"]),
        ], favorites: ["pick"])
        let listed = Set(ids(plan.suggestions(in: forumGap)))
        XCTAssertEqual(listed, ["onTime", "backInTime"])
    }

    func testTheDayRunsToTheDrawnEndOfALastSessionWithNoLength() {
        // His seat is 09:00–10:00; the day's last catalog session starts at 12:00 with no length,
        // so the day ends at 12:20, the end the calendar draws for it.
        let last = offered("last", time: "12:00", length: "")
        XCTAssertEqual(last.sessionTime?.lengthMinutes, 0)
        let plan = snapshot([offered("seat", time: "09:00"), last], reserved: ["seat"])
        XCTAssertEqual(plan.gaps(on: "2026-12-02"),
                       [Gap(date: "2026-12-02", start: 600, end: 740, before: .at("Caesars Forum"), after: .open,
                            lineFrom: 600, lineUpAfter: false)])
    }

    func testASessionWithNoLengthTakesTheTwentyMinutesTheCalendarDrawsForIt() {
        // In line at the Forum by 15:30 means leaving Wynn by 15:10. Listed with no length, a
        // session still takes the 20 minutes the calendar would draw it for once reserved.
        let fits = offered("fits", time: "14:50", length: "", venue: "Wynn/Encore", topics: ["Rare"])
        let runsOver = offered("runsOver", time: "14:51", length: "", venue: "Wynn/Encore", topics: ["Rare"])
        // Precondition: both are listed with no length, so the 20 minutes come from the drawing.
        XCTAssertEqual(fits.sessionTime?.lengthMinutes, 0)
        XCTAssertEqual(runsOver.sessionTime?.lengthMinutes, 0)
        let plan = snapshot(filler(4) + [offered("pick", time: "09:00", topics: ["Rare"]), fits, runsOver],
                            favorites: ["pick"])
        let listed = Set(ids(plan.suggestions(in: forumGap)))
        XCTAssertEqual(listed, ["fits"])
    }

    func testTheWalkInUsesTheVenueBeforeAndTheWalkOutTheVenueAfter() {
        // MGM to the Forum is 35 minutes; the Forum to the Wynn is 20; 30 in line at each end.
        let gap = Gap(date: "2026-12-02", start: 600, end: 960, before: .at("MGM Grand"), after: .at("Wynn/Encore"),
                      lineFrom: 600, lineUpAfter: true)
        let plan = snapshot(filler(4) + [
            offered("pick", time: "09:00", topics: ["Rare"]),
            offered("onTime", time: "11:05", topics: ["Rare"]), offered("oneShort", time: "11:04", topics: ["Rare"]),
            offered("backInTime", time: "14:10", topics: ["Rare"]), offered("backLate", time: "14:11", topics: ["Rare"]),
        ], favorites: ["pick"])
        XCTAssertEqual(Set(ids(plan.suggestions(in: gap))), ["onTime", "backInTime"])
    }

    func testFromTheStartOfTheDayThereIsNoWalkAndNoLineInTheGap() {
        // He can line up before the day's first sessions, so one starting as the day does fits.
        let gap = Gap(date: "2026-12-02", start: 480, end: 600, before: .open, after: .open,
                      lineFrom: nil, lineUpAfter: false)
        let plan = snapshot(filler(4) + [offered("pick", time: "13:00", topics: ["Rare"]),
                                         offered("first", time: "08:00", length: "120", venue: "MGM Grand",
                                                 topics: ["Rare"])],
                            favorites: ["pick"])
        XCTAssertEqual(ids(plan.suggestions(in: gap)), ["first"])
    }

    func testAWalkUpSessionNeedsFiveMinutesInLineButTheSeatAfterItStillThirty() {
        // Forum to Wynn is 20 minutes. Into a walk-up: 10:00 + 20 + 5 = 10:25. Out of it, back in
        // line for the 16:00 seat: 16:00 - 30 - 20 = 15:10.
        func walkUp(_ id: String, _ time: String) -> Session {
            offered(id, time: time, venue: "Wynn/Encore", topics: ["Rare"], reservable: false)
        }
        let plan = snapshot(filler(4) + [
            offered("pick", time: "09:00", topics: ["Rare"]),
            walkUp("onTime", "10:25"), walkUp("oneShort", "10:24"),
            walkUp("backInTime", "14:10"), walkUp("backLate", "14:11"),
            // The same start as "onTime", but one he can reserve: 30 minutes in line.
            offered("reservable", time: "10:25", venue: "Wynn/Encore", topics: ["Rare"], reservable: true),
        ], favorites: ["pick"])
        XCTAssertEqual(Set(ids(plan.suggestions(in: forumGap))), ["onTime", "backInTime"])
    }

    func testHisTimeInLineIsUsedBeforeTheSessionAndBeforeTheSeatAfterIt() {
        // With 10 minutes in line: in by 10:00 + 20 + 10 = 10:30, out by 16:00 - 10 - 20 = 15:30.
        let plan = snapshot(filler(4) + [
            offered("pick", time: "09:00", topics: ["Rare"]),
            offered("onTime", time: "10:30", venue: "Wynn/Encore", topics: ["Rare"], reservable: true),
            offered("oneShort", time: "10:29", venue: "Wynn/Encore", topics: ["Rare"], reservable: true),
            offered("backInTime", time: "14:30", venue: "Wynn/Encore", topics: ["Rare"], reservable: true),
            offered("backLate", time: "14:31", venue: "Wynn/Encore", topics: ["Rare"], reservable: true),
        ], favorites: ["pick"])
        // Precondition: with the default 30 minutes none of them fits.
        XCTAssertEqual(Set(ids(plan.suggestions(in: forumGap))), [])
        XCTAssertEqual(Set(ids(plan.suggestions(in: forumGap, lineUp: LineUp(minutes: 10)))), ["onTime", "backInTime"])
        // A walk-up with 3 minutes set needs only 3: 10:00 + 20 + 3 = 10:23.
        let walkUps = snapshot(filler(4) + [
            offered("pick", time: "09:00", topics: ["Rare"]),
            offered("in3", time: "10:23", venue: "Wynn/Encore", topics: ["Rare"], reservable: false),
            offered("in2", time: "10:22", venue: "Wynn/Encore", topics: ["Rare"], reservable: false),
        ], favorites: ["pick"])
        XCTAssertEqual(Set(ids(walkUps.suggestions(in: forumGap, lineUp: LineUp(minutes: 3)))), ["in3"])
        XCTAssertEqual(Set(ids(walkUps.suggestions(in: forumGap))), [])
    }

    func testHeLinesUpForAReservedSeatAfterTheGapButNotForAnInvitation() {
        // From a seat at the Forum ending at 10:00 to a 16:00 commitment at the Forum, with
        // sessions at the Wynn, 20 minutes away. Reserved next: out by 15:10. Invited: by 15:40.
        let candidates = [
            offered("pick", time: "09:00", topics: ["Rare"]),
            offered("beforeTheLine", time: "14:10", venue: "Wynn/Encore", topics: ["Rare"]),
            offered("intoTheLine", time: "14:11", venue: "Wynn/Encore", topics: ["Rare"]),
            offered("beforeTheWalk", time: "14:40", venue: "Wynn/Encore", topics: ["Rare"]),
            offered("pastTheWalk", time: "14:41", venue: "Wynn/Encore", topics: ["Rare"]),
        ]
        let seat = offered("seat", time: "09:00")
        let next = offered("next", time: "16:00")
        let reservedNext = snapshot(filler(4) + candidates + [seat, next], reserved: ["seat", "next"], favorites: ["pick"])
        let invitedNext = snapshot(filler(4) + candidates + [seat], reserved: ["seat"], favorites: ["pick"],
                                   invited: [next])
        let reservedGap = reservedNext.gaps(on: "2026-12-02")
        let invitedGap = invitedNext.gaps(on: "2026-12-02")
        // Precondition: the same stretch either way, 10:00 to 16:00.
        XCTAssertEqual(reservedGap.map { [$0.start, $0.end] }, [[600, 960]])
        XCTAssertEqual(invitedGap.map { [$0.start, $0.end] }, [[600, 960]])
        XCTAssertEqual(Set(ids(reservedNext.suggestions(in: reservedGap[0]))), ["beforeTheLine"])
        XCTAssertEqual(Set(ids(invitedNext.suggestions(in: invitedGap[0]))), ["beforeTheLine", "intoTheLine", "beforeTheWalk"])
    }

    func testASeatAndAnInvitationAtTheSameMinuteEndTheGapAtTheSeat() {
        // At 16:00 he holds a seat at the Wynn and is invited to the Venetian. The seat counts:
        // from the Forum that is 20 minutes' walk and 30 in line, so out by 15:10.
        let plan = snapshot(filler(4) + [
            offered("pick", time: "09:00", topics: ["Rare"]),
            offered("seat", time: "09:00"),
            offered("next", time: "16:00", venue: "Wynn/Encore"),
            offered("inTime", time: "14:10", topics: ["Rare"]),
            offered("late", time: "14:11", topics: ["Rare"]),
        ], reserved: ["seat", "next"], favorites: ["pick"],
           invited: [offered("party", time: "16:00", venue: "Venetian")])
        let gaps = plan.gaps(on: "2026-12-02")
        XCTAssertEqual(gaps.first, Gap(date: "2026-12-02", start: 600, end: 960, before: .at("Caesars Forum"),
                                       after: .at("Wynn/Encore"), lineFrom: 600, lineUpAfter: true))
        XCTAssertEqual(ids(plan.suggestions(in: gaps[0])), ["inTime"])
    }

    func testNothingHeHoldsNorItsRepeatIsListedButAFavoriteIs() {
        let plan = snapshot(filler(6) + [
            offered("seat", code: "AIM320", time: "11:00", topics: ["Rare"]),
            offered("seatRepeat", code: "AIM320-R1", time: "12:00", topics: ["Rare"]),
            offered("party", code: "PTY001", time: "13:00", topics: ["Rare"]),
            offered("partyRepeat", code: "PTY001-R", time: "14:00", topics: ["Rare"]),
            offered("fav", code: "COP305", time: "12:00", topics: ["Rare"]),
            offered("other", code: "DEV200", time: "12:00", topics: ["Rare"]),
        ], reserved: ["seat"], favorites: ["fav"],
           invited: [offered("party", code: "PTY001", time: "13:00", topics: ["Rare"])])
        let found = plan.suggestions(in: forumGap)
        XCTAssertEqual(Set(ids(found)), ["fav", "other"])
        XCTAssertEqual(found.first { $0.session.sessionId == "fav" }?.isFavorite, true)
        XCTAssertEqual(found.first { $0.session.sessionId == "other" }?.isFavorite, false)
        // A favorite is not a repeat of itself.
        XCTAssertEqual(found.first { $0.session.sessionId == "fav" }?.isRepeatOfFavorite, false)
    }

    func testTheRepeatOfAFavoriteThatClashesIsMarkedAsTheSameSession() {
        let plan = snapshot(filler(4) + [
            offered("fav", code: "COP319", time: "09:00", topics: ["Rare"]),
            offered("favRepeat", code: "COP319-R1", time: "12:00", topics: ["Rare"]),
            offered("other", code: "DEV200", time: "12:00", topics: ["Rare"]),
        ], favorites: ["fav"])
        let found = plan.suggestions(in: forumGap)
        XCTAssertEqual(Set(ids(found)), ["favRepeat", "other"])
        XCTAssertEqual(found.first { $0.session.sessionId == "favRepeat" }?.isRepeatOfFavorite, true)
        XCTAssertEqual(found.first { $0.session.sessionId == "other" }?.isRepeatOfFavorite, false)
    }

    func testARareSharedTraitOutranksACommonOneAndEachSaysWhatItShares() {
        // "Agentic AI" is on every pick and most of the catalog; "ADOT" is on one pick and one
        // other session, as "Kiro" is.
        let common = ["Agentic AI"]
        let plan = snapshot((0..<6).map { offered("c\($0)", date: "2026-12-03", areas: common) } + [
            offered("kiroTwin", date: "2026-12-03", services: ["Kiro"]),
            offered("p1", time: "09:00", areas: common, services: ["ADOT"]),
            offered("p2", time: "09:00", areas: common, services: ["Kiro"]),
            offered("aiOnly", time: "12:00", areas: common),
            offered("adot", time: "12:00", services: ["ADOT"]),
        ], favorites: ["p1", "p2"])
        let found = plan.suggestions(in: forumGap)
        XCTAssertEqual(ids(found), ["adot", "aiOnly"])
        XCTAssertEqual(found.map(\.shared), [["ADOT"], ["Agentic AI"]])
        XCTAssertGreaterThan(found[0].score, found[1].score)
    }

    func testAtMostThreeSharedTraitsAreGivenTheRarestFirst() {
        // "Z" is on 2 sessions, "Y" on 3, "X" on 4, "W" on 5: the rarer, the more it says.
        // Rarity runs against the alphabet, so name order can't pass for it.
        let plan = snapshot(filler(4) + [
            offered("pick", time: "09:00", topics: ["W", "Y", "Z", "X"]),
            offered("cand", topics: ["X", "Z", "W", "Y"]),
            offered("y1", date: "2026-12-03", topics: ["Y", "X", "W"]),
            offered("x1", date: "2026-12-03", topics: ["X", "W"]),
            offered("w1", date: "2026-12-03", topics: ["W"]),
        ], favorites: ["pick"])
        XCTAssertEqual(plan.suggestions(in: forumGap).map(\.shared), [["Z", "Y", "X"]])
    }

    func testLevelAndTypeAreInterestsToo() {
        let plan = snapshot(filler(4) + [
            offered("pick", time: "09:00", level: "300 – Advanced", type: "Workshop"),
            offered("sameLevel", code: "AAA1", level: "300 – Advanced"),
            offered("sameType", code: "BBB1", type: "Workshop"),
            offered("neither", code: "CCC1", level: "200 – Intermediate", type: "Chalk talk"),
        ], favorites: ["pick"])
        let found = plan.suggestions(in: forumGap)
        XCTAssertEqual(Set(ids(found)), ["sameLevel", "sameType"])
        XCTAssertEqual(Set(found.map(\.shared)), [["300 – Advanced"], ["Workshop"]])
    }

    func testANameUnderTwoHeadingsIsGivenOnce() {
        let plan = snapshot(filler(4) + [offered("pick", time: "09:00", topics: ["Security"], areas: ["Security"]),
                                         offered("cand", topics: ["Security"], areas: ["Security"])],
                            favorites: ["pick"])
        XCTAssertEqual(plan.suggestions(in: forumGap).map(\.shared), [["Security"]])
    }

    func testASessionTheCatalogListsTwiceIsSuggestedOnce() {
        let twice = offered("cand", topics: ["Rare"])
        let plan = snapshot(filler(4) + [offered("pick", time: "09:00", topics: ["Rare"]), twice, twice],
                            favorites: ["pick"])
        XCTAssertEqual(ids(plan.suggestions(in: forumGap)), ["cand"])
    }

    func testWithNoPicksNothingIsListed() {
        let plan = snapshot(filler(4) + [offered("cand", topics: ["Rare"]), offered("other", time: "09:00", topics: ["Rare"])])
        XCTAssertEqual(plan.sessions.filter { $0.sessionTime?.date == "2026-12-02" }.count, 2)
        XCTAssertEqual(ids(plan.suggestions(in: forumGap)), [])
    }

    func testARareTraitWeighsMoreInTheScore() {
        // "A" is on 2 of 4 sessions (weight ln 2), "B" on 1 (weight ln 4 = 2 ln 2). The pick's unit
        // vector is (1, 2)/sqrt(5) and the candidate's is (1, 0), so the score is 1/sqrt(5).
        let plan = snapshot([offered("pick", time: "09:00", topics: ["A", "B"]), offered("cand", topics: ["A"]),
                             offered("o1", date: "2026-12-03", topics: ["Y"]),
                             offered("o2", date: "2026-12-03", topics: ["Y"])],
                            favorites: ["pick"])
        let found = plan.suggestions(in: forumGap)
        XCTAssertEqual(ids(found), ["cand"])
        XCTAssertEqual(found[0].score, 0.4472135954999579, accuracy: 1e-12)
    }

    func testAScoreIsTheSimilarityToHisPicks() {
        // One pick and one candidate with the same single trait, shared by half the catalog:
        // their vectors are identical unit vectors, so the score is exactly 1.
        let plan = snapshot([offered("pick", time: "09:00", topics: ["X"]), offered("cand", topics: ["X"]),
                             offered("o1", date: "2026-12-03", topics: ["Y"]),
                             offered("o2", date: "2026-12-03", topics: ["Y"])],
                            favorites: ["pick"])
        let found = plan.suggestions(in: forumGap)
        XCTAssertEqual(ids(found), ["cand"])
        XCTAssertEqual(found[0].score, 1, accuracy: 1e-12)
        XCTAssertEqual(found[0].shared, ["X"])
        XCTAssertEqual(found[0].seat, .walkUp)
    }

    func testAReservedSeatCountsTwiceAndAnInvitationNotAtAll() {
        let plan = snapshot(filler(8) + [
            offered("seat", time: "09:00", topics: ["SeatTopic"]),
            offered("fav", time: "09:00", topics: ["FavTopic"]),
            offered("likeFav", time: "12:00", topics: ["FavTopic"]),
            offered("likeSeat", time: "12:00", topics: ["SeatTopic"]),
            offered("likeParty", time: "12:00", topics: ["PartyTopic"]),
            offered("partyTwin", date: "2026-12-03", topics: ["PartyTopic"]),
        ], reserved: ["seat"], favorites: ["fav"],
           invited: [offered("party", time: "17:00", topics: ["PartyTopic"])])
        let found = plan.suggestions(in: forumGap)
        XCTAssertEqual(ids(found), ["likeSeat", "likeFav"])
        // Each is a unit vector identical to its pick's, so the scores are the pick weights.
        XCTAssertEqual(found[0].score, 2, accuracy: 1e-12)
        XCTAssertEqual(found[1].score, 1, accuracy: 1e-12)
    }

    func testOfTwoEquallyLikeSessionsTheOneWithSeatsComesFirst() {
        let plan = snapshot(filler(4) + [
            offered("pick", time: "09:00", topics: ["Rare"]),
            offered("full", code: "AAA100", time: "11:00", topics: ["Rare"], seats: "unavailable", reservable: true),
            offered("open", code: "ZZZ100", time: "12:00", topics: ["Rare"], seats: "limited", reservable: true),
            offered("notReservable", code: "BBB100", time: "11:30", topics: ["Rare"], seats: "available",
                    reservable: false),
        ], favorites: ["pick"])
        let found = plan.suggestions(in: forumGap)
        XCTAssertEqual(ids(found), ["open", "full", "notReservable"])
        XCTAssertEqual(found.map(\.seat), [.reserve, .walkUp, .walkUp])
        XCTAssertEqual(Set(found.map(\.score)).count, 1)
    }

    func testEveryOpenSeatBandOffersAReservation() {
        for band in ["available", "limited", "veryLimited"] {
            let plan = snapshot(filler(4) + [offered("pick", time: "09:00", topics: ["Rare"]),
                                             offered("s", topics: ["Rare"], seats: band, reservable: true)],
                                favorites: ["pick"])
            XCTAssertEqual(plan.suggestions(in: forumGap).map(\.seat), [.reserve], band)
        }
        for band in ["unavailable", "walkUp", ""] {
            let plan = snapshot(filler(4) + [offered("pick", time: "09:00", topics: ["Rare"]),
                                             offered("s", topics: ["Rare"], seats: band, reservable: true)],
                                favorites: ["pick"])
            XCTAssertEqual(plan.suggestions(in: forumGap).map(\.seat), [.walkUp], band)
        }
    }

    func testASessionWithNothingInCommonIsNotListed() {
        let plan = snapshot(filler(4) + [offered("pick", time: "09:00", topics: ["Rare"]),
                                         offered("alike", topics: ["Rare"]),
                                         offered("unalike", topics: ["Elsewhere"]),
                                         offered("bare")],
                            favorites: ["pick"])
        XCTAssertEqual(ids(plan.suggestions(in: forumGap)), ["alike"])
    }

    func testNoLevelIsNotAnInterest() {
        let plan = snapshot(filler(4) + [
            offered("pick", time: "09:00", topics: ["Rare"], level: "No Level"),
            offered("reception", time: "18:00", length: "60", level: "No Level"),
            offered("talk", topics: ["Rare"], level: "No Level"),
        ], favorites: ["pick"])
        let gap = Gap(date: "2026-12-02", start: 600, end: 1200, before: .open, after: .open,
                      lineFrom: nil, lineUpAfter: false)
        let found = plan.suggestions(in: gap)
        XCTAssertEqual(ids(found), ["talk"])
        XCTAssertEqual(found.map(\.shared), [["Rare"]])
    }

    func testOneSuggesterAnswersEveryGap() {
        let plan = snapshot(filler(4) + [offered("pick", time: "09:00", topics: ["Rare"]),
                                         offered("noon", topics: ["Rare"]), offered("eve", time: "17:00", topics: ["Rare"])],
                            favorites: ["pick"])
        let suggester = Suggester(plan)
        let evening = Gap(date: "2026-12-02", start: 960, end: 1200, before: .open, after: .open,
                          lineFrom: nil, lineUpAfter: false)
        XCTAssertEqual(ids(suggester.suggestions(in: forumGap)), ["noon"])
        XCTAssertEqual(ids(suggester.suggestions(in: evening)), ["eve"])
    }

    func testOnlyTimedSessionsOnThatDayAreListed() {
        let plan = snapshot(filler(4) + [
            offered("pick", time: "09:00", topics: ["Rare"]),
            offered("today", topics: ["Rare"]),
            offered("tomorrow", date: "2026-12-03", topics: ["Rare"]),
            offered("allDay", topics: ["Rare"], allDay: true),
            Session(sessionId: "untimed", title: "Untimed", topics: ["Rare"]),
        ], favorites: ["pick"])
        XCTAssertEqual(ids(plan.suggestions(in: forumGap)), ["today"])
    }

    func testEqualSuggestionsAreInTimeThenCodeOrder() {
        let plan = snapshot(filler(4) + [
            offered("pick", time: "09:00", topics: ["Rare"]),
            offered("late", code: "AAA1", time: "13:00", topics: ["Rare"]),
            offered("earlyB", code: "BBB1", time: "11:00", topics: ["Rare"]),
            offered("earlyA", code: "AAA2", time: "11:00", topics: ["Rare"]),
        ], favorites: ["pick"])
        let found = plan.suggestions(in: forumGap)
        XCTAssertEqual(ids(found), ["earlyA", "earlyB", "late"])
        XCTAssertEqual(Set(found.map(\.score)).count, 1)
    }

    func testARepeatFamilyIsTheCodeWithoutItsRepeatSuffix() {
        let cases: [(String?, String)] = [
            ("AIM320-R1", "AIM320"), ("COP305-R", "COP305"), ("AIM110-S-SC2", "AIM110-S"),
            ("GHJ308-S-R", "GHJ308-S"), ("SEC213-S", "SEC213-S"), ("DAT317", "DAT317"),
            (" AIM320-R2 ", "AIM320"), (nil, "id1"), ("  ", "id1"),
        ]
        for (code, family) in cases {
            XCTAssertEqual(Session(sessionId: "id1", title: "T", abbreviation: code).family, family, code ?? "nil")
        }
    }
}
