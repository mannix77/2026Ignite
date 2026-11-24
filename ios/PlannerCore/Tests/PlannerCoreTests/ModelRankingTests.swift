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

/// The model's turn on `list`, with the timer that never fires unless one is given.
private func rank(_ list: [Suggestion], with ranker: (any SessionRanker)?, sessionsInBlock: Int = 40,
                  budget: PromptBudget = PromptBudget(),
                  sleep: @escaping @Sendable (Duration) async throws -> Void = untilCancelled) async -> RankedSuggestions {
    await ModelStep.rank(list, sessionsInBlock: sessionsInBlock, picks: [], ranker: ranker, budget: budget, sleep: sleep)
}

private func codes(_ list: [Suggestion]) -> [String] { list.map(\.session.code) }

final class ModelRankingTests: XCTestCase {
    func testTheModelsOrderGoesFirstWithItsReasons() async {
        let list = usualList()
        let model = FakeRanker(picks: [pick("L"), pick("B"), pick("A")])
        let ranked = await rank(list, with: model)

        // It was sent the first 12 of the 14.
        XCTAssertEqual(model.prompts.map(\.sentIDs), [list.prefix(12).map(\.id)])
        XCTAssertEqual(codes(ranked.suggestions), ["L", "B", "A", "C", "D", "E", "F", "G", "H", "I", "J", "K", "M", "N"])
        XCTAssertEqual(ranked.suggestions.map(\.modelReason),
                       ["Because L", "Because B", "Because A"] + Array(repeating: nil, count: 11))
        XCTAssertEqual(ranked.suggestions.map(Wording.reasons),
                       ["Because L", "Because B", "Because A"] + "CDEFGHIJKMN".map { "Shares Topic \($0)" })
        // Nothing else about a session changes.
        var unranked = ranked.suggestions.first { $0.session.code == "L" }!
        unranked.modelReason = nil
        XCTAssertEqual(unranked, list[11])
        XCTAssertEqual(ranked.run.outcome, .ok)
        XCTAssertEqual(ranked.run.placed, 3)
        XCTAssertEqual(ranked.run.ignored, 0)
        XCTAssertEqual(Wording.modelHeader(ranked.run), "Top 3 ranked by Apple Intelligence")
    }

    func testOnlyWhatWasSentCanMove() async {
        let list = usualList()
        let ranked = await rank(list, with: FakeRanker(picks: [pick("XYZ999"), pick("B"), pick("C"), pick("M")]))

        XCTAssertEqual(codes(ranked.suggestions), ["B", "C", "A", "D", "E", "F", "G", "H", "I", "J", "K", "L", "M", "N"])
        XCTAssertEqual(ranked.suggestions.compactMap(\.modelReason), ["Because B", "Because C"])
        XCTAssertEqual(ranked.run.outcome, .ok)
        XCTAssertEqual(ranked.run.placed, 2)
        XCTAssertEqual(ranked.run.ignored, 2)
    }

