import { useEffect, useMemo, useState } from 'react'
import { listen } from '@tauri-apps/api/event'
import { ask, open } from '@tauri-apps/plugin-dialog'
import { ChevronDown, ChevronUp, FolderOpen, RefreshCw, Search, Trash2 } from 'lucide-react'
import { builtinPlugins, builtinSkills } from './catalog'
import {
  BROWSER_INSTALL_PROGRESS_EVENT,
  cancelManagedBrowserInstall,
  clearAuraSiteCookies,
  detectBrowserRuntime,
  discoverChromeImportSources,
  getBrowserRuntimeSourceLabel,
  importChromeSiteCookies,
  installManagedBrowser,
  isBrowserRuntimeSourceAvailable,
  resetAuraBrowserProfile,
  resetAuraSiteSessions,
  resolveAuraBrowserProfilePath,
  uninstallManagedBrowser,
  validateCustomSearchTemplate,
} from './lib/browser'
import {
  inspectMcpServer,
  type McpInspectResult,
  validateMcpServerInput,
} from './lib/mcp'
import { fetchProviderModels, testProviderConnection } from './lib/provider'
import { ensureAuraHome, deleteAuraAsset, resetAuraHome, type AuraAsset, type AuraHomeState } from './lib/aura'
import {
  hydrateStorageFromAuraHome,
  loadSettings,
  saveSettingsAndAwaitPersistence,
} from './lib/storage'
import { openPathInDefaultApp, readTextFile } from './lib/workspace'
import { ConfirmModal } from './components/ConfirmModal'
import { broadcastSettingsUpdated, closeCurrentWindow, openMcpEditorWindow } from './lib/windows'
import type {
  AgentSettings,
  BrowserRuntimeSource,
  ManagedBrowserInstallProgress,
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

type ProviderStatusState = {
  tone: 'success' | 'error'
  message: string
}

const browserRuntimeOptions: Array<{
  id: BrowserRuntimeSource
  label: string
  description: string
}> = [
    {
      id: 'system-chrome',
      label: '系统 Chrome',
      description: '复用本机已安装的 Chrome，但会使用 Aura 自己的 Profile。',
    },
    {
      id: 'managed-chrome',
      label: 'Aura 托管浏览器',
      description: '支持一键安装和卸载，和系统浏览器隔离更彻底。',
    },
    {
      id: 'custom-executable',
      label: '自定义可执行文件',
      description: '使用你指定的独立浏览器程序，仍然搭配 Aura Profile 运行。',
    },
  ]

function formatTimestamp(value?: number) {
  if (!value) {
    return '尚未检测'
  }
  return new Date(value).toLocaleString()
}

function formatBytes(value?: number) {
  if (!value || value <= 0) {
    return '未知'
  }

  const units = ['B', 'KB', 'MB', 'GB']
  let size = value
  let unitIndex = 0

  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024
    unitIndex += 1
  }

  return `${size.toFixed(size >= 100 || unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`
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

function formatProgressPercent(value?: number) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return '进行中'
  }

  return `${Math.max(0, Math.min(100, Math.round(value * 100)))}%`
}

