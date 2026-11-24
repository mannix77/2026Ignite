import Foundation

/// When the app updates the calendar by itself: on coming back to the foreground, if the
/// calendar is old enough. Pull to refresh and the Update buttons always update.
public enum AutoRefresh {
    /// How old the calendar must be before coming back to the app updates it.
    public static let after: TimeInterval = 5 * 60

    /// True when coming back to the app at `now` should update a calendar last updated at
    /// `lastUpdated`: there is none yet, it is `after` old or more, or it reads as updated in
    /// the future (the phone's clock was moved back), when its age can't be trusted.
    public static func isDue(lastUpdated: Date?, now: Date) -> Bool {
        guard let lastUpdated else { return true }
        let age = now.timeIntervalSince(lastUpdated)
        return age >= after || age < 0
    }

    /// Whether a failed automatic update should interrupt him. Not reaching the site (no
    /// connection, a timeout) is quiet: the calendar he last saw stays, and Settings says when
    /// it was updated. Anything the site itself answered, such as a rejected sign-in, is shown.
    public static func shouldReport(_ error: Error) -> Bool {
        !(error is URLError)
    }
}
