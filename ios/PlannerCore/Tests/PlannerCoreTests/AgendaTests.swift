import XCTest
@testable import PlannerCore

final class ModelsTests: XCTestCase {
    func testASessionIsReadAsTheSiteSendsIt() throws {
        let json = """
        {"sessionId": "1790358243294001io1w", "abbreviation": "AIM320-R1", "title": "A workshop",
         "abstract": "About it", "type": "Workshop", "level": "300 – Advanced",
         "venue": "Caesars Forum", "room": "Level 1 | Forum 110",
         "sessionTime": {"date": "2026-12-02", "time": "15:00", "length": "120"},
         "isAllDaySession": false, "isReservable": true, "seatAvailability": "unavailable",
         "speakers": [{"name": "Ada Example"}, {}], "topics": ["Artificial Intelligence"]}
        """
        let session = try JSONDecoder().decode(Session.self, from: Data(json.utf8))
        XCTAssertEqual(session.sessionId, "1790358243294001io1w")
        XCTAssertEqual(session.code, "AIM320-R1")
        XCTAssertEqual(session.venue, "Caesars Forum")
        XCTAssertEqual(session.sessionTime, SessionTime(date: "2026-12-02", time: "15:00", length: "120"))
        XCTAssertEqual(session.sessionTime?.startMinute, 900)
        XCTAssertEqual(session.sessionTime?.lengthMinutes, 120)
        XCTAssertEqual(session.isReservable, true)
        XCTAssertEqual(session.seatAvailability, "unavailable")
        XCTAssertEqual(session.speakerNames, ["Ada Example"])
        XCTAssertEqual(session.topics, ["Artificial Intelligence"])
    }

