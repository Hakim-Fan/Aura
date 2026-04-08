import type {
  AgentSettings,
  CapabilityOverrideMode,
  CapabilityUsageSnapshot,
  ChatMessageVariant,
  ExecutionMode,
  MemoryMode,
  ProjectCapabilityOverrides,
  ResolvedAgentCapabilities,
  ProviderMode,
  ProviderProfile,
  ReasoningEffort,
  Session,
  WorkspaceCapabilityOverrides,
} from '../types'
import { ensureAuraHome, readAuraFile, writeAuraFile, type AuraHomeState } from './aura'

const SETTINGS_KEY = 'aura-settings-cache-v1'
const SESSIONS_KEY = 'aura-sessions-cache-v1'
const PROJECT_CAPABILITIES_KEY = 'aura-project-capability-overrides-v1'
const LEGACY_SETTINGS_KEY = 'desk-agent-settings-v2'
const LEGACY_SESSIONS_KEY = 'desk-agent-sessions-v2'
const SETTINGS_FILE_PATH = 'config/settings.json'
const SESSIONS_FILE_PATH = 'config/sessions.json'
const MCP_FILE_PATH = 'mcp/servers.json'
const PROJECT_CAPABILITIES_FILE_PATH = 'config/project-capabilities.json'

function createProfileId(prefix: string) {
  return `${prefix}-${Math.random().toString(36).slice(2, 8)}`
}

function readCachedValue(primaryKey: string, legacyKey: string) {
  const primary = localStorage.getItem(primaryKey)
  if (primary) {
    return primary
  }

  const legacy = localStorage.getItem(legacyKey)
  if (legacy) {
    localStorage.setItem(primaryKey, legacy)
    return legacy
  }

  return null
}

function readLocalStorageValue(key: string) {
  return localStorage.getItem(key)
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

export const defaultSettings: AgentSettings = {
  provider: 'openai',
  apiKey: '',
  baseUrl: baseUrlForProvider('openai'),
  model: '',
  activeProviderProfileId: 'profile-openai',
  providerProfiles: defaultProfiles(),
  cwd: '',
  maxSteps: 8,
  executionMode: 'bounded',
  memoryMode: 'summary',
  reasoningEffort: 'medium',
  enableMultiAgent: true,
  enableComputerUse: true,
  enableChromeAutomation: true,
  autoApproveShell: false,
  autoApproveFileWrite: false,
  autoApproveComputerUse: false,
  autoApproveChromeAutomation: false,
  enabledSkillIds: ['repair-planner', 'desktop-operator'],
  enabledPluginIds: ['workspace-inspector'],
  mcpServers: [],
  sendShortcut: 'meta-enter',
}

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

function normalizeMessageVariant(
  value: unknown,
  fallbackCreatedAt: number,
): ChatMessageVariant | null {
  if (!value || typeof value !== 'object') {
    return null
  }

  const variant = value as Partial<ChatMessageVariant>
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
    attachments: normalizeMessageAttachments(variant.attachments),
    reasoning: normalizeMessageReasoning(variant.reasoning),
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
            }
            if (typeof entry.id !== 'string' || !entry.id.trim()) {
              return null
            }

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

  return value
    .map((entry, index) => {
      if (!entry || typeof entry !== 'object') {
        return null
      }

      const server = entry as Partial<AgentSettings['mcpServers'][number]>
      const id =
        typeof server.id === 'string' && server.id.trim()
          ? server.id
          : `mcp-${Math.random().toString(36).slice(2, 10)}-${index}`
      const name =
        typeof server.name === 'string' && server.name.trim() ? server.name : 'new-mcp'

      return {
        id,
        name,
        description:
          typeof server.description === 'string'
            ? server.description
            : '',
        command:
          typeof server.command === 'string'
            ? server.command
            : '',
        args:
          typeof server.args === 'string'
            ? server.args
            : '',
        env:
          typeof server.env === 'string'
            ? server.env
            : '{}',
        cwd:
          typeof server.cwd === 'string'
            ? server.cwd
            : '',
        enabled: server.enabled !== false,
        isDefault: server.isDefault === true,
      } as AgentSettings['mcpServers'][number]
    })
    .filter((entry): entry is AgentSettings['mcpServers'][number] => Boolean(entry))
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
      maxSteps: normalizeMaxSteps(parsed.maxSteps),
      executionMode: normalizeExecutionMode(parsed.executionMode),
      memoryMode: normalizeMemoryMode(parsed.memoryMode),
      reasoningEffort: normalizeReasoningEffort(parsed.reasoningEffort),
      mcpServers: normalizeMcpServers(parsed.mcpServers),
    })
  } catch {
    return defaultSettings
  }
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
  return value
    .map(entry => {
      if (typeof entry === 'string') {
        return { id: entry, enabled: true }
      }
      if (entry && typeof entry === 'object' && typeof entry.id === 'string') {
        return {
          id: entry.id,
          enabled: entry.enabled !== false,
        }
      }
      return null
    })
    .filter((entry): entry is ProviderProfile['models'][number] => Boolean(entry))
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
  const activeProfile = resolveActiveProfile(
    settings.providerProfiles,
    settings.activeProviderProfileId,
  )

  if (!activeProfile) {
    return settings
  }

  return {
    ...settings,
    activeProviderProfileId: activeProfile.id,
    provider: activeProfile.provider,
    apiKey: activeProfile.apiKey,
    baseUrl: activeProfile.baseUrl,
    model: resolvePreferredModelId(activeProfile, settings.model),
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
            attachments: [],
            reasoning: [],
            usage: undefined,
            capabilitySnapshot: normalizeCapabilityUsageSnapshot(message.capabilitySnapshot),
            activity: message.activity,
            events: message.events || [],
            steps: message.steps || [],
            error: message.error,
            errorInfo:
              message.errorInfo && typeof message.errorInfo === 'object'
                ? message.errorInfo
                : undefined,
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
            attachments: activeVariant.attachments,
            reasoning: activeVariant.reasoning,
            usage: activeVariant.usage,
            capabilitySnapshot: activeVariant.capabilitySnapshot,
            activity: activeVariant.activity,
            events: activeVariant.events,
            steps: activeVariant.steps,
            error: activeVariant.error,
            errorInfo: activeVariant.errorInfo,
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
      .sort((a, b) => b.updatedAt - a.updatedAt)
  } catch {
    return []
  }
}

