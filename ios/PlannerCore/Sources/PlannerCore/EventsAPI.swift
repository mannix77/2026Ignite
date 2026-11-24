import Foundation

/// Sends one HTTP request. The app uses URLSession; tests use a script of canned answers.
public protocol HTTPTransport: Sendable {
    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse)
}

/// Hands out the attendee's access token, renewing it when asked.
public protocol AccessTokenSource: Sendable {
    func accessToken(forceRefresh: Bool) async throws -> String
}

public enum APIError: Error, Equatable {
    /// The saved sign-in is no longer good: the attendee has to sign in again.
    case signInNeeded
    /// Signed in, but not registered for this event.
    case notRegistered
    /// Refused before reaching the API (403 with no body). Slow down and try later.
    case refused
    case notFound
    /// The operation is closed for now (for example reservations have not opened).
    case closed
    /// Still rate limited after waiting as told.
    case busy
    case server(Int)
    case badResponse
    /// Fewer (or more) sessions arrived than the site said the catalog holds.
    case catalogIncomplete(expected: Int, got: Int)
    /// The site changed its mind about the catalog size part way through.
    case catalogChanged
    /// More than half the records were unusable.
    case catalogMostlyJunk(skipped: Int, total: Int)
    /// More than half the entries in a schedule answer were unusable.
    case scheduleMostlyJunk(skipped: Int, total: Int)
    /// The new catalog is less than half the size of the one already held.
    case catalogShrank(previous: Int, got: Int)
    /// A change was sent but its answer never arrived. Read the schedule; do not send it again.
    case outcomeUnknown
    /// The site answered a change without saying whether this session was done or refused.
    case unconfirmed
}

/// Everything the app needs from a conference: the real API, or the sample conference.
public protocol PlanBackend: Sendable {
    func loadCatalog() async throws -> Catalog
    func loadSchedule() async throws -> Schedule
    func reserve(_ sessionIds: [String]) async throws -> BulkResult
    func cancelReservation(_ sessionId: String) async throws
    func favorite(_ sessionIds: [String]) async throws -> BulkResult
    func unfavorite(_ sessionId: String) async throws
}

/// Client for the AWS Events API (https://api.awsevents.com/v1).
public struct EventsAPI: PlanBackend {
    public static let defaultBaseURL = URL(string: "https://api.awsevents.com/v1")!
    /// The API takes at most this many sessions in one reserve or favorite request.
    public static let bulkLimit = 10
    static let maxThrottleWaits = 3
    static let maxReadRetries = 2
    static let maxPages = 400

    let baseURL: URL
    let eventID: String
    let transport: HTTPTransport
    let tokens: AccessTokenSource
    let sleep: @Sendable (TimeInterval) async throws -> Void

    public init(baseURL: URL = EventsAPI.defaultBaseURL, eventID: String, transport: HTTPTransport,
                tokens: AccessTokenSource,
                sleep: @escaping @Sendable (TimeInterval) async throws -> Void = { seconds in
                    try await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
                }) {
        self.baseURL = baseURL
        self.eventID = eventID
        self.transport = transport
        self.tokens = tokens
        self.sleep = sleep
    }

    // MARK: Reads

    /// Walks every page of the catalog. Refuses a walk that does not add up to the size the
    /// site gave on the first page, so a cut-short answer never passes for the catalog.
    public func loadCatalog() async throws -> Catalog {
        var sessions: [Session] = []
        var seenIDs = Set<String>()
        var seenTokens = Set<String>()
        var skipped = 0
        var expected: Int?
        var nextToken: String?
        var pages = 0
        repeat {
            var query: [URLQueryItem] = []
            if let nextToken { query.append(URLQueryItem(name: "nextToken", value: nextToken)) }
            let data = try await perform("GET", ["events", eventID, "sessions"], query: query, isWrite: false)
            guard let page = try? JSONDecoder().decode(SessionsPage.self, from: data) else { throw APIError.badResponse }
            if let expected {
                // The size is fixed by the first page. A later page that disagrees is refused.
                guard page.totalCount == expected else { throw APIError.catalogChanged }
            } else {
                expected = page.totalCount
            }
            for session in page.items where seenIDs.insert(session.sessionId).inserted {
                sessions.append(session)
            }
            skipped += page.skipped
            nextToken = page.nextToken
            if let nextToken {
                guard seenTokens.insert(nextToken).inserted else { throw APIError.badResponse }
            }
            pages += 1
            guard pages <= EventsAPI.maxPages else { throw APIError.badResponse }
        } while nextToken != nil

        let total = expected ?? 0
        let got = sessions.count + skipped
        guard got == total else { throw APIError.catalogIncomplete(expected: total, got: got) }
        guard skipped * 2 <= total else { throw APIError.catalogMostlyJunk(skipped: skipped, total: total) }
        return Catalog(sessions: sessions, skipped: skipped)
    }

