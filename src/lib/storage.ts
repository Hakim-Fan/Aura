import type { AgentSettings, ProviderMode, ProviderProfile, Session } from '../types'

const SETTINGS_KEY = 'desk-agent-settings-v2'
const SESSIONS_KEY = 'desk-agent-sessions-v2'

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

export const defaultSettings: AgentSettings = {
  provider: 'openai',
  apiKey: '',
  baseUrl: baseUrlForProvider('openai'),
  model: '',
  activeProviderProfileId: 'profile-openai',
  providerProfiles: defaultProfiles(),
  cwd: '',
  maxSteps: 8,
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
    model: firstEnabledModelId(activeProfile),
  }
}

export function loadSettings(): AgentSettings {
  const raw = localStorage.getItem(SETTINGS_KEY)
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
    })
  } catch {
    return defaultSettings
  }
}

export function saveSettings(settings: AgentSettings) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(syncLegacyFields(settings)))
}

export function loadSessions(): Session[] {
  const raw = localStorage.getItem(SESSIONS_KEY)
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
        messages: (session.messages || []).map(message => ({
          id: message.id || Math.random().toString(36).slice(2, 10),
          role: message.role || 'assistant',
          content: message.content || '',
          parts: Array.isArray(message.parts)
            ? message.parts
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
            : [],
          status: message.status || 'completed',
          createdAt: message.createdAt || session.updatedAt || Date.now(),
          attachments: Array.isArray(message.attachments)
            ? message.attachments
                .map(attachment => {
                  if (!attachment || typeof attachment !== 'object') {
                    return null
                  }
                  const path =
                    typeof attachment.path === 'string' ? attachment.path : ''
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
                    preview:
                      typeof attachment.preview === 'string' ? attachment.preview : undefined,
                    mimeType:
                      typeof attachment.mimeType === 'string'
                        ? attachment.mimeType
                        : undefined,
                  }
                })
                .filter(
                  (attachment): attachment is NonNullable<typeof attachment> =>
                    Boolean(attachment),
                )
            : [],
          reasoning: Array.isArray(message.reasoning)
            ? message.reasoning
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
                  }
                })
                .filter((reasoning): reasoning is NonNullable<typeof reasoning> =>
                  Boolean(reasoning),
                )
            : [],
          usage:
            message.usage && typeof message.usage === 'object'
              ? {
                  inputTokens:
                    typeof message.usage.inputTokens === 'number'
                      ? message.usage.inputTokens
                      : undefined,
                  outputTokens:
                    typeof message.usage.outputTokens === 'number'
                      ? message.usage.outputTokens
                      : undefined,
                  contextWindow:
                    typeof message.usage.contextWindow === 'number'
                      ? message.usage.contextWindow
                      : undefined,
                }
              : undefined,
          activity: message.activity,
          events: message.events || [],
          steps: message.steps || [],
          error: message.error,
        })),
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

export function saveSessions(sessions: Session[]) {
  localStorage.setItem(SESSIONS_KEY, JSON.stringify(sessions))
}
