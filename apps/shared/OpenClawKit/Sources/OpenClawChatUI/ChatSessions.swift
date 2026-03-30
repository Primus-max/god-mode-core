import Foundation

public struct OpenClawChatModelChoice: Identifiable, Codable, Sendable, Hashable {
    public var id: String { self.selectionID }

    public let modelID: String
    public let name: String
    public let provider: String
    public let contextWindow: Int?

    public init(modelID: String, name: String, provider: String, contextWindow: Int?) {
        self.modelID = modelID
        self.name = name
        self.provider = provider
        self.contextWindow = contextWindow
    }

    /// Provider-qualified model ref used for picker identity and selection tags.
    public var selectionID: String {
        let trimmedProvider = self.provider.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedProvider.isEmpty else { return self.modelID }
        let providerPrefix = "\(trimmedProvider)/"
        if self.modelID.hasPrefix(providerPrefix) {
            return self.modelID
        }
        return "\(trimmedProvider)/\(self.modelID)"
    }

    public var displayLabel: String {
        self.selectionID
    }
}

public struct OpenClawChatSessionsDefaults: Codable, Sendable {
    public let model: String?
    public let contextTokens: Int?
    public let mainSessionKey: String?

    public init(model: String?, contextTokens: Int?, mainSessionKey: String? = nil) {
        self.model = model
        self.contextTokens = contextTokens
        self.mainSessionKey = mainSessionKey
    }
}

public enum OpenClawChatSessionHandoffTruthSource: String, Codable, Sendable, Hashable {
    case closure
    case recovery
}

public struct OpenClawChatRunClosureSummary: Codable, Sendable, Hashable {
    public let runId: String
    public let requestRunId: String?
    public let parentRunId: String?
    public let sessionKey: String?
    public let updatedAtMs: Double
    public let outcomeStatus: String
    public let verificationStatus: String
    public let acceptanceStatus: String
    public let action: String
    public let remediation: String
    public let reasonCode: String
    public let reasons: [String]
    public let declaredIntent: String?
    public let declaredProfileId: String?
    public let declaredRecipeId: String?
    public let requiresOutput: Bool?
    public let requiresMessagingDelivery: Bool?
    public let requiresConfirmedAction: Bool?
    public let surfaceStatus: String?
}

public struct OpenClawChatSessionEntry: Codable, Identifiable, Sendable, Hashable {
    public var id: String { self.key }

    public let key: String
    public let kind: String?
    public let displayName: String?
    public let surface: String?
    public let subject: String?
    public let room: String?
    public let space: String?
    public let updatedAt: Double?
    public let sessionId: String?

    public let systemSent: Bool?
    public let abortedLastRun: Bool?
    public let thinkingLevel: String?
    public let verboseLevel: String?
    public let totalTokensFresh: Bool?
    public let status: String?
    public let startedAt: Double?
    public let endedAt: Double?
    public let runtimeMs: Double?
    public let parentSessionKey: String?
    public let childSessions: [String]?
    public let runClosureSummary: OpenClawChatRunClosureSummary?
    public let handoffRequestRunId: String?
    public let handoffRunId: String?
    public let handoffTruthSource: OpenClawChatSessionHandoffTruthSource?
    public let handoffHint: String?
    public let recoveryCheckpointId: String?
    public let recoveryStatus: String?
    public let recoveryContinuationState: String?
    public let recoveryOperation: String?
    public let recoveryBlockedReason: String?
    public let recoveryUpdatedAt: Double?
    public let recoveryAttempts: Int?
    public let recoveryOperatorHint: String?

    public let inputTokens: Int?
    public let outputTokens: Int?
    public let totalTokens: Int?

    public let modelProvider: String?
    public let model: String?
    public let contextTokens: Int?

