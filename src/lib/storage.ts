import type {
  AgentArchitectureMode,
  AgentSettings,
  BrowserSettings,
  WebFetchProviderSettings,
  WebFetchSettings,
  WebResearchSettings,
  WebSearchProviderSettings,
  WebSearchSettings,
  WebToolsSettings,
  CapabilityOverrideMode,
  CapabilityUsageSnapshot,
  ChatMessageVariant,
  CompletionState,
  ExecutionMode,
  ExecutionEvidenceSummary,
  InteractiveBrowserSettings,
  LightpandaSettings,
  MemoryMode,
  ProjectCapabilityOverrides,
  ResolvedAgentCapabilities,
  ProviderMode,
  ProviderProfile,
  ResearchMode,
  ProviderRetryStage,
  ReasoningEffort,
  RouteDecisionSnapshot,
  Session,
  SessionContextCompression,
  SessionFolder,
  WorkspaceCapabilityOverrides,
} from '../types'
import { builtinSkills } from '../catalog'
import { ensureAuraHome, type AuraHomeState } from './aura'
import { getSessionSortTimestamp, sortSessionsByRecentActivity } from './sessionMeta'
import {
  deletePersistedMessage,
  deletePersistedMessageVersion,
  deletePersistedSession,
  loadPersistedAppState,
  loadPersistedSessionMessages,
  searchPersistedSessionIds,
  savePersistedProjectCapabilityOverrides,
  savePersistedSessionFolders,
  savePersistedSettings,
  upsertPersistedMessage,
  upsertPersistedMessageVersion,
  upsertPersistedSession,
} from './persistence'

function createProfileId(prefix: string) {
  return `${prefix}-${Math.random().toString(36).slice(2, 8)}`
}

function baseUrlForProvider(provider: ProviderMode) {
  switch (provider) {
    case 'google':
      return 'https://generativelanguage.googleapis.com/v1beta'
    case 'custom':
      return 'https://api.openai.com/v1'
    default:
      return 'https://api.openai.com/v1'
  }
}

function defaultProfiles(): ProviderProfile[] {
  return [
    {
      id: 'profile-openai',
      name: 'OpenAI',
      provider: 'openai',
      apiKey: '',
      baseUrl: baseUrlForProvider('openai'),
      enabled: true,
      models: [],
      defaultModel: '',
    },
    {
      id: 'profile-google',
      name: 'Google',
      provider: 'google',
      apiKey: '',
      baseUrl: baseUrlForProvider('google'),
      enabled: false,
      models: [],
      defaultModel: '',
    },
    {
      id: 'profile-custom',
      name: 'Custom',
      provider: 'custom',
      apiKey: '',
      baseUrl: baseUrlForProvider('custom'),
      enabled: false,
      models: [],
      defaultModel: '',
    },
  ]
}

function defaultLightpandaSettings(): LightpandaSettings {
  return {
    enabled: false,
    executablePath: '',
    maxConcurrency: 4,
    timeoutSeconds: 12,
  }
}

function defaultInteractiveBrowserSettings(): InteractiveBrowserSettings {
  return {
    enabled: true,
    allowComputerUse: true,
  }
}

function defaultBrowserSettings(): BrowserSettings {
  return {
    lightpanda: defaultLightpandaSettings(),
    interactive: defaultInteractiveBrowserSettings(),
  }
}

function defaultWebSearchProviderSettings(): WebSearchProviderSettings {
  return {
    tavilyApiKey: '',
    braveApiKey: '',
  }
}

function defaultWebSearchSettings(): WebSearchSettings {
  return {
    enabled: true,
    provider: 'auto',
    timeoutSeconds: 12,
    cacheTtlMinutes: 30,
    maxResults: 5,
    providers: defaultWebSearchProviderSettings(),
  }
}

function defaultWebFetchSettings(): WebFetchSettings {
  return {
    enabled: true,
    provider: 'auto',
    timeoutSeconds: 15,
    maxCharsCap: 20_000,
    maxResponseBytes: 750_000,
    maxRedirects: 3,
    readability: true,
    providers: defaultWebFetchProviderSettings(),
  }
}

function defaultWebFetchProviderSettings(): WebFetchProviderSettings {
  return {
    jinaEnabled: true,
    jinaApiKey: '',
    jinaAllowAnonymous: true,
  }
}

function defaultWebResearchSettings(): WebResearchSettings {
  return {
    enabled: true,
    defaultSearchLimit: 5,
    defaultFetchLimit: 3,
    defaultMaxChars: 3_200,
    preferSearchContent: true,
    searchContentMinChars: 1_200,
    deepSearchLimit: 8,
    deepFetchLimit: 5,
    deepMaxChars: 5_200,
  }
}

function defaultWebToolsSettings(): WebToolsSettings {
  return {
    search: defaultWebSearchSettings(),
    fetch: defaultWebFetchSettings(),
    research: defaultWebResearchSettings(),
  }
}

export const defaultSettings: AgentSettings = {
  provider: 'openai',
  apiKey: '',
  baseUrl: baseUrlForProvider('openai'),
  model: '',
  analysisProviderProfileId: '',
  analysisModel: '',
  titleProviderProfileId: '',
  titleModel: '',
  activeProviderProfileId: 'profile-openai',
  providerProfiles: defaultProfiles(),
  agentArchitectureMode: 'default-agent',
  cwd: '',
  locale: 'zh-CN',
  providerProxyEnabled: false,
  networkProxy: '',
  maxSteps: 8,
  executionMode: 'bounded',
  memoryMode: 'summary',
  contextCompressionThresholdTokens: 256_000,
  reasoningEffort: 'medium',
  showDetailedExecutionDetails: false,
  requireLongTaskPlanApproval: false,
  enableMultiAgent: true,
  enableComputerUse: true,
  autoApproveShell: false,
  autoApproveFileWrite: false,
  autoApproveComputerUse: false,
  enabledSkillIds: [],
  enabledPluginIds: [],
  browser: defaultBrowserSettings(),
  web: defaultWebToolsSettings(),
  mcpServers: [],
  sendShortcut: 'meta-enter',
}

const builtinSkillIds = new Set(builtinSkills.map(skill => skill.id))

function createEmptyWorkspaceCapabilityOverrides(): WorkspaceCapabilityOverrides {
  return {
    skills: {},
    plugins: {},
    mcp: {},
  }
}

function normalizeCapabilityOverrideMode(value: unknown): CapabilityOverrideMode {
  return value === 'on' || value === 'off' ? value : 'inherit'
}

function normalizeCapabilityOverrideMap(value: unknown): Record<string, CapabilityOverrideMode> {
  if (!value || typeof value !== 'object') {
    return {}
  }

  return Object.fromEntries(
    Object.entries(value)
      .map(([key, entry]) => [key, normalizeCapabilityOverrideMode(entry)])
      .filter(([, entry]) => entry !== 'inherit'),
  )
}

function normalizeWorkspaceCapabilityOverrides(value: unknown): WorkspaceCapabilityOverrides {
  if (!value || typeof value !== 'object') {
    return createEmptyWorkspaceCapabilityOverrides()
  }

  return {
    skills: normalizeCapabilityOverrideMap((value as { skills?: unknown }).skills),
    plugins: normalizeCapabilityOverrideMap((value as { plugins?: unknown }).plugins),
    mcp: normalizeCapabilityOverrideMap((value as { mcp?: unknown }).mcp),
  }
}

function parseProjectCapabilityOverrides(raw: string | null): ProjectCapabilityOverrides {
  if (!raw) {
    return {}
  }

  try {
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') {
      return {}
    }

    return Object.fromEntries(
      Object.entries(parsed)
        .filter(([workspaceRoot]) => Boolean(workspaceRoot.trim()))
        .map(([workspaceRoot, value]) => [
          workspaceRoot,
          normalizeWorkspaceCapabilityOverrides(value),
        ]),
    )
  } catch {
    return {}
  }
}

function normalizeCapabilityUsageSnapshot(value: unknown): CapabilityUsageSnapshot | undefined {
  if (!value || typeof value !== 'object') {
    return undefined
  }

  const snapshot = value as Partial<CapabilityUsageSnapshot>
  const workspaceRoot =
    typeof snapshot.workspaceRoot === 'string' ? snapshot.workspaceRoot : ''
  if (!workspaceRoot.trim()) {
    return undefined
  }

  function normalizeEntries(entries: unknown) {
    if (!Array.isArray(entries)) {
      return []
    }

    return entries
      .map(entry => {
        if (!entry || typeof entry !== 'object') {
          return null
        }

        const id = typeof (entry as { id?: unknown }).id === 'string' ? (entry as { id: string }).id : ''
        const name =
          typeof (entry as { name?: unknown }).name === 'string'
            ? (entry as { name: string }).name
            : id
        if (!id.trim()) {
          return null
        }

        return {
          id,
          name: name || id,
        }
      })
      .filter((entry): entry is { id: string; name: string } => Boolean(entry))
  }

  return {
    workspaceRoot,
    resolvedAt:
      typeof snapshot.resolvedAt === 'number' && Number.isFinite(snapshot.resolvedAt)
        ? snapshot.resolvedAt
        : Date.now(),
    skills: normalizeEntries(snapshot.skills),
    plugins: normalizeEntries(snapshot.plugins),
    mcpServers: normalizeEntries(snapshot.mcpServers),
  }
}

function normalizeProviderRetryInfo(value: unknown) {
  if (!value || typeof value !== 'object') {
    return undefined
  }

  const retryInfo = value as {
    attemptedRetries?: unknown
    configuredMaxRetries?: unknown
    configuredMaxAttempts?: unknown
    stage?: unknown
    stageLabel?: unknown
    recovered?: unknown
    inProgress?: unknown
    nextRetryDelayMs?: unknown
    nextAttemptNumber?: unknown
    lastErrorSummary?: unknown
  }
  const configuredMaxRetries =
    typeof retryInfo.configuredMaxRetries === 'number' && Number.isFinite(retryInfo.configuredMaxRetries)
      ? Math.max(0, Math.round(retryInfo.configuredMaxRetries))
      : typeof retryInfo.configuredMaxAttempts === 'number' &&
          Number.isFinite(retryInfo.configuredMaxAttempts)
        ? Math.max(0, Math.round(retryInfo.configuredMaxAttempts) - 1)
        : undefined
  const stage: ProviderRetryStage | undefined =
    retryInfo.stage === 'response' ||
    retryInfo.stage === 'finalization' ||
    retryInfo.stage === 'recovery'
      ? retryInfo.stage
      : undefined
  const configuredMaxAttempts =
    typeof retryInfo.configuredMaxAttempts === 'number' &&
    Number.isFinite(retryInfo.configuredMaxAttempts)
      ? Math.max(1, Math.round(retryInfo.configuredMaxAttempts))
      : typeof configuredMaxRetries === 'number'
        ? configuredMaxRetries + 1
        : undefined
  if (
    typeof retryInfo.attemptedRetries !== 'number' ||
    !Number.isFinite(retryInfo.attemptedRetries) ||
    retryInfo.attemptedRetries <= 0 ||
    typeof configuredMaxAttempts !== 'number' ||
    configuredMaxAttempts <= 0
  ) {
    return undefined
  }

  return {
    attemptedRetries: Math.max(0, Math.round(retryInfo.attemptedRetries)),
    configuredMaxRetries,
    configuredMaxAttempts,
    stage,
    stageLabel: typeof retryInfo.stageLabel === 'string' ? retryInfo.stageLabel : undefined,
    recovered: retryInfo.recovered === true,
    inProgress: retryInfo.inProgress === true,
    nextRetryDelayMs:
      typeof retryInfo.nextRetryDelayMs === 'number' &&
      Number.isFinite(retryInfo.nextRetryDelayMs)
        ? Math.max(0, Math.round(retryInfo.nextRetryDelayMs))
        : undefined,
    nextAttemptNumber:
      typeof retryInfo.nextAttemptNumber === 'number' &&
      Number.isFinite(retryInfo.nextAttemptNumber)
        ? Math.max(1, Math.round(retryInfo.nextAttemptNumber))
        : undefined,
    lastErrorSummary:
      typeof retryInfo.lastErrorSummary === 'string'
        ? retryInfo.lastErrorSummary
        : undefined,
  }
}

