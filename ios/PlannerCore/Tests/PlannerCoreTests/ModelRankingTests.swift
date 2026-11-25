import XCTest
@testable import PlannerCore

/// A model with a scripted answer that records every prompt it is sent.
private final class FakeRanker: SessionRanker, @unchecked Sendable {
    let availability: ModelAvailability
    private let answer: () async throws -> ModelAnswer
    private let lock = NSLock()
    private var sent: [ModelPrompt] = []

    init(_ availability: ModelAvailability = .available, answer: @escaping () async throws -> ModelAnswer) {
        self.availability = availability
        self.answer = answer
    }

    convenience init(picks: [ModelPick], promptTokens: Int? = nil, answerTokens: Int? = nil) {
        self.init { ModelAnswer(picks: picks, promptTokens: promptTokens, answerTokens: answerTokens) }
    }

    convenience init(failing error: Error) {
        self.init { throw error }
    }

    var prompts: [ModelPrompt] { lock.withLock { sent } }

    /// The `index`th prompt it was sent, or a test failure (not a crash) when there isn't one.
    func prompt(_ index: Int, file: StaticString = #filePath, line: UInt = #line) -> ModelPrompt? {
        let all = prompts
        guard all.indices.contains(index) else {
            XCTFail("the model was sent \(all.count) prompts, not \(index + 1)", file: file, line: line)
            return nil
        }
        return all[index]
    }

    func rank(_ prompt: ModelPrompt) async throws -> ModelAnswer {
        lock.withLock { sent.append(prompt) }
        return try await answer()
    }
}

/// Waits until cancelled, without a clock: the timer that never fires, or the model that
/// never answers.
@Sendable private func untilCancelled(_: Duration = .zero) async throws {
    while !Task.isCancelled { await Task.yield() }
    throw CancellationError()
}

/// The waits a timer was asked for.
private final class DurationLog: @unchecked Sendable {
    private let lock = NSLock()
    private var waits: [Duration] = []
    func append(_ wait: Duration) { lock.withLock { waits.append(wait) } }
    var all: [Duration] { lock.withLock { waits } }
}

/// A switch a test flips, read from other tasks.
private final class Flag: @unchecked Sendable {
    private let lock = NSLock()
    private var on = false
    func set() { lock.withLock { on = true } }
    var isSet: Bool { lock.withLock { on } }
}

/// A count other tasks add to.
private final class Counter: @unchecked Sendable {
    private let lock = NSLock()
    private var count = 0
    @discardableResult func next() -> Int { lock.withLock { defer { count += 1 }; return count } }
    var value: Int { lock.withLock { count } }
}

/// Waits until `condition` holds, failing after 10 seconds instead of hanging (rule 12).
private func waitUntil(_ test: XCTestCase, _ what: String, _ condition: @escaping @Sendable () -> Bool) async {
    let met = test.expectation(description: what)
    let poll = Task {
        while !condition(), !Task.isCancelled { await Task.yield() }
        if condition() { met.fulfill() }
    }
    await test.fulfillment(of: [met], timeout: 10)
    poll.cancel()
}

/// A task's result, failing after 10 seconds instead of hanging (rule 12).
private func result<T: Sendable>(of task: Task<T, Never>, _ test: XCTestCase) async -> T? {
    let box = Box<T>()
    let done = test.expectation(description: "task finished")
    Task { box.set(await task.value); done.fulfill() }
    await test.fulfillment(of: [done], timeout: 10)
    return box.value
}

private final class Box<T: Sendable>: @unchecked Sendable {
    private let lock = NSLock()
    private var stored: T?
    func set(_ value: T) { lock.withLock { stored = value } }
    var value: T? { lock.withLock { stored } }
}

/// A model that never answers.
private func silentModel() -> FakeRanker { FakeRanker { try await untilCancelled(); return ModelAnswer(picks: []) } }

/// "A" to "N": suggestions in the usual order, each sharing a topic named after it.
private func usualList(_ codes: [String] = (0..<14).map { String(UnicodeScalar(65 + $0)!) }) -> [Suggestion] {
    codes.enumerated().map { index, code in
        Suggestion(session: session("id-\(code)-\(index)", code: code), score: Double(100 - index), shared: ["Topic \(code)"],
                   seat: .walkUp, isFavorite: false, isRepeatOfFavorite: false)
    }
}

private func pick(_ code: String, _ reason: String? = nil) -> ModelPick { ModelPick(code: code, reason: reason ?? "Because \(code)") }

/// The model's turn on `list`, with the timer that never fires unless one is given. It fails
/// the test after 10 seconds instead of hanging (rule 12), and then gives an empty list.
private func rank(_ list: [Suggestion], with ranker: (any SessionRanker)?, sessionsInBlock: Int = 40,
                  budget: PromptBudget = PromptBudget(),
                  sleep: @escaping @Sendable (Duration) async throws -> Void = untilCancelled,
                  file: StaticString = #filePath, line: UInt = #line) async -> RankedSuggestions {
    let work = Task { await ModelStep.rank(list, sessionsInBlock: sessionsInBlock, picks: [], ranker: ranker, budget: budget, sleep: sleep) }
    let box = Box<RankedSuggestions>()
    let done = XCTestExpectation(description: "ranked")
    Task { box.set(await work.value); done.fulfill() }
    let waited = await XCTWaiter().fulfillment(of: [done], timeout: 10)
    guard waited == .completed, let ranked = box.value else {
        work.cancel()
        XCTFail("the ranking didn't return within 10 seconds", file: file, line: line)
        return RankedSuggestions(suggestions: [], run: ModelRun(outcome: .error, prompt: nil, placed: 0, ignored: 0))
    }
    return ranked
}

/// `list` in the literal `order` of codes (the k-th "S" is the k-th session coded S), each
/// with the literal reason given for its code, or none: the expected list, written out.
private func arranged(_ list: [Suggestion], _ order: [String], reasons: [String: String?] = [:],
                      file: StaticString = #filePath, line: UInt = #line) -> [Suggestion] {
    XCTAssertEqual(order.sorted(), list.map(\.session.code).sorted(), "the order names every session once", file: file, line: line)
    var used = Set<String>()
    return order.map { code in
        var suggestion = list.first { $0.session.code == code && !used.contains($0.id) }!
        used.insert(suggestion.id)
        suggestion.modelReason = reasons[code] ?? nil
        return suggestion
    }
}

/// The same, for a list coded with single letters, written as one string ("BACD…").
private func arranged(_ list: [Suggestion], _ order: String, reasons: [String: String?] = [:],
                      file: StaticString = #filePath, line: UInt = #line) -> [Suggestion] {
    arranged(list, order.map(String.init), reasons: reasons, file: file, line: line)
}

/// Every field of a run, the prompt's measures included (nil when no prompt was built).
private func assertRun(_ run: ModelRun, _ outcome: ModelOutcome, placed: Int, ignored: Int, remembered: Bool = false,
                       promptTokens: Int? = nil, answerTokens: Int? = nil, unavailable: String? = nil,
                       prompt: PromptMetrics?, file: StaticString = #filePath, line: UInt = #line) {
    XCTAssertEqual(run.prompt, prompt, "prompt measures", file: file, line: line)
    XCTAssertEqual(run.outcome, outcome, "outcome", file: file, line: line)
    XCTAssertEqual(run.placed, placed, "placed", file: file, line: line)
    XCTAssertEqual(run.ignored, ignored, "ignored", file: file, line: line)
    XCTAssertEqual(run.remembered, remembered, "remembered", file: file, line: line)
    XCTAssertEqual(run.modelPromptTokens, promptTokens, "prompt tokens", file: file, line: line)
    XCTAssertEqual(run.modelAnswerTokens, answerTokens, "answer tokens", file: file, line: line)
    XCTAssertEqual(run.unavailableReason, unavailable, "unavailable", file: file, line: line)
}

