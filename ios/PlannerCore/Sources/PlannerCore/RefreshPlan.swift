import Foundation

/// How often the app goes back to the conference site. His schedule is one small request and
/// is read often; the whole catalog (about 2,900 sessions, 12 pages) is downloaded at most daily.
public enum RefreshPlan {
    /// While the calendar is open, his schedule is read again once it is this old, and an
    /// update by itself that failed isn't tried again sooner than this.
    public static let scheduleEvery: TimeInterval = 5 * 60
    /// The whole catalog is downloaded again once it is this old.
    public static let catalogEvery: TimeInterval = 24 * 60 * 60
    /// The catalog isn't tried again sooner than this after a try, and a session on his schedule
    /// that the catalog lacks downloads it early only once the catalog is this old.
    public static let catalogRetry: TimeInterval = 60 * 60

    /// True when the calendar should read his schedule again by itself: nothing is held, it is
    /// `scheduleEvery` old (or the phone's clock reads earlier than the last read, when its age
    /// can't be known), and the last attempt by itself, if it failed, is as old.
    public static func scheduleDue(_ snapshot: PlanSnapshot?, lastAttempt: Date?, now: Date) -> Bool {
        due(snapshot?.fetchedAt, every: scheduleEvery, now: now) && due(lastAttempt, every: scheduleEvery, now: now)
    }

    /// True when the whole catalog should be downloaded with his schedule: it is `catalogEvery`
    /// old (or of unknown age), and wasn't tried in the last `catalogRetry`.
    public static func catalogDue(_ snapshot: PlanSnapshot?, lastAttempt: Date?, now: Date) -> Bool {
        due(snapshot?.catalogFetchedAt, every: catalogEvery, now: now) && due(lastAttempt, every: catalogRetry, now: now)
    }

    /// True when his schedule names a session the catalog lacks that the last download didn't
    /// already fail to find, the catalog is `catalogRetry` old, and wasn't tried in that time.
    public static func catalogWantedFor(_ snapshot: PlanSnapshot, lastAttempt: Date?, now: Date) -> Bool {
        let missing = Set(snapshot.catalogMissing)
        return snapshot.unresolvedIDs.contains { !missing.contains($0) }
            && due(snapshot.catalogFetchedAt, every: catalogRetry, now: now)
            && due(lastAttempt, every: catalogRetry, now: now)
    }

    /// Nothing at `last`, `interval` gone since, or a clock that reads earlier than `last`.
    private static func due(_ last: Date?, every interval: TimeInterval, now: Date) -> Bool {
        guard let last else { return true }
        let age = now.timeIntervalSince(last)
        return age >= interval || age < 0
    }

    /// Whether a failed update should interrupt him. One he didn't ask for (`quiet`) stays
    /// quiet when it couldn't reach the site (no connection, a timeout): the calendar he last
    /// saw stays and says how old it is. Anything the site itself answered is always shown.
    public static func shouldShow(_ error: Error, quiet: Bool) -> Bool {
        !quiet || !(error is URLError)
    }
}