function normalizeSessionContextCompression(value: unknown): SessionContextCompression | undefined {
  if (!value || typeof value !== 'object') {
    return undefined
  }

  const compression = value as Partial<SessionContextCompression>
  const id = typeof compression.id === 'string' ? compression.id.trim() : ''
  const summary = typeof compression.summary === 'string' ? compression.summary.trim() : ''
  const compressedThroughMessageId =
    typeof compression.compressedThroughMessageId === 'string'
      ? compression.compressedThroughMessageId.trim()
      : ''
  const createdAt =
    typeof compression.createdAt === 'number' && Number.isFinite(compression.createdAt)
      ? Math.max(0, Math.round(compression.createdAt))
      : Date.now()

  if (!summary || !compressedThroughMessageId) {
    return undefined
  }

  const numberField = (key: keyof SessionContextCompression) => {
    const raw = compression[key]
    return typeof raw === 'number' && Number.isFinite(raw)
      ? Math.max(0, Math.round(raw))
      : undefined
  }
  const stringField = (key: keyof SessionContextCompression) => {
    const raw = compression[key]
    return typeof raw === 'string' ? raw.trim() || undefined : undefined
  }

  return {
    id: id || `context-compression-${createdAt}`,
    summary,
    compressedThroughMessageId,
    originalMessageCount:
      typeof compression.originalMessageCount === 'number' &&
      Number.isFinite(compression.originalMessageCount)
        ? Math.max(0, Math.round(compression.originalMessageCount))
        : 0,
    originalTokenEstimate:
      typeof compression.originalTokenEstimate === 'number' &&
      Number.isFinite(compression.originalTokenEstimate)
        ? Math.max(0, Math.round(compression.originalTokenEstimate))
        : 0,
    compressedTokenEstimate:
      typeof compression.compressedTokenEstimate === 'number' &&
      Number.isFinite(compression.compressedTokenEstimate)
        ? Math.max(0, Math.round(compression.compressedTokenEstimate))
        : 0,
    createdAt,
    kind: stringField('kind'),
    trigger: stringField('trigger'),
    activePromptTokens: numberField('activePromptTokens'),
    activePromptLimit: numberField('activePromptLimit'),
    contextWindowTokens: numberField('contextWindowTokens'),
    configuredContextWindowTokens: numberField('configuredContextWindowTokens'),
    configuredThresholdTokens: numberField('configuredThresholdTokens'),
    compressionThresholdTokens: numberField('compressionThresholdTokens'),
    effectiveThresholdTokens: numberField('effectiveThresholdTokens'),
    systemPromptTokens: numberField('systemPromptTokens'),
    toolSchemaTokens: numberField('toolSchemaTokens'),
    maxOutputTokens: numberField('maxOutputTokens'),
    toolResultBufferTokens: numberField('toolResultBufferTokens'),
    summaryTokens: numberField('summaryTokens'),
    windowSource: stringField('windowSource'),
    preserved: Array.isArray(compression.preserved)
      ? compression.preserved
        .map(item => (typeof item === 'string' ? item.trim() : ''))
        .filter(Boolean)
        .slice(0, 8)
      : undefined,
    providerProfileId:
      typeof compression.providerProfileId === 'string'
        ? compression.providerProfileId.trim() || undefined
        : undefined,
    model:
      typeof compression.model === 'string'
        ? compression.model.trim() || undefined
        : undefined,
  }
}

function normalizeAgentMode(value: unknown): AgentArchitectureMode | undefined {
  return value === 'default-agent' || value === 'orchestrated'
    ? value
    : undefined
}

function normalizeCompletionState(value: unknown): CompletionState | undefined {
  return value === 'not_executed' ||
    value === 'executed_unverified' ||
    value === 'executed_verified' ||
    value === 'blocked_by_approval' ||
    value === 'blocked_by_capability' ||
    value === 'failed_after_execution'
    ? value
    : undefined
}

function normalizeEvidenceSummary(value: unknown): ExecutionEvidenceSummary | undefined {
  if (!value || typeof value !== 'object') {
    return undefined
  }

  const summary = value as Partial<ExecutionEvidenceSummary>
  const records = Array.isArray(summary.records)
    ? summary.records
        .map(record => {
          if (!record || typeof record !== 'object') {
            return null
          }

          return {
            toolName: typeof record.toolName === 'string' ? record.toolName : '',
            source:
              record.source === 'builtin' ||
              record.source === 'plugin' ||
              record.source === 'mcp' ||
              record.source === 'subagent'
                ? record.source
                : 'builtin',
            status:
              record.status === 'success' ||
              record.status === 'error' ||
              record.status === 'denied'
                ? record.status
                : 'success',
            effectTypes: Array.isArray(record.effectTypes)
              ? record.effectTypes.filter(
                  (entry): entry is NonNullable<typeof record.effectTypes>[number] =>
                    entry === 'read' ||
                    entry === 'write' ||
                    entry === 'execute' ||
                    entry === 'browser' ||
                    entry === 'plan',
                )
              : [],
            producedEvidence: Array.isArray(record.producedEvidence)
              ? record.producedEvidence.filter(
                  (entry): entry is NonNullable<typeof record.producedEvidence>[number] =>
                    entry === 'file_mutation' ||
                    entry === 'file_verified' ||
                    entry === 'artifact_present' ||
                    entry === 'artifact_read_back' ||
                    entry === 'artifact_hash_recorded' ||
                    entry === 'command_exit_0' ||
                    entry === 'command_exit_nonzero' ||
                    entry === 'command_session' ||
                    entry === 'command_timeout' ||
                    entry === 'command_output' ||
                    entry === 'test_pass' ||
                    entry === 'test_fail' ||
                    entry === 'page_state' ||
                    entry === 'web_search_result' ||
                    entry === 'web_research_result' ||
                    entry === 'web_fetch_content' ||
                    entry === 'web_fetch_summary' ||
                    entry === 'search_result' ||
                    entry === 'user_denied',
                )
              : [],
            verificationLevel:
              record.verificationLevel === 'none' ||
              record.verificationLevel === 'partial' ||
              record.verificationLevel === 'verified'
                ? record.verificationLevel
                : 'none',
            detail: typeof record.detail === 'string' ? record.detail : undefined,
          }
        })
        .filter((record): record is NonNullable<typeof record> => Boolean(record))
    : []

  return {
    records,
    hasAnyExecution: summary.hasAnyExecution === true,
    hasWriteEffect: summary.hasWriteEffect === true,
    hasBrowserEffect: summary.hasBrowserEffect === true,
    hasFileVerification: summary.hasFileVerification === true,
    verifiedArtifactCount:
      typeof summary.verifiedArtifactCount === 'number' &&
      Number.isFinite(summary.verifiedArtifactCount)
        ? Math.max(0, Math.round(summary.verifiedArtifactCount))
        : 0,
    artifactPaths: Array.isArray(summary.artifactPaths)
      ? summary.artifactPaths.filter(
          (entry): entry is string => typeof entry === 'string' && entry.trim().length > 0,
        )
      : [],
    hasArtifactEvidence:
      summary.hasArtifactEvidence === true ||
      (Array.isArray(summary.artifactPaths) && summary.artifactPaths.length > 0) ||
      summary.hasFileVerification === true,
    hasSuccessfulCommand: summary.hasSuccessfulCommand === true,
    hasSuccessfulBrowserAction: summary.hasSuccessfulBrowserAction === true,
    hasVerifiedEvidence: summary.hasVerifiedEvidence === true,
    hasApprovalBlock: summary.hasApprovalBlock === true,
    hasCapabilityBlock: summary.hasCapabilityBlock === true,
    hasExecutionFailure: summary.hasExecutionFailure === true,
  }
}

