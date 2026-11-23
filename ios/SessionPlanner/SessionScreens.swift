import PlannerCore
import SwiftUI

struct SessionDetailView: View {
    @Environment(AppModel.self) private var model
    let sessionID: String

    @State private var working = false
    @State private var confirmReserve = false
    @State private var confirmCancel = false

    var body: some View {
        if let session = model.sessionsByID[sessionID] {
            detail(session)
        } else {
            ContentUnavailableView("Session no longer listed", systemImage: "questionmark.circle",
                                   description: Text("The conference site no longer has this session."))
        }
    }

    @ViewBuilder
    private func detail(_ session: Session) -> some View {
        let commitment = model.commitment(of: sessionID)
        List {
            Section {
                VStack(alignment: .leading, spacing: 6) {
                    if let commitment {
                        Label(commitment.label, systemImage: commitment.symbol)
                            .font(.caption.bold())
                            .foregroundStyle(commitment.color)
                    }
                    Text(session.title).font(.title3.bold())
                    Text([session.abbreviation, session.type, session.level].compactMap { $0 }.joined(separator: " · "))
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
                if let time = session.sessionTime, let start = time.startMinute {
                    Label("\(Wording.day(time.date)), \(Wording.timeRange(start: start, end: start + time.lengthMinutes))",
                          systemImage: "clock")
                }
                if session.venue != nil || session.room != nil {
                    Label([session.venue, session.room].compactMap { $0 }.joined(separator: " · "), systemImage: "mappin.and.ellipse")
                }
                if let seats = Wording.seats(session, commitment: commitment) {
                    Label(seats, systemImage: "chair")
                }
            }

            Section {
                if commitment != .invited {
                    let isFavorite = model.snapshot?.schedule.favorites.contains(sessionID) ?? false
                    Button {
                        run { await model.setFavorite(session, !isFavorite) }
                    } label: {
                        Label(isFavorite ? "Remove from favorites" : "Add to favorites", systemImage: isFavorite ? "star.slash" : "star")
                    }
                }
                if commitment == .reserved {
                    Button(role: .destructive) {
                        confirmCancel = true
                    } label: {
                        Label("Cancel reservation", systemImage: "xmark.circle")
                    }
                    .confirmationDialog("Cancel your seat in \(session.code)?", isPresented: $confirmCancel, titleVisibility: .visible) {
                        Button("Cancel reservation", role: .destructive) { run { await model.cancelReservation(session) } }
                    } message: {
                        Text("This gives up the seat on the conference site. You may not get it back.")
                    }
                } else if session.isReservable == true, commitment != .invited {
                    Button {
                        confirmReserve = true
                    } label: {
                        Label("Reserve a seat", systemImage: "checkmark.seal")
                    }
                    .confirmationDialog("Reserve a seat in \(session.code)?", isPresented: $confirmReserve, titleVisibility: .visible) {
                        Button("Reserve") { run { await model.reserve(session) } }
                    } message: {
                        Text("This reserves the seat on the conference site.")
                    }
                }
            } footer: {
                if working { ProgressView() }
            }
            .disabled(working)

            if !session.speakerNames.isEmpty {
                Section("Speakers") {
                    ForEach(session.speakerNames, id: \.self) { Text($0) }
                }
            }
            if let abstract = session.abstract {
                Section("About") { Text(abstract) }
            }
            let tags = (session.topics ?? []) + (session.areasOfInterest ?? []) + (session.services ?? [])
            if !tags.isEmpty {
                Section("Topics") { Text(tags.joined(separator: ", ")).font(.subheadline) }
            }
        }
        .navigationTitle(session.code)
        .navigationBarTitleDisplayMode(.inline)
    }

    private func run(_ action: @escaping () async -> Void) {
        guard !working else { return }
        working = true
        Task {
            await action()
            working = false
        }
    }
}

struct SessionsScreen: View {
    @Environment(AppModel.self) private var model
    @State private var search = ""
    @State private var filter = Launch.string("shotFilter").flatMap(SessionFilter.init(rawValue:)) ?? .mine
    @State private var path: [String] = Launch.string("shotSession").map { [$0] } ?? []

