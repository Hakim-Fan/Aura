import type {
  AgentArchitectureMode,
  AgentSettings,
  BrowserBehaviorPreferences,
  BrowserRuntimeSettings,
  BrowserRuntimeStatusRecord,
  BrowserSearchPreferences,
  CapabilityOverrideMode,
  CapabilityUsageSnapshot,
  ChatMessageVariant,
  ChromeImportSource,
  CompletionState,
  ExecutionMode,
  ExecutionEvidenceSummary,
  ImportedChromeSite,
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

function defaultBrowserSearchPreferences(): BrowserSearchPreferences {
  return {
    engine: 'google',
    region: 'auto',
    language: 'auto',
    safeSearch: 'moderate',
  }
}

function defaultBrowserBehaviorPreferences(): BrowserBehaviorPreferences {
  return {
    acceptLanguage: 'auto',
    timezone: 'system',
    locale: 'system',
    colorScheme: 'system',
    userAgentMode: 'default',
  }
}

function defaultBrowserRuntimeSettings(): BrowserRuntimeSettings {
  return {
    enabled: true,
    source: 'system-chrome',
    allowChromeAutomationFallback: false,
    headlessByDefault: true,
    takeoverMode: 'ask',
    persistAuraProfile: true,
    search: defaultBrowserSearchPreferences(),
    behavior: defaultBrowserBehaviorPreferences(),
  }
}

export const defaultSettings: AgentSettings = {
  provider: 'openai',
  apiKey: '',
  baseUrl: baseUrlForProvider('openai'),
  model: '',
  analysisProviderProfileId: '',
  analysisModel: '',
  activeProviderProfileId: 'profile-openai',
  providerProfiles: defaultProfiles(),
  agentArchitectureMode: 'route-first',
  cwd: '',
  maxSteps: 8,
  executionMode: 'bounded',
  memoryMode: 'summary',
  reasoningEffort: 'medium',
  enableProviderFailureRecovery: true,
  providerFailureRecoveryMaxAttempts: 3,
  enableMultiAgent: true,
  enableComputerUse: true,
  enableChromeAutomation: true,
  autoApproveShell: false,
  autoApproveFileWrite: false,
  autoApproveComputerUse: false,
  autoApproveChromeAutomation: false,
  enabledSkillIds: [],
  enabledPluginIds: [],
  browser: defaultBrowserRuntimeSettings(),
  chromeImportSources: [],
  importedChromeSites: [],
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
  }
}

function normalizeAgentMode(value: unknown): AgentArchitectureMode | undefined {
  return value === 'route-first' || value === 'orchestrated' ? value : undefined
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
                    entry === 'command_exit_0' ||
                    entry === 'command_output' ||
                    entry === 'test_pass' ||
                    entry === 'test_fail' ||
                    entry === 'page_state' ||
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
    analysisProviderProfileId:
      typeof settings.analysisProviderProfileId === 'string'
        ? settings.analysisProviderProfileId
        : '',
    analysisModel:
      typeof settings.analysisModel === 'string' ? settings.analysisModel : '',
    mcpServers: normalizeMcpServers(settings.mcpServers),
  }
}

function normalizeBrowserSearchPreferences(value: unknown): BrowserSearchPreferences {
  const defaults = defaultBrowserSearchPreferences()
  if (!value || typeof value !== 'object') {
    return defaults
  }

  const entry = value as Partial<BrowserSearchPreferences>
  return {
    engine:
      entry.engine === 'google' ||
      entry.engine === 'bing' ||
      entry.engine === 'duckduckgo' ||
      entry.engine === 'baidu' ||
      entry.engine === 'custom'
        ? entry.engine
        : defaults.engine,
    customTemplate:
      typeof entry.customTemplate === 'string' && entry.customTemplate.trim()
        ? entry.customTemplate.trim()
        : undefined,
    region:
      typeof entry.region === 'string' && entry.region.trim()
        ? entry.region.trim()
        : defaults.region,
    language:
      typeof entry.language === 'string' && entry.language.trim()
        ? entry.language.trim()
        : defaults.language,
    safeSearch:
      entry.safeSearch === 'off' ||
      entry.safeSearch === 'strict' ||
      entry.safeSearch === 'moderate'
        ? entry.safeSearch
        : defaults.safeSearch,
  }
}

