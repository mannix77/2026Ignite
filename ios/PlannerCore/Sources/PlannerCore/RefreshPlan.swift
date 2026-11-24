import Foundation

/// How often the app goes back to the conference site. His schedule is one small request and
/// is read often; the whole catalog (about 2,900 sessions, 12 pages) is downloaded at most daily.
public enum RefreshPlan {
    /// While the calendar is open, his schedule is read again once it is this old.
    public static let scheduleEvery: TimeInterval = 5 * 60
    /// The whole catalog is downloaded again once it is this old.
    public static let catalogEvery: TimeInterval = 24 * 60 * 60
    /// A schedule naming a session the catalog doesn't have downloads the catalog early, but
    /// not more often than this.
    public static let catalogForUnknownAfter: TimeInterval = 60 * 60

    /// True when his schedule should be read again: nothing is held, it is `scheduleEvery`
    /// old, or the phone's clock reads earlier than the last read, when its age can't be known.
    public static func scheduleDue(_ snapshot: PlanSnapshot?, now: Date) -> Bool {
        due(snapshot?.fetchedAt, every: scheduleEvery, now: now)
    }

    /// True when the whole catalog should be downloaded again, by the same reasoning.
    public static func catalogDue(_ snapshot: PlanSnapshot?, now: Date) -> Bool {
        due(snapshot?.catalogFetchedAt, every: catalogEvery, now: now)
    }

    private static func due(_ last: Date?, every interval: TimeInterval, now: Date) -> Bool {
        guard let last else { return true }
        let age = now.timeIntervalSince(last)
        return age >= interval || age < 0
    }

    /// Whether a failed update he didn't ask for should interrupt him. Not reaching the site
    /// (no connection, a timeout) is quiet: the calendar he last saw stays, and says how old it
    /// is. Anything the site itself answered, such as a rejected sign-in, is shown.
    public static func shouldReport(_ error: Error) -> Bool {
        !(error is URLError)
    }
}