function normalizeRouteDecision(value: unknown): RouteDecisionSnapshot | undefined {
  if (!value || typeof value !== 'object') {
    return undefined
  }

  const routeDecision = value as Partial<RouteDecisionSnapshot>
  const answerMode =
    routeDecision.answerMode === 'advise' ||
    routeDecision.answerMode === 'diagnose' ||
    routeDecision.answerMode === 'execute'
      ? routeDecision.answerMode
      : undefined
  const capabilityTier =
    routeDecision.capabilityTier === 'none' ||
    routeDecision.capabilityTier === 'local-readonly' ||
    routeDecision.capabilityTier === 'local-write' ||
    routeDecision.capabilityTier === 'web-lookup' ||
    routeDecision.capabilityTier === 'browser-interactive'
      ? routeDecision.capabilityTier
      : undefined

  if (!answerMode || !capabilityTier) {
    return undefined
  }

  function normalizeEscalationTargets(targets: unknown) {
    if (!Array.isArray(targets)) {
      return []
    }
    return targets.filter(
      (target): target is NonNullable<RouteDecisionSnapshot['allowEscalationTo']>[number] =>
        target === 'local-write' ||
        target === 'web-lookup' ||
        target === 'browser-interactive',
    )
  }

  function normalizeStrings(values: unknown) {
    if (!Array.isArray(values)) {
      return []
    }
    return values.filter(
      (value): value is string =>
        typeof value === 'string' && value.trim().length > 0,
    )
  }

  function normalizeTierHistory(values: unknown) {
    if (!Array.isArray(values)) {
      return []
    }
    return values.filter(
      (value): value is NonNullable<RouteDecisionSnapshot['tierHistory']>[number] =>
        value === 'none' ||
        value === 'local-readonly' ||
        value === 'local-write' ||
        value === 'web-lookup' ||
        value === 'browser-interactive',
    )
  }

  return {
    answerMode,
    capabilityTier,
    budgets:
      routeDecision.budgets &&
      typeof routeDecision.budgets === 'object' &&
      typeof routeDecision.budgets.searchesRemaining === 'number' &&
      typeof routeDecision.budgets.browserEscalationsRemaining === 'number' &&
      typeof routeDecision.budgets.writeEscalationsRemaining === 'number'
        ? {
            searchesRemaining: routeDecision.budgets.searchesRemaining,
            browserEscalationsRemaining:
              routeDecision.budgets.browserEscalationsRemaining,
            writeEscalationsRemaining: routeDecision.budgets.writeEscalationsRemaining,
          }
        : undefined,
    allowEscalationTo: normalizeEscalationTargets(routeDecision.allowEscalationTo),
    availableEscalations: normalizeEscalationTargets(routeDecision.availableEscalations),
    escalationCount:
      typeof routeDecision.escalationCount === 'number' &&
      Number.isFinite(routeDecision.escalationCount)
        ? Math.max(0, Math.round(routeDecision.escalationCount))
        : undefined,
    tierHistory: normalizeTierHistory(routeDecision.tierHistory),
    stopReason:
      routeDecision.stopReason === 'completed' ||
      routeDecision.stopReason === 'completed_with_evidence' ||
      routeDecision.stopReason === 'no_incremental_progress' ||
      routeDecision.stopReason === 'budget_exhausted' ||
      routeDecision.stopReason === 'runtime_pass_limit'
        ? routeDecision.stopReason
        : undefined,
    mountedCapabilities:
      routeDecision.mountedCapabilities &&
      typeof routeDecision.mountedCapabilities === 'object'
        ? {
            skills: normalizeStrings(routeDecision.mountedCapabilities.skills),
            plugins: normalizeStrings(routeDecision.mountedCapabilities.plugins),
            mcpServers: normalizeStrings(routeDecision.mountedCapabilities.mcpServers),
            tools: normalizeStrings(routeDecision.mountedCapabilities.tools),
          }
        : undefined,
    contextEstimate:
      routeDecision.contextEstimate &&
      typeof routeDecision.contextEstimate === 'object' &&
      typeof routeDecision.contextEstimate.systemPromptTokens === 'number' &&
      typeof routeDecision.contextEstimate.toolSchemaTokens === 'number' &&
      typeof routeDecision.contextEstimate.promptEnvelopeTokens === 'number' &&
      typeof routeDecision.contextEstimate.contextWindowTokens === 'number' &&
      typeof routeDecision.contextEstimate.compressionThresholdTokens === 'number'
        ? {
            systemPromptTokens: Math.max(
              0,
              Math.round(routeDecision.contextEstimate.systemPromptTokens),
            ),
            toolSchemaTokens: Math.max(
              0,
              Math.round(routeDecision.contextEstimate.toolSchemaTokens),
            ),
            promptEnvelopeTokens: Math.max(
              0,
              Math.round(routeDecision.contextEstimate.promptEnvelopeTokens),
            ),
            contextWindowTokens: Math.max(
              0,
              Math.round(routeDecision.contextEstimate.contextWindowTokens),
            ),
            configuredContextWindowTokens:
              typeof routeDecision.contextEstimate.configuredContextWindowTokens === 'number' &&
                Number.isFinite(routeDecision.contextEstimate.configuredContextWindowTokens)
                ? Math.max(
                  0,
                  Math.round(routeDecision.contextEstimate.configuredContextWindowTokens),
                )
                : undefined,
            windowSource:
              typeof routeDecision.contextEstimate.windowSource === 'string'
                ? routeDecision.contextEstimate.windowSource.trim() || undefined
                : undefined,
            compressionThresholdTokens: Math.max(
              0,
              Math.round(routeDecision.contextEstimate.compressionThresholdTokens),
            ),
            conversationTokens:
              typeof routeDecision.contextEstimate.conversationTokens === 'number' &&
                Number.isFinite(routeDecision.contextEstimate.conversationTokens)
                ? Math.max(
                  0,
                  Math.round(routeDecision.contextEstimate.conversationTokens),
                )
                : undefined,
            promptTokens:
              typeof routeDecision.contextEstimate.promptTokens === 'number' &&
                Number.isFinite(routeDecision.contextEstimate.promptTokens)
                ? Math.max(0, Math.round(routeDecision.contextEstimate.promptTokens))
                : undefined,
            effectiveThresholdTokens:
              typeof routeDecision.contextEstimate.effectiveThresholdTokens === 'number' &&
                Number.isFinite(routeDecision.contextEstimate.effectiveThresholdTokens)
                ? Math.max(
                  0,
                  Math.round(routeDecision.contextEstimate.effectiveThresholdTokens),
                )
                : undefined,
          }
        : undefined,
  }
}

function normalizeMessageParts(value: unknown) {
  if (!Array.isArray(value)) {
    return []
  }

  return value
    .map(part => {
      if (!part || typeof part !== 'object') {
        return null
      }

      if (
        (part as { type?: unknown }).type === 'text' &&
        typeof (part as { text?: unknown }).text === 'string'
      ) {
        return {
          type: 'text' as const,
          text: (part as { text: string }).text,
        }
      }

      if (
        (part as { type?: unknown }).type === 'image' &&
        typeof (part as { name?: unknown }).name === 'string' &&
        typeof (part as { mimeType?: unknown }).mimeType === 'string'
      ) {
        return {
          type: 'image' as const,
          name: (part as { name: string }).name,
          mimeType: (part as { mimeType: string }).mimeType,
          path:
            typeof (part as { path?: unknown }).path === 'string'
              ? (part as { path?: string }).path
              : undefined,
          dataUrl:
            typeof (part as { dataUrl?: unknown }).dataUrl === 'string'
              ? (part as { dataUrl?: string }).dataUrl
              : undefined,
        }
      }

      if (
        (part as { type?: unknown }).type === 'file' &&
        typeof (part as { name?: unknown }).name === 'string' &&
        typeof (part as { path?: unknown }).path === 'string'
      ) {
        return {
          type: 'file' as const,
          name: (part as { name: string }).name,
          path: (part as { path: string }).path,
          mimeType:
            typeof (part as { mimeType?: unknown }).mimeType === 'string'
              ? (part as { mimeType?: string }).mimeType
              : undefined,
        }
      }

      return null
    })
    .filter((part): part is NonNullable<typeof part> => Boolean(part))
}

function normalizeMessageAttachments(value: unknown) {
  if (!Array.isArray(value)) {
    return []
  }

  return value
    .map(attachment => {
      if (!attachment || typeof attachment !== 'object') {
        return null
      }
      const path = typeof attachment.path === 'string' ? attachment.path : ''
      if (!path) {
        return null
      }
      return {
        id:
          typeof attachment.id === 'string' && attachment.id.trim()
            ? attachment.id
            : Math.random().toString(36).slice(2, 10),
        name:
          typeof attachment.name === 'string' && attachment.name.trim()
            ? attachment.name
            : path.split('/').pop() || '附件',
        path,
        preview: typeof attachment.preview === 'string' ? attachment.preview : undefined,
        mimeType:
          typeof attachment.mimeType === 'string' ? attachment.mimeType : undefined,
      }
    })
    .filter((attachment): attachment is NonNullable<typeof attachment> => Boolean(attachment))
}

function normalizeMessageReasoning(value: unknown) {
  if (!Array.isArray(value)) {
    return []
  }

  return value
    .map(reasoning => {
      if (!reasoning || typeof reasoning !== 'object') {
        return null
      }
      if (typeof reasoning.content !== 'string' || !reasoning.content.trim()) {
        return null
      }
      return {
        id:
          typeof reasoning.id === 'string' && reasoning.id.trim()
            ? reasoning.id
            : Math.random().toString(36).slice(2, 10),
        kind: (reasoning.kind === 'summary' ? 'summary' : 'provider') as
          | 'summary'
          | 'provider',
        content: reasoning.content,
        order: typeof reasoning.order === 'number' ? reasoning.order : undefined,
        createdAt: typeof reasoning.createdAt === 'number' ? reasoning.createdAt : undefined,
      }
    })
    .filter((reasoning): reasoning is NonNullable<typeof reasoning> => Boolean(reasoning))
}

function normalizeMessagePhaseOutputs(value: unknown) {
  if (!Array.isArray(value)) {
    return []
  }

  return value
    .map(output => {
      if (!output || typeof output !== 'object') {
        return null
      }
      if (typeof output.content !== 'string' || !output.content.trim()) {
        return null
      }
      if (typeof output.blockId !== 'string' || !output.blockId.trim()) {
        return null
      }

      return {
        id:
          typeof output.id === 'string' && output.id.trim()
            ? output.id
            : `phase-${output.blockId}`,
        blockId: output.blockId,
        content: output.content,
        order: typeof output.order === 'number' ? output.order : undefined,
      }
    })
    .filter((output): output is NonNullable<typeof output> => Boolean(output))
}

function normalizeMessageVariant(
  value: unknown,
  fallbackCreatedAt: number,
): ChatMessageVariant | null {
  if (!value || typeof value !== 'object') {
    return null
  }

  const variant = value as Partial<ChatMessageVariant>
  const researchMode: ResearchMode | undefined =
    variant.researchMode === 'deep' || variant.researchMode === 'auto'
      ? variant.researchMode
      : undefined
  return {
    id: typeof variant.id === 'string' && variant.id.trim() ? variant.id : undefined,
    content: typeof variant.content === 'string' ? variant.content : '',
    parts: normalizeMessageParts(variant.parts),
    status:
      variant.status === 'pending' ||
      variant.status === 'streaming' ||
      variant.status === 'failed'
        ? variant.status
        : 'completed',
    createdAt:
      typeof variant.createdAt === 'number' ? variant.createdAt : fallbackCreatedAt,
    researchMode,
    attachments: normalizeMessageAttachments(variant.attachments),
    reasoning: normalizeMessageReasoning(variant.reasoning),
    phaseOutputs: normalizeMessagePhaseOutputs(variant.phaseOutputs),
    usage:
      variant.usage && typeof variant.usage === 'object'
        ? {
            inputTokens:
              typeof variant.usage.inputTokens === 'number'
                ? variant.usage.inputTokens
                : undefined,
            outputTokens:
              typeof variant.usage.outputTokens === 'number'
                ? variant.usage.outputTokens
                : undefined,
            latestInputTokens:
              typeof variant.usage.latestInputTokens === 'number'
                ? variant.usage.latestInputTokens
                : undefined,
            latestOutputTokens:
              typeof variant.usage.latestOutputTokens === 'number'
                ? variant.usage.latestOutputTokens
                : undefined,
            contextWindow:
              typeof variant.usage.contextWindow === 'number'
                ? variant.usage.contextWindow
                : undefined,
          }
        : undefined,
    capabilitySnapshot: normalizeCapabilityUsageSnapshot(variant.capabilitySnapshot),
    activity: variant.activity,
    events: Array.isArray(variant.events) ? variant.events : [],
    steps: Array.isArray(variant.steps) ? variant.steps : [],
    error: typeof variant.error === 'string' ? variant.error : undefined,
    errorInfo:
      variant.errorInfo && typeof variant.errorInfo === 'object'
        ? variant.errorInfo
        : undefined,
    retryInfo: normalizeProviderRetryInfo(variant.retryInfo),
    agentMode: normalizeAgentMode(variant.agentMode),
    routeDecision: normalizeRouteDecision(variant.routeDecision),
    completionState: normalizeCompletionState(variant.completionState),
    evidenceSummary: normalizeEvidenceSummary(variant.evidenceSummary),
    deliveryNote:
      typeof variant.deliveryNote === 'string' ? variant.deliveryNote : undefined,
    modelInfo:
      variant.modelInfo &&
      typeof variant.modelInfo === 'object' &&
      typeof variant.modelInfo.providerProfileId === 'string' &&
      typeof variant.modelInfo.providerProfileName === 'string' &&
      (variant.modelInfo.provider === 'openai' ||
        variant.modelInfo.provider === 'google' ||
        variant.modelInfo.provider === 'custom') &&
      typeof variant.modelInfo.modelId === 'string' &&
      typeof variant.modelInfo.label === 'string'
        ? {
            providerProfileId: variant.modelInfo.providerProfileId,
            providerProfileName: variant.modelInfo.providerProfileName,
            provider: variant.modelInfo.provider,
            modelId: variant.modelInfo.modelId,
            label: variant.modelInfo.label,
          }
        : undefined,
    appendedInputs: Array.isArray(variant.appendedInputs)
      ? variant.appendedInputs
          .map(input => {
            if (!input || typeof input !== 'object') {
              return null
            }

            const entry = input as {
              id?: unknown
              content?: unknown
              parts?: unknown
              attachments?: unknown
              createdAt?: unknown
              status?: unknown
              researchMode?: unknown
            }
            if (typeof entry.id !== 'string' || !entry.id.trim()) {
              return null
            }

            const researchMode: ResearchMode | undefined =
              entry.researchMode === 'deep' || entry.researchMode === 'auto'
                ? entry.researchMode
                : undefined

            return {
              id: entry.id,
              content: typeof entry.content === 'string' ? entry.content : '',
              parts: normalizeMessageParts(entry.parts),
              attachments: normalizeMessageAttachments(entry.attachments),
              createdAt:
                typeof entry.createdAt === 'number' && Number.isFinite(entry.createdAt)
                  ? entry.createdAt
                  : fallbackCreatedAt,
              status: entry.status === 'consumed' ? ('consumed' as const) : ('queued' as const),
              researchMode,
            }
          })
          .filter((input): input is NonNullable<typeof input> => Boolean(input))
      : [],
  }
}

