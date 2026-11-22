import CryptoKit
import Foundation

/// Sign-in values published in the AWS Events API developer guide ("Endpoints and values").
/// The client id is public and shared; the flow is protected by PKCE, so there is no secret.
public struct OAuthConfig: Sendable {
    public var authorizeURL: URL
    public var tokenURL: URL
    public var revokeURL: URL
    public var clientID: String
    public var scope: String
    public var identityProvider: String
    /// The only loopback ports the sign-in service accepts for `/callback`.
    public var callbackPorts: ClosedRange<UInt16>

    public init(authorizeURL: URL, tokenURL: URL, revokeURL: URL, clientID: String, scope: String,
                identityProvider: String, callbackPorts: ClosedRange<UInt16>) {
        self.authorizeURL = authorizeURL
        self.tokenURL = tokenURL
        self.revokeURL = revokeURL
        self.clientID = clientID
        self.scope = scope
        self.identityProvider = identityProvider
        self.callbackPorts = callbackPorts
    }

    public static let awsEvents = OAuthConfig(
        authorizeURL: URL(string: "https://oauth.awsevents.com/oauth2/authorize")!,
        tokenURL: URL(string: "https://oauth.awsevents.com/oauth2/token")!,
        revokeURL: URL(string: "https://oauth.awsevents.com/oauth2/revoke")!,
        clientID: "7vmom55m1qstvq8i71ph127bfq",
        scope: "openid email events/access",
        identityProvider: "AWSBuilderID",
        callbackPorts: 8484...8489
    )

    /// The redirect URI for a port. The authorization request and the token exchange must send
    /// this identical string.
    public func redirectURI(port: UInt16) -> String { "http://localhost:\(port)/callback" }
}

/// Proof Key for Code Exchange (RFC 7636), S256.
public struct PKCE: Equatable, Sendable {
    public let verifier: String
    public let challenge: String

    public init(verifier: String) {
        self.verifier = verifier
        self.challenge = PKCE.challenge(for: verifier)
    }

    /// A fresh verifier: 32 random bytes, base64url without padding (43 characters).
    public static func generate() -> PKCE {
        PKCE(verifier: randomToken(bytes: 32))
    }

    public static func challenge(for verifier: String) -> String {
        base64URL(Data(SHA256.hash(data: Data(verifier.utf8))))
    }

    public static func randomToken(bytes: Int) -> String {
        var generator = SystemRandomNumberGenerator()
        let data = Data((0..<bytes).map { _ in UInt8.random(in: .min ... .max, using: &generator) })
        return base64URL(data)
    }

    static func base64URL(_ data: Data) -> String {
        data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}

/// What came back on the loopback callback.
public enum CallbackResult: Equatable, Sendable {
    /// The authorization code, from an answer whose state matched this sign-in.
    case code(String)
    /// The sign-in service reported an error (for example the attendee declined).
    case denied(String)
    /// The answer belongs to some other sign-in. Refused.
    case stateMismatch
    /// Not a request for `/callback` at all (a favicon fetch, a stray probe).
    case notCallback
}

public enum OAuthFlow {
    /// The URL to send the attendee's browser to.
    public static func authorizationURL(config: OAuthConfig, port: UInt16, state: String, pkce: PKCE) -> URL {
        var parts = URLComponents(url: config.authorizeURL, resolvingAgainstBaseURL: false)!
        parts.percentEncodedQuery = formEncode([
            ("response_type", "code"),
            ("client_id", config.clientID),
            ("redirect_uri", config.redirectURI(port: port)),
            ("scope", config.scope),
            ("identity_provider", config.identityProvider),
            ("code_challenge", pkce.challenge),
            ("code_challenge_method", "S256"),
            ("state", state),
        ])
        return parts.url!
    }

