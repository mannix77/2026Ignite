import XCTest
@testable import PlannerCore

final class OAuthTests: XCTestCase {
    let config = OAuthConfig.awsEvents

    // RFC 7636, Appendix B: the published verifier and the challenge it must produce.
    func testChallengeMatchesThePublishedExample() {
        let pkce = PKCE(verifier: "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")
        XCTAssertEqual(pkce.challenge, "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM")
    }

    func testEachSignInGetsAFreshVerifierOfTheRightShape() {
        let first = PKCE.generate()
        let second = PKCE.generate()
        XCTAssertNotEqual(first.verifier, second.verifier)
        XCTAssertEqual(first.verifier.count, 43)
        let unreserved = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~")
        XCTAssertTrue(first.verifier.unicodeScalars.allSatisfy(unreserved.contains))
        XCTAssertEqual(first.challenge.count, 43)
        XCTAssertNotEqual(first.challenge, first.verifier)
    }

    func testAuthorizationURLCarriesEveryPublishedValue() throws {
        let pkce = PKCE(verifier: "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")
        let url = OAuthFlow.authorizationURL(config: config, port: 8485, state: "st4te", pkce: pkce)
        let parts = try XCTUnwrap(URLComponents(url: url, resolvingAgainstBaseURL: false))
        XCTAssertEqual(parts.scheme, "https")
        XCTAssertEqual(parts.host, "oauth.awsevents.com")
        XCTAssertEqual(parts.path, "/oauth2/authorize")
        let items = Dictionary(uniqueKeysWithValues: (parts.queryItems ?? []).map { ($0.name, $0.value ?? "") })
        XCTAssertEqual(items, [
            "response_type": "code",
            "client_id": "7vmom55m1qstvq8i71ph127bfq",
            "redirect_uri": "http://localhost:8485/callback",
            "scope": "openid email events/access",
            "identity_provider": "AWSBuilderID",
            "code_challenge": "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
            "code_challenge_method": "S256",
            "state": "st4te",
        ])
    }

    func testCallbackWithMatchingStateGivesTheCode() {
        XCTAssertEqual(
            OAuthFlow.parseCallback(requestLine: "GET /callback?code=abc123&state=st4te HTTP/1.1", expectedState: "st4te"),
            .code("abc123"))
        // The code is percent-decoded before it is used.
        XCTAssertEqual(
            OAuthFlow.parseCallback(requestLine: "GET /callback?state=st4te&code=a%2Fb HTTP/1.1", expectedState: "st4te"),
            .code("a/b"))
    }

    func testCallbackFromAnotherSignInIsRefused() {
        XCTAssertEqual(
            OAuthFlow.parseCallback(requestLine: "GET /callback?code=abc123&state=other HTTP/1.1", expectedState: "st4te"),
            .stateMismatch)
        XCTAssertEqual(
            OAuthFlow.parseCallback(requestLine: "GET /callback?code=abc123 HTTP/1.1", expectedState: "st4te"),
            .stateMismatch)
        // An empty expected state never matches an empty or missing one.
        XCTAssertEqual(
            OAuthFlow.parseCallback(requestLine: "GET /callback?code=abc123&state= HTTP/1.1", expectedState: ""),
            .stateMismatch)
    }

    func testCallbackErrorsAndStrayRequests() {
        XCTAssertEqual(
            OAuthFlow.parseCallback(requestLine: "GET /callback?error=access_denied&error_description=Declined&state=st4te HTTP/1.1",
                                    expectedState: "st4te"),
            .denied("Declined"))
        XCTAssertEqual(
            OAuthFlow.parseCallback(requestLine: "GET /callback?state=st4te HTTP/1.1", expectedState: "st4te"),
            .denied("The sign-in answer had no code."))
        XCTAssertEqual(OAuthFlow.parseCallback(requestLine: "GET /favicon.ico HTTP/1.1", expectedState: "st4te"), .notCallback)
        XCTAssertEqual(
            OAuthFlow.parseCallback(requestLine: "POST /callback?code=abc123&state=st4te HTTP/1.1", expectedState: "st4te"),
            .notCallback)
        XCTAssertEqual(OAuthFlow.parseCallback(requestLine: "", expectedState: "st4te"), .notCallback)
    }

