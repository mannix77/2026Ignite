import PlannerCore
import SwiftUI

@main
struct SessionPlannerApp: App {
    @State private var model = AppModel()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(model)
                .task { await model.start() }
        }
    }
}

/// Launch arguments that stage a screen for App Store screenshots, for example
/// `-mode demo -shotTab sessions`. Debug builds only: a release build ignores them.
enum Launch {
    static func string(_ key: String) -> String? {
        #if DEBUG
        return UserDefaults.standard.string(forKey: key)
        #else
        return nil
        #endif
    }
}

struct RootView: View {
    @Environment(AppModel.self) private var model
    @State private var tab = Launch.string("shotTab") ?? "calendar"

    var body: some View {
        @Bindable var model = model
        Group {
            if model.mode == .signedOut {
                WelcomeView()
            } else {
                TabView(selection: $tab) {
                    CalendarScreen()
                        .tabItem { Label("Calendar", systemImage: "calendar") }
                        .tag("calendar")
                    SessionsScreen()
                        .tabItem { Label("Sessions", systemImage: "list.bullet") }
                        .tag("sessions")
                    SettingsScreen()
                        .tabItem { Label("Settings", systemImage: "gearshape") }
                        .tag("settings")
                }
            }
        }
        .alert("Session Planner", isPresented: Binding(get: { model.notice != nil }, set: { if !$0 { model.notice = nil } })) {
            if model.needsSignIn {
                Button("Sign in again") { Task { await model.signIn() } }
                Button("Not now", role: .cancel) {}
            } else {
                Button("OK", role: .cancel) {}
            }
        } message: {
            Text(model.notice ?? "")
        }
    }
}

struct WelcomeView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        VStack(spacing: 24) {
            Spacer()
            Image(systemName: "calendar.badge.clock")
                .font(.system(size: 64))
                .foregroundStyle(.tint)
                .accessibilityHidden(true)
            Text("Session Planner")
                .font(.largeTitle.bold())
            Text("Your reserved seats, invitations and favorites from the conference site, as a calendar. Sign in once and it stays up to date.")
                .multilineTextAlignment(.center)
                .foregroundStyle(.secondary)
            Spacer()
            Button {
                Task { await model.signIn() }
            } label: {
                HStack {
                    if model.isSigningIn { ProgressView().tint(.white) }
                    Text("Sign in with AWS Builder ID")
                }
                .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
            .disabled(model.isSigningIn)

            Button("Try the sample conference") {
                Task { await model.startDemo() }
            }
            .controlSize(.large)

            Text("For AWS re:Invent 2026 attendees. You sign in on AWS's own page; this app never sees your password. Not affiliated with or endorsed by Amazon Web Services.")
                .font(.footnote)
                .multilineTextAlignment(.center)
                .foregroundStyle(.secondary)
        }
        .padding(24)
    }
}

/// Colors and labels for how firmly a session is on the calendar.
extension Commitment {
    var label: String {
        switch self {
        case .reserved: "Reserved"
        case .invited: "Invited"
        case .walkIn: "Walk-in"
        case .favorite: "Favorite"
        }
    }

    var symbol: String {
        switch self {
        case .reserved: "checkmark.seal.fill"
        case .invited: "envelope.fill"
        case .walkIn: "figure.walk"
        case .favorite: "star.fill"
        }
    }

    var color: Color {
        switch self {
        case .reserved: .accentColor
        case .invited: .purple
        case .walkIn: .teal
        case .favorite: .orange
        }
    }
}