/// The measures of the prompt built for `list` (`ModelPrompt.build`, tested on its own in
/// `ModelPromptTests`), as `ModelStep.rank` builds it in these tests.
private func measures(_ list: [Suggestion], sessionsInBlock: Int = 40, budget: PromptBudget = PromptBudget()) -> PromptMetrics {
    ModelPrompt.build(question: "", ranked: list.map(\.session), sessionsInBlock: sessionsInBlock, picks: [], budget: budget).metrics
}

/// A model whose answers come from `answers` in turn, the last one repeating.
private func answering(_ answers: [[ModelPick]]) -> FakeRanker {
    let count = Box<Int>()
    return FakeRanker {
        let turn = count.value ?? 0
        count.set(turn + 1)
        return ModelAnswer(picks: answers[min(turn, answers.count - 1)])
    }
}

private func codes(_ list: [Suggestion]) -> [String] { list.map(\.session.code) }

final class ModelRankingTests: XCTestCase {
    func testTheModelsOrderGoesFirstWithItsReasons() async {
        let list = usualList()
        let model = FakeRanker(picks: [pick("L"), pick("B"), pick("A")])
        let ranked = await rank(list, with: model)

        // It was sent the first 12 of the 14, by the codes the prompt shows.
        XCTAssertEqual(model.prompts.map(\.sentIDs), [list.prefix(12).map(\.id)])
        XCTAssertEqual(model.prompts.first?.sentCodes, ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L"])
        XCTAssertEqual(codes(ranked.suggestions), ["L", "B", "A", "C", "D", "E", "F", "G", "H", "I", "J", "K", "M", "N"])
        XCTAssertEqual(ranked.suggestions, arranged(list, "LBACDEFGHIJKMN", reasons: ["L": "Because L", "B": "Because B", "A": "Because A"]))
        XCTAssertEqual(ranked.suggestions.map(Wording.reasons),
                       ["Because L", "Because B", "Because A"] + "CDEFGHIJKMN".map { "Shares Topic \($0)" })
        assertRun(ranked.run, .ok, placed: 3, ignored: 0, prompt: measures(list))
        XCTAssertEqual(ranked.run.prompt, model.prompts.first?.metrics)
        XCTAssertEqual(Wording.modelHeader(ranked.run), "Top 3 ranked by Apple Intelligence")
    }

    func testOnlyWhatWasSentCanMove() async {
        let list = usualList()
        let model = FakeRanker(picks: [pick("XYZ999"), pick("B"), pick("C"), pick("M")])
        let ranked = await rank(list, with: model)

        // M was in the list but not sent.
        XCTAssertFalse(model.prompts.first?.sentIDs.contains(list[12].id) ?? true)
        XCTAssertEqual(ranked.suggestions, arranged(list, "BCADEFGHIJKLMN", reasons: ["B": "Because B", "C": "Because C"]))
        assertRun(ranked.run, .ok, placed: 2, ignored: 2, prompt: measures(list))
    }

    func testASessionNamedTwiceMovesOnce() async {
        let list = usualList()
        let ranked = await rank(list, with: FakeRanker(picks: [pick("B", "First"), pick("A"), pick("B", "Second")]))

        XCTAssertEqual(ranked.suggestions, arranged(list, "BACDEFGHIJKLMN", reasons: ["B": "First", "A": "Because A"]))
        assertRun(ranked.run, .ok, placed: 2, ignored: 1, prompt: measures(list))
    }

    func testACodeTwoSentSessionsShareMovesNeither() async {
        let list = usualList(["A", "AIM301", "AIM301", "B"])
        let model = FakeRanker(picks: [pick("AIM301"), pick("B")])
        let ranked = await rank(list, with: model)

        // Both were sent, so the model saw the code twice.
        XCTAssertEqual(model.prompts.map(\.sentIDs), [list.map(\.id)])
        XCTAssertEqual(model.prompts.first?.sentCodes, ["A", "AIM301", "AIM301", "B"])
        XCTAssertEqual(ranked.suggestions, arranged(list, ["B", "A", "AIM301", "AIM301"], reasons: ["B": "Because B"]))
        assertRun(ranked.run, .ok, placed: 1, ignored: 1, prompt: measures(list))
    }

    func testACodeThreeSentSessionsShareMovesNoneOfThem() async {
        let list = usualList(["S", "S", "S", "B"])
        let model = FakeRanker(picks: [pick("S"), pick("B")])
        let ranked = await rank(list, with: model)
        XCTAssertEqual(model.prompts.map(\.sentIDs), [list.map(\.id)])
        XCTAssertEqual(ranked.suggestions, arranged(list, ["B", "S", "S", "S"], reasons: ["B": "Because B"]))
        assertRun(ranked.run, .ok, placed: 1, ignored: 1, prompt: measures(list))
    }

    func testASharedCodeIsIgnoredButNotWrong() async {
        // S was sent twice: naming it moves neither, but it isn't a code the model wasn't sent.
        let list = usualList(["S", "S", "B"])
        let ranked = await rank(list, with: FakeRanker(picks: [pick("S"), pick("B"), pick("X1")]))
        XCTAssertEqual(ranked.suggestions, arranged(list, ["B", "S", "S"], reasons: ["B": "Because B"]))
        assertRun(ranked.run, .ok, placed: 1, ignored: 2, prompt: measures(list))
    }

    func testTheCodeIsMatchedAsThePromptShowedIt() async {
        // The prompt shows " AIM|301\n" on one line with "|" as "/".
        let list = usualList(["A", " AIM|301\n", "B", "C"])
        let model = FakeRanker(picks: [pick("AIM/301"), pick("AIM|301"), pick("C"), pick(" B ", "Because B"), pick("aim/301")])
        let ranked = await rank(list, with: model)

        XCTAssertTrue(model.prompts.first?.text.contains("\nAIM/301 | Title id- AIM/301 -1 |") ?? false)
        XCTAssertEqual(model.prompts.first?.sentCodes, ["A", "AIM/301", "B", "C"])
        // "AIM/301" as shown moves it; "AIM|301" and "aim/301" aren't what was shown. The
        // model's code is trimmed, as every identifier is, so " B " is B.
        var aim = list[1]
        aim.modelReason = "Because AIM/301"
        var c = list[3]
        c.modelReason = "Because C"
        var b = list[2]
        b.modelReason = "Because B"
        XCTAssertEqual(ranked.suggestions, [aim, c, b, list[0]])
        assertRun(ranked.run, .ok, placed: 3, ignored: 2, prompt: measures(list))

        // In other letters, without the exact code beside it, the code moves nothing.
        let lower = await rank(list, with: FakeRanker(picks: [pick("aim/301"), pick("C")]))
        XCTAssertEqual(lower.suggestions, arranged(list, ["C", "A", " AIM|301\n", "B"], reasons: ["C": "Because C"]))
        assertRun(lower.run, .ok, placed: 1, ignored: 1, prompt: measures(list))

        // Written as the catalog has it, not as the prompt showed it, the code moves nothing.
        let piped = usualList(["A", "X|1", "C"])
        let catalogSpelling = await rank(piped, with: FakeRanker(picks: [pick("X|1"), pick("C")]))
        XCTAssertEqual(catalogSpelling.suggestions, arranged(piped, ["C", "A", "X|1"], reasons: ["C": "Because C"]))
        assertRun(catalogSpelling.run, .ok, placed: 1, ignored: 1, prompt: measures(piped))
    }

    func testACodeMatchesOnlyInTheSameUnicodeSpelling() async {
        let composed = "CAF\u{00C9}1"     // É as one character
        let decomposed = "CAFE\u{0301}1"  // E and a combining accent
        XCTAssertEqual(composed, decomposed)  // the same to Swift's String
        XCTAssertNotEqual(Array(composed.utf8), Array(decomposed.utf8))
        let list = usualList(["A", composed, "C"])
        let other = await rank(list, with: FakeRanker(picks: [pick(decomposed), pick("C")]))
        XCTAssertEqual(other.suggestions, arranged(list, ["C", "A", composed], reasons: ["C": "Because C"]))
        assertRun(other.run, .ok, placed: 1, ignored: 1, prompt: measures(list))
        // The spelling the prompt showed moves it.
        let same = await rank(list, with: FakeRanker(picks: [pick(composed), pick("C")]))
        XCTAssertEqual(same.suggestions, arranged(list, [composed, "C", "A"], reasons: [composed: "Because \(composed)", "C": "Because C"]))
        assertRun(same.run, .ok, placed: 2, ignored: 0, prompt: measures(list))
    }

    func testAnAnswerThatIsMostlyWrongIsNotUsed() async {
        let list = usualList()
        let wrong = await rank(list, with: FakeRanker(picks: [pick("C"), pick("X1"), pick("B"), pick("X2"), pick("X3")]))
        XCTAssertEqual(wrong.suggestions, list)
        assertRun(wrong.run, .unusable, placed: 0, ignored: 3, prompt: measures(list))
        XCTAssertNil(Wording.modelHeader(wrong.run))

        // Half wrong is still used.
        let half = await rank(list, with: FakeRanker(picks: [pick("C"), pick("X1"), pick("B"), pick("X2")]))
        XCTAssertEqual(half.suggestions, arranged(list, "CBADEFGHIJKLMN", reasons: ["C": "Because C", "B": "Because B"]))
        assertRun(half.run, .ok, placed: 2, ignored: 2, prompt: measures(list))
    }

    func testRepeatsAreNotCountedAsWrong() async {
        let list = usualList()
        // One session named three times: repeats are ignored, but they aren't wrong.
        let ranked = await rank(list, with: FakeRanker(picks: [pick("C"), pick("C"), pick("C")]))
        XCTAssertEqual(ranked.suggestions, arranged(list, "CABDEFGHIJKLMN", reasons: ["C": "Because C"]))
        assertRun(ranked.run, .ok, placed: 1, ignored: 2, prompt: measures(list))

        // A code it wasn't sent, named twice, is one wrong code.
        let twice = await rank(list, with: FakeRanker(picks: [pick("B"), pick("X1"), pick("X1")]))
        XCTAssertEqual(twice.suggestions, arranged(list, "BACDEFGHIJKLMN", reasons: ["B": "Because B"]))
        assertRun(twice.run, .ok, placed: 1, ignored: 2, prompt: measures(list))

        // Two different codes it wasn't sent, against one it was, are mostly wrong.
        let wrong = await rank(list, with: FakeRanker(picks: [pick("B"), pick("X1"), pick("X2")]))
        XCTAssertEqual(wrong.suggestions, list)
        assertRun(wrong.run, .unusable, placed: 0, ignored: 2, prompt: measures(list))
    }

    func testAnEmptyAnswerIsNotUsed() async {
        let list = usualList()
        let ranked = await rank(list, with: FakeRanker(picks: []))
        XCTAssertEqual(ranked.suggestions, list)
        assertRun(ranked.run, .unusable, placed: 0, ignored: 0, prompt: measures(list))
    }

    func testALongReasonIsCutAtAWordAndAnEmptyOneShowsWhatItShares() async {
        let words = Array(repeating: "abcd", count: 30).joined(separator: " ")   // 149 characters
        let long = words + "\nx"                                               // 151 once on one line
        let exact = Array(repeating: "abcd", count: 29).joined(separator: " ") + " abcde" // 150
        XCTAssertEqual(words.count, 149)
        XCTAssertEqual(exact.count, 150)
        let list = usualList()
        let ranked = await rank(list, with: FakeRanker(picks: [pick("A", long), pick("B", exact), pick("C", " \n ")]))

        XCTAssertEqual(ranked.suggestions, arranged(list, "ABCDEFGHIJKLMN", reasons: ["A": words + "…", "B": exact]))
        XCTAssertEqual(ranked.suggestions[0].modelReason?.count, 150)
        XCTAssertEqual(Wording.reasons(ranked.suggestions[2]), "Shares Topic C")
        assertRun(ranked.run, .ok, placed: 3, ignored: 0, prompt: measures(list))

        // The reason is shown as written, on one line: a "|" stays.
        let piped = await rank(list, with: FakeRanker(picks: [pick("A", "Fast |\n cheap")]))
        XCTAssertEqual(piped.suggestions, arranged(list, "ABCDEFGHIJKLMN", reasons: ["A": "Fast | cheap"]))
        assertRun(piped.run, .ok, placed: 1, ignored: 0, prompt: measures(list))
    }

    func testWithoutAppleIntelligenceTheModelIsNotAsked() async {
        let list = usualList()
        let model = FakeRanker(.unavailable("modelNotReady")) { ModelAnswer(picks: [pick("B")]) }
        let ranked = await rank(list, with: model)

        XCTAssertTrue(model.prompts.isEmpty)
        XCTAssertEqual(ranked.suggestions, list)
        assertRun(ranked.run, .unavailable, placed: 0, ignored: 0, unavailable: "modelNotReady", prompt: nil)
        XCTAssertNil(ranked.run.prompt)

        // An iOS without the framework has no model at all.
        let none = await rank(list, with: nil)
        XCTAssertEqual(none.suggestions, list)
        assertRun(none.run, .unavailable, placed: 0, ignored: 0, unavailable: "unsupported", prompt: nil)
        XCTAssertNil(none.run.prompt)

        // The same list is ranked by a model that is available.
        let availableModel = FakeRanker(picks: [pick("B")])
        let available = await rank(list, with: availableModel)
        XCTAssertEqual(available.suggestions, arranged(list, "BACDEFGHIJKLMN", reasons: ["B": "Because B"]))
        assertRun(available.run, .ok, placed: 1, ignored: 0, prompt: availableModel.prompts.first?.metrics)
    }

    func testEveryWayTheModelFailsKeepsTheUsualList() async {
        struct Other: Error {}
        let list = usualList()
        let cases: [(Error, ModelOutcome)] = [(ModelFailure.refused, .refused), (ModelFailure.contextExceeded, .contextExceeded),
                                              (ModelFailure.guardrail, .guardrail), (ModelFailure.timedOut, .timeout),
                                              (Other(), .error)]
        for (error, outcome) in cases {
            let model = FakeRanker(failing: error)
            let ranked = await rank(list, with: model)
            XCTAssertEqual(model.prompts.map(\.sentIDs), [list.prefix(12).map(\.id)], "\(outcome)")
            XCTAssertEqual(ranked.suggestions, list, "\(outcome)")
            assertRun(ranked.run, outcome, placed: 0, ignored: 0, prompt: measures(list))
            XCTAssertEqual(ranked.run.prompt, model.prompts.first?.metrics, "\(outcome)")
        }
    }

    func testTheModelThatTakesTooLong() async {
        let list = usualList()
        let asked = DurationLog()
        // The timer fires at once; the model never answers.
        let late = await rank(list, with: silentModel()) { asked.append($0) }
        XCTAssertEqual(late.suggestions, list)
        assertRun(late.run, .timeout, placed: 0, ignored: 0, prompt: measures(list))
        XCTAssertEqual(asked.all, [.seconds(20)])
    }

    func testAnAnswerBeforeTheTimerIsUsed() async {
        let list = usualList()
        // The timer fires only once the ranking has returned, so an answer that comes first
        // must decide it: a ranking that waited for the timer would never return.
        let returned = Flag()
        let fired = Flag()
        let ranked = await rank(list, with: FakeRanker(picks: [pick("B")])) { _ in
            while !returned.isSet { try Task.checkCancellation(); await Task.yield() }
            fired.set()
        }
        // Checked before the timer is let go: it hadn't fired when the ranking returned.
        XCTAssertFalse(fired.isSet)
        returned.set()
        XCTAssertEqual(ranked.suggestions, arranged(list, "BACDEFGHIJKLMN", reasons: ["B": "Because B"]))
        assertRun(ranked.run, .ok, placed: 1, ignored: 0, prompt: measures(list))
    }

    func testTheTimeoutHoldsForAModelThatIgnoresBeingStopped() async {
        let list = usualList()
        let started = Flag()
        let release = Flag()
        let finished = Flag()
        // It keeps working after it is cancelled, until the test lets it go.
        let stubborn = FakeRanker {
            started.set()
            while !release.isSet { await Task.yield() }
            finished.set()
            return ModelAnswer(picks: [pick("B")])
        }
        // The timer fires once the model is working.
        let ranked = await rank(list, with: stubborn) { _ in
            while !started.isSet { try Task.checkCancellation(); await Task.yield() }
        }
        // It returned while the model was still working.
        XCTAssertTrue(started.isSet)
        XCTAssertFalse(finished.isSet)
        XCTAssertEqual(ranked.suggestions, list)
        assertRun(ranked.run, .timeout, placed: 0, ignored: 0, prompt: measures(list))
        // The model is then let go, and finishes.
        release.set()
        await waitUntil(self, "the model finishes") { finished.isSet }
    }

    func testClosingTheListStopsTheWaitAtOnce() async {
        let list = usualList()
        let model = silentModel()
        let task = Task { await ModelStep.rank(list, sessionsInBlock: 40, picks: [], ranker: model, sleep: untilCancelled) }
        // Cancelled once the model has the prompt; neither it nor the timer ever finishes.
        await waitUntil(self, "the model has the prompt") { !model.prompts.isEmpty }
        task.cancel()
        let ranked = await result(of: task, self)
        XCTAssertEqual(ranked?.suggestions, list)
        if let ranked { assertRun(ranked.run, .cancelled, placed: 0, ignored: 0, prompt: measures(list)) }
        XCTAssertEqual(model.prompts.count, 1)
    }

    func testACallerAlreadyStoppedAsksNothing() async {
        let list = usualList()
        let model = FakeRanker(picks: [pick("B")])
        let started = Flag()
        let task = Task { () -> RankedSuggestions in
            started.set()
            while !Task.isCancelled { await Task.yield() }
            return await ModelStep.rank(list, sessionsInBlock: 40, picks: [], ranker: model, sleep: untilCancelled)
        }
        await waitUntil(self, "the caller has started") { started.isSet }
        task.cancel()
        let ranked = await result(of: task, self)
        XCTAssertEqual(ranked?.suggestions, list)
        if let ranked { assertRun(ranked.run, .cancelled, placed: 0, ignored: 0, prompt: measures(list)) }
        XCTAssertTrue(model.prompts.isEmpty)
        // The same model is asked by a caller that isn't stopped.
        let asked = await rank(list, with: model)
        XCTAssertEqual(model.prompts.count, 1)
        XCTAssertEqual(asked.suggestions, arranged(list, "BACDEFGHIJKLMN", reasons: ["B": "Because B"]))
        assertRun(asked.run, .ok, placed: 1, ignored: 0, prompt: model.prompts.first?.metrics)
    }

    func testNothingToRankAsksNothing() async {
        let model = FakeRanker(picks: [pick("A")])
        let ranked = await rank([], with: model)
        XCTAssertTrue(model.prompts.isEmpty)
        XCTAssertEqual(ranked.suggestions, [])
        assertRun(ranked.run, .nothingToRank, placed: 0, ignored: 0, prompt: nil)
        XCTAssertNil(ranked.run.prompt)

        // The same model is asked when there is something.
        let one = usualList(["A"])
        let asked = await rank(one, with: model)
        XCTAssertEqual(model.prompts.map(\.sentIDs), [[one[0].id]])
        XCTAssertEqual(asked.suggestions, arranged(one, "A", reasons: ["A": "Because A"]))
        assertRun(asked.run, .ok, placed: 1, ignored: 0, prompt: model.prompts.first?.metrics)
    }

    func testAPromptWhoseFixedTextDoesNotFitIsNotSent() async {
        var tiny = PromptBudget()
        tiny.window = 1100   // 100 tokens for the prompt: less than the instructions
        let model = FakeRanker(picks: [pick("A")])
        let list = usualList()
        let ranked = await rank(list, with: model, budget: tiny)
        XCTAssertTrue(model.prompts.isEmpty)
        XCTAssertEqual(ranked.suggestions, list)
        assertRun(ranked.run, .promptTooLong, placed: 0, ignored: 0, prompt: measures(list, budget: tiny))
        XCTAssertEqual(ranked.run.prompt?.sessionsSent, 0)
        XCTAssertEqual(ranked.run.prompt?.sessionsLeftOut, 14)
    }

    func testWhatIsRecorded() async {
        let model = FakeRanker(picks: [pick("B", "Secret reason"), pick("X1")], promptTokens: 1234, answerTokens: 56)
        let list = usualList()
        let ranked = await rank(list, with: model, sessionsInBlock: 77)
        let run = ranked.run

        // The reason reached the list, and the instructions the prompt.
        XCTAssertEqual(ranked.suggestions, arranged(list, "BACDEFGHIJKLMN", reasons: ["B": "Secret reason"]))
        XCTAssertTrue(model.prompts.first?.text.hasPrefix(ModelPrompt.instructions) ?? false)
        assertRun(run, .ok, placed: 1, ignored: 1, promptTokens: 1234, answerTokens: 56, prompt: measures(list, sessionsInBlock: 77))
        XCTAssertEqual(run.prompt, model.prompts.first?.metrics)
        XCTAssertEqual(run.prompt?.sessionsInBlock, 77)
        XCTAssertEqual(run.prompt?.sessionsSent, 12)
        XCTAssertEqual(run.prompt?.sessionsLeftOut, 2)
        // Neither the prompt nor a reason is in the record.
        let recorded = String(describing: run)
        XCTAssertFalse(recorded.contains("Secret reason"))
        XCTAssertFalse(recorded.contains(ModelPrompt.instructions.prefix(40)))
        XCTAssertTrue(recorded.contains("1234"))
    }

    func testWhetherTheModelWillBeAsked() {
        XCTAssertTrue(ModelStep.willAsk(usualList(["A"]), ranker: FakeRanker(picks: [])))
        XCTAssertFalse(ModelStep.willAsk([], ranker: FakeRanker(picks: [])))
        XCTAssertFalse(ModelStep.willAsk(usualList(["A"]), ranker: FakeRanker(.unavailable("modelNotReady")) { ModelAnswer(picks: []) }))
        XCTAssertFalse(ModelStep.willAsk(usualList(["A"]), ranker: nil))
    }

    func testTheHeaderNamesHowManyTheModelRanked() {
        var run = ModelRun(outcome: .ok, prompt: nil, placed: 1, ignored: 0)
        XCTAssertEqual(Wording.modelHeader(run), "Top session ranked by Apple Intelligence")
        run.placed = 12
        XCTAssertEqual(Wording.modelHeader(run), "Top 12 ranked by Apple Intelligence")
        for outcome in [ModelOutcome.unavailable, .nothingToRank, .promptTooLong, .refused, .contextExceeded, .guardrail,
                        .timeout, .error, .unusable, .cancelled] {
            run.outcome = outcome
            XCTAssertNil(Wording.modelHeader(run), "\(outcome)")
        }
    }

    func testTheHeaderIsForTheStretchItDescribes() {
        let here = Gap(date: "2026-12-02", start: 600, end: 720, before: .open, after: .open, lineFrom: nil, lineUpAfter: false)
        var later = here
        later.start = 601
        let done = ModelRun(outcome: .ok, prompt: nil, placed: 3, ignored: 0)
        let pending = "Ranking with Apple Intelligence…"
        let top3 = "Top 3 ranked by Apple Intelligence"

        XCTAssertEqual(Wording.rankingHeader(for: here, ranking: here, ranked: nil), pending)
        XCTAssertEqual(Wording.rankingHeader(for: here, ranking: nil, ranked: (here, done)), top3)
        // A newer request for this stretch is shown over an older answer.
        XCTAssertEqual(Wording.rankingHeader(for: here, ranking: here, ranked: (here, done)), pending)
        // Neither a request nor an answer for another stretch is shown here.
        XCTAssertEqual(Wording.rankingHeader(for: here, ranking: later, ranked: (here, done)), top3)
        XCTAssertNil(Wording.rankingHeader(for: here, ranking: later, ranked: nil))
        XCTAssertNil(Wording.rankingHeader(for: here, ranking: nil, ranked: (later, done)))
        XCTAssertNil(Wording.rankingHeader(for: here, ranking: nil, ranked: nil))
        // An answer that wasn't used has no header.
        XCTAssertNil(Wording.rankingHeader(for: here, ranking: nil,
                                           ranked: (here, ModelRun(outcome: .timeout, prompt: nil, placed: 0, ignored: 0))))
    }
}

final class SessionsInBlockTests: XCTestCase {
    func testSessionsStartingInTheStretchAreCounted() {
        // The stretch runs 10:00 to 12:00 on 2 Dec.
        let gap = Gap(date: "2026-12-02", start: 600, end: 720, before: .open, after: .open, lineFrom: nil, lineUpAfter: false)
        func count(_ sessions: [Session]) -> Int {
            PlanSnapshot(sessions: sessions, schedule: Schedule(reserved: [], favorites: []),
                         fetchedAt: Date(timeIntervalSince1970: 0)).sessionsStarting(in: gap)
        }
        // Each edge on its own.
        XCTAssertEqual(count([session("at-start", time: "10:00")]), 1)
        XCTAssertEqual(count([session("before", time: "09:59")]), 0)
        XCTAssertEqual(count([session("inside", time: "11:59")]), 1)
        XCTAssertEqual(count([session("at-end", time: "12:00")]), 0)
        XCTAssertEqual(count([session("other-day", date: "2026-12-03", time: "10:30")]), 0)
        XCTAssertEqual(count([session("all-day", time: "10:30", allDay: true)]), 0)
        // And together.
        XCTAssertEqual(count([session("at-start", time: "10:00"), session("inside", time: "11:59"),
                              session("at-end", time: "12:00"), session("before", time: "09:59")]), 2)
    }
}

final class RememberingRankerTests: XCTestCase {
    func testTheSamePromptIsAnsweredFromTheLastAnswer() async {
        let model = FakeRanker(picks: [pick("B")], promptTokens: 9)
        let remembering = RememberingRanker(model)
        let list = usualList()

        let first = await rank(list, with: remembering)
        let again = await rank(list, with: remembering)
        XCTAssertEqual(model.prompts.map(\.sentIDs), [list.prefix(12).map(\.id)])
        XCTAssertEqual(first.suggestions, arranged(list, "BACDEFGHIJKLMN", reasons: ["B": "Because B"]))
        XCTAssertEqual(again.suggestions, arranged(list, "BACDEFGHIJKLMN", reasons: ["B": "Because B"]))
        // Recorded as remembered, with no tokens: the model didn't run.
        assertRun(first.run, .ok, placed: 1, ignored: 0, promptTokens: 9, prompt: measures(list))
        assertRun(again.run, .ok, placed: 1, ignored: 0, remembered: true, prompt: measures(list))

        // Another list is another prompt: asked again.
        let other = usualList(["B", "A"])
        let otherRanked = await rank(other, with: remembering)
        XCTAssertEqual(model.prompts.map(\.sentIDs), [list.prefix(12).map(\.id), other.map(\.id)])
        XCTAssertEqual(otherRanked.suggestions, arranged(other, "BA", reasons: ["B": "Because B"]))
        assertRun(otherRanked.run, .ok, placed: 1, ignored: 0, promptTokens: 9, prompt: measures(other))
        // Only the last answer is kept: the first list is asked again too.
        let third = await rank(list, with: remembering)
        XCTAssertEqual(model.prompts.map(\.sentIDs).last, list.prefix(12).map(\.id))
        XCTAssertEqual(model.prompts.count, 3)
        XCTAssertEqual(third.suggestions, arranged(list, "BACDEFGHIJKLMN", reasons: ["B": "Because B"]))
        assertRun(third.run, .ok, placed: 1, ignored: 0, promptTokens: 9, prompt: model.prompt(2)?.metrics)
    }