    func testASessionNamedTwiceMovesOnce() async {
        let ranked = await rank(usualList(), with: FakeRanker(picks: [pick("B", "First"), pick("A"), pick("B", "Second")]))

        XCTAssertEqual(codes(ranked.suggestions), ["B", "A", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L", "M", "N"])
        XCTAssertEqual(ranked.suggestions.compactMap(\.modelReason), ["First", "Because A"])
        XCTAssertEqual(ranked.run.placed, 2)
        XCTAssertEqual(ranked.run.ignored, 1)
    }

    func testACodeTwoSentSessionsShareMovesNeither() async {
        let list = usualList(["A", "AIM301", "AIM301", "B"])
        let model = FakeRanker(picks: [pick("AIM301"), pick("B")])
        let ranked = await rank(list, with: model)

        // Both were sent, so the model saw the code twice.
        XCTAssertEqual(model.prompts.map(\.sentIDs), [list.map(\.id)])
        XCTAssertEqual(ranked.suggestions.map(\.id), [list[3].id, list[0].id, list[1].id, list[2].id])
        XCTAssertEqual(ranked.run.placed, 1)
        XCTAssertEqual(ranked.run.ignored, 1)
    }

    func testACodeThreeSentSessionsShareMovesNoneOfThem() async {
        let list = usualList(["S", "S", "S", "B"])
        let model = FakeRanker(picks: [pick("S"), pick("B")])
        let ranked = await rank(list, with: model)
        XCTAssertEqual(model.prompts.map(\.sentIDs), [list.map(\.id)])
        XCTAssertEqual(ranked.suggestions.map(\.id), [list[3].id, list[0].id, list[1].id, list[2].id])
        XCTAssertEqual(ranked.run.placed, 1)
    }

    func testTheCodeIsMatchedAsTheModelWasShownIt() async {
        // The prompt shows a code on one line with "|" as "/"; the model writes it back so.
        let list = usualList(["A", " AIM|301\n", "B"])
        let ranked = await rank(list, with: FakeRanker(picks: [pick("AIM/301"), pick(" B ")]))

        XCTAssertEqual(ranked.suggestions.map(\.id), [list[1].id, list[2].id, list[0].id])
        XCTAssertEqual(ranked.run.placed, 2)
        XCTAssertEqual(ranked.run.ignored, 0)
    }

    func testAnAnswerThatIsMostlyWrongIsNotUsed() async {
        let list = usualList()
        let wrong = await rank(list, with: FakeRanker(picks: [pick("C"), pick("X1"), pick("B"), pick("X2"), pick("X3")]))
        XCTAssertEqual(wrong.suggestions, list)
        XCTAssertEqual(wrong.run.outcome, .unusable)
        XCTAssertEqual(wrong.run.placed, 0)
        XCTAssertEqual(wrong.run.ignored, 3)
        XCTAssertNil(Wording.modelHeader(wrong.run))

        // Half wrong is still used.
        let half = await rank(list, with: FakeRanker(picks: [pick("C"), pick("X1"), pick("B"), pick("X2")]))
        XCTAssertEqual(codes(half.suggestions).prefix(3), ["C", "B", "A"])
        XCTAssertEqual(half.run.outcome, .ok)
        XCTAssertEqual(half.run.placed, 2)
        XCTAssertEqual(half.run.ignored, 2)
    }

    func testRepeatsAreNotCountedAsWrong() async {
        // One session named three times: repeats are ignored, but they aren't wrong.
        let ranked = await rank(usualList(), with: FakeRanker(picks: [pick("C"), pick("C"), pick("C")]))
        XCTAssertEqual(codes(ranked.suggestions).prefix(3), ["C", "A", "B"])
        XCTAssertEqual(ranked.run.outcome, .ok)
        XCTAssertEqual(ranked.run.placed, 1)
        XCTAssertEqual(ranked.run.ignored, 2)
        // Two codes it wasn't sent against the one it was are still mostly wrong.
        let wrong = await rank(usualList(), with: FakeRanker(picks: [pick("C"), pick("X1"), pick("X2"), pick("C")]))
        XCTAssertEqual(wrong.run.outcome, .unusable)
        XCTAssertEqual(wrong.suggestions, usualList())
    }

    func testAnEmptyAnswerIsNotUsed() async {
        let list = usualList()
        let ranked = await rank(list, with: FakeRanker(picks: []))
        XCTAssertEqual(ranked.suggestions, list)
        XCTAssertEqual(ranked.run.outcome, .unusable)
    }

    func testALongReasonIsCutAtAWordAndAnEmptyOneShowsWhatItShares() async {
        let words = Array(repeating: "abcd", count: 30).joined(separator: " ")   // 149 characters
        let long = words + "\nx"                                               // 151 once on one line
        let exact = Array(repeating: "abcd", count: 29).joined(separator: " ") + " abcde" // 150
        XCTAssertEqual(words.count, 149)
        XCTAssertEqual(exact.count, 150)
        let ranked = await rank(usualList(), with: FakeRanker(picks: [pick("A", long), pick("B", exact), pick("C", " \n ")]))

        XCTAssertEqual(codes(ranked.suggestions).prefix(3), ["A", "B", "C"])
        XCTAssertEqual(ranked.suggestions[0].modelReason, words + "…")
        XCTAssertEqual(ranked.suggestions[0].modelReason?.count, 150)
        XCTAssertEqual(ranked.suggestions[1].modelReason, exact)
        XCTAssertNil(ranked.suggestions[2].modelReason)
        // The reason is shown as written, on one line: a "|" stays.
        let piped = await rank(usualList(), with: FakeRanker(picks: [pick("A", "Fast |\n cheap")]))
        XCTAssertEqual(piped.suggestions[0].modelReason, "Fast | cheap")
        XCTAssertEqual(Wording.reasons(ranked.suggestions[2]), "Shares Topic C")
        XCTAssertEqual(ranked.run.placed, 3)
    }

    func testWithoutAppleIntelligenceTheModelIsNotAsked() async {
        let list = usualList()
        let model = FakeRanker(.unavailable("modelNotReady")) { ModelAnswer(picks: [pick("B")]) }
        let ranked = await rank(list, with: model)

        XCTAssertTrue(model.prompts.isEmpty)
        XCTAssertEqual(ranked.suggestions, list)
        XCTAssertEqual(ranked.run.outcome, .unavailable)
        XCTAssertEqual(ranked.run.unavailableReason, "modelNotReady")
        XCTAssertNil(ranked.run.prompt)

        // An iOS without the framework has no model at all.
        let none = await rank(list, with: nil)
        XCTAssertEqual(none.suggestions, list)
        XCTAssertEqual(none.run.outcome, .unavailable)
        XCTAssertEqual(none.run.unavailableReason, "unsupported")
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
            XCTAssertEqual(model.prompts.count, 1, "\(outcome)")
            XCTAssertEqual(ranked.suggestions, list, "\(outcome)")
            XCTAssertEqual(ranked.run.outcome, outcome)
            XCTAssertEqual(ranked.run.placed, 0)
            XCTAssertEqual(ranked.run.prompt, model.prompts.first?.metrics, "\(outcome)")
        }
    }

    func testTheModelThatTakesTooLong() async {
        let list = usualList()
        let asked = DurationLog()
        // The timer fires at once; the model never answers.
        let late = await rank(list, with: silentModel()) { asked.append($0) }
        XCTAssertEqual(late.suggestions, list)
        XCTAssertEqual(late.run.outcome, .timeout)
        XCTAssertEqual(asked.all, [.seconds(20)])

        // An answer that comes before the timer is used, though the timer fires after it.
        let answered = Flag()
        let quick = FakeRanker { answered.set(); return ModelAnswer(picks: [pick("B")]) }
        let prompt = await rank(list, with: quick) { _ in
            while !answered.isSet { await Task.yield() }
            await Task.yield()
        }
        XCTAssertEqual(prompt.run.outcome, .ok)
        XCTAssertEqual(codes(prompt.suggestions).first, "B")
    }

    func testTheTimeoutHoldsForAModelThatIgnoresBeingStopped() async {
        let list = usualList()
        let release = Flag()
        let finished = Flag()
        // It keeps working after it is cancelled, until the test lets it go.
        let stubborn = FakeRanker {
            while !release.isSet { await Task.yield() }
            finished.set()
            return ModelAnswer(picks: [pick("B")])
        }
        let done = expectation(description: "ranked")
        let result = Task { () -> RankedSuggestions in
            let ranked = await rank(list, with: stubborn) { _ in }
            done.fulfill()
            return ranked
        }
        await fulfillment(of: [done], timeout: 10)
        // It returned while the model was still working, which is then let go.
        XCTAssertFalse(finished.isSet)
        release.set()
        let ranked = await result.value
        XCTAssertEqual(ranked.run.outcome, .timeout)
        XCTAssertEqual(ranked.suggestions, list)
    }

    func testClosingTheListStopsTheWaitAtOnce() async {
        let list = usualList()
        let model = silentModel()
        let task = Task { await rank(list, with: model) }
        // Cancelled once the model has the prompt; neither it nor the timer ever finishes.
        await waitUntil(self, "the model has the prompt") { !model.prompts.isEmpty }
        task.cancel()
        let ranked = await result(of: task, self)
        XCTAssertEqual(ranked?.run.outcome, .cancelled)
        XCTAssertEqual(ranked?.suggestions, list)
        XCTAssertEqual(model.prompts.count, 1)
    }

    func testACallerAlreadyStoppedAsksNothing() async {
        let list = usualList()
        let model = FakeRanker(picks: [pick("B")])
        let started = Flag()
        let task = Task { () -> RankedSuggestions in
            started.set()
            while !Task.isCancelled { await Task.yield() }
            return await rank(list, with: model)
        }
        await waitUntil(self, "the caller has started") { started.isSet }
        task.cancel()
        let ranked = await result(of: task, self)
        XCTAssertEqual(ranked?.run.outcome, .cancelled)
        XCTAssertEqual(ranked?.suggestions, list)
        XCTAssertTrue(model.prompts.isEmpty)
        // The same model is asked by a caller that isn't stopped.
        _ = await rank(list, with: model)
        XCTAssertEqual(model.prompts.count, 1)
    }

    func testNothingToRankAsksNothing() async {
        let model = FakeRanker(picks: [pick("A")])
        let ranked = await rank([], with: model)
        XCTAssertTrue(model.prompts.isEmpty)
        XCTAssertEqual(ranked.suggestions, [])
        XCTAssertEqual(ranked.run.outcome, .nothingToRank)

        // The same model is asked when there is something.
        _ = await rank(usualList(["A"]), with: model)
        XCTAssertEqual(model.prompts.count, 1)
    }

    func testAPromptWhoseFixedTextDoesNotFitIsNotSent() async {
        var tiny = PromptBudget()
        tiny.window = 1100   // 100 tokens for the prompt: less than the instructions
        let model = FakeRanker(picks: [pick("A")])
        let list = usualList()
        let ranked = await rank(list, with: model, budget: tiny)
        XCTAssertTrue(model.prompts.isEmpty)
        XCTAssertEqual(ranked.suggestions, list)
        XCTAssertEqual(ranked.run.outcome, .promptTooLong)
        XCTAssertEqual(ranked.run.prompt?.sessionsSent, 0)
    }

    func testWhatIsRecorded() async {
        let model = FakeRanker(picks: [pick("B", "Secret reason"), pick("X1")], promptTokens: 1234, answerTokens: 56)
        let ranked = await rank(usualList(), with: model, sessionsInBlock: 77)
        let run = ranked.run

        XCTAssertEqual(run.outcome, .ok)
        XCTAssertNil(run.unavailableReason)
        XCTAssertEqual(run.prompt, model.prompts.first?.metrics)
        XCTAssertEqual(run.prompt?.sessionsInBlock, 77)
        XCTAssertEqual(run.prompt?.sessionsSent, 12)
        XCTAssertEqual(run.modelPromptTokens, 1234)
        XCTAssertEqual(run.modelAnswerTokens, 56)
        XCTAssertEqual(run.placed, 1)
        XCTAssertEqual(run.ignored, 1)
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
}

final class SessionsInBlockTests: XCTestCase {
    func testSessionsStartingInTheStretchAreCounted() {
        // The stretch runs 10:00 to 12:00 on 2 Dec.
        let gap = Gap(date: "2026-12-02", start: 600, end: 720, before: .open, after: .open, lineFrom: nil, lineUpAfter: false)
        let sessions = [
            session("at-start", time: "10:00"), session("inside", time: "11:59"),
            session("before", time: "09:59"), session("at-end", time: "12:00"),
            session("other-day", date: "2026-12-03", time: "10:30"), session("all-day", time: "10:30", allDay: true),
        ]
        let plan = PlanSnapshot(sessions: sessions, schedule: Schedule(reserved: [], favorites: []),
                                fetchedAt: Date(timeIntervalSince1970: 0))
        XCTAssertEqual(plan.sessionsStarting(in: gap), 2)
        // With only the ones outside, none.
        let outside = PlanSnapshot(sessions: Array(sessions.dropFirst(2)), schedule: Schedule(reserved: [], favorites: []),
                                   fetchedAt: Date(timeIntervalSince1970: 0))
        XCTAssertEqual(outside.sessionsStarting(in: gap), 0)
    }
}

final class RememberingRankerTests: XCTestCase {
    func testTheSamePromptIsAnsweredFromTheLastAnswer() async {
        let model = FakeRanker(picks: [pick("B")], promptTokens: 9)
        let remembering = RememberingRanker(model)
        let list = usualList()

        let first = await rank(list, with: remembering)
        let again = await rank(list, with: remembering)
        XCTAssertEqual(model.prompts.count, 1)
        XCTAssertEqual(codes(again.suggestions), codes(first.suggestions))
        XCTAssertEqual(codes(again.suggestions).first, "B")
        // Recorded as remembered, with no tokens: the model didn't run.
        XCTAssertFalse(first.run.remembered)
        XCTAssertEqual(first.run.modelPromptTokens, 9)
        XCTAssertTrue(again.run.remembered)
        XCTAssertNil(again.run.modelPromptTokens)
        var same = again.run
        same.remembered = false
        same.modelPromptTokens = 9
        XCTAssertEqual(same, first.run)

        // Another list is another prompt: asked again.
        _ = await rank(usualList(["B", "A"]), with: remembering)
        XCTAssertEqual(model.prompts.count, 2)
        // Only the last answer is kept: the first list is asked again too.
        _ = await rank(list, with: remembering)
        XCTAssertEqual(model.prompts.count, 3)
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
        let first = Task { await rank(list, with: remembering) }
        await waitUntil(self, "the model has the prompt") { !model.prompts.isEmpty }
        first.cancel()
        let stopped = await result(of: first, self)
        XCTAssertEqual(stopped?.run.outcome, .cancelled)
        // The model goes on, and its answer serves the next ask.
        release.set()
        let again = await rank(list, with: remembering)
        XCTAssertEqual(model.prompts.count, 1)
        XCTAssertEqual(again.run.outcome, .ok)
        XCTAssertEqual(codes(again.suggestions).first, "B")
    }

    func testTwoListsAskingAtOnceShareOneRequest() async {
        let release = Flag()
        let model = FakeRanker {
            while !release.isSet { await Task.yield() }
            return ModelAnswer(picks: [pick("B")])
        }
        let remembering = RememberingRanker(model)
        let list = usualList()
        let first = Task { await rank(list, with: remembering) }
        await waitUntil(self, "the model has the prompt") { !model.prompts.isEmpty }
        let second = Task { await rank(list, with: remembering) }
        // Both are waiting before the model answers, so neither is served from memory.
        await waitUntil(self, "both lists are waiting") { remembering.callersWaiting == 2 }
        release.set()
        let a = await result(of: first, self)
        let b = await result(of: second, self)
        XCTAssertEqual(model.prompts.count, 1)
        XCTAssertEqual(a?.run.outcome, .ok)
        XCTAssertEqual(b?.run.outcome, .ok)
        XCTAssertEqual(codes(b?.suggestions ?? []).first, "B")
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
        let kept = remembered(list)
        XCTAssertEqual(kept?.suggestions, asked.suggestions)
        XCTAssertEqual(codes(kept?.suggestions ?? []).first, "B")
        XCTAssertEqual(kept?.run.remembered, true)
        XCTAssertEqual(model.prompts.count, 1)
        // A different list has nothing remembered.
        XCTAssertNil(remembered(usualList(["B", "A"])))

        // An answer that wasn't usable isn't shown from memory either.
        let wrong = RememberingRanker(FakeRanker(picks: [pick("X1"), pick("X2")]))
        let unusable = await rank(list, with: wrong)
        XCTAssertEqual(unusable.run.outcome, .unusable)
        XCTAssertNil(ModelStep.remembered(list, sessionsInBlock: 40, picks: [], ranker: wrong))
    }

    func testAFailureIsNotRemembered() async {
        let model = FakeRanker(failing: ModelFailure.refused)
        let remembering = RememberingRanker(model)
        let first = await rank(usualList(), with: remembering)
        let again = await rank(usualList(), with: remembering)
        XCTAssertEqual(first.run.outcome, .refused)
        XCTAssertEqual(again.run.outcome, .refused)
        XCTAssertEqual(model.prompts.count, 2)
    }

    func testItsAvailabilityIsTheModels() {
        XCTAssertEqual(RememberingRanker(FakeRanker(.unavailable("modelNotReady")) { ModelAnswer(picks: []) }).availability,
                       .unavailable("modelNotReady"))
        XCTAssertEqual(RememberingRanker(FakeRanker(picks: [])).availability, .available)
    }
}
