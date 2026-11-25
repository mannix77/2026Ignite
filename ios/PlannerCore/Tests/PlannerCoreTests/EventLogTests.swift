import XCTest
@testable import PlannerCore

/// A model with one fixed answer, or one failure, that records every prompt it is given.
private final class RecordingRanker: SessionRanker, @unchecked Sendable {
    let availability: ModelAvailability
    private let result: Result<ModelAnswer, Error>
    private let lock = NSLock()
    private var given: [ModelPrompt] = []

    init(_ availability: ModelAvailability = .available, answer: ModelAnswer) {
        self.availability = availability
        result = .success(answer)
    }

    init(failing error: Error) {
        availability = .available
        result = .failure(error)
    }

    var prompts: [ModelPrompt] { lock.withLock { given } }

    func rank(_ prompt: ModelPrompt) async throws -> ModelAnswer {
        lock.withLock { given.append(prompt) }
        return try result.get()
    }
}

/// Hands out scripted consents in order, and counts the asks.
private final class ConsentScript: @unchecked Sendable {
    private let lock = NSLock()
    private var left: [EventConsent]
    private var count = 0
    init(_ consents: [EventConsent]) { left = consents }
    func next() -> EventConsent {
        lock.withLock {
            count += 1
            return left.isEmpty ? EventConsent(sharing: .notAsked, installID: nil, live: false) : left.removeFirst()
        }
    }
    var asked: Int { lock.withLock { count } }
}

/// Three offered sessions and four picks, every title, abstract and interest marked SECRET.
private func secretList() -> (suggestions: [Suggestion], picks: [Session]) {
    var picks = (1...4).map { session("SECRET-ID-p\($0)", code: "PCK10\($0)") }
    for index in picks.indices {
        picks[index].title = "SECRET-PICK-TITLE \(index)"
        picks[index].topics = ["SECRET-INTEREST"]
        picks[index].type = "Chalk talk"
    }
    var offered = (1...3).map { session("SECRET-ID-s\($0)", code: "OFF20\($0)") }
    for index in offered.indices {
        offered[index].title = "SECRET-SESSION-TITLE \(index)"
        offered[index].abstract = "SECRET-ABSTRACT about vectors"
        offered[index].topics = ["SECRET-INTEREST"]
    }
    let suggestions = offered.map { Suggestion(session: $0, score: 1, shared: ["SECRET-INTEREST"], seat: .walkUp, isFavorite: false,
                                               isRepeatOfFavorite: false) }
    return (suggestions, picks)
}

private let config = HoneycombConfig(key: "hcxik_test0123456789", dataset: "session-planner")!
private let app = AppBuild(version: "1.2", build: "6")
private let installID = "6F1C2B9A-3D4E-4F5A-8B6C-7D8E9F0A1B2C"

/// A run with every measure present, all values different so a swapped field shows.
private let fullRun = ModelRun(
    outcome: .ok, unavailableReason: nil,
    prompt: PromptMetrics(estimatedTokens: 2100, window: 4096, answerReserve: 1000, headroom: 996, sessionsInBlock: 149,
                          sessionsSent: 12, sessionsLeftOut: 37, abstractsCut: 9, profileTokens: 140,
                          profile: ProfileUse(interestsNamed: 5, levels: .settings, formats: .inferred, skips: true,
                                              reservedToday: false)),
    modelPromptTokens: 2050, modelAnswerTokens: 310, placed: 4, ignored: 1, remembered: false)

private func body(_ request: URLRequest) throws -> [String: Any] {
    let data = try XCTUnwrap(request.httpBody)
    return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
}

final class EventLogTests: XCTestCase {
    // MARK: Consent

    func testSavedAnswerReadsBackAndAnythingElseIsNotAsked() {
        XCTAssertEqual(EventSharing(saved: "allowed"), .allowed)
        XCTAssertEqual(EventSharing(saved: "declined"), .declined)
        XCTAssertEqual(EventSharing(saved: "notAsked"), .notAsked)
        XCTAssertEqual(EventSharing(saved: nil), .notAsked)
        XCTAssertEqual(EventSharing(saved: "yes"), .notAsked)
        XCTAssertEqual(EventSharing(saved: 1), .notAsked)
        XCTAssertEqual(EventSharing.allowed.saved, "allowed")
        XCTAssertEqual(EventSharing.declined.saved, "declined")
    }

