import Foundation

extension PlanSnapshot {
    /// The shortest free stretch the calendar offers suggestions for, in minutes. Anything
    /// shorter can't hold a session and the walks either side.
    public static let shortestOfferedGap = 30

    /// The free stretches of a day the calendar offers suggestions for: its gaps of at least
    /// `shortestOfferedGap` minutes. `index` is `sessionsByID`, if the caller has it built.
    public func offeredGaps(on date: String, index: [String: Session]? = nil) -> [Gap] {
        gaps(on: date, index: index).filter { $0.end - $0.start >= PlanSnapshot.shortestOfferedGap }
    }
}

extension Wording {
    /// "Free 10:00 – 10:30 AM": the label of a free stretch on the calendar.
    public static func gap(_ gap: Gap) -> String {
        "Free \(timeRange(start: gap.start, end: gap.end))"
    }

    /// How he can get into a suggested session, after whether it is one of his favorites:
    /// "Your favorite · Walk-up line".
    public static func outlook(_ suggestion: Suggestion) -> String {
        var parts: [String] = []
        if suggestion.isFavorite {
            parts.append("Your favorite")
        } else if suggestion.isRepeatOfFavorite {
            parts.append("Another run of a favorite")
        }
        switch suggestion.seat {
        case .reserve: parts.append("Seat to reserve")
        case .walkUp: parts.append("Walk-up line")
        }
        return parts.joined(separator: " · ")
    }

    /// "Shares Agentic AI, Amazon Bedrock": why a session was suggested. Nil when it shares
    /// nothing to name.
    public static func reasons(_ suggestion: Suggestion) -> String? {
        suggestion.shared.isEmpty ? nil : "Shares \(suggestion.shared.joined(separator: ", "))"
    }
}