function resolveCapabilityEnabled(
  globalEnabled: boolean,
  override: CapabilityOverrideMode | undefined,
) {
  if (override === 'on') {
    return true
  }
  if (override === 'off') {
    return false
  }
  return globalEnabled
}

function normalizeMcpServers(value: unknown) {
  if (!Array.isArray(value)) {
    return []
  }

  const byFingerprint = new Map<string, AgentSettings['mcpServers'][number]>()

  for (const [index, entry] of value.entries()) {
    if (!entry || typeof entry !== 'object') {
      continue
    }

    const server = entry as Partial<AgentSettings['mcpServers'][number]>
    const id =
      typeof server.id === 'string' && server.id.trim()
        ? server.id
        : `mcp-${Math.random().toString(36).slice(2, 10)}-${index}`
    const name =
      typeof server.name === 'string' && server.name.trim() ? server.name.trim() : 'new-mcp'
    const command = typeof server.command === 'string' ? server.command.trim() : ''
    const args = typeof server.args === 'string' ? server.args.trim() : ''
    const cwd = typeof server.cwd === 'string' ? server.cwd.trim() : ''
    const healthStatus =
      server.healthStatus === 'ok' || server.healthStatus === 'error'
        ? server.healthStatus
        : 'unknown'
    const normalized = {
      id,
      name,
      description:
        typeof server.description === 'string'
          ? server.description
          : '',
      command,
      args,
      env:
        typeof server.env === 'string'
          ? server.env
          : '{}',
      cwd,
      enabled: server.enabled === true && healthStatus === 'ok',
      healthStatus,
      healthMessage:
        typeof server.healthMessage === 'string' ? server.healthMessage : '',
      lastCheckedAt:
        typeof server.lastCheckedAt === 'number' && Number.isFinite(server.lastCheckedAt)
          ? server.lastCheckedAt
          : undefined,
      toolCount:
        typeof server.toolCount === 'number' && Number.isFinite(server.toolCount)
          ? Math.max(0, Math.round(server.toolCount))
          : undefined,
      isDefault: server.isDefault === true,
    } as AgentSettings['mcpServers'][number]
    const fingerprint = [command, args, cwd, name.toLowerCase()].join('::')
    const existing = byFingerprint.get(fingerprint)

    byFingerprint.set(fingerprint, existing
      ? {
          ...existing,
          ...normalized,
          id: existing.id || normalized.id,
        }
      : normalized)
  }

  return Array.from(byFingerprint.values())
}

function normalizeProviderProfiles(value: AgentSettings['providerProfiles']) {
  return value.map(profile => ({
    ...profile,
    models: normalizeModels(profile.models),
  }))
}

function normalizeMutableSettings(settings: AgentSettings): AgentSettings {
  return {
    ...settings,
    providerProfiles: normalizeProviderProfiles(settings.providerProfiles),
    locale: normalizeLocale(settings.locale),
    analysisProviderProfileId:
      typeof settings.analysisProviderProfileId === 'string'
        ? settings.analysisProviderProfileId
        : '',
    analysisModel:
      typeof settings.analysisModel === 'string' ? settings.analysisModel : '',
    titleProviderProfileId:
      typeof settings.titleProviderProfileId === 'string'
        ? settings.titleProviderProfileId
        : '',
    titleModel:
      typeof settings.titleModel === 'string' ? settings.titleModel : '',
    browser: normalizeBrowserSettings(settings.browser),
    web: normalizeWebToolsSettings(settings.web),
    mcpServers: normalizeMcpServers(settings.mcpServers),
  }
}

function normalizeWebSearchProviderSettings(value: unknown): WebSearchProviderSettings {
  const defaults = defaultWebSearchProviderSettings()
  if (!value || typeof value !== 'object') {
    return defaults
  }

  const entry = value as Partial<WebSearchProviderSettings>
  return {
    tavilyApiKey: typeof entry.tavilyApiKey === 'string' ? entry.tavilyApiKey : defaults.tavilyApiKey,
    braveApiKey: typeof entry.braveApiKey === 'string' ? entry.braveApiKey : defaults.braveApiKey,
  }
}

function clampIntegerSetting(value: unknown, fallback: number, min: number, max: number) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback
  }
  return Math.max(min, Math.min(max, Math.round(value)))
}

function normalizeWebSearchSettings(value: unknown): WebSearchSettings {
  const defaults = defaultWebSearchSettings()
  if (!value || typeof value !== 'object') {
    return defaults
  }

  const entry = value as Partial<WebSearchSettings>
  return {
    enabled: entry.enabled !== false,
    provider:
      entry.provider === 'tavily' ||
      entry.provider === 'brave' ||
      entry.provider === 'duckduckgo' ||
      entry.provider === 'auto'
        ? entry.provider
        : defaults.provider,
    timeoutSeconds: clampIntegerSetting(entry.timeoutSeconds, defaults.timeoutSeconds, 3, 60),
    cacheTtlMinutes: clampIntegerSetting(entry.cacheTtlMinutes, defaults.cacheTtlMinutes, 0, 24 * 60),
    maxResults: clampIntegerSetting(entry.maxResults, defaults.maxResults, 1, 10),
    providers: normalizeWebSearchProviderSettings(entry.providers),
  }
}

function normalizeWebFetchSettings(value: unknown): WebFetchSettings {
  const defaults = defaultWebFetchSettings()
  if (!value || typeof value !== 'object') {
    return defaults
  }

  const entry = value as Partial<WebFetchSettings>
  return {
    enabled: entry.enabled !== false,
    provider:
      entry.provider === 'http-readability' || entry.provider === 'auto'
        ? entry.provider
        : defaults.provider,
    timeoutSeconds: clampIntegerSetting(entry.timeoutSeconds, defaults.timeoutSeconds, 3, 90),
    maxCharsCap: clampIntegerSetting(entry.maxCharsCap, defaults.maxCharsCap, 500, 100_000),
    maxResponseBytes: clampIntegerSetting(
      entry.maxResponseBytes,
      defaults.maxResponseBytes,
      32_000,
      10_000_000,
    ),
    maxRedirects: clampIntegerSetting(entry.maxRedirects, defaults.maxRedirects, 0, 10),
    readability: entry.readability !== false,
    providers: normalizeWebFetchProviderSettings((entry as Partial<WebFetchSettings>).providers),
  }
}

function normalizeWebFetchProviderSettings(value: unknown): WebFetchProviderSettings {
  const defaults = defaultWebFetchProviderSettings()
  if (!value || typeof value !== 'object') {
    return defaults
  }

  const entry = value as Partial<WebFetchProviderSettings>
  return {
    jinaEnabled: entry.jinaEnabled === true,
    jinaApiKey: typeof entry.jinaApiKey === 'string' ? entry.jinaApiKey : defaults.jinaApiKey,
    jinaAllowAnonymous: entry.jinaAllowAnonymous === true,
  }
}

function normalizeWebResearchSettings(value: unknown): WebResearchSettings {
  const defaults = defaultWebResearchSettings()
  if (!value || typeof value !== 'object') {
    return defaults
  }

  const entry = value as Partial<WebResearchSettings>
  return {
    enabled: entry.enabled !== false,
    defaultSearchLimit: clampIntegerSetting(
      entry.defaultSearchLimit,
      defaults.defaultSearchLimit,
      1,
      10,
    ),
    defaultFetchLimit: clampIntegerSetting(
      entry.defaultFetchLimit,
      defaults.defaultFetchLimit,
      1,
      6,
    ),
    defaultMaxChars: clampIntegerSetting(
      entry.defaultMaxChars,
      defaults.defaultMaxChars,
      500,
      20_000,
    ),
    preferSearchContent: entry.preferSearchContent !== false,
    searchContentMinChars: clampIntegerSetting(
      entry.searchContentMinChars,
      defaults.searchContentMinChars,
      200,
      8_000,
    ),
    deepSearchLimit: clampIntegerSetting(
      entry.deepSearchLimit,
      defaults.deepSearchLimit,
      2,
      10,
    ),
    deepFetchLimit: clampIntegerSetting(
      entry.deepFetchLimit,
      defaults.deepFetchLimit,
      1,
      6,
    ),
    deepMaxChars: clampIntegerSetting(
      entry.deepMaxChars,
      defaults.deepMaxChars,
      800,
      20_000,
    ),
  }
}

function normalizeWebToolsSettings(value: unknown): WebToolsSettings {
  const defaults = defaultWebToolsSettings()
  if (!value || typeof value !== 'object') {
    return defaults
  }

  const entry = value as Partial<WebToolsSettings>
  return {
    search: normalizeWebSearchSettings(entry.search),
    fetch: normalizeWebFetchSettings(entry.fetch),
    research: normalizeWebResearchSettings(entry.research),
  }
}

