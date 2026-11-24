import Foundation

/// Whether the phone can run the on-device model now.
public enum ModelAvailability: Equatable, Sendable {
    case available
    /// Why not, for the logs: "deviceNotEligible", "appleIntelligenceNotEnabled", "modelNotReady".
    case unavailable(String)
}

/// One entry of the model's answer, as it wrote it.
public struct ModelPick: Equatable, Sendable {
    public var code: String
    public var reason: String

    public init(code: String, reason: String) {
        self.code = code
        self.reason = reason
    }
}

/// The model's answer: its order, best first, and its own token counts when it reports them.
public struct ModelAnswer: Equatable, Sendable {
    public var picks: [ModelPick]
    public var promptTokens: Int?
    public var answerTokens: Int?
    /// From `RememberingRanker`'s memory: the model didn't run.
    public var remembered = false

    public init(picks: [ModelPick], promptTokens: Int? = nil, answerTokens: Int? = nil) {
        self.picks = picks
        self.promptTokens = promptTokens
        self.answerTokens = answerTokens
    }
}

/// How the model said no. Any other error it throws counts as `ModelOutcome.error`.
public enum ModelFailure: Error, Equatable, Sendable {
    case refused, contextExceeded, guardrail
    /// The framework's own time limit.
    case timedOut
}

/// The on-device model, behind a protocol so tests use a fake (rule 12).
public protocol SessionRanker: Sendable {
    var availability: ModelAvailability { get }
    func rank(_ prompt: ModelPrompt) async throws -> ModelAnswer
}

/// A model that answers an identical prompt from its last answer instead of asking again: an
/// open free stretch reloads every minute, and its list shouldn't be re-ranked each time. Only
/// the last answer is kept, and a failure is never kept. A request runs on its own task, so
/// when the list asking for it closes or reloads, the model still finishes and its answer is
/// kept; asking the same prompt meanwhile waits for that same request.
public final class RememberingRanker: SessionRanker, @unchecked Sendable {
    private let model: any SessionRanker
    private let lock = NSLock()
    private var last: (prompt: String, answer: ModelAnswer)?
    private var running: (prompt: String, task: Task<ModelAnswer, Error>)?
    private var waiting = 0

    /// Callers waiting on a request now: for tests that need two to be waiting at once.
    var callersWaiting: Int { lock.withLock { waiting } }

    public init(_ model: any SessionRanker) { self.model = model }

    public var availability: ModelAvailability { model.availability }

    /// The last answer, if it was for this prompt: marked remembered, with no tokens, since
    /// the model doesn't run for it.
    public func lastAnswer(for prompt: ModelPrompt) -> ModelAnswer? {
        guard let kept = lock.withLock({ last }), kept.prompt == prompt.text else { return nil }
        var answer = kept.answer
        answer.remembered = true
        answer.promptTokens = nil
        answer.answerTokens = nil
        return answer
    }

    public func rank(_ prompt: ModelPrompt) async throws -> ModelAnswer {
        if let answer = lastAnswer(for: prompt) { return answer }
        let task: Task<ModelAnswer, Error> = lock.withLock {
            if let running, running.prompt == prompt.text { return running.task }
            let model = model
            let task = Task { () throws -> ModelAnswer in
                do {
                    let answer = try await model.rank(prompt)
                    self.lock.withLock {
                        self.last = (prompt.text, answer)
                        if self.running?.prompt == prompt.text { self.running = nil }
                    }
                    return answer
                } catch {
                    self.lock.withLock { if self.running?.prompt == prompt.text { self.running = nil } }
                    throw error
                }
            }
            running = (prompt.text, task)
            return task
        }
        lock.withLock { waiting += 1 }
        defer { lock.withLock { waiting -= 1 } }
        return try await task.value
    }
}

