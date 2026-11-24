import XCTest
@testable import PlannerCore

/// A model with one fixed answer, for building a real `ModelRun`.
private struct FixedRanker: SessionRanker {
    var availability: ModelAvailability = .available
    var answer: ModelAnswer
    func rank(_ prompt: ModelPrompt) async throws -> ModelAnswer { answer }
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
        XCTAssertNotNil(HoneycombConfig(key: "hcxik_abc", dataset: "Session_Planner.v1"))
    }

    func testTheBuildFileGivesTheConfig() {
        XCTAssertEqual(HoneycombConfig(file: ["IngestKey": "hcxik_abc", "Dataset": "session-planner"]),
                       HoneycombConfig(key: "hcxik_abc", dataset: "session-planner"))
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

    /// Rule 11: what the real sender is handed, after the real model step, holds nothing of the
    /// prompt, the answer, his picks or his profile.
    func testNothingOfThePromptTheAnswerOrHisProfileIsSent() async throws {
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
        let answer = ModelAnswer(picks: [ModelPick(code: "OFF202", reason: "SECRET-REASON from the model")],
                                 promptTokens: 900, answerTokens: 40)
        let ranked = await ModelStep.rank(suggestions, sessionsInBlock: 3, picks: picks, ranker: FixedRanker(answer: answer))
        XCTAssertEqual(ranked.run.outcome, .ok, "precondition: the model's answer was used")
        XCTAssertEqual(ranked.suggestions.first?.modelReason, "SECRET-REASON from the model")
        XCTAssertEqual(ranked.run.prompt?.profile.interestsNamed, 1, "precondition: his interest was in the prompt")
        let transport = ScriptedTransport([.respond(status: 200)])

        let delivery = await EventLog(config: config, transport: transport)
            .send(ranked.run, duration: .milliseconds(5), sharing: .allowed, installID: installID, app: app)

        XCTAssertEqual(delivery, .sent)
        let request = try XCTUnwrap(transport.sent.first)
        let text = String(decoding: try XCTUnwrap(request.httpBody), as: UTF8.self)
        for secret in ["SECRET", "OFF20", "PCK10", "vectors", "Chalk talk"] {
            XCTAssertFalse(text.contains(secret), "\(secret) was sent: \(text)")
        }
        XCTAssertEqual(Set(try body(request).keys), [
            "name", "app.version", "app.build", "install_id", "outcome", "remembered", "placed", "ignored",
            "duration_ms", "model.prompt_tokens", "model.answer_tokens", "prompt.estimated_tokens", "prompt.window",
            "prompt.answer_reserve", "prompt.headroom", "prompt.sessions_in_block", "prompt.sessions_sent",
            "prompt.sessions_left_out", "prompt.abstracts_cut", "prompt.profile_tokens", "profile.interests_named",
            "profile.levels", "profile.formats", "profile.skips", "profile.reserved_today",
        ])
        XCTAssertEqual(try body(request)["placed"] as? Int, 1)
    }

    func testARefusedOrUnreachableEventIsDroppedNotRetried() async {
        let refused = ScriptedTransport([.respond(status: 401, body: #"{"error":"unknown API key"}"#),
                                         .respond(status: 200)])
        let refusedResult = await EventLog(config: config, transport: refused)
            .send(fullRun, duration: nil, sharing: .allowed, installID: installID, app: app)
        XCTAssertEqual(refusedResult, .refused(401))
        XCTAssertEqual(refused.sent.count, 1)

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

    // MARK: Install id

    func testInstallIDIsAUUIDAndANewOneDiffers() {
        XCTAssertEqual(InstallID.usable(" 6f1c2b9a-3d4e-4f5a-8b6c-7d8e9f0a1b2c "), installID)
        XCTAssertNil(InstallID.usable(nil))
        XCTAssertNil(InstallID.usable(""))
        XCTAssertNil(InstallID.usable("his-email@example.com"))
        XCTAssertNil(InstallID.usable(42))
        let first = InstallID.make()
        let second = InstallID.make()
        XCTAssertEqual(InstallID.usable(first), first)
        XCTAssertEqual(InstallID.usable(second), second)
        XCTAssertNotEqual(first, second)
    }
}