    public func loadSchedule() async throws -> Schedule {
        let data = try await perform("GET", ["events", eventID, "schedule"], isWrite: false)
        guard let envelope = try? JSONDecoder().decode(ScheduleEnvelope.self, from: data) else {
            throw APIError.badResponse
        }
        // Counted from the answer's own entries, as the catalog is: an answer that is mostly
        // unusable is refused, so it never stands for "nothing reserved" and the last good
        // calendar (and the Calendar copy made from it) is kept.
        var schedule = envelope.schedule
        let raw = ((try? JSONSerialization.jsonObject(with: data)) as? [String: Any])?["schedule"] as? [String: Any]
        let total = ["reserved", "favorites", "invitedSessions", "personalTime"]
            .reduce(0) { $0 + ((raw?[$1] as? [Any])?.count ?? 0) }
        let kept = schedule.reserved.count + schedule.favorites.count + schedule.invitedSessions.count
            + schedule.personalTime.count
        let dropped = max(0, total - kept)
        guard dropped * 2 <= total else { throw APIError.scheduleMostlyJunk(skipped: dropped, total: total) }
        schedule.skipped = dropped
        return schedule
    }

    // MARK: Writes

    public func reserve(_ sessionIds: [String]) async throws -> BulkResult {
        try await bulk(["events", eventID, "reservations"], sessionIds)
    }

    public func favorite(_ sessionIds: [String]) async throws -> BulkResult {
        try await bulk(["events", eventID, "favorites"], sessionIds)
    }

    /// Cancelling a reservation that is already gone counts as cancelled.
    public func cancelReservation(_ sessionId: String) async throws {
        try await remove(["events", eventID, "reservations", sessionId])
    }

    /// Removing a favorite that is already gone counts as removed.
    public func unfavorite(_ sessionId: String) async throws {
        try await remove(["events", eventID, "favorites", sessionId])
    }

    private func bulk(_ path: [String], _ sessionIds: [String]) async throws -> BulkResult {
        var ids: [String] = []
        for id in sessionIds.compactMap(Identifier.clean) where !ids.contains(id) { ids.append(id) }
        var merged = BulkResult()
        var start = 0
        while start < ids.count {
            let chunk = Array(ids[start..<min(start + EventsAPI.bulkLimit, ids.count)])
            start += chunk.count
            let body = try JSONEncoder().encode(["sessionIds": chunk])
            let data = try await perform("POST", path, body: body, isWrite: true)
            // The request was accepted; an answer that cannot be read leaves the outcome unknown.
            guard let envelope = try? JSONDecoder().decode(BulkEnvelope.self, from: data) else {
                throw APIError.outcomeUnknown
            }
            merged.successful += envelope.result.successful
            merged.failed += envelope.result.failed
        }
        return merged
    }

    private func remove(_ path: [String]) async throws {
        do {
            _ = try await perform("DELETE", path, isWrite: true)
        } catch APIError.notFound {
            return
        } catch APIError.outcomeUnknown {
            // A removal is safe to repeat: if the first one landed, the retry answers 404.
            do { _ = try await perform("DELETE", path, isWrite: true) } catch APIError.notFound { return }
        }
    }

    // MARK: One request

    private func perform(_ method: String, _ path: [String], query: [URLQueryItem] = [], body: Data? = nil,
                         isWrite: Bool) async throws -> Data {
        var url = baseURL
        for part in path { url.appendPathComponent(part) }
        if !query.isEmpty {
            var parts = URLComponents(url: url, resolvingAgainstBaseURL: false)!
            parts.queryItems = query
            url = parts.url!
        }
        var refreshed = false
        var throttleWaits = 0
        var readRetries = 0
        var token = try await tokens.accessToken(forceRefresh: false)

        while true {
            try Task.checkCancellation()
            var request = URLRequest(url: url, timeoutInterval: 30)
            request.httpMethod = method
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
            request.setValue("application/json", forHTTPHeaderField: "Accept")
            if let body {
                request.httpBody = body
                request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            }

            let data: Data
            let response: HTTPURLResponse
            do {
                (data, response) = try await transport.send(request)
            } catch is CancellationError {
                throw CancellationError()
            } catch {
                if isWrite { throw APIError.outcomeUnknown }
                guard readRetries < EventsAPI.maxReadRetries else { throw error }
                readRetries += 1
                try await sleep(TimeInterval(readRetries))
                continue
            }

            switch response.statusCode {
            case 200..<300:
                return data
            case 401:
                // Refresh once, then retry. A second 401 means the saved sign-in is no longer good.
                guard !refreshed else { throw APIError.signInNeeded }
                refreshed = true
                token = try await tokens.accessToken(forceRefresh: true)
            case 403:
                throw data.isEmpty ? APIError.refused : APIError.notRegistered
            case 404:
                throw APIError.notFound
            case 409:
                throw APIError.closed
            case 429:
                // Nothing was performed, so waiting and retrying is safe for a write too.
                guard throttleWaits < EventsAPI.maxThrottleWaits else { throw APIError.busy }
                throttleWaits += 1
                try await sleep(EventsAPI.retryAfter(response))
            case 500..<600:
                if isWrite { throw APIError.outcomeUnknown }
                guard readRetries < EventsAPI.maxReadRetries else { throw APIError.server(response.statusCode) }
                readRetries += 1
                try await sleep(TimeInterval(readRetries))
            default:
                throw APIError.server(response.statusCode)
            }
        }
    }

    /// Seconds to wait from `Retry-After`: 2 when absent or unreadable, never more than 60.
    static func retryAfter(_ response: HTTPURLResponse) -> TimeInterval {
        guard let text = response.value(forHTTPHeaderField: "Retry-After"),
              let seconds = Double(text.trimmingCharacters(in: .whitespaces)), seconds.isFinite, seconds > 0 else {
            return 2
        }
        return min(seconds, 60)
    }
}