    /// Reads the first line of the HTTP request the browser sent to the loopback listener,
    /// e.g. `GET /callback?code=abc&state=xyz HTTP/1.1`.
    public static func parseCallback(requestLine: String, expectedState: String) -> CallbackResult {
        let parts = requestLine.split(separator: " ")
        guard parts.count >= 2, parts[0] == "GET",
              let url = URLComponents(string: "http://localhost\(parts[1])"), url.path == "/callback" else {
            return .notCallback
        }
        var values: [String: String] = [:]
        for item in url.queryItems ?? [] where values[item.name] == nil {
            values[item.name] = item.value ?? ""
        }
        // The state is checked first: an answer from another sign-in is refused whatever it says.
        guard !expectedState.isEmpty, values["state"] == expectedState else { return .stateMismatch }
        if let error = Identifier.clean(values["error"]) {
            return .denied(Identifier.clean(values["error_description"]) ?? error)
        }
        guard let code = Identifier.clean(values["code"]) else { return .denied("The sign-in answer had no code.") }
        return .code(code)
    }

    public static func tokenExchangeRequest(config: OAuthConfig, code: String, verifier: String, port: UInt16) -> URLRequest {
        formPost(config.tokenURL, [
            ("grant_type", "authorization_code"),
            ("client_id", config.clientID),
            ("redirect_uri", config.redirectURI(port: port)),
            ("code", code),
            ("code_verifier", verifier),
        ])
    }

    public static func refreshRequest(config: OAuthConfig, refreshToken: String) -> URLRequest {
        formPost(config.tokenURL, [
            ("grant_type", "refresh_token"),
            ("client_id", config.clientID),
            ("refresh_token", refreshToken),
        ])
    }

    public static func revokeRequest(config: OAuthConfig, refreshToken: String) -> URLRequest {
        formPost(config.revokeURL, [("client_id", config.clientID), ("token", refreshToken)])
    }

    static func formPost(_ url: URL, _ fields: [(String, String)]) -> URLRequest {
        var request = URLRequest(url: url, timeoutInterval: 30)
        request.httpMethod = "POST"
        request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        request.httpBody = Data(formEncode(fields).utf8)
        return request
    }

    static func formEncode(_ fields: [(String, String)]) -> String {
        var allowed = CharacterSet.alphanumerics
        allowed.insert(charactersIn: "-._~")
        func enc(_ s: String) -> String { s.addingPercentEncoding(withAllowedCharacters: allowed) ?? "" }
        return fields.map { "\(enc($0.0))=\(enc($0.1))" }.joined(separator: "&")
    }
}

public enum TokenError: Error, Equatable {
    /// The token endpoint's answer had no usable access token.
    case badResponse
    /// The first sign-in answer carried no refresh token, so the sign-in could not be kept.
    case noRefreshToken
}

/// The tokens for one signed-in attendee. Kept in the keychain, never logged.
public struct TokenSet: Codable, Equatable, Sendable {
    public var accessToken: String
    public var refreshToken: String
    public var expiresAt: Date

    public init(accessToken: String, refreshToken: String, expiresAt: Date) {
        self.accessToken = accessToken
        self.refreshToken = refreshToken
        self.expiresAt = expiresAt
    }

    private struct Response: Decodable {
        let access_token: String?
        let refresh_token: String?
        let expires_in: Double?
    }

    /// Reads a token endpoint answer. A refresh answer may omit the refresh token, in which case
    /// the previous one is kept; if it carries a new one, the new one replaces it.
    public static func parse(_ data: Data, now: Date, previousRefreshToken: String? = nil) throws -> TokenSet {
        guard let response = try? JSONDecoder().decode(Response.self, from: data),
              let access = Identifier.clean(response.access_token) else { throw TokenError.badResponse }
        guard let refresh = Identifier.clean(response.refresh_token) ?? Identifier.clean(previousRefreshToken) else {
            throw TokenError.noRefreshToken
        }
        // No usable lifetime means "expired already": the next call refreshes instead of trusting it.
        let lifetime = response.expires_in.flatMap { $0.isFinite && $0 > 0 ? $0 : nil } ?? 0
        return TokenSet(accessToken: access, refreshToken: refresh, expiresAt: now.addingTimeInterval(lifetime))
    }

    /// True when the access token should be renewed before use (within a minute of expiry).
    public func needsRefresh(now: Date) -> Bool {
        now.addingTimeInterval(60) >= expiresAt
    }
}
