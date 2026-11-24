import XCTest
@testable import PlannerCore

final class RefreshPlanTests: XCTestCase {
    // 2026-12-03T17:00:00Z, 09:00 in Las Vegas.
    private let now = Date(timeIntervalSince1970: 1_796_317_200)

    private func held(scheduleAge: TimeInterval = 0, catalogAge: TimeInterval = 0,
                      sessions: [Session] = [session("a"), session("b")],
                      favorites: [String] = ["a"]) -> PlanSnapshot {
        PlanSnapshot(sessions: sessions, schedule: Schedule(reserved: [], favorites: favorites),
                     fetchedAt: now.addingTimeInterval(-scheduleAge), skipped: 2,
                     catalogFetchedAt: now.addingTimeInterval(-catalogAge))
    }

    // MARK: When

    func testTheScheduleIsReadAgainFromFiveMinutes() {
        XCTAssertFalse(RefreshPlan.scheduleDue(held(scheduleAge: 299), now: now))
        XCTAssertTrue(RefreshPlan.scheduleDue(held(scheduleAge: 300), now: now))
        XCTAssertFalse(RefreshPlan.scheduleDue(held(scheduleAge: 0), now: now))
    }

    func testTheCatalogIsDownloadedAgainFromTwentyFourHours() {
        XCTAssertFalse(RefreshPlan.catalogDue(held(catalogAge: 86399), now: now))
        XCTAssertTrue(RefreshPlan.catalogDue(held(catalogAge: 86400), now: now))
    }

    func testAClockMovedBackMakesBothDue() {
        XCTAssertTrue(RefreshPlan.scheduleDue(held(scheduleAge: -1), now: now))
        XCTAssertTrue(RefreshPlan.catalogDue(held(catalogAge: -1), now: now))
    }

    func testNothingHeldMakesBothDue() {
        XCTAssertTrue(RefreshPlan.scheduleDue(nil, now: now))
        XCTAssertTrue(RefreshPlan.catalogDue(nil, now: now))
    }

    func testNoConnectionIsQuietButOtherProblemsAreShown() {
        XCTAssertFalse(RefreshPlan.shouldReport(URLError(.notConnectedToInternet)))
        XCTAssertFalse(RefreshPlan.shouldReport(URLError(.timedOut)))
        XCTAssertTrue(RefreshPlan.shouldReport(APIError.signInNeeded))
        XCTAssertTrue(RefreshPlan.shouldReport(APIError.busy))
    }

    // MARK: What is fetched

    func testWithinADayOnlyTheScheduleIsRead() async throws {
        let backend = CountingBackend()
        backend.scheduleAnswer = .success(Schedule(reserved: ["b"], favorites: ["a"]))
        let previous = held(scheduleAge: 600, catalogAge: 86399)
        let updated = try await Sync.update(backend: backend, previous: previous, now: now)
        XCTAssertEqual(backend.calls("catalog"), 0)
        XCTAssertEqual(backend.calls("schedule"), 1)
        XCTAssertEqual(updated, PlanSnapshot(sessions: [session("a"), session("b")],
                                             schedule: Schedule(reserved: ["b"], favorites: ["a"]),
                                             fetchedAt: now, skipped: 2,
                                             catalogFetchedAt: now.addingTimeInterval(-86399)))
    }

    func testADayOldCatalogIsDownloadedWithTheSchedule() async throws {
        let backend = CountingBackend()
        backend.catalogAnswer = .success(Catalog(sessions: [session("a"), session("b"), session("c")], skipped: 0))
        backend.scheduleAnswer = .success(Schedule(reserved: ["c"], favorites: []))
        let updated = try await Sync.update(backend: backend, previous: held(catalogAge: 86400), now: now)
        XCTAssertEqual(backend.calls("catalog"), 1)
        XCTAssertEqual(backend.calls("schedule"), 1)
        XCTAssertEqual(updated, PlanSnapshot(sessions: [session("a"), session("b"), session("c")],
                                             schedule: Schedule(reserved: ["c"], favorites: []),
                                             fetchedAt: now, skipped: 0, catalogFetchedAt: now))
    }

    func testAskingForEverythingDownloadsTheCatalogHoweverRecent() async throws {
        let backend = CountingBackend()
        backend.catalogAnswer = .success(Catalog(sessions: [session("a"), session("b")]))
        let updated = try await Sync.update(backend: backend, previous: held(catalogAge: 60), now: now, wholeCatalog: true)
        XCTAssertEqual(backend.calls("catalog"), 1)
        XCTAssertEqual(updated.catalogFetchedAt, now)
        XCTAssertEqual(updated.fetchedAt, now)
    }