    var body: some View {
        NavigationStack(path: $path) {
            let rows = model.sessions(matching: filter, search: search)
            List {
                if rows.isEmpty {
                    Text(model.snapshot == nil ? "No sessions loaded yet." : "No sessions match.")
                        .foregroundStyle(.secondary)
                }
                ForEach(rows) { session in
                    NavigationLink(value: session.sessionId) {
                        SessionRow(session: session, commitment: model.commitment(of: session.sessionId))
                    }
                }
            }
            .listStyle(.plain)
            .navigationTitle("Sessions")
            .navigationBarTitleDisplayMode(.inline)
            .navigationDestination(for: String.self) { SessionDetailView(sessionID: $0) }
            .searchable(text: $search, prompt: "Code, title, speaker or topic")
            .toolbar {
                ToolbarItem(placement: .principal) {
                    Picker("Show", selection: $filter) {
                        ForEach(SessionFilter.allCases) { Text($0.rawValue).tag($0) }
                    }
                    .pickerStyle(.segmented)
                    .frame(maxWidth: 320)
                }
            }
        }
    }
}

struct SessionRow: View {
    let session: Session
    let commitment: Commitment?

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 6) {
                if let commitment {
                    Image(systemName: commitment.symbol)
                        .foregroundStyle(commitment.color)
                        .accessibilityLabel(commitment.label)
                }
                Text(session.code).font(.subheadline.bold())
                Spacer()
                if let time = session.sessionTime, let start = time.startMinute {
                    Text("\(Wording.day(time.date)), \(Wording.clock(start))")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            if session.abbreviation != nil {
                Text(session.title).font(.subheadline).lineLimit(2)
            }
            Text([session.type, session.venue, Wording.seats(session, commitment: commitment)]
                .compactMap { $0 }.joined(separator: " · "))
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(1)
        }
        .padding(.vertical, 2)
    }
}

struct SettingsScreen: View {
    @Environment(AppModel.self) private var model
    @State private var confirmSignOut = false

    var body: some View {
        NavigationStack {
            Form {
                Section("Conference") {
                    LabeledContent("Event", value: model.event.name)
                    if let snapshot = model.snapshot {
                        LabeledContent("Reserved seats", value: "\(snapshot.schedule.reserved.count)")
                        LabeledContent("Invitations", value: "\(snapshot.schedule.invitedSessions.count)")
                        LabeledContent("Favorites", value: "\(snapshot.schedule.favorites.count)")
                        LabeledContent("Sessions in catalog", value: "\(snapshot.sessions.count)")
                        if model.unresolvedCount > 0 {
                            LabeledContent("No longer listed", value: "\(model.unresolvedCount)")
                        }
                        if snapshot.skipped + snapshot.schedule.skipped > 0 {
                            LabeledContent("Unreadable entries skipped", value: "\(snapshot.skipped + snapshot.schedule.skipped)")
                        }
                        LabeledContent("Updated") {
                            Text(snapshot.fetchedAt, format: .relative(presentation: .named))
                        }
                    }
                    Button("Update now") { Task { await model.refresh() } }
                        .disabled(model.isRefreshing)
                }

                Section {
                    Toggle("Add reserved sessions to Calendar", isOn: Binding(
                        get: { model.exportsToCalendar },
                        set: { on in Task { await model.setExportsToCalendar(on) } }))
                        .disabled(model.mode != .live)
                    if let status = model.calendarExportStatus {
                        Text(status).font(.footnote)
                    }
                } header: {
                    Text("Apple Calendar")
                } footer: {
                    Text(model.mode == .live
                         ? "Your reserved sessions go in a calendar of their own, “\(model.event.name)”, and stay matched as your schedule changes. Turning this off stops the updates; delete that calendar in the Calendar app to remove the events. Nothing is sent anywhere."
                         : "Not available for the sample conference.")
                }

                Section("Account") {
                    if model.mode == .demo {
                        Text("You are looking at a made-up sample conference. Nothing is sent to any conference site.")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                        Button("Sign in with AWS Builder ID") { Task { await model.signIn() } }
                        Button("Leave the sample conference", role: .destructive) { model.leaveDemo() }
                    } else {
                        if model.needsSignIn {
                            Button("Sign in again") { Task { await model.signIn() } }
                        } else {
                            Label("Signed in with AWS Builder ID", systemImage: "person.crop.circle.badge.checkmark")
                        }
                        Button("Sign out", role: .destructive) { confirmSignOut = true }
                            .confirmationDialog("Sign out?", isPresented: $confirmSignOut, titleVisibility: .visible) {
                                Button("Sign out", role: .destructive) { Task { await model.signOut() } }
                            } message: {
                                Text("This removes your sign-in and saved calendar from this phone. Your schedule on the conference site is not changed.")
                            }
                        Link("Manage your Builder ID sessions", destination: URL(string: "https://profile.aws.amazon.com")!)
                    }
                }

                Section("Privacy") {
                    Text("Your sign-in is kept in this phone's keychain and your schedule is saved only on this phone. The app talks only to the AWS Events service. It has no analytics, no ads and no server of its own.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }

                Section("About") {
                    Text("Session Planner is an independent app. It is not affiliated with, sponsored by or endorsed by Amazon Web Services. Session information is provided by the AWS Events API.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                    LabeledContent("Version", value: Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "")
                }
            }
            .navigationTitle("Settings")
        }
    }
}
