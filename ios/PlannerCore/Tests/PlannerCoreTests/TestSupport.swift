import XCTest
import Foundation
@testable import PlannerCore

/// Answers requests from a fixed script and records what was sent.
final class ScriptedTransport: HTTPTransport, @unchecked Sendable {
    enum Step {
        case respond(status: Int, body: String = "", headers: [String: String] = [:])
        case fail
    }

    struct Dropped: Error {}

    private let lock = NSLock()
    private var steps: [Step]
    private(set) var requests: [URLRequest] = []

    init(_ steps: [Step]) { self.steps = steps }

    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let step: Step = lock.withLock {
            requests.append(request)
            return steps.isEmpty ? .respond(status: 599, body: "script ran out") : steps.removeFirst()
        }
        switch step {
        case .fail:
            throw Dropped()
        case let .respond(status, body, headers):
            let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: "HTTP/1.1",
                                           headerFields: headers)!
            return (Data(body.utf8), response)
        }
    }

    var sent: [URLRequest] { lock.withLock { requests } }
}

/// Hands out "T1", then "T2" after a forced refresh, and records each ask.
final class FakeTokens: AccessTokenSource, @unchecked Sendable {
    private let lock = NSLock()
    private var asks: [Bool] = []
    private var current = 1

    func accessToken(forceRefresh: Bool) async throws -> String {
        lock.withLock {
            asks.append(forceRefresh)
            if forceRefresh { current += 1 }
            return "T\(current)"
        }
    }

    var forceRefreshAsks: [Bool] { lock.withLock { asks } }
}

/// Records how long the code asked to wait, without waiting.
final class SleepLog: @unchecked Sendable {
    private let lock = NSLock()
    private var waits: [TimeInterval] = []

    func sleep(_ seconds: TimeInterval) async throws { lock.withLock { waits.append(seconds) } }

    var all: [TimeInterval] { lock.withLock { waits } }
}

func makeAPI(_ steps: [ScriptedTransport.Step]) -> (EventsAPI, ScriptedTransport, FakeTokens, SleepLog) {
    let transport = ScriptedTransport(steps)
    let tokens = FakeTokens()
    let sleeps = SleepLog()
    let api = EventsAPI(eventID: "reinvent2026", transport: transport, tokens: tokens,
                        sleep: { try await sleeps.sleep($0) })
    return (api, transport, tokens, sleeps)
}