function normalizeBrowserBehaviorPreferences(value: unknown): BrowserBehaviorPreferences {
  const defaults = defaultBrowserBehaviorPreferences()
  if (!value || typeof value !== 'object') {
    return defaults
  }

  const entry = value as Partial<BrowserBehaviorPreferences>
  return {
    acceptLanguage:
      typeof entry.acceptLanguage === 'string' && entry.acceptLanguage.trim()
        ? entry.acceptLanguage.trim()
        : defaults.acceptLanguage,
    timezone:
      typeof entry.timezone === 'string' && entry.timezone.trim()
        ? entry.timezone.trim()
        : defaults.timezone,
    locale:
      typeof entry.locale === 'string' && entry.locale.trim()
        ? entry.locale.trim()
        : defaults.locale,
    colorScheme:
      entry.colorScheme === 'light' ||
      entry.colorScheme === 'dark' ||
      entry.colorScheme === 'system'
        ? entry.colorScheme
        : defaults.colorScheme,
    userAgentMode:
      entry.userAgentMode === 'desktop' || entry.userAgentMode === 'default'
        ? entry.userAgentMode
        : defaults.userAgentMode,
  }
}

function normalizeBrowserRuntimeSettings(value: unknown): BrowserRuntimeSettings {
  const defaults = defaultBrowserRuntimeSettings()
  if (!value || typeof value !== 'object') {
    return defaults
  }

  const entry = value as Partial<BrowserRuntimeSettings>
  return {
    enabled: entry.enabled !== false,
    source:
      entry.source === 'managed-chrome' ||
      entry.source === 'custom-executable' ||
      entry.source === 'system-chrome'
        ? entry.source
        : defaults.source,
    executablePath:
      typeof entry.executablePath === 'string' && entry.executablePath.trim()
        ? entry.executablePath.trim()
        : undefined,
    managedExecutablePath:
      typeof entry.managedExecutablePath === 'string' && entry.managedExecutablePath.trim()
        ? entry.managedExecutablePath.trim()
        : undefined,
    allowChromeAutomationFallback: entry.allowChromeAutomationFallback === true,
    headlessByDefault: entry.headlessByDefault !== false,
    takeoverMode:
      entry.takeoverMode === 'auto-visible-on-blocker' ? entry.takeoverMode : defaults.takeoverMode,
    persistAuraProfile: entry.persistAuraProfile !== false,
    auraProfilePath:
      typeof entry.auraProfilePath === 'string' && entry.auraProfilePath.trim()
        ? entry.auraProfilePath.trim()
        : undefined,
    search: normalizeBrowserSearchPreferences(entry.search),
    behavior: normalizeBrowserBehaviorPreferences(entry.behavior),
  }
}

function normalizeChromeImportSources(value: unknown): ChromeImportSource[] {
  if (!Array.isArray(value)) {
    return []
  }

  return value
    .map((entry, index) => {
      if (!entry || typeof entry !== 'object') {
        return null
      }

      const source = entry as Partial<ChromeImportSource>
      if (
        typeof source.profileName !== 'string' ||
        !source.profileName.trim() ||
        typeof source.profilePath !== 'string' ||
        !source.profilePath.trim()
      ) {
        return null
      }

      return {
        id:
          typeof source.id === 'string' && source.id.trim()
            ? source.id
            : `chrome-import-${index}-${Math.random().toString(36).slice(2, 8)}`,
        profileName: source.profileName.trim(),
        profilePath: source.profilePath.trim(),
        isDefault: source.isDefault === true,
      } satisfies ChromeImportSource
    })
    .filter((entry): entry is ChromeImportSource => Boolean(entry))
}

function normalizeImportedChromeSites(value: unknown): ImportedChromeSite[] {
  if (!Array.isArray(value)) {
    return []
  }

  return value
    .map((entry, index) => {
      if (!entry || typeof entry !== 'object') {
        return null
      }

      const site = entry as Partial<ImportedChromeSite>
      if (
        typeof site.domain !== 'string' ||
        !site.domain.trim() ||
        typeof site.sourceProfileId !== 'string' ||
        !site.sourceProfileId.trim()
      ) {
        return null
      }

      const normalized: ImportedChromeSite = {
        id:
          typeof site.id === 'string' && site.id.trim()
            ? site.id
            : `imported-site-${index}-${Math.random().toString(36).slice(2, 8)}`,
        domain: site.domain.trim(),
        sourceProfileId: site.sourceProfileId.trim(),
        importedAt:
          typeof site.importedAt === 'number' && Number.isFinite(site.importedAt)
            ? site.importedAt
            : Date.now(),
        cookieCount:
          typeof site.cookieCount === 'number' && Number.isFinite(site.cookieCount)
            ? Math.max(0, Math.round(site.cookieCount))
            : 0,
      }

      if (typeof site.lastRefreshedAt === 'number' && Number.isFinite(site.lastRefreshedAt)) {
        normalized.lastRefreshedAt = site.lastRefreshedAt
      }
      if (typeof site.notes === 'string' && site.notes.trim()) {
        normalized.notes = site.notes.trim()
      }

      return normalized
    })
    .filter((entry): entry is ImportedChromeSite => Boolean(entry))
}

