import PlannerCore
import SwiftUI

struct CalendarScreen: View {
    @Environment(AppModel.self) private var model
    @State private var selectedDay: String? = Launch.string("shotDay")

    var body: some View {
        @Bindable var model = model
        NavigationStack {
            // Redrawn every minute while on screen, so the "now" line moves and the day to
            // open on rolls over at midnight in the conference's time zone.
            TimelineView(.everyMinute) { clock in
                if let snapshot = model.snapshot {
                    let days = model.days
                    let now = model.eventNow(at: clock.date)
                    if days.isEmpty {
                        ContentUnavailableView("No sessions yet", systemImage: "calendar",
                                               description: Text("The conference site has not published any timed sessions."))
                    } else {
                        let day = selectedDay.flatMap { days.contains($0) ? $0 : nil }
                            ?? snapshot.defaultDay(today: now.date) ?? days[0]
                        // One page per day: a horizontal swipe moves a day, a vertical drag scrolls
                        // the day, and the pager stops at the first and last day.
                        let move = { (offset: Int) in
                            withAnimation { selectedDay = DayNavigation.day(from: day, by: offset, in: days) }
                        }
                        VStack(spacing: 0) {
                            DayStrip(days: days, busy: Set(model.committedDays), selected: day, move: move) { picked in
                                withAnimation { selectedDay = picked }
                            }
                            Divider()
                            TabView(selection: Binding(get: { day }, set: { selectedDay = $0 })) {
                                ForEach(days, id: \.self) { page in
                                    DayView(agenda: snapshot.agenda(on: page, includeFavorites: model.showFavorites,
                                                                    index: model.sessionsByID, commitments: model.commitmentsByID),
                                            nowMinute: now.date == page ? now.minute : nil)
                                        .refreshable { await model.refresh() }
                                        .tag(page)
                                }
                            }
                            .tabViewStyle(.page(indexDisplayMode: .never))
                            // VoiceOver takes over swipes, so the same moves are offered as actions.
                            .accessibilityAction(named: "Next day") { move(1) }
                            .accessibilityAction(named: "Previous day") { move(-1) }
                        }
                    }
                } else if model.isRefreshing {
                    ProgressView("Loading your calendar…")
                } else {
                    ContentUnavailableView {
                        Label("No calendar yet", systemImage: "calendar")
                    } description: {
                        Text("Update to load your schedule from the conference site.")
                    } actions: {
                        Button("Update") { Task { await model.refresh() } }
                    }
                }
            }
            .navigationTitle(model.event.name)
            .navigationBarTitleDisplayMode(.inline)
            .navigationDestination(for: String.self) { SessionDetailView(sessionID: $0) }
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Toggle(isOn: $model.showFavorites) {
                        Label("Show favorites", systemImage: model.showFavorites ? "star.fill" : "star")
                    }
                    .toggleStyle(.button)
                }
                ToolbarItem(placement: .topBarTrailing) {
                    if model.isRefreshing {
                        ProgressView()
                    } else {
                        Button {
                            Task { await model.refresh() }
                        } label: {
                            Label("Update", systemImage: "arrow.clockwise")
                        }
                    }
                }
            }
        }
    }
}

private struct DayStrip: View {
    let days: [String]
    let busy: Set<String>
    let selected: String
    let move: (Int) -> Void
    let select: (String) -> Void

    var body: some View {
        ScrollViewReader { strip in
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(days, id: \.self) { day in
                        let chip = Wording.dayChip(day)
                        let isSelected = day == selected
                        // Selected: a solid accent chip with bold text in the background colour (white
                        // in light mode, black in dark mode), so shape and weight mark it, not tint alone.
                        // Contrast of that text on AccentColor: 5.8:1 light, 7.2:1 dark (WCAG AA). A
                        // fixed white would be 2.9:1 on the lighter dark-mode accent.
                        let ink: Color = isSelected ? Color(uiColor: .systemBackground) : .primary
                        let dot: Color = isSelected ? ink : .accentColor
                        Button {
                            select(day)
                        } label: {
                            VStack(spacing: 2) {
                                ChipText(text: chip.weekday, font: .caption, bold: isSelected)
                                ChipText(text: chip.number, font: .headline, bold: isSelected)
                                Circle()
                                    .fill(dot)
                                    .frame(width: 5, height: 5)
                                    .opacity(busy.contains(day) ? 1 : 0)
                            }
                            .foregroundStyle(ink)
                            .padding(.horizontal, 6)
                            .frame(minWidth: 48, minHeight: 56)
                            .background(isSelected ? Color.accentColor : .clear, in: RoundedRectangle(cornerRadius: 10))
                            .contentShape(RoundedRectangle(cornerRadius: 10))
                        }
                        .buttonStyle(.plain)
                        .id(day)
                        .accessibilityLabel(Wording.day(day))
                        .accessibilityAddTraits(day == selected ? .isSelected : [])
                        .accessibilityAction(named: "Next day") { move(1) }
                        .accessibilityAction(named: "Previous day") { move(-1) }
                    }
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 6)
            }
            // Keep the selected day in view when a swipe moves it off the edge of the strip.
            .onAppear { strip.scrollTo(selected, anchor: .center) }
            .onChange(of: selected) { _, day in
                withAnimation { strip.scrollTo(day, anchor: .center) }
            }
        }
    }
}