    func testAnAnswerStillComingWhenTheCallerStopsIsKept() async {
        let release = Flag()
        // Like the real model, it stops when its own task is cancelled.
        let model = FakeRanker {
            while !release.isSet {
                try Task.checkCancellation()
                await Task.yield()
            }
            return ModelAnswer(picks: [pick("B")])
        }
        let remembering = RememberingRanker(model)
        let list = usualList()
        let first = Task { await ModelStep.rank(list, sessionsInBlock: 40, picks: [], ranker: remembering, sleep: untilCancelled) }
        await waitUntil(self, "the model has the prompt") { !model.prompts.isEmpty }
        first.cancel()
        let stopped = await result(of: first, self)
        XCTAssertEqual(stopped?.run.outcome, .cancelled)
        // The model goes on, and its answer serves the next ask.
        release.set()
        await waitUntil(self, "the answer is kept") { remembering.requestsInFlight == 0 }
        let again = await rank(list, with: remembering)
        XCTAssertEqual(model.prompts.count, 1)
        XCTAssertEqual(again.suggestions, arranged(list, "BACDEFGHIJKLMN", reasons: ["B": "Because B"]))
        assertRun(again.run, .ok, placed: 1, ignored: 0, remembered: true, prompt: measures(list))
    }

    func testAnAnswerAfterTheTimeoutIsNotKept() async {
        let release = Flag()
        let model = FakeRanker {
            while !release.isSet { await Task.yield() }
            return ModelAnswer(picks: [pick("B")])
        }
        let remembering = RememberingRanker(model)
        let list = usualList()
        // The timer fires once the model has the prompt.
        let late = await rank(list, with: remembering) { _ in
            while model.prompts.isEmpty { try Task.checkCancellation(); await Task.yield() }
        }
        assertRun(late.run, .timeout, placed: 0, ignored: 0, prompt: measures(list))
        // Its answer comes after all, and is not kept: the next ask goes to the model.
        release.set()
        await waitUntil(self, "the late answer is in") { remembering.requestsInFlight == 0 }
        guard let asked = model.prompt(0) else { return }
        XCTAssertNil(remembering.lastAnswer(for: asked))
        let again = await rank(list, with: remembering)
        XCTAssertEqual(model.prompts.count, 2)
        XCTAssertEqual(again.suggestions, arranged(list, "BACDEFGHIJKLMN", reasons: ["B": "Because B"]))
        assertRun(again.run, .ok, placed: 1, ignored: 0, prompt: measures(list))
    }

