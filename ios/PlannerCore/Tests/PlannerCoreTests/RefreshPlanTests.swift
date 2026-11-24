import XCTest
@testable import PlannerCore

final class RefreshPlanTests: XCTestCase {
    // 2026-12-03T17:00:00Z, 09:00 in Las Vegas.
    private let now = Date(timeIntervalSince1970: 1_796_317_200)

    private func ago(_ seconds: TimeInterval) -> Date { now.addingTimeInterval(-seconds) }

    private func held(scheduleAge: TimeInterval = 0, catalogAge: TimeInterval = 0, favorites: [String] = ["a"],
                      catalogMissing: [String] = []) -> PlanSnapshot {
        PlanSnapshot(sessions: [session("a"), session("b")], schedule: Schedule(reserved: [], favorites: favorites),
                     fetchedAt: ago(scheduleAge), skipped: 2, catalogFetchedAt: ago(catalogAge),
                     catalogMissing: catalogMissing)
    }

    private func update(_ backend: CountingBackend, _ previous: PlanSnapshot?, wholeCatalog: Bool = false,
                        catalogLastTried: Date? = nil) async throws -> Sync.UpdateResult {
        try await Sync.update(backend: backend, previous: previous, now: now, wholeCatalog: wholeCatalog,
                              catalogLastTried: catalogLastTried)
    }

    // MARK: When

    func testTheScheduleIsReadAgainFromFiveMinutes() {
        XCTAssertFalse(RefreshPlan.scheduleDue(held(scheduleAge: 299), lastAttempt: nil, now: now))
        XCTAssertTrue(RefreshPlan.scheduleDue(held(scheduleAge: 300), lastAttempt: nil, now: now))
    }

    func testAFailedAttemptWaitsFiveMinutesBeforeTheNext() {
        let stale = held(scheduleAge: 3600)
        XCTAssertFalse(RefreshPlan.scheduleDue(stale, lastAttempt: ago(299), now: now))
        XCTAssertTrue(RefreshPlan.scheduleDue(stale, lastAttempt: ago(300), now: now))
        XCTAssertTrue(RefreshPlan.scheduleDue(stale, lastAttempt: ago(-60), now: now))
    }

    func testTheCatalogIsDownloadedAgainFromTwentyFourHours() {
        XCTAssertFalse(RefreshPlan.catalogDue(held(catalogAge: 86399), lastAttempt: nil, now: now))
        XCTAssertTrue(RefreshPlan.catalogDue(held(catalogAge: 86400), lastAttempt: nil, now: now))
    }

    func testAFailedCatalogDownloadWaitsAnHour() {
        let old = held(catalogAge: 2 * 86400)
        XCTAssertFalse(RefreshPlan.catalogDue(old, lastAttempt: ago(3599), now: now))
        XCTAssertTrue(RefreshPlan.catalogDue(old, lastAttempt: ago(3600), now: now))
    }

    func testAClockMovedBackMakesBothDue() {
        XCTAssertTrue(RefreshPlan.scheduleDue(held(scheduleAge: -1), lastAttempt: nil, now: now))
        XCTAssertTrue(RefreshPlan.catalogDue(held(catalogAge: -1), lastAttempt: nil, now: now))
    }

    func testNothingHeldMakesBothDue() {
        XCTAssertTrue(RefreshPlan.scheduleDue(nil, lastAttempt: nil, now: now))
        XCTAssertTrue(RefreshPlan.catalogDue(nil, lastAttempt: nil, now: now))
    }

    func testOnlyAnUpdateHeAskedForReportsNoConnection() {
        XCTAssertFalse(RefreshPlan.shouldShow(URLError(.notConnectedToInternet), quiet: true))
        XCTAssertFalse(RefreshPlan.shouldShow(URLError(.timedOut), quiet: true))
        XCTAssertTrue(RefreshPlan.shouldShow(URLError(.notConnectedToInternet), quiet: false))
        XCTAssertTrue(RefreshPlan.shouldShow(APIError.signInNeeded, quiet: true))
        XCTAssertTrue(RefreshPlan.shouldShow(APIError.busy, quiet: true))
    }