    func testFirstOpenAsksOnlyInABuildWithAKeyAndOnlyUntilAnswered() {
        XCTAssertTrue(EventLog.asksOnLaunch(.notAsked, config: config))
        XCTAssertFalse(EventLog.asksOnLaunch(.allowed, config: config))
        XCTAssertFalse(EventLog.asksOnLaunch(.declined, config: config))
        XCTAssertFalse(EventLog.asksOnLaunch(.notAsked, config: nil))
    }

    // MARK: The build's key and dataset

    func testKeyAndDatasetAreTrimmedAndBlankOrOddOnesMeanNoKey() {
        let trimmed = HoneycombConfig(key: "  hcxik_abc \n", dataset: " session-planner ")
        XCTAssertEqual(trimmed?.key, "hcxik_abc")
        XCTAssertEqual(trimmed?.dataset, "session-planner")
        XCTAssertNil(HoneycombConfig(key: nil, dataset: "session-planner"))
        XCTAssertNil(HoneycombConfig(key: "   ", dataset: "session-planner"))
        XCTAssertNil(HoneycombConfig(key: "hcxik_abc", dataset: nil))
        XCTAssertNil(HoneycombConfig(key: "hcxik_abc", dataset: ""))
        XCTAssertNil(HoneycombConfig(key: 42, dataset: "session-planner"))
        XCTAssertNil(HoneycombConfig(key: "hcxik abc", dataset: "session-planner"), "a key never holds a space")
        XCTAssertNil(HoneycombConfig(key: "hcxik_abc", dataset: "a/b"), "a slash would change the address")
        XCTAssertNil(HoneycombConfig(key: "hcxik_abc", dataset: "a?b"))
        XCTAssertNil(HoneycombConfig(key: "hcxik_abc", dataset: ".."), "dots alone would leave the dataset's address")
        XCTAssertNil(HoneycombConfig(key: "hcxik_abc", dataset: "."))
        XCTAssertNil(HoneycombConfig(key: "hcxik\u{0}abc", dataset: "session-planner"))
        XCTAssertNotNil(HoneycombConfig(key: "hcxik_abc", dataset: "a.b"))
        XCTAssertNotNil(HoneycombConfig(key: "hcxik_abc", dataset: "Session_Planner.v1"))
    }

    func testTheBuildFileGivesTheConfig() {
        let read = HoneycombConfig(file: ["IngestKey": "hcxik_abc", "Dataset": "session-planner"])
        XCTAssertEqual(read?.key, "hcxik_abc")
        XCTAssertEqual(read?.dataset, "session-planner")
        XCTAssertEqual(read?.url.absoluteString, "https://api.honeycomb.io/1/events/session-planner")
        XCTAssertNil(HoneycombConfig(file: nil))
        XCTAssertNil(HoneycombConfig(file: ["IngestKey": "", "Dataset": "session-planner"]))
    }

    // MARK: What is sent

