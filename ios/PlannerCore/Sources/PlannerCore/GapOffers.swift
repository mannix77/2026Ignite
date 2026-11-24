import Foundation

extension PlanSnapshot {
    /// The shortest free stretch the calendar offers suggestions for, in minutes. Anything
    /// shorter can't hold a session and the walks either side.
    public static let shortestOfferedGap = 30

    /// The minute it is now when `date` is today (`now` is the event's date and minute, from
    /// `Wording.eventNow`); nil on any other day. What the calendar cuts its free stretches at
    /// and draws its "now" line at.
    public static func minute(of now: (date: String, minute: Int), on date: String) -> Int? {
        now.date == date ? now.minute : nil
    }

    /// The free stretches of a day the calendar offers suggestions for: its gaps of at least
    /// `shortestOfferedGap` minutes. `now` is the event's date and minute (`Wording.eventNow`):
    /// on that day a stretch under way starts now, so nothing that has already started is
    /// suggested, and one with less than `shortestOfferedGap` minutes left is not offered. On
    /// that day he can't start lining up before now, even for the day's first sessions.
    /// Other days are not cut. `index` is `sessionsByID`, if the caller has it built.
    public func offeredGaps(on date: String, now: (date: String, minute: Int)? = nil,
                            index: [String: Session]? = nil) -> [Gap] {
        let cut = now.flatMap { PlanSnapshot.minute(of: $0, on: date) }
        return gaps(on: date, index: index).compactMap { whole in
            var gap = whole
            if let cut {
                gap.start = max(gap.start, cut)
                gap.lineFrom = max(gap.lineFrom ?? cut, cut)
            }
            return gap.end - gap.start >= PlanSnapshot.shortestOfferedGap ? gap : nil
        }
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

/// Staging for App Store screenshots: which free stretch to open on launch.
public enum GapStaging {
    /// The first of `gaps` when it is on `requestedDay` (a "YYYY-MM-DD" passed at launch);
    /// otherwise none. No request, a blank one or another day opens nothing.
    public static func gapToOpen(requestedDay: String?, in gaps: [Gap]) -> Gap? {
        guard let day = Identifier.clean(requestedDay), let first = gaps.first, first.date == day else { return nil }
        return first
    }
}
