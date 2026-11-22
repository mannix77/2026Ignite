import Foundation
import Network
import PlannerCore

enum SignInError: Error {
    /// None of the six ports the sign-in service accepts could be opened on this phone.
    case noPortFree
    case cancelled
    case denied(String)
    case tokenExchangeFailed
}

/// Resumes a continuation exactly once, whichever of several events arrives first.
final class OneShot<Value>: @unchecked Sendable {
    private let lock = NSLock()
    private var continuation: CheckedContinuation<Value, Never>?
    private var early: Value?

    func wait() async -> Value {
        await withCheckedContinuation { continuation in
            lock.lock()
            if let early {
                lock.unlock()
                continuation.resume(returning: early)
            } else {
                self.continuation = continuation
                lock.unlock()
            }
        }
    }

    func finish(_ value: Value) {
        lock.lock()
        if let continuation {
            self.continuation = nil
            lock.unlock()
            continuation.resume(returning: value)
        } else {
            if early == nil { early = value }
            lock.unlock()
        }
    }
}

/// Listens on this phone's loopback address for the browser's return from sign-in. The sign-in
/// service only redirects to http://localhost:8484–8489/callback, so the app answers there itself.
/// `start`, `ensureAnswering` and `stop` are called from the main actor only.
final class LoopbackListener: @unchecked Sendable {
    private let queue = DispatchQueue(label: "sessionplanner.signin.loopback")
    private var listener: NWListener?
    private var expectedState = ""
    private var onCallback: @Sendable (CallbackResult) -> Void = { _ in }
    private var stopped = false
    private(set) var port: UInt16 = 0

    /// Opens the first free port in `ports`. `onCallback` is called for each request to
    /// `/callback` that ends the sign-in (a code or an error from the sign-in service).
    func start(ports: ClosedRange<UInt16>, expectedState: String,
               onCallback: @escaping @Sendable (CallbackResult) -> Void) async throws {
        self.expectedState = expectedState
        self.onCallback = onCallback
        for candidate in ports {
            if let opened = await open(candidate) {
                listener = opened
                port = candidate
                return
            }
        }
        throw SignInError.noPortFree
    }

    /// Checks that the listener still answers and reopens it on the same port if not. iOS can
    /// take the socket away while the app is suspended, for example while the attendee is in
    /// Mail fetching a verification code; the redirect must land on the same port, so only
    /// that port is tried.
    func ensureAnswering() async {
        guard port != 0, !stopped else { return }
        if await isAnswering() { return }
        listener?.cancel()
        listener = nil
        for _ in 0..<10 {
            if let opened = await open(port) {
                if stopped { opened.cancel() } else { listener = opened }
                return
            }
            try? await Task.sleep(nanoseconds: 200_000_000)
            if stopped { return }
        }
    }

    func stop() {
        stopped = true
        listener?.cancel()
        listener = nil
    }

    /// True when a request to the listener's own port gets an answer within two seconds.
    func isAnswering() async -> Bool {
        guard let endpointPort = NWEndpoint.Port(rawValue: port), port != 0 else { return false }
        let answered = OneShot<Bool>()
        let connection = NWConnection(host: "127.0.0.1", port: endpointPort, using: .tcp)
        connection.stateUpdateHandler = { state in
            switch state {
            case .ready:
                connection.send(content: Data("GET /ping HTTP/1.1\r\n\r\n".utf8), completion: .contentProcessed { _ in })
                connection.receive(minimumIncompleteLength: 1, maximumLength: 1024) { data, _, _, _ in
                    answered.finish(!(data ?? Data()).isEmpty)
                }
            case .failed, .cancelled, .waiting:
                answered.finish(false)
            default:
                break
            }
        }
        connection.start(queue: queue)
        queue.asyncAfter(deadline: .now() + 2) { answered.finish(false) }
        let result = await answered.wait()
        connection.cancel()
        return result
    }

    private func open(_ candidate: UInt16) async -> NWListener? {
        guard let endpointPort = NWEndpoint.Port(rawValue: candidate) else { return nil }
        let parameters = NWParameters.tcp
        parameters.requiredInterfaceType = .loopback
        parameters.allowLocalEndpointReuse = true
        guard let listener = try? NWListener(using: parameters, on: endpointPort) else { return nil }
        let ready = OneShot<Bool>()
        listener.stateUpdateHandler = { state in
            switch state {
            case .ready: ready.finish(true)
            case .failed, .cancelled, .waiting: ready.finish(false)
            default: break
            }
        }
        let expectedState = self.expectedState
        let onCallback = self.onCallback
        listener.newConnectionHandler = { [queue] connection in
            connection.start(queue: queue)
            LoopbackListener.readRequestLine(connection, buffer: Data()) { requestLine in
                LoopbackListener.answer(connection, requestLine: requestLine, expectedState: expectedState,
                                        onCallback: onCallback)
            }
        }
        listener.start(queue: queue)
        if await ready.wait() { return listener }
        listener.cancel()
        return nil
    }

    /// Reads until the end of the request's first line, however many pieces it arrives in.
    private static func readRequestLine(_ connection: NWConnection, buffer: Data,
                                        done: @escaping @Sendable (String) -> Void) {
        let limit = 16 * 1024
        connection.receive(minimumIncompleteLength: 1, maximumLength: limit) { data, _, isComplete, error in
            var buffer = buffer
            if let data { buffer.append(data) }
            if let end = buffer.range(of: Data("\r\n".utf8)) {
                done(String(decoding: buffer[buffer.startIndex..<end.lowerBound], as: UTF8.self))
            } else if isComplete || error != nil || buffer.count >= limit {
                // No complete line will come: an unfinished line is not a callback.
                done("")
            } else {
                readRequestLine(connection, buffer: buffer, done: done)
            }
        }
    }

    private static func answer(_ connection: NWConnection, requestLine: String, expectedState: String,
                               onCallback: @escaping @Sendable (CallbackResult) -> Void) {
        let result = OAuthFlow.parseCallback(requestLine: requestLine, expectedState: expectedState)
        let status: String
        let message: String
        switch result {
        case .code:
            (status, message) = ("200 OK", "You are signed in. Return to Session Planner.")
        case .denied:
            (status, message) = ("400 Bad Request", "Sign-in did not complete. Return to Session Planner and try again.")
        case .stateMismatch:
            (status, message) = ("400 Bad Request", "This sign-in answer was not expected and was ignored.")
        case .notCallback:
            (status, message) = ("404 Not Found", "Not found.")
        }
        let body = "<!doctype html><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width\">"
            + "<body style=\"font:17px -apple-system;padding:2em\">\(message)</body>"
        let response = "HTTP/1.1 \(status)\r\nContent-Type: text/html; charset=utf-8\r\n"
            + "Content-Length: \(body.utf8.count)\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n\(body)"
        connection.send(content: Data(response.utf8), completion: .contentProcessed { _ in connection.cancel() })
        // An answer for some other sign-in is refused and the wait goes on.
        switch result {
        case .code, .denied: onCallback(result)
        case .stateMismatch, .notCallback: break
        }
    }
}
