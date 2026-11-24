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

    func loadCatalog() async throws -> Catalog { count("catalog"); return try catalogAnswer.get() }
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
