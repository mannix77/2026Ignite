import Foundation

/// Where one block sits across the width of a day: column `column` of `columns`.
public struct Placement: Equatable, Sendable {
    public var id: String
    public var column: Int
    public var columns: Int

    public init(id: String, column: Int, columns: Int) {
        self.id = id
        self.column = column
        self.columns = columns
    }
}

public enum CalendarLayout {
    /// The width of the hour column down the side of the timeline, given the width the text
    /// size asks for (50 points scaled with the hour labels' text style). It grows with larger
    /// text so "12 PM" stays on one line, but never past 88 points, which leaves the sessions
    /// most of the width; past that the label shrinks to fit. It never goes below 50, so the
    /// standard and smaller sizes look as they always did.
    public static func hourColumnWidth(scaled: Double) -> Double {
        min(max(scaled, standardHourColumn), widestHourColumn)
    }

    /// How far an hour label sticks out above (and below) its 12 pt row, given the label's
    /// height. The timeline is padded by this at its top and bottom so the first and last
    /// labels don't run into what sits around it.
    public static func hourLabelOverhang(labelHeight: Double) -> Double {
        max(0, labelHeight / 2 - hourLabelRow / 2)
    }

    static let hourLabelRow: Double = 12

    static let standardHourColumn: Double = 50
    static let widestHourColumn: Double = 88

    /// Places blocks side by side when they overlap. Blocks that only touch (one ends as the
    /// next starts) do not overlap. Every block in a run of overlapping blocks gets the same
    /// number of columns, so widths line up.
    public static func place(_ items: [(id: String, start: Int, end: Int)]) -> [Placement] {
        let sorted = items.sorted { ($0.start, $0.end, $0.id) < ($1.start, $1.end, $1.id) }
        var placements: [Placement] = []
        var cluster: [(id: String, column: Int)] = []
        var columnEnds: [Int] = []
        var clusterEnd = Int.min

        func flush() {
            for item in cluster {
                placements.append(Placement(id: item.id, column: item.column, columns: columnEnds.count))
            }
            cluster = []
            columnEnds = []
        }

        for item in sorted {
            if item.start >= clusterEnd { flush() }
            let column = columnEnds.firstIndex(where: { $0 <= item.start }) ?? columnEnds.count
            if column == columnEnds.count { columnEnds.append(item.end) } else { columnEnds[column] = item.end }
            cluster.append((item.id, column))
            clusterEnd = max(clusterEnd, item.end)
        }
        flush()
        return placements
    }
}
