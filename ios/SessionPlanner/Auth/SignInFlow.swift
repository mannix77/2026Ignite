import AuthenticationServices
import Foundation
import PlannerCore
import UIKit

/// Signs the attendee in with their AWS Builder ID: authorization code with PKCE, in the
/// system's sign-in sheet, returning to a listener on this phone.
@MainActor
final class SignInFlow: NSObject, ASWebAuthenticationPresentationContextProviding {
    private let config: OAuthConfig
    private var webSession: ASWebAuthenticationSession?

    init(config: OAuthConfig = .awsEvents) {
        self.config = config
    }

    func signIn() async throws -> TokenSet {
        let pkce = PKCE.generate()
        let state = PKCE.randomToken(bytes: 24)
        let outcome = OneShot<Result<String, SignInError>>()
        let listener = LoopbackListener()
        try await listener.start(ports: config.callbackPorts, expectedState: state) { result in
            switch result {
            case let .code(code): outcome.finish(.success(code))
            case let .denied(reason): outcome.finish(.failure(.denied(reason)))
            case .stateMismatch, .notCallback: break
            }
        }
        defer { listener.stop() }
        let port = listener.port

        let url = OAuthFlow.authorizationURL(config: config, port: port, state: state, pkce: pkce)
        // The sheet never completes through a custom scheme: the listener gets the answer and
        // the sheet is closed from here. Its completion only tells us the attendee closed it.
        let web = ASWebAuthenticationSession(url: url, callbackURLScheme: "sessionplanner-signin") { _, _ in
            outcome.finish(.failure(.cancelled))
        }
        web.presentationContextProvider = self
        // A private session: no cookies are read or left behind, so signing out of the app is a
        // real sign-out and a second person is never let in as the first.
        web.prefersEphemeralWebBrowserSession = true
        webSession = web
        guard web.start() else { throw SignInError.cancelled }

        let result = await outcome.wait()
        web.cancel()
        webSession = nil
        let code = try result.get()

        let request = OAuthFlow.tokenExchangeRequest(config: config, code: code, verifier: pkce.verifier, port: port)
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 30
        let (data, response) = try await URLSession(configuration: configuration).data(for: request)
        guard (response as? HTTPURLResponse)?.statusCode == 200,
              let tokens = try? TokenSet.parse(data, now: Date()) else { throw SignInError.tokenExchangeFailed }
        return tokens
    }

    nonisolated func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        MainActor.assumeIsolated {
            let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
            return scenes.flatMap(\.windows).first(where: \.isKeyWindow) ?? ASPresentationAnchor()
        }
    }
}