    func testOnlyIdAndTitleAreNeededAndAnOddFieldCostsOnlyThatField() throws {
        let bare = try JSONDecoder().decode(Session.self, from: Data(#"{"sessionId":" a1 ","title":"T"}"#.utf8))
        XCTAssertEqual(bare.sessionId, "a1")
        XCTAssertNil(bare.sessionTime)
        XCTAssertEqual(bare.code, "T")
        let odd = try JSONDecoder().decode(
            Session.self, from: Data(#"{"sessionId":"a1","title":"T","venue":7,"sessionTime":"soon","room":"R1"}"#.utf8))
        XCTAssertNil(odd.venue)
        XCTAssertNil(odd.sessionTime)
        XCTAssertEqual(odd.room, "R1")
    }

    func testASessionWithoutAUsableIdOrTitleIsRefused() {
        for json in [#"{"title":"T"}"#, #"{"sessionId":"  ","title":"T"}"#, #"{"sessionId":7,"title":"T"}"#,
                     #"{"sessionId":"a1"}"#, #"{"sessionId":"a1","title":""}"#] {
            XCTAssertThrowsError(try JSONDecoder().decode(Session.self, from: Data(json.utf8)), json)
        }
    }

    func testTimesAndLengths() throws {
        func time(_ time: String, _ length: String? = nil, date: String = "2026-12-02") -> SessionTime {
            SessionTime(date: date, time: time, length: length)
        }
        XCTAssertEqual(time("00:00").startMinute, 0)
        XCTAssertEqual(time("23:59").startMinute, 1439)
        XCTAssertNil(time("24:00").startMinute)
        XCTAssertNil(time("12:60").startMinute)
        XCTAssertNil(time("noon").startMinute)
        XCTAssertEqual(time("10:00", "0").lengthMinutes, 0)
        XCTAssertEqual(time("10:00", "abc").lengthMinutes, 0)
        XCTAssertEqual(time("10:00", "-5").lengthMinutes, 0)
        XCTAssertEqual(time("10:00", nil).lengthMinutes, 0)
        XCTAssertTrue(time("10:00").hasValidDate)
        XCTAssertFalse(time("10:00", date: "12/02/2026").hasValidDate)
        XCTAssertFalse(time("10:00", date: "2026-13-02").hasValidDate)
        // The longest length taken at its word is two weeks; beyond that it is not a length.
        XCTAssertEqual(time("10:00", "20160").lengthMinutes, 20160)
        XCTAssertEqual(time("10:00", "20161").lengthMinutes, 0)
        XCTAssertEqual(time("10:00", "9223372036854775807").lengthMinutes, 0)
        // A length sent as a number is accepted too.
        let numeric = try JSONDecoder().decode(SessionTime.self, from: Data(#"{"date":"2026-12-02","time":"09:30","length":45}"#.utf8))
        XCTAssertEqual(numeric.lengthMinutes, 45)
        XCTAssertEqual(numeric.startMinute, 570)
    }

    func testANumericLengthTooLargeToCountIsTreatedAsNoLength() throws {
        let huge = try JSONDecoder().decode(SessionTime.self, from: Data(#"{"date":"2026-12-02","time":"09:30","length":1e30}"#.utf8))
        XCTAssertNil(huge.length)
        XCTAssertEqual(huge.lengthMinutes, 0)
        XCTAssertEqual(huge.startMinute, 570)
        let fraction = try JSONDecoder().decode(SessionTime.self, from: Data(#"{"date":"2026-12-02","time":"09:30","length":45.9}"#.utf8))
        XCTAssertEqual(fraction.lengthMinutes, 45)
    }

    func testAnAbsurdlyLongSessionStillHasAnEndThatCanBeComputed() {
        let plan = PlanSnapshot(sessions: [session("forever", length: "9223372036854775807")],
                                schedule: Schedule(reserved: ["forever"]), fetchedAt: Date(timeIntervalSince1970: 0))
        let entry = plan.agenda(on: "2026-12-02", includeFavorites: false).timed.first
        XCTAssertEqual(entry?.start, 600)
        XCTAssertEqual(entry?.end, 600)
    }

    func testAScheduleKeepsWhatItCanReadOfInvitations() throws {
        let json = """
        {"reserved": ["r1", " ", 7], "favorites": ["f1", "f2"], "personalTime": [],
         "invitedSessions": [{"sessionId": "inv1", "title": "Reception", "room": "Sphere",
            "sessionTime": {"date": "2026-11-30", "time": "18:00", "length": "180", "timezone": "America/Los_Angeles"}},
            {"title": "No id"}]}
        """
        let schedule = try JSONDecoder().decode(Schedule.self, from: Data(json.utf8))
        XCTAssertEqual(schedule.reserved, ["r1"])
        XCTAssertEqual(schedule.favorites, ["f1", "f2"])
        XCTAssertEqual(schedule.invitedSessions.map(\.sessionId), ["inv1"])
        XCTAssertEqual(schedule.invitedSessions.first?.sessionTime?.timezone, "America/Los_Angeles")
        XCTAssertEqual(schedule.personalTime, [])
        // Two unusable reserved ids and one invitation without an id were dropped, and counted.
        XCTAssertEqual(schedule.skipped, 3)
    }

    func testACleanScheduleCountsNothingSkipped() throws {
        let schedule = try JSONDecoder().decode(
            Schedule.self, from: Data(#"{"reserved":["r1"],"favorites":["f1"],"personalTime":[]}"#.utf8))
        XCTAssertEqual(schedule, Schedule(reserved: ["r1"], favorites: ["f1"]))
        XCTAssertEqual(schedule.skipped, 0)
    }

    func testASnapshotSurvivesBeingSavedAndReadBack() throws {
        let snapshot = PlanSnapshot(
            sessions: [session("a"), Session(sessionId: "b", title: "Bare")],
            schedule: Schedule(reserved: ["a"], favorites: ["b"], invitedSessions: [session("inv", venue: nil)], skipped: 2),
            fetchedAt: Date(timeIntervalSince1970: 1_800_000_000), skipped: 2)
        let data = try JSONEncoder().encode(snapshot)
        XCTAssertEqual(try JSONDecoder().decode(PlanSnapshot.self, from: data), snapshot)
    }
}

final class AgendaTests: XCTestCase {
    private let now = Date(timeIntervalSince1970: 1_800_000_000)

    private func snapshot(_ sessions: [Session], reserved: [String] = [], favorites: [String] = [],
                          invited: [Session] = []) -> PlanSnapshot {
        PlanSnapshot(sessions: sessions,
                     schedule: Schedule(reserved: reserved, favorites: favorites, invitedSessions: invited),
                     fetchedAt: now)
    }

    func testReservedSessionsShowOnTheirDayAndFavoritesWaitUntilAsked() {
        let plan = snapshot([session("res", time: "08:00"), session("fav", time: "13:00"), session("other", time: "09:00"),
                             session("tomorrow", date: "2026-12-03")],
                            reserved: ["res", "tomorrow"], favorites: ["fav"])
        let quiet = plan.agenda(on: "2026-12-02", includeFavorites: false)
        XCTAssertEqual(quiet.timed.map(\.id), ["res"])
        XCTAssertEqual(quiet.timed.map(\.commitment), [.reserved])
        XCTAssertEqual(quiet.timed.map(\.start), [480])
        XCTAssertEqual(quiet.timed.map(\.end), [540])

        let full = plan.agenda(on: "2026-12-02", includeFavorites: true)
        XCTAssertEqual(full.timed.map(\.id), ["res", "fav"])
        XCTAssertEqual(full.timed.map(\.commitment), [.reserved, .favorite])

        XCTAssertEqual(plan.agenda(on: "2026-12-03", includeFavorites: false).timed.map(\.id), ["tomorrow"])
    }

    func testFavoritesAreGroupedByTheHourTheyStartAndCommitmentsStayApart() {
        let nine = (1...9).map { session("f\($0)", time: $0 <= 5 ? "12:00" : "12:59") }
        let plan = snapshot(nine + [session("seat", time: "12:00"), session("late", time: "13:00"),
                                    session("early", time: "08:30"), session("inv", time: "12:30")],
                            reserved: ["seat"], favorites: nine.map(\.sessionId) + ["late", "early", "seat"],
                            invited: [session("inv", time: "12:30")])
        let day = plan.agenda(on: "2026-12-02", includeFavorites: true)
        XCTAssertEqual(day.commitments.map(\.id), ["seat", "inv"])
        XCTAssertEqual(day.favoriteBuckets.map(\.hour), [8, 12, 13])
        XCTAssertEqual(day.favoriteBuckets.map { $0.entries.map(\.id) },
                       [["early"], ["f1", "f2", "f3", "f4", "f5", "f6", "f7", "f8", "f9"], ["late"]])
        XCTAssertEqual(day.timed.count, 13)

        let quiet = plan.agenda(on: "2026-12-02", includeFavorites: false)
        XCTAssertEqual(quiet.commitments.map(\.id), ["seat", "inv"])
        XCTAssertEqual(quiet.favoriteBuckets, [])
    }

    func testAnInvitationIsOnTheCalendarThoughItIsNotInTheCatalog() {
        let reception = session("inv", code: "RECEPTION", date: "2026-11-30", time: "18:00", length: "180", venue: nil)
        let plan = snapshot([session("res")], reserved: ["res"], invited: [reception])
        let day = plan.agenda(on: "2026-11-30", includeFavorites: false)
        XCTAssertEqual(day.timed.map(\.id), ["inv"])
        XCTAssertEqual(day.timed.map(\.commitment), [.invited])
        XCTAssertEqual(day.timed.first?.end, 21 * 60)
        XCTAssertEqual(plan.commitment(of: "inv"), .invited)
        XCTAssertEqual(plan.days(committedOnly: true), ["2026-11-30", "2026-12-02"])
    }

    func testAWithdrawnFavoriteIsReportedAndTheRestCarriesOn() {
        let plan = snapshot([session("fav")], reserved: [], favorites: ["fav", "gone", "gone"])
        XCTAssertEqual(plan.unresolvedIDs, ["gone"])
        XCTAssertEqual(plan.agenda(on: "2026-12-02", includeFavorites: true).timed.map(\.id), ["fav"])
    }

    func testASessionBothReservedAndFavoritedShowsOnceAsReserved() {
        let plan = snapshot([session("both")], reserved: ["both"], favorites: ["both"])
        let day = plan.agenda(on: "2026-12-02", includeFavorites: true)
        XCTAssertEqual(day.timed.map(\.id), ["both"])
        XCTAssertEqual(day.timed.map(\.commitment), [.reserved])
        XCTAssertEqual(plan.commitment(of: "both"), .reserved)
        XCTAssertNil(plan.commitment(of: "nobody"))
    }

    func testAllDayAndUntimedSessionsStayOffTheTimeline() {
        let untimed = Session(sessionId: "untimed", title: "No time yet")
        let plan = snapshot([session("expo", time: "08:00", length: "600", allDay: true), session("res"), untimed],
                            reserved: ["expo", "res", "untimed"])
        let day = plan.agenda(on: "2026-12-02", includeFavorites: false)
        XCTAssertEqual(day.timed.map(\.id), ["res"])
        XCTAssertEqual(day.allDay.map(\.id), ["expo"])
        XCTAssertEqual(plan.unresolvedIDs, [])
    }

    func testAZeroLengthSessionIsStillDrawn() {
        let plan = snapshot([session("zero", length: "0")], reserved: ["zero"])
        let entry = plan.agenda(on: "2026-12-02", includeFavorites: false).timed.first
        XCTAssertEqual(entry?.end, 600)
        XCTAssertEqual(entry?.drawnEnd, 620)
    }

    func testAnInvitationTheCatalogAlsoListsTakesItsDayFromTheCatalog() {
        let invited = session("both", date: "2026-12-02")
        let plan = snapshot([session("both", date: "2026-12-03"), session("other", date: "2026-12-01")], invited: [invited])
        XCTAssertEqual(plan.days(committedOnly: true), ["2026-12-03"])
        XCTAssertEqual(plan.days(), ["2026-12-01", "2026-12-03"])
        XCTAssertEqual(plan.defaultDay(today: "2026-11-22"), "2026-12-03")
        XCTAssertEqual(plan.agenda(on: "2026-12-03", includeFavorites: false).timed.map(\.id), ["both"])
    }

    func testDaysCoverTheWholeCatalogUnlessOnlyCommitmentsAreAsked() {
        let plan = snapshot([session("a", date: "2026-12-03"), session("b", date: "2026-11-30"),
                             session("c", date: "not a date"), Session(sessionId: "d", title: "untimed")],
                            reserved: ["a"])
        XCTAssertEqual(plan.days(), ["2026-11-30", "2026-12-03"])
        XCTAssertEqual(plan.days(committedOnly: true), ["2026-12-03"])
    }

    // MARK: Walks he cannot make

    private func warnings(gap: Int, from: String? = "Caesars Palace", to: String? = "MGM Grand",
                          secondIs: Commitment = .reserved) -> [TransferWarning] {
        let first = session("sec", time: "11:30", length: "60", venue: from)
        let start = 12 * 60 + 30 + gap
        let second = session("pex", time: String(format: "%02d:%02d", start / 60, start % 60), length: "120", venue: to)
        let plan = snapshot([first, second], reserved: secondIs == .reserved ? ["sec", "pex"] : ["sec"],
                            favorites: secondIs == .favorite ? ["pex"] : [])
        let day = plan.agenda(on: "2026-12-02", includeFavorites: true)
        XCTAssertEqual(day.timed.map(\.id), ["sec", "pex"])
        return day.warnings
    }

    func testNoTimeToCrossTheStripIsPointedOut() {
        XCTAssertEqual(warnings(gap: 0), [
            TransferWarning(fromID: "sec", toID: "pex", fromVenue: "Caesars Palace", toVenue: "MGM Grand", gapMinutes: 0),
        ])
    }

    func testAChangeOfVenueIsFlaggedUnderThirtyMinutesAndNotAtThirty() {
        XCTAssertEqual(warnings(gap: 29).map(\.gapMinutes), [29])
        XCTAssertEqual(warnings(gap: 30), [])
    }

    func testTheSameVenueAndUnknownVenuesAreNotFlagged() {
        XCTAssertEqual(warnings(gap: 0, from: "MGM Grand", to: "MGM Grand"), [])
        XCTAssertEqual(warnings(gap: 0, to: nil), [])
    }

    func testFavoritesAreNotJudgedForWalks() {
        XCTAssertEqual(warnings(gap: 0, secondIs: .favorite), [])
    }

    func testAVenuelessEntryInBetweenDoesNotHideTheWalk() {
        let reception = session("reception", time: "12:30", length: "60", venue: nil)
        let plan = snapshot([session("sec", time: "11:30", length: "60", venue: "Caesars Palace"),
                             session("pex", time: "12:35", length: "120", venue: "MGM Grand")],
                            reserved: ["sec", "pex"], invited: [reception])
        let day = plan.agenda(on: "2026-12-02", includeFavorites: false)
        XCTAssertEqual(day.timed.map(\.id), ["sec", "reception", "pex"])
        XCTAssertEqual(day.warnings, [
            TransferWarning(fromID: "sec", toID: "pex", fromVenue: "Caesars Palace", toVenue: "MGM Grand", gapMinutes: 5),
        ])
    }

    func testHeIsComingFromTheSessionThatEndsLastNotTheOneThatStartedLast() {
        let plan = snapshot([session("long", time: "10:00", length: "120", venue: "MGM Grand"),
                             session("short", time: "10:30", length: "30", venue: "MGM Grand"),
                             session("next", time: "12:00", length: "60", venue: "Caesars Palace")],
                            reserved: ["long", "short", "next"])
        let day = plan.agenda(on: "2026-12-02", includeFavorites: false)
        XCTAssertEqual(day.timed.map(\.id), ["long", "short", "next"])
        XCTAssertEqual(day.warnings, [
            TransferWarning(fromID: "long", toID: "next", fromVenue: "MGM Grand", toVenue: "Caesars Palace", gapMinutes: 0),
        ])
    }

    // MARK: Lookups

    func testCommitmentsByIdRankReservedOverInvitedOverFavorite() {
        let plan = snapshot([session("a"), session("b"), session("c"), session("d")],
                            reserved: ["a", "b"], favorites: ["a", "c", "inv"], invited: [session("b"), session("inv")])
        XCTAssertEqual(plan.commitmentsByID, ["a": .reserved, "b": .reserved, "c": .favorite, "inv": .invited])
        for id in ["a", "b", "c", "d", "inv"] {
            XCTAssertEqual(plan.commitmentsByID[id], plan.commitment(of: id), id)
        }
    }

    func testAnAgendaBuiltFromHeldLookupsIsTheSame() {
        let plan = snapshot([session("res", time: "08:00"), session("fav", time: "13:00")],
                            reserved: ["res"], favorites: ["fav"])
        let held = plan.agenda(on: "2026-12-02", includeFavorites: true, index: plan.sessionsByID,
                               commitments: plan.commitmentsByID)
        XCTAssertEqual(held.timed.map(\.id), ["res", "fav"])
        XCTAssertEqual(held.timed.map(\.commitment), [.reserved, .favorite])
        XCTAssertEqual(held, plan.agenda(on: "2026-12-02", includeFavorites: true))
    }

    func testTheDayToOpenOn() {
        let plan = snapshot([session("a", date: "2026-11-30"), session("b", date: "2026-12-01"),
                             session("c", date: "2026-12-02")], reserved: ["b"])
        XCTAssertEqual(plan.defaultDay(today: "2026-12-02"), "2026-12-02")
        XCTAssertEqual(plan.defaultDay(today: "2026-11-22"), "2026-12-01")
        let uncommitted = snapshot([session("a", date: "2026-11-30"), session("b", date: "2026-12-01")])
        XCTAssertEqual(uncommitted.defaultDay(today: "2026-11-22"), "2026-11-30")
        XCTAssertNil(snapshot([]).defaultDay(today: "2026-11-22"))
    }

    // MARK: The session list

    private func listed(_ plan: PlanSnapshot, _ filter: SessionFilter, _ search: String = "") -> [String] {
        plan.sessions(matching: filter, search: search).map(\.sessionId)
    }

    func testTheWholeCatalogIsListedInDayTimeCodeOrderWithUnscheduledLast() {
        let plan = snapshot([Session(sessionId: "untimed", title: "No time yet"),
                             session("late", code: "AAA", date: "2026-12-02", time: "15:00"),
                             session("z", code: "ZZZ", date: "2026-12-01", time: "09:00"),
                             session("a", code: "AAA", date: "2026-12-01", time: "09:00"),
                             session("early", code: "MMM", date: "2026-12-01", time: "08:00")])
        XCTAssertEqual(listed(plan, .all), ["early", "a", "z", "late", "untimed"])
    }

    func testMineListsWhatIsOnHisScheduleIncludingInvitationsOutsideTheCatalog() {
        let reception = session("inv", code: "RECEPTION", date: "2026-11-30", time: "18:00", venue: nil)
        var catalogCopy = session("both", code: "BOTH", time: "09:00")
        catalogCopy.title = "From the catalog"
        var invitedCopy = catalogCopy
        invitedCopy.title = "From the invitation"
        let plan = snapshot([session("res", time: "08:00"), session("fav", time: "13:00"), session("other"), catalogCopy],
                            reserved: ["res"], favorites: ["fav", "gone"], invited: [reception, invitedCopy])
        XCTAssertEqual(listed(plan, .mine), ["inv", "res", "both", "fav"])
        XCTAssertEqual(plan.sessions(matching: .mine).first { $0.sessionId == "both" }?.title, "From the catalog")
        XCTAssertEqual(plan.sessions(matching: .mine, commitments: plan.commitmentsByID).map(\.sessionId),
                       ["inv", "res", "both", "fav"])
    }

    func testSeatsOpenListsOnlyReservableSessionsWithASeatLeft() {
        func seat(_ id: String, _ band: String?, reservable: Bool = true) -> Session {
            var s = session(id)
            s.isReservable = reservable
            s.seatAvailability = band
            return s
        }
        let plan = snapshot([seat("a", "available"), seat("b", "limited"), seat("c", "veryLimited"),
                             seat("full", "unavailable"), seat("walk", "walkUp"), seat("unknown", nil),
                             seat("closed", "available", reservable: false), seat("held", "limited"),
                             seat("wanted", "available"), seat("invited", "available")],
                            reserved: ["held"], favorites: ["wanted"], invited: [seat("invited", "available")])
        // A seat he already holds and an invitation are left out; a favorite with a seat left stays in.
        XCTAssertEqual(listed(plan, .open), ["a", "b", "c", "wanted"])
        XCTAssertEqual(listed(plan, .mine), ["held", "invited", "wanted"])
    }

    func testSearchLooksAtCodeTitleSpeakerAndTopicIgnoringCase() {
        var byTitle = session("t", code: "AAA101")
        byTitle.title = "Tracing a request"
        var bySpeaker = session("s", code: "BBB202")
        bySpeaker.speakers = [Speaker(name: "Tracy Example")]
        var byTopic = session("p", code: "CCC303")
        byTopic.topics = ["Distributed Tracing"]
        let plan = snapshot([byTitle, bySpeaker, byTopic, session("none", code: "DDD404")])
        XCTAssertEqual(listed(plan, .all, "trac"), ["t", "s", "p"])
        XCTAssertEqual(listed(plan, .all, "  bbb2 "), ["s"])
        XCTAssertEqual(listed(plan, .all, "ddd404"), ["none"])
        XCTAssertEqual(listed(plan, .all, "nothing like this"), [])
        XCTAssertEqual(listed(plan, .all, "   "), ["t", "s", "p", "none"])
    }

    // MARK: Changing things on the conference site

    func testAChangeIsSentOnceAndTheScheduleReadBack() async {
        let backend = CountingBackend()
        backend.reserveAnswer = .success(BulkResult(successful: ["a"]))
        backend.scheduleAnswer = .success(Schedule(reserved: ["a"]))
        let outcome = await Sync.change(backend: backend, sessionID: "a") { try await $0.reserve(["a"]) }
        XCTAssertEqual(outcome.schedule, Schedule(reserved: ["a"]))
        XCTAssertNil(outcome.refusal)
        XCTAssertNil(outcome.problem)
        XCTAssertEqual(backend.calls("reserve"), 1)
        XCTAssertEqual(backend.calls("schedule"), 1)
    }

    func testARefusalForThisSessionIsReportedAndTheScheduleStillRead() async {
        let backend = CountingBackend()
        backend.reserveAnswer = .success(BulkResult(failed: [
            BulkFailure(sessionId: "other", code: "sessionFull"),
            BulkFailure(sessionId: "pex", code: "scheduleConflict", conflictsWith: ["aim"]),
        ]))
        backend.scheduleAnswer = .success(Schedule(reserved: ["aim"]))
        let outcome = await Sync.change(backend: backend, sessionID: "pex") { try await $0.reserve(["pex"]) }
        XCTAssertEqual(outcome.refusal, BulkFailure(sessionId: "pex", code: "scheduleConflict", conflictsWith: ["aim"]))
        XCTAssertEqual(outcome.schedule, Schedule(reserved: ["aim"]))
        XCTAssertNil(outcome.problem)
    }

    func testAChangeWhoseAnswerNeverArrivedIsFollowedByAReadNotASecondSend() async {
        let backend = CountingBackend()
        backend.reserveAnswer = .failure(.outcomeUnknown)
        backend.scheduleAnswer = .success(Schedule(reserved: ["a"]))
        let outcome = await Sync.change(backend: backend, sessionID: "a") { try await $0.reserve(["a"]) }
        XCTAssertEqual(outcome.problem as? APIError, .outcomeUnknown)
        XCTAssertEqual(outcome.schedule, Schedule(reserved: ["a"]))
        XCTAssertEqual(backend.calls("reserve"), 1)
        XCTAssertEqual(backend.calls("schedule"), 1)
    }

    func testAChangeTheSiteSaysNothingAboutIsNotTakenAsDone() async {
        let silent = CountingBackend()
        silent.reserveAnswer = .success(BulkResult())
        silent.scheduleAnswer = .success(Schedule(reserved: []))
        let outcome = await Sync.change(backend: silent, sessionID: "a") { try await $0.reserve(["a"]) }
        XCTAssertEqual(outcome.problem as? APIError, .unconfirmed)
        XCTAssertNil(outcome.refusal)
        XCTAssertEqual(outcome.schedule, Schedule(reserved: []))
        XCTAssertNil(outcome.readBackProblem)

        // Another session's success does not confirm this one.
        let other = CountingBackend()
        other.reserveAnswer = .success(BulkResult(successful: ["b"]))
        let mismatched = await Sync.change(backend: other, sessionID: "a") { try await $0.reserve(["a"]) }
        XCTAssertEqual(mismatched.problem as? APIError, .unconfirmed)

        // Nor does another session's refusal stand in for this one's.
        let unrelated = CountingBackend()
        unrelated.reserveAnswer = .success(BulkResult(failed: [BulkFailure(sessionId: "b", code: "sessionFull")]))
        let stray = await Sync.change(backend: unrelated, sessionID: "a") { try await $0.reserve(["a"]) }
        XCTAssertNil(stray.refusal)
        XCTAssertEqual(stray.problem as? APIError, .unconfirmed)
        XCTAssertEqual(unrelated.calls("schedule"), 1)
    }

    func testASignInRejectedOnReadBackIsReportedEvenWhenTheChangeAlsoFailed() async {
        let backend = CountingBackend()
        backend.reserveAnswer = .failure(.outcomeUnknown)
        backend.scheduleAnswer = .failure(.signInNeeded)
        let outcome = await Sync.change(backend: backend, sessionID: "a") { try await $0.reserve(["a"]) }
        XCTAssertEqual(outcome.problem as? APIError, .outcomeUnknown)
        XCTAssertEqual(outcome.readBackProblem as? APIError, .signInNeeded)
        XCTAssertNil(outcome.schedule)

        let fine = CountingBackend()
        fine.reserveAnswer = .success(BulkResult(successful: ["a"]))
        let clean = await Sync.change(backend: fine, sessionID: "a") { try await $0.reserve(["a"]) }
        XCTAssertNil(clean.readBackProblem)
        XCTAssertNil(clean.problem)
    }

    func testAScheduleThatCannotBeReadBackIsReportedAndTheFirstProblemWins() async {
        let unread = CountingBackend()
        unread.reserveAnswer = .success(BulkResult(successful: ["a"]))
        unread.scheduleAnswer = .failure(.busy)
        let afterSuccess = await Sync.change(backend: unread, sessionID: "a") { try await $0.reserve(["a"]) }
        XCTAssertNil(afterSuccess.schedule)
        XCTAssertEqual(afterSuccess.problem as? APIError, .busy)
        XCTAssertEqual(afterSuccess.readBackProblem as? APIError, .busy)

        let both = CountingBackend()
        both.reserveAnswer = .failure(.closed)
        both.scheduleAnswer = .failure(.busy)
        let afterFailure = await Sync.change(backend: both, sessionID: "a") { try await $0.reserve(["a"]) }
        XCTAssertNil(afterFailure.schedule)
        XCTAssertEqual(afterFailure.problem as? APIError, .closed)
        XCTAssertEqual(both.calls("schedule"), 1)
    }

    // MARK: Refreshing

    func testRefreshBuildsTheSnapshotFromBothAnswers() async throws {
        let backend = FixedBackend(catalog: .success(Catalog(sessions: [session("a"), session("b")], skipped: 1)),
                                   schedule: .success(Schedule(reserved: ["a"], favorites: ["b"])))
        let snapshot = try await Sync.refresh(backend: backend, previous: nil, now: now)
        XCTAssertEqual(snapshot, PlanSnapshot(sessions: [session("a"), session("b")],
                                              schedule: Schedule(reserved: ["a"], favorites: ["b"]),
                                              fetchedAt: now, skipped: 1))
    }

    func testACatalogUnderHalfTheOneHeldIsRefusedAndExactlyHalfIsAccepted() async throws {
        let previous = snapshot((1...10).map { session("s\($0)") })
        func refresh(count: Int) async throws -> PlanSnapshot {
            let backend = FixedBackend(catalog: .success(Catalog(sessions: (1...count).map { session("s\($0)") })),
                                       schedule: .success(Schedule()))
            return try await Sync.refresh(backend: backend, previous: previous, now: now)
        }
        let accepted = try await refresh(count: 5)
        XCTAssertEqual(accepted.sessions.count, 5)
        do {
            _ = try await refresh(count: 4)
            XCTFail("a catalog of 4 replaced one of 10")
        } catch {
            XCTAssertEqual(error as? APIError, .catalogShrank(previous: 10, got: 4))
        }
    }

    func testAFailedScheduleFetchFailsTheRefresh() async {
        let backend = FixedBackend(catalog: .success(Catalog(sessions: [session("a")])), schedule: .failure(.signInNeeded))
        do {
            _ = try await Sync.refresh(backend: backend, previous: nil, now: now)
            XCTFail("a refresh without a schedule produced a snapshot")
        } catch {
            XCTAssertEqual(error as? APIError, .signInNeeded)
        }
    }
}

final class CalendarLayoutTests: XCTestCase {
    private func place(_ items: [(String, Int, Int)]) -> [String: Placement] {
        let placed = CalendarLayout.place(items.map { (id: $0.0, start: $0.1, end: $0.2) })
        XCTAssertEqual(placed.count, items.count)
        return Dictionary(uniqueKeysWithValues: placed.map { ($0.id, $0) })
    }

    func testTwoAtTheSameHourEachTakeHalfTheWidth() {
        let placed = place([("a", 600, 660), ("b", 600, 660)])
        XCTAssertEqual(placed["a"], Placement(id: "a", column: 0, columns: 2))
        XCTAssertEqual(placed["b"], Placement(id: "b", column: 1, columns: 2))
    }

    func testOneThatStartsAsTheOtherEndsTakesTheFullWidth() {
        let placed = place([("a", 600, 660), ("b", 660, 720)])
        XCTAssertEqual(placed["a"], Placement(id: "a", column: 0, columns: 1))
        XCTAssertEqual(placed["b"], Placement(id: "b", column: 0, columns: 1))
    }

    func testOneThatStartsAsAClashEndsIsNotNarrowedByIt() {
        let placed = place([("a", 600, 660), ("b", 600, 660), ("next", 660, 720)])
        XCTAssertEqual(placed["a"], Placement(id: "a", column: 0, columns: 2))
        XCTAssertEqual(placed["b"], Placement(id: "b", column: 1, columns: 2))
        XCTAssertEqual(placed["next"], Placement(id: "next", column: 0, columns: 1))
    }

    func testOneMinuteOfOverlapPutsThemSideBySide() {
        let placed = place([("a", 600, 661), ("b", 660, 720)])
        XCTAssertEqual(placed["a"], Placement(id: "a", column: 0, columns: 2))
        XCTAssertEqual(placed["b"], Placement(id: "b", column: 1, columns: 2))
    }

    func testAColumnIsReusedOnceItsSessionEnds() {
        let placed = place([("long", 600, 720), ("early", 600, 660), ("late", 660, 720)])
        XCTAssertEqual(placed["long"], Placement(id: "long", column: 1, columns: 2))
        XCTAssertEqual(placed["early"], Placement(id: "early", column: 0, columns: 2))
        XCTAssertEqual(placed["late"], Placement(id: "late", column: 0, columns: 2))
    }

    func testALaterSessionOnItsOwnIsNotNarrowedByAnEarlierClash() {
        let placed = place([("a", 600, 660), ("b", 600, 660), ("c", 600, 660), ("alone", 900, 960)])
        XCTAssertEqual(placed["c"], Placement(id: "c", column: 2, columns: 3))
        XCTAssertEqual(placed["alone"], Placement(id: "alone", column: 0, columns: 1))
    }

    // The scaled inputs were read from @ScaledMetric(relativeTo: .caption2) = 50 in the
    // simulator: 50 at the extra-small and standard sizes, 184.67 at AX XXXL.
    func testTheHourColumnIsUnchangedAtTheStandardTextSize() {
        XCTAssertEqual(CalendarLayout.hourColumnWidth(scaled: 50), 50)
    }

    func testTheHourColumnGrowsWithLargerTextUpToItsCap() {
        XCTAssertEqual(CalendarLayout.hourColumnWidth(scaled: 70), 70)
        XCTAssertEqual(CalendarLayout.hourColumnWidth(scaled: 87.5), 87.5)
        XCTAssertEqual(CalendarLayout.hourColumnWidth(scaled: 88), 88)
        XCTAssertEqual(CalendarLayout.hourColumnWidth(scaled: 88.5), 88)
        XCTAssertEqual(CalendarLayout.hourColumnWidth(scaled: 184.67), 88)
    }

    func testTheHourColumnNeverShrinksBelowItsStandardWidth() {
        XCTAssertEqual(CalendarLayout.hourColumnWidth(scaled: 50.5), 50.5)
        XCTAssertEqual(CalendarLayout.hourColumnWidth(scaled: 49.5), 50)
    }

    func testAnHourLabelNoTallerThanItsRowDoesNotStickOut() {
        XCTAssertEqual(CalendarLayout.hourLabelOverhang(labelHeight: 11.5), 0)
        XCTAssertEqual(CalendarLayout.hourLabelOverhang(labelHeight: 12), 0)
    }

    func testATallerHourLabelSticksOutByHalfTheExcess() {
        XCTAssertEqual(CalendarLayout.hourLabelOverhang(labelHeight: 12.5), 0.25)
        XCTAssertEqual(CalendarLayout.hourLabelOverhang(labelHeight: 44), 16)
    }
}

final class DemoBackendTests: XCTestCase {
    func testTheSampleConferenceHasACalendarToShow() async throws {
        let demo = DemoBackend()
        let snapshot = try await Sync.refresh(backend: demo, previous: nil, now: Date(timeIntervalSince1970: 0))
        XCTAssertEqual(snapshot.sessions.count, 16)
        XCTAssertEqual(snapshot.unresolvedIDs, [])
        XCTAssertEqual(snapshot.days(), ["2027-03-09", "2027-03-10", "2027-03-11"])
        let first = snapshot.agenda(on: "2027-03-09", includeFavorites: false)
        XCTAssertEqual(first.timed.map(\.session.code), ["DAT310", "RECEPTION"])
        let second = snapshot.agenda(on: "2027-03-10", includeFavorites: false)
        XCTAssertEqual(second.timed.map(\.session.code), ["AIM410", "SEC340"])
        XCTAssertEqual(second.warnings.map(\.gapMinutes), [0])
    }

    func testReservingAClashIsRefusedAndNothingChanges() async {
        let demo = DemoBackend()
        let before = await demo.loadSchedule()
        let result = await demo.reserve(["demo-206"])
        XCTAssertEqual(result, BulkResult(successful: [], failed: [
            // 09:00–11:00 overlaps both the 08:30–10:30 and the 10:30–12:30 seats he holds.
            BulkFailure(sessionId: "demo-206", code: "scheduleConflict", conflictsWith: ["demo-201", "demo-204"]),
        ]))
        let after = await demo.loadSchedule()
        XCTAssertEqual(after, before)
        XCTAssertEqual(after.reserved, ["demo-103", "demo-201", "demo-204"])
    }

    func testReservingAndCancellingASeat() async {
        let demo = DemoBackend()
        let result = await demo.reserve(["demo-104", "demo-107", "demo-102", "demo-103"])
        XCTAssertEqual(result, BulkResult(successful: ["demo-104"], failed: [
            BulkFailure(sessionId: "demo-107", code: "sessionFull"),
            BulkFailure(sessionId: "demo-102", code: "sessionNotReservable"),
            BulkFailure(sessionId: "demo-103", code: "alreadyScheduled"),
        ]))
        var reserved = await demo.loadSchedule().reserved
        XCTAssertEqual(reserved, ["demo-103", "demo-201", "demo-204", "demo-104"])
        await demo.cancelReservation("demo-104")
        reserved = await demo.loadSchedule().reserved
        XCTAssertEqual(reserved, ["demo-103", "demo-201", "demo-204"])
    }

    func testFavoritingAndUnfavoriting() async {
        let demo = DemoBackend()
        let result = await demo.favorite(["demo-106", "demo-101", "nope"])
        XCTAssertEqual(result, BulkResult(successful: ["demo-106"], failed: [
            BulkFailure(sessionId: "demo-101", code: "alreadyFavorited"),
            BulkFailure(sessionId: "nope", code: "other"),
        ]))
        await demo.unfavorite("demo-101")
        let favorites = await demo.loadSchedule().favorites
        XCTAssertEqual(favorites, ["demo-104", "demo-105", "demo-202", "demo-301", "demo-106"])
    }
}
