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
/// The saved calendar with the id of the sign-in that fetched it.
private struct SavedSnapshot: Codable {
    var owner: String
    var snapshot: PlanSnapshot
}

actor SnapshotStore {
    /// Which version is on disk and which are ruled out. It is told of a write or a removal
    /// only after that has succeeded.
    private var ledger = SaveLedger()

    private static var url: URL {
        let folder = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        return folder.appendingPathComponent("snapshot-reinvent2026.json")
    }

    func save(_ snapshot: PlanSnapshot, owner: String, version: Int) throws {
        guard ledger.accept(version) else { return }
        let url = SnapshotStore.url
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try JSONEncoder().encode(SavedSnapshot(owner: owner, snapshot: snapshot))
            .write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        ledger.didWrite(version)
    }

    /// The saved calendar, only if it was fetched under the sign-in `owner`. A copy that is
    /// missing, unreadable, from an older build, or from any other sign-in is not returned,
    /// and is removed: this is what keeps one attendee's calendar from another's sign-in even
    /// if an earlier delete was cut short or failed.
    func load(owner: String) -> PlanSnapshot? {
        guard let data = try? Data(contentsOf: SnapshotStore.url) else { return nil }
        if let saved = try? JSONDecoder().decode(SavedSnapshot.self, from: data), saved.owner == owner {
            return saved.snapshot
        }
        if remove() { ledger.didRemove() }
        return nil
    }

    /// Refuses every save issued up to `version`, and removes the saved copy unless a later
    /// save has already replaced it (a new sign-in's calendar is not the departing one's).
    /// Returns false when a copy that should be gone could not be removed or emptied.
    @discardableResult
    func delete(through version: Int) -> Bool {
        guard ledger.ruleOut(through: version) else { return true }
        guard remove() else { return false }
        ledger.didRemove()
        return true
    }

    /// Removes the file; if that fails, empties it. True when no calendar is left in it.
    private func remove() -> Bool {
        let url = SnapshotStore.url
        guard FileManager.default.fileExists(atPath: url.path) else { return true }
        if (try? FileManager.default.removeItem(at: url)) != nil { return true }
        return (try? Data().write(to: url, options: .atomic)) != nil
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
    /// The id of the sign-in the live calendar belongs to; saved copies are tagged with it.
    private var signInID: String?
    private var backend: PlanBackend?
    /// Goes up every time the backend changes (sign-in, sign-out, sample conference). An
    /// answer is applied only if the backend it was asked of is still the current one.
    private var generation = 0
    /// The generation a refresh is running for, if one is.
    private var refreshingFor: Int?
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
            signInID = await tokens.signInID
            enterLive()
            await loadSavedSnapshot()
            await refresh()
        case .signedOut:
            // Nobody is signed in, so no saved calendar should exist. One left by a sign-out
            // that was cut short is removed here.
            await store.delete(through: saveVersion)
        }
    }

    private func enterLive() {
        setBackend(EventsAPI(eventID: EventInfo.reinvent2026.id, transport: URLSessionTransport(), tokens: tokens))
        setMode(.live)
        needsSignIn = false
    }

    private func setBackend(_ new: PlanBackend?) {
        backend = new
        generation += 1
        // A refresh still running for the old backend no longer counts as this one's.
        refreshingFor = nil
        isRefreshing = false
    }

    private func setMode(_ new: Mode) {
        mode = new
        UserDefaults.standard.set(new.rawValue, forKey: "mode")
    }

    private func setSnapshot(_ new: PlanSnapshot?) {
        snapshot = new
        suggester = nil
        let index = new?.sessionsByID ?? [:]
        sessionsByID = index
        commitmentsByID = new?.commitmentsByID ?? [:]
        days = new?.days() ?? []
        committedDays = new?.days(committedOnly: true) ?? []
        unresolvedCount = new?.unresolvedIDs.count ?? 0
    }

    // MARK: What the screens show

    func commitment(of sessionID: String) -> Commitment? { commitmentsByID[sessionID] }

    /// Built from the calendar the first time a gap is opened, and dropped when the calendar
    /// changes, so every gap is ranked against the same picks.
    @ObservationIgnored private var suggester: Suggester?

    /// The sessions that fit a free stretch, most like his picks first.
    func suggestions(in gap: Gap) -> [Suggestion] {
        guard let snapshot else { return [] }
        let ranker = suggester ?? Suggester(snapshot)
        suggester = ranker
        return ranker.suggestions(in: gap)
    }

    func sessions(matching filter: SessionFilter, search: String) -> [Session] {
        snapshot?.sessions(matching: filter, search: search, commitments: commitmentsByID) ?? []
    }

    /// The date and minute of `instant` in the conference's time zone.
    func eventNow(at instant: Date) -> (date: String, minute: Int) {
        Wording.eventNow(instant, timeZone: event.timeZone)
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
            // Nothing says this is the same attendee as before, so no earlier calendar, on
            // screen or saved, is carried into the new sign-in. The saved copy is removed
            // before the new tokens are kept; and since every saved copy is tagged with the
            // sign-in that fetched it, one that survives (a crash here, a failed delete) is
            // still refused under the new sign-in's id.
            let departing = saveVersion
            setSnapshot(nil)
            setBackend(nil)
            await store.delete(through: departing)
            let kept = await tokens.keep(new, freshSignIn: true)
            signInID = await tokens.signInID
            enterLive()
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
        // Fixed before the first wait: a calendar saved by a sign-in made while this is still
        // revoking belongs to that sign-in and is not deleted.
        let departing = saveVersion
        setBackend(nil)
        setSnapshot(nil)
        needsSignIn = false
        notice = nil
        setMode(.signedOut)
        // Revocation can wait on the network for a while. The saved calendar is deleted
        // alongside it, not after it, so quitting the app during that wait leaves nothing behind.
        signInID = nil
        async let revoked: Void = tokens.signOut()
        let removed = await store.delete(through: departing)
        await revoked
        if !removed, mode == .signedOut {
            notice = "You are signed out, but the saved calendar could not be removed from this phone. Delete the app to remove it."
        }
    }

    func startDemo() async {
        setBackend(DemoBackend())
        setSnapshot(nil)
        setMode(.demo)
        await refresh()
    }

    func leaveDemo() {
        setBackend(nil)
        setSnapshot(nil)
        notice = nil
        setMode(.signedOut)
    }

    // MARK: Reading

    /// Fetches the catalog and schedule. On any failure the calendar last seen is kept.
    func refresh() async {
        let asked = generation
        guard let backend, refreshingFor != asked else { return }
        refreshingFor = asked
        isRefreshing = true
        defer {
            if refreshingFor == asked {
                refreshingFor = nil
                isRefreshing = false
            }
        }
        do {
            let new = try await Sync.refresh(backend: backend, previous: snapshot, now: Date())
            // An answer from a backend he has since left (signed out, signed in again,
            // switched to the sample) is dropped, even if the mode reads the same.
            guard generation == asked else { return }
            setSnapshot(new)
            needsSignIn = false
            if mode == .live { save(new) }
        } catch is CancellationError {
            // The screen went away mid-refresh.
        } catch {
            guard generation == asked else { return }
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
        let asked = generation
        let outcome = await Sync.change(backend: backend, sessionID: sessionID, action)
        guard generation == asked else { return }
        // A sign-in rejected while reading the schedule back is acted on even when the change
        // itself is what gets reported.
        if outcome.readBackProblem as? APIError == .signInNeeded { needsSignIn = true }
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

    // MARK: Apple Calendar

    /// Whether his reserved sessions are kept in Apple Calendar. Off until he turns it on.
    private(set) var exportsToCalendar = UserDefaults.standard.bool(forKey: "exportsToCalendar") {
        didSet { UserDefaults.standard.set(exportsToCalendar, forKey: "exportsToCalendar") }
    }
    /// What the setting says after the last update.
    private(set) var calendarExportStatus: String?
    @ObservationIgnored private lazy var calendarExporter = CalendarExporter()

    /// Turns the Apple Calendar copy on (asking for permission, then writing it) or off. Off
    /// stops updates and leaves the calendar as it is.
    func setExportsToCalendar(_ on: Bool) async {
        guard on else {
            exportsToCalendar = false
            calendarExportStatus = nil
            return
        }
        guard mode == .live, let snapshot else { return }
        guard await calendarExporter.requestAccess() else {
            notice = "Session Planner can't add your sessions without access to Calendar. Allow it in the Settings app, under Privacy & Security, Calendars."
            return
        }
        exportsToCalendar = true
        exportToCalendar(snapshot)
    }

    private func exportToCalendar(_ snapshot: PlanSnapshot) {
        guard exportsToCalendar, mode == .live else { return }
        do {
            let count = try calendarExporter.sync(snapshot, calendarName: event.name, timeZone: event.timeZone)
            calendarExportStatus = Wording.calendarExport(count: count, calendar: event.name)
        } catch CalendarExporter.Failure.denied {
            exportsToCalendar = false
            calendarExportStatus = nil
            notice = "Calendar access was turned off, so your sessions are no longer kept in Calendar."
        } catch CalendarExporter.Failure.unreadableRecords {
            notice = "Calendar wasn't updated: the app's record of its events can't be read. Delete the “\(event.name)” calendar in the Calendar app, then turn this on again."
        } catch {
            notice = "Calendar couldn't be updated: \(error.localizedDescription)"
        }
    }

    // MARK: The saved copy

    private func save(_ snapshot: PlanSnapshot) {
        // Every live calendar the app keeps also brings Apple Calendar up to date, if he asked.
        exportToCalendar(snapshot)
        guard let owner = signInID else { return }
        saveVersion += 1
        let version = saveVersion
        Task {
            do {
                try await store.save(snapshot, owner: owner, version: version)
            } catch {
                notice = "The calendar could not be saved on this phone, so it will not be available offline."
            }
        }
    }

    private func loadSavedSnapshot() async {
        let asked = generation
        guard snapshot == nil, let owner = signInID, let saved = await store.load(owner: owner),
              snapshot == nil, generation == asked else { return }
        setSnapshot(saved)
    }
}
