import { useEffect, useMemo, useState } from 'react'
import { listen } from '@tauri-apps/api/event'
import { ask, open } from '@tauri-apps/plugin-dialog'
import { ChevronDown, ChevronUp, FolderOpen, RefreshCw, Search, Trash2 } from 'lucide-react'
import { builtinPlugins, builtinSkills } from './catalog'
import { detectLightpandaRuntime, resolveLightpandaExecutablePath } from './lib/browser'
import {
  inspectMcpServer,
  type McpInspectResult,
  validateMcpServerInput,
} from './lib/mcp'
import {
  fetchProviderModels,
  testProviderConnection,
  testProxyConnectivity,
} from './lib/provider'
import { ensureAuraHome, deleteAuraAsset, resetAuraHome, type AuraAsset, type AuraHomeState } from './lib/aura'
import {
  hydrateStorageFromAuraHome,
  loadSettings,
  saveSettingsAndAwaitPersistence,
} from './lib/storage'
import { openPathInDefaultApp, readTextFile } from './lib/workspace'
import { ConfirmModal } from './components/ConfirmModal'
import {
  broadcastSettingsUpdated,
  closeCurrentWindow,
  openLogViewerWindow,
  openMcpEditorWindow,
  openWorkspaceFolder,
} from './lib/windows'
import type {
  AgentSettings,
  LightpandaRuntimeStatusRecord,
  ProviderMode,
  ProviderProfile,
} from './types'
import { ProvidersView } from './views/ProvidersView'
import { SettingsView, type SettingsTab } from './views/SettingsView'

const PROVIDER_BASE_URLS: Record<ProviderMode, string> = {
  openai: 'https://api.openai.com/v1',
  google: 'https://generativelanguage.googleapis.com/v1beta',
  custom: 'https://api.openai.com/v1',
}

const STEP_PRESETS = [8, 16, 32, 64] as const
const CONTEXT_COMPRESSION_PRESETS = [128_000, 256_000, 512_000, 1_000_000] as const
const builtinSkillIdSet = new Set(builtinSkills.map(item => item.id))

function cloneSettings(settings: AgentSettings): AgentSettings {
  return JSON.parse(JSON.stringify(settings)) as AgentSettings
}

function mergeAuraAssets(items: AuraAsset[], fallback: typeof builtinSkills | typeof builtinPlugins) {
  const fallbackMap = new Map(fallback.map(item => [item.id, item]))
  return items.map(item => ({
    ...item,
    name: fallbackMap.get(item.id)?.name || item.name,
    description: fallbackMap.get(item.id)?.description || item.description,
  }))
}

function createReadonlyBuiltinAssets(
  items: typeof builtinSkills | typeof builtinPlugins,
): AuraAsset[] {
  return items.map(item => ({
    ...item,
    path: '',
    entryPath: '',
    supported: true,
    supportMessage: '',
    readonly: true,
  }))
}

function normalizePathList(paths: string[] = []) {
  const seen = new Set<string>()
  return paths
    .map(path => path.trim())
    .filter(Boolean)
    .filter(path => {
      if (seen.has(path)) {
        return false
      }
      seen.add(path)
      return true
    })
}

function createProviderProfile(provider: ProviderMode = 'custom'): ProviderProfile {
  return {
    id: `profile-${provider}-${Math.random().toString(36).slice(2, 8)}`,
    name: provider === 'custom' ? 'New Provider' : provider === 'google' ? 'Google' : 'OpenAI',
    provider,
    apiKey: '',
    baseUrl: PROVIDER_BASE_URLS[provider],
    enabled: true,
    models: [],
    defaultModel: '',
  }
}

function formatModelLabel(modelId: string) {
  return modelId.split('/').filter(Boolean).at(-1) || modelId
}

function normalizeManualModelId(profile: ProviderProfile, value: string) {
  const modelId = value.trim()
  return profile.provider === 'google' ? modelId.replace(/^models\//, '').trim() : modelId
}

function encodeModelRouteValue(profileId: string, modelId: string) {
  return JSON.stringify([profileId, modelId])
}

function decodeModelRouteValue(value: string) {
  if (!value) {
    return null
  }

  try {
    const parsed = JSON.parse(value) as unknown
    if (
      Array.isArray(parsed) &&
      typeof parsed[0] === 'string' &&
      typeof parsed[1] === 'string'
    ) {
      return {
        profileId: parsed[0],
        modelId: parsed[1],
      }
    }
  } catch {
    return null
  }

  return null
}

function formatModelRouteLabel(profile: ProviderProfile, modelId: string) {
  const providerLabel = profile.name.trim() || profile.provider
  return `${providerLabel}/${modelId}`
}

function formatCaughtMessage(caught: unknown, fallback: string) {
  if (caught instanceof Error && caught.message.trim()) {
    return caught.message
  }
  if (typeof caught === 'string' && caught.trim()) {
    return caught
  }
  return fallback
}

type ProviderStatusState = {
  tone: 'success' | 'error'
  message: string
}

function formatTimestamp(value?: number) {
  if (!value) {
    return '尚未检测'
  }
  return new Date(value).toLocaleString()
}

function formatTokenCount(value?: number) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return ''
  }
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`
  }
  if (value >= 1_000) {
    return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}K`
  }
  return `${Math.round(value)}`
}

function isPathInsideDirectory(candidate?: string, directory?: string) {
  const normalizedCandidate = typeof candidate === 'string' ? candidate.trim() : ''
  const normalizedDirectory = typeof directory === 'string' ? directory.trim() : ''
  if (!normalizedCandidate || !normalizedDirectory) {
    return false
  }
  return (
    normalizedCandidate === normalizedDirectory ||
    normalizedCandidate.startsWith(`${normalizedDirectory}/`) ||
    normalizedCandidate.startsWith(`${normalizedDirectory}\\`)
  )
}

function formatMiddleEllipsis(value?: string, maxLength = 44) {
  const normalizedValue = typeof value === 'string' ? value.trim() : ''
  if (!normalizedValue || normalizedValue.length <= maxLength) {
    return normalizedValue
  }
  if (maxLength <= 5) {
    return `${normalizedValue.slice(0, Math.max(1, maxLength - 1))}…`
  }

  const tailLength = Math.max(10, Math.floor((maxLength - 1) * 0.38))
  const headLength = Math.max(8, maxLength - tailLength - 1)
  return `${normalizedValue.slice(0, headLength)}…${normalizedValue.slice(-tailLength)}`
}

type Props = {
  initialTab: SettingsTab
}

