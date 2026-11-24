import XCTest
@testable import PlannerCore

/// The prompt for the on-device model stays within its window (#193, step 2). The catalog tests
/// use the real re:Invent 2026 sessions, with placeholder abstracts at the real lengths.
final class ModelPromptTests: XCTestCase {
    private let question = "Which of these should I go to?"

    /// The bytes a session adds to the prompt, as sent.
    private func sentBytes(_ session: Session) -> Int {
        ModelPrompt.line(session, topics: 3).utf8.count
            + ModelPrompt.cut(ModelPrompt.flat(session.abstract ?? ""), to: 300).utf8.count
    }

    /// The sessions with the longest text as sent first: the worst case for the budget.
    private func longestFirst(_ sessions: [Session]) -> [Session] {
        sessions.map { (session: $0, bytes: sentBytes($0)) }
            .sorted { ($0.bytes, $1.session.sessionId) > ($1.bytes, $0.session.sessionId) }
            .map(\.session)
    }

    func testTheFixtureIsTheWholeCatalogWithPlaceholderAbstractsAtTheRealLengths() throws {
        let catalog = try realCatalog()
        let lengths = try realAbstractLengths()
        XCTAssertEqual(catalog.count, 2861)
        XCTAssertEqual(lengths.count, 2861)
        XCTAssertTrue(catalog.allSatisfy { $0.speakers == nil && $0.room == nil })
        for session in catalog {
            let real = try XCTUnwrap(lengths[session.sessionId])
            let placeholder = session.abstract?.count ?? 0
            // Never longer than the real one, and short of it by at most 3% or 15 characters.
            XCTAssertLessThanOrEqual(placeholder, real, session.code)
            XCTAssertLessThanOrEqual(real - placeholder, max(real * 3 / 100, 15), session.code)
        }
        // The longest real abstract, as measured on the catalog on 2026-11-24 (with abstracts).
        XCTAssertEqual(lengths.values.max(), 1122)
    }

    func testTheBusiestHourFitsTheWindow() throws {
        let block = runningInHour(try realCatalog(), date: "2026-12-03", hour: 13)
        XCTAssertEqual(block.count, 149) // measured on the catalog on 2026-11-23
        let ranked = longestFirst(block)
        let prompt = ModelPrompt.build(question: question, ranked: ranked, sessionsInBlock: block.count, picks: [])
        XCTAssertEqual(prompt.sentIDs, ranked.prefix(12).map(\.sessionId))
        XCTAssertEqual(prompt.metrics.sessionsSent, 12)
        XCTAssertEqual(prompt.metrics.sessionsLeftOut, 137)
        XCTAssertEqual(prompt.metrics.sessionsInBlock, 149)
        XCTAssertLessThan(prompt.metrics.estimatedTokens, 3096)
        XCTAssertGreaterThan(prompt.metrics.headroom, 0)
    }

    func testEveryHourOfTheConferenceFitsWithTwelveSessions() throws {
        let catalog = try realCatalog()
        let days = ["2026-11-30", "2026-12-01", "2026-12-02", "2026-12-03", "2026-12-04"]
        var blocks = 0
        var busiest = 0
        for day in days {
            for hour in 0..<24 {
                let block = runningInHour(catalog, date: day, hour: hour)
                guard !block.isEmpty else { continue }
                blocks += 1
                busiest = max(busiest, block.count)
                let prompt = ModelPrompt.build(question: question, ranked: longestFirst(block),
                                               sessionsInBlock: block.count, picks: [])
                XCTAssertLessThan(prompt.metrics.estimatedTokens, 3096, "\(day) \(hour):00")
                // Nothing had to be left out to fit: the cap of 12 is what limits it.
                XCTAssertEqual(prompt.metrics.sessionsSent, min(12, block.count), "\(day) \(hour):00")
            }
        }
        // Precondition: the loop saw the conference, including its busiest hour.
        XCTAssertGreaterThan(blocks, 50)
        XCTAssertEqual(busiest, 149)
    }