    /// Known before the update starts, so the attempt is recorded even if the update then fails.
    func testWhetherTheCatalogIsTriedFirstIsKnownBeforehand() {
        XCTAssertTrue(Sync.triesCatalogFirst(previous: nil, wholeCatalog: false, catalogLastTried: ago(10), now: now))
        XCTAssertTrue(Sync.triesCatalogFirst(previous: held(catalogAge: 60), wholeCatalog: true, catalogLastTried: ago(10), now: now))
        XCTAssertTrue(Sync.triesCatalogFirst(previous: held(catalogAge: 86400), wholeCatalog: false, catalogLastTried: nil, now: now))
        XCTAssertFalse(Sync.triesCatalogFirst(previous: held(catalogAge: 86399), wholeCatalog: false, catalogLastTried: nil, now: now))
        XCTAssertFalse(Sync.triesCatalogFirst(previous: held(catalogAge: 86400), wholeCatalog: false, catalogLastTried: ago(3599), now: now))
    }

    // MARK: What is fetched

    func testWithinADayOnlyTheScheduleIsRead() async throws {
        let backend = CountingBackend()
        backend.scheduleAnswer = .success(Schedule(reserved: ["b"], favorites: ["a"]))
        let result = try await update(backend, held(scheduleAge: 600, catalogAge: 86399))
        XCTAssertEqual(backend.log, ["schedule"])
        XCTAssertFalse(result.triedCatalog)
        XCTAssertNil(result.catalogProblem)
        XCTAssertEqual(result.snapshot, PlanSnapshot(sessions: [session("a"), session("b")],
                                                     schedule: Schedule(reserved: ["b"], favorites: ["a"]),
                                                     fetchedAt: now, skipped: 2, catalogFetchedAt: ago(86399)))
    }

    func testADayOldCatalogIsDownloadedBeforeTheSchedule() async throws {
        let backend = CountingBackend()
        backend.catalogAnswer = .success(Catalog(sessions: [session("a"), session("b"), session("c")], skipped: 0))
        backend.scheduleAnswer = .success(Schedule(reserved: ["c"], favorites: ["gone"]))
        let result = try await update(backend, held(catalogAge: 86400))
        XCTAssertEqual(backend.log, ["catalog", "schedule"])
        XCTAssertTrue(result.triedCatalog)
        XCTAssertNil(result.catalogProblem)
        XCTAssertEqual(result.snapshot, PlanSnapshot(sessions: [session("a"), session("b"), session("c")],
                                                     schedule: Schedule(reserved: ["c"], favorites: ["gone"]),
                                                     fetchedAt: now, skipped: 0, catalogFetchedAt: now,
                                                     catalogMissing: ["gone"]))
    }

    func testAClockMovedBackDownloadsTheCatalogToo() async throws {
        let backend = CountingBackend()
        backend.catalogAnswer = .success(Catalog(sessions: [session("a"), session("b")]))
        backend.scheduleAnswer = .success(Schedule(reserved: ["b"], favorites: []))
        let result = try await update(backend, held(scheduleAge: -600, catalogAge: -600))
        XCTAssertEqual(backend.log, ["catalog", "schedule"])
        XCTAssertTrue(result.triedCatalog)
        XCTAssertNil(result.catalogProblem)
        XCTAssertEqual(result.snapshot, PlanSnapshot(sessions: [session("a"), session("b")],
                                                     schedule: Schedule(reserved: ["b"], favorites: []),
                                                     fetchedAt: now, catalogFetchedAt: now))
    }

    func testAskingForEverythingDownloadsTheCatalogHoweverRecent() async throws {
        let backend = CountingBackend()
        backend.catalogAnswer = .success(Catalog(sessions: [session("a"), session("b")], skipped: 1))
        backend.scheduleAnswer = .success(Schedule(reserved: ["a"], favorites: []))
        let result = try await update(backend, held(catalogAge: 60), wholeCatalog: true, catalogLastTried: ago(10))
        XCTAssertEqual(backend.log, ["catalog", "schedule"])
        XCTAssertTrue(result.triedCatalog)
        XCTAssertNil(result.catalogProblem)
        XCTAssertEqual(result.snapshot, PlanSnapshot(sessions: [session("a"), session("b")],
                                                     schedule: Schedule(reserved: ["a"], favorites: []),
                                                     fetchedAt: now, skipped: 1, catalogFetchedAt: now))
    }

