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

@MainActor
@Observable
final class AppModel {
    enum Mode: String {
        case signedOut, live, demo
    }

    private(set) var mode: Mode = .signedOut
    private(set) var snapshot: PlanSnapshot?
    private(set) var sessionsByID: [String: Session] = [:]
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
            loadSavedSnapshot()
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
        sessionsByID = new?.sessionsByID ?? [:]
    }

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
            loadSavedSnapshot()
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
        await tokens.signOut()
        try? FileManager.default.removeItem(at: AppModel.snapshotURL)
        backend = nil
        setSnapshot(nil)
        needsSignIn = false
        notice = nil
        setMode(.signedOut)
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
        isRefreshing = true
        defer { isRefreshing = false }
        do {
            let new = try await Sync.refresh(backend: backend, previous: snapshot, now: Date())
            setSnapshot(new)
            needsSignIn = false
            if mode == .live { save(new) }
        } catch is CancellationError {
            // The screen went away mid-refresh.
        } catch {
            report(error)
        }
    }

    private func report(_ error: Error) {
        if error as? APIError == .signInNeeded { needsSignIn = true }
        if (error as? URLError)?.code == .cancelled { return }
        notice = Wording.problem(error)
    }

    // MARK: Changing things on the conference site

    func commitment(of sessionID: String) -> Commitment? { snapshot?.commitment(of: sessionID) }

    func setFavorite(_ session: Session, _ favorite: Bool) async {
        await change(session) { backend in
            if favorite { return try await backend.favorite([session.sessionId]) }
            try await backend.unfavorite(session.sessionId)
            return BulkResult(successful: [session.sessionId])
        }
    }

    func reserve(_ session: Session) async {
        await change(session) { try await $0.reserve([session.sessionId]) }
    }

    func cancelReservation(_ session: Session) async {
        await change(session) { backend in
            try await backend.cancelReservation(session.sessionId)
            return BulkResult(successful: [session.sessionId])
        }
    }

    /// Sends one change, then reads the schedule back: the conference site's answer is what is
    /// shown, never a guess. When the answer to the change never arrived, the schedule is still
    /// read and the change is not sent again.
    private func change(_ session: Session, _ action: (PlanBackend) async throws -> BulkResult) async {
        guard let backend else { return }
        var problem: String?
        do {
            let result = try await action(backend)
            if let failure = result.failed.first(where: { $0.sessionId == session.sessionId }) ?? result.failed.first {
                problem = Wording.refusal(failure) { [sessionsByID] id in sessionsByID[id]?.code }
            }
        } catch {
            if error as? APIError == .signInNeeded { needsSignIn = true }
            problem = Wording.problem(error)
        }
        do {
            let schedule = try await backend.loadSchedule()
            if var updated = snapshot {
                updated.schedule = schedule
                setSnapshot(updated)
                if mode == .live { save(updated) }
            }
        } catch {
            if problem == nil { problem = Wording.problem(error) }
        }
        if let problem { notice = problem }
    }

    // MARK: The saved copy

    private static var snapshotURL: URL {
        let folder = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        return folder.appendingPathComponent("snapshot-reinvent2026.json")
    }

    private func save(_ snapshot: PlanSnapshot) {
        do {
            let url = AppModel.snapshotURL
            try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            try JSONEncoder().encode(snapshot).write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        } catch {
            notice = "The calendar could not be saved on this phone, so it will not be available offline."
        }
    }

    /// A missing or unreadable saved copy just means starting from a fresh fetch.
    private func loadSavedSnapshot() {
        guard snapshot == nil, let data = try? Data(contentsOf: AppModel.snapshotURL),
              let saved = try? JSONDecoder().decode(PlanSnapshot.self, from: data) else { return }
        setSnapshot(saved)
    }
}
