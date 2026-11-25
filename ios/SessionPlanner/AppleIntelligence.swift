import Foundation
import PlannerCore
#if canImport(FoundationModels)
import FoundationModels
#endif

/// Apple's on-device model, where the phone has it (#193). Everything about what it is sent and
/// what is done with its answer is in `ModelStep` in PlannerCore, which is tested; this only
/// hands the prompt over and reads the answer back. Nothing leaves the phone.
enum AppleIntelligence {
    /// The model on iOS 26 and later; nil before, where the framework doesn't exist.
    static func ranker() -> (any SessionRanker)? {
        #if canImport(FoundationModels)
        if #available(iOS 26.0, *) { return OnDeviceRanker() }
        #endif
        return nil
    }
}

#if canImport(FoundationModels)
@available(iOS 26.0, *)
@Generable
struct GeneratedRanking {
    @Guide(description: "The listed sessions most worth attending for this attendee, best first, at most 12")
    var sessions: [GeneratedPick]
}

@available(iOS 26.0, *)
@Generable
struct GeneratedPick {
    @Guide(description: "The session's code, exactly as listed")
    var code: String
    @Guide(description: "One short sentence on why it suits this attendee")
    var reason: String
}

@available(iOS 26.0, *)
struct OnDeviceRanker: SessionRanker {
    var availability: ModelAvailability {
        switch SystemLanguageModel.default.availability {
        case .available: return .available
        case let .unavailable(reason):
            switch reason {
            case .deviceNotEligible: return .unavailable("deviceNotEligible")
            case .appleIntelligenceNotEnabled: return .unavailable("appleIntelligenceNotEnabled")
            case .modelNotReady: return .unavailable("modelNotReady")
            @unknown default: return .unavailable("other")
            }
        }
    }

    func rank(_ prompt: ModelPrompt) async throws -> ModelAnswer {
        // A new session each time: nothing from one stretch carries into the next.
        let session = LanguageModelSession()
        let response: LanguageModelSession.Response<GeneratedRanking>
        do {
            response = try await session.respond(to: prompt.text, generating: GeneratedRanking.self)
        } catch {
            throw OnDeviceRanker.failure(error)
        }
        var promptTokens: Int?
        var answerTokens: Int?
        if #available(iOS 26.4, *) {
            promptTokens = try? await SystemLanguageModel.default.tokenCount(for: prompt.text)
        }
        if #available(iOS 27.0, *) {
            answerTokens = session.usage.output.totalTokenCount
        }
        return ModelAnswer(picks: response.content.sessions.map { ModelPick(code: $0.code, reason: $0.reason) },
                           promptTokens: promptTokens, answerTokens: answerTokens)
    }

    /// The framework's error as one `ModelStep` tells apart; anything else is passed on as it is.
    static func failure(_ error: Error) -> Error {
        if #available(iOS 27.0, *), let error = error as? LanguageModelError {
            switch error {
            case .refusal: return ModelFailure.refused
            case .contextSizeExceeded: return ModelFailure.contextExceeded
            case .guardrailViolation: return ModelFailure.guardrail
            case .timeout: return ModelFailure.timedOut
            default: return error
            }
        }
        return olderFailure(error)
    }

    /// iOS 26 throws `GenerationError`, which iOS 27 replaces.
    @available(iOS, deprecated: 27.0)
    private static func olderFailure(_ error: Error) -> Error {
        guard let error = error as? LanguageModelSession.GenerationError else { return error }
        switch error {
        case .refusal: return ModelFailure.refused
        case .exceededContextWindowSize: return ModelFailure.contextExceeded
        case .guardrailViolation: return ModelFailure.guardrail
        default: return error
        }
    }
}
#endif
