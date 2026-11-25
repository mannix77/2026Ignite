import Foundation
import Observation
import os
import PlannerCore

private let modelLog = Logger(subsystem: "SessionPlanner", category: "model")

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

    /// How long he allows to be in line before a session, for gap suggestions (Settings).
    var lineUp = LineUp(saved: UserDefaults.standard.object(forKey: "lineUpMinutes")) {
        didSet { UserDefaults.standard.set(lineUp.minutes, forKey: "lineUpMinutes") }
    }
    /// Favorites he can't reserve that he put on his calendar. Kept on the phone only: the site
    /// knows them as favorites. Cleared on a new sign-in, like the calendar.
    private(set) var walkIns = Set(UserDefaults.standard.stringArray(forKey: "walkIns") ?? []) {
        didSet {
            UserDefaults.standard.set(walkIns.sorted(), forKey: "walkIns")
            commitmentsByID = snapshot?.commitments(walkIns: walkIns) ?? [:]
            suggester = nil
            snapshotVersion += 1
        }
    }

    func setWalkIn(_ session: Session, _ on: Bool) {
        if on { walkIns.insert(session.sessionId) } else { walkIns.remove(session.sessionId) }
    }

    /// The levels and formats he looks for and the formats he skips (#197). Kept on the phone.
    var preferences = SessionPreferences(saved: UserDefaults.standard.data(forKey: "sessionPreferences")) {
        didSet { UserDefaults.standard.set(preferences.saved, forKey: "sessionPreferences") }
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
    /// True while the running refresh is one he didn't ask for; a refresh he asks for while
    /// it runs joins it and makes it report its problems like his own.
    private var refreshIsQuiet = false
    /// Set once `start()` has finished, so an update by itself can't overtake launching.
    private var started = false
    /// When the calendar last tried to update by itself, so a failure waits before the next try.
    private var lastAutomaticAttempt: Date?
    /// When the whole catalog was last tried, so a failed download waits before the next try.
    private var catalogLastTried: Date?
    private var signInFlow: SignInFlow?

    var event: EventInfo { mode == .demo ? .sample : .reinvent2026 }

    // MARK: Starting up

    func start() async {
        defer { started = true }
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
        lastAutomaticAttempt = nil
        catalogLastTried = nil
        // What the model remembers belongs to the calendar it ranked: a new sign-in, the sample
        // conference or signing out start with nothing. A request still running for the old
        // one can only fill the ranker dropped here.
        onDeviceModel = AppleIntelligence.ranker().map(RememberingRanker.init)
    }

    private func setMode(_ new: Mode) {
        mode = new
        UserDefaults.standard.set(new.rawValue, forKey: "mode")
    }

    private func setSnapshot(_ new: PlanSnapshot?) {
        snapshot = new
        suggester = nil
        snapshotVersion += 1
        let index = new?.sessionsByID ?? [:]
        sessionsByID = index
        commitmentsByID = new?.commitments(walkIns: walkIns) ?? [:]
        days = new?.days() ?? []
        committedDays = new?.days(committedOnly: true) ?? []
        unresolvedCount = new?.unresolvedIDs.count ?? 0
    }

    // MARK: What the screens show

    func commitment(of sessionID: String) -> Commitment? { commitmentsByID[sessionID] }

    /// The walk-in button the session's page shows (`PlanSnapshot.walkInAction`).
    func walkInAction(for sessionID: String) -> WalkInAction? {
        snapshot?.walkInAction(for: sessionID, commitments: commitmentsByID)
    }

    /// Built from the calendar the first time a gap is opened, and dropped when the calendar
    /// changes, so every gap is ranked against the same picks.
    @ObservationIgnored private var suggester: Suggester?
    /// Goes up every time the calendar is replaced; a screen showing something worked out from
    /// an earlier calendar watches it.
    private(set) var snapshotVersion = 0

    /// The sessions that fit a free stretch, most like his picks first, re-ordered by his session
    /// preferences as they are when it opens. The ranking is built and run off the main actor,
    /// so the screen doesn't stall on a large catalog.
    func suggestions(in gap: Gap) async -> [Suggestion] {
        guard let snapshot else { return [] }
        let built = suggester
        let version = snapshotVersion
        let lineUp = lineUp
        let preferences = preferences
        let marks = commitmentsByID
        let ranker = await Task.detached(priority: .userInitiated) { built ?? Suggester(snapshot, commitments: marks) }.value
        // Kept only if the calendar hasn't changed meanwhile; either way this answer is for the
        // calendar the gap came from.
        if suggester == nil, snapshotVersion == version { suggester = ranker }
        return await Task.detached(priority: .userInitiated) {
            ranker.suggestions(in: gap, lineUp: lineUp, preferences: preferences)
        }.value
    }

    /// Apple's on-device model where the phone has it, answering a prompt it has just answered
    /// from its last answer (an open stretch reloads every minute). Replaced whenever the
    /// sign-in changes (`setBackend`).
    @ObservationIgnored private var onDeviceModel: RememberingRanker? = AppleIntelligence.ranker().map(RememberingRanker.init)

    /// Whether the on-device model will be asked about `suggestions` (`ModelStep.willAsk`).
    func willRankWithModel(_ suggestions: [Suggestion]) -> Bool { ModelStep.willAsk(suggestions, ranker: onDeviceModel) }

    /// `suggestions` as the on-device model last ranked them, at once, when it has already
    /// answered for this list (an open stretch reloading on the minute); nil otherwise.
    func rememberedRanking(of suggestions: [Suggestion], in gap: Gap) -> RankedSuggestions? {
        guard let onDeviceModel, let snapshot else { return nil }
        let ranked = ModelStep.remembered(suggestions, sessionsInBlock: snapshot.sessionsStarting(in: gap), picks: snapshot.picks,
                                          preferences: preferences, reservedToday: snapshot.reservedCount(on: gap.date),
                                          ranker: onDeviceModel)
        if let ranked { AppModel.log(ranked.run) }
        return ranked
    }

    /// `suggestions` for `gap` after the on-device model's turn (`ModelStep`): what it ranks
    /// first, with its reasons, then the rest; or the list as it was. Run off the main actor,
    /// and stopped when the screen asking for it goes away.
    func modelRanking(of suggestions: [Suggestion], in gap: Gap) async -> RankedSuggestions {
        let snapshot = snapshot
        let preferences = preferences
        let ranker = onDeviceModel
        let work = Task.detached(priority: .userInitiated) {
            await ModelStep.rank(suggestions, sessionsInBlock: snapshot?.sessionsStarting(in: gap) ?? 0,
                                 picks: snapshot?.picks ?? [], preferences: preferences,
                                 reservedToday: snapshot?.reservedCount(on: gap.date) ?? 0, ranker: ranker)
        }
        let ranked = await withTaskCancellationHandler { await work.value } onCancel: { work.cancel() }
        AppModel.log(ranked.run)
        return ranked
    }

    /// One line per request to the model, on the phone only: its outcome and counts, never the
    /// prompt or the reasons (#193; Honeycomb comes in a later step).
    private static func log(_ run: ModelRun) {
        let outcome = run.outcome.rawValue
        let unavailable = run.unavailableReason ?? "-"
        let p = run.prompt
        let profile = p.map { "interests=\($0.profile.interestsNamed) levels=\($0.profile.levels?.rawValue ?? "-") formats=\($0.profile.formats?.rawValue ?? "-") skips=\($0.profile.skips) reservedToday=\($0.profile.reservedToday)" } ?? "-"
        modelLog.info("model outcome=\(outcome, privacy: .public) unavailable=\(unavailable, privacy: .public) estimated=\(p?.estimatedTokens ?? -1) window=\(p?.window ?? -1) answerReserve=\(p?.answerReserve ?? -1) headroom=\(p?.headroom ?? -1) promptTokens=\(run.modelPromptTokens ?? -1) answerTokens=\(run.modelAnswerTokens ?? -1) inBlock=\(p?.sessionsInBlock ?? -1) sent=\(p?.sessionsSent ?? -1) leftOut=\(p?.sessionsLeftOut ?? -1) abstractsCut=\(p?.abstractsCut ?? -1) profileTokens=\(p?.profileTokens ?? -1) \(profile, privacy: .public) placed=\(run.placed) ignored=\(run.ignored) remembered=\(run.remembered)")
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
            walkIns = []
            setSnapshot(nil)
            setBackend(nil)
            // Likewise the Calendar copy: it was the earlier attendee's choice, so it starts off,
            // and their calendar is never written to under this sign-in.
            resetCalendarExport()
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
        walkIns = []
        setSnapshot(nil)
        needsSignIn = false
        notice = nil
        setMode(.signedOut)
        // The Calendar copy was his choice: whoever signs in next starts with it off, and with a
        // calendar of their own. His is left in the Calendar app, his to keep or delete.
        resetCalendarExport()
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

    /// Reads his schedule again if it is old enough (`RefreshPlan.scheduleDue`), as the
    /// calendar does while it is open. Not while he is signing in (he may have left to read a
    /// code), nor once his saved sign-in is known to be rejected: that would only fail and ask
    /// again every few minutes.
    func refreshIfDue() async {
        let now = Date()
        guard started, mode != .signedOut, !isSigningIn, !needsSignIn,
              RefreshPlan.scheduleDue(snapshot, lastAttempt: lastAutomaticAttempt, catalogLastTried: catalogLastTried,
                                      now: now) else { return }
        lastAutomaticAttempt = now
        await refresh(automatic: true)
    }

    /// Reads his schedule, and the whole catalog when it is due or `wholeCatalog` asks for it
    /// (`Sync.update`). On any failure the calendar last seen is kept. `automatic` (he didn't
    /// ask) keeps a failure to reach the site quiet, unless he asks for an update while it runs.
    /// Stamped when the download starts, which can be well after the refresh began (an early
    /// download follows a schedule read), so the hour's wait runs from the try itself.
    private func recordCatalogTry(for asked: Int) {
        if generation == asked { catalogLastTried = Date() }
    }

    func refresh(automatic: Bool = false, wholeCatalog: Bool = false) async {
        let asked = generation
        guard let backend else { return }
        guard refreshingFor != asked else {
            if !automatic { refreshIsQuiet = false }
            return
        }
        refreshingFor = asked
        refreshIsQuiet = automatic
        isRefreshing = true
        defer {
            if refreshingFor == asked {
                refreshingFor = nil
                isRefreshing = false
            }
        }
        do {
            let now = Date()
            let version = snapshotVersion
            // Each catalog try is recorded as it starts, so one that fails or is cancelled still
            // waits an hour before the next try.
            let result = try await Sync.update(backend: backend, previous: snapshot, now: now, wholeCatalog: wholeCatalog,
                                               catalogLastTried: catalogLastTried,
                                               willTryCatalog: { [weak self] in await self?.recordCatalogTry(for: asked) })
            // An answer from a backend he has since left (signed out, signed in again,
            // switched to the sample) is dropped, even if the mode reads the same.
            guard generation == asked else { return }
            let new = Sync.landed(result.snapshot, current: snapshot, changedDuring: snapshotVersion != version)
            setSnapshot(new)
            needsSignIn = false
            if mode == .live { save(new) }
            // A failed second schedule read comes first: a rejected sign-in matters more.
            for problem in [result.scheduleProblem, result.catalogProblem].compactMap({ $0 })
            where RefreshPlan.shouldShow(problem, quiet: refreshIsQuiet) {
                report(problem)
                break
            }
        } catch is CancellationError {
            // The screen went away mid-refresh.
        } catch {
            guard generation == asked, RefreshPlan.shouldShow(error, quiet: refreshIsQuiet) else { return }
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
            updated.fetchedAt = Date()
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

    /// Goes up with every request to turn the Calendar copy on or off, so an older one still
    /// waiting on the permission prompt can tell it has been overtaken.
    @ObservationIgnored private var calendarRequest = 0
    /// Set when forgetting an earlier attendee's calendar record failed. Until a reset works,
    /// nothing is written: the old record must never be acted on for someone else.
    private var calendarNeedsReset = UserDefaults.standard.bool(forKey: "calendarNeedsReset") {
        didSet { UserDefaults.standard.set(calendarNeedsReset, forKey: "calendarNeedsReset") }
    }

    /// Turns the Apple Calendar copy off and forgets the app's calendar and record (the
    /// calendar stays in the Calendar app). Used whenever the attendee may have changed.
    private func resetCalendarExport() {
        calendarRequest += 1
        exportsToCalendar = false
        calendarExportStatus = nil
        calendarNeedsReset = !calendarExporter.forget()
    }

    /// Turns the Apple Calendar copy on (asking for permission, then writing it) or off. Off
    /// stops updates and leaves the calendar as it is.
    func setExportsToCalendar(_ on: Bool) async {
        calendarRequest += 1
        guard on else {
            exportsToCalendar = false
            calendarExportStatus = nil
            return
        }
        guard mode == .live, snapshot != nil else { return }
        let request = calendarRequest
        let asked = generation
        guard await calendarExporter.requestAccess() else {
            notice = "Session Planner can't add your sessions without access to Calendar. Allow it in the Settings app, under Privacy & Security, Calendars."
            return
        }
        // While the prompt was up he may have turned it off again, signed out, or signed in as
        // someone else, and the calendar may have been refreshed: act only if nothing changed,
        // and on the calendar as it is now.
        guard request == calendarRequest, generation == asked, mode == .live, let current = snapshot else { return }
        if calendarNeedsReset {
            guard calendarExporter.forget() else {
                notice = "Calendar can't be turned on: the app couldn't remove an earlier attendee's record of their calendar. Delete the app and install it again to clear it."
                return
            }
            calendarNeedsReset = false
        }
        // Turning it on is the way back from a record that can't be read (the notice asks him
        // to delete the old calendar first): it is discarded and a new calendar started.
        if calendarExporter.hasUnreadableRecord, !calendarExporter.forget() {
            notice = "Calendar can't be turned on: the app's record of its events can't be read or removed."
            return
        }
        exportsToCalendar = true
        exportToCalendar(current)
    }

    private func exportToCalendar(_ snapshot: PlanSnapshot) {
        guard exportsToCalendar, !calendarNeedsReset, mode == .live else { return }
        do {
            let count = try calendarExporter.sync(snapshot, calendarName: event.name, timeZone: event.timeZone)
            calendarExportStatus = Wording.calendarExport(count: count, calendar: event.name)
        } catch CalendarExporter.Failure.denied {
            exportsToCalendar = false
            calendarExportStatus = nil
            notice = "Calendar access was turned off, so your sessions are no longer kept in Calendar."
        } catch CalendarExporter.Failure.unwritableRecords {
            // Stop here: another update before the record is saved would add every event again.
            exportsToCalendar = false
            calendarExportStatus = nil
            notice = "Calendar updates are off: the app couldn't save its record of the events it added, so updating again could add them twice. Delete the “\(event.name)” calendar in the Calendar app, then turn this on again."
        } catch CalendarExporter.Failure.unreadableRecords {
            exportsToCalendar = false
            calendarExportStatus = nil
            notice = "Calendar updates are off: the app's record of its events can't be read. Delete the “\(event.name)” calendar in the Calendar app, then turn this on again to start a new one."
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
