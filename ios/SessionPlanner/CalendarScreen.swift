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
                        // The VoiceOver "Next day" / "Previous day" actions: move, then say where
                        // he landed, since focus stays on the chip he started from.
                        let move = { (offset: Int) in
                            let target = DayNavigation.day(from: day, by: offset, in: days)
                            withAnimation { selectedDay = target }
                            AccessibilityNotification.Announcement(Wording.day(target)).post()
                        }
                        VStack(spacing: 0) {
                            DayStrip(days: days, busy: Set(model.committedDays), selected: day, move: move) { picked in
                                withAnimation { selectedDay = picked }
                            }
                            Divider()
                            // The actual time: the timeline's tick is the start of the minute,
                            // which can be earlier than an update made within it.
                            Text(Wording.calendarStatus(refreshing: model.isRefreshing, fetchedAt: snapshot.fetchedAt,
                                                        now: Date(), sample: model.mode == .demo))
                                .font(.caption)
                                .foregroundStyle(.secondary)
                                .multilineTextAlignment(.center)
                                .frame(maxWidth: .infinity)
                                .padding(.horizontal)
                                .padding(.vertical, 4)
                            TabView(selection: Binding(get: { day }, set: { selectedDay = $0 })) {
                                ForEach(days, id: \.self) { page in
                                    DayPage(snapshot: snapshot, day: page, now: now)
                                        .tag(page)
                                }
                            }
                            .tabViewStyle(.page(indexDisplayMode: .never))
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
            // While the calendar is open, his schedule is read again every few minutes
            // (`RefreshPlan`); the check itself sends nothing until one is due.
            .task {
                while !Task.isCancelled {
                    await model.refreshIfDue()
                    try? await Task.sleep(for: .seconds(60))
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
                        // VoiceOver takes over swipes, so the selected day offers the same moves
                        // as actions. Only the selected chip has them, so they always move from
                        // the day the chip names.
                        .accessibilityActions {
                            if isSelected {
                                Button("Next day") { move(1) }
                                Button("Previous day") { move(-1) }
                            }
                        }
                    }
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 6)
            }
            // Keep the selected day in view when a swipe moves it off the edge of the strip.
            // Deferred a turn so the chips are laid out before scrolling to one.
            .onAppear { DispatchQueue.main.async { strip.scrollTo(selected, anchor: .center) } }
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

/// One page of the day pager. It builds its own day's agenda when it is drawn, so the pages
/// SwiftUI hasn't drawn cost nothing.
private struct DayPage: View {
    @Environment(AppModel.self) private var model
    let snapshot: PlanSnapshot
    let day: String
    /// The event's date and minute now.
    let now: (date: String, minute: Int)

    var body: some View {
        DayView(agenda: snapshot.agenda(on: day, includeFavorites: model.showFavorites,
                                        index: model.sessionsByID, commitments: model.commitmentsByID),
                gaps: snapshot.offeredGaps(on: day, now: now, index: model.sessionsByID, commitments: model.commitmentsByID),
                span: snapshot.offeredGaps(on: day, index: model.sessionsByID, commitments: model.commitmentsByID),
                nowMinute: PlanSnapshot.minute(of: now, on: day))
            .refreshable { await model.refresh() }
    }
}

/// A free stretch the attendee opened, as a sheet item.
private struct OpenGap: Identifiable {
    let gap: Gap
    var id: String { "\(gap.date) \(gap.start)" }
}

private struct DayView: View {
    let agenda: DayAgenda
    let gaps: [Gap]
    /// The day's free stretches before any are cut at the current minute: they set how much of
    /// the day the timeline shows, so it doesn't shrink as time passes.
    let span: [Gap]
    let nowMinute: Int?

    @State private var openGap: OpenGap?

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
                    ForEach(gaps, id: \.end) { gap in
                        Button {
                            openGap = OpenGap(gap: gap)
                        } label: {
                            Label("\(Wording.gap(gap)): see sessions that fit", systemImage: "sparkles")
                        }
                        .frame(maxWidth: .infinity)
                    }
                } else {
                    Timeline(entries: agenda.commitments, favorites: agenda.favoriteBuckets, gaps: gaps,
                             span: span, nowMinute: nowMinute) { openGap = OpenGap(gap: $0) }
                }
            }
            .padding(12)
        }
        // The list follows the stretch as time passes, and closes once it is no longer offered.
        .sheet(item: $openGap) { GapSheet(gap: $0.gap.current(in: gaps) ?? $0.gap) }
        .onChange(of: gaps) {
            if let open = openGap, open.gap.current(in: gaps) == nil { openGap = nil }
        }
        // For App Store screenshots (debug builds only): `-shotGap 2027-03-09` opens that day's
        // first free stretch.
        .onAppear {
            if openGap == nil, let gap = GapStaging.gapToOpen(requestedDay: Launch.string("shotGap"), in: gaps) {
                openGap = OpenGap(gap: gap)
            }
        }
    }
}