export function SettingsWindowApp({ initialTab }: Props) {
  const [savedSettings, setSavedSettings] = useState<AgentSettings>(() => loadSettings())
  const [draftSettings, setDraftSettings] = useState<AgentSettings>(() =>
    cloneSettings(loadSettings()),
  )
  const [activeTab, setActiveTab] = useState<SettingsTab>(initialTab)
  const [selectedProviderProfileId, setSelectedProviderProfileId] = useState(
    loadSettings().activeProviderProfileId,
  )
  const [saveState, setSaveState] = useState<'idle' | 'saved'>('idle')
  const [generalStatus, setGeneralStatus] = useState<ProviderStatusState | null>(null)
  const [providerStatus, setProviderStatus] = useState<ProviderStatusState | null>(null)
  const [browserStatus, setBrowserStatus] = useState<ProviderStatusState | null>(null)
  const [proxyStatus, setProxyStatus] = useState<ProviderStatusState | null>(null)
  const [lightpandaStatus, setLightpandaStatus] = useState<LightpandaRuntimeStatusRecord | null>(
    null,
  )
  const [isTestingProvider, setIsTestingProvider] = useState(false)
  const [isTestingProxy, setIsTestingProxy] = useState(false)
  const [isFetchingModels, setIsFetchingModels] = useState(false)
  const [isRefreshingLightpandaStatus, setIsRefreshingLightpandaStatus] = useState(false)
  const [isAwaitingLightpandaSelection, setIsAwaitingLightpandaSelection] = useState(false)
  const [availableSkills, setAvailableSkills] = useState<AuraAsset[]>(() =>
    createReadonlyBuiltinAssets(builtinSkills),
  )
  const [availablePlugins, setAvailablePlugins] = useState<AuraAsset[]>(() =>
    createReadonlyBuiltinAssets(builtinPlugins),
  )
  const [auraHome, setAuraHome] = useState<AuraHomeState | null>(null)
  const [assetSearch, setAssetSearch] = useState({
    skills: '',
    plugins: '',
  })
  const [expandedAssetIds, setExpandedAssetIds] = useState<Set<string>>(new Set())
  const [assetPreviewCache, setAssetPreviewCache] = useState<Record<string, string>>({})
  const [loadingPreviewPath, setLoadingPreviewPath] = useState('')
  const [refreshingAssets, setRefreshingAssets] = useState<'skills' | 'plugins' | ''>('')
  const [isRefreshingMcp, setIsRefreshingMcp] = useState(false)
  const [testingMcpServerId, setTestingMcpServerId] = useState('')
  const [mcpInspectResults, setMcpInspectResults] = useState<
    Record<
      string,
      {
        tone: 'success' | 'error'
        message: string
        tools: McpInspectResult['tools']
      }
    >
  >({})
  const [assetToDelete, setAssetToDelete] = useState<{ id: string; name: string; kind: 'skills' | 'plugins'; path: string } | null>(null)
  const [mcpToDelete, setMcpToDelete] = useState<{ id: string; name: string } | null>(null)
  const [isResetting, setIsResetting] = useState(false)

  const isDirty = useMemo(
    () => JSON.stringify(savedSettings) !== JSON.stringify(draftSettings),
    [draftSettings, savedSettings],
  )

  const selectedProfile =
    draftSettings.providerProfiles.find(profile => profile.id === selectedProviderProfileId) ||
    draftSettings.providerProfiles[0] ||
    null

  const analysisCandidateProfiles = useMemo(
    () =>
      draftSettings.providerProfiles.filter(
        profile => profile.enabled && profile.models.some(model => model.enabled),
      ),
    [draftSettings.providerProfiles],
  )

  const selectedAnalysisProfile =
    analysisCandidateProfiles.find(
      profile => profile.id === draftSettings.analysisProviderProfileId,
    ) || null

  const analysisUsesDedicatedModel =
    !!draftSettings.analysisProviderProfileId && !!draftSettings.analysisModel

  const analysisModelOptions = selectedAnalysisProfile
    ? selectedAnalysisProfile.models.filter(model => model.enabled)
    : []

  const modelRouteOptions = useMemo(
    () =>
      draftSettings.providerProfiles
        .filter(profile => profile.enabled)
        .flatMap(profile =>
          profile.models
            .filter(model => model.enabled)
            .map(model => ({
              value: encodeModelRouteValue(profile.id, model.id),
              label: formatModelRouteLabel(profile, model.id),
            })),
        ),
    [draftSettings.providerProfiles],
  )

  const titleModelRouteStoredValue =
    draftSettings.titleProviderProfileId && draftSettings.titleModel
      ? encodeModelRouteValue(draftSettings.titleProviderProfileId, draftSettings.titleModel)
      : ''
  const titleModelRouteValue = modelRouteOptions.some(
    option => option.value === titleModelRouteStoredValue,
  )
    ? titleModelRouteStoredValue
    : ''

  const browserValidationError = useMemo(() => {
    if (draftSettings.browser.lightpanda.enabled && !lightpandaStatus?.valid) {
      return lightpandaStatus?.error || 'Lightpanda 已启用，但当前不可用。'
    }

    return ''
  }, [draftSettings.browser.lightpanda.enabled, lightpandaStatus])

  useEffect(() => {
    let unlistenOpenTab: (() => void) | undefined
    let unlistenSettingsUpdated: (() => void) | undefined
    void (async () => {
      try {
        const hydrated = await hydrateStorageFromAuraHome()
        setAuraHome(hydrated.aura)
        setSavedSettings(hydrated.settings)
        setDraftSettings(cloneSettings(hydrated.settings))
        setSelectedProviderProfileId(hydrated.settings.activeProviderProfileId)
        await refreshLightpandaStatus(hydrated.settings, { useAsBaseline: true, silent: true }).catch(() => {
          // Keep startup resilient even if Lightpanda detection is unavailable.
        })
      } catch {
        // Fall back to cached settings if Aura initialization is unavailable.
      }

      await refreshAuraAssets().catch(() => {
        setAvailableSkills(createReadonlyBuiltinAssets(builtinSkills))
        setAvailablePlugins(createReadonlyBuiltinAssets(builtinPlugins))
      })

        // Dismiss splash after full hydration
        ; (window as unknown as { __dismissSplash?: () => void }).__dismissSplash?.()

      unlistenOpenTab = await listen<SettingsTab>('settings:open-tab', event => {
        setActiveTab(event.payload)
      })

      unlistenSettingsUpdated = await listen('settings:updated', () => {
        const latest = loadSettings()
        setSavedSettings(latest)
        setDraftSettings(cloneSettings(latest))
        setSelectedProviderProfileId(current =>
          latest.providerProfiles.some(profile => profile.id === current)
            ? current
            : latest.activeProviderProfileId,
        )
        void refreshLightpandaStatus(latest, { useAsBaseline: true, silent: true }).catch(() => {
          // Ignore background Lightpanda detection refresh errors.
        })
      })
    })()

    return () => {
      unlistenOpenTab?.()
      unlistenSettingsUpdated?.()
    }
  }, [])

  useEffect(() => {
    if (saveState !== 'saved') {
      return
    }
    const timer = window.setTimeout(() => setSaveState('idle'), 1800)
    return () => window.clearTimeout(timer)
  }, [saveState])

  useEffect(() => {
    if (browserStatus?.tone !== 'success') {
      return
    }

    const timer = window.setTimeout(() => setBrowserStatus(null), 2200)
    return () => window.clearTimeout(timer)
  }, [browserStatus])

  useEffect(() => {
    if (!proxyStatus) {
      return
    }

    const timer = window.setTimeout(() => setProxyStatus(null), 2600)
    return () => window.clearTimeout(timer)
  }, [proxyStatus])

  useEffect(() => {
    if (!generalStatus) {
      return
    }

    const timer = window.setTimeout(() => setGeneralStatus(null), 2600)
    return () => window.clearTimeout(timer)
  }, [generalStatus])

  useEffect(() => {
    if (!isAwaitingLightpandaSelection) {
      return
    }

    const unlistenPromise = listen('tauri://focus', () => {
      setIsAwaitingLightpandaSelection(false)
      void syncLightpandaExecutableRecord({ silent: true })
    })

    return () => {
      unlistenPromise.then(unlisten => unlisten())
    }
  }, [isAwaitingLightpandaSelection])

  function handleSettingsChange<K extends keyof AgentSettings>(
    key: K,
    value: AgentSettings[K],
  ) {
    setDraftSettings(current => ({
      ...current,
      [key]: value,
    }))
    setSaveState('idle')
    if (key === 'networkProxy' || key === 'providerProxyEnabled') {
      setProxyStatus(null)
    }
  }

  function handleApprovalSettingChange<K extends keyof AgentSettings>(
    key: K,
    value: AgentSettings[K],
  ) {
    handleSettingsChange(key, value)
  }

  function updateLightpandaSettings(patch: Partial<AgentSettings['browser']['lightpanda']>) {
    setDraftSettings(current => ({
      ...current,
      browser: {
        ...current.browser,
        lightpanda: {
          ...current.browser.lightpanda,
          ...patch,
        },
      },
    }))
    setSaveState('idle')
    setBrowserStatus(null)
  }

  function updateInteractiveBrowserSettings(
    patch: Partial<AgentSettings['browser']['interactive']>,
  ) {
    setDraftSettings(current => ({
      ...current,
      browser: {
        ...current.browser,
        interactive: {
          ...current.browser.interactive,
          ...patch,
        },
      },
    }))
    setSaveState('idle')
    setBrowserStatus(null)
  }

  function updateWebSettings(patch: Partial<AgentSettings['web']>) {
    setDraftSettings(current => ({
      ...current,
      web: {
        ...current.web,
        ...patch,
      },
    }))
    setSaveState('idle')
  }

  function updateWebSearchSettings<K extends keyof AgentSettings['web']['search']>(
    key: K,
    value: AgentSettings['web']['search'][K],
  ) {
    setDraftSettings(current => ({
      ...current,
      web: {
        ...current.web,
        search: {
          ...current.web.search,
          [key]: value,
        },
      },
    }))
    setSaveState('idle')
  }

  function updateWebResearchSettings<K extends keyof AgentSettings['web']['research']>(
    key: K,
    value: AgentSettings['web']['research'][K],
  ) {
    setDraftSettings(current => ({
      ...current,
      web: {
        ...current.web,
        research: {
          ...current.web.research,
          [key]: value,
        },
      },
    }))
    setSaveState('idle')
  }

  function updateWebFetchSettings<K extends keyof AgentSettings['web']['fetch']>(
    key: K,
    value: AgentSettings['web']['fetch'][K],
  ) {
    setDraftSettings(current => ({
      ...current,
      web: {
        ...current.web,
        fetch: {
          ...current.web.fetch,
          [key]: value,
        },
      },
    }))
    setSaveState('idle')
  }

  function updateWebFetchProviderSettings<
    K extends keyof AgentSettings['web']['fetch']['providers'],
  >(
    key: K,
    value: AgentSettings['web']['fetch']['providers'][K],
  ) {
    setDraftSettings(current => ({
      ...current,
      web: {
        ...current.web,
        fetch: {
          ...current.web.fetch,
          providers: {
            ...current.web.fetch.providers,
            [key]: value,
          },
        },
      },
    }))
    setSaveState('idle')
  }

  function updateWebSearchProviderSettings<
    K extends keyof AgentSettings['web']['search']['providers'],
  >(
    key: K,
    value: AgentSettings['web']['search']['providers'][K],
  ) {
    setDraftSettings(current => ({
      ...current,
      web: {
        ...current.web,
        search: {
          ...current.web.search,
          providers: {
            ...current.web.search.providers,
            [key]: value,
          },
        },
      },
    }))
    setSaveState('idle')
  }

  function updateProviderProfile<K extends keyof ProviderProfile>(
    profileId: string,
    key: K,
    value: ProviderProfile[K],
  ) {
    setDraftSettings(current => ({
      ...current,
      providerProfiles: current.providerProfiles.map(profile => {
        if (profile.id !== profileId) {
          return profile
        }

        if (key === 'provider') {
          const provider = value as ProviderMode
          const shouldResetBaseUrl =
            !profile.baseUrl.trim() || Object.values(PROVIDER_BASE_URLS).includes(profile.baseUrl)
          return {
            ...profile,
            provider,
            baseUrl: shouldResetBaseUrl ? PROVIDER_BASE_URLS[provider] : profile.baseUrl,
          }
        }

        if (key === 'models') {
          const models = value as ProviderProfile['models']
          const nextDefaultModel =
            models.some(model => model.enabled && model.id === profile.defaultModel)
              ? profile.defaultModel
              : models.find(model => model.enabled)?.id || ''
          return {
            ...profile,
            models,
            defaultModel: nextDefaultModel,
          }
        }

        return {
          ...profile,
          [key]: value,
        }
      }),
    }))
    setSaveState('idle')
    setProviderStatus(null)
  }

  function createProfile() {
    const next = createProviderProfile('custom')
    setDraftSettings(current => ({
      ...current,
      providerProfiles: [next, ...current.providerProfiles],
    }))
    setSelectedProviderProfileId(next.id)
    setSaveState('idle')
  }

  async function deleteProfile(profileId: string) {
    const target = draftSettings.providerProfiles.find(profile => profile.id === profileId)
    if (!target) {
      return
    }

    const confirmed = await ask(`确认删除提供商 “${target.name}”？此操作不可撤销。`, {
      title: '删除确认',
      kind: 'warning',
    })

    if (!confirmed) {
      return
    }

    const remaining = draftSettings.providerProfiles.filter(profile => profile.id !== profileId)
    const isDeletingActive = draftSettings.activeProviderProfileId === profileId
    const nextActiveProfile = isDeletingActive ? remaining[0] : null
    const nextActiveId = isDeletingActive ? nextActiveProfile?.id || '' : draftSettings.activeProviderProfileId

    setDraftSettings(current => {
      const next = {
        ...current,
        activeProviderProfileId: nextActiveId,
        providerProfiles: remaining,
      }

      // 如果删除的是当前激活项，同步更新根级字段
      if (isDeletingActive) {
        if (nextActiveProfile) {
          next.provider = nextActiveProfile.provider
          next.apiKey = nextActiveProfile.apiKey
          next.baseUrl = nextActiveProfile.baseUrl
          const primaryModel = getPrimaryModelId(nextActiveProfile)
          next.model = primaryModel
        } else {
          // 彻底没有 Profile 了
          next.apiKey = ''
          next.baseUrl = ''
          next.model = ''
        }
      }

      return next
    })

    setSelectedProviderProfileId(remaining[0]?.id || '')
    setSaveState('idle')
    setProviderStatus(null)
  }

  function addProfileModel(profileId: string, rawModelId: string) {
    const targetProfile = draftSettings.providerProfiles.find(profile => profile.id === profileId)
    if (!targetProfile) {
      return
    }

    const modelId = normalizeManualModelId(targetProfile, rawModelId)
    if (!modelId) {
      setProviderStatus({
        tone: 'error',
        message: '请输入模型 ID。',
      })
      return
    }

    setDraftSettings(current => {
      const providerProfiles = current.providerProfiles.map(profile => {
        if (profile.id !== profileId) {
          return profile
        }

        const models = profile.models.some(model => model.id === modelId)
          ? profile.models.map(model =>
            model.id === modelId ? { ...model, enabled: true } : model,
          )
          : [{ id: modelId, enabled: true }, ...profile.models]

        return {
          ...profile,
          models,
          defaultModel: modelId,
        }
      })
      const updatedProfile = providerProfiles.find(profile => profile.id === profileId)
      const next = {
        ...current,
        providerProfiles,
      }

      if (updatedProfile && current.activeProviderProfileId === profileId) {
        next.provider = updatedProfile.provider
        next.apiKey = updatedProfile.apiKey
        next.baseUrl = updatedProfile.baseUrl
        next.model = modelId
      }

      return next
    })
    setSaveState('idle')
    setProviderStatus({
      tone: 'success',
      message: `已添加并启用模型 ${formatModelLabel(modelId)}。`,
    })
  }

  function removeProfileModel(profileId: string, modelId: string) {
    setDraftSettings(current => {
      const providerProfiles = current.providerProfiles.map(profile => {
        if (profile.id !== profileId) {
          return profile
        }

        const models = profile.models.filter(model => model.id !== modelId)
        if (models.length === profile.models.length) {
          return profile
        }

        const defaultModel =
          profile.defaultModel !== modelId &&
            models.some(model => model.enabled && model.id === profile.defaultModel)
            ? profile.defaultModel
            : models.find(model => model.enabled)?.id || ''

        return {
          ...profile,
          models,
          defaultModel,
        }
      })
      const updatedProfile = providerProfiles.find(profile => profile.id === profileId)
      const next = {
        ...current,
        providerProfiles,
      }

      if (updatedProfile && current.activeProviderProfileId === profileId && current.model === modelId) {
        next.model = updatedProfile.defaultModel
      }

      return next
    })
    setSaveState('idle')
    setProviderStatus({
      tone: 'success',
      message: `已移除模型 ${formatModelLabel(modelId)}。`,
    })
  }

  function toggleProfileModel(profileId: string, modelId: string) {
    setDraftSettings(current => ({
      ...current,
      providerProfiles: current.providerProfiles.map(profile => {
        if (profile.id !== profileId) {
          return profile
        }

        const models = profile.models.map(model =>
          model.id === modelId ? { ...model, enabled: !model.enabled } : model,
        )
        const toggledModel = models.find(model => model.id === modelId)
        const nextDefaultModel =
          toggledModel?.enabled
            ? modelId
            : models.some(model => model.enabled && model.id === profile.defaultModel)
              ? profile.defaultModel
              : models.find(model => model.enabled)?.id || ''

        return {
          ...profile,
          models,
          defaultModel: nextDefaultModel,
        }
      }),
    }))
    setSaveState('idle')
  }

  function getPrimaryModelId(profile: ProviderProfile) {
    if (profile.models.some(model => model.enabled && model.id === profile.defaultModel)) {
      return profile.defaultModel
    }
    return profile.models.find(model => model.enabled)?.id || ''
  }

  function activateProviderProfile(profileId: string) {
    const profile =
      draftSettings.providerProfiles.find(entry => entry.id === profileId) || null
    setSelectedProviderProfileId(profileId)
    if (!profile) {
      return
    }

    const preferredModel = getPrimaryModelId(profile)
    setDraftSettings(current => ({
      ...current,
      activeProviderProfileId: profile.id,
      provider: profile.provider,
      apiKey: profile.apiKey,
      baseUrl: profile.baseUrl,
      model: preferredModel,
    }))
    setSaveState('idle')
  }

  function buildProviderRequestSettings(profile: ProviderProfile): AgentSettings {
    const primaryModel = getPrimaryModelId(profile)
    return {
      ...draftSettings,
      provider: profile.provider,
      apiKey: profile.apiKey,
      baseUrl: profile.baseUrl,
      model: primaryModel,
    }
  }

  function setAnalysisMode(mode: 'inherit' | 'dedicated') {
    if (mode === 'inherit') {
      setDraftSettings(current => ({
        ...current,
        analysisProviderProfileId: '',
        analysisModel: '',
      }))
      setSaveState('idle')
      return
    }

    const fallbackProfile =
      selectedAnalysisProfile ||
      analysisCandidateProfiles[0] ||
      draftSettings.providerProfiles.find(profile => profile.id === draftSettings.activeProviderProfileId) ||
      null
    const fallbackModel = fallbackProfile ? getPrimaryModelId(fallbackProfile) : ''

    setDraftSettings(current => ({
      ...current,
      analysisProviderProfileId: fallbackProfile?.id || '',
      analysisModel: fallbackModel,
    }))
    setSaveState('idle')
  }

  function updateAnalysisProfile(profileId: string) {
    const profile =
      analysisCandidateProfiles.find(entry => entry.id === profileId) || null
    const nextModel = profile ? getPrimaryModelId(profile) : ''
    setDraftSettings(current => ({
      ...current,
      analysisProviderProfileId: profile?.id || '',
      analysisModel: nextModel,
    }))
    setSaveState('idle')
  }

  function updateAnalysisModel(modelId: string) {
    setDraftSettings(current => ({
      ...current,
      analysisModel: modelId,
    }))
    setSaveState('idle')
  }

  function updateTitleModelRoute(value: string) {
    const selection = decodeModelRouteValue(value)

    if (!selection) {
      setDraftSettings(current => ({
        ...current,
        titleProviderProfileId: '',
        titleModel: '',
      }))
      setSaveState('idle')
      return
    }

    setDraftSettings(current => ({
      ...current,
      titleProviderProfileId: selection.profileId,
      titleModel: selection.modelId,
    }))
    setSaveState('idle')
  }

  function toggleSkill(skillId: string) {
    if (builtinSkillIdSet.has(skillId)) {
      return
    }
    const target = availableSkills.find(item => item.id === skillId)
    if (target && !target.supported) {
      return
    }
    const next = draftSettings.enabledSkillIds.includes(skillId)
      ? draftSettings.enabledSkillIds.filter(id => id !== skillId)
      : [...draftSettings.enabledSkillIds, skillId]
    handleSettingsChange('enabledSkillIds', next)
  }

  function togglePlugin(pluginId: string) {
    const target = availablePlugins.find(item => item.id === pluginId)
    if (target && !target.supported) {
      return
    }
    const next = draftSettings.enabledPluginIds.includes(pluginId)
      ? draftSettings.enabledPluginIds.filter(id => id !== pluginId)
      : [...draftSettings.enabledPluginIds, pluginId]
    handleSettingsChange('enabledPluginIds', next)
  }

  function setAllSkillsEnabled(enabled: boolean) {
    handleSettingsChange(
      'enabledSkillIds',
      enabled
        ? availableSkills
          .filter(item => item.supported && !builtinSkillIdSet.has(item.id))
          .map(item => item.id)
        : [],
    )
  }

  function setAllPluginsEnabled(enabled: boolean) {
    handleSettingsChange(
      'enabledPluginIds',
      enabled ? availablePlugins.filter(item => item.supported).map(item => item.id) : [],
    )
  }

  function setAllMcpEnabled(enabled: boolean) {
    if (!enabled) {
      void persistMcpServers(
        draftSettings.mcpServers.map(server => ({
          ...server,
          enabled: false,
        })),
      )
      return
    }

    void persistMcpServers(
      draftSettings.mcpServers.map(server => ({
        ...server,
        enabled: server.healthStatus === 'ok',
      })),
    )
  }

  async function refreshAuraAssets(kind?: 'skills' | 'plugins') {
    if (kind) {
      setRefreshingAssets(kind)
    } else {
      setRefreshingAssets('skills')
    }

    try {
      const state = await ensureAuraHome()
      setAuraHome(state)
      setAvailableSkills(mergeAuraAssets(state.skills, builtinSkills))
      setAvailablePlugins(mergeAuraAssets(state.plugins, builtinPlugins))
    } finally {
      setRefreshingAssets('')
    }
  }

  async function persistSettingsAndRefreshAssets(nextSettings: AgentSettings, kind?: 'skills' | 'plugins') {
    await saveSettingsAndAwaitPersistence(nextSettings)
    setSavedSettings(cloneSettings(nextSettings))
    setDraftSettings(cloneSettings(nextSettings))
    setSaveState('saved')
    await broadcastSettingsUpdated()
    await refreshAuraAssets(kind)
  }

  async function bindExternalSkillDirectory() {
    const existingDirs = normalizePathList(draftSettings.externalSkillDirs || [])
    const selected = await open({
      directory: true,
      multiple: false,
      title: '选择外部 Skill 目录',
    })
    if (typeof selected !== 'string') {
      return
    }

    const nextDirs = normalizePathList([selected])
    const selectedPath = nextDirs[0]
    if (!selectedPath) {
      return
    }

    const isChangingDirectory =
      existingDirs.length > 0 &&
      (existingDirs.length !== 1 || existingDirs[0] !== selectedPath)
    if (isChangingDirectory) {
      const confirmed = await ask(
        '换绑外部 Skill 目录会从 Aura 列表中移除之前绑定目录的 skills，并清除这些 skills 的启用状态；不会删除原目录文件。确认继续？',
        {
          title: '换绑外部目录',
          kind: 'warning',
          okLabel: '确认换绑',
          cancelLabel: '取消',
        },
      )
      if (!confirmed) {
        return
      }
    }

    const previousExternalSkillIds = new Set(
      availableSkills
        .filter(item => item.external)
        .map(item => item.id),
    )
    await persistSettingsAndRefreshAssets({
      ...draftSettings,
      enabledSkillIds: isChangingDirectory
        ? draftSettings.enabledSkillIds.filter(id => !previousExternalSkillIds.has(id))
        : draftSettings.enabledSkillIds,
      externalSkillDirs: nextDirs,
    }, 'skills')
  }

  async function handleDeleteAsset() {
    if (!assetToDelete || !auraHome) return

    try {
      // Resolve path relative to aura home
      let relativePath = assetToDelete.path
      if (relativePath.startsWith(auraHome.homeDir)) {
        relativePath = relativePath.slice(auraHome.homeDir.length)
      }

      await deleteAuraAsset(relativePath)
      await refreshAuraAssets(assetToDelete.kind)
    } catch (error) {
      console.error('Failed to delete asset:', error)
      alert(`删除失败: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setAssetToDelete(null)
    }
  }

  async function handleDeleteMcp() {
    if (!mcpToDelete) return
    await persistMcpServers(draftSettings.mcpServers.filter(s => s.id !== mcpToDelete.id))
    setMcpToDelete(null)
  }

  async function persistMcpServers(nextServers: AgentSettings['mcpServers']) {
    const latest = loadSettings()
    await saveSettingsAndAwaitPersistence({
      ...latest,
      mcpServers: nextServers,
    })
    setSavedSettings(current => ({
      ...current,
      mcpServers: nextServers,
    }))
    setDraftSettings(current => ({
      ...current,
      mcpServers: nextServers,
    }))
    await broadcastSettingsUpdated()
    setSaveState('saved')
  }

  async function handleFactoryReset() {
    try {
      await resetAuraHome()
      localStorage.clear()
      window.location.reload()
    } catch (error) {
      console.error('Failed to reset app:', error)
      alert(`应用重置失败: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setIsResetting(false)
    }
  }

  async function refreshMcpServers() {
    setIsRefreshingMcp(true)
    try {
      const hydrated = await hydrateStorageFromAuraHome()
      setAuraHome(hydrated.aura)
      setSavedSettings(current => ({
        ...current,
        mcpServers: hydrated.settings.mcpServers,
      }))
      setDraftSettings(current => ({
        ...current,
        mcpServers: hydrated.settings.mcpServers,
      }))
      setMcpInspectResults({})
      setSaveState('idle')
    } finally {
      setIsRefreshingMcp(false)
    }
  }

  async function openAuraMcpFolder() {
    const nextAura = auraHome || (await ensureAuraHome())
    setAuraHome(nextAura)
    await openPathInDefaultApp(nextAura.mcpDir)
  }

  async function testMcpServer(
    serverId: string,
    options?: {
      enableOnSuccess?: boolean
      persistResult?: boolean
    },
  ) {
    const server = draftSettings.mcpServers.find(entry => entry.id === serverId)
    if (!server) {
      return false
    }

    setTestingMcpServerId(serverId)
    try {
      const validation = validateMcpServerInput(server)
      if (!validation.isValid) {
        const message = validation.firstMessage || 'MCP 配置校验失败。'
        const nextServers = draftSettings.mcpServers.map(entry =>
          entry.id === serverId
            ? {
              ...entry,
              enabled: false,
              healthStatus: 'error' as const,
              healthMessage: message,
              lastCheckedAt: Date.now(),
              toolCount: 0,
            }
            : entry,
        )
        setMcpInspectResults(current => ({
          ...current,
          [serverId]: {
            tone: 'error',
            message,
            tools: [],
          },
        }))
        setDraftSettings(current => ({
          ...current,
          mcpServers: nextServers,
        }))
        if (options?.persistResult) {
          await persistMcpServers(nextServers)
        } else {
          setSaveState('idle')
        }
        return false
      }

      const result = await inspectMcpServer(server)
      const nextServers = draftSettings.mcpServers.map(entry =>
        entry.id === serverId
          ? {
            ...entry,
            enabled: options?.enableOnSuccess ? true : entry.enabled,
            healthStatus: 'ok' as const,
            healthMessage: result.message,
            lastCheckedAt: Date.now(),
            toolCount: result.tools.length,
          }
          : entry,
      )
      setMcpInspectResults(current => ({
        ...current,
        [serverId]: {
          tone: 'success',
          message: result.message,
          tools: result.tools,
        },
      }))
      setDraftSettings(current => ({
        ...current,
        mcpServers: nextServers,
      }))
      if (options?.persistResult) {
        await persistMcpServers(nextServers)
      } else {
        setSaveState('idle')
      }
      return true
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : 'MCP 连接测试失败。'
      const nextServers = draftSettings.mcpServers.map(entry =>
        entry.id === serverId
          ? {
            ...entry,
            enabled: false,
            healthStatus: 'error' as const,
            healthMessage: message,
            lastCheckedAt: Date.now(),
            toolCount: 0,
          }
          : entry,
      )
      setMcpInspectResults(current => ({
        ...current,
        [serverId]: {
          tone: 'error',
          message,
          tools: [],
        },
      }))
      setDraftSettings(current => ({
        ...current,
        mcpServers: nextServers,
      }))
      if (options?.persistResult) {
        await persistMcpServers(nextServers)
      } else {
        setSaveState('idle')
      }
      return false
    } finally {
      setTestingMcpServerId('')
    }
  }

  async function toggleMcpServerEnabled(serverId: string, nextEnabled: boolean) {
    if (!nextEnabled) {
      await persistMcpServers(
        draftSettings.mcpServers.map(server =>
          server.id === serverId
            ? {
              ...server,
              enabled: false,
            }
            : server,
        ),
      )
      return
    }

    await testMcpServer(serverId, {
      enableOnSuccess: true,
      persistResult: true,
    })
  }

  async function openAuraAssetFolder(kind: 'skills' | 'plugins') {
    const nextAura = auraHome || (await ensureAuraHome())
    setAuraHome(nextAura)
    const folderPath = kind === 'skills' ? nextAura.skillsDir : nextAura.pluginsDir
    await openPathInDefaultApp(folderPath)
  }

  async function toggleAssetExpanded(item: { id: string; path?: string }) {
    const nextExpanded = new Set(expandedAssetIds)
    const isExpanded = nextExpanded.has(item.id)
    if (isExpanded) {
      nextExpanded.delete(item.id)
      setExpandedAssetIds(nextExpanded)
      return
    }

    nextExpanded.add(item.id)
    setExpandedAssetIds(nextExpanded)

    if (!item.path || assetPreviewCache[item.path]) {
      return
    }

    setLoadingPreviewPath(item.path)
    try {
      const content = await readTextFile(item.path)
      setAssetPreviewCache(current => ({
        ...current,
        [item.path!]: content,
      }))
    } catch (caught) {
      setAssetPreviewCache(current => ({
        ...current,
        [item.path!]:
          caught instanceof Error ? caught.message : '读取内容失败。',
      }))
    } finally {
      setLoadingPreviewPath('')
    }
  }

  async function refreshLightpandaStatus(
    settingsOverride?: AgentSettings,
    options?: { useAsBaseline?: boolean; silent?: boolean },
  ): Promise<LightpandaRuntimeStatusRecord | null> {
    const targetSettings = settingsOverride || draftSettings
    const executablePath = resolveLightpandaExecutablePath(
      targetSettings.browser.lightpanda.executablePath,
    )

    setIsRefreshingLightpandaStatus(true)
    if (!options?.silent) {
      setBrowserStatus(null)
    }

    try {
      const status = await detectLightpandaRuntime({
        executablePath: executablePath || undefined,
      })
      setLightpandaStatus(status)

      const nextSettings: AgentSettings = {
        ...targetSettings,
        browser: {
          ...targetSettings.browser,
          lightpanda: {
            ...targetSettings.browser.lightpanda,
            executablePath: executablePath
              ? status.valid
                ? status.executablePath || executablePath
                : executablePath
              : '',
          },
        },
      }

      setDraftSettings(cloneSettings(nextSettings))
      if (options?.useAsBaseline) {
        setSavedSettings(cloneSettings(nextSettings))
      } else if (
        nextSettings.browser.lightpanda.executablePath !==
        targetSettings.browser.lightpanda.executablePath
      ) {
        setSaveState('idle')
      }

      if (!options?.silent) {
        setBrowserStatus({
          tone: status.valid ? 'success' : 'error',
          message: status.valid
            ? 'Lightpanda 环境检测已完成。'
            : status.error || '未检测到可用的 Lightpanda。',
        })
      }
      return status
    } catch (caught) {
      setLightpandaStatus(null)
      if (!options?.silent) {
        setBrowserStatus({
          tone: 'error',
          message: caught instanceof Error ? caught.message : 'Lightpanda 检测失败。',
        })
      }
      return null
    } finally {
      setIsRefreshingLightpandaStatus(false)
    }
  }

  async function openLightpandaInstallDirectory() {
    const nextAura = auraHome || (await ensureAuraHome())
    setAuraHome(nextAura)
    setBrowserStatus(null)
    setIsAwaitingLightpandaSelection(true)

    try {
      await openPathInDefaultApp(nextAura.browserDir)
    } catch (caught) {
      setIsAwaitingLightpandaSelection(false)
      setBrowserStatus({
        tone: 'error',
        message: caught instanceof Error ? caught.message : '打开 Lightpanda 安装目录失败。',
      })
    }
  }

  async function syncLightpandaExecutableRecord(options?: { silent?: boolean }) {
    const nextAura = auraHome || (await ensureAuraHome())
    setAuraHome(nextAura)
    if (!options?.silent) {
      setBrowserStatus(null)
    }
    setIsRefreshingLightpandaStatus(true)

    let status: LightpandaRuntimeStatusRecord | null = null
    try {
      status = await detectLightpandaRuntime()
      setLightpandaStatus(status)
    } catch (caught) {
      if (!options?.silent) {
        setBrowserStatus({
          tone: 'error',
          message: caught instanceof Error ? caught.message : 'Lightpanda 检测失败。',
        })
      }
      return
    } finally {
      setIsRefreshingLightpandaStatus(false)
    }

    const detectedBrowserPath =
      status?.valid &&
        status.executablePath &&
        isPathInsideDirectory(status.executablePath, nextAura.browserDir)
        ? status.executablePath
        : ''
    const persistedSettings = loadSettings()
    const persistedPath = resolveLightpandaExecutablePath(
      persistedSettings.browser.lightpanda.executablePath,
    )
    const shouldClearPersistedPath =
      !detectedBrowserPath && isPathInsideDirectory(persistedPath, nextAura.browserDir)

    if (!detectedBrowserPath && !shouldClearPersistedPath) {
      return
    }

    const nextSavedSettings: AgentSettings = {
      ...persistedSettings,
      browser: {
        ...persistedSettings.browser,
        lightpanda: {
          ...persistedSettings.browser.lightpanda,
          executablePath: detectedBrowserPath,
        },
      },
    }

    try {
      await saveSettingsAndAwaitPersistence(nextSavedSettings)
      setSavedSettings(cloneSettings(nextSavedSettings))
      setDraftSettings(current => ({
        ...current,
        browser: {
          ...current.browser,
          lightpanda: {
            ...current.browser.lightpanda,
            executablePath: detectedBrowserPath,
          },
        },
      }))
      if (!options?.silent) {
        setSaveState('saved')
      }
      await broadcastSettingsUpdated()
      if (!options?.silent) {
        setBrowserStatus({
          tone: 'success',
          message: detectedBrowserPath
            ? '已记录 Lightpanda 可执行文件，后续会直接调用这个路径。'
            : '已清除无效的启动实例记录。',
        })
      }
    } catch (caught) {
      if (!options?.silent) {
        setBrowserStatus({
          tone: 'error',
          message: caught instanceof Error ? caught.message : '保存 Lightpanda 路径失败。',
        })
      }
    }
  }

  async function chooseDefaultWorkspace() {
    const selected = await open({
      directory: true,
      multiple: false,
      title: '选择默认工作目录',
    })
    if (typeof selected === 'string') {
      handleSettingsChange('cwd', selected)
    }
  }

  async function openAuraLogsFolder() {
    setGeneralStatus(null)
    try {
      const nextAura = auraHome || (await ensureAuraHome())
      setAuraHome(nextAura)
      await openPathInDefaultApp(nextAura.logsDir)
    } catch (caught) {
      setGeneralStatus({
        tone: 'error',
        message: formatCaughtMessage(caught, '打开日志目录失败。'),
      })
    }
  }

  async function handleOpenWorkspaceFolder() {
    setGeneralStatus(null)
    const path = draftSettings.cwd.trim()
    if (!path) return
    try {
      await openWorkspaceFolder(path)
    } catch (caught) {
      setGeneralStatus({
        tone: 'error',
        message: formatCaughtMessage(caught, '打开工作目录失败。'),
      })
    }
  }

  async function saveDraftSettings() {
    if (browserValidationError) {
      setBrowserStatus({
        tone: 'error',
        message: browserValidationError,
      })
      return
    }

    await saveSettingsAndAwaitPersistence(draftSettings)
    setSavedSettings(cloneSettings(draftSettings))
    setSaveState('saved')
    await broadcastSettingsUpdated()
  }

  async function handleTestConnection() {
    if (!selectedProfile) {
      return
    }
    setIsTestingProvider(true)
    setProviderStatus(null)
    try {
      const result = await testProviderConnection(buildProviderRequestSettings(selectedProfile))
      setProviderStatus({
        tone: 'success',
        message: result.message,
      })
    } catch (caught) {
      setProviderStatus({
        tone: 'error',
        message: formatCaughtMessage(caught, 'Provider 测试失败。'),
      })
    } finally {
      setIsTestingProvider(false)
    }
  }

  async function handleFetchModels() {
    if (!selectedProfile) {
      return
    }
    setIsFetchingModels(true)
    setProviderStatus(null)
    try {
      const result = await fetchProviderModels(buildProviderRequestSettings(selectedProfile))
      const fetchedIdsForStatus = new Set(result.models.map(model => model.id))
      const preservedLocalModelCount = selectedProfile.models.filter(
        model => !fetchedIdsForStatus.has(model.id),
      ).length
      setDraftSettings(current => ({
        ...current,
        providerProfiles: current.providerProfiles.map(profile => {
          if (profile.id !== selectedProfile.id) {
            return profile
          }

          const existingById = new Map(profile.models.map(model => [model.id, model]))
          const fetchedIds = new Set(result.models.map(model => model.id))
          const preservedLocalModels = profile.models.filter(model => !fetchedIds.has(model.id))
          const fetchedModels = result.models.map(model => {
            const existing = existingById.get(model.id)
            return {
              ...model,
              enabled: existing?.enabled ?? false,
              contextWindowTokens: model.contextWindowTokens || existing?.contextWindowTokens,
              maxOutputTokens: model.maxOutputTokens || existing?.maxOutputTokens,
            }
          })
          const models = [...preservedLocalModels, ...fetchedModels]
          const nextDefaultModel =
            models.some(model => model.enabled && model.id === profile.defaultModel)
              ? profile.defaultModel
              : models.find(model => model.enabled)?.id || ''

          return {
            ...profile,
            models,
            defaultModel: nextDefaultModel,
          }
        }),
      }))
      setSaveState('idle')
      setProviderStatus({
        tone: 'success',
        message:
          preservedLocalModelCount > 0
            ? `${result.message} 已保留 ${preservedLocalModelCount} 个本地模型。`
            : result.message,
      })
    } catch (caught) {
      setProviderStatus({
        tone: 'error',
        message: formatCaughtMessage(caught, '模型拉取失败。'),
      })
    } finally {
      setIsFetchingModels(false)
    }
  }

  async function handleTestProxyConnectivity() {
    setIsTestingProxy(true)
    setProxyStatus(null)
    try {
      const result = await testProxyConnectivity(draftSettings)
      setProxyStatus({
        tone: 'success',
        message: result.message,
      })
    } catch (caught) {
      setProxyStatus({
        tone: 'error',
        message: caught instanceof Error ? caught.message : '代理连通性测试失败。',
      })
    } finally {
      setIsTestingProxy(false)
    }
  }

  function renderGeneral() {
    const isLongTaskMode = draftSettings.executionMode === 'long-task'

    return (
      <section className="section-shell settings-panel">
        <div className="settings-grid">
          <section className="dashboard-card">
            <div className="rounded-xl border border-[var(--border-subtle)] bg-[rgba(0,0,0,0.02)] p-3">
              <div className="section-title flex items-center justify-between">
                <span>默认工作目录</span>
                <button className="secondary-button" onClick={() => void chooseDefaultWorkspace()}>
                  选择目录
                </button>
              </div>
              <button className="muted" onClick={() => void handleOpenWorkspaceFolder()}>
                {draftSettings.cwd.trim()
                  ? draftSettings.cwd
                  : '新会话没有手动选择目录时，会使用这里作为默认根目录。'}
              </button>
            </div>
            <div className="mt-5 rounded-xl border border-[var(--border-subtle)] bg-[rgba(0,0,0,0.02)] p-3">
              <div className="mb-2 flex items-center justify-between gap-3">
                <span className="text-13px font-700 text-[var(--text-primary)]">日志目录</span>
                <div className="flex shrink-0 items-center gap-2">
                  <button
                    className="secondary-button"
                    onClick={() => void openLogViewerWindow()}
                    type="button"
                  >
                    <Search size={14} />
                    查看看板
                  </button>
                </div>
              </div>
              <button
                className="block w-full truncate text-left text-12px leading-relaxed text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                onClick={() => void openAuraLogsFolder()}
                title={auraHome?.logsDir || '正在初始化 Aura 数据目录…'}
                type="button"
              >
                {auraHome?.logsDir || '正在初始化 Aura 数据目录…'}
              </button>
            </div>
            {generalStatus ? (
              <div className={`provider-feedback ${generalStatus.tone === 'success' ? 'success' : 'error'} mt-3`}>
                <span>{generalStatus.message}</span>
              </div>
            ) : null}
          </section>

          <section className="dashboard-card">
            <div className="section-title">网络连接代理 (Network Proxy)</div>
            <p className="muted">
              Provider 走显式代理，Web 工具走自动策略。模型连接只会按下面的开关决定是否使用代理；`web_search / web_fetch / web_research` 会先直连，只有直连失败时才自动尝试下面的代理地址。
            </p>
            <label className="toggle-inline mt-3">
              <input
                checked={draftSettings.providerProxyEnabled}
                onChange={event => handleSettingsChange('providerProxyEnabled', event.target.checked)}
                type="checkbox"
              />
              <div className="flex flex-col">
                <strong>{'使用代理'}</strong>
                <span className="muted">开启后 Provider 将使用代理连接；Web 工具默认使用直连，当遇到错误会尝试代理连接。</span>
              </div>
            </label>
            <input
              type="text"
              placeholder="http://127.0.0.1:7890"
              value={draftSettings.networkProxy || ''}
              className="settings-text-input mt-3"
              onChange={event => handleSettingsChange('networkProxy', event.target.value)}
              style={{ width: '100%', maxWidth: '400px' }}
            />
            <div className="header-actions mt-3">
              <button
                className="secondary-button"
                disabled={isTestingProxy}
                onClick={() => void handleTestProxyConnectivity()}
                type="button"
              >
                <RefreshCw className={isTestingProxy ? 'animate-spin' : ''} size={14} />
                <span>{isTestingProxy ? '正在测试...' : (draftSettings.networkProxy || '').trim() ? '测试代理地址' : '测试当前直连'}</span>
              </button>
            </div>
            {proxyStatus ? (
              <div className={`provider-feedback ${proxyStatus.tone === 'success' ? 'success' : 'error'} mt-3`}>
                <strong>{proxyStatus.message}</strong>
              </div>
            ) : null}
          </section>

          {/* <section className="dashboard-card">
            <div className="section-title">提供商概览</div>
            <div className="dashboard-list">
              <div className="dashboard-row">
                <strong>已启用 Provider</strong>
                <span>
                  {draftSettings.providerProfiles.filter(profile => profile.enabled).length || '未配置'}
                </span>
              </div>
              <div className="dashboard-row">
                <strong>已启用模型</strong>
                <span>
                  {draftSettings.providerProfiles.reduce(
                    (count, profile) => count + profile.models.filter(model => model.enabled).length,
                    0,
                  ) || '未配置'}
                </span>
              </div>
            </div>
          </section> */}

          {/* <section className="dashboard-card">
            <div className="section-title">意图分析模型</div>
            <p className="muted">
              用于前置判断任务是否需要联网、浏览器交互，以及是否属于复杂任务。默认跟随当前聊天模型；只有你想用更便宜或更快的模型做前置分析时，才需要单独指定。
            </p>
            <div className="settings-mode-stack">
              <label className="toggle-inline">
                <input
                  checked={!analysisUsesDedicatedModel}
                  name="analysis-model-mode"
                  type="radio"
                  onChange={() => setAnalysisMode('inherit')}
                />
                <div className="flex flex-col">
                  <strong>跟随当前聊天模型</strong>
                  <span className="muted">
                    不单独设置时，自动使用你当前会话正在使用的模型。
                  </span>
                </div>
              </label>
              <label className="toggle-inline mt-2">
                <input
                  checked={analysisUsesDedicatedModel}
                  disabled={analysisCandidateProfiles.length === 0}
                  name="analysis-model-mode"
                  type="radio"
                  onChange={() => setAnalysisMode('dedicated')}
                />
                <div className="flex flex-col">
                  <strong>单独指定分析模型</strong>
                  <span className="muted">
                    适合把前置分类交给更快或更省成本的模型处理。
                  </span>
                </div>
              </label>
            </div>
            {analysisUsesDedicatedModel ? (
              analysisCandidateProfiles.length > 0 ? (
                <div className="mt-3 flex flex-col gap-3">
                  <label className="flex flex-col gap-1">
                    <span className="muted">分析 Provider</span>
                    <select
                      className="settings-select"
                      value={draftSettings.analysisProviderProfileId}
                      onChange={event => updateAnalysisProfile(event.target.value)}
                    >
                      {analysisCandidateProfiles.map(profile => (
                        <option key={profile.id} value={profile.id}>
                          {profile.name} · {profile.provider}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="flex flex-col gap-1">
                    <span className="muted">分析模型</span>
                    <select
                      className="settings-select"
                      value={draftSettings.analysisModel}
                      onChange={event => updateAnalysisModel(event.target.value)}
                    >
                      {analysisModelOptions.map(model => (
                        <option key={model.id} value={model.id}>
                          {formatModelLabel(model.id)} · {model.id}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
              ) : (
                <p className="muted mt-3">
                  还没有可选的已启用模型。先到“提供商”页启用至少一个模型，再回来单独指定分析模型。
                </p>
              )
            ) : null}
          </section> */}

          <section className="dashboard-card">
            <div className="section-title">模型设置</div>
            <p className="muted">
              不单独指定时，所有功能都会使用当前会话模型。需要更快或更省成本时，可以只针对某个功能覆盖模型。
            </p>
            <div className="model-routing-panel">
              <div className="model-routing-default">
                <span className="model-routing-default__badge">默认</span>
                <div>
                  <strong>当前会话模型</strong>
                  <span>所有未覆盖的功能都会跟随聊天窗口正在使用的模型。</span>
                </div>
              </div>

              <div className="model-route-list">
                <label className="model-route-row">
                  <div className="model-route-copy">
                    <span>标题</span>
                    <strong>聊天标题 AI 总结</strong>
                    <small>用于侧边栏“AI 总结标题”的后台调用。</small>
                  </div>
                  <div className="model-route-control">
                    <select
                      aria-label="聊天标题 AI 总结模型"
                      className="model-route-select"
                      value={titleModelRouteValue}
                      onChange={event => updateTitleModelRoute(event.target.value)}
                    >
                      <option value="">当前会话模型</option>
                      {modelRouteOptions.map(option => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                    <ChevronDown size={15} />
                  </div>
                </label>
              </div>

              {modelRouteOptions.length === 0 ? (
                <p className="model-route-empty">
                  还没有可选的已启用模型。先到“提供商”页启用至少一个模型。
                </p>
              ) : null}
            </div>
          </section>

          <section className="dashboard-card">
            <div className="section-title">交互设置</div>
            <div className="toggle-stack">
              <label className="toggle-inline">
                <input
                  name="shortcut"
                  type="radio"
                  checked={draftSettings.sendShortcut === 'meta-enter'}
                  onChange={() => handleSettingsChange('sendShortcut', 'meta-enter')}
                />
                <div className="flex flex-col">
                  <strong>⌘/Ctrl + Enter 发送</strong>
                  <span className="muted">Enter 键用于换行</span>
                </div>
              </label>
              <label className="toggle-inline mt-2">
                <input
                  name="shortcut"
                  type="radio"
                  checked={draftSettings.sendShortcut === 'enter'}
                  onChange={() => handleSettingsChange('sendShortcut', 'enter')}
                />
                <div className="flex flex-col">
                  <strong>Enter 发送</strong>
                  <span className="muted">Shift + Enter 用于换行</span>
                </div>
              </label>
            </div>
          </section>

          {/* <section className="dashboard-card">
            <div className="section-title">任务轮数</div>
            <p className="muted">
              普通模式下，Agent 每完成一轮“模型判断 + 工具调用 + 继续推理”都会消耗一次轮数。
              项目分析、重构和排错通常需要更高轮数。
            </p>
            <div className="settings-mode-stack">
              <label className="toggle-inline">
                <input
                  checked={draftSettings.executionMode === 'bounded'}
                  onChange={() => handleSettingsChange('executionMode', 'bounded')}
                  type="radio"
                />
                <div className="flex flex-col">
                  <strong>普通模式</strong>
                  <span className="muted">
                    使用你设定的最大轮数，适合大多数任务，成本和耗时更可控。
                  </span>
                </div>
              </label>
              <label className="toggle-inline">
                <input
                  checked={draftSettings.executionMode === 'long-task'}
                  onChange={() => handleSettingsChange('executionMode', 'long-task')}
                  type="radio"
                />
                <div className="flex flex-col">
                  <strong>长任务模式</strong>
                  <span className="muted">
                    类似持续执行模式，更适合大型代码库分析。系统会持续尝试直到完成、你手动停止，或命中保护条件。
                  </span>
                </div>
              </label>
            </div>
            <div className="settings-preset-row">
              {STEP_PRESETS.map(preset => (
                <button
                  key={preset}
                  className={`settings-preset-chip ${draftSettings.maxSteps === preset ? 'active' : ''}`}
                  onClick={() => handleSettingsChange('maxSteps', preset)}
                  disabled={isLongTaskMode}
                  type="button"
                >
                  {preset} 轮
                </button>
              ))}
            </div>
            <label className="settings-number-field">
              <span>最大轮数</span>
              <input
                type="number"
                min={1}
                max={128}
                step={1}
                value={draftSettings.maxSteps}
                disabled={isLongTaskMode}
                onChange={event =>
                  handleSettingsChange(
                    'maxSteps',
                    Math.max(1, Math.min(128, Number(event.target.value) || 1)),
                  )
                }
              />
            </label>
            <div className="provider-note">
              <p>
                更高轮数意味着更长执行时间和更高 token 成本。
                长任务模式还可能让模型进行更多探索性工具调用，适合复杂任务，不适合简单问答。
              </p>
              {isLongTaskMode ? (
                <p>当前已启用长任务模式，轮数预设和最大轮数输入不会生效。</p>
              ) : null}
            </div>
          </section> */}

          <section className="dashboard-card">
            <div className="section-title">上下文与压缩</div>
            <p className="muted">
              当前上下文窗口优先使用模型列表返回的上限；模型没有提供时，使用这里的本地预算。Aura 会在接近窗口前自动压缩历史消息和工具结果，默认 256K tokens。
            </p>
            <div className="settings-preset-row">
              {CONTEXT_COMPRESSION_PRESETS.map(preset => (
                <button
                  key={preset}
                  className={`settings-preset-chip ${draftSettings.contextCompressionThresholdTokens === preset ? 'active' : ''}`}
                  onClick={() => handleSettingsChange('contextCompressionThresholdTokens', preset)}
                  type="button"
                >
                  {formatTokenCount(preset)}
                </button>
              ))}
            </div>
            <label className="settings-number-field">
              <span>本地上下文预算</span>
              <input
                type="number"
                min={16_000}
                max={2_000_000}
                step={1_000}
                value={draftSettings.contextCompressionThresholdTokens}
                onChange={event =>
                  handleSettingsChange(
                    'contextCompressionThresholdTokens',
                    Math.max(16_000, Math.min(2_000_000, Number(event.target.value) || 256_000)),
                  )
                }
              />
            </label>
            <div className="toggle-stack">
              <label className="toggle-inline">
                <input checked={draftSettings.memoryMode === 'summary'} disabled type="radio" />
                <div className="flex flex-col">
                  <strong>摘要模式</strong>
                  <span className="muted">
                    保留上一轮的分析摘要和结论，成本更低，当前版本已实现。
                  </span>
                </div>
              </label>
              <label className="toggle-inline disabled">
                <input checked={draftSettings.memoryMode === 'claude-like'} disabled type="radio" />
                <div className="flex flex-col">
                  <strong>持续上下文模式</strong>
                  <span className="muted">
                    未来会像 Claude Code 一样持续保留更多工具结果和上下文；当前版本暂未开放切换。
                  </span>
                </div>
              </label>
            </div>
          </section>

          <section className="dashboard-card">
            <div className="section-title">执行详情展示</div>
            <div className="toggle-stack">
              <label className="toggle-inline">
                <input
                  checked={draftSettings.showDetailedExecutionDetails}
                  onChange={event =>
                    handleSettingsChange('showDetailedExecutionDetails', event.target.checked)
                  }
                  type="checkbox"
                />
                <div className="flex flex-col">
                  <strong>显示详细执行信息</strong>
                  <span className="muted">
                    关闭时，聊天页默认只显示轻量执行摘要和待审批步骤；开启后恢复完整执行时间线。
                  </span>
                </div>
              </label>
            </div>
            <div className="provider-note mt-3">
              <p>这个开关只影响 UI 展示，不会裁剪 reasoning、工具事件、阶段输出或任务树的实际记录。</p>
              <p>切换后当前会话和历史消息都会按新模式重新渲染。</p>
            </div>
          </section>

          <section className="dashboard-card">
            <div className="section-title">审批策略</div>
            <div className="flex flex-col gap-3">
              {[
                { key: 'autoApproveShell', label: 'Shell 默认自动允许' },
                { key: 'autoApproveFileWrite', label: '文件写入默认自动允许' },
                { key: 'autoApproveComputerUse', label: 'Computer Use 默认自动允许' },
                { key: 'requireLongTaskPlanApproval', label: '长任务规划需要审批' },
              ].map(item => (
                <label key={item.key} className="relative flex items-center gap-3 cursor-pointer group">
                  <input
                    checked={draftSettings[item.key as keyof AgentSettings] as boolean}
                    onChange={event =>
                      handleApprovalSettingChange(
                        item.key as keyof AgentSettings,
                        event.target.checked,
                      )
                    }
                    type="checkbox"
                    className="peer sr-only"
                  />
                  <div className="relative h-5 w-9 shrink-0 rounded-full bg-black/10 transition-all peer-checked:bg-[var(--bg-user-bubble)] after:absolute after:top-0.5 after:left-[2px] after:h-4 after:w-4 after:rounded-full after:bg-white after:shadow-sm after:transition-all after:content-[''] peer-checked:after:translate-x-4" />
                  <span className="text-13px font-600 text-black/60 group-hover:text-black/80 transition-colors whitespace-nowrap">
                    {item.label}
                  </span>
                </label>
              ))}
            </div>
            <p className="text-12px leading-relaxed text-[var(--text-secondary)] opacity-70">
              这组开关会在保存后同步到主窗口。长任务规划审批默认关闭；关闭时计划会直接展示并执行，Shell、文件写入和桌面交互仍按各自开关审批。
            </p>
          </section>

          <section className="dashboard-card !border-red-100/50">
            <div className="section-title text-red-500">危险区域 (Danger Zone)</div>
            <p>
              抹除所有数据和设置会永久删除所有的本地会话记录、MCP 配置、下载的插件和自定义设置。
              操作完成后，应用将自动重启并恢复到初始状态。
            </p>
            <div className="header-actions">
              <button
                className="secondary-button !text-red-600 hover:!bg-red-50"
                onClick={() => setIsResetting(true)}
              >
                抹除所有数据和设置
              </button>
            </div>
          </section>
        </div>
      </section>
    )
  }

  function renderBrowser() {
    const savedLightpandaPath = resolveLightpandaExecutablePath(
      draftSettings.browser.lightpanda.executablePath,
    )
    const detectedBrowserPath =
      auraHome &&
        isPathInsideDirectory(lightpandaStatus?.executablePath, auraHome.browserDir)
        ? lightpandaStatus?.executablePath || ''
        : ''
    const lightpandaInstanceLabel =
      savedLightpandaPath || detectedBrowserPath || '选择启动路径'
    const lightpandaInstanceDisplay = savedLightpandaPath || detectedBrowserPath
      ? formatMiddleEllipsis(lightpandaInstanceLabel, 46)
      : lightpandaInstanceLabel
    const lightpandaStatusLabel = lightpandaStatus?.valid
      ? '可用'
      : lightpandaStatus?.detected
        ? '已检测但不可用'
        : '未检测到'
    const lightpandaDetail = lightpandaStatus?.version
      ? `版本: ${lightpandaStatus.version}`
      : lightpandaStatus?.error || '可用于资料搜索和网页内容读取。'

    return (
      <section className="section-shell settings-panel">
        <header className="section-header">
          <div>
            <div className="eyebrow">Web + Browser</div>
            <h2>网页与浏览器</h2>
            <p className="muted mt-2">
              资料获取和网页操作现在分成两条路径: 搜资料时只走 `web_* + Lightpanda`，显式操作网页时只走系统浏览器。
            </p>
          </div>
        </header>

        <div className="settings-grid">
          <section className="dashboard-card full-span browser-overview-card">
            <div className="section-title">运行模式总览</div>
            <div className="browser-summary-grid">
              <div className="browser-summary-item">
                <span className="browser-summary-label">Lightpanda</span>
                <strong>{lightpandaStatusLabel}</strong>
                <span className="muted">{lightpandaDetail}</span>
              </div>
              <div className="browser-summary-item">
                <span className="browser-summary-label">资料获取</span>
                <strong>
                  {draftSettings.browser.lightpanda.enabled ? '启用 Lightpanda' : '仅保留 web_*'}
                </strong>
                <span className="muted">失败不会自动拉起系统浏览器。</span>
              </div>
              <div className="browser-summary-item">
                <span className="browser-summary-label">浏览器操作</span>
                <strong>
                  {draftSettings.browser.interactive.enabled ? '系统浏览器可用' : '已禁用'}
                </strong>
                <span className="muted">只服务登录、点击、表单和人工处理等显式网页操作。</span>
              </div>
              <div className="browser-summary-item">
                <span className="browser-summary-label">Computer Use</span>
                <strong>
                  {draftSettings.browser.interactive.allowComputerUse ? '允许配合使用' : '不参与'}
                </strong>
                <span className="muted">
                  {draftSettings.enableComputerUse
                    ? '系统级桌面交互仍受全局 Computer Use 开关约束。'
                    : '当前全局 Computer Use 已关闭。'}
                </span>
              </div>
            </div>
          </section>

          <section className="dashboard-card">
            <div className="section-title">资料获取</div>

            {browserStatus ? (
              <div className={`provider-feedback ${browserStatus.tone === 'success' ? 'success' : 'error'} mt-3`}>
                <strong>{browserStatus.message}</strong>
              </div>
            ) : null}

            {browserValidationError ? (
              <div className="provider-feedback error mt-3">
                <strong>{browserValidationError}</strong>
              </div>
            ) : null}

            <div className="toggle-stack">
              <label className="toggle-inline">
                <input
                  checked={draftSettings.browser.lightpanda.enabled}
                  onChange={event =>
                    updateLightpandaSettings({ enabled: event.target.checked })
                  }
                  type="checkbox"
                />
                <div className="flex flex-col">
                  <strong>启用 Lightpanda 读取层</strong>
                  <span className="muted">用于搜索资料、执行少量 JS、抽取正文；失败不会升级为系统浏览器。</span>
                </div>
              </label>
            </div>

            <div className="dashboard-list mt-4">
              <div className="dashboard-row gap-3">
                <strong className="shrink-0">启动实例</strong>
                <div className="ml-auto min-w-0 max-w-[32rem]">
                  <button
                    className="inline-flex min-w-0 max-w-full items-center gap-2 rounded-lg px-2 py-1 text-12px font-500 text-black/45 transition-colors hover:bg-black/5 hover:text-black/65 disabled:opacity-40"
                    disabled={isRefreshingLightpandaStatus}
                    onClick={() => void openLightpandaInstallDirectory()}
                    title={lightpandaInstanceLabel}
                    type="button"
                  >
                    <FolderOpen size={13} className="shrink-0" />
                    <span className="min-w-0 text-left leading-relaxed">{lightpandaInstanceDisplay}</span>
                  </button>
                </div>
              </div>
              <div className="dashboard-row">
                <strong>并发会话上限</strong>
                <span>{draftSettings.browser.lightpanda.maxConcurrency}</span>
              </div>
              <div className="dashboard-row">
                <strong>单次超时</strong>
                <span>{draftSettings.browser.lightpanda.timeoutSeconds} 秒</span>
              </div>
            </div>

            <div className="form-container mt-4">
              <div className="form-row">
                <label>并发会话上限</label>
                <input
                  min={1}
                  max={12}
                  onChange={event =>
                    updateLightpandaSettings({
                      maxConcurrency:
                        Number(event.target.value) ||
                        draftSettings.browser.lightpanda.maxConcurrency,
                    })
                  }
                  type="number"
                  value={draftSettings.browser.lightpanda.maxConcurrency}
                />
              </div>
              <div className="form-row">
                <label>单次超时（秒）</label>
                <input
                  min={3}
                  max={90}
                  onChange={event =>
                    updateLightpandaSettings({
                      timeoutSeconds:
                        Number(event.target.value) ||
                        draftSettings.browser.lightpanda.timeoutSeconds,
                    })
                  }
                  type="number"
                  value={draftSettings.browser.lightpanda.timeoutSeconds}
                />
              </div>
            </div>

            <div className="provider-note mt-3">
              <p>安装目录: `{auraHome?.browserDir || '正在初始化 Aura 数据目录…'}`。点击上面的启动实例会直接打开这个 `browser` 文件夹，把浏览器执行文件移动进去后返回应用即可自动识别并记录。</p>
              <p>支持直接放入 `Lightpanda.app`、`lightpanda.exe` 或 `lightpanda` 二进制；如果是压缩包，请先解压再移动进去。</p>
              <p>Lightpanda 不负责登录、验证码、表单和人工处理，这些任务会走系统浏览器路径。</p>
            </div>
          </section>

          <section className="dashboard-card">
            <div className="section-title">浏览器操作</div>
            <div className="toggle-stack">
              <label className="toggle-inline">
                <input
                  checked={draftSettings.browser.interactive.enabled}
                  onChange={event =>
                    updateInteractiveBrowserSettings({ enabled: event.target.checked })
                  }
                  type="checkbox"
                />
                <div className="flex flex-col">
                  <strong>允许系统浏览器处理显式网页操作</strong>
                  <span className="muted">仅在意图明确是“打开网页并继续操作”时使用系统默认浏览器。</span>
                </div>
              </label>

              <label className="toggle-inline">
                <input
                  checked={draftSettings.browser.interactive.allowComputerUse}
                  onChange={event =>
                    updateInteractiveBrowserSettings({
                      allowComputerUse: event.target.checked,
                    })
                  }
                  type="checkbox"
                />
                <div className="flex flex-col">
                  <strong>允许配合 `computer_*` 工具</strong>
                  <span className="muted">打开系统浏览器后，Agent 可以继续用桌面交互工具协助完成操作。</span>
                </div>
              </label>
            </div>

            <div className="provider-note mt-3">
              <p>这里不再维护托管浏览器、浏览器来源切换、登录态导入和自动接管。</p>
              <p>网页操作就是系统浏览器，资料获取就是 `web_* + Lightpanda`。</p>
            </div>
          </section>

          <section className="dashboard-card">
            <div className="section-title">Web Research</div>
            <div className="form-container">
              <label className="toggle-inline">
                <input
                  checked={draftSettings.web.research.enabled}
                  onChange={event =>
                    updateWebResearchSettings('enabled', event.target.checked)
                  }
                  type="checkbox"
                />
                <div className="flex flex-col">
                  <strong>启用 `web_research`</strong>
                  <span className="muted">适合资料搜集、横向对比和生成带引用结论。</span>
                </div>
              </label>

              <label className="toggle-inline">
                <input
                  checked={draftSettings.web.research.preferSearchContent}
                  onChange={event =>
                    updateWebResearchSettings('preferSearchContent', event.target.checked)
                  }
                  type="checkbox"
                />
                <div className="flex flex-col">
                  <strong>优先复用搜索摘要正文</strong>
                  <span className="muted">摘要够长时少发一次抓取请求。</span>
                </div>
              </label>

              <div className="form-row">
                <label>普通模式搜索结果数</label>
                <input
                  min={1}
                  max={10}
                  onChange={event =>
                    updateWebResearchSettings(
                      'defaultSearchLimit',
                      Number(event.target.value) ||
                      draftSettings.web.research.defaultSearchLimit,
                    )
                  }
                  type="number"
                  value={draftSettings.web.research.defaultSearchLimit}
                />
              </div>

              <div className="form-row">
                <label>普通模式抓取页数</label>
                <input
                  min={1}
                  max={6}
                  onChange={event =>
                    updateWebResearchSettings(
                      'defaultFetchLimit',
                      Number(event.target.value) ||
                      draftSettings.web.research.defaultFetchLimit,
                    )
                  }
                  type="number"
                  value={draftSettings.web.research.defaultFetchLimit}
                />
              </div>

              <div className="form-row">
                <label>普通模式单页正文上限</label>
                <input
                  min={500}
                  max={20000}
                  onChange={event =>
                    updateWebResearchSettings(
                      'defaultMaxChars',
                      Number(event.target.value) ||
                      draftSettings.web.research.defaultMaxChars,
                    )
                  }
                  type="number"
                  value={draftSettings.web.research.defaultMaxChars}
                />
              </div>

              <div className="form-row">
                <label>复用搜索正文的最小长度</label>
                <input
                  min={200}
                  max={8000}
                  onChange={event =>
                    updateWebResearchSettings(
                      'searchContentMinChars',
                      Number(event.target.value) ||
                      draftSettings.web.research.searchContentMinChars,
                    )
                  }
                  type="number"
                  value={draftSettings.web.research.searchContentMinChars}
                />
              </div>

              <div className="form-row">
                <label>深度研究搜索结果数</label>
                <input
                  min={2}
                  max={10}
                  onChange={event =>
                    updateWebResearchSettings(
                      'deepSearchLimit',
                      Number(event.target.value) ||
                      draftSettings.web.research.deepSearchLimit,
                    )
                  }
                  type="number"
                  value={draftSettings.web.research.deepSearchLimit}
                />
              </div>

              <div className="form-row">
                <label>深度研究抓取页数</label>
                <input
                  min={1}
                  max={6}
                  onChange={event =>
                    updateWebResearchSettings(
                      'deepFetchLimit',
                      Number(event.target.value) ||
                      draftSettings.web.research.deepFetchLimit,
                    )
                  }
                  type="number"
                  value={draftSettings.web.research.deepFetchLimit}
                />
              </div>

              <div className="form-row">
                <label>深度研究单页正文上限</label>
                <input
                  min={800}
                  max={20000}
                  onChange={event =>
                    updateWebResearchSettings(
                      'deepMaxChars',
                      Number(event.target.value) || draftSettings.web.research.deepMaxChars,
                    )
                  }
                  type="number"
                  value={draftSettings.web.research.deepMaxChars}
                />
              </div>
            </div>
          </section>

          <section className="dashboard-card">
            <div className="section-title">Web Search</div>
            <div className="form-container">
              <label className="toggle-inline">
                <input
                  checked={draftSettings.web.search.enabled}
                  onChange={event => updateWebSearchSettings('enabled', event.target.checked)}
                  type="checkbox"
                />
                <div className="flex flex-col">
                  <strong>启用 `web_search`</strong>
                  <span className="muted">负责候选来源发现和排序，`web_research` 会复用这里的 provider。</span>
                </div>
              </label>

              <div className="form-row">
                <label>搜索 Provider</label>
                <select
                  className="settings-select"
                  value={draftSettings.web.search.provider}
                  onChange={event =>
                    updateWebSearchSettings(
                      'provider',
                      event.target.value as AgentSettings['web']['search']['provider'],
                    )
                  }
                >
                  <option value="auto">Auto（Tavily → Brave → DuckDuckGo）</option>
                  <option value="tavily">Tavily</option>
                  <option value="brave">Brave</option>
                  <option value="duckduckgo">DuckDuckGo</option>
                </select>
              </div>

              <div className="form-row">
                <label>Tavily API Key</label>
                <input
                  className="monospace"
                  value={draftSettings.web.search.providers.tavilyApiKey}
                  onChange={event =>
                    updateWebSearchProviderSettings('tavilyApiKey', event.target.value)
                  }
                  placeholder="tvly-..."
                  type="password"
                />
              </div>

              <div className="form-row">
                <label>Brave API Key</label>
                <input
                  className="monospace"
                  value={draftSettings.web.search.providers.braveApiKey}
                  onChange={event =>
                    updateWebSearchProviderSettings('braveApiKey', event.target.value)
                  }
                  placeholder="BSA..."
                  type="password"
                />
              </div>

              <div className="form-row">
                <label>搜索超时（秒）</label>
                <input
                  min={3}
                  max={60}
                  onChange={event =>
                    updateWebSearchSettings(
                      'timeoutSeconds',
                      Number(event.target.value) || draftSettings.web.search.timeoutSeconds,
                    )
                  }
                  type="number"
                  value={draftSettings.web.search.timeoutSeconds}
                />
              </div>

              <div className="form-row">
                <label>缓存 TTL（分钟）</label>
                <input
                  min={0}
                  max={1440}
                  onChange={event =>
                    updateWebSearchSettings(
                      'cacheTtlMinutes',
                      Number(event.target.value) || draftSettings.web.search.cacheTtlMinutes,
                    )
                  }
                  type="number"
                  value={draftSettings.web.search.cacheTtlMinutes}
                />
              </div>

              <div className="form-row">
                <label>默认结果数</label>
                <input
                  min={1}
                  max={10}
                  onChange={event =>
                    updateWebSearchSettings(
                      'maxResults',
                      Number(event.target.value) || draftSettings.web.search.maxResults,
                    )
                  }
                  type="number"
                  value={draftSettings.web.search.maxResults}
                />
              </div>
            </div>
          </section>

          <section className="dashboard-card full-span">
            <div className="section-title">Web Fetch</div>
            <div className="form-container">
              <label className="toggle-inline">
                <input
                  checked={draftSettings.web.fetch.enabled}
                  onChange={event => updateWebFetchSettings('enabled', event.target.checked)}
                  type="checkbox"
                />
                <div className="flex flex-col">
                  <strong>启用 `web_fetch`</strong>
                  <span className="muted">用于 HTTP 拉取和正文抽取，和交互式浏览器分开维护。</span>
                </div>
              </label>

              <label className="toggle-inline">
                <input
                  checked={draftSettings.web.fetch.readability}
                  onChange={event => updateWebFetchSettings('readability', event.target.checked)}
                  type="checkbox"
                />
                <div className="flex flex-col">
                  <strong>优先正文抽取</strong>
                  <span className="muted">开启后优先走更适合文章正文的提取策略。</span>
                </div>
              </label>

              <label className="toggle-inline">
                <input
                  checked={draftSettings.web.fetch.providers.jinaEnabled}
                  onChange={event =>
                    updateWebFetchProviderSettings('jinaEnabled', event.target.checked)
                  }
                  type="checkbox"
                />
                <div className="flex flex-col">
                  <strong>启用 Jina Reader fallback</strong>
                  <span className="muted">本地提取不足时，允许交给第三方云端抓取。</span>
                </div>
              </label>

              <label className="toggle-inline">
                <input
                  checked={draftSettings.web.fetch.providers.jinaAllowAnonymous}
                  disabled={!draftSettings.web.fetch.providers.jinaEnabled}
                  onChange={event =>
                    updateWebFetchProviderSettings('jinaAllowAnonymous', event.target.checked)
                  }
                  type="checkbox"
                />
                <div className="flex flex-col">
                  <strong>允许匿名调用 Jina</strong>
                  <span className="muted">填写 API Key 后会自动优先带 Key 以提高限额和稳定性。</span>
                </div>
              </label>

              <div className="form-row">
                <label>Jina API Key</label>
                <input
                  className="monospace"
                  disabled={!draftSettings.web.fetch.providers.jinaEnabled}
                  value={draftSettings.web.fetch.providers.jinaApiKey}
                  onChange={event =>
                    updateWebFetchProviderSettings('jinaApiKey', event.target.value)
                  }
                  placeholder="jina_..."
                  type="password"
                />
              </div>

              <div className="form-row">
                <label>抓取超时（秒）</label>
                <input
                  min={3}
                  max={90}
                  onChange={event =>
                    updateWebFetchSettings(
                      'timeoutSeconds',
                      Number(event.target.value) || draftSettings.web.fetch.timeoutSeconds,
                    )
                  }
                  type="number"
                  value={draftSettings.web.fetch.timeoutSeconds}
                />
              </div>

              <div className="form-row">
                <label>最大返回字符数</label>
                <input
                  min={500}
                  max={100000}
                  onChange={event =>
                    updateWebFetchSettings(
                      'maxCharsCap',
                      Number(event.target.value) || draftSettings.web.fetch.maxCharsCap,
                    )
                  }
                  type="number"
                  value={draftSettings.web.fetch.maxCharsCap}
                />
              </div>

              <div className="form-row">
                <label>最大响应字节数</label>
                <input
                  min={32000}
                  max={10000000}
                  onChange={event =>
                    updateWebFetchSettings(
                      'maxResponseBytes',
                      Number(event.target.value) || draftSettings.web.fetch.maxResponseBytes,
                    )
                  }
                  type="number"
                  value={draftSettings.web.fetch.maxResponseBytes}
                />
              </div>

              <div className="form-row">
                <label>最大跳转次数</label>
                <input
                  min={0}
                  max={10}
                  onChange={event =>
                    updateWebFetchSettings(
                      'maxRedirects',
                      Number(event.target.value) || draftSettings.web.fetch.maxRedirects,
                    )
                  }
                  type="number"
                  value={draftSettings.web.fetch.maxRedirects}
                />
              </div>

              <div className="provider-note">
                <p>Jina Reader 是第三方服务。默认作为 `web_fetch` 的补充层，而不是浏览器兜底的替代说法。</p>
              </div>
            </div>
          </section>
        </div>
      </section>
    )
  }

  function renderMcp() {
    const allMcpEnabled =
      draftSettings.mcpServers.length > 0 &&
      draftSettings.mcpServers.every(server => server.enabled)

    return (
      <section className="section-shell settings-panel">
        <header className="section-header">
          <div>
            <div className="eyebrow">MCP Servers</div>
            <h2>MCP 服务器</h2>
          </div>
          <div className="header-actions">
            <button
              className="secondary-button"
              disabled={draftSettings.mcpServers.length === 0}
              onClick={() => setAllMcpEnabled(!allMcpEnabled)}
            >
              {allMcpEnabled ? '全部关闭' : '全部打开'}
            </button>
            <button
              className="secondary-button"
              onClick={() => void refreshMcpServers()}
            >
              <RefreshCw
                size={14}
                className={isRefreshingMcp ? 'spin-icon' : undefined}
              />
              刷新
            </button>
            <button
              className="secondary-button"
              onClick={() => void openAuraMcpFolder()}
            >
              <FolderOpen size={14} />
              打开文件夹
            </button>
            <button className="primary-button" onClick={() => void openMcpEditorWindow()}>
              新增 MCP
            </button>
          </div>
        </header>

        <div className="asset-card-list">
          {draftSettings.mcpServers.length > 0 ? (
            draftSettings.mcpServers.map(server => (
              <article key={server.id} className="asset-card asset-card-rich">
                {(() => {
                  const statusTone =
                    server.healthStatus === 'ok'
                      ? 'success'
                      : server.healthStatus === 'error'
                        ? 'error'
                        : 'idle'
                  const inspectResult = mcpInspectResults[server.id]
                  const statusLabel =
                    server.enabled && server.healthStatus === 'ok'
                      ? '已启用'
                      : server.healthStatus === 'ok'
                        ? '已验证'
                        : server.healthStatus === 'error'
                          ? '连接失败'
                          : '待验证'
                  const statusMessage =
                    server.healthStatus === 'ok'
                      ? server.healthMessage || `连接成功，发现 ${server.toolCount || 0} 个工具。`
                      : server.healthStatus === 'error'
                        ? server.healthMessage || '连接测试失败。'
                        : '该 MCP 还没有通过连接验证，验证通过后才能真正启用。'
                  const feedbackTone = inspectResult?.tone || statusTone
                  const feedbackMessage = inspectResult?.message || statusMessage
                  const feedbackTools = inspectResult?.tools || []

                  return (
                    <>
                      <div className="asset-card-head">
                        <div>
                          <strong>{server.name}</strong>
                          <p>{server.description || server.command || '尚未添加描述'}</p>
                        </div>
                        <label className="relative flex cursor-pointer items-center gap-2.5 truncate">
                          <input
                            checked={server.enabled}
                            type="checkbox"
                            className="peer sr-only"
                            onChange={event => void toggleMcpServerEnabled(server.id, event.target.checked)}
                          />
                          <div className="relative h-4.5 w-8 shrink-0 rounded-full bg-black/10 transition-all peer-checked:bg-green-500/80 after:absolute after:top-0.5 after:left-[2px] after:h-3.5 after:w-3.5 after:rounded-full after:bg-white after:shadow-sm after:transition-all after:content-[''] peer-checked:after:translate-x-3.5" />
                          <span className="text-12px font-600 text-black/40 truncate whitespace-nowrap">
                            {statusLabel}
                          </span>
                        </label>
                      </div>
                      <div className="asset-card-meta">
                        <span className="micro-pill">
                          {server.command ? `命令: ${server.command}` : '未配置启动命令'}
                        </span>
                        <span className="micro-pill">{server.args || '无参数'}</span>
                        {server.env.trim() !== '{}' ? (
                          <span className="micro-pill">已配置环境变量</span>
                        ) : null}
                        {server.lastCheckedAt ? (
                          <span className="micro-pill">{`最近验证: ${formatTimestamp(server.lastCheckedAt)}`}</span>
                        ) : null}
                      </div>
                      <div
                        className={`provider-feedback ${feedbackTone === 'success'
                          ? 'success'
                          : feedbackTone === 'error'
                            ? 'error'
                            : ''
                          }`}
                      >
                        <strong>{feedbackMessage}</strong>
                        {server.healthStatus === 'unknown' ? (
                          <div className="mt-1 text-12px opacity-80">
                            现在保存配置不会自动代表可用，测试通过后才会加入工具池。
                          </div>
                        ) : null}
                        {feedbackTools.length ? (
                          <div className="mcp-tool-chip-list">
                            {feedbackTools.map(tool => (
                              <div key={`${server.id}-${tool.name}`} className="mcp-tool-chip-group">
                                <span className="mcp-tool-chip">
                                  {tool.name}
                                </span>
                                <div className="mcp-tool-tooltip">
                                  {tool.description}
                                </div>
                              </div>
                            ))}
                          </div>
                        ) : null}
                      </div>
                      <div className="header-actions">
                        <button
                          className="secondary-button"
                          disabled={testingMcpServerId === server.id}
                          onClick={() => void testMcpServer(server.id, { persistResult: true })}
                        >
                          <RefreshCw
                            size={14}
                            className={testingMcpServerId === server.id ? 'spin-icon' : undefined}
                          />
                          测试连接
                        </button>
                        <button
                          className="secondary-button"
                          onClick={() => void openMcpEditorWindow(server.id)}
                        >
                          编辑
                        </button>
                        {!server.isDefault && (
                          <button
                            className="p-2 rounded-xl text-black/40 hover:text-red-500 hover:bg-red-50 transition-all ml-auto"
                            onClick={() => setMcpToDelete({ id: server.id, name: server.name })}
                            title="删除 MCP 配置"
                          >
                            <Trash2 size={16} />
                          </button>
                        )}
                      </div>
                    </>
                  )
                })()}
              </article>
            ))
          ) : (
            <article className="asset-card empty">
              <strong>还没有 MCP Server</strong>
              <p>新增一个 stdio MCP 服务后，Agent 就能把它的工具纳入工具池。</p>
            </article>
          )}
        </div>
      </section>
    )
  }

  function renderAssets(
    kind: 'skills' | 'plugins',
    items: Array<AuraAsset>,
    enabledIds: string[],
    onToggle: (id: string) => void,
  ) {
    const title = kind === 'skills' ? '技能' : '插件'
    const searchValue = assetSearch[kind]
    const visibleItems =
      kind === 'skills'
        ? items.filter(item => !builtinSkillIdSet.has(item.id))
        : items
    const toggleableItems =
      visibleItems.filter(item => item.supported)
    const allEnabled =
      toggleableItems.length > 0 &&
      toggleableItems.every(item => enabledIds.includes(item.id))
    const normalizedKeyword = searchValue.trim().toLowerCase()
    const filteredItems = visibleItems.filter(item =>
      !normalizedKeyword ||
      `${item.name} ${item.description} ${item.id} ${item.path || ''} ${item.entryPath || ''} ${item.supportMessage || ''}`
        .toLowerCase()
        .includes(normalizedKeyword),
    )
    const folderPath =
      kind === 'skills' ? auraHome?.skillsDir || '' : auraHome?.pluginsDir || ''
    const externalSkillDirs = normalizePathList(draftSettings.externalSkillDirs || [])
    const externalSkillPath = kind === 'skills' ? externalSkillDirs.join('、') : ''

    return (
      <section className="section-shell settings-panel">
        <header className="section-header asset-section-header">
          <div className="asset-section-copy">
            <div className="eyebrow">{title}</div>
            <h2>{title}</h2>
            {kind === 'skills' ? (
              <p className="muted mt-2">您可以自己安装 skills，或通过”绑定外部目录“将其他目录挂载到 skills 目录</p>
            ) : null}
          </div>
          <div className="header-actions asset-section-toolbar mb-12px">
            <span className="micro-pill">{visibleItems.length} 个可用</span>
            <button
              className="secondary-button"
              disabled={visibleItems.length === 0}
              onClick={() =>
                kind === 'skills'
                  ? setAllSkillsEnabled(!allEnabled)
                  : setAllPluginsEnabled(!allEnabled)
              }
            >
              {allEnabled ? '全部关闭' : '全部打开'}
            </button>
            <button
              className="secondary-button"
              onClick={() => void refreshAuraAssets(kind)}
            >
              <RefreshCw
                size={14}
                className={refreshingAssets === kind ? 'spin-icon' : undefined}
              />
              刷新
            </button>
            <button
              className="secondary-button"
              disabled={!folderPath}
              onClick={() => void openAuraAssetFolder(kind)}
            >
              <FolderOpen size={14} />
              打开文件夹
            </button>
            {kind === 'skills' ? (
              <button
                className="secondary-button"
                onClick={() => void bindExternalSkillDirectory()}
              >
                <FolderOpen size={14} />
                {externalSkillPath ? '换绑外部目录' : '绑定外部目录'}
              </button>
            ) : null}
          </div>
        </header>

        {kind === 'skills' && externalSkillPath ? (
          <div className="external-skill-path-row">
            <span>当前外部目录</span>
            <code title={externalSkillPath}>{externalSkillPath}</code>
          </div>
        ) : null}

        <div className="settings-search-bar">
          <Search size={16} />
          <input
            value={searchValue}
            onChange={event =>
              setAssetSearch(current => ({
                ...current,
                [kind]: event.target.value,
              }))
            }
            placeholder={`搜索${title}名称、描述或路径...`}
          />
        </div>

        <div className="asset-card-list">
          {filteredItems.length > 0 ? filteredItems.map(item => {
            const expanded = expandedAssetIds.has(item.id)
            const preview = item.path ? assetPreviewCache[item.path] : ''
            const isLoadingPreview = item.path === loadingPreviewPath
            const isEnabled = enabledIds.includes(item.id)
            const canToggle = item.supported

            return (
              <article key={item.id} className="asset-card asset-card-rich">
                <div className="asset-card-head">
                  <div>
                    <strong>{item.name}</strong>
                    <p>{item.description}</p>
                  </div>
                  <label className={`relative flex items-center gap-3 cursor-pointer ${canToggle ? '' : 'opacity-40 cursor-not-allowed'}`}>
                    <input
                      checked={isEnabled}
                      disabled={!canToggle}
                      onChange={() => onToggle(item.id)}
                      type="checkbox"
                      className="peer sr-only"
                    />
                    <div className="relative h-5 w-9 shrink-0 rounded-full bg-black/10 transition-all peer-checked:bg-[var(--bg-user-bubble)] after:absolute after:top-0.5 after:left-[2px] after:h-4 after:w-4 after:rounded-full after:bg-white after:shadow-sm after:transition-all after:content-[''] peer-checked:after:translate-x-4" />
                    <span className="text-13px font-700 text-black/60 peer-checked:text-black/80 transition-colors select-none whitespace-nowrap">
                      {canToggle
                        ? isEnabled
                          ? '启用中'
                          : '已关闭'
                        : '当前不兼容'}
                    </span>
                  </label>
                </div>
                <div className="asset-card-meta">
                  <span className="micro-pill">{item.id}</span>
                  <span className={`micro-pill ${item.supported ? 'pill-success' : 'pill-warning'}`}>
                    {item.supported ? '可用' : '仅发现'}
                  </span>
                  {kind === 'skills' && item.external ? (
                    <span className="micro-pill">外部目录</span>
                  ) : null}
                  {kind === 'skills' && item.external ? (
                    <span className="micro-pill">只读</span>
                  ) : null}
                  {item.path ? (
                    <span className="micro-pill mono-pill">{item.path}</span>
                  ) : null}
                  {item.entryPath && item.entryPath !== item.path ? (
                    <span className="micro-pill mono-pill">入口：{item.entryPath}</span>
                  ) : null}
                </div>
                {!item.supported && item.supportMessage ? (
                  <div className="asset-compat-note">{item.supportMessage}</div>
                ) : null}
                <div className="flex items-center justify-between">
                  <button
                    className="asset-preview-toggle"
                    onClick={() => void toggleAssetExpanded(item)}
                    type="button"
                  >
                    <span>{expanded ? '隐藏内容' : '查看内容'}</span>
                    {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                  </button>
                  {!item.readonly && (
                    <button
                      className="p-1.5 rounded-lg text-black/40 hover:text-red-500 hover:bg-red-50 transition-all"
                      onClick={() => setAssetToDelete({ id: item.id, name: item.name, kind, path: item.path })}
                      title={`删除${title}`}
                    >
                      <Trash2 size={14} />
                    </button>
                  )}
                </div>
                {expanded ? (
                  <div className="asset-preview-panel">
                    {isLoadingPreview ? (
                      <div className="muted">正在读取内容...</div>
                    ) : (
                      <pre>{preview || '暂无可读内容。'}</pre>
                    )}
                  </div>
                ) : null}
              </article>
            )
          }) : (
            <article className="asset-card empty">
              <strong>没有匹配的{title}</strong>
              <p>你可以尝试清空搜索词，或点击“刷新”重新扫描 Aura 目录。</p>
            </article>
          )}
        </div>
      </section>
    )
  }

  return (
    <div className="settings-window-shell">
      <SettingsView activeTab={activeTab} onSelectTab={setActiveTab}>
        {activeTab === 'general' ? renderGeneral() : null}
        {activeTab === 'providers' ? (
          <ProvidersView
            profiles={draftSettings.providerProfiles}
            activeProfileId={selectedProviderProfileId}
            providerStatus={providerStatus}
            isTesting={isTestingProvider}
            isFetchingModels={isFetchingModels}
            onSelectProfile={activateProviderProfile}
            onCreateProfile={createProfile}
            onDeleteProfile={deleteProfile}
            onProfileChange={updateProviderProfile}
            onAddModel={addProfileModel}
            onRemoveModel={removeProfileModel}
            onToggleModel={toggleProfileModel}
            onTestConnection={() => void handleTestConnection()}
            onFetchModels={() => void handleFetchModels()}
          />
        ) : null}
        {activeTab === 'browser' ? renderBrowser() : null}
        {activeTab === 'mcp' ? renderMcp() : null}
        {activeTab === 'skills'
          ? renderAssets(
            'skills',
            availableSkills,
            draftSettings.enabledSkillIds,
            toggleSkill,
          )
          : null}
        {activeTab === 'plugins'
          ? renderAssets(
            'plugins',
            availablePlugins,
            draftSettings.enabledPluginIds,
            togglePlugin,
          )
          : null}
      </SettingsView>

      <footer className="settings-window-footer">
        <div className="muted">
          {browserValidationError
            ? browserValidationError
            : saveState === 'saved'
              ? '所有更改已保存'
              : isDirty
                ? '有未保存更改'
                : '所有更改已同步'}
        </div>
        <div className="header-actions">
          <button className="secondary-button" onClick={() => void closeCurrentWindow()}>
            关闭
          </button>
          <button
            className="primary-button"
            disabled={!isDirty || Boolean(browserValidationError)}
            onClick={() => void saveDraftSettings()}
          >
            保存
          </button>
        </div>
      </footer>

      <ConfirmModal
        isOpen={!!assetToDelete}
        title={`删除${assetToDelete?.kind === 'skills' ? '技能' : '插件'}`}
        description={`确定要永久删除“${assetToDelete?.name}”吗？此操作不可撤销。`}
        confirmText="彻底删除"
        variant="danger"
        onConfirm={() => void handleDeleteAsset()}
        onCancel={() => setAssetToDelete(null)}
      />

      <ConfirmModal
        isOpen={!!mcpToDelete}
        title="删除 MCP 服务"
        description={`确定要移除“${mcpToDelete?.name}”配置吗？`}
        confirmText="确认删除"
        variant="danger"
        onConfirm={() => void handleDeleteMcp()}
        onCancel={() => setMcpToDelete(null)}
      />

      <ConfirmModal
        isOpen={isResetting}
        title="确认抹除所有数据和设置？"
        description="此操作将抹除所有本地数据（会话、配置、插件等）并恢复为默认设置。操作不可撤销。"
        confirmText="确认抹除"
        variant="danger"
        onConfirm={() => void handleFactoryReset()}
        onCancel={() => setIsResetting(false)}
      />
    </div>
  )
}
