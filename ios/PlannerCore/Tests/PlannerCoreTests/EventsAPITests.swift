import XCTest
@testable import PlannerCore

final class EventsAPITests: XCTestCase {
    private func assertThrows<T>(_ expected: APIError, file: StaticString = #filePath, line: UInt = #line,
                                 _ body: () async throws -> T) async {
        do {
            _ = try await body()
            XCTFail("expected \(expected), but nothing was thrown", file: file, line: line)
        } catch {
            XCTAssertEqual(error as? APIError, expected, file: file, line: line)
        }
    }

    // MARK: Catalog

    func testCatalogIsWalkedPageByPage() async throws {
        let (api, transport, _, _) = makeAPI([
            .respond(status: 200, body: pageJSON(ids: ["a", "b"], total: 3, nextToken: "tok 1")),
            .respond(status: 200, body: pageJSON(ids: ["c"], total: 3)),
        ])
        let catalog = try await api.loadCatalog()
        XCTAssertEqual(catalog.sessions.map(\.sessionId), ["a", "b", "c"])
        XCTAssertEqual(catalog.skipped, 0)
        XCTAssertEqual(transport.sent.map { $0.url?.absoluteString }, [
            "https://api.awsevents.com/v1/events/reinvent2026/sessions",
            "https://api.awsevents.com/v1/events/reinvent2026/sessions?nextToken=tok%201",
        ])
        XCTAssertEqual(transport.sent.map { $0.httpMethod }, ["GET", "GET"])
        XCTAssertEqual(transport.sent.map { $0.value(forHTTPHeaderField: "Authorization") }, ["Bearer T1", "Bearer T1"])
    }

    func testCatalogCutShortIsRefused() async {
        let ids = (1...250).map { "s\($0)" }
        let (api, _, _, _) = makeAPI([.respond(status: 200, body: pageJSON(ids: ids, total: 2849))])
        await assertThrows(.catalogIncomplete(expected: 2849, got: 250)) { try await api.loadCatalog() }
    }

    func testCatalogThatChangesSizePartWayIsRefused() async {
        let (api, _, _, _) = makeAPI([
            .respond(status: 200, body: pageJSON(ids: ["a", "b"], total: 3, nextToken: "t1")),
            .respond(status: 200, body: pageJSON(ids: ["c"], total: 1)),
        ])
        await assertThrows(.catalogChanged) { try await api.loadCatalog() }
    }

    func testAFewGarbledSessionsAreSkippedAndCounted() async throws {
        let ids = (1...19).map { "s\($0)" }
        let (api, _, _, _) = makeAPI([.respond(status: 200, body: pageJSON(ids: ids, junk: 1, total: 20))])
        let catalog = try await api.loadCatalog()
        XCTAssertEqual(catalog.sessions.map(\.sessionId), ids)
        XCTAssertEqual(catalog.skipped, 1)
    }

    func testHalfJunkIsAcceptedAndMoreThanHalfIsRefused() async throws {
        let ten = (1...10).map { "s\($0)" }
        let (half, _, _, _) = makeAPI([.respond(status: 200, body: pageJSON(ids: ten, junk: 10, total: 20))])
        let catalog = try await half.loadCatalog()
        XCTAssertEqual(catalog.sessions.count, 10)
        XCTAssertEqual(catalog.skipped, 10)

        let nine = (1...9).map { "s\($0)" }
        let (mostly, _, _, _) = makeAPI([.respond(status: 200, body: pageJSON(ids: nine, junk: 11, total: 20))])
        await assertThrows(.catalogMostlyJunk(skipped: 11, total: 20)) { try await mostly.loadCatalog() }
    }

    func testARepeatedPageTokenIsRefused() async {
        let (api, transport, _, _) = makeAPI([
            .respond(status: 200, body: pageJSON(ids: ["a"], total: 3, nextToken: "t1")),
            .respond(status: 200, body: pageJSON(ids: ["b"], total: 3, nextToken: "t1")),
            .respond(status: 200, body: pageJSON(ids: ["c"], total: 3)),
        ])
        await assertThrows(.badResponse) { try await api.loadCatalog() }
        XCTAssertEqual(transport.sent.count, 2)
    }