/// Chip text that is bold when selected but always takes the bold width, so selecting a day
/// doesn't widen its chip and push the others sideways at large Dynamic Type sizes.
private struct ChipText: View {
    let text: String
    let font: Font
    let bold: Bool

    var body: some View {
        Text(text).font(font.weight(.bold)).hidden()
            .overlay { Text(text).font(font.weight(bold ? .bold : .regular)) }
    }
}

private struct DayView: View {
    let agenda: DayAgenda
    let nowMinute: Int?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 10) {
                ForEach(agenda.warnings) { warning in
                    WarningRow(warning: warning, agenda: agenda)
                }
                if !agenda.allDay.isEmpty {
                    VStack(alignment: .leading, spacing: 6) {
                        Text("All day").font(.caption).foregroundStyle(.secondary)
                        ForEach(agenda.allDay) { entry in
                            NavigationLink(value: entry.id) {
                                Label(entry.session.title, systemImage: entry.commitment.symbol)
                                    .font(.subheadline)
                                    .lineLimit(1)
                            }
                        }
                    }
                }
                if agenda.timed.isEmpty {
                    Text("Nothing on your calendar this day.")
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity)
                        .padding(.top, 40)
                } else {
                    Timeline(entries: agenda.commitments, favorites: agenda.favoriteBuckets, nowMinute: nowMinute)
                }
            }
            .padding(12)
        }
    }
}

private struct WarningRow: View {
    let warning: TransferWarning
    let agenda: DayAgenda

    var body: some View {
        let from = agenda.timed.first { $0.id == warning.fromID }?.session.code ?? ""
        let to = agenda.timed.first { $0.id == warning.toID }?.session.code ?? ""
        let gap = warning.gapMinutes <= 0 ? "No time" : "Only \(warning.gapMinutes) min"
        Label("\(gap) to get from \(warning.fromVenue) to \(warning.toVenue) (\(from) → \(to))",
              systemImage: "figure.walk.motion")
            .font(.footnote)
            .foregroundStyle(.red)
            .padding(10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(.red.opacity(0.1), in: RoundedRectangle(cornerRadius: 10))
    }
}

/// The day drawn as a timeline: hours down the side, commitments as blocks (clashes side by
/// side), and favorites as one marker per hour in a narrow lane on the right.
private struct Timeline: View {
    let entries: [AgendaEntry]
    let favorites: [FavoriteBucket]
    let nowMinute: Int?

    @State private var openBucket: FavoriteBucket?

    private let hourHeight: CGFloat = 72
    private let gutter: CGFloat = 50
    private let laneWidth: CGFloat = 76

    var body: some View {
        let starts = entries.map(\.start) + favorites.map { $0.hour * 60 }
        let ends = entries.map(\.drawnEnd) + favorites.map { ($0.hour + 1) * 60 }
        let first = max(0, (starts.min() ?? 480) / 60 - 1)
        let last = max(first + 1, ((ends.max() ?? 1080) + 59) / 60)
        let placements = Dictionary(uniqueKeysWithValues:
            CalendarLayout.place(entries.map { (id: $0.id, start: $0.start, end: $0.drawnEnd) }).map { ($0.id, $0) })

        GeometryReader { geometry in
            let lane = favorites.isEmpty ? 0 : laneWidth
            let width = max(0, geometry.size.width - gutter - lane)
            ZStack(alignment: .topLeading) {
                ForEach(first...last, id: \.self) { hour in
                    HStack(spacing: 6) {
                        Text(hourLabel(hour))
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                            .frame(width: gutter - 6, alignment: .trailing)
                        Rectangle().fill(.quaternary).frame(height: 1)
                    }
                    .offset(y: y(hour * 60, first) - 6)
                }
                ForEach(entries) { entry in
                    let placement = placements[entry.id] ?? Placement(id: entry.id, column: 0, columns: 1)
                    let columnWidth = width / CGFloat(placement.columns)
                    NavigationLink(value: entry.id) {
                        EntryBlock(entry: entry, narrow: placement.columns > 2)
                    }
                    .buttonStyle(.plain)
                    .frame(width: max(0, columnWidth - 3), height: max(20, CGFloat(entry.drawnEnd - entry.start) / 60 * hourHeight - 3))
                    .offset(x: gutter + CGFloat(placement.column) * columnWidth, y: y(entry.start, first))
                }
                ForEach(favorites) { bucket in
                    Button {
                        openBucket = bucket
                    } label: {
                        FavoriteMarker(bucket: bucket)
                    }
                    .buttonStyle(.plain)
                    .frame(width: lane - 6, height: hourHeight - 6)
                    .offset(x: gutter + width + 6, y: y(bucket.hour * 60, first) + 2)
                }
                if let nowMinute, nowMinute >= first * 60, nowMinute <= last * 60 {
                    Rectangle()
                        .fill(.red)
                        .frame(width: width + lane, height: 2)
                        .offset(x: gutter, y: y(nowMinute, first))
                        .accessibilityLabel("Now")
                }
            }
        }
        .frame(height: CGFloat(last - first) * hourHeight + 12)
        .sheet(item: $openBucket) { bucket in
            FavoriteBucketSheet(bucket: bucket)
        }
    }

