import Foundation

/// Keeps track of which saved copy of the calendar is on disk, so that a slow older save never
/// lands on a newer one and a delete only removes what it was meant to. It records what
/// actually happened: a write or a removal counts only once it has succeeded.
public struct SaveLedger: Equatable, Sendable {
    /// The highest version accepted for writing or ruled out by a delete.
    public private(set) var newest = 0
    /// The version of the copy known to be on disk, or 0 when none has been written in this
    /// run (a copy from an earlier run may still be there).
    public private(set) var onDisk = 0

    public init() {}

    /// True when a save with this version should go ahead. Older and repeated versions are refused.
    public mutating func accept(_ version: Int) -> Bool {
        guard version > newest else { return false }
        newest = version
        return true
    }

    /// Call after the write of `version` has succeeded.
    public mutating func didWrite(_ version: Int) {
        onDisk = max(onDisk, version)
    }

    /// Rules out every save issued up to `version`. True when the copy on disk should be
    /// removed: it is that old or older, or of unknown age. False when a later save has
    /// replaced it.
    public mutating func ruleOut(through version: Int) -> Bool {
        newest = max(newest, version)
        return onDisk <= version
    }

    /// Call after the copy on disk has been removed or emptied.
    public mutating func didRemove() {
        onDisk = 0
    }
}