/// What became of one request to the model, for the logs.
public enum ModelOutcome: String, Equatable, Sendable {
    /// Its order was used.
    case ok
    /// The phone can't run it; it wasn't asked.
    case unavailable
    /// No session fit the stretch; it wasn't asked.
    case nothingToRank
    /// The fixed text alone didn't fit the window; it wasn't asked.
    case promptTooLong
    case refused, contextExceeded, guardrail, timeout, error
    /// It answered, but named too few of the sessions it was sent (`ModelStep.isUsable`).
    case unusable
    /// The list was closed or reloaded first.
    case cancelled
}

/// One request's record: counts and outcomes only, never the prompt or the reasons.
public struct ModelRun: Equatable, Sendable {
    public var outcome: ModelOutcome
    /// Why the model was unavailable, when it was.
    public var unavailableReason: String?
    /// The prompt's measures, when one was built.
    public var prompt: PromptMetrics?
    /// The model's own token counts, when it reported them.
    public var modelPromptTokens: Int?
    public var modelAnswerTokens: Int?
    /// Sessions the model moved to the top.
    public var placed: Int
    /// Entries of its answer that named nothing it was sent, or a session again.
    public var ignored: Int
    /// Answered from `RememberingRanker`'s memory, without the model.
    public var remembered = false
}

/// The list for a free stretch after the model's turn, and what happened.
public struct RankedSuggestions: Equatable, Sendable {
    public var suggestions: [Suggestion]
    public var run: ModelRun
}

/// The model's turn on a free stretch's list (#193): the top of the list goes to it, and what
/// it ranks moves to the top with its reasons. Whatever goes wrong, the list comes back as it
/// was.
public enum ModelStep {
    /// How long the model is given to answer.
    public static let timeout: Duration = .seconds(20)
    /// Characters of a reason shown at most.
    public static let reasonLimit = 150

    /// Sends the top of `suggestions` (the usual order) to `ranker` with the profile of him,
    /// and puts the sessions it ranks first, in its order, with its reasons; the rest follow in
    /// the usual order. The model isn't asked when it is unavailable (nil: an iOS without it),
    /// when there is nothing to rank, or when the prompt can't fit. Its answer is used only
    /// when `isUsable`; any failure, or no answer within `timeout`, leaves the list as it was.
    /// `sleep` is the timer, passed in so tests need no clock.
    public static func rank(_ suggestions: [Suggestion], sessionsInBlock: Int, picks: [Session],
                            preferences: SessionPreferences = SessionPreferences(), reservedToday: Int = 0,
                            ranker: (any SessionRanker)?, budget: PromptBudget = PromptBudget(),
                            timeout: Duration = ModelStep.timeout,
                            sleep: @escaping @Sendable (Duration) async throws -> Void = { try await Task.sleep(for: $0) })
        async -> RankedSuggestions {
        func unchanged(_ outcome: ModelOutcome, unavailable: String? = nil, prompt: ModelPrompt? = nil) -> RankedSuggestions {
            RankedSuggestions(suggestions: suggestions,
                              run: ModelRun(outcome: outcome, unavailableReason: unavailable, prompt: prompt?.metrics,
                                            modelPromptTokens: nil, modelAnswerTokens: nil, placed: 0, ignored: 0))
        }
        guard let ranker else { return unchanged(.unavailable, unavailable: "unsupported") }
        if case let .unavailable(why) = ranker.availability { return unchanged(.unavailable, unavailable: why) }
        guard !suggestions.isEmpty else { return unchanged(.nothingToRank) }
        let prompt = ModelPrompt.build(question: "", ranked: suggestions.map(\.session), sessionsInBlock: sessionsInBlock,
                                       picks: picks, preferences: preferences, reservedToday: reservedToday, budget: budget)
        guard prompt.fits, !prompt.sentIDs.isEmpty else { return unchanged(.promptTooLong, prompt: prompt) }
        // A list already closed asks nothing.
        guard !Task.isCancelled else { return unchanged(.cancelled, prompt: prompt) }

        switch await answered(prompt, by: ranker, within: timeout, sleep: sleep) {
        case let .success(answer): return apply(answer, prompt: prompt, to: suggestions)
        case let .failure(failed): return unchanged(failed.outcome, prompt: prompt)
        }
    }