export function loadSettings(): AgentSettings {
  return parseSettings(readCachedValue(SETTINGS_KEY, LEGACY_SETTINGS_KEY))
}

export function loadSessions(): Session[] {
  return parseSessions(readCachedValue(SESSIONS_KEY, LEGACY_SESSIONS_KEY))
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

function writeSessionCache(serializedSessions: ReturnType<typeof serializeSessions>) {
  try {
    localStorage.setItem(SESSIONS_KEY, JSON.stringify(serializedSessions))
  } catch (error) {
    if (
      error instanceof DOMException &&
      (error.name === 'QuotaExceededError' || error.code === 22)
    ) {
      try {
        localStorage.removeItem(SESSIONS_KEY)
        localStorage.setItem(SESSIONS_KEY, JSON.stringify(serializedSessions))
      } catch {
        // Swallow storage quota failures to keep the UI responsive.
      }
      return
    }
    throw error
  }
}

async function writeSettingsToAuraHome(settings: AgentSettings) {
  const serialized = JSON.stringify(
    {
      ...syncLegacyFields(settings),
      mcpServers: [],
    },
    null,
    2,
  )
  await writeAuraFile(
    SETTINGS_FILE_PATH,
    serialized,
  )
}

async function writeSessionsToAuraHome(sessions: Session[]) {
  await writeAuraFile(
    SESSIONS_FILE_PATH,
    JSON.stringify(serializeSessions(sessions), null, 2),
  )
}

async function writeMcpServersToAuraHome(settings: AgentSettings) {
  await writeAuraFile(
    MCP_FILE_PATH,
    JSON.stringify(settings.mcpServers || [], null, 2),
  )
}

async function writeProjectCapabilitiesToAuraHome(overrides: ProjectCapabilityOverrides) {
  await writeAuraFile(
    PROJECT_CAPABILITIES_FILE_PATH,
    JSON.stringify(overrides, null, 2),
  )
}

export function saveSettings(settings: AgentSettings) {
  const normalized = syncLegacyFields(settings)
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(normalized))
  void writeSettingsToAuraHome(normalized).catch(() => {
    // Keep the UI responsive even if Aura file persistence fails.
  })
  void writeMcpServersToAuraHome(normalized).catch(() => {
    // Keep the UI responsive even if Aura file persistence fails.
  })
}