    func testYesSendsOneEventToTheDatasetWithTheKeyAndExactlyTheseFields() async throws {
        let transport = ScriptedTransport([.respond(status: 200)])
        let log = EventLog(config: config, transport: transport)

        let delivery = await log.send(fullRun, duration: .milliseconds(1234), sharing: .allowed, installID: installID, app: app)

        XCTAssertEqual(delivery, .sent)
        XCTAssertEqual(transport.sent.count, 1)
        let request = try XCTUnwrap(transport.sent.first)
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.url?.absoluteString, "https://api.honeycomb.io/1/events/session-planner")
        XCTAssertEqual(request.value(forHTTPHeaderField: "X-Honeycomb-Team"), "hcxik_test0123456789")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Content-Type"), "application/json")
        XCTAssertNil(request.value(forHTTPHeaderField: "Authorization"))
        XCTAssertEqual(request.allHTTPHeaderFields?.count, 2, "only the key and the content type")
        let expected: [String: Any] = [
            "name": "suggest.model", "app.version": "1.2", "app.build": "6", "install_id": installID,
            "outcome": "ok", "remembered": false, "placed": 4, "ignored": 1, "duration_ms": 1234,
            "model.prompt_tokens": 2050, "model.answer_tokens": 310,
            "prompt.estimated_tokens": 2100, "prompt.window": 4096, "prompt.answer_reserve": 1000,
            "prompt.headroom": 996, "prompt.sessions_in_block": 149, "prompt.sessions_sent": 12,
            "prompt.sessions_left_out": 37, "prompt.abstracts_cut": 9, "prompt.profile_tokens": 140,
            "profile.interests_named": 5, "profile.levels": "settings", "profile.formats": "inferred",
            "profile.skips": true, "profile.reserved_today": false,
        ]
        XCTAssertEqual(try body(request) as NSDictionary, expected as NSDictionary)
        // NSDictionary equates true with 1: the flags must arrive as JSON booleans.
        let text = String(decoding: try XCTUnwrap(request.httpBody), as: UTF8.self)
        for flag in [#""remembered":false"#, #""profile.skips":true"#, #""profile.reserved_today":false"#] {
            XCTAssertTrue(text.contains(flag), "\(flag) not in \(text)")
        }
    }

    func testARunWithoutAPromptSendsOnlyWhatItHas() async throws {
        let transport = ScriptedTransport([.respond(status: 200)])
        let log = EventLog(config: config, transport: transport)
        let run = ModelRun(outcome: .unavailable, unavailableReason: "appleIntelligenceNotEnabled", prompt: nil,
                           modelPromptTokens: nil, modelAnswerTokens: nil, placed: 0, ignored: 0)

        let delivery = await log.send(run, duration: nil, sharing: .allowed, installID: installID, app: app)

        XCTAssertEqual(delivery, .sent)
        let expected: [String: Any] = [
            "name": "suggest.model", "app.version": "1.2", "app.build": "6", "install_id": installID,
            "outcome": "unavailable", "unavailable_reason": "appleIntelligenceNotEnabled",
            "remembered": false, "placed": 0, "ignored": 0,
        ]
        XCTAssertEqual(try body(XCTUnwrap(transport.sent.first)) as NSDictionary, expected as NSDictionary)
    }

    func testAProfileLineThatWasntThereIsSentAsNone() async throws {
        var run = fullRun
        run.prompt?.profile = ProfileUse(interestsNamed: 0, levels: nil, formats: nil, skips: false, reservedToday: true)
        run.remembered = true
        let transport = ScriptedTransport([.respond(status: 200)])

        _ = await EventLog(config: config, transport: transport).send(run, duration: .seconds(20), sharing: .allowed,
                                                                      installID: installID, app: app)

        let sent = try body(XCTUnwrap(transport.sent.first))
        XCTAssertEqual(sent["profile.levels"] as? String, "none")
        XCTAssertEqual(sent["profile.formats"] as? String, "none")
        XCTAssertEqual(sent["profile.reserved_today"] as? Bool, true)
        XCTAssertEqual(sent["remembered"] as? Bool, true)
        XCTAssertEqual(sent["duration_ms"] as? Int, 20000)
    }

    func testNoOrNotYetAnsweredOrNoKeySendsNothingAndYesAgainSends() async {
        let transport = ScriptedTransport([.respond(status: 200)])
        let log = EventLog(config: config, transport: transport)

        let notAsked = await log.send(fullRun, duration: nil, sharing: .notAsked, installID: installID, app: app)
        let declined = await log.send(fullRun, duration: nil, sharing: .declined, installID: installID, app: app)
        let keyless = await EventLog(config: nil, transport: transport)
            .send(fullRun, duration: nil, sharing: .allowed, installID: installID, app: app)
        XCTAssertEqual(notAsked, .notSent)
        XCTAssertEqual(declined, .notSent)
        XCTAssertEqual(keyless, .notSent)
        XCTAssertEqual(transport.sent.count, 0)

        let allowed = await log.send(fullRun, duration: nil, sharing: .allowed, installID: installID, app: app)
        XCTAssertEqual(allowed, .sent)
        XCTAssertEqual(transport.sent.count, 1)
    }

    func testAnUnusableInstallIDSendsNothing() async {
        let transport = ScriptedTransport([.respond(status: 200), .respond(status: 200)])
        let log = EventLog(config: config, transport: transport)

        let junk = await log.send(fullRun, duration: nil, sharing: .allowed, installID: "his-email@example.com", app: app)
        XCTAssertEqual(junk, .notSent)
        XCTAssertEqual(transport.sent.count, 0)

        let good = await log.send(fullRun, duration: nil, sharing: .allowed, installID: installID, app: app)
        XCTAssertEqual(good, .sent)
        XCTAssertEqual(transport.sent.count, 1)
    }

    /// Rule 11: after the real model step, the event the real sender is handed carries the
    /// exact text the model was given and its answer as written, and no other field holds
    /// anything of the prompt, the answer, his picks or his profile.
    func testTheModelsTextAndAnswerGoOnlyInTheirOwnFields() async throws {
        let (suggestions, picks) = secretList()
        let model = RecordingRanker(answer: ModelAnswer(picks: [ModelPick(code: "OFF202", reason: "SECRET-REASON from the model"),
                                                                ModelPick(code: "XYZ999", reason: "SECRET \"quoted\" / slash")],
                                                        promptTokens: 900, answerTokens: 40))
        let ranked = await ModelStep.rank(suggestions, sessionsInBlock: 3, picks: picks, ranker: model)
        XCTAssertEqual(ranked.run.outcome, .ok, "precondition: the model's answer was used")
        XCTAssertEqual(ranked.run.prompt?.profile.interestsNamed, 1, "precondition: his interest was in the prompt")
        let given = try XCTUnwrap(model.prompts.first?.text)
        XCTAssertTrue(given.contains("SECRET-SESSION-TITLE"), "precondition: the prompt names the sessions")
        let transport = ScriptedTransport([.respond(status: 200)])

        let delivery = await EventLog(config: config, transport: transport)
            .send(ranked, duration: .milliseconds(5), sharing: .allowed, installID: installID, app: app)

        XCTAssertEqual(delivery, .sent)
        var sent = try body(XCTUnwrap(transport.sent.first))
        XCTAssertEqual(sent.removeValue(forKey: "model.prompt") as? String, given)
        XCTAssertEqual(sent.removeValue(forKey: "model.answer") as? String,
                       #"[{"code":"OFF202","reason":"SECRET-REASON from the model"},{"code":"XYZ999","reason":"SECRET \"quoted\" / slash"}]"#)
        let rest = String(decoding: try JSONSerialization.data(withJSONObject: sent), as: UTF8.self)
        for secret in ["SECRET", "OFF20", "PCK10", "XYZ999", "vectors", "Chalk talk"] {
            XCTAssertFalse(rest.contains(secret), "\(secret) was sent outside the model's fields: \(rest)")
        }
        XCTAssertEqual(Set(sent.keys), [
            "name", "app.version", "app.build", "install_id", "outcome", "remembered", "placed", "ignored",
            "duration_ms", "model.prompt_tokens", "model.answer_tokens", "prompt.estimated_tokens", "prompt.window",
            "prompt.answer_reserve", "prompt.headroom", "prompt.sessions_in_block", "prompt.sessions_sent",
            "prompt.sessions_left_out", "prompt.abstracts_cut", "prompt.profile_tokens", "profile.interests_named",
            "profile.levels", "profile.formats", "profile.skips", "profile.reserved_today",
        ])
        XCTAssertEqual(sent["placed"] as? Int, 1)
        XCTAssertEqual(sent["ignored"] as? Int, 1)
    }

    func testAFailedModelSendsTheTextItWasGivenAndNoAnswer() async throws {
        let (suggestions, picks) = secretList()
        let model = RecordingRanker(failing: ModelFailure.refused)
        let ranked = await ModelStep.rank(suggestions, sessionsInBlock: 3, picks: picks, ranker: model)
        XCTAssertEqual(ranked.run.outcome, .refused)
        let transport = ScriptedTransport([.respond(status: 200)])

        let delivery = await EventLog(config: config, transport: transport)
            .send(ranked, duration: nil, sharing: .allowed, installID: installID, app: app)

        XCTAssertEqual(delivery, .sent)
        let sent = try body(XCTUnwrap(transport.sent.first))
        XCTAssertEqual(sent["model.prompt"] as? String, try XCTUnwrap(model.prompts.first?.text))
        XCTAssertNil(sent["model.answer"])
        XCTAssertEqual(sent["outcome"] as? String, "refused")
    }

    /// A prompt the model was never given isn't sent as if it had been.
    func testAPromptTooLongOrAListClosedFirstSendsNoText() async throws {
        let (suggestions, picks) = secretList()
        var tiny = PromptBudget()
        tiny.window = 1100   // 100 tokens for the prompt: less than the instructions
        let tooLongModel = RecordingRanker(answer: ModelAnswer(picks: []))
        let tooLong = await ModelStep.rank(suggestions, sessionsInBlock: 3, picks: picks, ranker: tooLongModel, budget: tiny)
        XCTAssertEqual(tooLong.run.outcome, .promptTooLong)

        let closedModel = RecordingRanker(answer: ModelAnswer(picks: []))
        let closing = Task { () -> RankedSuggestions in
            while !Task.isCancelled { await Task.yield() }
            return await ModelStep.rank(suggestions, sessionsInBlock: 3, picks: picks, ranker: closedModel)
        }
        closing.cancel()
        let closedValue = await finished(closing)
        let closed = try XCTUnwrap(closedValue)
        XCTAssertEqual(closed.run.outcome, .cancelled)
        XCTAssertTrue(tooLongModel.prompts.isEmpty)
        XCTAssertTrue(closedModel.prompts.isEmpty)
        let transport = ScriptedTransport([.respond(status: 200), .respond(status: 200)])
        let log = EventLog(config: config, transport: transport)

        _ = await log.send(tooLong, duration: nil, sharing: .allowed, installID: installID, app: app)
        _ = await log.send(closed, duration: nil, sharing: .allowed, installID: installID, app: app)

        XCTAssertEqual(transport.sent.count, 2)
        for (request, outcome) in zip(transport.sent, ["promptTooLong", "cancelled"]) {
            let sent = try body(request)
            XCTAssertEqual(sent["outcome"] as? String, outcome)
            XCTAssertNotNil(sent["prompt.estimated_tokens"], "the prompt's measures still go")
            XCTAssertNil(sent["model.prompt"])
            XCTAssertNil(sent["model.answer"])
        }
    }

    func testAnUnavailableModelSendsNeitherTextNorAnswer() async throws {
        let (suggestions, picks) = secretList()
        let model = RecordingRanker(.unavailable("modelNotReady"), answer: ModelAnswer(picks: []))
        let ranked = await ModelStep.rank(suggestions, sessionsInBlock: 3, picks: picks, ranker: model)
        let transport = ScriptedTransport([.respond(status: 200)])

        _ = await EventLog(config: config, transport: transport)
            .send(ranked, duration: nil, sharing: .allowed, installID: installID, app: app)

        let sent = try body(XCTUnwrap(transport.sent.first))
        XCTAssertEqual(sent["outcome"] as? String, "unavailable")
        XCTAssertEqual(sent["unavailable_reason"] as? String, "modelNotReady")
        XCTAssertNil(sent["model.prompt"])
        XCTAssertNil(sent["model.answer"])
        XCTAssertTrue(model.prompts.isEmpty)
    }

    /// Through the real paths: the model's own answer, then the same list from its memory.
    func testARememberedAnswerDoesntRepeatTheTextOrAnswer() async throws {
        let (suggestions, picks) = secretList()
        let model = RecordingRanker(answer: ModelAnswer(picks: [ModelPick(code: "OFF202", reason: "r")]))
        let remembering = RememberingRanker(model)
        let asked = await ModelStep.rank(suggestions, sessionsInBlock: 3, picks: picks, ranker: remembering)
        let fromMemory = try XCTUnwrap(ModelStep.remembered(suggestions, sessionsInBlock: 3, picks: picks, ranker: remembering))
        XCTAssertEqual(model.prompts.count, 1, "precondition: the model ran once")
        XCTAssertTrue(fromMemory.run.remembered)
        let transport = ScriptedTransport([.respond(status: 200), .respond(status: 200)])
        let log = EventLog(config: config, transport: transport)

        _ = await log.send(asked, duration: nil, sharing: .allowed, installID: installID, app: app)
        _ = await log.send(fromMemory, duration: nil, sharing: .allowed, installID: installID, app: app)

        XCTAssertEqual(transport.sent.count, 2)
        let first = try body(transport.sent[0])
        XCTAssertEqual(first["remembered"] as? Bool, false)
        XCTAssertEqual(first["model.prompt"] as? String, try XCTUnwrap(model.prompts.first?.text))
        XCTAssertEqual(first["model.answer"] as? String, #"[{"code":"OFF202","reason":"r"}]"#)
        let second = try body(transport.sent[1])
        XCTAssertEqual(second["remembered"] as? Bool, true)
        XCTAssertNil(second["model.prompt"])
        XCTAssertNil(second["model.answer"])
    }

    func testTextOver32000BytesIsCutAtACharacter() async throws {
        let transport = ScriptedTransport([.respond(status: 200), .respond(status: 200), .respond(status: 200)])
        let log = EventLog(config: config, transport: transport)
        let exact = String(repeating: "a", count: 32_000)
        // An "é" ending exactly at byte 32,000 stays; the "b" after it goes.
        let fills = String(repeating: "a", count: 31_998) + "éb"
        // 31,999 bytes then a 2-byte "é": 32,001 bytes, so the "é" goes whole.
        let over = String(repeating: "a", count: 31_999) + "é"

        _ = await log.send(RankedSuggestions(suggestions: [], run: fullRun, promptText: exact),
                           duration: nil, sharing: .allowed, installID: installID, app: app)
        _ = await log.send(RankedSuggestions(suggestions: [], run: fullRun, promptText: over),
                           duration: nil, sharing: .allowed, installID: installID, app: app)

        XCTAssertEqual(try body(transport.sent[0])["model.prompt"] as? String, exact)
        _ = await log.send(RankedSuggestions(suggestions: [], run: fullRun, promptText: fills),
                           duration: nil, sharing: .allowed, installID: installID, app: app)

        XCTAssertEqual(try body(transport.sent[1])["model.prompt"] as? String, String(repeating: "a", count: 31_999))
        XCTAssertEqual(try body(transport.sent[2])["model.prompt"] as? String, String(repeating: "a", count: 31_998) + "é")
    }

    /// The answer is cut too, and at a whole character: a 25-byte family emoji that would
    /// cross the limit goes whole, not by its parts.
    func testTheAnswerIsCutAtAWholeCharacter() async throws {
        let family = "👨‍👩‍👧‍👦"
        XCTAssertEqual(family.utf8.count, 25, "precondition")
        // 23 bytes of JSON come before the reason; 31,993 + 25 would cross 32,000.
        let reason = String(repeating: "a", count: 31_970) + family
        let transport = ScriptedTransport([.respond(status: 200)])

        _ = await EventLog(config: config, transport: transport)
            .send(RankedSuggestions(suggestions: [], run: fullRun, answer: [ModelPick(code: "A", reason: reason)]),
                  duration: nil, sharing: .allowed, installID: installID, app: app)

        let sent = try XCTUnwrap(body(XCTUnwrap(transport.sent.first))["model.answer"] as? String)
        XCTAssertEqual(sent, #"[{"code":"A","reason":""# + String(repeating: "a", count: 31_970))
        XCTAssertEqual(sent.utf8.count, 31_993, "23 bytes of JSON before the reason, then 31,970")
    }

    func testARefusedOrUnreachableEventIsDroppedNotRetried() async {
        let refused = ScriptedTransport([.respond(status: 401, body: #"{"error":"unknown API key"}"#),
                                         .respond(status: 200)])
        let refusedResult = await EventLog(config: config, transport: refused)
            .send(fullRun, duration: nil, sharing: .allowed, installID: installID, app: app)
        XCTAssertEqual(refusedResult, .refused(401))
        XCTAssertEqual(refused.sent.count, 1)

        // Both sides of "2xx is sent".
        for (status, expected) in [(199, EventDelivery.refused(199)), (200, .sent), (299, .sent), (300, .refused(300))] {
            let transport = ScriptedTransport([.respond(status: status)])
            let result = await EventLog(config: config, transport: transport)
                .send(fullRun, duration: nil, sharing: .allowed, installID: installID, app: app)
            XCTAssertEqual(result, expected, "status \(status)")
            XCTAssertEqual(transport.sent.count, 1)
        }

        let unreachable = ScriptedTransport([.fail, .respond(status: 200)])
        let unreachableResult = await EventLog(config: config, transport: unreachable)
            .send(fullRun, duration: nil, sharing: .allowed, installID: installID, app: app)
        XCTAssertEqual(unreachableResult, .unreachable)
        XCTAssertEqual(unreachable.sent.count, 1)
    }

    func testTheRequestGivesUpAfterTenSeconds() async throws {
        let transport = ScriptedTransport([.respond(status: 200)])
        _ = await EventLog(config: config, transport: transport)
            .send(fullRun, duration: nil, sharing: .allowed, installID: installID, app: app)
        XCTAssertEqual(try XCTUnwrap(transport.sent.first).timeoutInterval, 10)
    }

    func testDurationIsSentInWholeMillisecondsCutNotRounded() {
        XCTAssertEqual(EventLog.milliseconds(.microseconds(1999)), 1)
        XCTAssertEqual(EventLog.milliseconds(.microseconds(2000)), 2)
        XCTAssertEqual(EventLog.milliseconds(.zero), 0)
    }

    // MARK: Asked or not

    /// The prompt counts as given only once the ranker is called: a request stopped before the
    /// model's task asks it records no text (CodeRabbit on #201).
    func testARequestStoppedBeforeTheModelIsAskedIsNotMarkedGiven() async throws {
        let (suggestions, picks) = secretList()
        let prompt = ModelPrompt.build(question: "", ranked: suggestions.map(\.session), sessionsInBlock: 3, picks: picks)
        let model = RecordingRanker(answer: ModelAnswer(picks: []))
        let handed = ModelStep.Handed()
        let stopped = Task { () -> Bool in
            while !Task.isCancelled { await Task.yield() }
            let result = await ModelStep.answered(prompt, by: model, within: .seconds(20), handed: handed,
                                                  sleep: { _ in try await Task.sleep(for: .seconds(3600)) })
            if case let .failure(failed) = result { return failed.outcome == ModelOutcome.cancelled }
            return false
        }
        stopped.cancel()
        let stoppedValue = await finished(stopped)
        let wasCancelled = try XCTUnwrap(stoppedValue)
        XCTAssertTrue(wasCancelled)
        XCTAssertFalse(handed.value)
        XCTAssertTrue(model.prompts.isEmpty, "the model wasn't asked")

        // The model's own task, stopped before it starts, asks nothing either.
        let early = ModelStep.Handed()
        let earlyModel = RecordingRanker(answer: ModelAnswer(picks: []))
        let earlyTask = Task { () -> Bool in
            while !Task.isCancelled { await Task.yield() }
            if case let .failure(failed) = await ModelStep.outcome(of: prompt, by: earlyModel, handed: early) {
                return failed.outcome == ModelOutcome.cancelled
            }
            return false
        }
        earlyTask.cancel()
        let earlyValue = await finished(earlyTask)
        XCTAssertEqual(earlyValue, true)
        XCTAssertFalse(early.value)
        XCTAssertTrue(earlyModel.prompts.isEmpty)

        let asked = ModelStep.Handed()
        let refusing = RecordingRanker(failing: ModelFailure.refused)
        _ = await ModelStep.answered(prompt, by: refusing, within: .seconds(20), handed: asked,
                                     sleep: { _ in try await Task.sleep(for: .seconds(3600)) })
        XCTAssertTrue(asked.value)
        XCTAssertEqual(refusing.prompts.count, 1)
    }

    // MARK: Consent and mode at the moment of sending

    /// What decides is the consent as it is when the event goes out, not when it was queued.
    func testConsentIsReadWhenTheEventIsSent() async throws {
        let transport = ScriptedTransport([.respond(status: 200)])
        let log = EventLog(config: config, transport: transport)
        let ranked = RankedSuggestions(suggestions: [], run: fullRun, promptText: "the prompt")
        let answers = ConsentScript([EventConsent(sharing: .declined, installID: installID, live: true),
                                     EventConsent(sharing: .allowed, installID: "11111111-2222-3333-4444-555555555555", live: true)])

        let declined = await log.send(ranked, duration: nil, app: app, consent: { answers.next() })
        XCTAssertEqual(declined, .notSent)
        XCTAssertEqual(transport.sent.count, 0)

        let allowed = await log.send(ranked, duration: nil, app: app, consent: { answers.next() })
        XCTAssertEqual(allowed, .sent)
        XCTAssertEqual(transport.sent.count, 1)
        XCTAssertEqual(try body(transport.sent[0])["install_id"] as? String, "11111111-2222-3333-4444-555555555555",
                       "the install id as it is at sending, e.g. just reset")
        XCTAssertEqual(answers.asked, 2, "asked once per event")
    }

    /// The sample conference sends nothing anywhere, even with his yes.
    func testTheSampleConferenceSendsNothing() async {
        let transport = ScriptedTransport([.respond(status: 200)])
        let log = EventLog(config: config, transport: transport)
        let ranked = RankedSuggestions(suggestions: [], run: fullRun)

        let sample = await log.send(ranked, duration: nil, app: app,
                                    consent: { EventConsent(sharing: .allowed, installID: installID, live: false) })
        XCTAssertEqual(sample, .notSent)
        XCTAssertEqual(transport.sent.count, 0)

        let live = await log.send(ranked, duration: nil, app: app,
                                  consent: { EventConsent(sharing: .allowed, installID: installID, live: true) })
        XCTAssertEqual(live, .sent)
        XCTAssertEqual(transport.sent.count, 1)
    }

    // MARK: Install id

    func testYesKeepsHisInstallIDAndNoForgetsIt() {
        let yes = EventSharing.answer(true, installID: installID)
        XCTAssertEqual(yes.sharing, .allowed)
        XCTAssertEqual(yes.installID, installID)
        let no = EventSharing.answer(false, installID: installID)
        XCTAssertEqual(no.sharing, .declined)
        XCTAssertNil(no.installID)
        let yesWithJunk = EventSharing.answer(true, installID: "junk")
        XCTAssertEqual(yesWithJunk.sharing, .allowed)
        XCTAssertNil(yesWithJunk.installID)
    }

    func testAnEventUsesTheSavedIDOrANewOne() {
        XCTAssertEqual(InstallID.forSending(installID), installID)
        let made = InstallID.forSending(nil)
        XCTAssertEqual(UUID(uuidString: made)?.uuidString, made, "a UUID in its usual form")
        XCTAssertNotEqual(made, installID)
        let replaced = InstallID.forSending("his-email@example.com")
        XCTAssertEqual(UUID(uuidString: replaced)?.uuidString, replaced, "a UUID in its usual form")
        XCTAssertNotEqual(replaced, "his-email@example.com")
    }

    func testInstallIDIsAUUIDAndANewOneDiffers() {
        XCTAssertEqual(InstallID.usable(" 6f1c2b9a-3d4e-4f5a-8b6c-7d8e9f0a1b2c "), installID)
        XCTAssertNil(InstallID.usable(nil))
        XCTAssertNil(InstallID.usable(""))
        XCTAssertNil(InstallID.usable("his-email@example.com"))
        XCTAssertNil(InstallID.usable(42))
        let first = InstallID.make()
        let second = InstallID.make()
        XCTAssertEqual(UUID(uuidString: first)?.uuidString, first, "a UUID in its usual form")
        XCTAssertEqual(UUID(uuidString: second)?.uuidString, second, "a UUID in its usual form")
        XCTAssertNotEqual(first, second)
    }
}
