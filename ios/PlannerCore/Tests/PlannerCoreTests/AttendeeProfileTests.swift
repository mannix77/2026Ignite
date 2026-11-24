import XCTest
@testable import PlannerCore

/// What the on-device model is told about the attendee (#197).
final class AttendeeProfileTests: XCTestCase {
    private let advanced = "300 – Advanced", expert = "400 – Expert", intermediate = "200 – Intermediate"

    private func pick(_ id: String, level: String? = nil, type: String? = nil, topics: [String] = [],
                      date: String = "2026-12-03") -> Session {
        var s = session(id, date: date)
        s.level = level
        s.type = type
        s.topics = topics
        return s
    }

    private func profile(_ picks: [Session], _ preferences: SessionPreferences = SessionPreferences(),
                         reservedToday: Int = 0, budget: PromptBudget = PromptBudget()) -> AttendeeProfile {
        AttendeeProfile.build(picks: picks, preferences: preferences, reservedToday: reservedToday, budget: budget)
    }

    // MARK: Inferred from his picks

    func testLevelsAndFormatsFromHisPicks() {
        let levels = Array(repeating: advanced, count: 6) + Array(repeating: expert, count: 3) + [intermediate]
        let types = Array(repeating: "Workshop", count: 5) + Array(repeating: "Chalk talk", count: 3)
            + Array(repeating: "Breakout session", count: 2)
        let picks = (0..<10).map { pick("p\($0)", level: levels[$0], type: types[$0], topics: ["AI"]) }
        let built = profile(picks)
        XCTAssertEqual(built.text, """
            About them:
            Interests: AI (10)
            Levels they choose: 300 – Advanced, 400 – Expert
            Formats they choose: Workshop, Chalk talk
            """)
        XCTAssertEqual(built.use, ProfileUse(interestsNamed: 1, levels: .inferred, formats: .inferred, skips: false,
                                             reservedToday: false))
    }

    func testAShareOfTwentyPercentCountsAndJustUnderDoesNot() {
        // 15 picks, 3 chalk talks: 20%, named. 16 picks, 3 chalk talks: 18.75%, not.
        let fifteen = (0..<15).map { pick("p\($0)", type: $0 < 3 ? "Chalk talk" : "Type \($0)") }
        XCTAssertTrue(profile(fifteen).text.contains("Formats they choose: Chalk talk"))
        XCTAssertEqual(profile(fifteen).use.formats, .inferred)
        let sixteen = (0..<16).map { pick("p\($0)", type: $0 < 3 ? "Chalk talk" : "Type \($0)") }
        XCTAssertFalse(profile(sixteen).text.contains("Formats they choose"))
        XCTAssertNil(profile(sixteen).use.formats)
        // 4 of 21 is 19%: still under.
        let twentyOne = (0..<21).map { pick("p\($0)", type: $0 < 4 ? "Chalk talk" : "Type \($0)") }
        XCTAssertNil(profile(twentyOne).use.formats)
    }

    func testThreePicksAreEnoughToTellAndTwoAreNot() {
        let two = (0..<2).map { pick("p\($0)", level: advanced, type: "Workshop", topics: ["AI"]) }
        XCTAssertEqual(profile(two).text, "About them:\nInterests: AI (2)")
        XCTAssertEqual(profile(two).use, ProfileUse(interestsNamed: 1, levels: nil, formats: nil, skips: false,
                                                    reservedToday: false))
        let three = (0..<3).map { pick("p\($0)", level: advanced, type: "Workshop", topics: ["AI"]) }
        XCTAssertEqual(profile(three).text, """
            About them:
            Interests: AI (3)
            Levels they choose: 300 – Advanced
            Formats they choose: Workshop
            """)
    }

    func testNoLevelIsNeverNamedEvenWhenMostCommon() {
        let levels = Array(repeating: "No Level", count: 8) + Array(repeating: advanced, count: 6)
            + Array(repeating: expert, count: 6)
        let built = profile((0..<20).map { pick("p\($0)", level: levels[$0]) })
        XCTAssertEqual(built.text, "About them:\nInterests: none yet\nLevels they choose: 300 – Advanced, 400 – Expert")
    }