export function saveSessions(sessions: Session[]) {
  const serialized = serializeSessions(sessions)
  writeSessionCache(serialized)
  void writeSessionsToAuraHome(sessions).catch(() => {
    // Keep the UI responsive even if Aura file persistence fails.
  })
}

export function loadProjectCapabilityOverrides(): ProjectCapabilityOverrides {
  return parseProjectCapabilityOverrides(readLocalStorageValue(PROJECT_CAPABILITIES_KEY))
}

export function saveProjectCapabilityOverrides(overrides: ProjectCapabilityOverrides) {
  localStorage.setItem(PROJECT_CAPABILITIES_KEY, JSON.stringify(overrides))
  void writeProjectCapabilitiesToAuraHome(overrides).catch(() => {
    // Keep the UI responsive even if Aura file persistence fails.
  })
}

export async function hydrateProjectCapabilityOverridesFromAuraHome(): Promise<ProjectCapabilityOverrides> {
  const cachedRaw = readLocalStorageValue(PROJECT_CAPABILITIES_KEY)
  const diskRaw = await readAuraFile(PROJECT_CAPABILITIES_FILE_PATH)
  const overrides = parseProjectCapabilityOverrides(diskRaw || cachedRaw)
  const serialized = JSON.stringify(overrides, null, 2)

  localStorage.setItem(PROJECT_CAPABILITIES_KEY, JSON.stringify(overrides))
  if (diskRaw !== serialized) {
    await writeProjectCapabilitiesToAuraHome(overrides)
  }

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
      ...aura.skills.map(skill => skill.id),
      ...(settings.enabledSkillIds || []),
      ...Object.keys(projectOverrides.skills),
    ]),
  )
    .filter(skillId =>
      resolveCapabilityEnabled(
        settings.enabledSkillIds.includes(skillId),
        projectOverrides.skills[skillId],
      ),
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
}> {
  const aura = await ensureAuraHome()
  const cachedSettingsRaw = readCachedValue(SETTINGS_KEY, LEGACY_SETTINGS_KEY)
  const cachedSessionsRaw = readCachedValue(SESSIONS_KEY, LEGACY_SESSIONS_KEY)
  const diskSettingsRaw = await readAuraFile(SETTINGS_FILE_PATH)
  const diskSessionsRaw = await readAuraFile(SESSIONS_FILE_PATH)
  const diskMcpRaw = await readAuraFile(MCP_FILE_PATH)

  let settings = parseSettings(diskSettingsRaw || cachedSettingsRaw)
  if (diskMcpRaw) {
    try {
      const parsedMcp = JSON.parse(diskMcpRaw)
      if (Array.isArray(parsedMcp)) {
        settings = {
          ...settings,
          mcpServers: normalizeMcpServers(parsedMcp),
        }
      }
    } catch {
      // Ignore invalid MCP persistence and keep the last valid in-memory settings.
    }
  }
  if (!settings.cwd.trim()) {
    settings = syncLegacyFields({
      ...settings,
      cwd: aura.workspaceDir,
    })
  }

  const sessions = parseSessions(diskSessionsRaw || cachedSessionsRaw)
  const serializedSettings = JSON.stringify(
    {
      ...syncLegacyFields(settings),
      mcpServers: [],
    },
    null,
    2,
  )
  const serializedMcp = JSON.stringify(settings.mcpServers || [], null, 2)
  const serializedSessions = JSON.stringify(serializeSessions(sessions), null, 2)

  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings))
  writeSessionCache(serializeSessions(sessions))

  if (diskSettingsRaw !== serializedSettings) {
    await writeSettingsToAuraHome(settings)
  }
  if (diskMcpRaw !== serializedMcp) {
    await writeMcpServersToAuraHome(settings)
  }
  if (diskSessionsRaw !== serializedSessions) {
    await writeSessionsToAuraHome(sessions)
  }

  return {
    aura,
    settings,
    sessions,
  }
}