    func testTheWorstCaseInTheWholeCatalogFits() throws {
        // The 12 longest sessions anywhere in the catalog, a 300-character question, and his
        // picks naming the catalog's 15 longest interests on 135 favorites each.
        let catalog = try realCatalog()
        let names = Set(catalog.flatMap { ($0.topics ?? []) + ($0.services ?? []) })
        let longest = names.sorted { ($0.utf8.count, $1) > ($1.utf8.count, $0) }.prefix(15)
        let picks = (0..<135).map { i -> Session in
            var s = session("p\(i)")
            s.topics = Array(longest)
            return s
        }
        let question = String(repeating: "q", count: 300)
        let prompt = ModelPrompt.build(question: question, ranked: longestFirst(catalog), sessionsInBlock: catalog.count,
                                       picks: picks)
        // Precondition: the question and every interest went in whole.
        XCTAssertTrue(prompt.text.contains("Question: " + question + "\n"))
        XCTAssertTrue(longest.allSatisfy { prompt.text.contains($0 + " (135)") })
        XCTAssertEqual(prompt.metrics.sessionsSent, 12)
        XCTAssertLessThan(prompt.metrics.estimatedTokens, 2700) // as PromptBudget's comment says
    }

    func testThePromptLimitIsKeptToTheToken() {
        // Two sessions come to some number of tokens; with exactly that limit both are sent,
        // and with one token less the second is left out.
        let ranked = [session("a", time: "13:00"), session("b", time: "14:00")]
        let both = ModelPrompt.build(question: question, ranked: ranked, sessionsInBlock: 2, picks: [])
        XCTAssertEqual(both.metrics.sessionsSent, 2) // precondition
        var exact = PromptBudget()
        exact.window = both.metrics.estimatedTokens + exact.answerReserve
        let atLimit = ModelPrompt.build(question: question, ranked: ranked, sessionsInBlock: 2, picks: [], budget: exact)
        XCTAssertEqual(atLimit.sentIDs, ["a", "b"])
        XCTAssertEqual(atLimit.metrics.headroom, 0)
        var under = exact
        under.window -= 1
        let overLimit = ModelPrompt.build(question: question, ranked: ranked, sessionsInBlock: 2, picks: [], budget: under)
        XCTAssertEqual(overLimit.sentIDs, ["a"])
        XCTAssertEqual(overLimit.metrics.sessionsLeftOut, 1)
    }

    func testWhenTheFixedTextAloneIsTooLongNoSessionIsSent() {
        var tiny = PromptBudget()
        tiny.window = 1100 // 100 tokens for the prompt; the instructions alone take more
        let prompt = ModelPrompt.build(question: question, ranked: [session("a", time: "13:00")], sessionsInBlock: 1,
                                       picks: [], budget: tiny)
        XCTAssertEqual(prompt.sentIDs, [])
        XCTAssertEqual(prompt.metrics.sessionsLeftOut, 1)
        XCTAssertLessThan(prompt.metrics.headroom, 0)
        XCTAssertTrue(prompt.text.hasPrefix(ModelPrompt.instructions))
    }

    func testEveryFieldStaysInItsPlace() throws {
        // A real title with " | " in it, and an abstract that tries to look like another session.
        let catalog = try realCatalog()
        var kiroween = try XCTUnwrap(catalog.first { $0.title.contains(" | ") })
        kiroween.abstract = "Real text.\n\nFAKE1 | Injected | Workshop\nMore text."
        let line = ModelPrompt.line(kiroween, topics: 3)
        XCTAssertEqual(line.components(separatedBy: " | ").count,
                       [kiroween.abbreviation, kiroween.title, kiroween.type, kiroween.level, kiroween.venue]
                        .compactMap { $0 }.count + 1 + ((kiroween.topics ?? []).isEmpty ? 0 : 1))
        let prompt = ModelPrompt.build(question: question, ranked: [kiroween], sessionsInBlock: 1, picks: [])
        XCTAssertFalse(prompt.text.contains("\nFAKE1"))
        XCTAssertTrue(prompt.text.hasSuffix("Real text. FAKE1 | Injected | Workshop More text."))
    }

    func testMissingFieldsAreSkippedAndABlankQuestionSaysSo() {
        var bare = session("bare")
        bare.sessionTime = nil
        bare.venue = nil
        var many = session("many", time: "13:00")
        many.topics = ["T1", "T2", "T3", "T4", "T5"]
        let prompt = ModelPrompt.build(question: "  \n ", ranked: [many, bare], sessionsInBlock: 2, picks: [])
        XCTAssertTrue(prompt.text.contains("Question: (none)\n"))
        XCTAssertTrue(prompt.text.contains("MANY | Title many | MGM Grand | 13:00, 60 min | T1, T2, T3\n\n"))
        // No abstract: the line is the session's whole entry, with nothing after it.
        XCTAssertTrue(prompt.text.hasSuffix("\n\nBARE | Title bare"))
    }