    func testNoLevelIsNeverNamedAndTheMostAreTwoLevelsAndThreeFormats() {
        let picks = (0..<20).map { i -> Session in
            let levels = ["No Level", advanced, expert, intermediate]
            let types = ["Workshop", "Chalk talk", "Breakout session", "Lightning talk"]
            return pick("p\(i)", level: levels[i % 4], type: types[i % 4])
        }
        let built = profile(picks)
        // Each level and format is on 5 of 20 picks (25%): ties go by name.
        XCTAssertTrue(built.text.contains("Levels they choose: 200 – Intermediate, 300 – Advanced\n"))
        XCTAssertTrue(built.text.hasSuffix("Formats they choose: Breakout session, Chalk talk, Lightning talk"))
        XCTAssertFalse(built.text.contains("No Level"))
    }

    func testFiveHundredCanBeInferredThoughSettingsDoesNotOfferIt() {
        XCTAssertEqual(SessionPreferences.offeredLevels,
                       ["100 – Foundational", "200 – Intermediate", "300 – Advanced", "400 – Expert"])
        var preferences = SessionPreferences()
        preferences.setLevel("500 – Distinguished", chosen: true)
        XCTAssertEqual(preferences.levels, [])
        preferences.setLevel(expert, chosen: true)
        XCTAssertEqual(preferences.levels, [expert])
        let picks = (0..<3).map { pick("p\($0)", level: "500 – Distinguished") }
        XCTAssertTrue(profile(picks).text.contains("Levels they choose: 500 – Distinguished"))
    }

    // MARK: His picks

    func testAReservedFavoriteCountsOnceAndUnknownSessionsAreSkipped() {
        let snapshot = PlanSnapshot(sessions: [pick("w", type: "Workshop"), pick("x"), pick("y")],
                                    schedule: Schedule(reserved: ["w", "gone"], favorites: ["w", "x"]),
                                    fetchedAt: Date(timeIntervalSince1970: 0))
        XCTAssertEqual(snapshot.picks.map(\.sessionId), ["w", "x"])
    }

    func testReservedTodayCountsOnlyThatDaysReservations() {
        let thursday = (0..<4).map { pick("t\($0)", date: "2026-12-03") }
        let wednesday = (0..<2).map { pick("w\($0)", date: "2026-12-02") }
        let snapshot = PlanSnapshot(sessions: thursday + wednesday + [pick("fav", date: "2026-12-03")],
                                    schedule: Schedule(reserved: (thursday + wednesday).map(\.sessionId), favorites: ["fav"]),
                                    fetchedAt: Date(timeIntervalSince1970: 0))
        XCTAssertEqual(snapshot.reservedCount(on: "2026-12-03"), 4)
        XCTAssertEqual(snapshot.reservedCount(on: "2026-12-02"), 2)
        XCTAssertEqual(snapshot.reservedCount(on: "2026-12-04"), 0)
        XCTAssertTrue(profile([], reservedToday: 4).text.hasSuffix("\nAlready reserved today: 4 sessions"))
        XCTAssertTrue(profile([], reservedToday: 1).text.hasSuffix("\nAlready reserved today: 1 session"))
        XCTAssertEqual(profile([], reservedToday: 0).text, "About them:\nInterests: none yet")
        XCTAssertTrue(profile([], reservedToday: 4).use.reservedToday)
        XCTAssertFalse(profile([], reservedToday: 0).use.reservedToday)
    }

    func testNoPicksAndNoPreferencesSayNoneYet() {
        let built = profile([])
        XCTAssertEqual(built.text, "About them:\nInterests: none yet")
        XCTAssertEqual(built.use, ProfileUse(interestsNamed: 0, levels: nil, formats: nil, skips: false, reservedToday: false))
    }

    // MARK: What he sets