/// The sessions that fit one free stretch, most like his picks first, each leading to the
/// session itself.
private struct GapSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let gap: Gap
    /// The list and the stretch it was worked out for.
    @State private var loaded: GapSuggestions?
    /// The on-device model's last answer, and the stretch it ranked.
    @State private var ranked: (gap: Gap, run: ModelRun)?
    /// The stretch the on-device model is ranking now.
    @State private var ranking: Gap?

    var body: some View {
        // Shown only for the stretch as it is now: while a newer one loads, the old list goes.
        let suggestions = loaded?.list(for: gap)
        NavigationStack {
            Group {
                if let suggestions, suggestions.isEmpty {
                    ContentUnavailableView("Nothing fits", systemImage: "calendar.badge.clock",
                                           description: Text("No session in this time is like your picks and leaves time for the walks and the line."))
                } else if let suggestions {
                    List {
                        Section {
                            ForEach(suggestions) { suggestion in
                                NavigationLink(value: suggestion.id) {
                                    SuggestionRow(suggestion: suggestion)
                                }
                            }
                        } header: {
                            if let header = Wording.rankingHeader(for: gap, ranking: ranking, ranked: ranked) {
                                Label {
                                    Text(header)
                                } icon: {
                                    ModelWorkingIcon(working: ranking == gap)
                                }
                            }
                        }
                    }
                    .listStyle(.plain)
                } else {
                    ProgressView()
                }
            }
            .navigationTitle(Wording.gap(gap))
            .navigationBarTitleDisplayMode(.inline)
            .navigationDestination(for: String.self) { SessionDetailView(sessionID: $0) }
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
            }
        }
        .task(id: gap) {
            let version = model.snapshotVersion
            let found = await model.suggestions(in: gap)
            // A newer stretch has replaced this one: its own task sets the list. A list worked
            // out from a calendar since replaced isn't ranked against the new one's picks (the
            // sheet is closing).
            guard !Task.isCancelled, model.snapshotVersion == version else { return }
            // What the on-device model already ranked shows at once, so a stretch reloading on
            // the minute doesn't fall back to the usual order and back again.
            if let remembered = model.rememberedRanking(of: found, in: gap) {
                loaded = GapSuggestions(gap: gap, suggestions: remembered.suggestions)
                ranked = (gap, remembered.run)
                return
            }
            loaded = GapSuggestions(gap: gap, suggestions: found)
            // Then the on-device model's turn, where the phone has one.
            guard model.willRankWithModel(found) else { return }
            ranking = gap
            let result = await model.modelRanking(of: found, in: gap)
            if ranking == gap { ranking = nil }
            guard !Task.isCancelled, model.snapshotVersion == version else { return }
            loaded = GapSuggestions(gap: gap, suggestions: result.suggestions)
            ranked = (gap, result.run)
        }
        // Reserving one of these (from its page) changes the calendar: this stretch may no
        // longer be free, so the list closes rather than offer what no longer fits.
        .onChange(of: model.snapshotVersion) { dismiss() }
    }
}

private struct SuggestionRow: View {
    let suggestion: Suggestion

