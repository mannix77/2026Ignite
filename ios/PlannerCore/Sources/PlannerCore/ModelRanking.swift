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
    /// Told when `ModelStep` gave up on `prompt` at its timeout: an answer to it that still
    /// comes is not to be trusted later.
    func abandon(_ prompt: ModelPrompt)
}

extension SessionRanker {
    public func abandon(_ prompt: ModelPrompt) {}
}

/// A model that answers an identical prompt from its last answer instead of asking again: an
/// open free stretch reloads every minute, and its list shouldn't be re-ranked each time.
/// Only the last usable answer is kept (`ModelStep.isUsable`); a failure, an unusable answer
/// and one that came after its timeout are not. A request runs on its own task, so when the
/// list asking for it closes or reloads, the model still finishes and its answer is kept;
/// asking the same prompt meanwhile waits for that same request.
public final class RememberingRanker: SessionRanker, @unchecked Sendable {
    private struct Running {
        var id: UUID
        var task: Task<ModelAnswer, Error>
        /// False once the request was abandoned at its timeout.
        var keep: Bool
    }

    /// A prompt as remembered: its text byte for byte, so two Unicode spellings Swift counts
    /// as equal are two prompts.
    private typealias Key = [UInt8]
    private static func key(_ prompt: ModelPrompt) -> Key { Array(prompt.text.utf8) }

    private let model: any SessionRanker
    private let lock = NSLock()
    private var last: (key: Key, answer: ModelAnswer, request: UUID)?
    private var running: [Key: Running] = [:]
    private var waiting = 0
    private var inFlight = 0

    /// Callers waiting on a request now: for tests that need two to be waiting at once.
    var callersWaiting: Int { lock.withLock { waiting } }
    /// Requests whose model call hasn't returned and been handled yet, abandoned ones
    /// included: for tests that wait for one to finish.
    var requestsInFlight: Int { lock.withLock { inFlight } }

    public init(_ model: any SessionRanker) { self.model = model }

    public var availability: ModelAvailability { model.availability }

    /// The last answer, if it was for this prompt: marked remembered, with no tokens, since
    /// the model doesn't run for it.
    public func lastAnswer(for prompt: ModelPrompt) -> ModelAnswer? {
        lock.withLock { remembered(RememberingRanker.key(prompt)) }
    }

    /// `lastAnswer`, with the lock held.
    private func remembered(_ key: Key) -> ModelAnswer? {
        guard let last, last.key == key else { return nil }
        var answer = last.answer
        answer.remembered = true
        answer.promptTokens = nil
        answer.answerTokens = nil
        return answer
    }

    public func rank(_ prompt: ModelPrompt) async throws -> ModelAnswer {
        let key = RememberingRanker.key(prompt)
        let ticket = ModelStep.ticket
        // The memory and the running requests are read together, so a request finishing in
        // between can't make a second caller start the same one again.
        let next: (answer: ModelAnswer?, task: Task<ModelAnswer, Error>?) = lock.withLock {
            if let answer = remembered(key) { return (answer, nil) }
            // A request abandoned at its timeout isn't joined: its answer won't be trusted.
            if let request = running[key], request.keep {
                // A caller whose ranking already gave up joins nothing.
                guard ticket?.claim(request.id) ?? true else { return (nil, nil) }
                waiting += 1
                return (nil, request.task)
            }
            // A caller already stopped starts nothing new: its task is cancelled, or its ticket
            // was closed when the ranking gave up on it (cancelled or timed out). The claim is
            // the moment the request starts, made before it does.
            let id = UUID()
            guard !Task.isCancelled, ticket?.claim(id) ?? true else { return (nil, nil) }
            let model = model
            // The model is called with no ticket of its own: a ranker it wraps can't take the
            // caller's.
            let task = ModelStep.$ticket.withValue(nil) { Task { () throws -> ModelAnswer in
                do {
                    let answer = try await model.rank(prompt)
                    self.lock.withLock {
                        self.inFlight -= 1
                        let request = self.running[key]
                        guard request?.id == id else { return }
                        self.running[key] = nil
                        if request?.keep == true, ModelStep.isUsable(answer, for: prompt) { self.last = (key, answer, id) }
                    }
                    return answer
                } catch {
                    self.lock.withLock {
                        self.inFlight -= 1
                        if self.running[key]?.id == id { self.running[key] = nil }
                    }
                    throw error
                }
            } }
            running[key] = Running(id: id, task: task, keep: true)
            inFlight += 1
            waiting += 1
            return (nil, task)
        }
        if let answer = next.answer { return answer }
        guard let task = next.task else { throw CancellationError() }
        defer { lock.withLock { waiting -= 1 } }
        return try await task.value
    }

