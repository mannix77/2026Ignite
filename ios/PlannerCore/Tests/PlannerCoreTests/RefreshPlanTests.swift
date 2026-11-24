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

    // MARK: What is fetched

    func testWithinADayOnlyTheScheduleIsRead() async throws {
        let backend = CountingBackend()
        backend.scheduleAnswer = .success(Schedule(reserved: ["b"], favorites: ["a"]))
        let result = try await Sync.update(backend: backend, previous: held(scheduleAge: 600, catalogAge: 86399),
                                           now: now, catalogLastTried: nil)
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
        let result = try await Sync.update(backend: backend, previous: held(catalogAge: 86400), now: now, catalogLastTried: nil)
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
        let result = try await Sync.update(backend: backend, previous: held(scheduleAge: -600, catalogAge: -600),
                                           now: now, catalogLastTried: nil)
        XCTAssertEqual(backend.log, ["catalog", "schedule"])
        XCTAssertEqual(result.snapshot.catalogFetchedAt, now)
        XCTAssertEqual(result.snapshot.fetchedAt, now)
    }

    func testAskingForEverythingDownloadsTheCatalogHoweverRecent() async throws {
        let backend = CountingBackend()
        backend.catalogAnswer = .success(Catalog(sessions: [session("a"), session("b")], skipped: 1))
        backend.scheduleAnswer = .success(Schedule(reserved: ["a"], favorites: []))
        let result = try await Sync.update(backend: backend, previous: held(catalogAge: 60), now: now,
                                           wholeCatalog: true, catalogLastTried: ago(10))
        XCTAssertEqual(backend.log, ["catalog", "schedule"])
        XCTAssertEqual(result.snapshot, PlanSnapshot(sessions: [session("a"), session("b")],
                                                     schedule: Schedule(reserved: ["a"], favorites: []),
                                                     fetchedAt: now, skipped: 1, catalogFetchedAt: now))
    }

    func testWithNothingHeldEverythingIsDownloaded() async throws {
        let backend = CountingBackend()
        backend.catalogAnswer = .success(Catalog(sessions: [session("a")]))
        backend.scheduleAnswer = .success(Schedule(reserved: ["a"], favorites: []))
        let result = try await Sync.update(backend: backend, previous: nil, now: now, catalogLastTried: nil)
        XCTAssertEqual(backend.log, ["catalog", "schedule"])
        XCTAssertTrue(result.triedCatalog)
        XCTAssertEqual(result.snapshot, PlanSnapshot(sessions: [session("a")], schedule: Schedule(reserved: ["a"], favorites: []),
                                                     fetchedAt: now, catalogFetchedAt: now))
    }

    func testWithNothingHeldAFailedCatalogFailsTheUpdate() async {
        let backend = CountingBackend()
        backend.catalogAnswer = .failure(.server(503))
        do {
            _ = try await Sync.update(backend: backend, previous: nil, now: now, catalogLastTried: nil)
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
        let previous = held(scheduleAge: 600, catalogAge: 86400)
        let result = try await Sync.update(backend: backend, previous: previous, now: now, catalogLastTried: nil)
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
        let result = try await Sync.update(backend: backend, previous: previous, now: now, catalogLastTried: nil)
        XCTAssertEqual(result.catalogProblem as? APIError, .catalogShrank(previous: 2, got: 0))
        XCTAssertEqual(result.snapshot.sessions, previous.sessions)
        XCTAssertEqual(result.snapshot.schedule.reserved, ["a"])
        XCTAssertEqual(backend.log, ["catalog", "schedule"])
    }

    func testARecentlyFailedCatalogIsNotTriedAgain() async throws {
        let backend = CountingBackend()
        let result = try await Sync.update(backend: backend, previous: held(catalogAge: 2 * 86400), now: now,
                                           catalogLastTried: ago(3599))
        XCTAssertEqual(backend.log, ["schedule"])
        XCTAssertFalse(result.triedCatalog)
        XCTAssertEqual(result.snapshot.catalogFetchedAt, ago(2 * 86400))
    }

    func testANewUnknownSessionDownloadsAnHourOldCatalogThenReadsTheScheduleAgain() async throws {
        let backend = CountingBackend()
        backend.catalogAnswer = .success(Catalog(sessions: [session("a"), session("b"), session("new")], skipped: 1))
        backend.scheduleAnswer = .success(Schedule(reserved: [], favorites: ["a", "new"]))
        let previous = held(catalogAge: 3600)
        XCTAssertEqual(previous.unresolvedIDs, [])
        let result = try await Sync.update(backend: backend, previous: previous, now: now, catalogLastTried: nil)
        XCTAssertEqual(backend.log, ["schedule", "catalog", "schedule"])
        XCTAssertTrue(result.triedCatalog)
        XCTAssertEqual(result.snapshot, PlanSnapshot(sessions: [session("a"), session("b"), session("new")],
                                                     schedule: Schedule(reserved: [], favorites: ["a", "new"]),
                                                     fetchedAt: now, skipped: 1, catalogFetchedAt: now))
    }

    func testANewUnknownSessionWaitsForAnUnderAnHourOldCatalog() async throws {
        let backend = CountingBackend()
        backend.scheduleAnswer = .success(Schedule(reserved: [], favorites: ["a", "new"]))
        let previous = held(catalogAge: 3599)
        let result = try await Sync.update(backend: backend, previous: previous, now: now, catalogLastTried: nil)
        XCTAssertEqual(backend.log, ["schedule"])
        XCTAssertEqual(result.snapshot, PlanSnapshot(sessions: previous.sessions,
                                                     schedule: Schedule(reserved: [], favorites: ["a", "new"]),
                                                     fetchedAt: now, skipped: 2, catalogFetchedAt: ago(3599)))
        XCTAssertEqual(result.snapshot.unresolvedIDs, ["new"])
    }

    func testASessionStillMissingAfterADownloadDoesNotDownloadAgain() async throws {
        let backend = CountingBackend()
        backend.scheduleAnswer = .success(Schedule(reserved: [], favorites: ["a", "gone"]))
        let previous = held(catalogAge: 10 * 3600, favorites: ["a", "gone"], catalogMissing: ["gone"])
        let result = try await Sync.update(backend: backend, previous: previous, now: now, catalogLastTried: nil)
        XCTAssertEqual(backend.log, ["schedule"])
        XCTAssertEqual(result.snapshot.unresolvedIDs, ["gone"])
        XCTAssertEqual(result.snapshot.catalogMissing, ["gone"])
        // A different unknown session alongside it still does (rule 2).
        let other = CountingBackend()
        other.catalogAnswer = .success(Catalog(sessions: [session("a"), session("b"), session("new")]))
        other.scheduleAnswer = .success(Schedule(reserved: [], favorites: ["a", "gone", "new"]))
        let next = try await Sync.update(backend: other, previous: previous, now: now, catalogLastTried: nil)
        XCTAssertEqual(other.log, ["schedule", "catalog", "schedule"])
        XCTAssertEqual(next.snapshot.catalogMissing, ["gone"])
    }

    func testTheShrinkGuardAppliesToTheEarlyDownloadToo() async throws {
        let backend = CountingBackend()
        backend.catalogAnswer = .success(Catalog(sessions: []))
        backend.scheduleAnswer = .success(Schedule(reserved: [], favorites: ["new"]))
        let previous = held(catalogAge: 3600)
        let result = try await Sync.update(backend: backend, previous: previous, now: now, catalogLastTried: nil)
        XCTAssertEqual(result.catalogProblem as? APIError, .catalogShrank(previous: 2, got: 0))
        XCTAssertEqual(result.snapshot.sessions, previous.sessions)
        XCTAssertEqual(result.snapshot.schedule.favorites, ["new"])
        XCTAssertEqual(backend.log, ["schedule", "catalog"])
    }

    func testARecentTryHoldsBackTheEarlyDownload() async throws {
        let backend = CountingBackend()
        backend.scheduleAnswer = .success(Schedule(reserved: [], favorites: ["new"]))
        let previous = held(catalogAge: 2 * 3600)
        let waiting = try await Sync.update(backend: backend, previous: previous, now: now, catalogLastTried: ago(3599))
        XCTAssertEqual(backend.log, ["schedule"])
        XCTAssertFalse(waiting.triedCatalog)
        let other = CountingBackend()
        other.catalogAnswer = .success(Catalog(sessions: [session("a"), session("b"), session("new")]))
        other.scheduleAnswer = .success(Schedule(reserved: [], favorites: ["new"]))
        let trying = try await Sync.update(backend: other, previous: previous, now: now, catalogLastTried: ago(3600))
        XCTAssertEqual(other.log, ["schedule", "catalog", "schedule"])
        XCTAssertTrue(trying.triedCatalog)
    }

    func testACatalogThatJustFailedIsNotTriedTwiceForAnUnknownSession() async throws {
        let backend = CountingBackend()
        backend.catalogAnswer = .failure(.server(503))
        backend.scheduleAnswer = .success(Schedule(reserved: [], favorites: ["new"]))
        let result = try await Sync.update(backend: backend, previous: held(catalogAge: 86400), now: now, catalogLastTried: nil)
        XCTAssertEqual(backend.log, ["catalog", "schedule"])
        XCTAssertEqual(result.catalogProblem as? APIError, .server(503))
        XCTAssertEqual(result.snapshot.unresolvedIDs, ["new"])
    }

    func testTheFirstDownloadRecordsWhatTheCatalogLacks() async throws {
        let backend = CountingBackend()
        backend.catalogAnswer = .success(Catalog(sessions: [session("a")]))
        backend.scheduleAnswer = .success(Schedule(reserved: ["a"], favorites: ["gone"]))
        let result = try await Sync.update(backend: backend, previous: nil, now: now, catalogLastTried: nil)
        XCTAssertEqual(result.snapshot, PlanSnapshot(sessions: [session("a")],
                                                     schedule: Schedule(reserved: ["a"], favorites: ["gone"]),
                                                     fetchedAt: now, catalogFetchedAt: now, catalogMissing: ["gone"]))
    }

    func testAFailedScheduleReadFailsTheUpdate() async {
        let backend = CountingBackend()
        backend.scheduleAnswer = .failure(.signInNeeded)
        do {
            _ = try await Sync.update(backend: backend, previous: held(scheduleAge: 600), now: now, catalogLastTried: nil)
            XCTFail("an update without a schedule produced a snapshot")
        } catch {
            XCTAssertEqual(error as? APIError, .signInNeeded)
        }
        XCTAssertEqual(backend.log, ["schedule"])
    }

    // MARK: Saved by the earlier version

    func testACalendarSavedWithoutTheNewFieldsStillOpens() throws {
        let json = #"{"sessions":[],"schedule":{"reserved":["a"],"favorites":[]},"fetchedAt":0,"skipped":0}"#
        let decoded = try JSONDecoder().decode(PlanSnapshot.self, from: Data(json.utf8))
        XCTAssertEqual(decoded, PlanSnapshot(sessions: [], schedule: Schedule(reserved: ["a"], favorites: []),
                                             fetchedAt: Date(timeIntervalSinceReferenceDate: 0),
                                             catalogFetchedAt: Date(timeIntervalSinceReferenceDate: 0), catalogMissing: []))
    }

    func testTheNewFieldsAreSavedAndReadBack() throws {
        let original = held(scheduleAge: 60, catalogAge: 7200, catalogMissing: ["gone"])
        let decoded = try JSONDecoder().decode(PlanSnapshot.self, from: JSONEncoder().encode(original))
        XCTAssertEqual(decoded, original)
        XCTAssertEqual(decoded.catalogMissing, ["gone"])
        XCTAssertNotEqual(decoded.catalogFetchedAt, decoded.fetchedAt)
    }
}
