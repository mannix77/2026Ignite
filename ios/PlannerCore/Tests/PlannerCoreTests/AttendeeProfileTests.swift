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

    func testAFormatHeSkipsIsNeverInferredAsOneHeChooses() {
        let picks = (0..<5).map { pick("p\($0)", level: advanced, type: "Keynote") }
        var preferences = SessionPreferences()
        preferences.setSkipped("Keynote", true)
        let built = profile(picks, preferences)
        XCTAssertEqual(built.text, "About them:\nInterests: none yet\nLevels they choose: 300 – Advanced\nThey skip: Keynote")
        XCTAssertNil(built.use.formats)
        XCTAssertTrue(built.use.skips)
        // Without the skip it is inferred (rule 2).
        XCTAssertTrue(profile(picks).text.hasSuffix("Formats they choose: Keynote"))
    }

    func testTheSameFormatWrittenTwoWaysCountsOnce() {
        let picks = (0..<3).map { pick("a\($0)", type: "Chalk talk") } + (0..<3).map { pick("b\($0)", type: "Chalk\ntalk") }
        XCTAssertEqual(profile(picks).text, "About them:\nInterests: none yet\nFormats they choose: Chalk talk")
        // 2 and 2 are 4 of 4 picks: named, where counted apart neither would reach 3.
        let four = (0..<2).map { pick("c\($0)", type: "Chalk talk") } + (0..<2).map { pick("d\($0)", type: " Chalk  talk ") }
        XCTAssertEqual(profile(four).text, "About them:\nInterests: none yet\nFormats they choose: Chalk talk")
        // "Chalk | talk" is written "Chalk / talk": another name, on 1 pick, not named.
        let five = four + [pick("e", type: "Chalk | talk")]
        XCTAssertEqual(profile(five).text, "About them:\nInterests: none yet\nFormats they choose: Chalk talk")
        // A format he picks in Settings is stored the same way, so it matches the catalog's.
        var preferences = SessionPreferences()
        preferences.setPreferred(" Chalk\ntalk ", true)
        preferences.setSkipped("Key | note", true)
        XCTAssertEqual(preferences.preferredFormats, ["Chalk talk"])
        XCTAssertEqual(preferences.skippedFormats, ["Key / note"])
    }

    func testAVeryLongCatalogStillFitsTheCap() {
        let family = "👨‍👩‍👧‍👦"
        let catalog = "ABCDEFGHIJKLMNOP".map { pick("t\($0)", type: String($0) + String(repeating: family, count: 59)) }
        var preferences = SessionPreferences()
        let formats = SessionPreferences.formats(in: catalog, keeping: preferences)
        XCTAssertEqual(formats.count, 16)
        // Each name as offered is already cut: its letter, 9 emoji and "…" (229 bytes).
        XCTAssertEqual(formats[0], "A" + String(repeating: family, count: 9) + "…")
        formats.forEach { preferences.setSkipped($0, true) }
        let built = profile(catalog, preferences)
        let skipLine = built.text.split(separator: "\n").last.map(String.init) ?? ""
        XCTAssertTrue(skipLine.hasPrefix("They skip: A"))
        XCTAssertLessThanOrEqual(skipLine.utf8.count, 300)
        XCTAssertLessThanOrEqual(TokenEstimate.tokens(built.text), 400)
        let prompt = ModelPrompt.build(question: "Which?", ranked: [session("a", time: "13:00")], sessionsInBlock: 1,
                                       picks: catalog, preferences: preferences)
        XCTAssertTrue(prompt.fits)
        XCTAssertEqual(prompt.sentIDs, ["a"])
        XCTAssertLessThanOrEqual(prompt.metrics.profileTokens, 400)
    }

    func testResettingClearsAllThree() {
        var preferences = SessionPreferences()
        XCTAssertTrue(preferences.isEmpty)
        preferences.setLevel(advanced, chosen: true)
        XCTAssertFalse(preferences.isEmpty)
        preferences.setPreferred("Workshop", true)
        preferences.setSkipped("Keynote", true)
        preferences.reset()
        XCTAssertEqual(preferences, SessionPreferences())
        XCTAssertTrue(preferences.isEmpty)
        var onlySkip = SessionPreferences()
        onlySkip.setSkipped("Keynote", true)
        XCTAssertFalse(onlySkip.isEmpty)
        var onlyPreferred = SessionPreferences()
        onlyPreferred.setPreferred("Workshop", true)
        XCTAssertFalse(onlyPreferred.isEmpty)
    }

    func testTheSettingsRowsSummariseWhatIsChosen() {
        XCTAssertEqual(Wording.preferenceSummary([], none: "Any"), "Any")
        XCTAssertEqual(Wording.preferenceSummary([], none: "None"), "None")
        XCTAssertEqual(Wording.preferenceSummary(["Workshop"], none: "Any"), "Workshop")
        XCTAssertEqual(Wording.preferenceSummary(["Workshop", "Keynote"], none: "Any"), "2 chosen")
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

    func testTheCapIsKeptToTheToken() {
        // 3 picks: "About them:\nInterests: Alpha (3), Beta (2)\nFormats they choose: Workshop" is
        // 12 + 31 + 29 = 72 bytes, 24 tokens. At 24 it is whole; at 23 the inferred formats go
        // (2 interests are under the 5 kept first).
        let picks = [pick("a", type: "Workshop", topics: ["Alpha", "Beta"]),
                     pick("b", type: "Workshop", topics: ["Alpha", "Beta"]),
                     pick("c", type: "Workshop", topics: ["Alpha"])]
        let whole = "About them:\nInterests: Alpha (3), Beta (2)\nFormats they choose: Workshop"
        XCTAssertEqual(whole.utf8.count, 72)
        var budget = PromptBudget()
        budget.profileTokenLimit = 24
        XCTAssertEqual(profile(picks, budget: budget).text, whole)
        budget.profileTokenLimit = 23
        XCTAssertEqual(profile(picks, budget: budget).text, "About them:\nInterests: Alpha (3), Beta (2)")
    }

    func testInferredLevelsGoBeforeInferredFormats() {
        let picks = (0..<3).map { pick("p\($0)", level: advanced, type: "Workshop") }
        let whole = profile(picks).text
        XCTAssertEqual(whole, "About them:\nInterests: none yet\nLevels they choose: 300 – Advanced\nFormats they choose: Workshop")
        // 98 bytes (33 tokens) whole; without the levels line 61 (21 tokens).
        XCTAssertEqual(whole.utf8.count, 98)
        var budget = PromptBudget()
        budget.profileTokenLimit = 33
        XCTAssertEqual(profile(picks, budget: budget).text, whole)
        budget.profileTokenLimit = 32
        XCTAssertEqual(profile(picks, budget: budget).text, "About them:\nInterests: none yet\nFormats they choose: Workshop")
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