function normalizeLightpandaSettings(value: unknown): LightpandaSettings {
  const defaults = defaultLightpandaSettings()
  if (!value || typeof value !== 'object') {
    return defaults
  }

  const entry = value as Partial<LightpandaSettings>
  return {
    enabled: entry.enabled === true,
    executablePath:
      typeof entry.executablePath === 'string' ? entry.executablePath.trim() : defaults.executablePath,
    maxConcurrency: clampIntegerSetting(entry.maxConcurrency, defaults.maxConcurrency, 1, 12),
    timeoutSeconds: clampIntegerSetting(entry.timeoutSeconds, defaults.timeoutSeconds, 3, 90),
  }
}

function normalizeInteractiveBrowserSettings(value: unknown): InteractiveBrowserSettings {
  const defaults = defaultInteractiveBrowserSettings()
  if (!value || typeof value !== 'object') {
    return defaults
  }

  const entry = value as Partial<InteractiveBrowserSettings>
  return {
    enabled: entry.enabled !== false,
    allowComputerUse: entry.allowComputerUse !== false,
  }
}

function normalizeBrowserSettings(value: unknown): BrowserSettings {
  const defaults = defaultBrowserSettings()
  if (!value || typeof value !== 'object') {
    return defaults
  }

  const entry = value as Partial<BrowserSettings> & {
    lightpanda?: unknown
    interactive?: unknown
  }
  const hasNewShape =
    Object.prototype.hasOwnProperty.call(entry, 'lightpanda') ||
    Object.prototype.hasOwnProperty.call(entry, 'interactive')

  if (!hasNewShape) {
    return defaults
  }

  return {
    lightpanda: normalizeLightpandaSettings(entry.lightpanda),
    interactive: normalizeInteractiveBrowserSettings(entry.interactive),
  }
}

function parseSettings(raw: string | null): AgentSettings {
  if (!raw) {
    return defaultSettings
  }

  try {
    const parsed = JSON.parse(raw) as Partial<AgentSettings> & {
      provider?: unknown
      networkProxyEnabled?: boolean
    }
    const providerProfiles = normalizeProfiles(parsed)
    const activeProviderProfileId =
      resolveActiveProfile(
        providerProfiles,
        typeof parsed.activeProviderProfileId === 'string'
          ? parsed.activeProviderProfileId
          : undefined,
      )?.id || ''

    return syncLegacyFields({
      ...defaultSettings,
      ...parsed,
      providerProfiles,
      activeProviderProfileId,
      providerProxyEnabled:
        typeof parsed.providerProxyEnabled === 'boolean'
          ? parsed.providerProxyEnabled
          : typeof parsed.networkProxyEnabled === 'boolean'
            ? parsed.networkProxyEnabled
            : typeof parsed.networkProxy === 'string' && parsed.networkProxy.trim().length > 0,
      networkProxy: typeof parsed.networkProxy === 'string' ? parsed.networkProxy : '',
      agentArchitectureMode: normalizeAgentArchitectureMode(parsed.agentArchitectureMode),
      maxSteps: normalizeMaxSteps(parsed.maxSteps),
      executionMode: normalizeExecutionMode(parsed.executionMode),
      memoryMode: normalizeMemoryMode(parsed.memoryMode),
      contextCompressionThresholdTokens: normalizeContextCompressionThreshold(
        parsed.contextCompressionThresholdTokens,
      ),
      reasoningEffort: normalizeReasoningEffort(parsed.reasoningEffort),
      showDetailedExecutionDetails: normalizeDetailedExecutionSetting(
        parsed.showDetailedExecutionDetails,
      ),
      requireLongTaskPlanApproval:
        typeof parsed.requireLongTaskPlanApproval === 'boolean'
          ? parsed.requireLongTaskPlanApproval
          : defaultSettings.requireLongTaskPlanApproval,
      browser: normalizeBrowserSettings(parsed.browser),
      web: normalizeWebToolsSettings(parsed.web),
      mcpServers: normalizeMcpServers(parsed.mcpServers),
    })
  } catch {
    return defaultSettings
  }
}

function normalizeAgentArchitectureMode(value: unknown): AgentArchitectureMode {
  return value === 'orchestrated' ? 'orchestrated' : 'default-agent'
}

function normalizeExecutionMode(value: unknown): ExecutionMode {
  return value === 'long-task' ? 'long-task' : 'bounded'
}

function normalizeMemoryMode(value: unknown): MemoryMode {
  return value === 'summary' ? 'summary' : 'summary'
}

function normalizeReasoningEffort(value: unknown): ReasoningEffort {
  if (
    value === 'off' ||
    value === 'low' ||
    value === 'medium' ||
    value === 'high' ||
    value === 'max'
  ) {
    return value
  }
  return defaultSettings.reasoningEffort
}

function normalizeLocale(value: unknown) {
  const normalized = typeof value === 'string' ? value.trim() : ''
  if (!normalized) {
    return defaultSettings.locale
  }

  const lower = normalized.toLowerCase().replace('_', '-')
  if (lower === 'zh-cn' || lower === 'zh-hans') {
    return 'zh-CN'
  }
  if (lower === 'zh-tw' || lower === 'zh-hant') {
    return 'zh-TW'
  }
  if (lower === 'en-us') {
    return 'en-US'
  }
  if (lower === 'en-gb') {
    return 'en-GB'
  }
  return normalized
}

function normalizeDetailedExecutionSetting(value: unknown) {
  return value === true
}

function normalizeContextCompressionThreshold(value: unknown) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return defaultSettings.contextCompressionThresholdTokens
  }
  return Math.max(16_000, Math.min(2_000_000, Math.round(parsed)))
}

function normalizeMaxSteps(value: unknown) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return defaultSettings.maxSteps
  }
  return Math.max(1, Math.min(128, Math.round(value)))
}

function normalizeProvider(
  provider: unknown,
  fallback: AgentSettings['provider'],
): AgentSettings['provider'] {
  if (provider === 'openai' || provider === 'google' || provider === 'custom') {
    return provider
  }
  if (provider === 'openai-compatible') {
    return 'custom'
  }
  if (provider === 'anthropic') {
    return 'openai'
  }
  return fallback
}

function normalizeModels(value: unknown) {
  if (!Array.isArray(value)) {
    return []
  }

  const byId = new Map<string, ProviderProfile['models'][number]>()

  for (const entry of value) {
    const normalized =
      typeof entry === 'string'
        ? { id: entry, enabled: true }
        : entry && typeof entry === 'object' && typeof entry.id === 'string'
          ? {
              id: entry.id,
              enabled: entry.enabled !== false,
              contextWindowTokens:
                typeof entry.contextWindowTokens === 'number' &&
                Number.isFinite(entry.contextWindowTokens) &&
                entry.contextWindowTokens > 0
                  ? Math.round(entry.contextWindowTokens)
                  : undefined,
              maxOutputTokens:
                typeof entry.maxOutputTokens === 'number' &&
                Number.isFinite(entry.maxOutputTokens) &&
                entry.maxOutputTokens > 0
                  ? Math.round(entry.maxOutputTokens)
                  : undefined,
            }
          : null

    if (!normalized?.id?.trim()) {
      continue
    }

    const modelId = normalized.id.trim()
    const existing = byId.get(modelId)
    byId.set(modelId, {
      id: modelId,
      enabled: existing ? existing.enabled || normalized.enabled !== false : normalized.enabled !== false,
      contextWindowTokens: Math.max(
        existing?.contextWindowTokens || 0,
        normalized.contextWindowTokens || 0,
      ) || undefined,
      maxOutputTokens: Math.max(
        existing?.maxOutputTokens || 0,
        normalized.maxOutputTokens || 0,
      ) || undefined,
    })
  }

  return Array.from(byId.values()).sort((left, right) => left.id.localeCompare(right.id))
}

function normalizeProfiles(
  parsed: Partial<AgentSettings> & { provider?: unknown; providerProfiles?: unknown },
) {
  const profiles = Array.isArray(parsed.providerProfiles)
    ? parsed.providerProfiles
      .map((profile, index) => {
        if (!profile || typeof profile !== 'object') {
          return null
        }
        const provider = normalizeProvider(
          (profile as { provider?: unknown }).provider,
          index === 0 ? defaultSettings.provider : 'custom',
        )
        const baseUrl =
          typeof (profile as { baseUrl?: unknown }).baseUrl === 'string' &&
            (profile as { baseUrl?: string }).baseUrl?.trim()
            ? String((profile as { baseUrl?: string }).baseUrl)
            : baseUrlForProvider(provider)
        const models = normalizeModels((profile as { models?: unknown }).models)
        const defaultModel =
          typeof (profile as { defaultModel?: unknown }).defaultModel === 'string'
            ? (profile as { defaultModel?: string }).defaultModel || models[0]?.id || ''
            : models[0]?.id || ''
        return {
          id:
            typeof (profile as { id?: unknown }).id === 'string' &&
              (profile as { id?: string }).id?.trim()
              ? String((profile as { id?: string }).id)
              : createProfileId(`profile-${provider}`),
          name:
            typeof (profile as { name?: unknown }).name === 'string' &&
              (profile as { name?: string }).name?.trim()
              ? String((profile as { name?: string }).name)
              : provider === 'custom'
                ? 'Custom'
                : provider === 'google'
                  ? 'Google'
                  : 'OpenAI',
          provider,
          apiKey:
            typeof (profile as { apiKey?: unknown }).apiKey === 'string'
              ? String((profile as { apiKey?: string }).apiKey)
              : '',
          baseUrl,
          enabled: (profile as { enabled?: boolean }).enabled !== false,
          models,
          defaultModel,
        } satisfies ProviderProfile
      })
      .filter((profile): profile is ProviderProfile => Boolean(profile))
    : []

  if (profiles.length > 0) {
    return profiles
  }

  const legacyProvider = normalizeProvider(parsed.provider, defaultSettings.provider)
  const legacyBaseUrl =
    legacyProvider === 'openai' && parsed.baseUrl === 'https://api.anthropic.com'
      ? defaultSettings.baseUrl
      : parsed.baseUrl || baseUrlForProvider(legacyProvider)
  const legacyModel = typeof parsed.model === 'string' ? parsed.model : ''

  return [
    {
      id: 'profile-legacy',
      name: legacyProvider === 'custom' ? 'Custom' : legacyProvider === 'google' ? 'Google' : 'OpenAI',
      provider: legacyProvider,
      apiKey: typeof parsed.apiKey === 'string' ? parsed.apiKey : '',
      baseUrl: legacyBaseUrl,
      enabled: true,
      models: legacyModel ? [{ id: legacyModel, enabled: true }] : [],
      defaultModel: legacyModel,
    },
    ...defaultProfiles().filter(profile => profile.provider !== legacyProvider),
  ]
}

function firstEnabledModelId(profile: ProviderProfile) {
  return profile.models.find(model => model.enabled)?.id || ''
}