    var body: some View {
        let session = suggestion.session
        VStack(alignment: .leading, spacing: 3) {
            Text(session.code).font(.caption.bold()).foregroundStyle(.secondary)
            Text(session.title).font(.subheadline)
            if let time = session.sessionTime, let start = time.startMinute {
                Text([Wording.timeRange(start: start, end: start + time.lengthMinutes), session.venue]
                    .compactMap { $0 }.joined(separator: " · "))
                    .font(.caption).foregroundStyle(.secondary)
            }
            if let reasons = Wording.reasons(suggestion) {
                Text(reasons).font(.caption)
            }
            Text(Wording.outlook(suggestion)).font(.caption).foregroundStyle(.tint)
        }
        .accessibilityElement(children: .combine)
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
    let gaps: [Gap]
    /// The free stretches before any are cut at the current minute, for the timeline's extent.
    let span: [Gap]
    let nowMinute: Int?
    let openGap: (Gap) -> Void

    @State private var openBucket: FavoriteBucket?

    private let hourHeight: CGFloat = 72
    @ScaledMetric(relativeTo: .caption2) private var scaledGutter: CGFloat = 50
    private var gutter: CGFloat { CalendarLayout.hourColumnWidth(scaled: scaledGutter) }
    private let laneWidth: CGFloat = 76
    /// Each hour label's rendered height, by hour. The timeline is padded at the top and bottom
    /// by however far the first and last labels stick out of their 12 pt rows.
    @State private var labelHeights: [Int: CGFloat] = [:]

    var body: some View {
        // Free stretches count too: the last one can run past his last commitment.
        let starts = entries.map(\.arrival) + favorites.map { $0.hour * 60 } + span.map(\.start)
        let ends = entries.map(\.drawnEnd) + favorites.map { ($0.hour + 1) * 60 } + span.map(\.end)
        let first = max(0, (starts.min() ?? 480) / 60 - 1)
        let last = max(first + 1, ((ends.max() ?? 1080) + 59) / 60)
        let placements = Dictionary(uniqueKeysWithValues:
            CalendarLayout.place(entries.map { (id: $0.id, start: $0.arrival, end: $0.drawnEnd) }).map { ($0.id, $0) })

        GeometryReader { geometry in
            let lane = favorites.isEmpty ? 0 : laneWidth
            let width = max(0, geometry.size.width - gutter - lane)
            ZStack(alignment: .topLeading) {
                ForEach(first...last, id: \.self) { hour in
                    HStack(spacing: 6) {
                        Text(hourLabel(hour))
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                            .minimumScaleFactor(0.5)
                            .fixedSize(horizontal: false, vertical: true) // shrink for width only
                            .onGeometryChange(for: CGFloat.self, of: { $0.size.height }) { labelHeights[hour] = $0 }
                            .frame(width: gutter - 6, alignment: .trailing)
                        Rectangle().fill(.quaternary).frame(height: 1)
                    }
                    // A fixed height keeps the line on the hour however tall the label is;
                    // a taller label overflows evenly above and below it.
                    .frame(height: 12)
                    .offset(y: y(hour * 60, first) - 6)
                }
                ForEach(entries) { entry in
                    let placement = placements[entry.id] ?? Placement(id: entry.id, column: 0, columns: 1)
                    let columnWidth = width / CGFloat(placement.columns)
                    if entry.arrival < entry.start {
                        ArrivalBand(entry: entry)
                            .frame(width: max(0, columnWidth - 3), height: CGFloat(entry.start - entry.arrival) / 60 * hourHeight)
                            .offset(x: gutter + CGFloat(placement.column) * columnWidth, y: y(entry.arrival, first))
                    }
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
                ForEach(gaps, id: \.end) { gap in
                    Button {
                        openGap(gap)
                    } label: {
                        GapBlock(gap: gap)
                    }
                    .buttonStyle(.plain)
                    .frame(width: max(0, width - 3), height: max(20, CGFloat(gap.end - gap.start) / 60 * hourHeight - 3))
                    .offset(x: gutter, y: y(gap.start, first))
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
        .padding(.top, overhang(first))
        .padding(.bottom, overhang(last))
        .sheet(item: $openBucket) { bucket in
            FavoriteBucketSheet(bucket: bucket)
        }
    }

    private func overhang(_ hour: Int) -> CGFloat {
        CalendarLayout.hourLabelOverhang(labelHeight: labelHeights[hour] ?? 0)
    }

    private func y(_ minute: Int, _ firstHour: Int) -> CGFloat {
        CGFloat(minute - firstHour * 60) / 60 * hourHeight + 6
    }

    private func hourLabel(_ hour: Int) -> String {
        let h = hour % 24
        return "\(h % 12 == 0 ? 12 : h % 12) \(h < 12 ? "AM" : "PM")"
    }
}

/// A free stretch on the timeline: a dashed outline that opens the sessions that fit it.
private struct GapBlock: View {
    let gap: Gap

    var body: some View {
        Label(Wording.gap(gap), systemImage: "sparkles")
            .font(.caption)
            .foregroundStyle(.tint)
            .lineLimit(1)
            .padding(6)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            .overlay {
                RoundedRectangle(cornerRadius: 8)
                    .strokeBorder(.tint.opacity(0.5), style: StrokeStyle(lineWidth: 1, dash: [4, 3]))
            }
            .contentShape(Rectangle())
            .accessibilityHint("Shows sessions that fit")
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

/// The minutes before a reserved seat when he must be there, in a lighter shade of its color.
private struct ArrivalBand: View {
    let entry: AgendaEntry

    var body: some View {
        let text = Wording.beThere(by: entry.arrival)
        Text(text)
            .font(.caption2.bold())
            .lineLimit(1)
            .minimumScaleFactor(0.6)
            .padding(.horizontal, 6)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
            .foregroundStyle(entry.commitment.color)
            .background(entry.commitment.color.opacity(0.22), in: UnevenRoundedRectangle(topLeadingRadius: 8, topTrailingRadius: 8))
            .accessibilityLabel("\(text), \(entry.session.code)")
    }
}

private struct EntryBlock: View {
    let entry: AgendaEntry
    let narrow: Bool

    var body: some View {
        let color = entry.commitment.color
        // A walk-in is drawn like a seat, but tinted and dashed: there is no seat held for him.
        let solid = entry.commitment == .reserved || entry.commitment == .invited
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

/// The Apple Intelligence mark beside the ranking header; it spins while the model is ranking.
private struct ModelWorkingIcon: View {
    let working: Bool

    var body: some View {
        let image = Image(systemName: "apple.intelligence")
        if #available(iOS 18, *) {
            image.symbolEffect(.rotate, options: .repeat(.continuous), isActive: working)
        } else {
            image.symbolEffect(.pulse, options: .repeating, isActive: working)
        }
    }
}