    func testWithNothingHeldEverythingIsDownloaded() async throws {
        let backend = CountingBackend()
        backend.catalogAnswer = .success(Catalog(sessions: [session("a")]))
        backend.scheduleAnswer = .success(Schedule(reserved: ["a"], favorites: []))
        let updated = try await Sync.update(backend: backend, previous: nil, now: now)
        XCTAssertEqual(backend.calls("catalog"), 1)
        XCTAssertEqual(updated, PlanSnapshot(sessions: [session("a")], schedule: Schedule(reserved: ["a"], favorites: []),
                                             fetchedAt: now, catalogFetchedAt: now))
    }

    func testAnUnknownSessionDownloadsAnHourOldCatalog() async throws {
        let backend = CountingBackend()
        backend.catalogAnswer = .success(Catalog(sessions: [session("a"), session("b"), session("new")], skipped: 1))
        backend.scheduleAnswer = .success(Schedule(reserved: [], favorites: ["a", "new"]))
        let previous = held(catalogAge: 3600)
        XCTAssertEqual(previous.unresolvedIDs, [])
        XCTAssertEqual(previous.skipped, 2)
        let updated = try await Sync.update(backend: backend, previous: previous, now: now)
        XCTAssertEqual(backend.calls("catalog"), 1)
        XCTAssertEqual(updated.unresolvedIDs, [])
        XCTAssertEqual(updated, PlanSnapshot(sessions: [session("a"), session("b"), session("new")],
                                             schedule: Schedule(reserved: [], favorites: ["a", "new"]),
                                             fetchedAt: now, skipped: 1, catalogFetchedAt: now))
    }

    func testAnUnknownSessionWaitsForAnUnderAnHourOldCatalog() async throws {
        let backend = CountingBackend()
        backend.scheduleAnswer = .success(Schedule(reserved: [], favorites: ["a", "new"]))
        let previous = held(catalogAge: 3599)
        let updated = try await Sync.update(backend: backend, previous: previous, now: now)
        XCTAssertEqual(backend.calls("catalog"), 0)
        XCTAssertEqual(backend.calls("schedule"), 1)
        XCTAssertEqual(updated.unresolvedIDs, ["new"])
        XCTAssertEqual(updated.catalogFetchedAt, previous.catalogFetchedAt)
    }

    func testTheShrinkGuardStillAppliesToADueCatalog() async {
        let backend = CountingBackend()
        backend.catalogAnswer = .success(Catalog(sessions: []))
        let previous = held(catalogAge: 86400)
        XCTAssertEqual(previous.sessions.count, 2)
        do {
            _ = try await Sync.update(backend: backend, previous: previous, now: now)
            XCTFail("an empty catalog replaced one of 2")
        } catch {
            XCTAssertEqual(error as? APIError, .catalogShrank(previous: 2, got: 0))
        }
    }

    func testAFailedScheduleReadFailsTheUpdate() async {
        let backend = CountingBackend()
        backend.scheduleAnswer = .failure(.signInNeeded)
        do {
            _ = try await Sync.update(backend: backend, previous: held(scheduleAge: 600), now: now)
            XCTFail("an update without a schedule produced a snapshot")
        } catch {
            XCTAssertEqual(error as? APIError, .signInNeeded)
        }
        XCTAssertEqual(backend.calls("catalog"), 0)
    }

    // MARK: Saved by the earlier version

    func testACalendarSavedWithoutTheCatalogTimeTakesTheScheduleTime() throws {
        let json = #"{"sessions":[],"schedule":{"reserved":["a"],"favorites":[]},"fetchedAt":0,"skipped":0}"#
        let decoded = try JSONDecoder().decode(PlanSnapshot.self, from: Data(json.utf8))
        XCTAssertEqual(decoded.schedule.reserved, ["a"])
        XCTAssertEqual(decoded.fetchedAt, Date(timeIntervalSinceReferenceDate: 0))
        XCTAssertEqual(decoded.catalogFetchedAt, Date(timeIntervalSinceReferenceDate: 0))
    }

    func testTheCatalogTimeIsSavedAndReadBack() throws {
        let original = held(scheduleAge: 60, catalogAge: 7200)
        let decoded = try JSONDecoder().decode(PlanSnapshot.self, from: JSONEncoder().encode(original))
        XCTAssertEqual(decoded, original)
        XCTAssertNotEqual(decoded.catalogFetchedAt, decoded.fetchedAt)
    }
}
