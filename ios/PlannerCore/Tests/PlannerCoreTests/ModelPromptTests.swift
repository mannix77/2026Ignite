import XCTest
@testable import PlannerCore

/// The prompt for the on-device model stays within its window (#193, step 2). The catalog tests
/// use the real re:Invent 2026 sessions, with placeholder abstracts at the real lengths.
final class ModelPromptTests: XCTestCase {
    private let question = "Which of these should I go to?"

    /// The sessions of a block with the longest text first: the worst case for the budget.
    private func longestFirst(_ sessions: [Session]) -> [Session] {
        sessions.sorted {
            (ModelPrompt.line($0).count + min($0.abstract?.count ?? 0, 300), $1.sessionId)
                > (ModelPrompt.line($1).count + min($1.abstract?.count ?? 0, 300), $0.sessionId)
        }
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
        // The longest real abstract, as measured on the catalog on 2026-11-24.
        XCTAssertEqual(lengths.values.max(), 1122)
    }

    func testTheBusiestHourFitsTheWindow() throws {
        let block = runningInHour(try realCatalog(), date: "2026-12-03", hour: 13)
        XCTAssertEqual(block.count, 149) // measured on the catalog on 2026-11-23
        let prompt = ModelPrompt.build(question: question, ranked: longestFirst(block), sessionsInBlock: block.count,
                                       picks: [])
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
        // 753 characters: 251 tokens at 3 characters each, rounded up; 3,096 - 251 to spare.
        XCTAssertEqual(prompt.text.count, 753)
        XCTAssertEqual(prompt.metrics, PromptMetrics(estimatedTokens: 251, window: 4096, answerReserve: 1000,
                                                     headroom: 2845, sessionsInBlock: 7, sessionsSent: 2,
                                                     sessionsLeftOut: 0, abstractsCut: 1))
        XCTAssertEqual(prompt.sentIDs, ["long", "short"])
        XCTAssertTrue(prompt.text.contains("Question: Which of these should I go to?"))
        XCTAssertTrue(prompt.text.contains("LONG | Title long |"))
    }

    func testTokensAreCharactersOverThreeRoundedUp() {
        XCTAssertEqual(TokenEstimate.tokens(""), 0)
        XCTAssertEqual(TokenEstimate.tokens("a"), 1)
        XCTAssertEqual(TokenEstimate.tokens("abc"), 1)
        XCTAssertEqual(TokenEstimate.tokens("abcd"), 2)
        XCTAssertEqual(TokenEstimate.tokens("abcdef"), 2)
        XCTAssertEqual(TokenEstimate.tokens("abcdefg"), 3)
    }

    func testTheBuiltPromptCutsAbstractsAtThreeHundredAndNamesFifteenInterests() {
        let words = String(repeating: "word ", count: 80)
        var whole = session("whole", time: "13:00")
        whole.abstract = String(words.prefix(300))
        var over = session("over", time: "13:00")
        over.abstract = String(words.prefix(301))
        let picks = (0..<20).map { i -> Session in
            var s = session("p\(i)")
            s.topics = (0...i).map { "I\($0)" } // "I0" on all 20 picks, "I19" on one
            return s
        }
        let prompt = ModelPrompt.build(question: question, ranked: [whole, over], sessionsInBlock: 2, picks: picks)
        XCTAssertEqual(prompt.metrics.abstractsCut, 1)
        XCTAssertTrue(prompt.text.contains("\n" + String(words.prefix(300)) + "\n"))
        XCTAssertTrue(prompt.text.contains("Their interests: " + (0..<15).map { "I\($0) (\(20 - $0))" }.joined(separator: ", ") + "\n"))
        XCTAssertFalse(prompt.text.contains("I15 ("))
    }

    func testALongQuestionIsCutLikeAnAbstract() {
        let question = String(repeating: "why ", count: 100) // 400 characters
        let prompt = ModelPrompt.build(question: question, ranked: [], sessionsInBlock: 0, picks: [])
        XCTAssertTrue(prompt.text.contains("Question: " + ModelPrompt.cut(question, to: 300) + "\n"))
        XCTAssertFalse(prompt.text.contains(question))
        XCTAssertEqual(prompt.metrics.sessionsSent, 0)
    }
}