    func testAnUnusableAnswerIsNotKept() async {
        let model = answering([[pick("X1"), pick("X2")], [pick("B")]])
        let remembering = RememberingRanker(model)
        let list = usualList()
        let first = await rank(list, with: remembering)
        XCTAssertEqual(first.suggestions, list)
        assertRun(first.run, .unusable, placed: 0, ignored: 2, prompt: measures(list))
        XCTAssertNil(ModelStep.remembered(list, sessionsInBlock: 40, picks: [], ranker: remembering))
        // The next ask goes to the model again.
        let again = await rank(list, with: remembering)
        XCTAssertEqual(model.prompts.count, 2)
        XCTAssertEqual(again.suggestions, arranged(list, "BACDEFGHIJKLMN", reasons: ["B": "Because B"]))
        assertRun(again.run, .ok, placed: 1, ignored: 0, prompt: measures(list))
    }

    func testTwoListsAskingAtOnceShareOneRequest() async {
        let release = Flag()
        let model = FakeRanker {
            while !release.isSet { await Task.yield() }
            return ModelAnswer(picks: [pick("B")])
        }
        let remembering = RememberingRanker(model)
        let list = usualList()
        let first = Task { await ModelStep.rank(list, sessionsInBlock: 40, picks: [], ranker: remembering, sleep: untilCancelled) }
        await waitUntil(self, "the model has the prompt") { !model.prompts.isEmpty }
        let second = Task { await ModelStep.rank(list, sessionsInBlock: 40, picks: [], ranker: remembering, sleep: untilCancelled) }
        // Both are waiting before the model answers, so neither is served from memory.
        await waitUntil(self, "both lists are waiting") { remembering.callersWaiting == 2 }
        // Abandoning without a request of one's own touches no running request.
        guard let asked = model.prompt(0) else { release.set(); return }
        remembering.abandon(asked)
        release.set()
        let a = await result(of: first, self)
        let b = await result(of: second, self)
        await waitUntil(self, "the request is handled") { remembering.requestsInFlight == 0 }
        XCTAssertEqual(remembering.lastAnswer(for: asked)?.picks, [pick("B")])
        XCTAssertEqual(model.prompts.count, 1)
        XCTAssertEqual(a?.suggestions, arranged(list, "BACDEFGHIJKLMN", reasons: ["B": "Because B"]))
        XCTAssertEqual(b?.suggestions, arranged(list, "BACDEFGHIJKLMN", reasons: ["B": "Because B"]))
        if let a { assertRun(a.run, .ok, placed: 1, ignored: 0, prompt: measures(list)) }
        if let b { assertRun(b.run, .ok, placed: 1, ignored: 0, prompt: measures(list)) }
    }