    func testACatalogSizeThatIsNotACountIsRefusedNotFatal() async {
        for total in ["1e30", "-1", "2.5"] {
            let (api, _, _, _) = makeAPI([.respond(status: 200, body: #"{"items":[],"totalCount":\#(total)}"#)])
            await assertThrows(.badResponse) { try await api.loadCatalog() }
        }
        let (empty, _, _, _) = makeAPI([.respond(status: 200, body: #"{"items":[],"totalCount":0}"#)])
        let catalog = try? await empty.loadCatalog()
        XCTAssertEqual(catalog, Catalog(sessions: [], skipped: 0))
    }

    func testAnAnswerThatIsNotACatalogIsRefused() async {
        let (api, _, _, _) = makeAPI([.respond(status: 200, body: "<html>edge error</html>")])
        await assertThrows(.badResponse) { try await api.loadCatalog() }
    }

    // MARK: Waiting and retrying

    func testToldToSlowDownItWaitsAsLongAsToldThenCarriesOn() async throws {
        let (api, transport, _, sleeps) = makeAPI([
            .respond(status: 429, headers: ["Retry-After": "2"]),
            .respond(status: 200, body: #"{"schedule":{"reserved":["r1"],"favorites":[],"personalTime":[]}}"#),
        ])
        let schedule = try await api.loadSchedule()
        XCTAssertEqual(schedule.reserved, ["r1"])
        XCTAssertEqual(sleeps.all, [2])
        XCTAssertEqual(transport.sent.count, 2)
    }

    func testStillBusyAfterThreeWaitsGivesUp() async {
        let busy = ScriptedTransport.Step.respond(status: 429, headers: ["Retry-After": "1"])
        let (api, transport, _, sleeps) = makeAPI([busy, busy, busy, busy, .respond(status: 200, body: "{}")])
        await assertThrows(.busy) { try await api.loadSchedule() }
        XCTAssertEqual(sleeps.all, [1, 1, 1])
        XCTAssertEqual(transport.sent.count, 4)
    }

    func testRetryAfterIsBoundedAndHasADefault() {
        func wait(_ headers: [String: String]) -> TimeInterval {
            EventsAPI.retryAfter(HTTPURLResponse(url: URL(string: "https://api.awsevents.com")!, statusCode: 429,
                                                 httpVersion: nil, headerFields: headers)!)
        }
        XCTAssertEqual(wait(["Retry-After": "60"]), 60)
        XCTAssertEqual(wait(["Retry-After": "61"]), 60)
        XCTAssertEqual(wait(["Retry-After": "7"]), 7)
        XCTAssertEqual(wait([:]), 2)
        XCTAssertEqual(wait(["Retry-After": "soon"]), 2)
        XCTAssertEqual(wait(["Retry-After": "0"]), 2)
    }

    func testAnExpiredPassIsRenewedOnceAndTheRequestRetried() async throws {
        let (api, transport, tokens, _) = makeAPI([
            .respond(status: 401),
            .respond(status: 200, body: #"{"schedule":{"reserved":[],"favorites":["f1"],"personalTime":[]}}"#),
        ])
        let schedule = try await api.loadSchedule()
        XCTAssertEqual(schedule.favorites, ["f1"])
        XCTAssertEqual(tokens.forceRefreshAsks, [false, true])
        XCTAssertEqual(transport.sent.map { $0.value(forHTTPHeaderField: "Authorization") }, ["Bearer T1", "Bearer T2"])
    }

    func testASavedSignInRejectedTwiceAsksForSignIn() async {
        let (api, transport, tokens, _) = makeAPI([.respond(status: 401), .respond(status: 401), .respond(status: 200)])
        await assertThrows(.signInNeeded) { try await api.loadSchedule() }
        XCTAssertEqual(tokens.forceRefreshAsks, [false, true])
        XCTAssertEqual(transport.sent.count, 2)
    }

    func testForbiddenIsToldApartByItsBody() async {
        let (unregistered, _, _, _) = makeAPI([.respond(status: 403, body: #"{"message":"Not registered"}"#)])
        await assertThrows(.notRegistered) { try await unregistered.loadSchedule() }
        let (edge, _, _, _) = makeAPI([.respond(status: 403)])
        await assertThrows(.refused) { try await edge.loadSchedule() }
    }

    func testAReadIsRetriedAfterAServerError() async throws {
        let (api, transport, _, sleeps) = makeAPI([
            .respond(status: 503),
            .fail,
            .respond(status: 200, body: #"{"schedule":{"reserved":["r1"],"favorites":[],"personalTime":[]}}"#),
        ])
        let schedule = try await api.loadSchedule()
        XCTAssertEqual(schedule.reserved, ["r1"])
        XCTAssertEqual(sleeps.all, [1, 2])
        XCTAssertEqual(transport.sent.count, 3)
    }

    func testAReadGivesUpAfterTwoRetries() async {
        let (api, transport, _, _) = makeAPI([
            .respond(status: 500), .respond(status: 500), .respond(status: 500), .respond(status: 200),
        ])
        await assertThrows(.server(500)) { try await api.loadSchedule() }
        XCTAssertEqual(transport.sent.count, 3)
    }

    func testAScheduleWithoutItsListsIsRefused() async {
        let (api, _, _, _) = makeAPI([.respond(status: 200, body: #"{"schedule":{"favorites":[]}}"#)])
        await assertThrows(.badResponse) { try await api.loadSchedule() }
    }

    // MARK: Changes

    func testReserveSendsTheIdsAndReportsAClash() async throws {
        let (api, transport, _, _) = makeAPI([.respond(status: 200, body: """
            {"result":{"successful":[],"failed":[{"sessionId":"pex","code":"scheduleConflict","conflictsWith":["aim"]}]}}
            """)])
        let result = try await api.reserve(["pex"])
        XCTAssertEqual(result, BulkResult(successful: [], failed: [
            BulkFailure(sessionId: "pex", code: "scheduleConflict", conflictsWith: ["aim"]),
        ]))
        let request = try XCTUnwrap(transport.sent.first)
        XCTAssertEqual(transport.sent.count, 1)
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.url?.absoluteString, "https://api.awsevents.com/v1/events/reinvent2026/reservations")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Content-Type"), "application/json")
        XCTAssertEqual(String(decoding: try XCTUnwrap(request.httpBody), as: UTF8.self), #"{"sessionIds":["pex"]}"#)
    }

    func testFavoriteGoesToTheFavoritesRoute() async throws {
        let (api, transport, _, _) = makeAPI([.respond(status: 200, body: #"{"result":{"successful":["a"],"failed":[]}}"#)])
        let result = try await api.favorite(["a"])
        XCTAssertEqual(result, BulkResult(successful: ["a"], failed: []))
        XCTAssertEqual(transport.sent.map { $0.url?.absoluteString },
                       ["https://api.awsevents.com/v1/events/reinvent2026/favorites"])
        XCTAssertEqual(transport.sent.map { $0.httpMethod }, ["POST"])
    }

    func testMoreThanTenIdsGoInSeparateRequestsAndTheAnswersAreJoined() async throws {
        let ids = (1...12).map { "s\($0)" }
        let (api, transport, _, _) = makeAPI([
            .respond(status: 200, body: #"{"result":{"successful":["s1"],"failed":[]}}"#),
            .respond(status: 200, body: #"{"result":{"successful":[],"failed":[{"sessionId":"s12","code":"sessionFull"}]}}"#),
        ])
        let result = try await api.reserve(ids + ["s1", "  "])
        XCTAssertEqual(result, BulkResult(successful: ["s1"], failed: [BulkFailure(sessionId: "s12", code: "sessionFull")]))
        let bodies = try transport.sent.map { String(decoding: try XCTUnwrap($0.httpBody), as: UTF8.self) }
        XCTAssertEqual(bodies, [
            #"{"sessionIds":["s1","s2","s3","s4","s5","s6","s7","s8","s9","s10"]}"#,
            #"{"sessionIds":["s11","s12"]}"#,
        ])
    }

    func testAChangeWhoseAnswerNeverArrivedIsNotSentAgain() async {
        let (dropped, droppedTransport, _, _) = makeAPI([.fail, .respond(status: 200)])
        await assertThrows(.outcomeUnknown) { try await dropped.reserve(["a"]) }
        XCTAssertEqual(droppedTransport.sent.count, 1)

        let (failed, failedTransport, _, _) = makeAPI([.respond(status: 500), .respond(status: 200)])
        await assertThrows(.outcomeUnknown) { try await failed.reserve(["a"]) }
        XCTAssertEqual(failedTransport.sent.count, 1)

        let (garbled, garbledTransport, _, _) = makeAPI([.respond(status: 200, body: "<html>"), .respond(status: 200)])
        await assertThrows(.outcomeUnknown) { try await garbled.favorite(["a"]) }
        XCTAssertEqual(garbledTransport.sent.count, 1)
    }

    func testAChangeWaitsWhenToldToSlowDown() async throws {
        let (api, transport, _, sleeps) = makeAPI([
            .respond(status: 429, headers: ["Retry-After": "3"]),
            .respond(status: 200, body: #"{"result":{"successful":["a"],"failed":[]}}"#),
        ])
        let result = try await api.reserve(["a"])
        XCTAssertEqual(result.successful, ["a"])
        XCTAssertEqual(sleeps.all, [3])
        XCTAssertEqual(transport.sent.count, 2)
    }

    func testCancellingSendsADelete() async throws {
        let (api, transport, _, _) = makeAPI([.respond(status: 204)])
        try await api.cancelReservation("abc")
        XCTAssertEqual(transport.sent.map { $0.httpMethod }, ["DELETE"])
        XCTAssertEqual(transport.sent.map { $0.url?.absoluteString },
                       ["https://api.awsevents.com/v1/events/reinvent2026/reservations/abc"])
    }

    func testCancellingWhatIsAlreadyGoneCountsAsCancelled() async throws {
        let (api, transport, _, _) = makeAPI([.respond(status: 404)])
        try await api.cancelReservation("abc")
        XCTAssertEqual(transport.sent.count, 1)

        let (favorites, favoritesTransport, _, _) = makeAPI([.respond(status: 404)])
        try await favorites.unfavorite("abc")
        XCTAssertEqual(favoritesTransport.sent.map { $0.url?.absoluteString },
                       ["https://api.awsevents.com/v1/events/reinvent2026/favorites/abc"])
    }

    func testACancelWhoseAnswerNeverArrivedIsRepeatedOnce() async throws {
        let (api, transport, _, _) = makeAPI([.fail, .respond(status: 404)])
        try await api.cancelReservation("abc")
        XCTAssertEqual(transport.sent.count, 2)

        let (stuck, stuckTransport, _, _) = makeAPI([.fail, .fail, .respond(status: 204)])
        await assertThrows(.outcomeUnknown) { try await stuck.cancelReservation("abc") }
        XCTAssertEqual(stuckTransport.sent.count, 2)
    }

    func testAClosedOperationIsReported() async {
        let (api, _, _, _) = makeAPI([.respond(status: 409, body: #"{"message":"closed"}"#)])
        await assertThrows(.closed) { try await api.cancelReservation("abc") }
        let (reserve, _, _, _) = makeAPI([.respond(status: 409, body: #"{"message":"closed"}"#)])
        await assertThrows(.closed) { try await reserve.reserve(["a"]) }
    }
}