    func testWithNothingHeldEverythingIsDownloaded() async throws {
        let backend = CountingBackend()
        backend.catalogAnswer = .success(Catalog(sessions: [session("a")]))
        backend.scheduleAnswer = .success(Schedule(reserved: ["a"], favorites: []))
        let result = try await update(backend, nil)
        XCTAssertEqual(backend.log, ["catalog", "schedule"])
        XCTAssertTrue(result.triedCatalog)
        XCTAssertNil(result.catalogProblem)
        XCTAssertEqual(result.snapshot, PlanSnapshot(sessions: [session("a")], schedule: Schedule(reserved: ["a"], favorites: []),
                                                     fetchedAt: now, catalogFetchedAt: now))
    }

    func testWithNothingHeldAFailedCatalogFailsTheUpdate() async {
        let backend = CountingBackend()
        backend.catalogAnswer = .failure(.server(503))
        do {
            _ = try await update(backend, nil)
            XCTFail("an update with no catalog at all produced a snapshot")
        } catch {
            XCTAssertEqual(error as? APIError, .server(503))
        }
        XCTAssertEqual(backend.log, ["catalog"])
    }

    func testAFailedCatalogStillUpdatesTheSchedule() async throws {
        let backend = CountingBackend()
        backend.catalogAnswer = .failure(.server(503))
        backend.scheduleAnswer = .success(Schedule(reserved: ["b"], favorites: []))
        let result = try await update(backend, held(scheduleAge: 600, catalogAge: 86400))
        XCTAssertEqual(backend.log, ["catalog", "schedule"])
        XCTAssertTrue(result.triedCatalog)
        XCTAssertEqual(result.catalogProblem as? APIError, .server(503))
        XCTAssertEqual(result.snapshot, PlanSnapshot(sessions: [session("a"), session("b")],
                                                     schedule: Schedule(reserved: ["b"], favorites: []),
                                                     fetchedAt: now, skipped: 2, catalogFetchedAt: ago(86400)))
    }

    func testAShrunkDueCatalogIsRefusedButTheScheduleIsRead() async throws {
        let backend = CountingBackend()
        backend.catalogAnswer = .success(Catalog(sessions: []))
        backend.scheduleAnswer = .success(Schedule(reserved: ["a"], favorites: []))
        let previous = held(catalogAge: 86400)
        XCTAssertEqual(previous.sessions.count, 2)
        let result = try await update(backend, previous)
        XCTAssertEqual(backend.log, ["catalog", "schedule"])
        XCTAssertTrue(result.triedCatalog)
        XCTAssertEqual(result.catalogProblem as? APIError, .catalogShrank(previous: 2, got: 0))
        XCTAssertEqual(result.snapshot, PlanSnapshot(sessions: [session("a"), session("b")],
                                                     schedule: Schedule(reserved: ["a"], favorites: []),
                                                     fetchedAt: now, skipped: 2, catalogFetchedAt: ago(86400)))
    }

    func testARecentlyFailedCatalogIsNotTriedAgain() async throws {
        let backend = CountingBackend()
        backend.scheduleAnswer = .success(Schedule(reserved: ["b"], favorites: []))
        let result = try await update(backend, held(catalogAge: 2 * 86400), catalogLastTried: ago(3599))
        XCTAssertEqual(backend.log, ["schedule"])
        XCTAssertFalse(result.triedCatalog)
        XCTAssertNil(result.catalogProblem)
        XCTAssertEqual(result.snapshot, PlanSnapshot(sessions: [session("a"), session("b")],
                                                     schedule: Schedule(reserved: ["b"], favorites: []),
                                                     fetchedAt: now, skipped: 2, catalogFetchedAt: ago(2 * 86400)))
    }