    func testWhatHeSetsWinsOverWhatIsInferred() {
        let picks = (0..<5).map { pick("p\($0)", level: intermediate, type: "Workshop") }
        var preferences = SessionPreferences()
        preferences.setLevel(expert, chosen: true)
        let built = profile(picks, preferences)
        XCTAssertTrue(built.text.contains("Levels they choose: 400 – Expert\n"))
        XCTAssertFalse(built.text.contains(intermediate))
        XCTAssertEqual(built.use.levels, .settings)
        // Formats he didn't set are still inferred.
        XCTAssertTrue(built.text.hasSuffix("Formats they choose: Workshop"))
        XCTAssertEqual(built.use.formats, .inferred)
    }

    func testSkippingIsOnlyWhatHeSays() {
        let picks = (0..<5).map { pick("p\($0)", type: "Workshop") }
        XCTAssertFalse(profile(picks).text.contains("They skip"))
        XCTAssertFalse(profile(picks).use.skips)
        var preferences = SessionPreferences()
        preferences.setSkipped("Keynote", true)
        preferences.setSkipped("Lightning talk", true)
        let built = profile(picks, preferences)
        XCTAssertTrue(built.text.hasSuffix("\nThey skip: Keynote, Lightning talk"))
        XCTAssertTrue(built.use.skips)
    }

    func testAFormatCannotBeBothPreferredAndSkipped() {
        var preferences = SessionPreferences()
        preferences.setPreferred("Workshop", true)
        XCTAssertEqual(preferences.preferredFormats, ["Workshop"])
        preferences.setSkipped("Workshop", true)
        XCTAssertEqual(preferences.preferredFormats, [])
        XCTAssertEqual(preferences.skippedFormats, ["Workshop"])
        // And the reverse.
        preferences.setPreferred("Workshop", true)
        XCTAssertEqual(preferences.preferredFormats, ["Workshop"])
        XCTAssertEqual(preferences.skippedFormats, [])
        // Clearing one leaves the other alone.
        preferences.setSkipped("Keynote", true)
        preferences.setPreferred("Workshop", false)
        XCTAssertEqual(preferences.preferredFormats, [])
        XCTAssertEqual(preferences.skippedFormats, ["Keynote"])
    }

    func testTheFormatsOfferedAreTheCatalogsOwnPlusAnyAlreadyChosen() {
        let catalog = [pick("a", type: "Workshop"), pick("b", type: "Chalk talk"), pick("c", type: "Workshop"),
                       pick("d", type: nil), pick("e", type: "  "), pick("f", type: "Chalk talk"), pick("g", type: "Keynote")]
        var preferences = SessionPreferences()
        XCTAssertEqual(SessionPreferences.formats(in: catalog, keeping: preferences), ["Chalk talk", "Workshop", "Keynote"])
        preferences.setSkipped("Bootcamp", true)
        preferences.setPreferred("Workshop", true) // in the catalog: listed once
        XCTAssertEqual(SessionPreferences.formats(in: catalog, keeping: preferences),
                       ["Chalk talk", "Workshop", "Keynote", "Bootcamp"])
    }

    func testTheRealCatalogOffersItsSixteenFormats() throws {
        let formats = SessionPreferences.formats(in: try realCatalog(), keeping: SessionPreferences())
        // Counts from the catalog as measured on 2026-11-23.
        XCTAssertEqual(formats, ["Breakout session", "Chalk talk", "Workshop", "Builders' session", "Lightning talk",
                                 "Code talk", "Meetup", "Featured experience", "Mainstage", "Lab", "Gamified learning",
                                 "Bootcamp", "Expo", "Event service", "Exam prep", "Keynote"])
    }

    func testSavedPreferencesAreReadBackAndADamagedCopyKeepsWhatItCan() throws {
        var preferences = SessionPreferences()
        preferences.setLevel(advanced, chosen: true)
        preferences.setPreferred("Workshop", true)
        preferences.setSkipped("Keynote", true)
        XCTAssertEqual(SessionPreferences(saved: preferences.saved), preferences)
        XCTAssertEqual(SessionPreferences(saved: nil), SessionPreferences())
        XCTAssertEqual(SessionPreferences(saved: Data("not json".utf8)), SessionPreferences())
        let damaged = #"{"levels":["500 – Distinguished"," 300 – Advanced ",null,7],"preferredFormats":[" Workshop ","","Keynote",null],"skippedFormats":["Keynote","Expo"]}"#
        let read = SessionPreferences(saved: Data(damaged.utf8))
        XCTAssertEqual(read.levels, [advanced])
        // Keynote is in both: skipping wins, as the last choice can't be known.
        XCTAssertEqual(read.preferredFormats, ["Workshop"])
        XCTAssertEqual(read.skippedFormats, ["Expo", "Keynote"])
    }

