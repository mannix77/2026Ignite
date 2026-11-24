import Foundation

/// How long he allows to be in line before a session starts, for gap suggestions. From the
/// owner's experience of re:Invent: a reservable session needs 15 minutes at the least and 30
/// to be safe; a walk-up one (lightning talks, breakouts) far less.
public struct LineUp: Equatable, Sendable {
    /// What he gets until he changes it in Settings.
    public static let defaultMinutes = 30
    /// What Settings lets him choose.
    public static let allowedMinutes = 1...60
    /// The line for a session that can't be reserved, unless his own time is shorter.
    public static let walkUpMinutes = 5

    /// His time in line for a session that can be reserved, within `allowedMinutes`.
    public let minutes: Int

    /// `minutes` brought inside `allowedMinutes`.
    public init(minutes: Int = LineUp.defaultMinutes) {
        self.minutes = min(max(minutes, LineUp.allowedMinutes.lowerBound), LineUp.allowedMinutes.upperBound)
    }

    /// The setting as saved on the phone: a whole number is brought inside `allowedMinutes`;
    /// nothing saved, or anything else, gives `defaultMinutes`.
    public init(saved value: Any?) {
        guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(),
              number.doubleValue.isFinite, number.doubleValue == number.doubleValue.rounded() else {
            self.init()
            return
        }
        // Brought near the range first, so a huge saved number can't overflow `Int`.
        self.init(minutes: Int(min(max(number.doubleValue, -1), 61)))
    }

    /// Minutes in line for a walk-up session: `walkUpMinutes`, or his time if that is shorter.
    public var walkUp: Int { min(LineUp.walkUpMinutes, minutes) }

    /// Minutes in line before `session` starts: his time for one that can be reserved (or that
    /// the site doesn't say about), `walkUp` for a walk-up one.
    public func minutes(for session: Session) -> Int {
        session.isReservable == false ? walkUp : minutes
    }
}
