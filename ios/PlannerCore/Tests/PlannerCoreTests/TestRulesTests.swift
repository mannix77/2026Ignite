import Foundation
import XCTest

/// Checks the test sources against the rules in CLAUDE.md that a machine can check, so
/// `swift test` (run before every push and in CI) catches them instead of a reviewer:
///
/// - rule 10: no wall clock and no machine time zone (`Date()`, `.now`, `TimeZone.current`,
///   and `Calendar(identifier:)` / `DateFormatter()`, which start in the machine's zone);
/// - rule 12: no network (`URLSession`, `import Network`, `Data(contentsOf:)` an http URL),
///   and every wait has a timeout (`wait(for:)`, `fulfillment(of:)` and a semaphore's or
///   group's `.wait()` wait forever without one);
/// - rule 13: no subclassing of a concrete `XCTestCase` (its tests would run twice).
///
/// Comments and string literals are ignored; code inside a string's `\(...)` is not. A line
/// that must break a rule says why with `// test-rules: allow <reason>` in a comment.
enum TestRules {
    struct Violation: Equatable, CustomStringConvertible {
        let file: String
        let line: Int
        let rule: String

        var description: String { "\(file):\(line): \(rule)" }
    }

    static let network = "rule 12: no network in tests (use ScriptedTransport)"
    static let clock = "rule 10: no wall clock or machine time zone (pass now and the time zone in)"
    static let waitTimeout = "rule 12: a wait needs a timeout"
    static let subclass = "rule 13: don't subclass a concrete XCTestCase (share helpers in TestSupport.swift)"

    /// `.now`, `.current` or `.init()` written without a type in front (an inferred `Date`,
    /// clock, time zone or calendar). A `DispatchTime` deadline, `.now() + 2`, only bounds a
    /// wait, so it is allowed.
    private static let implicitMember = #"(?<![\w)\]?!])\s*\."#