function getManagedBrowserStageLabel(stage?: ManagedBrowserInstallProgress['stage']) {
  switch (stage) {
    case 'preparing':
      return '准备环境'
    case 'resolving-download':
      return '获取版本'
    case 'downloading':
      return '下载安装包'
    case 'extracting':
      return '解压文件'
    case 'verifying':
      return '校验安装'
    case 'cancelled':
      return '已取消'
    case 'completed':
      return '安装完成'
    case 'failed':
      return '安装失败'
    default:
      return '等待开始'
  }
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
  const [providerStatus, setProviderStatus] = useState<ProviderStatusState | null>(null)
  const [browserStatus, setBrowserStatus] = useState<ProviderStatusState | null>(null)
  const [isTestingProvider, setIsTestingProvider] = useState(false)
  const [isFetchingModels, setIsFetchingModels] = useState(false)
  const [isRefreshingBrowserRuntime, setIsRefreshingBrowserRuntime] = useState(false)
  const [isInstallingManagedBrowser, setIsInstallingManagedBrowser] = useState(false)
  const [isUninstallingManagedBrowser, setIsUninstallingManagedBrowser] = useState(false)
  const [isCancellingManagedBrowserInstall, setIsCancellingManagedBrowserInstall] = useState(false)
  const [managedBrowserInstallProgress, setManagedBrowserInstallProgress] =
    useState<ManagedBrowserInstallProgress | null>(null)
  const [isDiscoveringChromeProfiles, setIsDiscoveringChromeProfiles] = useState(false)
  const [isImportingChromeSite, setIsImportingChromeSite] = useState(false)
  const [isBrowserAdvancedOpen, setIsBrowserAdvancedOpen] = useState(false)
  const [siteActionKey, setSiteActionKey] = useState('')
  const [profileActionKey, setProfileActionKey] = useState('')
  const [selectedChromeImportSourceId, setSelectedChromeImportSourceId] = useState('')
  const [chromeImportDomainInput, setChromeImportDomainInput] = useState('')
  const [availableSkills, setAvailableSkills] = useState<AuraAsset[]>(() =>
    builtinSkills.map(item => ({ ...item, path: '', entryPath: '', supported: true, supportMessage: '', readonly: true })),
  )
  const [availablePlugins, setAvailablePlugins] = useState<AuraAsset[]>(() =>
    builtinPlugins.map(item => ({ ...item, path: '', entryPath: '', supported: true, supportMessage: '', readonly: true })),
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

  const browserValidationError = useMemo(() => {
    if (
      draftSettings.browser.search.engine === 'custom' &&
      validateCustomSearchTemplate(draftSettings.browser.search.customTemplate || '')
    ) {
      return validateCustomSearchTemplate(draftSettings.browser.search.customTemplate || '')
    }

    if (
      draftSettings.browser.enabled &&
      draftSettings.browserRuntimeStatus &&
      !isBrowserRuntimeSourceAvailable(
        draftSettings.browserRuntimeStatus,
        draftSettings.browser.source,
      )
    ) {
      return `当前浏览器来源不可用：${getBrowserRuntimeSourceLabel(draftSettings.browser.source)}。请先重新检测环境，或切换到可用来源。`
    }

    return ''
  }, [draftSettings.browser, draftSettings.browserRuntimeStatus])

  useEffect(() => {
    let unlistenOpenTab: (() => void) | undefined
    let unlistenSettingsUpdated: (() => void) | undefined
    let unlistenBrowserInstallProgress: (() => void) | undefined

    void (async () => {
      try {
        const hydrated = await hydrateStorageFromAuraHome()
        setAuraHome(hydrated.aura)
        setSavedSettings(hydrated.settings)
        setDraftSettings(cloneSettings(hydrated.settings))
        setSelectedProviderProfileId(hydrated.settings.activeProviderProfileId)
        await refreshBrowserRuntimeStatus(hydrated.settings, { useAsBaseline: true }).catch(() => {
          // Keep startup resilient even if browser detection is unavailable.
        })
      } catch {
        // Fall back to cached settings if Aura initialization is unavailable.
      }

      await refreshAuraAssets().catch(() => {
        setAvailableSkills(
          builtinSkills.map(item => ({
            ...item,
            path: '',
            entryPath: '',
            supported: true,
            supportMessage: '',
            readonly: true,
          })),
        )
        setAvailablePlugins(
          builtinPlugins.map(item => ({
            ...item,
            path: '',
            entryPath: '',
            supported: true,
            supportMessage: '',
            readonly: true,
          })),
        )
      })

      // Dismiss splash after full hydration
      ;(window as unknown as { __dismissSplash?: () => void }).__dismissSplash?.()

      unlistenOpenTab = await listen<SettingsTab>('settings:open-tab', event => {
        setActiveTab(event.payload)
      })

      unlistenSettingsUpdated = await listen('settings:updated', () => {
        const latest = loadSettings()
        setSavedSettings(latest)
        setDraftSettings(cloneSettings(latest))
        setSelectedProviderProfileId(latest.activeProviderProfileId)
        void refreshBrowserRuntimeStatus(latest, { useAsBaseline: true }).catch(() => {
          // Ignore background browser detection refresh errors.
        })
      })

      unlistenBrowserInstallProgress = await listen<ManagedBrowserInstallProgress>(
        BROWSER_INSTALL_PROGRESS_EVENT,
        event => {
          setManagedBrowserInstallProgress(event.payload)
          if (
            event.payload.stage === 'completed' ||
            event.payload.stage === 'cancelled' ||
            event.payload.stage === 'failed'
          ) {
            setIsCancellingManagedBrowserInstall(false)
          }
        },
      )
    })()

    return () => {
      unlistenOpenTab?.()
      unlistenSettingsUpdated?.()
      unlistenBrowserInstallProgress?.()
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
    if (
      managedBrowserInstallProgress?.stage !== 'completed' &&
      managedBrowserInstallProgress?.stage !== 'cancelled'
    ) {
      return
    }

    const timer = window.setTimeout(() => setManagedBrowserInstallProgress(null), 1600)
    return () => window.clearTimeout(timer)
  }, [managedBrowserInstallProgress])

  useEffect(() => {
    if (
      selectedChromeImportSourceId &&
      draftSettings.chromeImportSources.some(source => source.id === selectedChromeImportSourceId)
    ) {
      return
    }

    setSelectedChromeImportSourceId(draftSettings.chromeImportSources[0]?.id || '')
  }, [draftSettings.chromeImportSources, selectedChromeImportSourceId])

  function handleSettingsChange<K extends keyof AgentSettings>(
    key: K,
    value: AgentSettings[K],
  ) {
    setDraftSettings(current => ({
      ...current,
      [key]: value,
    }))
    setSaveState('idle')
  }

  async function handleApprovalSettingChange<K extends keyof AgentSettings>(
    key: K,
    value: AgentSettings[K],
  ) {
    const nextSettings = {
      ...draftSettings,
      [key]: value,
    }
    setDraftSettings(nextSettings)
    setSavedSettings(cloneSettings(nextSettings))
    setSaveState('saved')
    await saveSettingsAndAwaitPersistence(nextSettings)
    await broadcastSettingsUpdated()
  }

  function updateBrowserSettings(patch: Partial<AgentSettings['browser']>) {
    setDraftSettings(current => ({
      ...current,
      browser: {
        ...current.browser,
        ...patch,
      },
    }))
    setSaveState('idle')
    setBrowserStatus(null)
  }

  function updateBrowserSearch<K extends keyof AgentSettings['browser']['search']>(
    key: K,
    value: AgentSettings['browser']['search'][K],
  ) {
    setDraftSettings(current => ({
      ...current,
      browser: {
        ...current.browser,
        search: {
          ...current.browser.search,
          [key]: value,
        },
      },
    }))
    setSaveState('idle')
    setBrowserStatus(null)
  }

  function updateBrowserBehavior<K extends keyof AgentSettings['browser']['behavior']>(
    key: K,
    value: AgentSettings['browser']['behavior'][K],
  ) {
    setDraftSettings(current => ({
      ...current,
      browser: {
        ...current.browser,
        behavior: {
          ...current.browser.behavior,
          [key]: value,
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

  async function refreshBrowserRuntimeStatus(
    settingsOverride?: AgentSettings,
    options?: { useAsBaseline?: boolean },
  ) {
    const targetSettings = settingsOverride || draftSettings
    setIsRefreshingBrowserRuntime(true)
    setBrowserStatus(null)

    try {
      const status = await detectBrowserRuntime({
        customExecutablePath: targetSettings.browser.executablePath,
        managedExecutablePath: targetSettings.browser.managedExecutablePath,
      })

      const nextSettings: AgentSettings = {
        ...targetSettings,
        browser: {
          ...targetSettings.browser,
          executablePath:
            status.customExecutableValid === true && status.customExecutablePath
              ? status.customExecutablePath
              : targetSettings.browser.executablePath,
          managedExecutablePath:
            status.managedChromePath || targetSettings.browser.managedExecutablePath,
        },
        browserRuntimeStatus: status,
      }

      setDraftSettings(cloneSettings(nextSettings))
      if (options?.useAsBaseline) {
        setSavedSettings(cloneSettings(nextSettings))
      } else {
        setSaveState('idle')
      }
      setBrowserStatus({
        tone: 'success',
        message: '浏览器运行环境检测已完成。',
      })
    } catch (caught) {
      setBrowserStatus({
        tone: 'error',
        message: caught instanceof Error ? caught.message : '浏览器环境检测失败。',
      })
    } finally {
      setIsRefreshingBrowserRuntime(false)
    }
  }

  async function chooseCustomBrowserExecutable() {
    const selected = await open({
      directory: false,
      multiple: false,
      title: '选择浏览器可执行文件',
    })

    if (typeof selected !== 'string') {
      return
    }

    setIsRefreshingBrowserRuntime(true)
    setBrowserStatus(null)

    try {
      const status = await detectBrowserRuntime({
        customExecutablePath: selected,
        managedExecutablePath: draftSettings.browser.managedExecutablePath,
      })

      if (status.customExecutableValid !== true || !status.customExecutablePath) {
        setDraftSettings(current => ({
          ...current,
          browserRuntimeStatus: status,
        }))
        setBrowserStatus({
          tone: 'error',
          message: '所选路径不是可用的浏览器可执行文件，请重新选择。',
        })
        setSaveState('idle')
        return
      }

      setDraftSettings(current => ({
        ...current,
        browser: {
          ...current.browser,
          source: 'custom-executable',
          executablePath: status.customExecutablePath,
        },
        browserRuntimeStatus: status,
      }))
      setBrowserStatus({
        tone: 'success',
        message: '已验证并保存自定义浏览器路径。',
      })
      setSaveState('idle')
    } catch (caught) {
      setBrowserStatus({
        tone: 'error',
        message: caught instanceof Error ? caught.message : '自定义浏览器校验失败。',
      })
    } finally {
      setIsRefreshingBrowserRuntime(false)
    }
  }

  async function openAuraBrowserProfileFolder() {
    const nextAura = auraHome || (await ensureAuraHome())
    setAuraHome(nextAura)
    await openPathInDefaultApp(resolveAuraBrowserProfilePath(nextAura, draftSettings.browser))
  }

  async function handleResetAuraBrowserProfile() {
    const confirmed = await ask(
      '确认清空 Aura 浏览器 Profile？这会删除 Aura 浏览器中的 Cookie、本地存储和缓存，并清空待应用的导入 Cookie 队列。',
      {
        title: '清空 Aura 浏览器 Profile',
        kind: 'warning',
      },
    )

    if (!confirmed) {
      return
    }

    setProfileActionKey('clear-profile')
    setBrowserStatus(null)

    try {
      const result = await resetAuraBrowserProfile({
        settings: draftSettings.browser,
      })
      setDraftSettings(current => ({
        ...current,
        importedChromeSites: [],
      }))
      setBrowserStatus({
        tone: 'success',
        message: result.clearedProfile
          ? `Aura 浏览器 Profile 已清空，待应用 Cookie 队列里还清掉了 ${result.pendingRemovedCount} 条记录。`
          : `Aura 浏览器 Profile 原本就是空的，待应用 Cookie 队列里清掉了 ${result.pendingRemovedCount} 条记录。`,
      })
      setSaveState('idle')
    } catch (caught) {
      setBrowserStatus({
        tone: 'error',
        message: caught instanceof Error ? caught.message : '清空 Aura 浏览器 Profile 失败。',
      })
    } finally {
      setProfileActionKey('')
    }
  }

  async function handleResetAuraSiteSessions() {
    const confirmed = await ask(
      '确认重置全部站点会话？这会清空 Aura 浏览器中所有站点 Cookie，并删除待应用的导入 Cookie 队列，但会保留 Profile 目录本身。',
      {
        title: '重置全部站点会话',
        kind: 'warning',
      },
    )

    if (!confirmed) {
      return
    }

    setProfileActionKey('reset-site-sessions')
    setBrowserStatus(null)

    try {
      const result = await resetAuraSiteSessions({
        settings: draftSettings.browser,
      })
      setDraftSettings(current => ({
        ...current,
        importedChromeSites: current.importedChromeSites.map(site => ({
          ...site,
          cookieCount: 0,
        })),
      }))
      setBrowserStatus({
        tone: 'success',
        message: `已重置 Aura 浏览器里的全部站点会话，移除了 ${result.removedCount} 条 Cookie，待应用队列里还清掉了 ${result.pendingRemovedCount} 条。`,
      })
      setSaveState('idle')
    } catch (caught) {
      setBrowserStatus({
        tone: 'error',
        message: caught instanceof Error ? caught.message : '重置 Aura 站点会话失败。',
      })
    } finally {
      setProfileActionKey('')
    }
  }

  async function handleInstallManagedBrowser() {
    setIsInstallingManagedBrowser(true)
    setIsCancellingManagedBrowserInstall(false)
    setBrowserStatus(null)
    setManagedBrowserInstallProgress({
      stage: 'preparing',
      message: '正在准备 Aura 托管浏览器安装环境…',
      progress: 0.01,
    })

    try {
      const status = await installManagedBrowser()
      setDraftSettings(current => ({
        ...current,
        browser: {
          ...current.browser,
          managedExecutablePath: status.managedChromePath || current.browser.managedExecutablePath,
        },
        browserRuntimeStatus: status,
      }))
      setManagedBrowserInstallProgress({
        stage: 'completed',
        message: 'Aura 托管浏览器安装完成。',
        progress: 1,
      })
      setBrowserStatus({
        tone: 'success',
        message: 'Aura 托管浏览器安装完成。',
      })
      setSaveState('idle')
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : '托管浏览器安装失败。'
      const wasCancelled = message.includes('已取消')

      setManagedBrowserInstallProgress({
        stage: wasCancelled ? 'cancelled' : 'failed',
        message,
      })
      setBrowserStatus({
        tone: wasCancelled ? 'success' : 'error',
        message,
      })
    } finally {
      setIsInstallingManagedBrowser(false)
      setIsCancellingManagedBrowserInstall(false)
    }
  }

  async function handleCancelManagedBrowserInstall() {
    if (!isInstallingManagedBrowser || isCancellingManagedBrowserInstall) {
      return
    }

    setIsCancellingManagedBrowserInstall(true)
    setManagedBrowserInstallProgress(current =>
      current
        ? {
          ...current,
          message: '正在取消 Aura 托管浏览器安装…',
        }
        : current,
    )

    try {
      await cancelManagedBrowserInstall()
    } catch (caught) {
      setIsCancellingManagedBrowserInstall(false)
      setBrowserStatus({
        tone: 'error',
        message: caught instanceof Error ? caught.message : '取消托管浏览器安装失败。',
      })
    }
  }

  async function handleUninstallManagedBrowser() {
    setIsUninstallingManagedBrowser(true)
    setBrowserStatus(null)

    try {
      const status = await uninstallManagedBrowser()
      setDraftSettings(current => {
        let nextSource = current.browser.source
        let nextEnabled = current.browser.enabled
        if (nextSource === 'managed-chrome') {
          if (status.systemChromeDetected) {
            nextSource = 'system-chrome'
          } else if (status.customExecutableValid) {
            nextSource = 'custom-executable'
          } else {
            nextEnabled = false
          }
        }

        return {
          ...current,
          browser: {
            ...current.browser,
            enabled: nextEnabled,
            source: nextSource,
            managedExecutablePath: undefined,
          },
          browserRuntimeStatus: status,
        }
      })
      setManagedBrowserInstallProgress(null)
      setBrowserStatus({
        tone: 'success',
        message: 'Aura 托管浏览器已卸载。',
      })
      setSaveState('idle')
    } catch (caught) {
      setBrowserStatus({
        tone: 'error',
        message: caught instanceof Error ? caught.message : '托管浏览器卸载失败。',
      })
    } finally {
      setIsUninstallingManagedBrowser(false)
    }
  }

  async function handleDiscoverChromeProfiles() {
    setIsDiscoveringChromeProfiles(true)
    setBrowserStatus(null)

    try {
      const sources = await discoverChromeImportSources()
      setDraftSettings(current => ({
        ...current,
        chromeImportSources: sources,
      }))
      setSelectedChromeImportSourceId(sources[0]?.id || '')
      setBrowserStatus({
        tone: 'success',
        message:
          sources.length > 0
            ? `已发现 ${sources.length} 个 Chrome Profile。`
            : '没有发现可导入的 Chrome Profile。',
      })
      setSaveState('idle')
    } catch (caught) {
      setBrowserStatus({
        tone: 'error',
        message: caught instanceof Error ? caught.message : '发现 Chrome Profile 失败。',
      })
    } finally {
      setIsDiscoveringChromeProfiles(false)
    }
  }

  async function handleImportChromeSiteCookies(options?: {
    domain?: string
    sourceProfileId?: string
    actionKey?: string
  }) {
    const normalizedDomain = (options?.domain || chromeImportDomainInput)
      .trim()
      .replace(/^https?:\/\//i, '')
      .replace(/\/.*$/, '')
      .trim()
    const source = draftSettings.chromeImportSources.find(
      entry => entry.id === (options?.sourceProfileId || selectedChromeImportSourceId),
    )

    if (!source) {
      setBrowserStatus({
        tone: 'error',
        message: '请先选择一个 Chrome Profile。',
      })
      return
    }

    if (!normalizedDomain) {
      setBrowserStatus({
        tone: 'error',
        message: '请输入要导入的站点域名。',
      })
      return
    }

    setIsImportingChromeSite(true)
    setSiteActionKey(options?.actionKey || '')
    setBrowserStatus(null)

    try {
      const result = await importChromeSiteCookies({
        sourceProfilePath: source.profilePath,
        domain: normalizedDomain,
      })

      setDraftSettings(current => {
        const existing = current.importedChromeSites.find(site => site.domain === result.domain)
        const nextImportedSites = existing
          ? current.importedChromeSites.map(site =>
            site.domain === result.domain
              ? {
                ...site,
                sourceProfileId: source.id,
                importedAt: result.importedAt,
                lastRefreshedAt: result.importedAt,
                cookieCount: result.cookieCount,
              }
              : site,
          )
          : [
            {
              id: `imported-site-${Math.random().toString(36).slice(2, 8)}`,
              domain: result.domain,
              sourceProfileId: source.id,
              importedAt: result.importedAt,
              cookieCount: result.cookieCount,
            },
            ...current.importedChromeSites,
          ]

        return {
          ...current,
          importedChromeSites: nextImportedSites,
        }
      })
      setBrowserStatus({
        tone: 'success',
        message: `已导入 ${result.domain} 的 ${result.cookieCount} 条 Cookie，Aura 浏览器下次使用时会自动应用。`,
      })
      setSaveState('idle')
    } catch (caught) {
      setBrowserStatus({
        tone: 'error',
        message: caught instanceof Error ? caught.message : 'Chrome 站点登录态导入失败。',
      })
    } finally {
      setIsImportingChromeSite(false)
      setSiteActionKey('')
    }
  }

  async function handleClearAuraSiteCookies(domain: string) {
    setSiteActionKey(`clear:${domain}`)
    setBrowserStatus(null)

    try {
      const result = await clearAuraSiteCookies({
        domain,
        settings: draftSettings.browser,
      })
      setDraftSettings(current => ({
        ...current,
        importedChromeSites: current.importedChromeSites.map(site =>
          site.domain === domain
            ? {
              ...site,
              cookieCount: 0,
            }
            : site,
        ),
      }))
      setBrowserStatus({
        tone: 'success',
        message: `已从 Aura Profile 中清理 ${domain} 的站点状态，移除了 ${result.removedCount} 条已写入 Cookie，待应用队列里还清掉了 ${result.pendingRemovedCount} 条。`,
      })
      setSaveState('idle')
    } catch (caught) {
      setBrowserStatus({
        tone: 'error',
        message: caught instanceof Error ? caught.message : '清理 Aura 站点状态失败。',
      })
    } finally {
      setSiteActionKey('')
    }
  }

  function handleDeleteImportedChromeSiteRecord(domain: string) {
    setDraftSettings(current => ({
      ...current,
      importedChromeSites: current.importedChromeSites.filter(site => site.domain !== domain),
    }))
    setBrowserStatus({
      tone: 'success',
      message: `已删除 ${domain} 的导入记录。Aura Profile 中的站点状态如果还需要清理，请再执行一次“清理 Aura 状态”。`,
    })
    setSaveState('idle')
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
        message: caught instanceof Error ? caught.message : 'Provider 测试失败。',
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
      const existingById = new Map(selectedProfile.models.map(model => [model.id, model]))
      updateProviderProfile(
        selectedProfile.id,
        'models',
        result.models.map(model => {
          const existing = existingById.get(model.id)
          return {
            ...model,
            enabled: existing?.enabled ?? false,
            contextWindowTokens: model.contextWindowTokens || existing?.contextWindowTokens,
            maxOutputTokens: model.maxOutputTokens || existing?.maxOutputTokens,
          }
        }),
      )
      setProviderStatus({
        tone: 'success',
        message: result.message,
      })
    } catch (caught) {
      setProviderStatus({
        tone: 'error',
        message: caught instanceof Error ? caught.message : '模型拉取失败。',
      })
    } finally {
      setIsFetchingModels(false)
    }
  }

  function renderGeneral() {
    const isLongTaskMode = draftSettings.executionMode === 'long-task'

    return (
      <section className="section-shell settings-panel">
        <div className="settings-grid">
          <section className="dashboard-card">
            <div className="section-title">默认工作目录</div>
            <p className="muted">
              {draftSettings.cwd.trim()
                ? draftSettings.cwd
                : '新会话没有手动选择目录时，会使用这里作为默认根目录。'}
            </p>
            <div className="header-actions">
              <button className="secondary-button" onClick={() => void chooseDefaultWorkspace()}>
                选择目录
              </button>
            </div>
          </section>

          <section className="dashboard-card">
            <div className="section-title">网络连接代理 (Network Proxy)</div>
            <p className="muted">
              配置全局 HTTP/HTTPS 代理。当你需要抓取海外网站或访问专业提供商时，建议填入你的本机梯子代理地址。例如：<code>http://127.0.0.1:7890</code>
            </p>
            <input
              type="text"
              placeholder="留空则直连网络或跟随环境变量"
              value={draftSettings.networkProxy || ''}
              className="settings-text-input mt-3"
              onChange={event => handleSettingsChange('networkProxy', event.target.value)}
              style={{ width: '100%', maxWidth: '400px' }}
            />
          </section>

          <section className="dashboard-card">
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
          </section>

          <section className="dashboard-card">
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

          <section className="dashboard-card">
            <div className="section-title">Agent 架构</div>
            <div className="settings-mode-stack">
              <label className="toggle-inline">
                <input
                  checked={draftSettings.agentArchitectureMode === 'route-first'}
                  type="radio"
                  onChange={() => handleSettingsChange('agentArchitectureMode', 'route-first')}
                />
                <div className="flex flex-col">
                  <strong>标准模式</strong>
                  <span className="muted">
                    适合绝大多数任务。会先判断你当前问题需要哪些能力，再按需挂载最小工具集，直接开始解决问题，速度更快也更稳。
                  </span>
                </div>
              </label>
              <label className="toggle-inline disabled">
                <input
                  disabled
                  checked={draftSettings.agentArchitectureMode === 'orchestrated'}
                  type="radio"
                  readOnly
                />
                <div className="flex flex-col">
                  <strong>编排模式</strong>
                  <span className="muted">
                    面向更复杂的多阶段任务，例如先规划、再执行、再验收的长链路工作。该模式仍在开发中，当前版本暂未开放切换。
                  </span>
                </div>
              </label>
            </div>
          </section>

          <section className="dashboard-card">
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
          </section>

          <section className="dashboard-card">
            <div className="section-title">记忆模式</div>
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
            <div className="section-title">失败恢复</div>
            <div className="toggle-stack">
              <label className="toggle-inline">
                <input
                  checked={draftSettings.enableProviderFailureRecovery}
                  onChange={event =>
                    handleSettingsChange('enableProviderFailureRecovery', event.target.checked)
                  }
                  type="checkbox"
                />
                <div className="flex flex-col">
                  <strong>模型失败时自动恢复</strong>
                  <span className="muted">
                    当 Provider 在工具调用后中断、超时或断流时，自动重试并尽量基于已完成步骤补出最终回答。
                  </span>
                </div>
              </label>
            </div>
            <label className="settings-number-field mt-3">
              <span>自动恢复重试次数</span>
              <input
                type="number"
                min={1}
                max={5}
                step={1}
                value={draftSettings.providerFailureRecoveryMaxAttempts}
                disabled={!draftSettings.enableProviderFailureRecovery}
                onChange={event =>
                  handleSettingsChange(
                    'providerFailureRecoveryMaxAttempts',
                    Math.max(1, Math.min(5, Number(event.target.value) || 1)),
                  )
                }
              />
            </label>
            <div className="provider-note mt-3">
              <p>开启后，Aura 会优先把瞬时模型故障当成可恢复问题处理，而不是立刻结束整轮任务。</p>
              <p>次数越高越激进，通常能多扛住几次断流或超时，但也会增加等待时间和 token 成本。</p>
            </div>
          </section>

          <section className="dashboard-card">
            <div className="section-title">审批策略</div>
            <div className="flex flex-col gap-3">
              {[
                { key: 'autoApproveShell', label: 'Shell 默认自动允许' },
                { key: 'autoApproveFileWrite', label: '文件写入默认自动允许' },
                { key: 'autoApproveComputerUse', label: 'Computer Use 默认自动允许' },
              ].map(item => (
                <label key={item.key} className="relative flex items-center gap-3 cursor-pointer group">
                  <input
                    checked={draftSettings[item.key as keyof AgentSettings] as boolean}
                    onChange={event =>
                      void handleApprovalSettingChange(
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
              这组开关会立即生效并同步到主窗口。注意: `Shell` 只覆盖命令执行，文件写入和桌面交互仍按各自开关审批。
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
    const runtimeStatus = draftSettings.browserRuntimeStatus
    const profilePath = resolveAuraBrowserProfilePath(auraHome, draftSettings.browser)
    const chromeImportSourcesById = new Map(
      draftSettings.chromeImportSources.map(source => [source.id, source] as const),
    )
    const latestImportedSite = draftSettings.importedChromeSites[0]
    const installProgressValue = managedBrowserInstallProgress?.progress
    const showManagedBrowserProgress = Boolean(managedBrowserInstallProgress)
    const managedBrowserStage =
      managedBrowserInstallProgress?.stage ||
      (runtimeStatus?.managedChromeInstalled ? 'completed' : undefined)
    const isManagedBrowserFailed = managedBrowserInstallProgress?.stage === 'failed'
    const isAdvancedVisible = isBrowserAdvancedOpen || Boolean(browserValidationError)
    const managedBrowserPrimaryText = runtimeStatus?.managedChromeInstalled
      ? runtimeStatus.managedChromePath || '已安装'
      : managedBrowserInstallProgress?.message || '未安装'
    const managedBrowserSecondaryText =
      managedBrowserInstallProgress?.downloadedBytes && managedBrowserInstallProgress?.totalBytes
        ? `${formatBytes(managedBrowserInstallProgress.downloadedBytes)} / ${formatBytes(managedBrowserInstallProgress.totalBytes)}`
        : runtimeStatus?.managedChromeInstalled
          ? formatBytes(runtimeStatus.managedChromeSizeBytes)
          : '建议安装后作为默认运行时，和系统 Chrome 隔离。'

    return (
      <section className="section-shell settings-panel">
        <header className="section-header">
          <div>
            <div className="eyebrow">Browser Runtime</div>
            <h2>浏览器</h2>
            <p className="muted mt-2">
              默认网页任务已经统一走 Aura 自己维护的浏览器运行时与 Profile。现在把常用设置放前面，安装、登录态和高级偏好按用途分组，阅读成本会低很多。
            </p>
          </div>
          <div className="header-actions">
            <button
              className="secondary-button"
              disabled={isRefreshingBrowserRuntime}
              onClick={() => void refreshBrowserRuntimeStatus()}
            >
              <RefreshCw
                size={14}
                className={isRefreshingBrowserRuntime ? 'spin-icon' : undefined}
              />
              重新检测环境
            </button>
            <button
              className="secondary-button"
              disabled={isRefreshingBrowserRuntime}
              onClick={() => void chooseCustomBrowserExecutable()}
            >
              <FolderOpen size={14} />
              选择自定义浏览器
            </button>
          </div>
        </header>

        {browserStatus ? (
          <div className={`provider-feedback ${browserStatus.tone === 'success' ? 'success' : 'error'}`}>
            <strong>{browserStatus.message}</strong>
          </div>
        ) : null}

        {browserValidationError ? (
          <div className="provider-feedback error">
            <strong>{browserValidationError}</strong>
          </div>
        ) : null}

        <div className="settings-grid">
          <section className="dashboard-card full-span browser-overview-card">
            <div className="section-title">浏览器总览</div>
            <div className="browser-summary-grid">
              <div className="browser-summary-item">
                <span className="browser-summary-label">当前来源</span>
                <strong>{getBrowserRuntimeSourceLabel(draftSettings.browser.source)}</strong>
                <span className="muted">
                  {draftSettings.browser.enabled ? 'Aura 浏览器运行时已启用' : 'Aura 浏览器运行时已关闭'}
                </span>
              </div>
              <div className="browser-summary-item">
                <span className="browser-summary-label">Aura 托管浏览器</span>
                <strong>{runtimeStatus?.managedChromeInstalled ? '已安装' : '未安装'}</strong>
                <span className="muted">{managedBrowserSecondaryText}</span>
              </div>
              <div className="browser-summary-item">
                <span className="browser-summary-label">Profile</span>
                <strong>{draftSettings.browser.persistAuraProfile ? '持久化保存' : '按需使用'}</strong>
                <span
                  className="muted truncate w-full"
                  title={profilePath || '等待 Aura 目录初始化'}
                >
                  {profilePath || '等待 Aura 目录初始化'}
                </span>
              </div>
              <div className="browser-summary-item">
                <span className="browser-summary-label">人工接管</span>
                <strong>
                  {draftSettings.browser.takeoverMode === 'ask'
                    ? '先询问再接管'
                    : '阻塞时自动打开可见浏览器'}
                </strong>
                <span className="muted">
                  {draftSettings.browser.headlessByDefault ? '默认先无头执行' : '默认直接可见执行'}
                </span>
              </div>
            </div>

            {showManagedBrowserProgress ? (
              <div
                className={`browser-install-panel ${isManagedBrowserFailed ? 'error' : runtimeStatus?.managedChromeInstalled ? 'success' : ''}`}
              >
                <div className="browser-install-panel-head">
                  <div>
                    <div className="browser-install-stage">
                      {getManagedBrowserStageLabel(managedBrowserStage)}
                    </div>
                    <strong>{managedBrowserPrimaryText}</strong>
                  </div>
                  <span className="browser-install-percent">
                    {runtimeStatus?.managedChromeInstalled && !managedBrowserInstallProgress
                      ? '已就绪'
                      : formatProgressPercent(installProgressValue)}
                  </span>
                </div>
                <div className="browser-progress-track">
                  <div
                    className={`browser-progress-fill ${isManagedBrowserFailed ? 'error' : ''}`}
                    style={{
                      width: `${Math.max(
                        0,
                        Math.min(
                          100,
                          Math.round(
                            ((runtimeStatus?.managedChromeInstalled && !managedBrowserInstallProgress
                              ? 1
                              : installProgressValue || 0) *
                              100),
                          ),
                        ),
                      )
                        }%`,
                    }}
                  />
                </div>
                <div className="browser-install-meta">
                  <span>{managedBrowserInstallProgress?.message || managedBrowserPrimaryText}</span>
                  <span>{managedBrowserSecondaryText}</span>
                </div>
              </div>
            ) : null}
          </section>

          <section className="dashboard-card">
            <div className="section-title">基础运行环境</div>
            <div className="toggle-stack">
              <label className="toggle-inline">
                <input
                  checked={draftSettings.browser.enabled}
                  onChange={event => updateBrowserSettings({ enabled: event.target.checked })}
                  type="checkbox"
                />
                <div className="flex flex-col">
                  <strong>启用 Aura 浏览器运行时</strong>
                  <span className="muted">默认网页工具优先走 Aura 浏览器，而不是系统前台 Chrome。</span>
                </div>
              </label>
            </div>

            <div className="dashboard-list mt-4">
              <div className="dashboard-row">
                <strong>默认浏览器来源</strong>
                <span>{getBrowserRuntimeSourceLabel(draftSettings.browser.source)}</span>
              </div>
              <div className="dashboard-row">
                <strong>最近检测时间</strong>
                <span>{formatTimestamp(runtimeStatus?.lastCheckedAt)}</span>
              </div>
              <div className="dashboard-row">
                <strong>自定义浏览器路径</strong>
                <span>
                  {runtimeStatus?.customExecutablePath
                    ? runtimeStatus.customExecutableValid
                      ? runtimeStatus.customExecutablePath
                      : `${runtimeStatus.customExecutablePath}（当前无效）`
                    : '未选择'}
                </span>
              </div>
            </div>

            <div className="settings-mode-stack">
              {browserRuntimeOptions.map(option => {
                const isAvailable = isBrowserRuntimeSourceAvailable(runtimeStatus, option.id)
                return (
                  <label
                    key={option.id}
                    className={`toggle-inline ${!isAvailable ? 'disabled' : ''}`}
                  >
                    <input
                      checked={draftSettings.browser.source === option.id}
                      disabled={!isAvailable}
                      onChange={() => updateBrowserSettings({ source: option.id })}
                      type="radio"
                    />
                    <div className="flex flex-col">
                      <strong>{option.label}</strong>
                      <span className="muted">{option.description}</span>
                    </div>
                  </label>
                )
              })}
            </div>
          </section>

          <section className="dashboard-card">
            <div className="section-title">安装与环境检测</div>
            <div className="dashboard-list">
              <div className="dashboard-row">
                <strong>系统 Chrome</strong>
                <span>
                  {runtimeStatus?.systemChromeDetected
                    ? runtimeStatus.systemChromePath || '已检测到'
                    : '未检测到'}
                </span>
              </div>
              <div className="dashboard-row">
                <strong>Aura 托管浏览器</strong>
                <span>
                  {runtimeStatus?.managedChromeInstalled
                    ? `${runtimeStatus.managedChromePath || '已安装'} · ${formatBytes(runtimeStatus.managedChromeSizeBytes)}`
                    : '未安装'}
                </span>
              </div>
            </div>

            <div className="provider-note mt-3">
              <p>推荐优先安装 Aura 托管浏览器。它会放在 Aura 自己的运行时目录里，和系统浏览器隔离，环境也更稳定。</p>
            </div>
            <div className="header-actions mt-4">
              <button
                className="secondary-button"
                disabled={
                  runtimeStatus?.managedChromeInstalled ||
                  isInstallingManagedBrowser ||
                  isUninstallingManagedBrowser
                }
                onClick={() => void handleInstallManagedBrowser()}
              >
                <RefreshCw
                  size={14}
                  className={isInstallingManagedBrowser ? 'spin-icon' : undefined}
                />
                {runtimeStatus?.managedChromeInstalled
                  ? 'Aura 托管浏览器已安装'
                  : isInstallingManagedBrowser
                    ? '正在安装...'
                    : '安装 Aura 托管浏览器'}
              </button>
              {isInstallingManagedBrowser ? (
                <button
                  className="secondary-button"
                  disabled={isCancellingManagedBrowserInstall}
                  onClick={() => void handleCancelManagedBrowserInstall()}
                >
                  <Trash2 size={14} />
                  {isCancellingManagedBrowserInstall ? '正在取消...' : '取消安装'}
                </button>
              ) : null}
              <button
                className="secondary-button"
                disabled={
                  !runtimeStatus?.managedChromeInstalled ||
                  isInstallingManagedBrowser ||
                  isUninstallingManagedBrowser
                }
                onClick={() => void handleUninstallManagedBrowser()}
              >
                <Trash2 size={14} />
                {isUninstallingManagedBrowser ? '正在卸载...' : '卸载托管浏览器'}
              </button>
            </div>
          </section>

          <section className="dashboard-card">
            <div className="section-title">Profile 与会话</div>
            <div className="toggle-stack">
              <label className="toggle-inline">
                <input
                  checked={draftSettings.browser.persistAuraProfile}
                  onChange={event => updateBrowserSettings({ persistAuraProfile: event.target.checked })}
                  type="checkbox"
                />
                <div className="flex flex-col">
                  <strong>持久化 Aura Profile</strong>
                  <span className="muted">登录态和站点会话会保存在 Aura 自己的浏览器目录中。</span>
                </div>
              </label>
            </div>

            <div className="dashboard-list mt-4">
              <div className="dashboard-row overflow-hidden">
                <strong className="shrink-0">Profile 路径</strong>
                <span
                  className="truncate flex-1 text-right"
                  title={profilePath || '等待 Aura 目录初始化'}
                >
                  {profilePath || '等待 Aura 目录初始化'}
                </span>
              </div>
              <div className="dashboard-row">
                <strong>当前会话模式</strong>
                <span>{draftSettings.browser.headlessByDefault ? '默认无头执行' : '默认可见窗口'}</span>
              </div>
            </div>

            <div className="header-actions mt-4">
              <button
                className="secondary-button"
                disabled={!profilePath || Boolean(profileActionKey)}
                onClick={() => void openAuraBrowserProfileFolder()}
              >
                <FolderOpen size={14} />
                打开 Profile 文件夹
              </button>
              <button
                className="secondary-button"
                disabled={!profilePath || Boolean(profileActionKey)}
                onClick={() => void handleResetAuraSiteSessions()}
              >
                <RefreshCw
                  size={14}
                  className={profileActionKey === 'reset-site-sessions' ? 'spin-icon' : undefined}
                />
                重置全部站点会话
              </button>
              <button
                className="secondary-button"
                disabled={!profilePath || Boolean(profileActionKey)}
                onClick={() => void handleResetAuraBrowserProfile()}
              >
                <Trash2
                  size={14}
                  className={profileActionKey === 'clear-profile' ? 'spin-icon' : undefined}
                />
                清空 Aura 浏览器 Profile
              </button>
            </div>
            <div className="provider-note mt-3">
              <p>“重置全部站点会话”会清空全部 Cookie，但保留 Profile；“清空 Aura 浏览器 Profile”会直接重建整个目录。</p>
            </div>
          </section>

          <section className="dashboard-card">
            <div className="section-title">人工接管与可见浏览器</div>
            <div className="toggle-stack">
              <label className="toggle-inline">
                <input
                  checked={draftSettings.browser.takeoverMode === 'ask'}
                  onChange={() => updateBrowserSettings({ takeoverMode: 'ask' })}
                  type="radio"
                />
                <div className="flex flex-col">
                  <strong>遇到阻塞时先询问</strong>
                  <span className="muted">更稳妥，适合希望保留更多手动确认的场景。</span>
                </div>
              </label>
              <label className="toggle-inline">
                <input
                  checked={draftSettings.browser.takeoverMode === 'auto-visible-on-blocker'}
                  onChange={() => updateBrowserSettings({ takeoverMode: 'auto-visible-on-blocker' })}
                  type="radio"
                />
                <div className="flex flex-col">
                  <strong>遇到阻塞时自动打开可见浏览器</strong>
                  <span className="muted">适合登录、验证码、2FA 之类需要尽快人工接管的流程。</span>
                </div>
              </label>
              <label className="toggle-inline">
                <input
                  checked={draftSettings.browser.headlessByDefault}
                  onChange={event => updateBrowserSettings({ headlessByDefault: event.target.checked })}
                  type="checkbox"
                />
                <div className="flex flex-col">
                  <strong>默认无头执行</strong>
                  <span className="muted">关闭后，会优先以可见窗口启动 Aura 浏览器。</span>
                </div>
              </label>
            </div>

            <div className="provider-note mt-3">
              <p>登录、验证码或授权页出现阻塞时，Aura 会通过接管卡片提醒你切到可见浏览器处理。</p>
            </div>
          </section>

          <section className="dashboard-card full-span">
            <div className="section-title">站点登录态导入</div>
            <div className="browser-summary-grid compact">
              <div className="browser-summary-item">
                <span className="browser-summary-label">已发现导入源</span>
                <strong>{draftSettings.chromeImportSources.length} 个</strong>
                <span className="muted">扫描本机 Chrome Profile 后可选择来源。</span>
              </div>
              <div className="browser-summary-item">
                <span className="browser-summary-label">最近一次导入</span>
                <strong>{latestImportedSite ? latestImportedSite.domain : '暂无'}</strong>
                <span className="muted">
                  {latestImportedSite ? formatTimestamp(latestImportedSite.importedAt) : '还没有导入任何站点'}
                </span>
              </div>
            </div>

            <div className="provider-note mt-4">
              <p>这里只会导入所选站点的 Cookie / Session，不会导入密码、书签、扩展或完整浏览历史。</p>
              <p>导入完成后，Aura 会把这些 Cookie 写入自己的待应用队列，在下次浏览器会话中自动加载。</p>
            </div>
            <div className="header-actions mt-4">
              <button
                className="secondary-button"
                disabled={isDiscoveringChromeProfiles}
                onClick={() => void handleDiscoverChromeProfiles()}
              >
                <RefreshCw
                  size={14}
                  className={isDiscoveringChromeProfiles ? 'spin-icon' : undefined}
                />
                {isDiscoveringChromeProfiles ? '正在扫描...' : '扫描本机 Chrome Profile'}
              </button>
            </div>
            <div className="form-container mt-4">
              <div className="form-row">
                <label>来源 Profile</label>
                <select
                  className="settings-select"
                  value={selectedChromeImportSourceId}
                  onChange={event => setSelectedChromeImportSourceId(event.target.value)}
                  disabled={draftSettings.chromeImportSources.length === 0}
                >
                  {draftSettings.chromeImportSources.length === 0 ? (
                    <option value="">请先扫描本机 Chrome</option>
                  ) : null}
                  {draftSettings.chromeImportSources.map(source => (
                    <option key={source.id} value={source.id}>
                      {source.profileName}
                    </option>
                  ))}
                </select>
              </div>
              <div className="form-row">
                <label>站点域名</label>
                <input
                  value={chromeImportDomainInput}
                  onChange={event => setChromeImportDomainInput(event.target.value)}
                  placeholder="例如 github.com / x.com / notion.so"
                  type="text"
                />
              </div>
            </div>
            <div className="header-actions mt-4">
              <button
                className="secondary-button"
                disabled={
                  draftSettings.chromeImportSources.length === 0 ||
                  !chromeImportDomainInput.trim() ||
                  isImportingChromeSite
                }
                onClick={() => void handleImportChromeSiteCookies()}
              >
                <RefreshCw
                  size={14}
                  className={isImportingChromeSite ? 'spin-icon' : undefined}
                />
                {isImportingChromeSite ? '正在导入...' : '导入站点登录态'}
              </button>
            </div>
          </section>

          <section className="dashboard-card full-span">
            <div className="section-title">已导入站点管理</div>
            {draftSettings.importedChromeSites.length > 0 ? (
              <div className="dashboard-list">
                {draftSettings.importedChromeSites.map(site => (
                  <div key={site.id} className="dashboard-row">
                    <div className="flex flex-col gap-1">
                      <strong>{site.domain}</strong>
                      <span>
                        来源 Profile:{' '}
                        {chromeImportSourcesById.get(site.sourceProfileId)?.profileName || site.sourceProfileId}
                      </span>
                      <span>首次导入: {formatTimestamp(site.importedAt)}</span>
                      <span>
                        最近刷新: {formatTimestamp(site.lastRefreshedAt || site.importedAt)} · {site.cookieCount} cookies
                      </span>
                    </div>
                    <div className="header-actions">
                      <button
                        className="secondary-button"
                        disabled={isImportingChromeSite || Boolean(siteActionKey)}
                        onClick={() =>
                          void handleImportChromeSiteCookies({
                            domain: site.domain,
                            sourceProfileId: site.sourceProfileId,
                            actionKey: `refresh:${site.domain}`,
                          })
                        }
                      >
                        <RefreshCw
                          size={14}
                          className={
                            isImportingChromeSite && siteActionKey === `refresh:${site.domain}`
                              ? 'spin-icon'
                              : undefined
                          }
                        />
                        刷新导入
                      </button>
                      <button
                        className="secondary-button"
                        disabled={Boolean(siteActionKey)}
                        onClick={() => void handleClearAuraSiteCookies(site.domain)}
                      >
                        <Trash2
                          size={14}
                          className={siteActionKey === `clear:${site.domain}` ? 'spin-icon' : undefined}
                        />
                        清理 Aura 状态
                      </button>
                      <button
                        className="secondary-button"
                        disabled={Boolean(siteActionKey)}
                        onClick={() => handleDeleteImportedChromeSiteRecord(site.domain)}
                      >
                        删除记录
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="muted">
                还没有导入任何站点。建议先扫描本机 Chrome Profile，再按站点导入登录态。
              </p>
            )}
          </section>

          <section className="dashboard-card full-span">
            <div className="section-header">
              <div>
                <div className="section-title">高级偏好</div>
                <p className="muted">把不常改的搜索、浏览器行为和备用模式收在这里，默认先不打扰。</p>
              </div>
              <button
                className="secondary-button"
                onClick={() => setIsBrowserAdvancedOpen(current => !current)}
              >
                {isAdvancedVisible ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                {isAdvancedVisible ? '收起高级偏好' : '展开高级偏好'}
              </button>
            </div>

            {isAdvancedVisible ? (
              <div className="settings-grid browser-advanced-grid mt-4">
                <section className="dashboard-card nested">
                  <div className="section-title">搜索设置</div>
                  <div className="form-container">
                    <div className="form-row">
                      <label>搜索引擎</label>
                      <select
                        className="settings-select"
                        value={draftSettings.browser.search.engine}
                        onChange={event => updateBrowserSearch('engine', event.target.value as AgentSettings['browser']['search']['engine'])}
                      >
                        <option value="google">Google</option>
                        <option value="bing">Bing</option>
                        <option value="duckduckgo">DuckDuckGo</option>
                        <option value="baidu">百度</option>
                        <option value="custom">自定义</option>
                      </select>
                    </div>

                    {draftSettings.browser.search.engine === 'custom' ? (
                      <div className="form-row top-align">
                        <label>搜索模板</label>
                        <div>
                          <input
                            className="monospace"
                            value={draftSettings.browser.search.customTemplate || ''}
                            onChange={event => updateBrowserSearch('customTemplate', event.target.value)}
                            placeholder="https://example.com/search?q={query}"
                            type="text"
                          />
                          <p className="muted mt-2">
                            模板必须包含 <code>{'{query}'}</code>，并以 `http://` 或 `https://` 开头。
                          </p>
                        </div>
                      </div>
                    ) : null}

                    <div className="form-row">
                      <label>搜索区域</label>
                      <input
                        value={draftSettings.browser.search.region || ''}
                        onChange={event => updateBrowserSearch('region', event.target.value)}
                        placeholder="auto / us / cn"
                        type="text"
                      />
                    </div>
                    <div className="form-row">
                      <label>搜索语言</label>
                      <input
                        value={draftSettings.browser.search.language || ''}
                        onChange={event => updateBrowserSearch('language', event.target.value)}
                        placeholder="auto / en / zh-CN"
                        type="text"
                      />
                    </div>
                    <div className="form-row">
                      <label>安全搜索</label>
                      <select
                        className="settings-select"
                        value={draftSettings.browser.search.safeSearch || 'moderate'}
                        onChange={event => updateBrowserSearch('safeSearch', event.target.value as AgentSettings['browser']['search']['safeSearch'])}
                      >
                        <option value="off">关闭</option>
                        <option value="moderate">适中</option>
                        <option value="strict">严格</option>
                      </select>
                    </div>
                  </div>
                </section>

                <section className="dashboard-card nested">
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
                        <span className="muted">把搜索、候选筛选和正文证据收集整合成一次调用，适合最新信息、文档和多来源调研。</span>
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
                        <strong>优先复用搜索结果正文</strong>
                        <span className="muted">当 Tavily / 其他 provider 已经返回足够长的原文时，优先直接用它，减少重复抓取和等待。</span>
                      </div>
                    </label>

                    <label className="toggle-inline">
                      <input
                        checked={draftSettings.web.research.allowBrowserFallback}
                        onChange={event =>
                          updateWebResearchSettings('allowBrowserFallback', event.target.checked)
                        }
                        type="checkbox"
                      />
                      <div className="flex flex-col">
                        <strong>允许最终降级到浏览器研究</strong>
                        <span className="muted">仅在 `web_*` 结果不足、被风控拦截，或工具明确建议浏览器兜底时，才允许升级到 `browser_search` / `browser_open`。</span>
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
                            Number(event.target.value) ||
                              draftSettings.web.research.deepMaxChars,
                          )
                        }
                        type="number"
                        value={draftSettings.web.research.deepMaxChars}
                      />
                    </div>

                    <label className="toggle-inline">
                      <input
                        checked={draftSettings.web.search.enabled}
                        onChange={event => updateWebSearchSettings('enabled', event.target.checked)}
                        type="checkbox"
                      />
                      <div className="flex flex-col">
                        <strong>启用 `web_search`</strong>
                        <span className="muted">用于候选来源发现和结构化排序；`web_research` 会复用这里的 provider 配置。</span>
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

                    <div className="provider-note">
                      <p>`web_search` 和 `web_research` 共用这里的搜索 provider 配置；浏览器搜索页仍由上方的 `browser.search` 控制。</p>
                    </div>
                  </div>
                </section>

                <section className="dashboard-card nested">
                  <div className="section-title">浏览器行为</div>
                  <div className="form-container">
                    <div className="form-row">
                      <label>请求语言</label>
                      <input
                        value={draftSettings.browser.behavior.acceptLanguage || ''}
                        onChange={event => updateBrowserBehavior('acceptLanguage', event.target.value)}
                        placeholder="auto / zh-CN,zh;q=0.9"
                        type="text"
                      />
                    </div>
                    <div className="form-row">
                      <label>时区</label>
                      <input
                        value={draftSettings.browser.behavior.timezone || ''}
                        onChange={event => updateBrowserBehavior('timezone', event.target.value)}
                        placeholder="system / Asia/Shanghai"
                        type="text"
                      />
                    </div>
                    <div className="form-row">
                      <label>地区 Locale</label>
                      <input
                        value={draftSettings.browser.behavior.locale || ''}
                        onChange={event => updateBrowserBehavior('locale', event.target.value)}
                        placeholder="system / zh-CN"
                        type="text"
                      />
                    </div>
                    <div className="form-row">
                      <label>配色方案</label>
                      <select
                        className="settings-select"
                        value={draftSettings.browser.behavior.colorScheme || 'system'}
                        onChange={event => updateBrowserBehavior('colorScheme', event.target.value as AgentSettings['browser']['behavior']['colorScheme'])}
                      >
                        <option value="system">跟随系统</option>
                        <option value="light">浅色</option>
                        <option value="dark">深色</option>
                      </select>
                    </div>
                    <div className="form-row">
                      <label>User-Agent 策略</label>
                      <select
                        className="settings-select"
                        value={draftSettings.browser.behavior.userAgentMode || 'default'}
                        onChange={event => updateBrowserBehavior('userAgentMode', event.target.value as AgentSettings['browser']['behavior']['userAgentMode'])}
                      >
                        <option value="default">默认</option>
                        <option value="desktop">优先桌面站</option>
                      </select>
                    </div>
                  </div>
                </section>

                <section className="dashboard-card nested">
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
                        <span className="muted">用于 HTTP 拉取和正文抽取，和浏览器自动化分开维护。</span>
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
                        <span className="muted">开启后，`web_fetch` 会优先走更适合文章正文的抽取策略。</span>
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
                        <span className="muted">默认开启；仅在本地提取明显不足时，才把页面交给第三方云端抓取。</span>
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
                        <span className="muted">默认开启；如果填写了 API Key，请求会自动优先带 Key 以提高限额和稳定性。</span>
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
                      <p>Jina Reader 是第三方服务。默认作为 `web_fetch` 的 fallback 启用；若填写了 Jina API Key，运行时会自动优先使用你的 Key。</p>
                    </div>
                  </div>
                </section>

                <section className="dashboard-card nested">
                  <div className="section-title">系统 Chrome 备用模式</div>
                  <div className="toggle-stack">
                    <label className="toggle-inline">
                      <input
                        checked={draftSettings.enableChromeAutomation}
                        onChange={event => handleSettingsChange('enableChromeAutomation', event.target.checked)}
                        type="checkbox"
                      />
                      <div className="flex flex-col">
                        <strong>允许系统前台 Chrome 自动化</strong>
                        <span className="muted">仅在运行时不可用，或你明确要求直接操作系统 Chrome 时使用。</span>
                      </div>
                    </label>
                    <label className={`toggle-inline ${!draftSettings.enableChromeAutomation ? 'disabled' : ''}`}>
                      <input
                        checked={draftSettings.browser.allowChromeAutomationFallback}
                        disabled={!draftSettings.enableChromeAutomation}
                        onChange={event =>
                          updateBrowserSettings({ allowChromeAutomationFallback: event.target.checked })
                        }
                        type="checkbox"
                      />
                      <div className="flex flex-col">
                        <strong>运行时不可用时允许自动降级</strong>
                        <span className="muted">只在 Aura 浏览器启动失败或来源不可用时，才允许回退到系统 Chrome。</span>
                      </div>
                    </label>
                    <label className={`toggle-inline ${!draftSettings.enableChromeAutomation ? 'disabled' : ''}`}>
                      <input
                        checked={draftSettings.autoApproveChromeAutomation}
                        disabled={!draftSettings.enableChromeAutomation}
                        onChange={event =>
                          void handleApprovalSettingChange(
                            'autoApproveChromeAutomation',
                            event.target.checked,
                          )
                        }
                        type="checkbox"
                      />
                      <div className="flex flex-col">
                        <strong>Chrome 自动化默认自动允许</strong>
                        <span className="muted">仅影响 `chrome_*` 备用工具的审批，不影响 Aura 浏览器运行时。</span>
                      </div>
                    </label>
                  </div>
                  <div className="provider-note mt-4">
                    <p>风险提示：启用后，Agent 可能切换到你的前台 Chrome 窗口并打断当前桌面操作。</p>
                  </div>
                </section>
              </div>
            ) : null}
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
                          {server.command ? `命令: ${server.command}` : '未配置安装命令'}
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

    return (
      <section className="section-shell settings-panel">
        <header className="section-header">
          <div>
            <div className="eyebrow">{title}</div>
            <h2>{title}</h2>
            {kind === 'skills' ? (
              <p className="muted mt-2">内置核心 skills 始终开启，这里只展示可管理的用户 skills。</p>
            ) : null}
          </div>
          <div className="header-actions">
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
          </div>
        </header>

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