    func testAnotherPromptDoesNotTakeOverARunningOne() async {
        let release = Flag()
        let model = FakeRanker {
            while !release.isSet { await Task.yield() }
            return ModelAnswer(picks: [pick("B")])
        }
        let remembering = RememberingRanker(model)
        let one = usualList()
        let two = usualList(["B", "A"])
        func start(_ list: [Suggestion]) -> Task<RankedSuggestions, Never> {
            Task { await ModelStep.rank(list, sessionsInBlock: 40, picks: [], ranker: remembering, sleep: untilCancelled) }
        }
        let a1 = start(one)
        await waitUntil(self, "the first prompt is asked") { model.prompts.count == 1 }
        let b = start(two)
        await waitUntil(self, "the second prompt is asked") { model.prompts.count == 2 }
        // A second ask for the first prompt joins its request, not a new one.
        let a2 = start(one)
        await waitUntil(self, "all three are waiting") { remembering.callersWaiting == 3 }
        release.set()
        let results = [await result(of: a1, self), await result(of: b, self), await result(of: a2, self)]
        XCTAssertEqual(model.prompts.map(\.sentIDs), [one.prefix(12).map(\.id), two.map(\.id)])
        XCTAssertEqual(results.map { $0?.suggestions }, [arranged(one, "BACDEFGHIJKLMN", reasons: ["B": "Because B"]), arranged(two, "BA", reasons: ["B": "Because B"]),
                                                       arranged(one, "BACDEFGHIJKLMN", reasons: ["B": "Because B"])])
        XCTAssertEqual(results.map { $0?.run.outcome }, [.ok, .ok, .ok])
    }