    private static let banned: [(rule: String, regex: NSRegularExpression)] = [
        (network, #"\bURLSession\b"#),
        (network, #"(?m)^\s*(@\w+\s+)*import\s+(\w+\s+)?Network\b"#),
        (clock, #"\bN?S?Date\s*\(\s*\)"#),
        (clock, #"\bDate\s*\.\s*init\s*\(\s*\)"#),
        (clock, #"\bDate\s*\.\s*(now|timeIntervalSinceReferenceDate)\b"#),
        (clock, #"\bDate\s*\(\s*timeIntervalSinceNow\s*:"#),
        (clock, implicitMember + #"(now\b(?!\s*\()|current\b|autoupdatingCurrent\b)"#),
        (clock, #":\s*Date\s*=\s*\.\s*init\s*\(\s*\)"#),
        (clock, #"\b(ContinuousClock|SuspendingClock|DispatchWallTime)\s*\.\s*now\b"#),
        (clock, #"\b(TimeZone|Calendar|Locale|NSTimeZone|NSCalendar)\s*\.\s*(current|autoupdatingCurrent|local|system|default)\b"#),
        (clock, #"\bCalendar\s*\(\s*identifier\s*:"#),
        (clock, #"\bDateFormatter\s*\(\s*\)"#),
        (clock, #"\bCFAbsoluteTimeGetCurrent\b"#),
        (clock, #"\bsystemUptime\b"#),
        (waitTimeout, #"\.\s*wait\s*\(\s*\)"#),
        (waitTimeout, #"\btimeout\s*:\s*([A-Za-z]*\s*\.\s*)?(infinity|distantFuture)\b"#),
    ].map { ($0.0, regex($0.1)) }

    private static let waitCall = regex(#"\b(wait|fulfillment)\s*\(\s*(for|of)\s*:"#)
    private static let timeoutLabel = regex(#"\btimeout\s*:"#)
    private static let contentsOfCall = regex(#"\b(Data|String|NSData|NSString)\s*\(\s*contentsOf\s*:"#)
    private static let webAddress = regex(#""\s*https?:"#)
    private static let classDeclaration =
        regex(#"\bclass\s+([A-Za-z_][A-Za-z0-9_]*)\s*(<[^>{]*>)?\s*:\s*([A-Za-z_][A-Za-z0-9_.]*)"#)
    private static let allowMarker = regex(#"//[ \t]*test-rules:[ \t]*allow[ \t]+\S"#)
    private static let testCaseRoots: Set<String> = ["XCTestCase"]

    /// Every rule broken in `files` (name -> source), sorted by file and line.
    static func check(_ files: [String: String]) -> [Violation] {
        var found: [Violation] = []
        var classes: [(file: String, line: Int, name: String, superclass: String)] = []
        var allowedByFile: [String: Set<Int>] = [:]

        for (name, source) in files {
            let lexed = Lexed(source)
            let allowed = lexed.allowedLines()
            allowedByFile[name] = allowed
            func add(_ rule: String, at offset: Int) {
                let line = lexed.line(at: offset)
                if !allowed.contains(line) { found.append(Violation(file: name, line: line, rule: rule)) }
            }

            for (rule, regex) in banned {
                for match in lexed.codeMatches(regex) { add(rule, at: match.lowerBound) }
            }
            for match in lexed.codeMatches(waitCall) {
                let call = lexed.arguments(from: match.upperBound)
                if timeoutLabel.firstMatch(in: call.topLevel, range: NSRange(call.topLevel.startIndex..., in: call.topLevel)) == nil {
                    add(waitTimeout, at: match.lowerBound)
                }
            }
            for match in lexed.codeMatches(contentsOfCall) {
                let call = lexed.arguments(from: match.upperBound)
                let raw = String(lexed.raw[match.upperBound..<call.end])
                if webAddress.firstMatch(in: raw, range: NSRange(raw.startIndex..., in: raw)) != nil {
                    add(network, at: match.lowerBound)
                }
            }
            for match in lexed.codeMatches(classDeclaration) {
                let parts = groups(classDeclaration, in: String(lexed.code[match]))
                // A module-qualified superclass (XCTest.XCTestCase) counts by its own name.
                let superclass = String(parts[2].split(separator: ".").last ?? "")
                classes.append((name, lexed.line(at: match.lowerBound), parts[0], superclass))
            }
        }

        // Test cases are the classes that reach XCTestCase through classes declared here.
        var testCases = testCaseRoots
        var grew = true
        while grew {
            grew = false
            for c in classes where testCases.contains(c.superclass) && !testCases.contains(c.name) {
                testCases.insert(c.name)
                grew = true
            }
        }
        for c in classes where !testCaseRoots.contains(c.superclass) && testCases.contains(c.superclass)
            && !(allowedByFile[c.file] ?? []).contains(c.line) {
            found.append(Violation(file: c.file, line: c.line, rule: subclass))
        }

        return found.sorted { ($0.file, $0.line, $0.rule) < ($1.file, $1.line, $1.rule) }
    }

    /// A source file split into code, comments and strings, one entry per character.
    struct Lexed {
        enum Kind { case code, comment, string }

        let raw: [Character]
        let kinds: [Kind]
        /// The source with comments and strings blanked (newlines kept), as characters.
        let code: [Character]
        private let lineOf: [Int]

        init(_ source: String) {
            enum Frame { case code(interpolation: Bool, depth: Int), lineComment, blockComment(Int),
                         string(hashes: Int, multiline: Bool) }
            let chars = Array(source)
            var kinds: [Kind] = []
            var code: [Character] = []
            kinds.reserveCapacity(chars.count)
            code.reserveCapacity(chars.count)
            var stack: [Frame] = [.code(interpolation: false, depth: 0)]
            var i = 0
            func at(_ offset: Int, _ text: String) -> Bool {
                var k = i + offset
                for c in text {
                    guard k < chars.count, chars[k] == c else { return false }
                    k += 1
                }
                return true
            }
            func take(_ count: Int, as kind: Kind) {
                for _ in 0..<count where i < chars.count {
                    kinds.append(kind)
                    code.append(kind == .code || chars[i].isNewline ? chars[i] : " ")
                    i += 1
                }
            }
            while i < chars.count {
                switch stack[stack.count - 1] {
                case let .code(interpolation, depth):
                    var hashes = 0
                    while at(hashes, "#") { hashes += 1 }
                    if at(0, "//") { stack.append(.lineComment); take(2, as: .comment) }
                    else if at(0, "/*") { stack.append(.blockComment(1)); take(2, as: .comment) }
                    else if at(hashes, "\"\"\"") { stack.append(.string(hashes: hashes, multiline: true)); take(hashes + 3, as: .string) }
                    else if at(hashes, "\"") { stack.append(.string(hashes: hashes, multiline: false)); take(hashes + 1, as: .string) }
                    else if interpolation && chars[i] == "(" { stack[stack.count - 1] = .code(interpolation: true, depth: depth + 1); take(1, as: .code) }
                    else if interpolation && chars[i] == ")" {
                        if depth == 0 { stack.removeLast(); take(1, as: .string) }
                        else { stack[stack.count - 1] = .code(interpolation: true, depth: depth - 1); take(1, as: .code) }
                    }
                    else { take(1, as: .code) }
                case .lineComment:
                    if chars[i].isNewline { stack.removeLast(); take(1, as: .code) } else { take(1, as: .comment) }
                case let .blockComment(depth):
                    if at(0, "/*") { stack[stack.count - 1] = .blockComment(depth + 1); take(2, as: .comment) }
                    else if at(0, "*/") {
                        if depth == 1 { stack.removeLast() } else { stack[stack.count - 1] = .blockComment(depth - 1) }
                        take(2, as: .comment)
                    }
                    else { take(1, as: .comment) }
                case let .string(hashes, multiline):
                    let pounds = String(repeating: "#", count: hashes)
                    let escape = "\\" + pounds
                    let close = (multiline ? "\"\"\"" : "\"") + pounds
                    if at(0, escape) && at(escape.count, "(") {
                        stack.append(.code(interpolation: true, depth: 0)); take(escape.count + 1, as: .string)
                    }
                    else if at(0, escape) { take(escape.count + 1, as: .string) }
                    else if at(0, close) { stack.removeLast(); take(close.count, as: .string) }
                    else if !multiline && chars[i].isNewline { stack.removeLast(); take(1, as: .code) }
                    else { take(1, as: .string) }
                }
            }
            raw = chars
            self.kinds = kinds
            self.code = code
            var lineOf: [Int] = []
            lineOf.reserveCapacity(chars.count + 1)
            var line = 1
            for c in chars {
                lineOf.append(line)
                if c.isNewline { line += 1 }
            }
            lineOf.append(line)
            self.lineOf = lineOf
        }

        func line(at offset: Int) -> Int { lineOf[min(offset, lineOf.count - 1)] }

        /// Matches of `regex` in the code (comments and strings blanked), as character offsets.
        func codeMatches(_ regex: NSRegularExpression) -> [Range<Int>] {
            Lexed.matches(regex, in: code)
        }

        /// Lines with an allow marker that sits in a comment (not in a string or in code).
        func allowedLines() -> Set<Int> {
            Set(Lexed.matches(TestRules.allowMarker, in: raw)
                .filter { kinds[$0.lowerBound] == .comment }
                .map { line(at: $0.lowerBound) })
        }

        /// The call's arguments from `offset` (just after its opening parenthesis) up to the
        /// one that closes it: the text outside any nested brackets or parentheses (so an inner
        /// call's `timeout:` doesn't count), and the offset just past the closing one.
        func arguments(from offset: Int) -> (topLevel: String, end: Int) {
            var depth = 1
            var topLevel = ""
            var i = offset
            while i < code.count && depth > 0 {
                let c = code[i]
                if c == "(" || c == "[" { depth += 1 } else if c == ")" || c == "]" { depth -= 1 }
                if depth == 1 && c != ")" && c != "]" { topLevel.append(c) }
                i += 1
            }
            return (topLevel, i)
        }

        private static func matches(_ regex: NSRegularExpression, in chars: [Character]) -> [Range<Int>] {
            let text = String(chars)
            return regex.matches(in: text, range: NSRange(text.startIndex..., in: text)).compactMap { match in
                guard let range = Range(match.range, in: text) else { return nil }
                let lower = text.distance(from: text.startIndex, to: range.lowerBound)
                return lower..<(lower + text.distance(from: range.lowerBound, to: range.upperBound))
            }
        }
    }

    private static func regex(_ pattern: String) -> NSRegularExpression {
        try! NSRegularExpression(pattern: pattern)
    }

    private static func groups(_ regex: NSRegularExpression, in text: String) -> [String] {
        guard let match = regex.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)) else { return [] }
        return (1..<match.numberOfRanges).map { Range(match.range(at: $0), in: text).map { String(text[$0]) } ?? "" }
    }
}

final class TestRulesTests: XCTestCase {
    private func check(_ lines: [String]) -> [TestRules.Violation] {
        TestRules.check(["T.swift": lines.joined(separator: "\n")])
    }

    private func violation(_ line: Int, _ rule: String) -> TestRules.Violation {
        TestRules.Violation(file: "T.swift", line: line, rule: rule)
    }

    // MARK: The real test sources

    func testTheTestSourcesFollowTheRules() throws {
        let folder = URL(fileURLWithPath: #filePath).deletingLastPathComponent().standardizedFileURL
        let walker = try XCTUnwrap(FileManager.default.enumerator(at: folder, includingPropertiesForKeys: [.isRegularFileKey]))
        var files: [String: String] = [:]
        for case let url as URL in walker where url.pathExtension == "swift" {
            guard try url.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile == true else { continue }
            let name = String(url.standardizedFileURL.path.dropFirst(folder.path.count + 1))
            files[name] = try String(contentsOf: url, encoding: .utf8)
        }
        // Precondition: the scan sees the real folder, including this file and the shared helpers.
        for expected in ["TestRulesTests.swift", "TestSupport.swift", "AgendaTests.swift", "EventsAPITests.swift"] {
            XCTAssertNotNil(files[expected], "\(files.keys.sorted())")
        }
        XCTAssertEqual(TestRules.check(files), [])
    }

    // MARK: Rule 12: network

    func testURLSessionTheNetworkFrameworkAndWebDownloadsAreRefused() {
        XCTAssertEqual(check([
            "import Network",
            "let s = URLSession.shared",
            "let d = try Data(contentsOf: URL(string: \"https://example.com/x\")!)",
            "let t = try String(contentsOf: URL(string: \"http://example.com\")!, encoding: .utf8)",
            "let ok = ScriptedTransport([])",
            "let r = URLRequest(url: URL(string: \"https://example.com\")!)",
            "let f = try String(contentsOf: folder.appendingPathComponent(name), encoding: .utf8)",
            "@testable import PlannerCore",
            "@preconcurrency import Network",
            "import struct Network.NWConnection",
            "import NetworkExtras",
        ]), [violation(1, TestRules.network), violation(2, TestRules.network),
             violation(3, TestRules.network), violation(4, TestRules.network),
             violation(9, TestRules.network), violation(10, TestRules.network)])
    }

    // MARK: Rule 10: clock and time zone

    func testTheWallClockAndTheMachineTimeZoneAreRefused() {
        let lines = [
            "let a = Date()",
            "let b = Date.now",
            "let c = Date(timeIntervalSinceNow: 5)",
            "let d = TimeZone.current",
            "let e = Calendar.autoupdatingCurrent",
            "let f = CFAbsoluteTimeGetCurrent()",
            "let g = NSTimeZone.local",
            "let h: Date = .now",
            "agenda.plan(now: .now)",
            "let i: Date = .init()",
            "let j = Date.init()",
            "let k = ContinuousClock.now",
            "let l = DispatchWallTime.now()",
            "let m = Date.timeIntervalSinceReferenceDate",
            "var n = Calendar(identifier: .gregorian)",
            "let o = DateFormatter()",
            "let p = ProcessInfo.processInfo.systemUptime",
            "let q = Locale.current",
            "let r = Wording.eventNow(n, timeZone: .current)",
            "f.timeZone = .autoupdatingCurrent",
            "let s = NSDate()",
        ]
        XCTAssertEqual(check(lines), (1...lines.count).map { violation($0, TestRules.clock) })
    }

    func testFixedTimesAndNamedTimeZonesAreAllowed() {
        XCTAssertEqual(check([
            "let a = Date(timeIntervalSince1970: 0)",
            "let b = TimeZone(identifier: \"America/Los_Angeles\")!",
            "let c = ISO8601DateFormatter()",
            "func plan(now: Date) {}",
            "let d = fixture.now",
            "let e = plan(now: day.start)",
            "let f = list[0].now",
            "let g = Thread.current",
            "let h = session.current",
            "let i = Date(timeInterval: 60, since: start)",
        ]), [])
    }

    // MARK: Rule 12: waits

    func testAWaitWithoutATimeoutIsRefusedAndOneWithATimeoutIsAllowed() {
        XCTAssertEqual(check([
            "wait(for: [done])",
            "wait(for: [done], timeout: 2)",
            "await fulfillment(of: [done])",
            "await fulfillment(of: [done],",
            "                  timeout: 2)",
            "XCTWaiter().wait(for: [done], enforceOrder: true)",
            "let w = wait([\"Retry-After\": \"60\"])",
            "semaphore.wait()",
            "_ = semaphore.wait(timeout: .distantFuture)",
            "group.wait ( )",
            "wait(for: [done], timeout: .infinity)",
            "wait(for: [done], timeout: TimeInterval.infinity)",
            "_ = group.wait(timeout: .now() + 2)",
            "let infinityTimeout = 2.0",
        ]), [violation(1, TestRules.waitTimeout), violation(3, TestRules.waitTimeout),
             violation(6, TestRules.waitTimeout), violation(8, TestRules.waitTimeout),
             violation(9, TestRules.waitTimeout), violation(10, TestRules.waitTimeout),
             violation(11, TestRules.waitTimeout), violation(12, TestRules.waitTimeout)])
    }

    func testATimeoutInsideANestedCallDoesNotCountForTheWait() {
        // The first timeout belongs to make(...), not to the wait; the second wait has its own.
        XCTAssertEqual(check([
            "wait(for: [make(timeout: 2)])",
            "wait(for: [make(timeout: 2)], timeout: 3)",
        ]), [violation(1, TestRules.waitTimeout)])
    }

    // MARK: Rule 13: subclassing

    func testSubclassingAConcreteTestCaseIsRefusedAtAnyDepth() {
        XCTAssertEqual(check([
            "final class OK: XCTestCase {}",
            "class Base: XCTestCase {}",
            "final class Twice: Base {}",
            "final class Thrice: Twice {}",
            "final class Helper: ScriptedTransport {}",
            "class Qualified: XCTest.XCTestCase {}",
            "final class AlsoTwice: Qualified {}",
            "class Generic<T: Equatable>: XCTestCase {}",
            "final class GenericTwice: Generic<Int> {}",
            "class var shared: Int { 1 }",
            "final class ModuleTwice: PlannerCoreTests.Base {}",
        ]), [violation(3, TestRules.subclass), violation(4, TestRules.subclass),
             violation(7, TestRules.subclass), violation(9, TestRules.subclass),
             violation(11, TestRules.subclass)])
    }

    func testSubclassingAcrossFilesIsRefused() {
        let found = TestRules.check([
            "A.swift": "class Base: XCTestCase {}",
            "B.swift": "\nfinal class Twice: Base {}",
        ])
        XCTAssertEqual(found, [TestRules.Violation(file: "B.swift", line: 2, rule: TestRules.subclass)])
    }

    // MARK: What is not code

    func testCommentsAndStringsAreIgnoredButCodeAfterThemIsNot() {
        XCTAssertEqual(check([
            "// Date() in a comment",
            "/* TimeZone.current /* nested */ URLSession */",
            "let s = \"Date() and \\\"URLSession\\\" in a string\"",
            "let m = \"\"\"",
            "Date.now inside a multi-line string",
            "\"\"\"",
            "let x = \"done\"; let y = Date()",
            "/* ok */ let z = Date.now",
        ]), [violation(7, TestRules.clock), violation(8, TestRules.clock)])
    }

    func testCodeInsideAnInterpolationIsChecked() {
        XCTAssertEqual(check([
            "let a = \"at \\(Wording.time(Date())) today\"",
            "let b = \"at \\(Wording.time(fixed)) and Date() in text\"",
            "let c = #\"raw \\#(Date.now) here\"#",
            "let d = #\"raw \\(Date.now) is text\"#",
        ]), [violation(1, TestRules.clock), violation(3, TestRules.clock)])
    }

    func testRawStringsEndOnlyAtTheirOwnDelimiter() {
        XCTAssertEqual(check([
            "let a = #\"C:\\\"#; let b = Date()",
            "let c = #\"say \"hi\" Date() \"#",
            "let d = ##\"one \"# Date() \"##; let e = Date.now",
            "let f = #\"\"\"",
            "Date() and \"\"\" inside",
            "\"\"\"#; let g = TimeZone.current",
        ]), [violation(1, TestRules.clock), violation(3, TestRules.clock), violation(6, TestRules.clock)])
    }

    func testLineNumbersCountWindowsLineEndings() {
        let found = TestRules.check(["W.swift": "let a = 1\r\nlet b = 2\r\nlet c = Date()"])
        XCTAssertEqual(found, [TestRules.Violation(file: "W.swift", line: 3, rule: TestRules.clock)])
    }

    func testAnAllowMarkerNeedsAReasonACommentAndCoversOnlyItsLine() {
        XCTAssertEqual(check([
            "let a = Date() // test-rules: allow measuring how long the suite takes",
            "let b = Date() // test-rules: allow",
            "let c = Date()",
            "let s = \"// test-rules: allow inside a string\"; let d = Date()",
            "class Base: XCTestCase {}",
            "final class Twice: Base {} // test-rules: allow checking the subclass marker",
        ]), [violation(2, TestRules.clock), violation(3, TestRules.clock), violation(4, TestRules.clock)])
    }
}