function normalizeBrowserRuntimeStatusRecord(
  value: unknown,
): BrowserRuntimeStatusRecord | undefined {
  if (!value || typeof value !== 'object') {
    return undefined
  }

  const status = value as Partial<BrowserRuntimeStatusRecord>
  return {
    systemChromeDetected: status.systemChromeDetected === true,
    systemChromePath:
      typeof status.systemChromePath === 'string' && status.systemChromePath.trim()
        ? status.systemChromePath.trim()
        : undefined,
    managedChromeInstalled: status.managedChromeInstalled === true,
    managedChromePath:
      typeof status.managedChromePath === 'string' && status.managedChromePath.trim()
        ? status.managedChromePath.trim()
        : undefined,
    managedChromeSizeBytes:
      typeof status.managedChromeSizeBytes === 'number' && Number.isFinite(status.managedChromeSizeBytes)
        ? status.managedChromeSizeBytes
        : undefined,
    customExecutablePath:
      typeof status.customExecutablePath === 'string' && status.customExecutablePath.trim()
        ? status.customExecutablePath.trim()
        : undefined,
    customExecutableValid:
      typeof status.customExecutableValid === 'boolean'
        ? status.customExecutableValid
        : undefined,
    lastCheckedAt:
      typeof status.lastCheckedAt === 'number' && Number.isFinite(status.lastCheckedAt)
        ? status.lastCheckedAt
        : Date.now(),
  }
}

function parseSettings(raw: string | null): AgentSettings {
  if (!raw) {
    return defaultSettings
  }

  try {
    const parsed = JSON.parse(raw) as Partial<AgentSettings> & { provider?: unknown }
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
      agentArchitectureMode: normalizeAgentArchitectureMode(parsed.agentArchitectureMode),
      maxSteps: normalizeMaxSteps(parsed.maxSteps),
      executionMode: normalizeExecutionMode(parsed.executionMode),
      memoryMode: normalizeMemoryMode(parsed.memoryMode),
      reasoningEffort: normalizeReasoningEffort(parsed.reasoningEffort),
      enableProviderFailureRecovery: parsed.enableProviderFailureRecovery !== false,
      providerFailureRecoveryMaxAttempts: normalizeProviderFailureRecoveryMaxAttempts(
        parsed.providerFailureRecoveryMaxAttempts,
      ),
      browser: normalizeBrowserRuntimeSettings(parsed.browser),
      chromeImportSources: normalizeChromeImportSources(parsed.chromeImportSources),
      importedChromeSites: normalizeImportedChromeSites(parsed.importedChromeSites),
      browserRuntimeStatus: normalizeBrowserRuntimeStatusRecord(parsed.browserRuntimeStatus),
      mcpServers: normalizeMcpServers(parsed.mcpServers),
    })
  } catch {
    return defaultSettings
  }
}

function normalizeAgentArchitectureMode(value: unknown): AgentArchitectureMode {
  return value === 'orchestrated' ? 'orchestrated' : 'route-first'
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

function normalizeMaxSteps(value: unknown) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return defaultSettings.maxSteps
  }
  return Math.max(1, Math.min(128, Math.round(value)))
}

function normalizeProviderFailureRecoveryMaxAttempts(value: unknown) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return defaultSettings.providerFailureRecoveryMaxAttempts
  }
  return Math.max(1, Math.min(5, Math.round(value)))
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

  if (preferred && firstEnabledModelId(preferred)) {
    return preferred
  }

  return (
    profiles.find(profile => profile.enabled && firstEnabledModelId(profile)) ||
    preferred ||
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

  return {
    ...normalizedSettings,
    activeProviderProfileId: activeProfile.id,
    provider: activeProfile.provider,
    apiKey: activeProfile.apiKey,
    baseUrl: activeProfile.baseUrl,
    model: resolvePreferredModelId(activeProfile, normalizedSettings.model),
    analysisProviderProfileId: shouldKeepAnalysisSelection ? analysisProfile.id : '',
    analysisModel: shouldKeepAnalysisSelection ? resolvedAnalysisModel : '',
  }
}

