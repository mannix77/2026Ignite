import Foundation

extension PlanSnapshot {
    /// The shortest free stretch the calendar offers suggestions for, in minutes. Anything
    /// shorter can't hold a session and the walks either side. With time in line as well, a
    /// short stretch between two seats will often list nothing; the threshold is kept as it is
    /// by the owner's decision (#193).
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

extension Gap {
    /// This free stretch as it is in `gaps` now: the one on the same day ending at the same
    /// minute, whose start and line may have moved on with the time. Nil once it is no longer
    /// offered. An open list of suggestions follows it, so it never offers a session he could
    /// no longer get into.
    public func current(in gaps: [Gap]) -> Gap? {
        gaps.first { $0.date == date && $0.end == end }
    }
}

/// A list of suggestions and the stretch it was worked out for. While an open stretch moves on
/// with the minute and its list reloads, the old list is not shown, so nothing that no longer
/// fits can be opened from it.
public struct GapSuggestions: Equatable, Sendable {
    public let gap: Gap
    public let suggestions: [Suggestion]

    public init(gap: Gap, suggestions: [Suggestion]) {
        self.gap = gap
        self.suggestions = suggestions
    }

    /// The list if it was worked out for `current`; nil while `current`'s own list loads.
    public func list(for current: Gap) -> [Suggestion]? {
        gap == current ? suggestions : nil
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

    /// Why a session was suggested: the on-device model's reason when it ranked it, otherwise
    /// "Shares Agentic AI, Amazon Bedrock". Nil when there is neither.
    public static func reasons(_ suggestion: Suggestion) -> String? {
        if let reason = suggestion.modelReason { return reason }
        return suggestion.shared.isEmpty ? nil : "Shares \(suggestion.shared.joined(separator: ", "))"
    }

    /// "Top 3 ranked by Apple Intelligence": over a list the model ranked; nil otherwise.
    public static func modelHeader(_ run: ModelRun) -> String? {
        guard run.outcome == .ok, run.placed > 0 else { return nil }
        return run.placed == 1 ? "Top session ranked by Apple Intelligence" : "Top \(run.placed) ranked by Apple Intelligence"
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