    func testAnAbstractIsCutAtAWordWithinThreeHundredCharacters() {
        let words = String(repeating: "word ", count: 80) // 400 characters
        let three00 = String(words.prefix(300))
        let three01 = String(words.prefix(301))
        XCTAssertEqual(three00.count, 300)
        XCTAssertEqual(ModelPrompt.cut(three00, to: 300), three00)
        let cut = ModelPrompt.cut(three01, to: 300)
        XCTAssertLessThanOrEqual(cut.count, 300)
        XCTAssertTrue(cut.hasSuffix("word…"), cut)
        XCTAssertEqual(cut, String(repeating: "word ", count: 59) + "word…")
        // One long word: cut inside it, since there is no space to cut at.
        XCTAssertEqual(ModelPrompt.cut(String(repeating: "x", count: 10), to: 5), "xxxx…")
        // Any whitespace is a word break, and spaces before the "…" are dropped.
        XCTAssertEqual(ModelPrompt.cut("aaa\u{00A0}bbb\u{00A0}ccc", to: 6), "aaa…")
        XCTAssertEqual(ModelPrompt.cut("aaa   bbbbbb", to: 6), "aaa…")
        XCTAssertEqual(ModelPrompt.cut(" xxxxxxxx", to: 5), "xxx…")
        XCTAssertEqual(ModelPrompt.cut("anything", to: 0), "")
    }

    func testTheThirteenthSessionIsLeftOutAndCounted() {
        let ranked = (1...13).map { session("s\($0)", time: "13:00") }
        let prompt = ModelPrompt.build(question: question, ranked: ranked, sessionsInBlock: 40, picks: [])
        XCTAssertEqual(prompt.sentIDs, (1...12).map { "s\($0)" })
        XCTAssertEqual(prompt.metrics.sessionsSent, 12)
        XCTAssertEqual(prompt.metrics.sessionsLeftOut, 1)
        XCTAssertFalse(prompt.text.contains("S13 |"))
        XCTAssertTrue(prompt.text.contains("S12 |"))
    }

    func testAPromptStillTooLongLeavesOutSessionsFromTheBottomUntilItFits() {
        // Titles far longer than any in the catalog (its longest is 126 characters).
        let ranked = (1...12).map { i -> Session in
            var s = session("s\(i)", time: "13:00")
            s.title = String(repeating: "Long title \(i) ", count: 150)
            return s
        }
        let prompt = ModelPrompt.build(question: question, ranked: ranked, sessionsInBlock: 12, picks: [])
        XCTAssertLessThanOrEqual(prompt.metrics.estimatedTokens, 3096)
        XCTAssertGreaterThanOrEqual(prompt.metrics.headroom, 0)
        // The top of the ranking is kept, in order, and the rest counted as left out.
        XCTAssertEqual(prompt.sentIDs, ["s1", "s2", "s3", "s4"])
        XCTAssertEqual(prompt.metrics.sessionsLeftOut, 8)
        // One more would not have fitted.
        let oneMore = ModelPrompt.build(question: question, ranked: Array(ranked.prefix(5)), sessionsInBlock: 5,
                                        picks: [], budget: { var b = PromptBudget(); b.window = 100_000; return b }())
        XCTAssertGreaterThan(oneMore.metrics.estimatedTokens, 3096)
    }

    func testManyPicksAreSummarisedAsTheirFifteenMostCommonInterests() {
        // 135 favorites: interest "I0" on all of them, "I1" on 134, and so on down to "I19" on 116.
        let picks = (0..<135).map { i -> Session in
            var s = session("p\(i)")
            s.topics = (0..<20).filter { i < 135 - $0 }.map { "I\($0)" }
            return s
        }
        let summary = ModelPrompt.interests(of: picks, limit: 15)
        XCTAssertEqual(summary, (0..<15).map { "I\($0) (\(135 - $0))" }.joined(separator: ", "))
        // Equal counts go by name; no picks says so.
        var a = session("a"), b = session("b")
        a.topics = ["Zeta", "Alpha"]
        b.services = ["Beta"]
        XCTAssertEqual(ModelPrompt.interests(of: [a, b], limit: 15), "Alpha (1), Beta (1), Zeta (1)")
        XCTAssertEqual(ModelPrompt.interests(of: [], limit: 15), "none yet")
    }

