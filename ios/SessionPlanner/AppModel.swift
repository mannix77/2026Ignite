import Foundation
import Observation
import PlannerCore

/// The conference the app talks to.
struct EventInfo {
    var id: String
    var name: String
    var timeZone: TimeZone

    static let reinvent2026 = EventInfo(id: "reinvent2026", name: "re:Invent 2026",
                                        timeZone: TimeZone(identifier: "America/Los_Angeles") ?? .current)
    static let sample = EventInfo(id: "sample", name: "Sample Conference", timeZone: .current)
}

/// The saved copy of the calendar. Reading and writing several megabytes of JSON happens here,
/// off the main actor. Each save carries a version, so a slow older save never lands on top of
/// a newer one, and nothing issued before a sign-out is written after it.
actor SnapshotStore {
    private var newest = 0

    private static var url: URL {
        let folder = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        return folder.appendingPathComponent("snapshot-reinvent2026.json")
    }

    func save(_ snapshot: PlanSnapshot, version: Int) throws {
        guard version > newest else { return }
        newest = version
        let url = SnapshotStore.url
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try JSONEncoder().encode(snapshot).write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }

    /// A missing or unreadable saved copy just means starting from a fresh fetch.
    func load() -> PlanSnapshot? {
        guard let data = try? Data(contentsOf: SnapshotStore.url) else { return nil }
        return try? JSONDecoder().decode(PlanSnapshot.self, from: data)
    }

    /// Removes the saved copy and refuses every save issued up to `version`.
    func delete(through version: Int) {
        newest = max(newest, version)
        try? FileManager.default.removeItem(at: SnapshotStore.url)
    }
}

@MainActor
@Observable
final class AppModel {
    enum Mode: String {
        case signedOut, live, demo
    }

    private(set) var mode: Mode = .signedOut
    private(set) var snapshot: PlanSnapshot?
    // Lookups derived from the snapshot once, when it changes, so redraws do not rebuild them.
    private(set) var sessionsByID: [String: Session] = [:]
    private(set) var commitmentsByID: [String: Commitment] = [:]
    private(set) var days: [String] = []
    private(set) var committedDays: [String] = []
    private(set) var unresolvedCount = 0
    private(set) var isRefreshing = false
    private(set) var isSigningIn = false
    /// True when the saved sign-in was rejected: the calendar stays, but updating needs a new sign-in.
    private(set) var needsSignIn = false
    /// A problem or result to show. Cleared when the attendee dismisses it.
    var notice: String?
    var showFavorites: Bool = UserDefaults.standard.bool(forKey: "showFavorites") {
        didSet { UserDefaults.standard.set(showFavorites, forKey: "showFavorites") }
    }

    private let tokens = TokenStore()
    private let store = SnapshotStore()
    private var saveVersion = 0
    private var backend: PlanBackend?
    private var signInFlow: SignInFlow?

    var event: EventInfo { mode == .demo ? .sample : .reinvent2026 }

    // MARK: Starting up

    func start() async {
        let saved = Mode(rawValue: UserDefaults.standard.string(forKey: "mode") ?? "") ?? .signedOut
        switch saved {
        case .demo:
            await startDemo()
        case .live:
            guard await tokens.isSignedIn else { return }
            enterLive()
            await loadSavedSnapshot()
            await refresh()
        case .signedOut:
            break
        }
    }

    private func enterLive() {
        backend = EventsAPI(eventID: EventInfo.reinvent2026.id, transport: URLSessionTransport(), tokens: tokens)
        setMode(.live)
        needsSignIn = false
    }

    private func setMode(_ new: Mode) {
        mode = new
        UserDefaults.standard.set(new.rawValue, forKey: "mode")
    }

    private func setSnapshot(_ new: PlanSnapshot?) {
        snapshot = new
        let index = new?.sessionsByID ?? [:]
        sessionsByID = index
        commitmentsByID = new?.commitmentsByID ?? [:]
        days = new?.days() ?? []
        committedDays = new?.days(committedOnly: true) ?? []
        unresolvedCount = new?.unresolvedIDs.count ?? 0
    }

    // MARK: What the screens show

    func commitment(of sessionID: String) -> Commitment? { commitmentsByID[sessionID] }

    func sessions(matching filter: SessionFilter, search: String) -> [Session] {
        snapshot?.sessions(matching: filter, search: search, commitments: commitmentsByID) ?? []
    }

