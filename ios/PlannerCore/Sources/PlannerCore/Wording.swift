import Foundation

/// The words the app shows. Kept here, away from the views, so they can be tested.
public enum Wording {
    /// "3:00 PM" for minutes after midnight. Minutes past the end of the day wrap around.
    /// The band before a reserved seat: "Be there by 9:50 AM".
    public static func beThere(by minute: Int) -> String { "Be there by \(clock(minute))" }

    public static func clock(_ minutes: Int) -> String {
        let inDay = ((minutes % 1440) + 1440) % 1440
        let hour = inDay / 60
        let hour12 = hour % 12 == 0 ? 12 : hour % 12
        return String(format: "%d:%02d %@", hour12, inDay % 60, hour < 12 ? "AM" : "PM")
    }

    /// "3:00 – 5:00 PM", or just the start for a session with no length.
    public static func timeRange(start: Int, end: Int) -> String {
        guard end > start else { return clock(start) }
        let from = clock(start)
        let to = clock(end)
        // Drop the first AM/PM when both ends share it.
        if from.suffix(2) == to.suffix(2) { return "\(from.dropLast(3)) – \(to)" }
        return "\(from) – \(to)"
    }

    /// "Wed, Dec 2" for "2026-12-02"; the text itself when it is not a date.
    public static func day(_ date: String) -> String {
        guard let parsed = parse(date) else { return date }
        let out = DateFormatter()
        out.calendar = utcCalendar
        out.timeZone = utcCalendar.timeZone
        out.locale = Locale(identifier: "en_US_POSIX")
        out.dateFormat = "EEE, MMM d"
        return out.string(from: parsed)
    }

    /// Weekday and day number for a day chip: ("Wed", "2").
    public static func dayChip(_ date: String) -> (weekday: String, number: String) {
        let parts = day(date).split(separator: " ")
        guard parse(date) != nil, parts.count == 3 else { return (date, "") }
        return (String(parts[0].dropLast()), String(parts[2]))
    }

    /// Today's date ("YYYY-MM-DD") and the minute of the day, in the event's time zone.
    public static func eventNow(_ now: Date, timeZone: TimeZone) -> (date: String, minute: Int) {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        let c = calendar.dateComponents([.year, .month, .day, .hour, .minute], from: now)
        return (String(format: "%04d-%02d-%02d", c.year ?? 0, c.month ?? 0, c.day ?? 0), (c.hour ?? 0) * 60 + (c.minute ?? 0))
    }

    /// The calendar's line on how fresh it is: "Updated from AWS 12 min ago. Pull down for the
    /// latest." Under a minute is "just now"; whole minutes, hours, then days, rounded down. A
    /// phone clock that reads earlier than the update leaves the age out rather than guess it.
    public static func lastUpdated(_ fetchedAt: Date, now: Date, sample: Bool) -> String {
        let seconds = now.timeIntervalSince(fetchedAt)
        let age: String?
        switch seconds {
        case ..<0: age = nil
        case ..<60: age = "just now"
        case ..<3600: age = "\(Int(seconds / 60)) min ago"
        case ..<86400: age = "\(Int(seconds / 3600)) hr ago"
        default:
            let days = Int(seconds / 86400)
            age = days == 1 ? "1 day ago" : "\(days) days ago"
        }
        let source = sample ? "Sample conference" : "Updated from AWS"
        let joined = age.map { sample ? "\(source), updated \($0)" : "\(source) \($0)" } ?? source
        return joined + ". Pull down for the latest."
    }

    /// The calendar's status line: what is happening while it updates, and how fresh it is
    /// otherwise (`lastUpdated`).
    public static func calendarStatus(refreshing: Bool, fetchedAt: Date, now: Date, sample: Bool) -> String {
        guard refreshing else { return lastUpdated(fetchedAt, now: now, sample: sample) }
        return sample ? "Updating the sample conference…" : "Updating from AWS…"
    }

    /// A Settings row's value for a list he chooses from: `none` when empty, the one name, or
    /// how many.
    public static func preferenceSummary(_ chosen: [String], none: String) -> String {
        switch chosen.count {
        case 0: none
        case 1: chosen[0]
        default: "\(chosen.count) chosen"
        }
    }

    /// What to say about seats. A seat the attendee holds reads "unavailable" on the site, so
    /// the reservation is checked first.
    /// Whether "Reserve a seat" can be pressed: not when the site shows the session full or
    /// walk-up only. A band the app doesn't know, or none, leaves the answer to the site.
    public static func canReserve(_ session: Session) -> Bool {
        session.isReservable == true && !["unavailable", "walkUp"].contains(session.seatAvailability ?? "")
    }

    public static func seats(_ session: Session, commitment: Commitment?) -> String? {
        if commitment == .reserved { return "You hold a seat" }
        if commitment == .invited { return "By invitation" }
        guard session.isReservable == true else { return "Walk-in, no reservation" }
        switch session.seatAvailability {
        case "available": return "Seats available"
        case "limited": return "Limited seats"
        case "veryLimited": return "Very few seats"
        case "unavailable": return "Full"
        case "walkUp": return "Walk-up only"
        default: return nil
        }
    }

    /// Why the conference site refused one session. `code(for:)` turns a session id into its
    /// public code for naming clashes.
    public static func refusal(_ failure: BulkFailure, code: (String) -> String?) -> String {
        switch failure.code {
        case "scheduleConflict":
            let names = (failure.conflictsWith ?? []).map { code($0) ?? "another session" }
            return names.isEmpty ? "It clashes with a session you already hold."
                : "It clashes with \(names.joined(separator: ", "))."
        case "sessionFull": return "This session is full."
        case "alreadyScheduled": return "You already hold a seat in this session."
        case "sessionNotReservable": return "This session does not take reservations."
        case "insufficientAccess": return "Your registration does not include this session."
        case "timePassed": return "This session has already started or ended."
        case "alreadyFavorited": return "This is already a favorite."
        case "notFavorited": return "This was not a favorite."
        case "invitedSession": return "This session is by invitation and cannot be changed here."
        default: return "The conference site refused this."
        }
    }

    /// What to tell the attendee when a fetch or a change fails.
    public static func problem(_ error: Error) -> String {
        guard let api = error as? APIError else {
            return "Could not reach the conference site. Check your connection and try again."
        }
        switch api {
        case .signInNeeded: return "Your sign-in has expired. Sign in again to update."
        case .notRegistered: return "This Builder ID is not registered for the event."
        case .refused: return "The conference site is refusing requests for now. Try again in a few minutes."
        case .notFound: return "The conference site could not find that."
        case .closed: return "This is closed on the conference site for now."
        case .busy: return "The conference site is busy. Try again in a minute."
        case .server, .badResponse: return "The conference site had a problem. Try again shortly."
        case .scheduleMostlyJunk:
            return "Your schedule arrived mostly unreadable, so the last good copy was kept."
        case .catalogIncomplete, .catalogChanged, .catalogMostlyJunk, .catalogShrank:
            return "The session list arrived incomplete, so the last good copy was kept."
        case .outcomeUnknown:
            return "The answer never arrived. Your schedule was read again: check whether the change went through."
        case .unconfirmed:
            return "The conference site did not confirm the change. Your schedule was read again: check whether it went through."
        }
    }

    private static var utcCalendar: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        return calendar
    }

    private static func parse(_ date: String) -> Date? {
        guard SessionTime(date: date, time: "00:00").hasValidDate else { return nil }
        let parts = date.split(separator: "-").compactMap { Int($0) }
        return utcCalendar.date(from: DateComponents(year: parts[0], month: parts[1], day: parts[2]))
    }
}