    func testANewUnknownSessionDownloadsAnHourOldCatalogAndKeepsTheSecondRead() async throws {
        let backend = CountingBackend()
        backend.catalogAnswer = .success(Catalog(sessions: [session("a"), session("b"), session("new")], skipped: 1))
        // The second read differs from the first: only the second may be kept.
        backend.scheduleAnswers = [.success(Schedule(reserved: [], favorites: ["a", "new"])),
                                   .success(Schedule(reserved: ["b"], favorites: ["a", "new"]))]
        let previous = held(catalogAge: 3600)
        XCTAssertEqual(previous.unresolvedIDs, [])
        let result = try await update(backend, previous)
        XCTAssertEqual(backend.log, ["schedule", "catalog", "schedule"])
        XCTAssertTrue(result.triedCatalog)
        XCTAssertNil(result.catalogProblem)
        XCTAssertEqual(result.snapshot, PlanSnapshot(sessions: [session("a"), session("b"), session("new")],
                                                     schedule: Schedule(reserved: ["b"], favorites: ["a", "new"]),
                                                     fetchedAt: now, skipped: 1, catalogFetchedAt: now))
    }

    func testAFailedSecondReadKeepsTheFirstScheduleWithTheNewCatalog() async throws {
        let backend = CountingBackend()
        backend.catalogAnswer = .success(Catalog(sessions: [session("a"), session("b"), session("new")]))
        backend.scheduleAnswers = [.success(Schedule(reserved: [], favorites: ["new"])), .failure(.server(503))]
        let result = try await update(backend, held(catalogAge: 3600))
        XCTAssertEqual(backend.log, ["schedule", "catalog", "schedule"])
        XCTAssertTrue(result.triedCatalog)
        XCTAssertNil(result.catalogProblem)
        XCTAssertEqual(result.snapshot, PlanSnapshot(sessions: [session("a"), session("b"), session("new")],
                                                     schedule: Schedule(reserved: [], favorites: ["new"]),
                                                     fetchedAt: now, catalogFetchedAt: now))
    }

    func testANewUnknownSessionWaitsForAnUnderAnHourOldCatalog() async throws {
        let backend = CountingBackend()
        backend.scheduleAnswer = .success(Schedule(reserved: [], favorites: ["a", "new"]))
        let previous = held(catalogAge: 3599)
        let result = try await update(backend, previous)
        XCTAssertEqual(backend.log, ["schedule"])
        XCTAssertFalse(result.triedCatalog)
        XCTAssertNil(result.catalogProblem)
        XCTAssertEqual(result.snapshot, PlanSnapshot(sessions: previous.sessions,
                                                     schedule: Schedule(reserved: [], favorites: ["a", "new"]),
                                                     fetchedAt: now, skipped: 2, catalogFetchedAt: ago(3599)))
        XCTAssertEqual(result.snapshot.unresolvedIDs, ["new"])
    }

    func testASessionStillMissingAfterADownloadDoesNotDownloadAgain() async throws {
        let backend = CountingBackend()
        backend.scheduleAnswer = .success(Schedule(reserved: ["b"], favorites: ["a", "gone"]))
        let previous = held(catalogAge: 10 * 3600, favorites: ["a", "gone"], catalogMissing: ["gone"])
        let result = try await update(backend, previous)
        XCTAssertEqual(backend.log, ["schedule"])
        XCTAssertFalse(result.triedCatalog)
        XCTAssertNil(result.catalogProblem)
        XCTAssertEqual(result.snapshot, PlanSnapshot(sessions: previous.sessions,
                                                     schedule: Schedule(reserved: ["b"], favorites: ["a", "gone"]),
                                                     fetchedAt: now, skipped: 2, catalogFetchedAt: ago(10 * 3600),
                                                     catalogMissing: ["gone"]))
        // A different unknown session alongside it still does (rule 2).
        let other = CountingBackend()
        other.catalogAnswer = .success(Catalog(sessions: [session("a"), session("b"), session("new")]))
        other.scheduleAnswers = [.success(Schedule(reserved: [], favorites: ["a", "gone", "new"])),
                                 .success(Schedule(reserved: ["new"], favorites: ["a", "gone", "new"]))]
        let next = try await update(other, previous)
        XCTAssertEqual(other.log, ["schedule", "catalog", "schedule"])
        XCTAssertTrue(next.triedCatalog)
        XCTAssertNil(next.catalogProblem)
        XCTAssertEqual(next.snapshot, PlanSnapshot(sessions: [session("a"), session("b"), session("new")],
                                                   schedule: Schedule(reserved: ["new"], favorites: ["a", "gone", "new"]),
                                                   fetchedAt: now, catalogFetchedAt: now, catalogMissing: ["gone"]))
    }