function parseSessions(raw: string | null): Session[] {
  if (!raw) {
    return []
  }

  try {
    const parsed = JSON.parse(raw) as Array<Partial<Session> & Pick<Session, 'id' | 'title'>>
    return parsed
      .map(session => ({
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
        messages: (session.messages || []).map(message => {
          const createdAt = message.createdAt || session.updatedAt || Date.now()
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
        }),
        toolEvents: session.toolEvents || [],
        taskTree: session.taskTree || [],
        updatedAt: session.updatedAt || Date.now(),
      }))
      .filter(session => {
        if (session.messages.length > 0) {
          return true
        }
        return session.title.trim() !== '新会话'
      })
      .sort((left, right) => {
        const timestampDelta = getSessionSortTimestamp(right) - getSessionSortTimestamp(left)
        if (timestampDelta !== 0) {
          return timestampDelta
        }
        return right.updatedAt - left.updatedAt
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

let cachedSettings: AgentSettings = cloneValue(defaultSettings)
let cachedSessions: Session[] = []
let cachedSessionFolders: SessionFolder[] = []
let cachedProjectCapabilityOverrides: ProjectCapabilityOverrides = {}
let persistedSessionSnapshots = new Map<string, PersistedSessionRecord>()
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
      activityStatus === 'awaiting_approval'
    )
  })
}

function persistedMessageVersions(message: PersistedSessionRecord['messages'][number]) {
  if (Array.isArray(message.versions) && message.versions.length > 0) {
    return message.versions
  }

  return [
    {
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

function messageShellSignature(
  message: PersistedSessionRecord['messages'][number],
  sortIndex: number,
) {
  return JSON.stringify({
    id: message.id,
    role: message.role,
    linkedMessageId: message.linkedMessageId || null,
    sortIndex,
    activeVersionIndex:
      typeof message.activeVersionIndex === 'number' ? message.activeVersionIndex : 0,
    createdAt: message.createdAt || 0,
  })
}

async function syncPersistedSession(
  session: PersistedSessionRecord,
  previous?: PersistedSessionRecord,
) {
  await upsertPersistedSession(session as Session)

  const previousMessages = new Map((previous?.messages || []).map(message => [message.id, message]))
  const nextMessages = new Map(session.messages.map(message => [message.id, message]))

  for (const previousMessageId of previousMessages.keys()) {
    if (!nextMessages.has(previousMessageId)) {
      await deletePersistedMessage(previousMessageId)
    }
  }

  for (const [sortIndex, message] of session.messages.entries()) {
    const previousMessage = previousMessages.get(message.id)
    if (!previousMessage || messageShellSignature(previousMessage, sortIndex) !== messageShellSignature(message, sortIndex)) {
      await upsertPersistedMessage(session.id, message as Session['messages'][number], sortIndex)
    }

    const nextVersions = persistedMessageVersions(message)
    const previousVersions = previousMessage ? persistedMessageVersions(previousMessage) : []
    const maxVersionCount = Math.max(nextVersions.length, previousVersions.length)

    for (let versionIndex = 0; versionIndex < maxVersionCount; versionIndex += 1) {
      const nextVersion = nextVersions[versionIndex]
      const previousVersion = previousVersions[versionIndex]

      if (!nextVersion && previousVersion) {
        await deletePersistedMessageVersion(message.id, versionIndex)
        continue
      }

      if (
        nextVersion &&
        (!previousVersion || JSON.stringify(nextVersion) !== JSON.stringify(previousVersion))
      ) {
        await upsertPersistedMessageVersion(
          message.id,
          nextVersion as ChatMessageVariant,
          versionIndex,
        )
      }
    }
  }
}

async function persistSessions(sessions: Session[]) {
  const serializedSessions = serializeSessions(sessions)
  const nextSessionIds = new Set(serializedSessions.map(session => session.id))

  for (const sessionId of Array.from(persistedSessionSnapshots.keys())) {
    if (!nextSessionIds.has(sessionId)) {
      await deletePersistedSession(sessionId)
      persistedSessionSnapshots.delete(sessionId)
    }
  }

  for (const session of serializedSessions) {
    if (sessionHasPendingPersistence(session)) {
      continue
    }

    const previous = persistedSessionSnapshots.get(session.id)
    await syncPersistedSession(session, previous)
    persistedSessionSnapshots.set(session.id, cloneValue(session))
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
  const sessions = parseSessions(parsePersistedJson(persisted.sessions || []))
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
  persistedSessionSnapshots = new Map(
    serializeSessions(normalizedSessions).map(session => [session.id, cloneValue(session)]),
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