    /// Abandons the request the current caller joined (`ModelStep.ticket`), and forgets its
    /// answer if it was already kept. A caller with no request abandons nothing: a newer
    /// request for the same prompt, started by a retry, is never touched.
    public func abandon(_ prompt: ModelPrompt) {
        guard let id = ModelStep.ticket?.request else { return }
        let key = RememberingRanker.key(prompt)
        lock.withLock {
            if running[key]?.id == id { running[key]?.keep = false }
            if last?.request == id { last = nil }
        }
    }
}

/// Which model request one caller of `ModelStep.rank` joined, so that its timeout abandons
/// that request and no other (`ModelStep.ticket`).
final class ModelRequestTicket: @unchecked Sendable {
    private let lock = NSLock()
    private var joined: UUID?
    private var closed = false
    var request: UUID? {
        get { lock.withLock { joined } }
        set { lock.withLock { joined = newValue } }
    }

    /// Whether its caller was stopped.
    var isClosed: Bool { lock.withLock { closed } }

    /// Its caller was stopped or timed out: no request may be started or joined for it from
    /// now on.
    func close() { lock.withLock { closed = true } }

    /// Records `request` as the one its caller joins or starts, unless the ticket was closed
    /// first. Checked under the same lock as `close`, so whichever comes first decides: a
    /// request claimed before the close runs on (and is the one a timeout abandons); after
    /// it, nothing is started or joined.
    func claim(_ request: UUID) -> Bool {
        lock.withLock {
            guard !closed else { return false }
            joined = request
            return true
        }
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
    /// The current caller's ticket: set around one request, and inherited by the tasks it
    /// starts, so `RememberingRanker` can record which request the caller joined.
    @TaskLocal static var ticket: ModelRequestTicket?

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
        let found = placement(answer.picks, prompt: prompt)
        func run(_ outcome: ModelOutcome, placed: Int) -> ModelRun {
            ModelRun(outcome: outcome, unavailableReason: nil, prompt: prompt.metrics,
                     modelPromptTokens: answer.promptTokens, modelAnswerTokens: answer.answerTokens,
                     placed: placed, ignored: answer.picks.count - found.placed.count, remembered: answer.remembered)
        }
        guard found.isUsable else { return RankedSuggestions(suggestions: suggestions, run: run(.unusable, placed: 0)) }
        let byID = Dictionary(suggestions.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        let placed = found.placed.compactMap { entry -> Suggestion? in
            guard var suggestion = byID[entry.id] else { return nil }
            suggestion.modelReason = entry.reason
            return suggestion
        }
        let first = Set(placed.map(\.id))
        return RankedSuggestions(suggestions: placed + suggestions.filter { !first.contains($0.id) },
                                 run: run(.ok, placed: placed.count))
    }

    /// Whether `rank` will ask the model about `suggestions`: there are some, and the phone
    /// can run it now. (It may still not fit the window, which only a far smaller one allows.)
    public static func willAsk(_ suggestions: [Suggestion], ranker: (any SessionRanker)?) -> Bool {
        guard let ranker, ranker.availability == .available else { return false }
        return !suggestions.isEmpty
    }

    /// The list as `rank` gives it from `ranker`'s last answer, worked out at once without
    /// the model: nil when it has no answer for the prompt this list would send.
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

    /// Where the model's entries land.
    struct Placement: Equatable {
        /// The sessions it placed, in its order, with its reason.
        var placed: [(id: String, reason: String?)]
        /// Distinct codes it named that the prompt didn't show.
        var unknown: Int

        /// Used when it placed something and named no more codes it wasn't sent than it
        /// placed: an answer that is mostly wrong isn't trusted for the rest either. A
        /// session named again, or a code two sent sessions share, is ignored but not wrong.
        var isUsable: Bool { !placed.isEmpty && unknown <= placed.count }

        static func == (a: Placement, b: Placement) -> Bool {
            a.unknown == b.unknown && a.placed.map(\.id) == b.placed.map(\.id) && a.placed.map(\.reason) == b.placed.map(\.reason)
        }
    }

    /// Whether `answer` would be used for `prompt`.
    static func isUsable(_ answer: ModelAnswer, for prompt: ModelPrompt) -> Bool {
        placement(answer.picks, prompt: prompt).isUsable
    }

    /// The sessions the model named, in its order, each once, with its reason. Only a session
    /// it was sent can be named, by the code the prompt showed for it, byte for byte (two
    /// Unicode spellings Swift counts as equal are not); the model's code is only trimmed, as
    /// any identifier is. A code two sent sessions share names neither.
    static func placement(_ picks: [ModelPick], prompt: ModelPrompt) -> Placement {
        var byCode: [[UInt8]: String] = [:]
        var shown = Set<[UInt8]>()
        for (id, code) in zip(prompt.sentIDs, prompt.sentCodes) {
            guard let code = code.map({ Array($0.utf8) }) else { continue }
            if shown.insert(code).inserted { byCode[code] = id } else { byCode[code] = nil }
        }
        var placed: [(id: String, reason: String?)] = []
        var seen = Set<String>()
        var unknown = Set<[UInt8]>()
        for pick in picks {
            guard let code = Identifier.clean(pick.code).map({ Array($0.utf8) }) else { unknown.insert([]); continue }
            guard shown.contains(code) else { unknown.insert(code); continue }
            guard let id = byCode[code], seen.insert(id).inserted else { continue }
            // Shown as written, on one line: "|" only matters inside the prompt.
            let reason = ModelPrompt.cut(ModelPrompt.flat(pick.reason), to: reasonLimit)
            placed.append((id, reason.isEmpty ? nil : reason))
        }
        return Placement(placed: placed, unknown: unknown.count)
    }

    /// A code as the prompt shows it: on one line, "|" as "/".
    static func shownCode(_ code: String?) -> String? {
        let shown = ModelPrompt.clean(code ?? "")
        return shown.isEmpty ? nil : shown
    }

    /// The model's answer, or the outcome that stands for it: whichever of the answer and the
    /// timer comes first. Neither is waited for once the other has decided, so a model that
    /// keeps working after it is cancelled can't hold up the timeout. Cancelling the caller
    /// gives `.cancelled` at once, and once it has, the model isn't started. At the timeout,
    /// `ranker` is told to abandon the prompt.
    static func answered(_ prompt: ModelPrompt, by ranker: any SessionRanker, within timeout: Duration,
                         sleep: @escaping @Sendable (Duration) async throws -> Void) async -> Result<ModelAnswer, ModelOutcomeError> {
        // The caller's ticket, inherited by the tasks below, records the request it joins.
        let ticket = ModelStep.ticket ?? ModelRequestTicket()
        return await ModelStep.$ticket.withValue(ticket) {
            await race(prompt, by: ranker, within: timeout, sleep: sleep)
        }
    }

    /// `answered`, with the caller's ticket set.
    private static func race(_ prompt: ModelPrompt, by ranker: any SessionRanker, within timeout: Duration,
                             sleep: @escaping @Sendable (Duration) async throws -> Void) async -> Result<ModelAnswer, ModelOutcomeError> {
        let race = Race<Result<ModelAnswer, ModelOutcomeError>>()
        let ticket = ModelStep.ticket
        let result = await withTaskCancellationHandler {
            await withCheckedContinuation { continuation in
                race.start(continuation)
                race.launch { Task { race.finish(await outcome(of: prompt, by: ranker)) } }
                race.launch {
                    Task {
                        // A timer that fails (cancelled) decides nothing.
                        do {
                            try await sleep(timeout)
                            // Closed first, so this caller starts or joins nothing from now on.
                            ticket?.close()
                            race.finish(.failure(ModelOutcomeError(.timeout)))
                        } catch {}
                    }
                }
            }
        } onCancel: {
            // Closed first, so no request starts for this caller once it has been stopped.
            ticket?.close()
            race.finish(.failure(ModelOutcomeError(.cancelled)))
        }
        if case let .failure(failed) = result, failed.outcome == .timeout { ranker.abandon(prompt) }
        return result
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

    /// Starts the task `make` creates, unless the race is already decided: the check and the
    /// start happen together, so nothing starts after the decision.
    func launch(_ make: () -> Task<Void, Never>) {
        lock.withLock {
            guard !decided else { return }
            tasks.append(make())
        }
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
        // The losers are stopped before the caller goes on.
        decided.losers.forEach { $0.cancel() }
        decided.waiting?.resume(returning: value)
    }
}

/// A `ModelOutcome` other than `.ok`, as an error.
struct ModelOutcomeError: Error {
    var outcome: ModelOutcome
    init(_ outcome: ModelOutcome) { self.outcome = outcome }
}