    func testValuesAreCleanedAndCut() {
        let long = String(repeating: "abcd ", count: 15) // 75 characters
        let picks = (0..<3).map { pick("p\($0)", type: "Work | shop\n" + long) }
        let built = profile(picks)
        // A value with no break is cut at exactly 59 characters and the "…".
        let unbroken = (0..<3).map { pick("u\($0)", type: String(repeating: "x", count: 70)) }
        XCTAssertTrue(profile(unbroken).text.hasSuffix("Formats they choose: " + String(repeating: "x", count: 59) + "…"))
        // "Work / shop abcd abcd …" is 86 characters; cut at the last word within 60.
        XCTAssertEqual(built.text.split(separator: "\n").last.map(String.init),
                       "Formats they choose: Work / shop " + String(repeating: "abcd ", count: 8) + "abcd…")
    }

    // MARK: The cap

    func testTheLongestRealProfileFitsAndSoDoesThePrompt() throws {
        let catalog = try realCatalog()
        let names = Set(catalog.flatMap { ($0.topics ?? []) + ($0.services ?? []) })
        let longest = Array(names.sorted { ($0.utf8.count, $1) > ($1.utf8.count, $0) }.prefix(15))
        let types = SessionPreferences.formats(in: catalog, keeping: SessionPreferences())
            .sorted { ($0.count, $1) > ($1.count, $0) }
        let picks = (0..<135).map { i -> Session in
            var s = pick("p\(i)", topics: longest)
            s.services = []
            return s
        }
        var preferences = SessionPreferences()
        SessionPreferences.offeredLevels.forEach { preferences.setLevel($0, chosen: true) }
        types.prefix(3).forEach { preferences.setPreferred($0, true) }
        types.dropFirst(3).forEach { preferences.setSkipped($0, true) }
        let built = profile(picks, preferences, reservedToday: 12)
        // Precondition: every line is there, interests whole.
        XCTAssertEqual(built.use, ProfileUse(interestsNamed: 15, levels: .settings, formats: .settings, skips: true,
                                             reservedToday: true))
        XCTAssertLessThanOrEqual(TokenEstimate.tokens(built.text), 400)
        let sessions = catalog.map { (session: $0, bytes: ModelPrompt.line($0, topics: 3).utf8.count
                                        + ModelPrompt.cut(ModelPrompt.clean($0.abstract ?? ""), to: 300).utf8.count) }
            .sorted { ($0.bytes, $1.session.sessionId) > ($1.bytes, $0.session.sessionId) }.map(\.session)
        let prompt = ModelPrompt.build(question: String(repeating: "q", count: 300), ranked: sessions,
                                       sessionsInBlock: catalog.count, picks: picks, preferences: preferences,
                                       reservedToday: 12)
        XCTAssertTrue(prompt.text.contains(built.text))
        XCTAssertEqual(prompt.metrics.sessionsSent, 12)
        XCTAssertLessThan(prompt.metrics.estimatedTokens, 3096)
    }

