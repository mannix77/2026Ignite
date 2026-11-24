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

/// A 30-minute session at the MGM Grand on an interest his favorite shares.
private func topical(_ id: String, _ time: String, date: String = "2026-12-02") -> Session {
    var s = session(id, date: date, time: time, length: "30", venue: "MGM Grand")
    s.topics = ["Observability"]
    return s
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

    // On the day itself: 09:00–10:00 and 12:00–13:00 held, so 10:00–12:00 is free.
    func testOnTheDayAStretchUnderWayStartsNow() {
        let plan = dayWithSeats(secondStart: "12:00")
        // Precondition: without a time the whole stretch is offered.
        XCTAssertEqual(plan.offeredGaps(on: "2026-12-02").map { [$0.start, $0.end] }, [[600, 720]])
        // At 11:00 it starts now, and so does his time in line; where he walks from and to is unchanged.
        XCTAssertEqual(plan.offeredGaps(on: "2026-12-02", now: ("2026-12-02", 660)),
                       [Gap(date: "2026-12-02", start: 660, end: 720, before: .at("MGM Grand"), after: .at("MGM Grand"),
                            lineFrom: 660, lineUpAfter: true)])
        // Before it starts, it is left as it is.
        XCTAssertEqual(plan.offeredGaps(on: "2026-12-02", now: ("2026-12-02", 540)).map { [$0.start, $0.end] }, [[600, 720]])
    }

    func testTheMinuteNowIsKnownOnlyOnTheSameDay() {
        XCTAssertEqual(PlanSnapshot.minute(of: ("2026-12-02", 660), on: "2026-12-02"), 660)
        XCTAssertNil(PlanSnapshot.minute(of: ("2026-12-01", 660), on: "2026-12-02"))
        XCTAssertNil(PlanSnapshot.minute(of: ("2026-12-03", 660), on: "2026-12-02"))
        // Midnight is a minute like any other, not "no time".
        XCTAssertEqual(PlanSnapshot.minute(of: ("2026-12-02", 0), on: "2026-12-02"), 0)
    }

    func testAnotherDayIsNotCut() {
        let plan = dayWithSeats(secondStart: "12:00")
        // 11:00 on the day before and the day after: the whole stretch on 2 Dec is still offered.
        XCTAssertEqual(plan.offeredGaps(on: "2026-12-02", now: ("2026-12-01", 660)).map { [$0.start, $0.end] }, [[600, 720]])
        XCTAssertEqual(plan.offeredGaps(on: "2026-12-02", now: ("2026-12-03", 660)).map { [$0.start, $0.end] }, [[600, 720]])
        // The same minute on 2 Dec itself cuts it.
        XCTAssertEqual(plan.offeredGaps(on: "2026-12-02", now: ("2026-12-02", 660)).map { [$0.start, $0.end] }, [[660, 720]])
    }

    func testOnTheDayAStretchWithUnderThirtyMinutesLeftIsNotOffered() {
        let plan = dayWithSeats(secondStart: "12:00")
        XCTAssertEqual(plan.offeredGaps(on: "2026-12-02", now: ("2026-12-02", 690)).map { [$0.start, $0.end] }, [[690, 720]])
        XCTAssertEqual(plan.offeredGaps(on: "2026-12-02", now: ("2026-12-02", 691)).map { [$0.start, $0.end] }, [])
        // Over: not offered.
        XCTAssertEqual(plan.offeredGaps(on: "2026-12-02", now: ("2026-12-02", 720)).map { [$0.start, $0.end] }, [])
    }

    func testAStretchUnderWayListsNothingThatHasStarted() {
        // A favorite on another day gives him a profile; "began" started at 10:40, "next" starts at 11:40, both
        // at the MGM Grand: 8 minutes' walk inside it, then 30 in line.
        var plan = dayWithSeats(secondStart: "13:00")
        plan.sessions += [topical("fav", "15:00", date: "2026-12-03"), topical("began", "10:40"), topical("next", "11:40")]
        plan.schedule.favorites = ["fav"]
        // Precondition: the whole stretch lists both.
        let whole = plan.offeredGaps(on: "2026-12-02")
        XCTAssertEqual(whole.map { [$0.start, $0.end] }, [[600, 780]])
        XCTAssertEqual(Set(plan.suggestions(in: whole[0]).map(\.id)), ["began", "next"])

        let now = plan.offeredGaps(on: "2026-12-02", now: ("2026-12-02", 660))
        XCTAssertEqual(now.map { [$0.start, $0.end] }, [[660, 780]])
        XCTAssertEqual(plan.suggestions(in: now[0]).map(\.id), ["next"])
    }

    func testPartWayThroughAGapHeStillWalksAndLinesUpFromNow() {
        // Seats at the MGM Grand 09:00–10:00 and 14:00–15:00; at 11:00 a session there needs the
        // 8-minute walk inside the venue, then 30 minutes in line: 11:38.
        var plan = dayWithSeats(secondStart: "14:00")
        plan.sessions += [topical("fav", "15:00", date: "2026-12-03"),
                          topical("onTime", "11:38"), topical("oneShort", "11:37")]
        plan.schedule.favorites = ["fav"]
        // Precondition: without a time both fit the whole stretch from 10:00.
        let whole = plan.offeredGaps(on: "2026-12-02")
        XCTAssertEqual(Set(plan.suggestions(in: whole[0]).map(\.id)), ["onTime", "oneShort"])
        let now = plan.offeredGaps(on: "2026-12-02", now: ("2026-12-02", 660))
        XCTAssertEqual(now.map { [$0.start, $0.end] }, [[660, 840]])
        XCTAssertEqual(plan.suggestions(in: now[0]).map(\.id), ["onTime"])
    }

    func testAFreeMorningLinesUpBeforeItsFirstSessionsButNotBeforeNow() {
        // Nothing held before a 12:00 seat; the day's sessions start at 08:00.
        var plan = PlanSnapshot(sessions: [session("seat", time: "12:00", venue: "MGM Grand")],
                                schedule: Schedule(reserved: ["seat"], favorites: ["fav"]),
                                fetchedAt: Date(timeIntervalSince1970: 0))
        plan.sessions += [topical("fav", "15:00", date: "2026-12-03"), topical("first", "08:00"),
                          topical("onTime", "09:40"), topical("oneShort", "09:39")]
        let morning = plan.offeredGaps(on: "2026-12-02")
        XCTAssertEqual(morning.map { [$0.start, $0.end] }, [[480, 720]])
        XCTAssertEqual(Set(plan.suggestions(in: morning[0]).map(\.id)), ["first", "onTime", "oneShort"])
        // At 09:10 he has to be in line by the start: 09:40 fits, 09:39 does not.
        let now = plan.offeredGaps(on: "2026-12-02", now: ("2026-12-02", 550))
        XCTAssertEqual(now.map { [$0.start, $0.end] }, [[550, 720]])
        XCTAssertEqual(plan.suggestions(in: now[0]).map(\.id), ["onTime"])
    }

    func testJustBeforeTheDayStartsHeCanOnlyLineUpFromNow() {
        // Nothing held before a 12:00 seat; the day's sessions start at 08:00. At 07:45 the
        // stretch still opens at 08:00, but he can't be in line before 07:45: 08:15 at the earliest.
        var plan = PlanSnapshot(sessions: [session("seat", time: "12:00", venue: "MGM Grand")],
                                schedule: Schedule(reserved: ["seat"], favorites: ["fav"]),
                                fetchedAt: Date(timeIntervalSince1970: 0))
        plan.sessions += [topical("fav", "15:00", date: "2026-12-03"), topical("first", "08:00"),
                          topical("onTime", "08:15"), topical("oneShort", "08:14")]
        // Precondition: with no time, all three fit the morning.
        let whole = plan.offeredGaps(on: "2026-12-02")
        XCTAssertEqual(Set(plan.suggestions(in: whole[0]).map(\.id)), ["first", "onTime", "oneShort"])
        let early = plan.offeredGaps(on: "2026-12-02", now: ("2026-12-02", 465))
        XCTAssertEqual(early, [Gap(date: "2026-12-02", start: 480, end: 720, before: .open, after: .at("MGM Grand"),
                                   lineFrom: 465, lineUpAfter: true)])
        XCTAssertEqual(plan.suggestions(in: early[0]).map(\.id), ["onTime"])
        // Long before the day starts, now changes nothing.
        let dawn = plan.offeredGaps(on: "2026-12-02", now: ("2026-12-02", 360))
        XCTAssertEqual(Set(plan.suggestions(in: dawn[0]).map(\.id)), ["first", "onTime", "oneShort"])
    }

    func testAnIndexPassedInGivesTheSameGaps() {
        let plan = dayWithSeats(secondStart: "10:30")
        XCTAssertEqual(plan.offeredGaps(on: "2026-12-02", index: plan.sessionsByID).map { [$0.start, $0.end] },
                       [[600, 630]])
        XCTAssertEqual(plan.gaps(on: "2026-12-02", index: plan.sessionsByID).map { [$0.start, $0.end] }, [[600, 630]])
    }

    func testTheGapIsWordedAsFreeTime() {
        let gap = Gap(date: "2026-12-02", start: 600, end: 630, before: .open, after: .open,
                      lineFrom: nil, lineUpAfter: false)
        XCTAssertEqual(Wording.gap(gap), "Free 10:00 – 10:30 AM")
        let acrossNoon = Gap(date: "2026-12-02", start: 690, end: 810, before: .open, after: .open,
                             lineFrom: nil, lineUpAfter: false)
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
    private let morning = Gap(date: "2027-03-09", start: 540, end: 660, before: .open, after: .at("South Pavilion"),
                              lineFrom: nil, lineUpAfter: false)
    private let afternoon = Gap(date: "2027-03-09", start: 780, end: 1080, before: .at("South Pavilion"), after: .open,
                                lineFrom: 780, lineUpAfter: false)

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

final class CurrentGapTests: XCTestCase {
    func testAnOpenStretchFollowsTheTimeAndEndsWhenItIsNoLongerOffered() {
        // Seats at the MGM Grand 09:00–10:00 and 12:00–13:00, and the day's sessions run to 16:00:
        // stretches 10:00–12:00 and 13:00–16:00. The first is opened at 10:30.
        let plan = PlanSnapshot(sessions: [session("first", time: "09:00"), session("second", time: "12:00"),
                                           session("late", time: "15:00")],
                                schedule: Schedule(reserved: ["first", "second"], favorites: []),
                                fetchedAt: Date(timeIntervalSince1970: 0))
        let opened = plan.offeredGaps(on: "2026-12-02", now: ("2026-12-02", 630))
        XCTAssertEqual(opened.map { [$0.start, $0.end] }, [[630, 720], [780, 960]]) // precondition
        // At 11:00 it is the same stretch, now starting and lining up from 11:00.
        let later = opened[0].current(in: plan.offeredGaps(on: "2026-12-02", now: ("2026-12-02", 660)))
        XCTAssertEqual(later, Gap(date: "2026-12-02", start: 660, end: 720, before: .at("MGM Grand"),
                                  after: .at("MGM Grand"), lineFrom: 660, lineUpAfter: true))
        // The afternoon stretch follows itself, not the morning one.
        XCTAssertEqual(opened[1].current(in: plan.offeredGaps(on: "2026-12-02", now: ("2026-12-02", 660)))?.end, 960)
        // At 11:31 it has under 30 minutes left and is no longer offered.
        XCTAssertNil(opened[0].current(in: plan.offeredGaps(on: "2026-12-02", now: ("2026-12-02", 691))))
        // A stretch ending at the same minute on another day is not it.
        var otherDay = opened[0]
        otherDay.date = "2026-12-03"
        XCTAssertNil(otherDay.current(in: plan.offeredGaps(on: "2026-12-02", now: ("2026-12-02", 660))))
    }
}

final class GapSuggestionsTests: XCTestCase {
    func testAListIsShownOnlyForTheStretchItWasWorkedOutFor() {
        let at11 = Gap(date: "2026-12-02", start: 660, end: 720, before: .at("MGM Grand"), after: .at("MGM Grand"),
                       lineFrom: 660, lineUpAfter: true)
        var at1101 = at11
        at1101.start = 661
        at1101.lineFrom = 661
        let found = [Suggestion(session: session("s"), score: 1, shared: [], seat: .walkUp, isFavorite: false,
                                isRepeatOfFavorite: false)]
        let loaded = GapSuggestions(gap: at11, suggestions: found)
        XCTAssertEqual(loaded.list(for: at11), found)
        // A minute later the same stretch has moved on: its list is still loading, the old one is hidden.
        XCTAssertNil(loaded.list(for: at1101))
        // Only the line moving on is enough to hide it too.
        var lineOnly = at11
        lineOnly.lineFrom = 661
        XCTAssertNil(loaded.list(for: lineOnly))
        // An empty list for the current stretch is an answer ("Nothing fits"), not "still loading".
        XCTAssertEqual(GapSuggestions(gap: at11, suggestions: []).list(for: at11), [])
    }
}
