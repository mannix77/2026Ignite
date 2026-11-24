import Foundation

/// How much of the on-device model's window a prompt may use (#193). The numbers were chosen
/// against the real re:Invent 2026 catalog: the 12 sessions with the longest text in the whole
/// catalog, abstracts cut to 300 characters, with a 300-character question and the catalog's 15
/// longest interest names, come to under 2,700 estimated tokens of the 3,096 allowed.
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
    /// Characters of an interest's name sent at most, so the fixed text can't crowd out the
    /// sessions: with every cap at its longest, in 4-byte characters, it still leaves room.
    public var interestNameLimit = 60
    /// Bytes of his question, and of an interest's name, sent at most: 4 a character. A
    /// character can be far larger (a family emoji is 25 bytes), so the fixed text is bounded
    /// by bytes too, and fits whatever it is written in.
    public var questionByteLimit = 1200
    public var interestNameByteLimit = 240
    /// Topics named on a session's line at most.
    public var maxTopics = 3

    public init() {}

    /// What the prompt itself may use: the window less the answer.
    public var promptLimit: Int { window - answerReserve }
}

/// Tokens a text is expected to take. Deliberately cautious: its UTF-8 bytes divided by 3,
/// rounded up. English runs nearer 4 characters (bytes) a token; other scripts and emoji take
/// more bytes a character, so counting bytes keeps the estimate on the safe side for them too.
public enum TokenEstimate {
    public static func tokens(_ text: String) -> Int { (text.utf8.count + 2) / 3 }
}

/// What one prompt used, for the logs (#193): every model call records these.
public struct PromptMetrics: Equatable, Sendable {
    public var estimatedTokens: Int
    public var window: Int
    public var answerReserve: Int
    /// Tokens to spare within the prompt's share of the window. Negative only when the fixed
    /// text alone (instructions, question, interests) is too long; then no session is sent.
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

    /// False when the fixed text alone (instructions, question, interests) is over the limit,
    /// which only a window smaller than the real one allows: then no session is sent and the
    /// prompt is not to be sent either.
    public var fits: Bool { metrics.headroom >= 0 }

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
        let asked = cut(clean(question), to: budget.questionLimit, maxBytes: budget.questionByteLimit)
        let head = [instructions,
                    "Question: " + (asked.isEmpty ? "(none)" : asked),
                    "Their interests: " + interests(of: picks, limit: budget.maxInterests, nameLimit: budget.interestNameLimit,
                                                          nameByteLimit: budget.interestNameByteLimit),
                    "Sessions:"].joined(separator: "\n\n")
        var lines: [(id: String, text: String, cut: Bool)] = ranked.prefix(budget.maxSessions).map { session in
            let abstract = clean(session.abstract ?? "")
            let shortened = cut(abstract, to: budget.abstractLimit)
            let entry = shortened.isEmpty ? line(session, topics: budget.maxTopics)
                                          : line(session, topics: budget.maxTopics) + "\n" + shortened
            return (session.sessionId, entry, shortened != abstract)
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

    /// "AIM301 | Title | Workshop | 300 – Advanced | Venetian | 13:00, 60 min | Topic, Topic":
    /// fields the site leaves out are skipped, and a "|" or line break inside a field is
    /// replaced, so every field stays in its place.
    static func line(_ session: Session, topics: Int) -> String {
        let time = session.sessionTime.map { "\($0.time), \($0.lengthMinutes) min" }
        let fields: [String?] = [session.abbreviation, session.title, session.type, session.level, session.venue, time,
                      (session.topics ?? []).prefix(topics).joined(separator: ", ")]
        return fields.compactMap { $0.map(clean) }
            .filter { !$0.isEmpty }
            .joined(separator: " | ")
    }

    /// `text` on one line: every run of whitespace, line breaks included, becomes one space.
    static func flat(_ text: String) -> String {
        text.split(whereSeparator: \.isWhitespace).joined(separator: " ")
    }

    /// Any text from the site or from him, as it goes into the prompt: on one line, with "|"
    /// (the session line's separator) written as "/", so nothing can pose as a field or entry.
    static func clean(_ text: String) -> String {
        flat(text).replacingOccurrences(of: "|", with: "/")
    }

    /// `cut(text, to: limit)`, and also at most `maxBytes` UTF-8 bytes: when the characters kept
    /// take more, as many whole characters as fit with the "…" are kept instead. Since those
    /// bytes run out within the first `limit` characters, the result keeps both caps.
    static func cut(_ text: String, to limit: Int, maxBytes: Int) -> String {
        let byCharacters = cut(text, to: limit)
        guard byCharacters.utf8.count > maxBytes else { return byCharacters }
        // Whole characters while they and the "…" (3 bytes) fit.
        var kept = ""
        var bytes = 0
        for character in text {
            let size = character.utf8.count
            guard bytes + size + 3 <= maxBytes else { break }
            kept.append(character)
            bytes += size
        }
        return kept.trimmingCharacters(in: .whitespaces) + "…"
    }

    /// `text` whole if it has at most `limit` characters; otherwise cut at the last word end
    /// that leaves room for "…", so the result has at most `limit` characters. A limit below 1
    /// gives nothing.
    static func cut(_ text: String, to limit: Int) -> String {
        guard limit > 0 else { return "" }
        guard text.count > limit else { return text }
        let room = String(text.prefix(limit - 1))
        // A word that ends exactly where the room does is kept whole.
        let endsAtWord = text.dropFirst(limit - 1).first?.isWhitespace == true
        let atWord = endsAtWord ? room : room.lastIndex(where: \.isWhitespace).map { String(room[..<$0]) } ?? room
        let kept = atWord.trimmingCharacters(in: .whitespaces)
        return (kept.isEmpty ? room.trimmingCharacters(in: .whitespaces) : kept) + "…"
    }

    /// "Agentic AI (12), Amazon Bedrock (9), …": the topics and services his picks share most,
    /// most common first, then by name. Names are cleaned and cut to `nameLimit` first, so the
    /// same name written twice on one pick counts once, and blank ones are skipped.
    static func interests(of picks: [Session], limit: Int, nameLimit: Int, nameByteLimit: Int = .max) -> String {
        var counts: [String: Int] = [:]
        for session in picks {
            let names = Set(((session.topics ?? []) + (session.services ?? []))
                .map { cut(clean($0), to: nameLimit, maxBytes: nameByteLimit) }
                .filter { !$0.isEmpty })
            for name in names { counts[name, default: 0] += 1 }
        }
        let top = counts.sorted { ($0.value, $1.key) > ($1.value, $0.key) }.prefix(limit)
        return top.isEmpty ? "none yet" : top.map { "\($0.key) (\($0.value))" }.joined(separator: ", ")
    }
}