    func testTheRememberedListIsReadWithoutAsking() async {
        let model = FakeRanker(picks: [pick("B")])
        let remembering = RememberingRanker(model)
        let list = usualList()
        func remembered(_ list: [Suggestion]) -> RankedSuggestions? {
            ModelStep.remembered(list, sessionsInBlock: 40, picks: [], ranker: remembering)
        }
        XCTAssertNil(remembered(list))
        let asked = await rank(list, with: remembering)
        XCTAssertEqual(asked.suggestions, arranged(list, "BACDEFGHIJKLMN", reasons: ["B": "Because B"]))
        let kept = remembered(list)
        XCTAssertEqual(kept?.suggestions, arranged(list, "BACDEFGHIJKLMN", reasons: ["B": "Because B"]))
        if let kept { assertRun(kept.run, .ok, placed: 1, ignored: 0, remembered: true, prompt: measures(list)) }
        XCTAssertEqual(model.prompts.count, 1)
        // A different list has nothing remembered.
        XCTAssertNil(remembered(usualList(["B", "A"])))
    }

    func testAFailureIsNotRemembered() async {
        let model = FakeRanker(failing: ModelFailure.refused)
        let remembering = RememberingRanker(model)
        let list = usualList()
        let first = await rank(list, with: remembering)
        let again = await rank(list, with: remembering)
        XCTAssertEqual(first.suggestions, list)
        XCTAssertEqual(again.suggestions, list)
        assertRun(first.run, .refused, placed: 0, ignored: 0, prompt: measures(list))
        assertRun(again.run, .refused, placed: 0, ignored: 0, prompt: measures(list))
        XCTAssertEqual(model.prompts.map(\.sentIDs), Array(repeating: list.prefix(12).map(\.id), count: 2))
    }

    func testAbandoningForgetsOnlyTheAnswerOfTheRequestAbandoned() async {
        let model = FakeRanker(picks: [pick("B")])
        let remembering = RememberingRanker(model)
        let list = usualList()
        let mine = ModelRequestTicket()
        let first = await ModelStep.$ticket.withValue(mine) { await rank(list, with: remembering) }
        XCTAssertEqual(first.suggestions, arranged(list, "BACDEFGHIJKLMN", reasons: ["B": "Because B"]))
        guard let prompt = model.prompt(0) else { return }
        XCTAssertNotNil(mine.request)
        // A caller that joined another request for the same prompt, or none, forgets nothing.
        let other = ModelRequestTicket()
        other.request = UUID()
        ModelStep.$ticket.withValue(other) { remembering.abandon(prompt) }
        ModelStep.$ticket.withValue(ModelRequestTicket()) { remembering.abandon(prompt) }
        remembering.abandon(prompt)
        XCTAssertEqual(remembering.lastAnswer(for: prompt)?.picks, [pick("B")])
        // The caller whose request gave it forgets it.
        ModelStep.$ticket.withValue(mine) { remembering.abandon(prompt) }
        XCTAssertNil(remembering.lastAnswer(for: prompt))
        // So the next ask goes to the model.
        let again = await rank(list, with: remembering)
        XCTAssertEqual(model.prompts.count, 2)
        XCTAssertEqual(again.suggestions, arranged(list, "BACDEFGHIJKLMN", reasons: ["B": "Because B"]))
        assertRun(again.run, .ok, placed: 1, ignored: 0, prompt: model.prompt(1)?.metrics)
    }

    /// A model whose first request answers B when `old` is set and later ones answer C when
    /// `retry` is set; `finished` counts the requests that have returned.
    private func twoRequests(old: Flag, retry: Flag, finished: Counter) -> FakeRanker {
        let calls = Counter()
        return FakeRanker {
            let call = calls.next()
            let gate = call == 0 ? old : retry
            while !gate.isSet { await Task.yield() }
            defer { finished.next() }
            return ModelAnswer(picks: [pick(call == 0 ? "B" : "C")])
        }
    }