    public init(
        key: String,
        kind: String? = nil,
        displayName: String? = nil,
        surface: String? = nil,
        subject: String? = nil,
        room: String? = nil,
        space: String? = nil,
        updatedAt: Double? = nil,
        sessionId: String? = nil,
        systemSent: Bool? = nil,
        abortedLastRun: Bool? = nil,
        thinkingLevel: String? = nil,
        verboseLevel: String? = nil,
        totalTokensFresh: Bool? = nil,
        status: String? = nil,
        startedAt: Double? = nil,
        endedAt: Double? = nil,
        runtimeMs: Double? = nil,
        parentSessionKey: String? = nil,
        childSessions: [String]? = nil,
        runClosureSummary: OpenClawChatRunClosureSummary? = nil,
        handoffRequestRunId: String? = nil,
        handoffRunId: String? = nil,
        handoffTruthSource: OpenClawChatSessionHandoffTruthSource? = nil,
        handoffHint: String? = nil,
        recoveryCheckpointId: String? = nil,
        recoveryStatus: String? = nil,
        recoveryContinuationState: String? = nil,
        recoveryOperation: String? = nil,
        recoveryBlockedReason: String? = nil,
        recoveryUpdatedAt: Double? = nil,
        recoveryAttempts: Int? = nil,
        recoveryOperatorHint: String? = nil,
        inputTokens: Int? = nil,
        outputTokens: Int? = nil,
        totalTokens: Int? = nil,
        modelProvider: String? = nil,
        model: String? = nil,
        contextTokens: Int? = nil)
    {
        self.key = key
        self.kind = kind
        self.displayName = displayName
        self.surface = surface
        self.subject = subject
        self.room = room
        self.space = space
        self.updatedAt = updatedAt
        self.sessionId = sessionId
        self.systemSent = systemSent
        self.abortedLastRun = abortedLastRun
        self.thinkingLevel = thinkingLevel
        self.verboseLevel = verboseLevel
        self.totalTokensFresh = totalTokensFresh
        self.status = status
        self.startedAt = startedAt
        self.endedAt = endedAt
        self.runtimeMs = runtimeMs
        self.parentSessionKey = parentSessionKey
        self.childSessions = childSessions
        self.runClosureSummary = runClosureSummary
        self.handoffRequestRunId = handoffRequestRunId
        self.handoffRunId = handoffRunId
        self.handoffTruthSource = handoffTruthSource
        self.handoffHint = handoffHint
        self.recoveryCheckpointId = recoveryCheckpointId
        self.recoveryStatus = recoveryStatus
        self.recoveryContinuationState = recoveryContinuationState
        self.recoveryOperation = recoveryOperation
        self.recoveryBlockedReason = recoveryBlockedReason
        self.recoveryUpdatedAt = recoveryUpdatedAt
        self.recoveryAttempts = recoveryAttempts
        self.recoveryOperatorHint = recoveryOperatorHint
        self.inputTokens = inputTokens
        self.outputTokens = outputTokens
        self.totalTokens = totalTokens
        self.modelProvider = modelProvider
        self.model = model
        self.contextTokens = contextTokens
    }
}

public struct OpenClawChatSessionsListResponse: Codable, Sendable {
    public let ts: Double?
    public let path: String?
    public let count: Int?
    public let defaults: OpenClawChatSessionsDefaults?
    public let sessions: [OpenClawChatSessionEntry]

    public init(
        ts: Double?,
        path: String?,
        count: Int?,
        defaults: OpenClawChatSessionsDefaults?,
        sessions: [OpenClawChatSessionEntry])
    {
        self.ts = ts
        self.path = path
        self.count = count
        self.defaults = defaults
        self.sessions = sessions
    }
}

public struct OpenClawChatSessionChangedPayload: Codable, Sendable, Hashable {
    public let sessionKey: String?
    public let reason: String?
    public let phase: String?
    public let ts: Double?
    public let messageId: String?
    public let messageSeq: Int?
    public let compacted: Bool?
    public let kind: String?
    public let updatedAt: Double?
    public let sessionId: String?
    public let status: String?
    public let runClosureSummary: OpenClawChatRunClosureSummary?
    public let handoffRequestRunId: String?
    public let handoffRunId: String?
    public let handoffTruthSource: OpenClawChatSessionHandoffTruthSource?
    public let handoffHint: String?
    public let recoveryCheckpointId: String?
    public let recoveryStatus: String?
    public let recoveryContinuationState: String?
    public let recoveryOperation: String?
    public let recoveryBlockedReason: String?
    public let recoveryUpdatedAt: Double?
    public let recoveryAttempts: Int?
    public let recoveryOperatorHint: String?
    public let session: OpenClawChatSessionEntry?
}