    /// `suggestions` with what `answer` ranks first, or as they were when it isn't usable.
    static func apply(_ answer: ModelAnswer, prompt: ModelPrompt, to suggestions: [Suggestion]) -> RankedSuggestions {
        let found = place(answer.picks, sent: prompt.sentIDs, in: suggestions)
        let ignored = answer.picks.count - found.placed.count
        func run(_ outcome: ModelOutcome, placed: Int) -> ModelRun {
            ModelRun(outcome: outcome, unavailableReason: nil, prompt: prompt.metrics,
                     modelPromptTokens: answer.promptTokens, modelAnswerTokens: answer.answerTokens,
                     placed: placed, ignored: ignored, remembered: answer.remembered)
        }
        guard isUsable(placed: found.placed.count, unknown: found.unknown) else {
            return RankedSuggestions(suggestions: suggestions, run: run(.unusable, placed: 0))
        }
        let first = Set(found.placed.map(\.id))
        return RankedSuggestions(suggestions: found.placed + suggestions.filter { !first.contains($0.id) },
                                 run: run(.ok, placed: found.placed.count))
    }

    /// Whether `rank` will ask the model about `suggestions`: there are some, and the phone
    /// can run it now. (It may still not fit the window, which only a far smaller one allows.)
    public static func willAsk(_ suggestions: [Suggestion], ranker: (any SessionRanker)?) -> Bool {
        guard let ranker, ranker.availability == .available else { return false }
        return !suggestions.isEmpty
    }

    /// The list as `rank` gives it from `ranker`'s last answer, worked out at once without
    /// the model: nil when it has no answer for what this list would send.
    public static func remembered(_ suggestions: [Suggestion], sessionsInBlock: Int, picks: [Session],
                                  preferences: SessionPreferences = SessionPreferences(), reservedToday: Int = 0,
                                  ranker: RememberingRanker, budget: PromptBudget = PromptBudget()) -> RankedSuggestions? {
        guard willAsk(suggestions, ranker: ranker) else { return nil }
        let prompt = ModelPrompt.build(question: "", ranked: suggestions.map(\.session), sessionsInBlock: sessionsInBlock,
                                       picks: picks, preferences: preferences, reservedToday: reservedToday, budget: budget)
        guard prompt.fits, !prompt.sentIDs.isEmpty, let answer = ranker.lastAnswer(for: prompt) else { return nil }
        let ranked = apply(answer, prompt: prompt, to: suggestions)
        return ranked.run.outcome == .ok ? ranked : nil
    }

    /// An answer is used when it placed something and no more of its entries named a session
    /// it wasn't sent than it placed: one that is mostly wrong isn't trusted for the rest
    /// either. A session named again is ignored but isn't wrong.
    static func isUsable(placed: Int, unknown: Int) -> Bool {
        placed > 0 && unknown <= placed
    }

