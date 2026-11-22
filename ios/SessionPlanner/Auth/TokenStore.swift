import Foundation
import PlannerCore
import Security

/// The phone's keychain, for the sign-in tokens only. Nothing here is ever logged.
enum Keychain {
    private static let service = "us.mannix.sessionplanner.signin"
    private static let account = "aws-events"

    private static var query: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: service,
         kSecAttrAccount as String: account]
    }

    static func load() -> Data? {
        var q = query
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        guard SecItemCopyMatching(q as CFDictionary, &item) == errSecSuccess else { return nil }
        return item as? Data
    }

    /// Replaces the saved item in place, so a failed save leaves the previous sign-in intact.
    @discardableResult
    static func save(_ data: Data) -> Bool {
        let updated = SecItemUpdate(query as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        if updated == errSecSuccess { return true }
        guard updated == errSecItemNotFound else { return false }
        var q = query
        q[kSecValueData as String] = data
        // Readable after the first unlock, on this device only: never synced or restored elsewhere.
        q[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        return SecItemAdd(q as CFDictionary, nil) == errSecSuccess
    }

    static func delete() {
        SecItemDelete(query as CFDictionary)
    }
}

/// What is kept in the keychain: the tokens, and an id made up afresh at each interactive
/// sign-in. The saved calendar carries the same id, so a calendar is only ever shown to the
/// sign-in that fetched it.
private struct SavedSignIn: Codable {
    var tokens: TokenSet
    var signInID: String
}

/// Holds the attendee's tokens and renews the access token when it is about to expire.
actor TokenStore: AccessTokenSource {
    private let config: OAuthConfig
    private let session: URLSession
    private var tokens: TokenSet?
    /// Identifies the interactive sign-in the tokens came from. Renewals keep it.
    private(set) var signInID: String?
    /// The renewal in flight, and the sign-in it is renewing.
    private var refreshing: (of: TokenSet, task: Task<TokenSet, Error>)?

    init(config: OAuthConfig = .awsEvents) {
        self.config = config
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 30
        session = URLSession(configuration: configuration)
        if let data = Keychain.load() {
            if let saved = try? JSONDecoder().decode(SavedSignIn.self, from: data) {
                tokens = saved.tokens
                signInID = saved.signInID
            } else if let bare = try? JSONDecoder().decode(TokenSet.self, from: data) {
                // Saved by a build from before sign-ins had ids. It gets one now, written back
                // at once so the next launch reads the same id. If that write fails the
                // sign-in has no id for this launch, and no calendar is saved under one that
                // the next launch could not reproduce.
                tokens = bare
                let id = UUID().uuidString
                if let envelope = try? JSONEncoder().encode(SavedSignIn(tokens: bare, signInID: id)),
                   Keychain.save(envelope) {
                    signInID = id
                }
            }
        }
    }

    var isSignedIn: Bool { tokens != nil }

    /// Keeps new tokens. Returns false when the keychain refused them: the sign-in then lasts
    /// only until the app is closed.
    /// `freshSignIn` is true for tokens from an interactive sign-in, which starts a new id;
    /// a renewal keeps the id it has.
    @discardableResult
    func keep(_ new: TokenSet, freshSignIn: Bool = false) -> Bool {
        tokens = new
        // The id is taken up only once it is in the keychain with the tokens, so a calendar
        // is never saved under an id the next launch cannot read back.
        let id = (freshSignIn ? nil : signInID) ?? UUID().uuidString
        guard let data = try? JSONEncoder().encode(SavedSignIn(tokens: new, signInID: id)), Keychain.save(data) else {
            signInID = nil
            return false
        }
        signInID = id
        return true
    }

    func accessToken(forceRefresh: Bool) async throws -> String {
        guard let current = tokens else { throw APIError.signInNeeded }
        if !forceRefresh, !current.needsRefresh(now: Date()) { return current.accessToken }
        return try await refresh(current).accessToken
    }

    /// One refresh at a time: callers that arrive while one is running share its answer, so a
    /// rotated refresh token is never spent twice.
    private func refresh(_ current: TokenSet) async throws -> TokenSet {
        let task: Task<TokenSet, Error>
        if let running = refreshing, running.of == current {
            task = running.task
        } else {
            let request = OAuthFlow.refreshRequest(config: config, refreshToken: current.refreshToken)
            let session = self.session
            task = Task<TokenSet, Error> {
                let (data, response) = try await session.data(for: request)
                let status = (response as? HTTPURLResponse)?.statusCode ?? 0
                // The token endpoint answers 400 or 401 when the refresh token is no longer good.
                if status == 400 || status == 401 { throw APIError.signInNeeded }
                guard status == 200 else { throw APIError.server(status) }
                return try TokenSet.parse(data, now: Date(), previousRefreshToken: current.refreshToken)
            }
            refreshing = (current, task)
        }
        let result = await task.result
        if let running = refreshing, running.task == task { refreshing = nil }
        let new = try result.get()

        // Every caller checks, whether it started the renewal or joined it: the attendee may
        // have signed out, or signed in afresh, while it was in flight.
        if tokens == current {
            keep(new)
            return new
        }
        if tokens == new { return new } // another caller of the same renewal already kept it
        // Tokens renewed for a sign-in that is gone are revoked, never kept or handed out.
        if new.refreshToken != current.refreshToken {
            _ = try? await session.data(for: OAuthFlow.revokeRequest(config: config, refreshToken: new.refreshToken))
        }
        guard let replacement = tokens else { throw APIError.signInNeeded }
        return replacement
    }

    /// Forgets both tokens at once, then asks the sign-in service to revoke the refresh token
    /// (best effort). Forgetting first means a sign-in made while the revocation is in flight
    /// is not wiped when it returns.
    func signOut() async {
        guard let departing = tokens else { return }
        tokens = nil
        signInID = nil
        Keychain.delete()
        _ = try? await session.data(for: OAuthFlow.revokeRequest(config: config, refreshToken: departing.refreshToken))
    }
}

/// Sends API requests with a session that keeps no cookies and no cache.
struct URLSessionTransport: HTTPTransport {
    private let session: URLSession

    init() {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 30
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        session = URLSession(configuration: configuration)
    }

    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw URLError(.badServerResponse) }
        return (data, http)
    }
}