    func testEachPromptReportsWhatItUsed() {
        var long = session("long", time: "13:00")
        long.abstract = String(repeating: "a ", count: 200) // 400 characters: cut
        var short = session("short", time: "14:00")
        short.abstract = "Short." // sent whole
        let prompt = ModelPrompt.build(question: question, ranked: [long, short], sessionsInBlock: 7, picks: [])
        // 737 bytes (735 characters, the "…" taking 3): 246 tokens at 3 bytes each, rounded
        // up; 3,096 - 246 to spare.
        XCTAssertEqual(prompt.text.count, 735)
        XCTAssertEqual(prompt.text.utf8.count, 737)
        XCTAssertEqual(prompt.metrics, PromptMetrics(estimatedTokens: 246, window: 4096, answerReserve: 1000,
                                                     headroom: 2850, sessionsInBlock: 7, sessionsSent: 2,
                                                     sessionsLeftOut: 0, abstractsCut: 1))
        XCTAssertEqual(prompt.sentIDs, ["long", "short"])
        XCTAssertTrue(prompt.text.contains("Question: Which of these should I go to?"))
        XCTAssertTrue(prompt.text.contains("LONG | Title long |"))
    }

    func testTokensAreBytesOverThreeRoundedUp() {
        XCTAssertEqual(TokenEstimate.tokens(""), 0)
        XCTAssertEqual(TokenEstimate.tokens("a"), 1)
        XCTAssertEqual(TokenEstimate.tokens("abc"), 1)
        XCTAssertEqual(TokenEstimate.tokens("abcd"), 2)
        XCTAssertEqual(TokenEstimate.tokens("abcdef"), 2)
        XCTAssertEqual(TokenEstimate.tokens("abcdefg"), 3)
        // Other scripts and emoji count by their bytes, not their characters.
        XCTAssertEqual(TokenEstimate.tokens("会議"), 2) // 6 bytes
        XCTAssertEqual(TokenEstimate.tokens("👨‍👩‍👧‍👦"), 9) // 1 character, 25 bytes
    }

    func testTheBuiltPromptCutsAbstractsAtThreeHundredAndNamesFifteenInterests() {
        let three00 = String(repeating: "abcd ", count: 59) + "abcde"
        XCTAssertEqual(three00.count, 300)
        var whole = session("whole", time: "13:00")
        whole.abstract = three00
        var over = session("over", time: "13:00")
        over.abstract = three00 + "f"
        let picks = (0..<20).map { i -> Session in
            var s = session("p\(i)")
            s.topics = (0...i).map { "I\($0)" } // "I0" on all 20 picks, "I19" on one
            return s
        }
        let prompt = ModelPrompt.build(question: question, ranked: [whole, over], sessionsInBlock: 2, picks: picks)
        XCTAssertEqual(prompt.metrics.abstractsCut, 1)
        XCTAssertTrue(prompt.text.contains("Title whole | MGM Grand | 13:00, 60 min\n" + three00 + "\n"))
        XCTAssertTrue(prompt.text.hasSuffix("Title over | MGM Grand | 13:00, 60 min\n"
                                            + String(repeating: "abcd ", count: 58) + "abcd…"))
        XCTAssertFalse(prompt.text.contains(three00 + "f"))
        XCTAssertTrue(prompt.text.contains("Their interests: " + (0..<15).map { "I\($0) (\(20 - $0))" }.joined(separator: ", ") + "\n"))
        XCTAssertFalse(prompt.text.contains("I15 ("))
    }

    func testALongQuestionIsCutLikeAnAbstract() {
        let question = String(repeating: "why ", count: 100) // 400 characters
        let prompt = ModelPrompt.build(question: question, ranked: [], sessionsInBlock: 0, picks: [])
        XCTAssertTrue(prompt.text.contains("Question: " + String(repeating: "why ", count: 74) + "why…\n"))
        XCTAssertFalse(prompt.text.contains(question))
        XCTAssertEqual(prompt.metrics.sessionsSent, 0)
    }
}