function resolvePreferredModelId(profile: ProviderProfile | null, preferredModelId?: string) {
  if (!profile) {
    return ''
  }

  if (
    preferredModelId &&
    profile.models.some(model => model.enabled && model.id === preferredModelId)
  ) {
    return preferredModelId
  }

  if (
    profile.defaultModel &&
    profile.models.some(model => model.enabled && model.id === profile.defaultModel)
  ) {
    return profile.defaultModel
  }

  return firstEnabledModelId(profile)
}

function resolveActiveProfile(
  profiles: ProviderProfile[],
  preferredProfileId?: string,
) {
  const preferred =
    typeof preferredProfileId === 'string'
      ? profiles.find(profile => profile.id === preferredProfileId && profile.enabled)
      : null

  if (preferred) {
    return preferred
  }

  return (
    profiles.find(profile => profile.enabled && firstEnabledModelId(profile)) ||
    profiles.find(profile => profile.enabled) ||
    profiles[0] ||
    null
  )
}

function syncLegacyFields(settings: AgentSettings): AgentSettings {
  const normalizedSettings = normalizeMutableSettings(settings)
  const activeProfile = resolveActiveProfile(
    normalizedSettings.providerProfiles,
    normalizedSettings.activeProviderProfileId,
  )
  const analysisProfile = resolveActiveProfile(
    normalizedSettings.providerProfiles,
    normalizedSettings.analysisProviderProfileId,
  )
  const titleProfile = resolveActiveProfile(
    normalizedSettings.providerProfiles,
    normalizedSettings.titleProviderProfileId,
  )

  if (!activeProfile) {
    return normalizedSettings
  }

  const resolvedAnalysisModel =
    normalizedSettings.analysisProviderProfileId &&
    normalizedSettings.analysisModel &&
    analysisProfile &&
    analysisProfile.id === normalizedSettings.analysisProviderProfileId
      ? resolvePreferredModelId(analysisProfile, normalizedSettings.analysisModel)
      : ''

  const shouldKeepAnalysisSelection =
    !!resolvedAnalysisModel &&
    !!analysisProfile &&
    analysisProfile.id === normalizedSettings.analysisProviderProfileId

  const resolvedTitleModel =
    normalizedSettings.titleProviderProfileId &&
    normalizedSettings.titleModel &&
    titleProfile &&
    titleProfile.id === normalizedSettings.titleProviderProfileId
      ? resolvePreferredModelId(titleProfile, normalizedSettings.titleModel)
      : ''

  const shouldKeepTitleSelection =
    !!resolvedTitleModel &&
    !!titleProfile &&
    titleProfile.id === normalizedSettings.titleProviderProfileId

  return {
    ...normalizedSettings,
    activeProviderProfileId: activeProfile.id,
    provider: activeProfile.provider,
    apiKey: activeProfile.apiKey,
    baseUrl: activeProfile.baseUrl,
    model: resolvePreferredModelId(activeProfile, normalizedSettings.model),
    analysisProviderProfileId: shouldKeepAnalysisSelection ? analysisProfile.id : '',
    analysisModel: shouldKeepAnalysisSelection ? resolvedAnalysisModel : '',
    titleProviderProfileId: shouldKeepTitleSelection ? titleProfile.id : '',
    titleModel: shouldKeepTitleSelection ? resolvedTitleModel : '',
  }
}

type ParsedSessionRecord = {
  session: Session
  messageCount: number
  messagesLoaded: boolean
}

function parseSessionMessages(
  rawMessages: unknown,
  sessionUpdatedAt: number,
): Session['messages'] {
  if (!Array.isArray(rawMessages)) {
    return []
  }

  return rawMessages.map(rawMessage => {
    const message =
      rawMessage && typeof rawMessage === 'object'
        ? (rawMessage as Partial<Session['messages'][number]>)
        : ({} as Partial<Session['messages'][number]>)
    const createdAt = message.createdAt || sessionUpdatedAt || Date.now()
    const baseVariant = normalizeMessageVariant(message, createdAt) || {
      content: message.content || '',
      parts: [],
      status: message.status || 'completed',
      createdAt,
      researchMode:
        message.researchMode === 'deep' || message.researchMode === 'auto'
          ? message.researchMode
          : undefined,
      attachments: [],
      reasoning: [],
      usage: undefined,
      capabilitySnapshot: normalizeCapabilityUsageSnapshot(message.capabilitySnapshot),
      activity: message.activity,
      events: message.events || [],
      steps: message.steps || [],
      phaseOutputs: normalizeMessagePhaseOutputs(message.phaseOutputs),
      error: message.error,
      errorInfo:
        message.errorInfo && typeof message.errorInfo === 'object'
          ? message.errorInfo
          : undefined,
      retryInfo: normalizeProviderRetryInfo(message.retryInfo),
      agentMode: normalizeAgentMode(message.agentMode),
      routeDecision: normalizeRouteDecision(message.routeDecision),
      modelInfo:
        message.modelInfo &&
          typeof message.modelInfo === 'object' &&
          typeof message.modelInfo.providerProfileId === 'string' &&
          typeof message.modelInfo.providerProfileName === 'string' &&
          (message.modelInfo.provider === 'openai' ||
            message.modelInfo.provider === 'google' ||
            message.modelInfo.provider === 'custom') &&
          typeof message.modelInfo.modelId === 'string' &&
          typeof message.modelInfo.label === 'string'
          ? {
            providerProfileId: message.modelInfo.providerProfileId,
            providerProfileName: message.modelInfo.providerProfileName,
            provider: message.modelInfo.provider,
            modelId: message.modelInfo.modelId,
            label: message.modelInfo.label,
          }
          : undefined,
      appendedInputs: [],
    }
    const normalizedVersions = Array.isArray(message.versions)
      ? message.versions
        .map(variant => normalizeMessageVariant(variant, createdAt))
        .filter((variant): variant is NonNullable<typeof variant> => Boolean(variant))
      : []
    const versions =
      normalizedVersions.length > 0 ? normalizedVersions : [baseVariant]
    const safeIndex =
      typeof message.activeVersionIndex === 'number' &&
        message.activeVersionIndex >= 0 &&
        message.activeVersionIndex < versions.length
        ? message.activeVersionIndex
        : versions.length - 1
    const activeVariant = versions[safeIndex] || baseVariant

    return {
      id: message.id || Math.random().toString(36).slice(2, 10),
      role: message.role || 'assistant',
      linkedMessageId:
        typeof message.linkedMessageId === 'string' ? message.linkedMessageId : undefined,
      content: activeVariant.content,
      parts: activeVariant.parts,
      status: activeVariant.status,
      createdAt: activeVariant.createdAt,
      researchMode: activeVariant.researchMode,
      attachments: activeVariant.attachments,
      reasoning: activeVariant.reasoning,
      phaseOutputs: activeVariant.phaseOutputs,
      usage: activeVariant.usage,
      capabilitySnapshot: activeVariant.capabilitySnapshot,
      activity: activeVariant.activity,
      events: activeVariant.events,
      steps: activeVariant.steps,
      error: activeVariant.error,
      errorInfo: activeVariant.errorInfo,
      retryInfo: activeVariant.retryInfo,
      agentMode: activeVariant.agentMode,
      routeDecision: activeVariant.routeDecision,
      appendedInputs: activeVariant.appendedInputs,
      modelInfo: activeVariant.modelInfo,
      versions,
      activeVersionIndex: safeIndex,
    }
  })
}

function parseSessions(raw: string | null): ParsedSessionRecord[] {
  if (!raw) {
    return []
  }

  try {
    const parsed = JSON.parse(raw) as Array<
      Partial<Session> &
      Pick<Session, 'id' | 'title'> & {
        messageCount?: number
        messagesLoaded?: boolean
      }
    >
    return parsed
      .map(session => {
        const updatedAt = session.updatedAt || Date.now()
        const messages = parseSessionMessages(session.messages, updatedAt)
        const messageCount =
          typeof session.messageCount === 'number' && Number.isFinite(session.messageCount)
            ? Math.max(0, Math.round(session.messageCount))
            : messages.length

        return {
          session: {
            id: session.id,
            title: session.title || '新会话',
            providerProfileId:
              typeof session.providerProfileId === 'string'
                ? session.providerProfileId
                : 'profile-legacy',
            provider: normalizeProvider(session.provider, defaultSettings.provider),
            model: session.model || defaultSettings.model,
            folderId: typeof session.folderId === 'string' ? session.folderId : undefined,
            workspacePath: session.workspacePath || '',
            workspaceRoot: session.workspaceRoot || '',
            workspaceMode: session.workspaceMode || 'explicit',
            contextCompression: normalizeSessionContextCompression(session.contextCompression),
            messages,
            toolEvents: session.toolEvents || [],
            taskTree: session.taskTree || [],
            updatedAt,
          },
          messageCount,
          messagesLoaded:
            session.messagesLoaded === true ||
            (Array.isArray(session.messages) && messageCount === messages.length),
        } satisfies ParsedSessionRecord
      })
      .filter(record => {
        if (record.messageCount > 0) {
          return true
        }
        return record.session.title.trim() !== '新会话'
      })
      .sort((left, right) => {
        const timestampDelta = getSessionSortTimestamp(right.session) - getSessionSortTimestamp(left.session)
        if (timestampDelta !== 0) {
          return timestampDelta
        }
        return right.session.updatedAt - left.session.updatedAt
      })
  } catch {
    return []
  }
}

function parseSessionFolders(raw: string | null): SessionFolder[] {
  if (!raw) {
    return []
  }

  try {
    const parsed = JSON.parse(raw) as Array<Partial<SessionFolder> & Pick<SessionFolder, 'id'>>
    return parsed
      .map(folder => ({
        id: folder.id,
        name:
          typeof folder.name === 'string' && folder.name.trim() ? folder.name.trim() : '未命名分组',
        expanded: folder.expanded !== false,
        createdAt:
          typeof folder.createdAt === 'number' && Number.isFinite(folder.createdAt)
            ? folder.createdAt
            : Date.now(),
      }))
      .sort((left, right) => left.createdAt - right.createdAt)
  } catch {
    return []
  }
}

function cloneValue<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function serializeSessions(sessions: Session[]) {
  return sessions.map(session => ({
    ...session,
    messages: session.messages.map(message => ({
      ...message,
      parts: (message.parts || []).map(part => {
        if (part.type === 'image') {
          return {
            ...part,
            dataUrl: undefined,
          }
        }
        return part
      }),
      attachments: (message.attachments || []).map(attachment => ({
        ...attachment,
        preview: undefined,
      })),
      appendedInputs: (message.appendedInputs || []).map(input => ({
        ...input,
        parts: (input.parts || []).map(part => {
          if (part.type === 'image') {
            return {
              ...part,
              dataUrl: undefined,
            }
          }
          return part
        }),
        attachments: (input.attachments || []).map(attachment => ({
          ...attachment,
          preview: undefined,
        })),
      })),
      versions: (message.versions || []).map(variant => ({
        ...variant,
        parts: (variant.parts || []).map(part => {
          if (part.type === 'image') {
            return {
              ...part,
              dataUrl: undefined,
            }
          }
          return part
        }),
        attachments: (variant.attachments || []).map(attachment => ({
          ...attachment,
          preview: undefined,
        })),
        appendedInputs: (variant.appendedInputs || []).map(input => ({
          ...input,
          parts: (input.parts || []).map(part => {
            if (part.type === 'image') {
              return {
                ...part,
                dataUrl: undefined,
              }
            }
            return part
          }),
          attachments: (input.attachments || []).map(attachment => ({
            ...attachment,
            preview: undefined,
          })),
        })),
      })),
    })),
  }))
}

