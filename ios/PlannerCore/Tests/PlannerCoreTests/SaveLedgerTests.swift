import XCTest
@testable import PlannerCore

final class SaveLedgerTests: XCTestCase {
    func testAnOlderOrRepeatedSaveIsRefused() {
        var ledger = SaveLedger()
        XCTAssertTrue(ledger.accept(2))
        XCTAssertFalse(ledger.accept(1))
        XCTAssertFalse(ledger.accept(2))
        XCTAssertTrue(ledger.accept(3))
        XCTAssertEqual(ledger.newest, 3)
        XCTAssertEqual(ledger.onDisk, 0)
    }

    func testADeleteRemovesTheDepartingCopyAndRefusesItsLateSaves() {
        var ledger = SaveLedger()
        XCTAssertTrue(ledger.accept(1))
        ledger.didWrite(1)
        XCTAssertTrue(ledger.ruleOut(through: 3))
        ledger.didRemove()
        XCTAssertEqual(ledger.onDisk, 0)
        // Saves issued before the delete arrive late and are refused; the next one is accepted.
        XCTAssertFalse(ledger.accept(2))
        XCTAssertFalse(ledger.accept(3))
        XCTAssertTrue(ledger.accept(4))
    }

    func testADeleteLeavesACopySavedAfterItsBoundary() {
        var ledger = SaveLedger()
        XCTAssertTrue(ledger.accept(1))
        ledger.didWrite(1)
        // A new sign-in saves version 2 while the old sign-out is still waiting.
        XCTAssertTrue(ledger.accept(2))
        ledger.didWrite(2)
        XCTAssertFalse(ledger.ruleOut(through: 1))
        XCTAssertEqual(ledger.onDisk, 2)
        // At the boundary itself the copy is the departing one, and goes.
        XCTAssertTrue(ledger.ruleOut(through: 2))
    }

    func testACopyFromAnEarlierRunIsRemovedWhenAsked() {
        var ledger = SaveLedger()
        XCTAssertTrue(ledger.ruleOut(through: 0))
    }

    // The sequence from review: a removal fails, then the next write fails too. The old
    // calendar is still on disk, so a delayed delete must still remove it.
    func testAFailedRemovalFollowedByAFailedWriteStillLeavesTheOldCopyToBeDeleted() {
        var ledger = SaveLedger()
        XCTAssertTrue(ledger.accept(1))
        ledger.didWrite(1)

        XCTAssertTrue(ledger.ruleOut(through: 1)) // removal attempted and fails: didRemove is not called
        XCTAssertEqual(ledger.onDisk, 1)

        XCTAssertTrue(ledger.accept(2)) // the write is attempted and fails: didWrite is not called
        XCTAssertEqual(ledger.onDisk, 1)

        XCTAssertTrue(ledger.ruleOut(through: 1), "the delayed delete skipped the old calendar")
        ledger.didRemove()
        XCTAssertEqual(ledger.onDisk, 0)
    }

    func testAWriteThatFinishesOutOfOrderDoesNotLowerTheVersionOnDisk() {
        var ledger = SaveLedger()
        XCTAssertTrue(ledger.accept(1))
        XCTAssertTrue(ledger.accept(2))
        ledger.didWrite(2)
        ledger.didWrite(1)
        XCTAssertEqual(ledger.onDisk, 2)
    }
}