    func testARecentTryHoldsBackTheEarlyDownload() async throws {
        let backend = CountingBackend()
        backend.scheduleAnswer = .success(Schedule(reserved: ["b"], favorites: ["new"]))
        let previous = held(catalogAge: 2 * 3600)
        let waiting = try await update(backend, previous, catalogLastTried: ago(3599))
        XCTAssertEqual(backend.log, ["schedule"])
        XCTAssertFalse(waiting.triedCatalog)
        XCTAssertNil(waiting.catalogProblem)
        XCTAssertEqual(waiting.snapshot, PlanSnapshot(sessions: previous.sessions,
                                                      schedule: Schedule(reserved: ["b"], favorites: ["new"]),
                                                      fetchedAt: now, skipped: 2, catalogFetchedAt: ago(2 * 3600)))
        let other = CountingBackend()
        other.catalogAnswer = .success(Catalog(sessions: [session("a"), session("b"), session("new")]))
        other.scheduleAnswers = [.success(Schedule(reserved: [], favorites: ["new"])),
                                 .success(Schedule(reserved: ["a"], favorites: ["new"]))]
        let trying = try await update(other, previous, catalogLastTried: ago(3600))
        XCTAssertEqual(other.log, ["schedule", "catalog", "schedule"])
        XCTAssertTrue(trying.triedCatalog)
        XCTAssertNil(trying.catalogProblem)
        XCTAssertEqual(trying.snapshot, PlanSnapshot(sessions: [session("a"), session("b"), session("new")],
                                                     schedule: Schedule(reserved: ["a"], favorites: ["new"]),
                                                     fetchedAt: now, catalogFetchedAt: now))
    }

    func testACatalogThatJustFailedIsNotTriedTwiceForAnUnknownSession() async throws {
        let backend = CountingBackend()
        backend.catalogAnswer = .failure(.server(503))
        backend.scheduleAnswer = .success(Schedule(reserved: [], favorites: ["new"]))
        let result = try await update(backend, held(catalogAge: 86400))
        XCTAssertEqual(backend.log, ["catalog", "schedule"])
        XCTAssertTrue(result.triedCatalog)
        XCTAssertEqual(result.catalogProblem as? APIError, .server(503))
        XCTAssertEqual(result.snapshot, PlanSnapshot(sessions: [session("a"), session("b")],
                                                     schedule: Schedule(reserved: [], favorites: ["new"]),
                                                     fetchedAt: now, skipped: 2, catalogFetchedAt: ago(86400)))
        XCTAssertEqual(result.snapshot.unresolvedIDs, ["new"])
    }

    func testTheFirstDownloadRecordsWhatTheCatalogLacks() async throws {
        let backend = CountingBackend()
        backend.catalogAnswer = .success(Catalog(sessions: [session("a")]))
        backend.scheduleAnswer = .success(Schedule(reserved: ["a"], favorites: ["gone"]))
        let result = try await update(backend, nil)
        XCTAssertTrue(result.triedCatalog)
        XCTAssertNil(result.catalogProblem)
        XCTAssertEqual(result.snapshot, PlanSnapshot(sessions: [session("a")],
                                                     schedule: Schedule(reserved: ["a"], favorites: ["gone"]),
                                                     fetchedAt: now, catalogFetchedAt: now, catalogMissing: ["gone"]))
    }

    func testTheShrinkGuardAppliesToTheEarlyDownloadToo() async throws {
        let backend = CountingBackend()
        backend.catalogAnswer = .success(Catalog(sessions: []))
        backend.scheduleAnswer = .success(Schedule(reserved: [], favorites: ["new"]))
        let previous = held(catalogAge: 3600)
        XCTAssertEqual(previous.sessions.count, 2)
        let result = try await update(backend, previous)
        XCTAssertEqual(backend.log, ["schedule", "catalog"])
        XCTAssertTrue(result.triedCatalog)
        XCTAssertEqual(result.catalogProblem as? APIError, .catalogShrank(previous: 2, got: 0))
        XCTAssertEqual(result.snapshot, PlanSnapshot(sessions: previous.sessions,
                                                     schedule: Schedule(reserved: [], favorites: ["new"]),
                                                     fetchedAt: now, skipped: 2, catalogFetchedAt: ago(3600)))
    }