    /// The suggestions the model named, in its order, each once, with its reason. Only a
    /// session it was sent can be named, by its code as the prompt showed it; a code two sent
    /// sessions share names neither.
    static func place(_ picks: [ModelPick], sent: [String], in suggestions: [Suggestion]) -> (placed: [Suggestion], unknown: Int) {
        let byID = Dictionary(suggestions.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        var byCode: [String: Suggestion] = [:]
        var shared = Set<String>()
        for id in sent {
            guard let suggestion = byID[id], let code = shownCode(suggestion.session.abbreviation) else { continue }
            if byCode.removeValue(forKey: code) != nil || shared.contains(code) { shared.insert(code) } else { byCode[code] = suggestion }
        }
        var placed: [Suggestion] = []
        var seen = Set<String>()
        var unknown = 0
        for pick in picks {
            guard let code = shownCode(pick.code), var suggestion = byCode[code] else { unknown += 1; continue }
            guard seen.insert(suggestion.id).inserted else { continue }
            // Shown as written, on one line: "|" only matters inside the prompt.
            let reason = ModelPrompt.cut(ModelPrompt.flat(pick.reason), to: reasonLimit)
            suggestion.modelReason = reason.isEmpty ? nil : reason
            placed.append(suggestion)
        }
        return (placed, unknown)
    }

    /// A code as the prompt shows it and as the model is matched on: on one line, "|" as "/".
    static func shownCode(_ code: String?) -> String? {
        let shown = ModelPrompt.clean(code ?? "")
        return shown.isEmpty ? nil : shown
    }

    /// The model's answer, or the outcome that stands for it: whichever of the answer and the
    /// timer comes first. Neither is waited for once the other has decided, so a model that
    /// keeps working after it is cancelled can't hold up the timeout. Cancelling the caller
    /// gives `.cancelled` at once.
    static func answered(_ prompt: ModelPrompt, by ranker: any SessionRanker, within timeout: Duration,
                         sleep: @escaping @Sendable (Duration) async throws -> Void) async -> Result<ModelAnswer, ModelOutcomeError> {
        let race = Race<Result<ModelAnswer, ModelOutcomeError>>()
        return await withTaskCancellationHandler {
            await withCheckedContinuation { continuation in
                race.start(continuation)
                race.add(Task { race.finish(await outcome(of: prompt, by: ranker)) })
                race.add(Task {
                    // A timer that fails (cancelled) decides nothing.
                    do { try await sleep(timeout); race.finish(.failure(ModelOutcomeError(.timeout))) } catch {}
                })
            }
        } onCancel: {
            race.finish(.failure(ModelOutcomeError(.cancelled)))
        }
    }

    /// What the model's answer, or the way it failed, stands for.
    static func outcome(of prompt: ModelPrompt, by ranker: any SessionRanker) async -> Result<ModelAnswer, ModelOutcomeError> {
        do { return .success(try await ranker.rank(prompt)) } catch let failure as ModelFailure {
            switch failure {
            case .refused: return .failure(ModelOutcomeError(.refused))
            case .contextExceeded: return .failure(ModelOutcomeError(.contextExceeded))
            case .guardrail: return .failure(ModelOutcomeError(.guardrail))
            case .timedOut: return .failure(ModelOutcomeError(.timeout))
            }
        } catch { return .failure(ModelOutcomeError(.error)) }
    }
}

/// The first of several tasks to finish decides, once; the others are then cancelled.
final class Race<Value: Sendable>: @unchecked Sendable {
    private let lock = NSLock()
    private var continuation: CheckedContinuation<Value, Never>?
    /// A result that came before `start` (the caller was cancelled first).
    private var early: Value?
    private var tasks: [Task<Void, Never>] = []
    private var decided = false

    func start(_ continuation: CheckedContinuation<Value, Never>) {
        let ready: Value? = lock.withLock {
            if let early { return early }
            self.continuation = continuation
            return nil
        }
        if let ready { continuation.resume(returning: ready) }
    }

    func add(_ task: Task<Void, Never>) {
        let late = lock.withLock { () -> Bool in
            if !decided { tasks.append(task) }
            return decided
        }
        if late { task.cancel() }
    }

    func finish(_ value: Value) {
        let winner: (waiting: CheckedContinuation<Value, Never>?, losers: [Task<Void, Never>])? = lock.withLock {
            guard !decided else { return nil }
            decided = true
            defer { continuation = nil; tasks = [] }
            if continuation == nil { early = value }
            return (continuation, tasks)
        }
        guard let decided = winner else { return }
        decided.waiting?.resume(returning: value)
        decided.losers.forEach { $0.cancel() }
    }
}

/// A `ModelOutcome` other than `.ok`, as an error.
struct ModelOutcomeError: Error {
    var outcome: ModelOutcome
    init(_ outcome: ModelOutcome) { self.outcome = outcome }
}