    func testARetryAfterTheTimeoutDoesNotJoinTheAbandonedRequest() async {
        for retryFirst in [true, false] {
            let old = Flag(), retry = Flag(), finished = Counter()
            // An early return mustn't leave the fake model spinning.
            defer { old.set(); retry.set() }
            let model = twoRequests(old: old, retry: retry, finished: finished)
            let remembering = RememberingRanker(model)
            let list = usualList()
            // The first request times out once the model has the prompt, and keeps running.
            let late = await rank(list, with: remembering) { _ in
                while model.prompts.isEmpty { try Task.checkCancellation(); await Task.yield() }
            }
            assertRun(late.run, .timeout, placed: 0, ignored: 0, prompt: measures(list))
            // A retry asks the model again rather than wait on the abandoned request.
            let retrying = Task { await ModelStep.rank(list, sessionsInBlock: 40, picks: [], ranker: remembering, sleep: untilCancelled) }
            await waitUntil(self, "the retry asks the model") { model.prompts.count == 2 }
            guard let abandoned = model.prompt(0), let retried = model.prompt(1) else { continue }
            if !retryFirst {
                // The abandoned request answers first, and isn't kept.
                old.set()
                await waitUntil(self, "the abandoned request returns") { finished.value == 1 }
                await waitUntil(self, "its answer is handled") { remembering.requestsInFlight == 1 }
                XCTAssertNil(remembering.lastAnswer(for: abandoned), "retryFirst: \(retryFirst)")
            }
            retry.set()
            let again = await result(of: retrying, self)
            XCTAssertEqual(again?.suggestions, arranged(list, "CABDEFGHIJKLMN", reasons: ["C": "Because C"]), "retryFirst: \(retryFirst)")
            old.set()
            await waitUntil(self, "both requests are handled") { remembering.requestsInFlight == 0 }
            // Only the retry's answer is kept, whichever finished last.
            XCTAssertEqual(remembering.lastAnswer(for: retried)?.picks, [pick("C")], "retryFirst: \(retryFirst)")
            XCTAssertEqual(model.prompts.count, 2)
        }
    }

    func testAnotherCallersTimeoutDoesNotAbandonTheRetry() async {
        let old = Flag(), retry = Flag(), finished = Counter()
        let model = twoRequests(old: old, retry: retry, finished: finished)
        let remembering = RememberingRanker(model)
        let list = usualList()
        func caller(timer: Flag) -> Task<RankedSuggestions, Never> {
            Task {
                await ModelStep.rank(list, sessionsInBlock: 40, picks: [], ranker: remembering) { _ in
                    while !timer.isSet { try Task.checkCancellation(); await Task.yield() }
                }
            }
        }
        // A starts the first request, and B joins it.
        let timerA = Flag(), timerB = Flag()
        let a = caller(timer: timerA)
        await waitUntil(self, "A asks the model") { model.prompts.count == 1 }
        let b = caller(timer: timerB)
        await waitUntil(self, "B joins") { remembering.callersWaiting == 2 }
        // A times out; a retry starts a second request.
        timerA.set()
        let aResult = await result(of: a, self)
        XCTAssertEqual(aResult?.run.outcome, .timeout)
        let retried = Task { await ModelStep.rank(list, sessionsInBlock: 40, picks: [], ranker: remembering, sleep: untilCancelled) }
        await waitUntil(self, "the retry asks the model") { model.prompts.count == 2 }
        // Then B, which joined the first request, times out too.
        timerB.set()
        let bResult = await result(of: b, self)
        XCTAssertEqual(bResult?.run.outcome, .timeout)
        // The retry's answer is still used and kept.
        retry.set()
        let again = await result(of: retried, self)
        XCTAssertEqual(again?.suggestions, arranged(list, "CABDEFGHIJKLMN", reasons: ["C": "Because C"]))
        old.set()
        await waitUntil(self, "both requests are handled") { remembering.requestsInFlight == 0 }
        guard let retriedPrompt = model.prompt(1) else { return }
        XCTAssertEqual(remembering.lastAnswer(for: retriedPrompt)?.picks, [pick("C")])
    }

    func testACallerThatJoinedAbandonsTheRequestItJoined() async {
        let release = Flag()
        let model = FakeRanker {
            while !release.isSet { await Task.yield() }
            return ModelAnswer(picks: [pick("B")])
        }
        let remembering = RememberingRanker(model)
        let list = usualList()
        // A starts the request and is closed; B joins it and times out.
        let a = Task { await ModelStep.rank(list, sessionsInBlock: 40, picks: [], ranker: remembering, sleep: untilCancelled) }
        await waitUntil(self, "A asks the model") { model.prompts.count == 1 }
        let timerB = Flag()
        let b = Task {
            await ModelStep.rank(list, sessionsInBlock: 40, picks: [], ranker: remembering) { _ in
                while !timerB.isSet { try Task.checkCancellation(); await Task.yield() }
            }
        }
        await waitUntil(self, "B joins") { remembering.callersWaiting == 2 }
        a.cancel()
        let aResult = await result(of: a, self)
        XCTAssertEqual(aResult?.run.outcome, .cancelled)
        timerB.set()
        let bResult = await result(of: b, self)
        XCTAssertEqual(bResult?.run.outcome, .timeout)
        // The request B joined is abandoned: its answer, when it comes, isn't kept.
        release.set()
        await waitUntil(self, "the request is handled") { remembering.requestsInFlight == 0 }
        guard let joined = model.prompt(0) else { return }
        XCTAssertNil(remembering.lastAnswer(for: joined))
        XCTAssertEqual(model.prompts.count, 1)
    }

    func testPromptsThatDifferOnlyInUnicodeSpellingAreNotTheSame() async {
        let composed = "CAF\u{00C9}1", decomposed = "CAFE\u{0301}1"
        let model = answering([[pick(composed)], [pick(decomposed)]])
        let remembering = RememberingRanker(model)
        let first = usualList(["A", composed])
        var second = first
        second[1].session.abbreviation = decomposed
        let ranked = await rank(first, with: remembering)
        XCTAssertEqual(ranked.suggestions, arranged(first, [composed, "A"], reasons: [composed: "Because \(composed)"]))
        // Equal to Swift, but another prompt byte for byte: the model is asked again.
        let again = await rank(second, with: remembering)
        XCTAssertEqual(model.prompts.count, 2)
        guard let firstSent = model.prompt(0), let secondSent = model.prompt(1) else { return }
        let composedBytes = Array("\nCAF\u{00C9}1 | ".utf8), decomposedBytes = Array("\nCAFE\u{0301}1 | ".utf8)
        XCTAssertNotNil(Array(firstSent.text.utf8).firstRange(of: composedBytes))
        XCTAssertNil(Array(firstSent.text.utf8).firstRange(of: decomposedBytes))
        XCTAssertNotNil(Array(secondSent.text.utf8).firstRange(of: decomposedBytes))
        XCTAssertNil(Array(secondSent.text.utf8).firstRange(of: composedBytes))
        XCTAssertEqual(firstSent.text, secondSent.text)            // the same to Swift
        XCTAssertNotEqual(Array(firstSent.text.utf8), Array(secondSent.text.utf8))
        XCTAssertEqual(again.suggestions, arranged(second, [decomposed, "A"], reasons: [decomposed: "Because \(decomposed)"]))
        assertRun(again.run, .ok, placed: 1, ignored: 0, prompt: measures(second))
    }

    func testAStoppedCallerStartsNoNewRequest() async throws {
        let model = FakeRanker(picks: [pick("B")])
        let remembering = RememberingRanker(model)
        let prompt = ModelPrompt.build(question: "", ranked: usualList().map(\.session), sessionsInBlock: 40, picks: [])
        let started = Flag()
        let stopped = Task { () -> Bool in
            started.set()
            while !Task.isCancelled { await Task.yield() }
            do { _ = try await remembering.rank(prompt); return false } catch { return error is CancellationError }
        }
        await waitUntil(self, "the caller has started") { started.isSet }
        stopped.cancel()
        let threwCancellation = await result(of: stopped, self)
        XCTAssertEqual(threwCancellation, true)
        XCTAssertTrue(model.prompts.isEmpty)
        // A caller that isn't stopped does start one.
        let answer = try await remembering.rank(prompt)
        XCTAssertEqual(answer.picks, [pick("B")])
        XCTAssertEqual(model.prompts.map(\.text), [prompt.text])
    }