    func testOverTheCapLinesGoInTheAgreedOrderAndWhatHeSetStays() {
        // 10 interests, inferred formats, levels he set, and 3 reserved today.
        let picks = (0..<10).map { i in
            pick("p\(i)", type: "Workshop", topics: (0...i).map { "Interest number \($0)" })
        }
        var preferences = SessionPreferences()
        preferences.setLevel(expert, chosen: true)
        var budget = PromptBudget()
        var seen: [ProfileUse] = []
        for limit in stride(from: 400, through: 1, by: -1) {
            budget.profileTokenLimit = limit
            let built = profile(picks, preferences, reservedToday: 3, budget: budget)
            // What he set is never cut.
            XCTAssertEqual(built.use.levels, .settings, "limit \(limit)")
            XCTAssertTrue(built.text.contains("Levels they choose: 400 – Expert"), "limit \(limit)")
            if seen.last != built.use { seen.append(built.use) }
        }
        let interests = seen.map(\.interestsNamed)
        // Interests 10 → 5 first, with everything else still there.
        XCTAssertEqual(Array(seen.prefix(6)), (5...10).reversed().map {
            ProfileUse(interestsNamed: $0, levels: .settings, formats: .inferred, skips: false, reservedToday: true)
        })
        // Then the reserved-today line, then the inferred formats, then interests below 5.
        XCTAssertEqual(seen[6], ProfileUse(interestsNamed: 5, levels: .settings, formats: .inferred, skips: false,
                                           reservedToday: false))
        XCTAssertEqual(seen[7], ProfileUse(interestsNamed: 5, levels: .settings, formats: nil, skips: false,
                                           reservedToday: false))
        XCTAssertEqual(Array(interests.dropFirst(7)), [5, 4, 3, 2, 1, 0])
        // With every interest cut, there is no interests line: "none yet" would be untrue.
        budget.profileTokenLimit = 1
        let bare = profile(picks, preferences, reservedToday: 3, budget: budget)
        XCTAssertEqual(bare.text, "About them:\nLevels they choose: 400 – Expert")
    }

    func testEachStepFitsTheCapWhenItCan() {
        let picks = (0..<10).map { i in pick("p\(i)", type: "Workshop", topics: (0...i).map { "Interest number \($0)" }) }
        var budget = PromptBudget()
        // The whole profile, measured once: 10 interests and the formats line.
        let whole = profile(picks, reservedToday: 3)
        let size = TokenEstimate.tokens(whole.text)
        XCTAssertEqual(whole.use.interestsNamed, 10)
        budget.profileTokenLimit = size
        XCTAssertEqual(profile(picks, reservedToday: 3, budget: budget), whole) // exactly at the cap: kept whole
        budget.profileTokenLimit = size - 1
        let one = profile(picks, reservedToday: 3, budget: budget)
        XCTAssertEqual(one.use.interestsNamed, 9) // one token under: the last interest goes
        XCTAssertLessThanOrEqual(TokenEstimate.tokens(one.text), size - 1)
    }

    // MARK: In the prompt

    func testThePromptCarriesTheProfileAndItsMetricsButNotItsText() {
        var preferences = SessionPreferences()
        preferences.setSkipped("Keynote", true)
        let picks = (0..<3).map { pick("p\($0)", level: advanced, topics: ["AI"]) }
        let prompt = ModelPrompt.build(question: "Which?", ranked: [session("a", time: "13:00")], sessionsInBlock: 1,
                                       picks: picks, preferences: preferences, reservedToday: 2)
        let built = profile(picks, preferences, reservedToday: 2)
        XCTAssertEqual(built.text, """
            About them:
            Interests: AI (3)
            Levels they choose: 300 – Advanced
            They skip: Keynote
            Already reserved today: 2 sessions
            """)
        XCTAssertTrue(prompt.text.contains("Question: Which?\n\n" + built.text + "\n\nSessions:"))
        XCTAssertEqual(prompt.metrics.profileTokens, TokenEstimate.tokens(built.text))
        // 120 bytes (the "–" takes 3): 40 tokens.
        XCTAssertEqual(built.text.utf8.count, 120)
        XCTAssertEqual(prompt.metrics.profileTokens, 40)
        XCTAssertEqual(prompt.metrics.profile, ProfileUse(interestsNamed: 1, levels: .inferred, formats: nil, skips: true,
                                                          reservedToday: true))
        XCTAssertEqual(prompt.sentIDs, ["a"])
        // Nothing in the metrics is text: they can be logged.
        let strings = Mirror(reflecting: prompt.metrics).children.filter { $0.value is String }
        XCTAssertTrue(strings.isEmpty)
        let profileStrings = Mirror(reflecting: prompt.metrics.profile).children.filter { $0.value is String }
        XCTAssertTrue(profileStrings.isEmpty)
    }
}
