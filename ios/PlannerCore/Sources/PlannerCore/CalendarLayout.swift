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