    private func y(_ minute: Int, _ firstHour: Int) -> CGFloat {
        CGFloat(minute - firstHour * 60) / 60 * hourHeight + 6
    }

    private func hourLabel(_ hour: Int) -> String {
        let h = hour % 24
        return "\(h % 12 == 0 ? 12 : h % 12) \(h < 12 ? "AM" : "PM")"
    }
}

/// One hour's favorites: a count, plus the codes when there are only one or two.
private struct FavoriteMarker: View {
    let bucket: FavoriteBucket

    var body: some View {
        let color = Commitment.favorite.color
        VStack(spacing: 2) {
            Label("\(bucket.entries.count)", systemImage: "star.fill")
                .font(.caption.bold())
                .foregroundStyle(color)
            if bucket.entries.count <= 2 {
                ForEach(bucket.entries) { entry in
                    Text(entry.session.code).font(.caption2).lineLimit(1).minimumScaleFactor(0.7)
                }
            }
        }
        .padding(4)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(color.opacity(0.14), in: RoundedRectangle(cornerRadius: 8))
        .overlay {
            RoundedRectangle(cornerRadius: 8).strokeBorder(color.opacity(0.5), style: StrokeStyle(lineWidth: 1, dash: [4, 3]))
        }
        .contentShape(Rectangle())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(bucket.entries.count) favorites starting in the \(Wording.clock(bucket.hour * 60)) hour")
    }
}

/// The favorites behind one marker, as a list that leads to each session.
private struct FavoriteBucketSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let bucket: FavoriteBucket

    var body: some View {
        NavigationStack {
            List(bucket.entries) { entry in
                NavigationLink(value: entry.id) {
                    SessionRow(session: entry.session, commitment: model.commitment(of: entry.id))
                }
            }
            .listStyle(.plain)
            .navigationTitle("Favorites, \(Wording.clock(bucket.hour * 60))")
            .navigationBarTitleDisplayMode(.inline)
            .navigationDestination(for: String.self) { SessionDetailView(sessionID: $0) }
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) { Button("Done") { dismiss() } }
            }
        }
        .presentationDetents([.medium, .large])
        .presentationBackground(Color(.systemBackground))
    }
}

private struct EntryBlock: View {
    let entry: AgendaEntry
    let narrow: Bool

    var body: some View {
        let color = entry.commitment.color
        let solid = entry.commitment != .favorite
        VStack(alignment: .leading, spacing: 2) {
            Text(entry.session.code)
                .font(.caption.bold())
                .lineLimit(1)
            if !narrow || entry.session.abbreviation == nil {
                Text(entry.session.title)
                    .font(.caption)
                    .lineLimit(2)
            }
            Text([Wording.clock(entry.start), entry.session.venue, entry.session.room]
                .compactMap { $0 }.joined(separator: " · "))
                .font(.caption2)
                .lineLimit(narrow ? 1 : 2)
                .opacity(0.85)
        }
        .padding(6)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .foregroundStyle(solid ? Color.white : Color.primary)
        .background(solid ? color : color.opacity(0.16), in: RoundedRectangle(cornerRadius: 8))
        .background(Color(.systemBackground), in: RoundedRectangle(cornerRadius: 8))
        .overlay {
            if !solid {
                RoundedRectangle(cornerRadius: 8).strokeBorder(color.opacity(0.6), style: StrokeStyle(lineWidth: 1, dash: [4, 3]))
            }
        }
        .clipped()
        .contentShape(Rectangle())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(entry.commitment.label): \(entry.session.code), \(entry.session.title), \(Wording.timeRange(start: entry.start, end: entry.end))")
    }
}
