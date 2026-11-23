import Foundation

/// Moving between the days the calendar's day strip shows.
public enum DayNavigation {
    /// The day `offset` days on from `day` in `days` (the strip's order): +1 is the next day,
    /// -1 the previous one. It stops at the first and last day instead of wrapping around, so
    /// a move past either end gives that end. A day that isn't in `days` has no neighbours and
    /// comes back unchanged.
    public static func day(from day: String, by offset: Int, in days: [String]) -> String {
        guard let index = days.firstIndex(of: day) else { return day }
        // No move can go further than the strip is long, so clamp it first and the sum
        // below can never overflow, however large the offset.
        let step = min(max(offset, -days.count), days.count)
        let target = min(max(index + step, 0), days.count - 1)
        return days[target]
    }
}