    func testAFailedScheduleReadFailsTheUpdate() async {
        let backend = CountingBackend()
        backend.scheduleAnswer = .failure(.signInNeeded)
        do {
            _ = try await update(backend, held(scheduleAge: 600))
            XCTFail("an update without a schedule produced a snapshot")
        } catch {
            XCTAssertEqual(error as? APIError, .signInNeeded)
        }
        XCTAssertEqual(backend.log, ["schedule"])
    }

    // MARK: When the update lands

    func testAChangeDuringTheUpdateKeepsItsScheduleAndTakesTheNewCatalog() {
        let fromUpdate = PlanSnapshot(sessions: [session("a"), session("b"), session("c")],
                                      schedule: Schedule(reserved: [], favorites: ["a"]), fetchedAt: now,
                                      skipped: 1, catalogFetchedAt: now, catalogMissing: [])
        let current = PlanSnapshot(sessions: [session("a"), session("b")],
                                   schedule: Schedule(reserved: ["c"], favorites: ["a"]), fetchedAt: ago(5),
                                   skipped: 2, catalogFetchedAt: ago(86400))
        XCTAssertEqual(Sync.landed(fromUpdate, current: current, changedDuring: true),
                       PlanSnapshot(sessions: [session("a"), session("b"), session("c")],
                                    schedule: Schedule(reserved: ["c"], favorites: ["a"]), fetchedAt: ago(5),
                                    skipped: 1, catalogFetchedAt: now, catalogMissing: []))
        // With no change in between, the update is shown as it came (rule 2).
        XCTAssertEqual(Sync.landed(fromUpdate, current: current, changedDuring: false), fromUpdate)
        XCTAssertEqual(Sync.landed(fromUpdate, current: nil, changedDuring: true), fromUpdate)
    }

    // MARK: Saved by the earlier version

    func testACalendarSavedWithoutTheNewFieldsStillOpens() throws {
        let json = #"{"sessions":[],"schedule":{"reserved":["a"],"favorites":[]},"fetchedAt":0,"skipped":0}"#
        let decoded = try JSONDecoder().decode(PlanSnapshot.self, from: Data(json.utf8))
        XCTAssertEqual(decoded, PlanSnapshot(sessions: [], schedule: Schedule(reserved: ["a"], favorites: []),
                                             fetchedAt: Date(timeIntervalSinceReferenceDate: 0),
                                             catalogFetchedAt: Date(timeIntervalSinceReferenceDate: 0), catalogMissing: []))
    }

    func testADamagedMissingListDropsBadEntriesAndKeepsTheCalendar() throws {
        let json = #"{"sessions":[],"schedule":{"reserved":["a"],"favorites":[]},"fetchedAt":0,"skipped":0,"catalogFetchedAt":10,"catalogMissing":[" gone ",null,"",7,"x"]}"#
        let decoded = try JSONDecoder().decode(PlanSnapshot.self, from: Data(json.utf8))
        XCTAssertEqual(decoded, PlanSnapshot(sessions: [], schedule: Schedule(reserved: ["a"], favorites: []),
                                             fetchedAt: Date(timeIntervalSinceReferenceDate: 0),
                                             catalogFetchedAt: Date(timeIntervalSinceReferenceDate: 10),
                                             catalogMissing: ["gone", "x"]))
        // A missing list that isn't a list at all is read as empty.
        let notAList = #"{"sessions":[],"schedule":{"reserved":[],"favorites":[]},"fetchedAt":0,"skipped":0,"catalogMissing":"gone"}"#
        XCTAssertEqual(try JSONDecoder().decode(PlanSnapshot.self, from: Data(notAList.utf8)).catalogMissing, [])
    }

    func testTheNewFieldsAreSavedAndReadBack() throws {
        let original = held(scheduleAge: 60, catalogAge: 7200, catalogMissing: ["gone"])
        let decoded = try JSONDecoder().decode(PlanSnapshot.self, from: JSONEncoder().encode(original))
        XCTAssertEqual(decoded, original)
        XCTAssertEqual(decoded.catalogMissing, ["gone"])
        XCTAssertNotEqual(decoded.catalogFetchedAt, decoded.fetchedAt)
    }
}
