import Foundation

/// How much of the on-device model's window a prompt may use (#193). The numbers were chosen
/// against the real re:Invent 2026 catalog: 12 sessions with the longest text in its busiest
/// hour, abstracts cut to 300 characters, come to about 2,130 estimated tokens.
public struct PromptBudget: Equatable, Sendable {
    /// The model's whole window, prompt and answer together.
    public var window = 4096
    /// Kept free for the answer.
    public var answerReserve = 1000
    /// Sessions sent at most; the rest of the ranking is left out.
    public var maxSessions = 12
    /// Characters of an abstract sent at most.
    public var abstractLimit = 300
    /// Characters of his question sent at most.
    public var questionLimit = 300
    /// Interests named in the summary of his picks at most.
    public var maxInterests = 15

    public init() {}

    /// What the prompt itself may use: the window less the answer.
    public var promptLimit: Int { window - answerReserve }
}

/// Tokens a text is expected to take. Deliberately cautious: a character count divided by 3,
/// rounded up, where English usually runs nearer 4 characters a token.
public enum TokenEstimate {
    public static func tokens(_ text: String) -> Int { (text.count + 2) / 3 }
}

/// What one prompt used, for the logs (#193): every model call records these.
public struct PromptMetrics: Equatable, Sendable {
    public var estimatedTokens: Int
    public var window: Int
    public var answerReserve: Int
    /// Tokens to spare within the prompt's share of the window; never negative for a prompt
    /// `ModelPrompt` builds, unless its fixed text alone is too long.
    public var headroom: Int
    public var sessionsInBlock: Int
    public var sessionsSent: Int
    /// Ranked sessions not sent, for the session cap or to fit the window.
    public var sessionsLeftOut: Int
    public var abstractsCut: Int
}

/// The text the on-device model gets: instructions, his question, a summary of his picks and
/// the top of the ranking, kept within `PromptBudget`.
public struct ModelPrompt: Equatable, Sendable {
    public var text: String
    /// The sessions sent, in ranking order.
    public var sentIDs: [String]
    public var metrics: PromptMetrics

    static let instructions = """
        You help an attendee at AWS re:Invent choose which of the sessions below to go to. Rank \
        them from most to least worth attending for this attendee, using their interests, and \
        give one short reason for each. Use only the sessions listed, by their codes.
        """

    /// `ranked` is the pre-filter's order, best first; `sessionsInBlock` how many sessions the
    /// block held before it. Sessions are sent from the top until `maxSessions`, and then left
    /// out from the bottom until the prompt fits.
    public static func build(question: String, ranked: [Session], sessionsInBlock: Int, picks: [Session],
                             budget: PromptBudget = PromptBudget()) -> ModelPrompt {
        let head = [instructions,
                    "Question: " + cut(question, to: budget.questionLimit),
                    "Their interests: " + interests(of: picks, limit: budget.maxInterests),
                    "Sessions:"].joined(separator: "\n\n")
        var lines: [(id: String, text: String, cut: Bool)] = ranked.prefix(budget.maxSessions).map { session in
            let abstract = session.abstract ?? ""
            let shortened = cut(abstract, to: budget.abstractLimit)
            return (session.sessionId, line(session) + "\n" + shortened, shortened != abstract)
        }
        func assemble() -> String { ([head] + lines.map(\.text)).joined(separator: "\n\n") }
        var text = assemble()
        while TokenEstimate.tokens(text) > budget.promptLimit, !lines.isEmpty {
            lines.removeLast()
            text = assemble()
        }
        let tokens = TokenEstimate.tokens(text)
        return ModelPrompt(
            text: text, sentIDs: lines.map(\.id),
            metrics: PromptMetrics(estimatedTokens: tokens, window: budget.window, answerReserve: budget.answerReserve,
                                   headroom: budget.promptLimit - tokens, sessionsInBlock: sessionsInBlock,
                                   sessionsSent: lines.count, sessionsLeftOut: ranked.count - lines.count,
                                   abstractsCut: lines.filter(\.cut).count))
    }

    /// "AIM301 | Title | Workshop | 300 – Advanced | Venetian | 13:00, 60 min | Topic, Topic"
    static func line(_ session: Session) -> String {
        let time = session.sessionTime.map { "\($0.time), \($0.lengthMinutes) min" } ?? ""
        return [session.code, session.title, session.type ?? "", session.level ?? "", session.venue ?? "", time,
                (session.topics ?? []).prefix(3).joined(separator: ", ")].joined(separator: " | ")
    }

    /// `text` whole if it has at most `limit` characters; otherwise cut at the last word end
    /// that leaves room for "…", so the result has at most `limit` characters.
    static func cut(_ text: String, to limit: Int) -> String {
        guard text.count > limit else { return text }
        let room = String(text.prefix(limit - 1))
        // A word that ends exactly where the room does is kept whole.
        let endsAtWord = text.dropFirst(limit - 1).first?.isWhitespace == true
        let atWord = endsAtWord ? room : room.lastIndex(of: " ").map { String(room[..<$0]) } ?? room
        return atWord.trimmingCharacters(in: .whitespaces) + "…"
    }

    /// "Agentic AI (12), Amazon Bedrock (9), …": the topics and services his picks share most,
    /// most common first, then by name.
    static func interests(of picks: [Session], limit: Int) -> String {
        var counts: [String: Int] = [:]
        for session in picks {
            for name in Set((session.topics ?? []) + (session.services ?? [])) { counts[name, default: 0] += 1 }
        }
        let top = counts.sorted { ($0.value, $1.key) > ($1.value, $0.key) }.prefix(limit)
        return top.isEmpty ? "none yet" : top.map { "\($0.key) (\($0.value))" }.joined(separator: ", ")
    }
}