    /// Today's date and minute in the conference's time zone.
    var eventNow: (date: String, minute: Int) { Wording.eventNow(Date(), timeZone: event.timeZone) }

    // MARK: Signing in and out

    func signIn() async {
        guard !isSigningIn else { return }
        isSigningIn = true
        defer { isSigningIn = false }
        let flow = SignInFlow()
        signInFlow = flow
        defer { signInFlow = nil }
        do {
            let new = try await flow.signIn()
            let kept = await tokens.keep(new)
            if mode != .live { setSnapshot(nil) }
            enterLive()
            await loadSavedSnapshot()
            await refresh()
            if !kept, notice == nil {
                notice = "Signed in, but the sign-in could not be saved to the keychain. You will need to sign in again next time."
            }
        } catch SignInError.cancelled {
            // The attendee closed the sheet: nothing to report.
        } catch let SignInError.denied(reason) {
            notice = "Sign-in did not complete: \(reason)"
        } catch SignInError.noPortFree {
            notice = "Sign-in could not start on this phone. Close other apps and try again."
        } catch {
            notice = "Sign-in did not complete. Check your connection and try again."
        }
    }

    func signOut() async {
        backend = nil
        setSnapshot(nil)
        needsSignIn = false
        notice = nil
        setMode(.signedOut)
        await tokens.signOut()
        await store.delete(through: saveVersion)
    }

    func startDemo() async {
        backend = DemoBackend()
        setSnapshot(nil)
        setMode(.demo)
        await refresh()
    }

    func leaveDemo() {
        backend = nil
        setSnapshot(nil)
        notice = nil
        setMode(.signedOut)
    }

    // MARK: Reading

    /// Fetches the catalog and schedule. On any failure the calendar last seen is kept.
    func refresh() async {
        guard let backend, !isRefreshing else { return }
        let startedIn = mode
        isRefreshing = true
        defer { isRefreshing = false }
        do {
            let new = try await Sync.refresh(backend: backend, previous: snapshot, now: Date())
            // An answer for a conference he has since left (signed out, switched) is dropped.
            guard mode == startedIn else { return }
            setSnapshot(new)
            needsSignIn = false
            if mode == .live { save(new) }
        } catch is CancellationError {
            // The screen went away mid-refresh.
        } catch {
            guard mode == startedIn else { return }
            report(error)
        }
    }

    private func report(_ error: Error) {
        if error as? APIError == .signInNeeded { needsSignIn = true }
        if (error as? URLError)?.code == .cancelled { return }
        notice = Wording.problem(error)
    }

    // MARK: Changing things on the conference site

    func setFavorite(_ session: Session, _ favorite: Bool) async {
        let id = session.sessionId
        await change(id) { backend in
            if favorite { return try await backend.favorite([id]) }
            try await backend.unfavorite(id)
            return BulkResult(successful: [id])
        }
    }

    func reserve(_ session: Session) async {
        let id = session.sessionId
        await change(id) { try await $0.reserve([id]) }
    }

    func cancelReservation(_ session: Session) async {
        let id = session.sessionId
        await change(id) { backend in
            try await backend.cancelReservation(id)
            return BulkResult(successful: [id])
        }
    }

    /// Sends one change and shows the schedule the conference site reads back (see `Sync.change`).
    private func change(_ sessionID: String, _ action: @Sendable (PlanBackend) async throws -> BulkResult) async {
        guard let backend else { return }
        let startedIn = mode
        let outcome = await Sync.change(backend: backend, sessionID: sessionID, action)
        guard mode == startedIn else { return }
        if let schedule = outcome.schedule, var updated = snapshot {
            updated.schedule = schedule
            setSnapshot(updated)
            if mode == .live { save(updated) }
        }
        if let refusal = outcome.refusal {
            notice = Wording.refusal(refusal) { [sessionsByID] id in sessionsByID[id]?.code }
        } else if let problem = outcome.problem {
            report(problem)
        }
    }

    // MARK: The saved copy

    private func save(_ snapshot: PlanSnapshot) {
        saveVersion += 1
        let version = saveVersion
        Task {
            do {
                try await store.save(snapshot, version: version)
            } catch {
                notice = "The calendar could not be saved on this phone, so it will not be available offline."
            }
        }
    }

    private func loadSavedSnapshot() async {
        guard snapshot == nil, let saved = await store.load(), snapshot == nil, mode == .live else { return }
        setSnapshot(saved)
    }
}
