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
final class LoopbackListener: @unchecked Sendable {
    private let queue = DispatchQueue(label: "sessionplanner.signin.loopback")
    private var listener: NWListener?
    private(set) var port: UInt16 = 0

    /// Opens the first free port in `ports`. `onCallback` is called for each request to
    /// `/callback` that ends the sign-in (a code or an error from the sign-in service).
    func start(ports: ClosedRange<UInt16>, expectedState: String,
               onCallback: @escaping @Sendable (CallbackResult) -> Void) async throws {
        for candidate in ports {
            guard let endpointPort = NWEndpoint.Port(rawValue: candidate) else { continue }
            let parameters = NWParameters.tcp
            parameters.requiredInterfaceType = .loopback
            parameters.allowLocalEndpointReuse = true
            guard let listener = try? NWListener(using: parameters, on: endpointPort) else { continue }
            let ready = OneShot<Bool>()
            listener.stateUpdateHandler = { state in
                switch state {
                case .ready: ready.finish(true)
                case .failed, .cancelled, .waiting: ready.finish(false)
                default: break
                }
            }
            listener.newConnectionHandler = { [queue] connection in
                connection.start(queue: queue)
                LoopbackListener.answer(connection, expectedState: expectedState, onCallback: onCallback)
            }
            listener.start(queue: queue)
            if await ready.wait() {
                self.listener = listener
                port = candidate
                return
            }
            listener.cancel()
        }
        throw SignInError.noPortFree
    }

    func stop() {
        listener?.cancel()
        listener = nil
    }

    private static func answer(_ connection: NWConnection, expectedState: String,
                               onCallback: @escaping @Sendable (CallbackResult) -> Void) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 16 * 1024) { data, _, _, _ in
            let text = data.map { String(decoding: $0, as: UTF8.self) } ?? ""
            let requestLine = text.components(separatedBy: "\r\n").first ?? ""
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
}