    func testAClosedTicketStartsNoRequestButAStartedOneRuns() async throws {
        let model = FakeRanker(picks: [pick("B")])
        let remembering = RememberingRanker(model)
        let prompt = ModelPrompt.build(question: "", ranked: usualList().map(\.session), sessionsInBlock: 40, picks: [])
        // Closed first (the caller was stopped), the ticket starts nothing.
        let closed = ModelRequestTicket()
        closed.close()
        let refused: Bool = await ModelStep.$ticket.withValue(closed) {
            do { _ = try await remembering.rank(prompt); return false } catch { return error is CancellationError }
        }
        XCTAssertTrue(refused)
        XCTAssertTrue(model.prompts.isEmpty)
        // Started first, the request runs, and closing the ticket afterwards changes nothing.
        let open = ModelRequestTicket()
        let answer = try await ModelStep.$ticket.withValue(open) { try await remembering.rank(prompt) }
        open.close()
        XCTAssertEqual(answer.picks, [pick("B")])
        XCTAssertEqual(model.prompts.map(\.text), [prompt.text])
        XCTAssertEqual(remembering.lastAnswer(for: prompt)?.picks, [pick("B")])
    }

    func testStoppingARankingClosesItsTicket() async {
        let model = silentModel()
        let ticket = ModelRequestTicket()
        let list = usualList()
        let task = Task {
            await ModelStep.$ticket.withValue(ticket) {
                await ModelStep.rank(list, sessionsInBlock: 40, picks: [], ranker: model, sleep: untilCancelled)
            }
        }
        await waitUntil(self, "the model has the prompt") { !model.prompts.isEmpty }
        XCTAssertFalse(ticket.isClosed)
        task.cancel()
        let ranked = await result(of: task, self)
        XCTAssertEqual(ranked?.run.outcome, .cancelled)
        XCTAssertTrue(ticket.isClosed)
    }

    func testATimeoutClosesTheTicket() async {
        let model = silentModel()
        let ticket = ModelRequestTicket()
        let list = usualList()
        let late = await ModelStep.$ticket.withValue(ticket) {
            await rank(list, with: model) { _ in
                while model.prompts.isEmpty { try Task.checkCancellation(); await Task.yield() }
            }
        }
        assertRun(late.run, .timeout, placed: 0, ignored: 0, prompt: measures(list))
        XCTAssertTrue(ticket.isClosed)
        // And a closed ticket claims nothing more.
        XCTAssertFalse(ticket.claim(UUID()))
    }

    func testAClaimBeforeTheCloseStandsAndOneAfterItDoesNot() {
        let ticket = ModelRequestTicket()
        let first = UUID()
        XCTAssertTrue(ticket.claim(first))
        ticket.close()
        XCTAssertEqual(ticket.request, first)
        XCTAssertFalse(ticket.claim(UUID()))
        XCTAssertEqual(ticket.request, first)
    }

    func testAWrappedRankerDoesNotTakeTheOuterRequestsTicket() async {
        let release = Flag()
        let model = FakeRanker {
            while !release.isSet { await Task.yield() }
            return ModelAnswer(picks: [pick("B")])
        }
        let outer = RememberingRanker(RememberingRanker(model))
        let list = usualList()
        let ticket = ModelRequestTicket()
        let late = await ModelStep.$ticket.withValue(ticket) {
            await rank(list, with: outer) { _ in
                while model.prompts.isEmpty { try Task.checkCancellation(); await Task.yield() }
            }
        }
        assertRun(late.run, .timeout, placed: 0, ignored: 0, prompt: measures(list))
        let claimed = ticket.request
        release.set()
        await waitUntil(self, "the outer request is handled") { outer.requestsInFlight == 0 }
        // The outer request was the one abandoned: its late answer isn't kept.
        guard let asked = model.prompt(0) else { return }
        XCTAssertNotNil(claimed)
        XCTAssertNil(outer.lastAnswer(for: asked))
    }

    func testAnAbandonedAnswerIsNotKeptByAWrappedRankerEither() async {
        let release = Flag()
        let model = FakeRanker {
            while !release.isSet { await Task.yield() }
            return ModelAnswer(picks: [pick("B")])
        }
        let inner = RememberingRanker(model)
        let outer = RememberingRanker(inner)
        let list = usualList()
        let late = await rank(list, with: outer) { _ in
            while model.prompts.isEmpty { try Task.checkCancellation(); await Task.yield() }
        }
        assertRun(late.run, .timeout, placed: 0, ignored: 0, prompt: measures(list))
        release.set()
        await waitUntil(self, "both layers are done") { outer.requestsInFlight == 0 && inner.requestsInFlight == 0 }
        guard let asked = model.prompt(0) else { return }
        XCTAssertNil(outer.lastAnswer(for: asked))
        XCTAssertNil(inner.lastAnswer(for: asked))
        // So a retry reaches the model.
        let again = await rank(list, with: outer)
        XCTAssertEqual(model.prompts.count, 2)
        XCTAssertEqual(again.suggestions, arranged(list, "BACDEFGHIJKLMN", reasons: ["B": "Because B"]))
        assertRun(again.run, .ok, placed: 1, ignored: 0, prompt: measures(list))
    }

    func testAbandoningAKeptAnswerForgetsItInAWrappedRankerToo() async {
        let model = FakeRanker(picks: [pick("B")])
        let inner = RememberingRanker(model)
        let outer = RememberingRanker(inner)
        let list = usualList()
        let mine = ModelRequestTicket()
        let first = await ModelStep.$ticket.withValue(mine) { await rank(list, with: outer) }
        assertRun(first.run, .ok, placed: 1, ignored: 0, prompt: measures(list))
        await waitUntil(self, "both layers are done") { outer.requestsInFlight == 0 && inner.requestsInFlight == 0 }
        guard let asked = model.prompt(0) else { return }
        // Precondition: both layers kept it.
        XCTAssertEqual(outer.lastAnswer(for: asked)?.picks, [pick("B")])
        XCTAssertEqual(inner.lastAnswer(for: asked)?.picks, [pick("B")])
        ModelStep.$ticket.withValue(mine) { outer.abandon(asked) }
        XCTAssertNil(outer.lastAnswer(for: asked))
        XCTAssertNil(inner.lastAnswer(for: asked))
    }

    func testItsAvailabilityIsTheModels() {
        XCTAssertEqual(RememberingRanker(FakeRanker(.unavailable("modelNotReady")) { ModelAnswer(picks: []) }).availability,
                       .unavailable("modelNotReady"))
        XCTAssertEqual(RememberingRanker(FakeRanker(picks: [])).availability, .available)
    }
}

final class RaceTests: XCTestCase {
    func testNothingStartsOnceTheRaceIsDecided() async {
        let race = Race<Int>()
        let made = Flag()
        let value = await withCheckedContinuation { continuation in
            race.start(continuation)
            race.finish(1)
            race.launch { made.set(); return Task {} }
        }
        XCTAssertEqual(value, 1)
        XCTAssertFalse(made.isSet)
        // Before the decision, it starts.
        let open = Race<Int>()
        let started = Flag()
        let second = await withCheckedContinuation { continuation in
            open.start(continuation)
            open.launch { started.set(); return Task { open.finish(2) } }
        }
        XCTAssertEqual(second, 2)
        XCTAssertTrue(started.isSet)
    }
}