    func testTokenExchangeSendsTheSameRedirectAsTheAuthorizationRequest() throws {
        let request = OAuthFlow.tokenExchangeRequest(config: config, code: "the code", verifier: "ver", port: 8484)
        XCTAssertEqual(request.url?.absoluteString, "https://oauth.awsevents.com/oauth2/token")
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Content-Type"), "application/x-www-form-urlencoded")
        XCTAssertEqual(
            String(decoding: try XCTUnwrap(request.httpBody), as: UTF8.self),
            "grant_type=authorization_code&client_id=7vmom55m1qstvq8i71ph127bfq"
                + "&redirect_uri=http%3A%2F%2Flocalhost%3A8484%2Fcallback&code=the%20code&code_verifier=ver")
    }

    func testRefreshAndRevokeRequests() throws {
        let refresh = OAuthFlow.refreshRequest(config: config, refreshToken: "r+1")
        XCTAssertEqual(refresh.url?.absoluteString, "https://oauth.awsevents.com/oauth2/token")
        XCTAssertEqual(String(decoding: try XCTUnwrap(refresh.httpBody), as: UTF8.self),
                       "grant_type=refresh_token&client_id=7vmom55m1qstvq8i71ph127bfq&refresh_token=r%2B1")
        let revoke = OAuthFlow.revokeRequest(config: config, refreshToken: "r1")
        XCTAssertEqual(revoke.url?.absoluteString, "https://oauth.awsevents.com/oauth2/revoke")
        XCTAssertEqual(String(decoding: try XCTUnwrap(revoke.httpBody), as: UTF8.self),
                       "client_id=7vmom55m1qstvq8i71ph127bfq&token=r1")
    }

    func testTokenAnswerIsReadWithItsLifetime() throws {
        let now = Date(timeIntervalSince1970: 1_000_000)
        let tokens = try TokenSet.parse(
            Data(#"{"access_token":"a1","refresh_token":"r1","id_token":"i1","expires_in":3600,"token_type":"Bearer"}"#.utf8),
            now: now)
        XCTAssertEqual(tokens, TokenSet(accessToken: "a1", refreshToken: "r1", expiresAt: now.addingTimeInterval(3600)))
    }

    func testRefreshKeepsTheOldRefreshTokenUnlessANewOneArrives() throws {
        let now = Date(timeIntervalSince1970: 1_000_000)
        let kept = try TokenSet.parse(Data(#"{"access_token":"a2","expires_in":3600}"#.utf8), now: now,
                                      previousRefreshToken: "r1")
        XCTAssertEqual(kept, TokenSet(accessToken: "a2", refreshToken: "r1", expiresAt: now.addingTimeInterval(3600)))
        let rotated = try TokenSet.parse(Data(#"{"access_token":"a3","refresh_token":"r2","expires_in":60}"#.utf8),
                                         now: now, previousRefreshToken: "r1")
        XCTAssertEqual(rotated, TokenSet(accessToken: "a3", refreshToken: "r2", expiresAt: now.addingTimeInterval(60)))
    }

    func testUnusableTokenAnswersAreRefused() {
        let now = Date(timeIntervalSince1970: 1_000_000)
        XCTAssertThrowsError(try TokenSet.parse(Data(#"{"error":"invalid_grant"}"#.utf8), now: now)) {
            XCTAssertEqual($0 as? TokenError, .badResponse)
        }
        XCTAssertThrowsError(try TokenSet.parse(Data("<html>".utf8), now: now)) {
            XCTAssertEqual($0 as? TokenError, .badResponse)
        }
        XCTAssertThrowsError(try TokenSet.parse(Data(#"{"access_token":"a1","expires_in":3600}"#.utf8), now: now)) {
            XCTAssertEqual($0 as? TokenError, .noRefreshToken)
        }
    }

    func testAnAnswerWithNoLifetimeIsTreatedAsExpired() throws {
        let now = Date(timeIntervalSince1970: 1_000_000)
        let tokens = try TokenSet.parse(Data(#"{"access_token":"a1","refresh_token":"r1"}"#.utf8), now: now)
        XCTAssertEqual(tokens.expiresAt, now)
        XCTAssertTrue(tokens.needsRefresh(now: now))
    }

    func testAccessIsRenewedFromAMinuteBeforeItExpires() {
        let now = Date(timeIntervalSince1970: 1_000_000)
        func tokens(expiringIn seconds: TimeInterval) -> TokenSet {
            TokenSet(accessToken: "a", refreshToken: "r", expiresAt: now.addingTimeInterval(seconds))
        }
        XCTAssertFalse(tokens(expiringIn: 61).needsRefresh(now: now))
        XCTAssertTrue(tokens(expiringIn: 60).needsRefresh(now: now))
        XCTAssertTrue(tokens(expiringIn: -1).needsRefresh(now: now))
    }
}