type PersistedSessionRecord = ReturnType<typeof serializeSessions>[number]
type PersistedMessageSnapshot = {
  shellSignature: string
  versionSignatures: string[]
}
type PersistedSessionSnapshot = Map<string, PersistedMessageSnapshot>
type SessionLoadState = {
  loaded: boolean
  messageCount: number
}

let cachedSettings: AgentSettings = cloneValue(defaultSettings)
let cachedSessions: Session[] = []
let cachedSessionFolders: SessionFolder[] = []
let cachedProjectCapabilityOverrides: ProjectCapabilityOverrides = {}
let persistedSessionSnapshots = new Map<string, PersistedSessionSnapshot>()
let sessionLoadStates = new Map<string, SessionLoadState>()
let sessionPersistenceQueue = Promise.resolve()

function parsePersistedJson(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null
  }
  return JSON.stringify(value)
}

function hasRunningStatus(status?: string) {
  return status === 'pending' || status === 'streaming'
}

function sessionHasPendingPersistence(session: PersistedSessionRecord) {
  return session.messages.some(message => {
    const variants =
      Array.isArray(message.versions) && message.versions.length > 0
        ? message.versions
        : [
            {
              id: message.id,
              content: message.content || '',
              parts: message.parts || [],
              status: message.status || 'completed',
              createdAt: message.createdAt || session.updatedAt || Date.now(),
              attachments: message.attachments || [],
              reasoning: message.reasoning || [],
              usage: message.usage,
              capabilitySnapshot: message.capabilitySnapshot,
              activity: message.activity,
              events: message.events || [],
              steps: message.steps || [],
              error: message.error,
              errorInfo: message.errorInfo,
              retryInfo: message.retryInfo,
              agentMode: message.agentMode,
              routeDecision: message.routeDecision,
              appendedInputs: message.appendedInputs || [],
              modelInfo: message.modelInfo,
            },
          ]
    const activeIndex =
      typeof message.activeVersionIndex === 'number'
        ? Math.max(0, Math.min(message.activeVersionIndex, variants.length - 1))
        : variants.length - 1
    const activeVariant = variants[activeIndex]
    const activityStatus = activeVariant?.activity?.status
    return (
      hasRunningStatus(activeVariant?.status) ||
      activityStatus === 'queued' ||
      activityStatus === 'running' ||
      activityStatus === 'awaiting_approval' ||
      activityStatus === 'awaiting_user_input'
    )
  })
}

function persistedMessageVersions(message: PersistedSessionRecord['messages'][number]) {
  if (Array.isArray(message.versions) && message.versions.length > 0) {
    return message.versions
  }

  return [
    {
      id: message.id,
      content: message.content || '',
      parts: message.parts || [],
      status: message.status || 'completed',
      createdAt: message.createdAt || Date.now(),
      researchMode:
        message.researchMode === 'deep' || message.researchMode === 'auto'
          ? message.researchMode
          : undefined,
      attachments: message.attachments || [],
      reasoning: message.reasoning || [],
      phaseOutputs: message.phaseOutputs || [],
      usage: message.usage,
      capabilitySnapshot: message.capabilitySnapshot,
      activity: message.activity,
      events: message.events || [],
      steps: message.steps || [],
      error: message.error,
      errorInfo: message.errorInfo,
      retryInfo: message.retryInfo,
      agentMode: message.agentMode,
      routeDecision: message.routeDecision,
      appendedInputs: message.appendedInputs || [],
      modelInfo: message.modelInfo,
    },
  ]
}

function hashSignaturePayload(value: string) {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return `${value.length}:${(hash >>> 0).toString(36)}`
}

function messageShellSignature(
  message: PersistedSessionRecord['messages'][number],
  sortIndex: number,
) {
  return hashSignaturePayload(
    JSON.stringify({
      id: message.id,
      role: message.role,
      linkedMessageId: message.linkedMessageId || null,
      sortIndex,
      activeVersionIndex:
        typeof message.activeVersionIndex === 'number' ? message.activeVersionIndex : 0,
      createdAt: message.createdAt || 0,
    }),
  )
}

function messageVersionSignature(version: ChatMessageVariant) {
  return hashSignaturePayload(JSON.stringify(version))
}

function buildPersistedSessionSnapshot(session: PersistedSessionRecord): PersistedSessionSnapshot {
  return new Map(
    session.messages.map((message, sortIndex) => [
      message.id,
      {
        shellSignature: messageShellSignature(message, sortIndex),
        versionSignatures: persistedMessageVersions(message).map(version =>
          messageVersionSignature(version as ChatMessageVariant),
        ),
      },
    ]),
  )
}

async function syncPersistedSession(
  session: PersistedSessionRecord,
  previous?: PersistedSessionSnapshot,
  syncMessages = true,
): Promise<boolean> {
  await upsertPersistedSession(session as Session)
  if (!syncMessages) {
    return false
  }

  const previousMessages = previous || new Map<string, PersistedMessageSnapshot>()
  const nextMessages = new Map(session.messages.map(message => [message.id, message]))

  // Safety guard:
  // if in-memory payload is empty while we still have persisted snapshots,
  // treat it as a potential lazy-load/invalidation mismatch and avoid
  // destructive full-history deletion.
  if (nextMessages.size === 0 && previousMessages.size > 0) {
    return false
  }

  for (const previousMessageId of previousMessages.keys()) {
    if (!nextMessages.has(previousMessageId)) {
      await deletePersistedMessage(previousMessageId)
    }
  }

  for (const [sortIndex, message] of session.messages.entries()) {
    const previousMessage = previousMessages.get(message.id)
    if (
      !previousMessage ||
      previousMessage.shellSignature !== messageShellSignature(message, sortIndex)
    ) {
      await upsertPersistedMessage(session.id, message as Session['messages'][number], sortIndex)
    }

    const nextVersions = persistedMessageVersions(message)
    const previousVersionSignatures = previousMessage?.versionSignatures || []
    const maxVersionCount = Math.max(nextVersions.length, previousVersionSignatures.length)

    for (let versionIndex = 0; versionIndex < maxVersionCount; versionIndex += 1) {
      const nextVersion = nextVersions[versionIndex]
      const previousVersionSignature = previousVersionSignatures[versionIndex]

      if (!nextVersion && previousVersionSignature) {
        await deletePersistedMessageVersion(message.id, versionIndex)
        continue
      }

      if (
        nextVersion &&
        messageVersionSignature(nextVersion as ChatMessageVariant) !== previousVersionSignature
      ) {
        await upsertPersistedMessageVersion(
          message.id,
          nextVersion as ChatMessageVariant,
          versionIndex,
        )
      }
    }
  }

  return true
}

function shouldSyncSessionMessages(session: PersistedSessionRecord) {
  const state = sessionLoadStates.get(session.id)
  const messageLength = session.messages.length

  // Defensive guard: never treat an empty in-memory message array as authoritative
  // when we have not explicitly loaded this session's full history yet.
  if (messageLength === 0) {
    if (!state) {
      return false
    }
    if (!state.loaded || state.messageCount > 0) {
      return false
    }
  }

  if (!state) {
    return true
  }
  if (state.loaded) {
    return true
  }
  if (state.messageCount <= 0) {
    return true
  }
  return messageLength > 0
}

async function persistSessions(sessions: Session[]) {
  const serializedSessions = serializeSessions(sessions)
  const nextSessionIds = new Set(serializedSessions.map(session => session.id))

  for (const sessionId of Array.from(sessionLoadStates.keys())) {
    if (!nextSessionIds.has(sessionId)) {
      await deletePersistedSession(sessionId)
      sessionLoadStates.delete(sessionId)
      persistedSessionSnapshots.delete(sessionId)
    }
  }

  for (const session of serializedSessions) {
    const syncMessages = shouldSyncSessionMessages(session)
    if (syncMessages && sessionHasPendingPersistence(session)) {
      continue
    }

    const previous = syncMessages ? persistedSessionSnapshots.get(session.id) : undefined
    const messagesSynced = await syncPersistedSession(session, previous, syncMessages)
    if (syncMessages && messagesSynced) {
      persistedSessionSnapshots.set(session.id, buildPersistedSessionSnapshot(session))
      sessionLoadStates.set(session.id, {
        loaded: true,
        messageCount: session.messages.length,
      })
      continue
    }

    const previousState = sessionLoadStates.get(session.id)
    const preservedMessageCount = Math.max(
      previousState?.messageCount ?? 0,
      previous?.size ?? 0,
      session.messages.length,
    )
    sessionLoadStates.set(session.id, {
      loaded: false,
      messageCount: preservedMessageCount,
    })
  }
}

async function readPersistedState() {
  const aura = await ensureAuraHome()
  const persisted = await loadPersistedAppState()
  let settings = parseSettings(parsePersistedJson(persisted.settings))
  if (!settings.cwd.trim()) {
    settings = syncLegacyFields({
      ...settings,
      cwd: aura.workspaceDir,
    })
  }
  const supportedSkillIds = new Set(
    aura.skills.filter(skill => skill.supported !== false).map(skill => skill.id),
  )
  const supportedPluginIds = new Set(
    aura.plugins.filter(plugin => plugin.supported !== false).map(plugin => plugin.id),
  )
  const normalizedSettings = syncLegacyFields({
    ...settings,
    enabledSkillIds: settings.enabledSkillIds.filter(
      id => supportedSkillIds.has(id) && !builtinSkillIds.has(id),
    ),
    enabledPluginIds: settings.enabledPluginIds.filter(id => supportedPluginIds.has(id)),
  })
  if (JSON.stringify(normalizedSettings) !== JSON.stringify(settings)) {
    settings = normalizedSettings
    void savePersistedSettings(settings).catch(() => {
      // Keep startup resilient even if settings cleanup cannot be persisted.
    })
  } else {
    settings = normalizedSettings
  }
  const parsedSessionRecords = parseSessions(parsePersistedJson(persisted.sessions || []))
  const sessions = parsedSessionRecords.map(record => record.session)
  const sessionLoadStatesFromPersistence = new Map(
    parsedSessionRecords.map(record => [
      record.session.id,
      {
        loaded: record.messagesLoaded || record.messageCount <= 0,
        messageCount: record.messageCount,
      } satisfies SessionLoadState,
    ]),
  )
  const sessionFolders = parseSessionFolders(parsePersistedJson(persisted.sessionFolders || []))
  const validFolderIds = new Set(sessionFolders.map(folder => folder.id))
  const normalizedSessions = sortSessionsByRecentActivity(
    sessions.map(session => ({
      ...session,
      folderId: session.folderId && validFolderIds.has(session.folderId) ? session.folderId : undefined,
    })),
  )
  const overrides = parseProjectCapabilityOverrides(
    parsePersistedJson(persisted.projectCapabilityOverrides),
  )

  cachedSettings = cloneValue(settings)
  cachedSessions = cloneValue(normalizedSessions)
  cachedSessionFolders = cloneValue(sessionFolders)
  cachedProjectCapabilityOverrides = cloneValue(overrides)
  sessionLoadStates = new Map(
    normalizedSessions.map(session => {
      const state = sessionLoadStatesFromPersistence.get(session.id)
      return [
        session.id,
        state || {
          loaded: true,
          messageCount: session.messages.length,
        },
      ]
    }),
  )
  persistedSessionSnapshots = new Map(
    serializeSessions(
      normalizedSessions.filter(session => sessionLoadStates.get(session.id)?.loaded !== false),
    ).map(session => [session.id, buildPersistedSessionSnapshot(session)]),
  )

  return {
    aura,
    settings: cloneValue(settings),
    sessions: cloneValue(normalizedSessions),
    sessionFolders: cloneValue(sessionFolders),
    overrides: cloneValue(overrides),
  }
}