/// A page of `ListSessions` as JSON. `junk` records have no id.
func pageJSON(ids: [String], junk: Int = 0, total: Int, nextToken: String? = nil) -> String {
    var items = ids.map { #"{"sessionId":"\#($0)","title":"Session \#($0)"}"# }
    items += Array(repeating: #"{"title":"No id here"}"#, count: junk)
    let token = nextToken.map { #","nextToken":"\#($0)""# } ?? ""
    return #"{"items":[\#(items.joined(separator: ","))],"totalCount":\#(total)\#(token)}"#
}

func session(_ id: String, code: String? = nil, date: String = "2026-12-02", time: String = "10:00",
             length: String = "60", venue: String? = "MGM Grand", allDay: Bool = false) -> Session {
    Session(sessionId: id, title: "Title \(id)", abbreviation: code ?? id.uppercased(), venue: venue,
            isAllDaySession: allDay, sessionTime: SessionTime(date: date, time: time, length: length))
}

/// A backend with fixed answers, for `Sync.refresh`.
struct FixedBackend: PlanBackend {
    var catalog: Result<Catalog, APIError>
    var schedule: Result<Schedule, APIError>

    func loadCatalog() async throws -> Catalog { try catalog.get() }
    func loadSchedule() async throws -> Schedule { try schedule.get() }
    func reserve(_ sessionIds: [String]) async throws -> BulkResult { BulkResult() }
    func cancelReservation(_ sessionId: String) async throws {}
    func favorite(_ sessionIds: [String]) async throws -> BulkResult { BulkResult() }
    func unfavorite(_ sessionId: String) async throws {}
}

/// Answers from fixed values and counts what was asked of it, for `Sync.change`.
final class CountingBackend: PlanBackend, @unchecked Sendable {
    private let lock = NSLock()
    private var counts: [String: Int] = [:]
    var reserveAnswer: Result<BulkResult, APIError> = .success(BulkResult())
    var scheduleAnswer: Result<Schedule, APIError> = .success(Schedule())
    /// Answers for successive schedule reads, first to last; once used up, `scheduleAnswer`.
    var scheduleAnswers: [Result<Schedule, APIError>] = []
    var catalogAnswer: Result<Catalog, APIError> = .success(Catalog(sessions: []))

    private var order: [String] = []
    private func count(_ name: String) { lock.withLock { counts[name, default: 0] += 1; order.append(name) } }
    func calls(_ name: String) -> Int { lock.withLock { counts[name, default: 0] } }
    /// Every call, in the order it was made.
    var log: [String] { lock.withLock { order } }

    /// The catalog download is cancelled, as when he leaves the screen mid-download.
    var catalogCancelled = false
    func loadCatalog() async throws -> Catalog {
        count("catalog")
        if catalogCancelled { throw CancellationError() }
        return try catalogAnswer.get()
    }
    func loadSchedule() async throws -> Schedule {
        count("schedule")
        let next: Result<Schedule, APIError> = lock.withLock { scheduleAnswers.isEmpty ? scheduleAnswer : scheduleAnswers.removeFirst() }
        return try next.get()
    }
    func reserve(_ sessionIds: [String]) async throws -> BulkResult { count("reserve"); return try reserveAnswer.get() }
    func cancelReservation(_ sessionId: String) async throws { count("cancel") }
    func favorite(_ sessionIds: [String]) async throws -> BulkResult { count("favorite"); return BulkResult() }
    func unfavorite(_ sessionId: String) async throws { count("unfavorite") }
}

/// The re:Invent 2026 catalog as the app reads it, from `Fixtures/reinvent2026-catalog.json`:
/// real sessions, times and venues, no speakers, and placeholder abstracts at the real lengths
/// (built by `scripts/catalog_fixture.py`).
func realCatalog() throws -> [Session] {
    let url = try XCTUnwrap(Bundle.module.url(forResource: "reinvent2026-catalog", withExtension: "json",
                                              subdirectory: "Fixtures"))
    return try JSONDecoder().decode(SessionsPage.self, from: Data(contentsOf: url)).items
}

/// Each real abstract's length, by session id, as recorded in the fixture.
func realAbstractLengths() throws -> [String: Int] {
    let url = try XCTUnwrap(Bundle.module.url(forResource: "reinvent2026-catalog", withExtension: "json",
                                              subdirectory: "Fixtures"))
    let root = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
    let items = try XCTUnwrap(root["items"] as? [[String: Any]])
    return Dictionary(uniqueKeysWithValues: items.compactMap { item in
        (item["sessionId"] as? String).flatMap { id in (item["realAbstractLength"] as? Int).map { (id, $0) } }
    })
}

/// The timed sessions running at any point in the hour from `hour`:00 on `date`.
func runningInHour(_ sessions: [Session], date: String, hour: Int) -> [Session] {
    sessions.filter { session in
        guard session.isAllDaySession != true, let time = session.sessionTime, time.date == date,
              let start = time.startMinute else { return false }
        let end = start + max(time.lengthMinutes, 1)
        return start < (hour + 1) * 60 && end > hour * 60
    }
}

/// The on-device model's instructions, written out (rule 5): tests build expected prompts
/// from this, never from `ModelPrompt.instructions`, so a change to the wording fails them.
let modelInstructions = "You help an attendee at AWS re:Invent choose which of the sessions below to go to. "
    + "Rank them from most to least worth attending for them, using what the profile says about them, "
    + "and give each a short reason, said to them as \"you\". Use only the listed sessions by code."

/// A task's value, or nil after `seconds` (the test fails then and the task is cancelled), so
/// a test waiting on a task can't hang (rule 12).
func finished<T: Sendable>(_ task: Task<T, Never>, within seconds: TimeInterval = 10,
                        file: StaticString = #filePath, line: UInt = #line) async -> T? {
    let slot = TaskSlot<T>()
    let done = XCTestExpectation(description: "task finished")
    Task { slot.set(await task.value); done.fulfill() }
    guard await XCTWaiter().fulfillment(of: [done], timeout: seconds) == .completed, let value = slot.value else {
        task.cancel()
        XCTFail("the task didn't finish within \(seconds) seconds", file: file, line: line)
        return nil
    }
    return value
}

/// Holds one task's value across tasks, for `finished(_:within:)`.
final class TaskSlot<T: Sendable>: @unchecked Sendable {
    private let lock = NSLock()
    private var stored: T?
    func set(_ value: T) { lock.withLock { stored = value } }
    var value: T? { lock.withLock { stored } }
}