export function loadSettings(): AgentSettings {
  return cloneValue(cachedSettings)
}

export function loadSessions(): Session[] {
  return cloneValue(cachedSessions)
}

export function isSessionMessagesLoaded(sessionId: string) {
  const state = sessionLoadStates.get(sessionId)
  if (!state) {
    return true
  }
  if (!state.loaded) {
    return false
  }
  if (state.messageCount > 0) {
    const session = cachedSessions.find(entry => entry.id === sessionId)
    if (session && session.messages.length === 0) {
      return false
    }
  }
  return true
}

export async function loadSessionMessages(sessionId: string): Promise<Session['messages']> {
  const existingSession = cachedSessions.find(session => session.id === sessionId)
  if (!existingSession) {
    return []
  }

  const loadState = sessionLoadStates.get(sessionId)
  const shouldForceReload =
    loadState?.loaded === true &&
    loadState.messageCount > 0 &&
    existingSession.messages.length === 0
  if (loadState?.loaded && !shouldForceReload) {
    return cloneValue(existingSession.messages)
  }

  const persistedMessages = await loadPersistedSessionMessages(sessionId)
  const normalizedMessages = parseSessionMessages(persistedMessages, existingSession.updatedAt)
  const expectedMessageCount = loadState?.messageCount ?? 0
  if (expectedMessageCount > 0 && normalizedMessages.length === 0) {
    sessionLoadStates.set(sessionId, {
      loaded: false,
      messageCount: expectedMessageCount,
    })
    throw new Error('会话元信息显示存在历史消息，但数据库本次返回为空；已阻止空历史覆盖。')
  }
  const nextSession: Session = {
    ...existingSession,
    messages: normalizedMessages,
  }

  cachedSessions = cachedSessions.map(session =>
    session.id === sessionId ? nextSession : session,
  )
  sessionLoadStates.set(sessionId, {
    loaded: true,
    messageCount: normalizedMessages.length,
  })
  persistedSessionSnapshots.set(
    sessionId,
    buildPersistedSessionSnapshot(serializeSessions([nextSession])[0]),
  )

  return cloneValue(normalizedMessages)
}

export async function searchSessionIds(keyword: string): Promise<string[]> {
  const normalizedKeyword = keyword.trim()
  if (!normalizedKeyword) {
    return []
  }
  return searchPersistedSessionIds(normalizedKeyword)
}

export function loadSessionFolders(): SessionFolder[] {
  return cloneValue(cachedSessionFolders)
}

export function saveSettings(settings: AgentSettings) {
  const normalized = syncLegacyFields(settings)
  cachedSettings = cloneValue(normalized)
  void savePersistedSettings(normalized).catch(() => {
    // Keep the UI responsive even if SQLite persistence fails.
  })
}

export async function saveSettingsAndAwaitPersistence(settings: AgentSettings) {
  const normalized = syncLegacyFields(settings)
  cachedSettings = cloneValue(normalized)
  await savePersistedSettings(normalized)
}

export function saveSessions(sessions: Session[]) {
  const sortedSessions = sortSessionsByRecentActivity(sessions)
  for (const session of sortedSessions) {
    const previousState = sessionLoadStates.get(session.id)
    if (!previousState) {
      sessionLoadStates.set(session.id, {
        loaded: true,
        messageCount: session.messages.length,
      })
      continue
    }
    const shouldRemainUnloaded = previousState.messageCount > 0 && session.messages.length === 0
    sessionLoadStates.set(session.id, {
      loaded: shouldRemainUnloaded ? false : true,
      messageCount: shouldRemainUnloaded ? previousState.messageCount : session.messages.length,
    })
  }
  cachedSessions = cloneValue(sortedSessions)
  const nextSessions = cloneValue(sortedSessions)
  sessionPersistenceQueue = sessionPersistenceQueue
    .then(() => persistSessions(nextSessions))
    .catch(() => {
      // Keep the UI responsive even if SQLite persistence fails.
    })
}

export function saveSessionFolders(sessionFolders: SessionFolder[]) {
  const sortedFolders = [...sessionFolders].sort((left, right) => left.createdAt - right.createdAt)
  cachedSessionFolders = cloneValue(sortedFolders)
  void savePersistedSessionFolders(sortedFolders).catch(() => {
    // Keep the UI responsive even if SQLite persistence fails.
  })
}

export function loadProjectCapabilityOverrides(): ProjectCapabilityOverrides {
  return cloneValue(cachedProjectCapabilityOverrides)
}

export function saveProjectCapabilityOverrides(overrides: ProjectCapabilityOverrides) {
  cachedProjectCapabilityOverrides = cloneValue(overrides)
  void savePersistedProjectCapabilityOverrides(overrides).catch(() => {
    // Keep the UI responsive even if SQLite persistence fails.
  })
}

export async function hydrateProjectCapabilityOverridesFromAuraHome(): Promise<ProjectCapabilityOverrides> {
  const { overrides } = await readPersistedState()
  return overrides
}

export function getWorkspaceCapabilityOverrides(
  overrides: ProjectCapabilityOverrides,
  workspaceRoot: string,
): WorkspaceCapabilityOverrides {
  return overrides[workspaceRoot] || createEmptyWorkspaceCapabilityOverrides()
}

export function updateWorkspaceCapabilityOverride(
  overrides: ProjectCapabilityOverrides,
  workspaceRoot: string,
  kind: 'skills' | 'plugins' | 'mcp',
  id: string,
  mode: CapabilityOverrideMode,
): ProjectCapabilityOverrides {
  const current = getWorkspaceCapabilityOverrides(overrides, workspaceRoot)
  const nextKindEntries = {
    ...current[kind],
  }

  if (mode === 'inherit') {
    delete nextKindEntries[id]
  } else {
    nextKindEntries[id] = mode
  }

  const nextWorkspaceOverrides: WorkspaceCapabilityOverrides = {
    ...current,
    [kind]: nextKindEntries,
  }

  const hasAnyOverrides =
    Object.keys(nextWorkspaceOverrides.skills).length > 0 ||
    Object.keys(nextWorkspaceOverrides.plugins).length > 0 ||
    Object.keys(nextWorkspaceOverrides.mcp).length > 0

  if (!hasAnyOverrides) {
    const next = { ...overrides }
    delete next[workspaceRoot]
    return next
  }

  return {
    ...overrides,
    [workspaceRoot]: nextWorkspaceOverrides,
  }
}

export function resolveCapabilitiesForWorkspace(args: {
  workspaceRoot: string
  settings: AgentSettings
  aura: AuraHomeState
  overrides: ProjectCapabilityOverrides
}): {
  runtime: ResolvedAgentCapabilities
  usage: CapabilityUsageSnapshot
} {
  const { workspaceRoot, settings, aura, overrides } = args
  const projectOverrides = getWorkspaceCapabilityOverrides(overrides, workspaceRoot)
  const resolvedAt = Date.now()

  const skillMap = new Map(aura.skills.map(skill => [skill.id, skill]))
  const pluginMap = new Map(aura.plugins.map(plugin => [plugin.id, plugin]))

  const resolvedSkills = Array.from(
    new Set([
      ...builtinSkills.map(skill => skill.id),
      ...aura.skills.map(skill => skill.id),
      ...(settings.enabledSkillIds || []),
      ...Object.keys(projectOverrides.skills),
    ]),
  )
    .filter(skillId =>
      (builtinSkillIds.has(skillId) ||
        resolveCapabilityEnabled(
          settings.enabledSkillIds.includes(skillId),
          projectOverrides.skills[skillId],
        )) &&
      skillMap.get(skillId)?.supported !== false,
    )
    .map(skillId => {
      const skill = skillMap.get(skillId)
      return {
        id: skillId,
        name: skill?.name || skillId,
        promptPath: skill?.entryPath || skill?.path || undefined,
      }
    })

  const resolvedPlugins = Array.from(
    new Set([
      ...aura.plugins.map(plugin => plugin.id),
      ...(settings.enabledPluginIds || []),
      ...Object.keys(projectOverrides.plugins),
    ]),
  )
    .filter(pluginId =>
      resolveCapabilityEnabled(
        settings.enabledPluginIds.includes(pluginId),
        projectOverrides.plugins[pluginId],
      ) && pluginMap.get(pluginId)?.supported !== false,
    )
    .map(pluginId => {
      const plugin = pluginMap.get(pluginId)
      return {
        id: pluginId,
        name: plugin?.name || pluginId,
        entryPath: plugin?.entryPath || plugin?.path || undefined,
      }
    })

  const resolvedMcpServers = settings.mcpServers
    .filter(server =>
      resolveCapabilityEnabled(server.enabled, projectOverrides.mcp[server.id]) &&
      server.healthStatus === 'ok' &&
      Boolean(server.command.trim()),
    )
    .map(server => ({
      ...server,
      enabled: true,
    }))

  return {
    runtime: {
      workspaceRoot,
      resolvedAt,
      skills: resolvedSkills,
      plugins: resolvedPlugins,
      mcpServers: resolvedMcpServers,
    },
    usage: {
      workspaceRoot,
      resolvedAt,
      skills: resolvedSkills.map(skill => ({
        id: skill.id,
        name: skill.name,
      })),
      plugins: resolvedPlugins.map(plugin => ({
        id: plugin.id,
        name: plugin.name,
      })),
      mcpServers: resolvedMcpServers.map(server => ({
        id: server.id,
        name: server.name,
      })),
    },
  }
}

export async function hydrateStorageFromAuraHome(): Promise<{
  aura: AuraHomeState
  settings: AgentSettings
  sessions: Session[]
  sessionFolders: SessionFolder[]
}> {
  const { aura, settings, sessions, sessionFolders } = await readPersistedState()

  return {
    aura,
    settings,
    sessions,
    sessionFolders,
  }
}
