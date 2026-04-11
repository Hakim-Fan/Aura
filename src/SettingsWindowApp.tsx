import { useEffect, useMemo, useState } from 'react'
import { listen } from '@tauri-apps/api/event'
import { ask, open } from '@tauri-apps/plugin-dialog'
import { ChevronDown, ChevronUp, FolderOpen, RefreshCw, Search, Trash2 } from 'lucide-react'
import { builtinPlugins, builtinSkills } from './catalog'
import {
  detectBrowserRuntime,
  getBrowserRuntimeSourceLabel,
  isBrowserRuntimeSourceAvailable,
  resolveAuraBrowserProfilePath,
  validateCustomSearchTemplate,
} from './lib/browser'
import { inspectMcpServer, type McpInspectResult } from './lib/mcp'
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
    description: '后续可一键安装和卸载，和系统浏览器隔离更彻底。',
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
    setDraftSettings(current => ({
      ...current,
      mcpServers: current.mcpServers.map(server => ({
        ...server,
        enabled,
      })),
    }))
    setSaveState('idle')
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

    setDraftSettings(current => ({
      ...current,
      mcpServers: current.mcpServers.filter(s => s.id !== mcpToDelete.id),
    }))
    setMcpToDelete(null)
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

  async function testMcpServer(serverId: string) {
    const server = draftSettings.mcpServers.find(entry => entry.id === serverId)
    if (!server) {
      return
    }

    setTestingMcpServerId(serverId)
    try {
      const result = await inspectMcpServer(server)
      setMcpInspectResults(current => ({
        ...current,
        [serverId]: {
          tone: 'success',
          message: result.message,
          tools: result.tools,
        },
      }))
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : 'MCP 连接测试失败。'
      setMcpInspectResults(current => ({
        ...current,
        [serverId]: {
          tone: 'error',
          message,
          tools: [],
        },
      }))
    } finally {
      setTestingMcpServerId('')
    }
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
      updateProviderProfile(
        selectedProfile.id,
        'models',
        result.models.map(model => ({
          id: model,
          enabled:
            selectedProfile.models.find(existing => existing.id === model)?.enabled ?? false,
        })),
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
            <div className="section-title">审批策略</div>
            <div className="flex flex-col gap-3">
              {[
                { key: 'autoApproveShell', label: 'Shell 默认自动允许' },
                { key: 'autoApproveFileWrite', label: '文件写入默认自动允许' },
                { key: 'autoApproveComputerUse', label: 'Computer Use 默认自动允许' },
                { key: 'autoApproveChromeAutomation', label: 'Chrome 自动化默认自动允许' },
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
              这组开关会立即生效并同步到主窗口。注意: `Shell` 只覆盖命令执行，文件写入、桌面交互和 Chrome 自动化仍按各自开关审批。
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

    return (
      <section className="section-shell settings-panel">
        <header className="section-header">
          <div>
            <div className="eyebrow">Browser Runtime</div>
            <h2>浏览器</h2>
            <p className="muted mt-2">
              默认网页任务将逐步切到 Aura 自己维护的浏览器运行时与 Profile。这里先完成运行环境、偏好和接管策略配置。
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
          <section className="dashboard-card">
            <div className="section-title">浏览器运行时</div>
            <div className="toggle-stack">
              <label className="toggle-inline">
                <input
                  checked={draftSettings.browser.enabled}
                  onChange={event => updateBrowserSettings({ enabled: event.target.checked })}
                  type="checkbox"
                />
                <div className="flex flex-col">
                  <strong>启用 Aura 浏览器运行时</strong>
                  <span className="muted">后续网页工具默认会优先走独立浏览器，而不是前台 Chrome。</span>
                </div>
              </label>
            </div>

            <div className="dashboard-list mt-4">
              <div className="dashboard-row">
                <strong>当前来源</strong>
                <span>{getBrowserRuntimeSourceLabel(draftSettings.browser.source)}</span>
              </div>
              <div className="dashboard-row">
                <strong>默认执行模式</strong>
                <span>{draftSettings.browser.headlessByDefault ? '无头执行' : '可见窗口'}</span>
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

            {draftSettings.browser.executablePath ? (
              <div className="provider-note mt-4">
                <p>自定义路径: {draftSettings.browser.executablePath}</p>
              </div>
            ) : null}
          </section>

          <section className="dashboard-card">
            <div className="section-title">浏览器安装与环境检测</div>
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
              <div className="dashboard-row">
                <strong>自定义路径</strong>
                <span>
                  {runtimeStatus?.customExecutablePath
                    ? runtimeStatus.customExecutableValid
                      ? runtimeStatus.customExecutablePath
                      : `${runtimeStatus.customExecutablePath}（无效）`
                    : '未选择'}
                </span>
              </div>
              <div className="dashboard-row">
                <strong>最近检测时间</strong>
                <span>{formatTimestamp(runtimeStatus?.lastCheckedAt)}</span>
              </div>
            </div>

            <div className="provider-note mt-3">
              <p>托管浏览器安装/卸载还没接入，这里目前只展示真实检测结果，不再放不可点击的假按钮。</p>
            </div>
          </section>

          <section className="dashboard-card">
            <div className="section-title">搜索偏好</div>
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
                  <label>模板</label>
                  <div>
                    <input
                      className="monospace"
                      value={draftSettings.browser.search.customTemplate || ''}
                      onChange={event => updateBrowserSearch('customTemplate', event.target.value)}
                      placeholder="https://example.com/search?q={query}"
                      type="text"
                    />
                    <p className="muted mt-2">模板必须包含 <code>{'{query}'}</code>，并以 http/https 开头。</p>
                  </div>
                </div>
              ) : null}

              <div className="form-row">
                <label>Region</label>
                <input
                  value={draftSettings.browser.search.region || ''}
                  onChange={event => updateBrowserSearch('region', event.target.value)}
                  placeholder="auto / us / cn"
                  type="text"
                />
              </div>

              <div className="form-row">
                <label>Language</label>
                <input
                  value={draftSettings.browser.search.language || ''}
                  onChange={event => updateBrowserSearch('language', event.target.value)}
                  placeholder="auto / en / zh-CN"
                  type="text"
                />
              </div>

              <div className="form-row">
                <label>SafeSearch</label>
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

          <section className="dashboard-card">
            <div className="section-title">浏览器行为偏好</div>
            <div className="form-container">
              <div className="form-row">
                <label>Accept-Language</label>
                <input
                  value={draftSettings.browser.behavior.acceptLanguage || ''}
                  onChange={event => updateBrowserBehavior('acceptLanguage', event.target.value)}
                  placeholder="auto / zh-CN,zh;q=0.9"
                  type="text"
                />
              </div>
              <div className="form-row">
                <label>Timezone</label>
                <input
                  value={draftSettings.browser.behavior.timezone || ''}
                  onChange={event => updateBrowserBehavior('timezone', event.target.value)}
                  placeholder="system / Asia/Shanghai"
                  type="text"
                />
              </div>
              <div className="form-row">
                <label>Locale</label>
                <input
                  value={draftSettings.browser.behavior.locale || ''}
                  onChange={event => updateBrowserBehavior('locale', event.target.value)}
                  placeholder="system / zh-CN"
                  type="text"
                />
              </div>
              <div className="form-row">
                <label>Color Scheme</label>
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
                <label>User-Agent</label>
                <select
                  className="settings-select"
                  value={draftSettings.browser.behavior.userAgentMode || 'default'}
                  onChange={event => updateBrowserBehavior('userAgentMode', event.target.value as AgentSettings['browser']['behavior']['userAgentMode'])}
                >
                  <option value="default">默认</option>
                  <option value="desktop">Desktop 优先</option>
                </select>
              </div>
            </div>
          </section>

          <section className="dashboard-card">
            <div className="section-title">Aura 浏览器 Profile</div>
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
              <div className="dashboard-row">
                <strong>Profile 路径</strong>
                <span>{profilePath || '等待 Aura 目录初始化'}</span>
              </div>
              <div className="dashboard-row">
                <strong>当前会话状态</strong>
                <span>{draftSettings.browser.headlessByDefault ? '默认无头执行' : '默认可见窗口'}</span>
              </div>
            </div>

            <div className="header-actions mt-4">
              <button
                className="secondary-button"
                disabled={!profilePath}
                onClick={() => void openAuraBrowserProfileFolder()}
              >
                <FolderOpen size={14} />
                打开 Profile 文件夹
              </button>
            </div>
            <div className="provider-note mt-3">
              <p>清空 Profile 和重置站点会话会等浏览器运行时稳定后再接入，避免现在提供误导性的空操作。</p>
            </div>
          </section>

          <section className="dashboard-card">
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
                  <span className="muted">仅在浏览器运行时不可用，或你明确要求直接操作系统 Chrome 时使用。</span>
                </div>
              </label>
            </div>
            <div className="provider-note mt-4">
              <p>风险提示：启用后，Agent 可能切换到你的前台 Chrome 窗口并打断当前桌面操作。</p>
            </div>
          </section>

          <section className="dashboard-card">
            <div className="section-title">Chrome 登录缓存导入</div>
            <div className="dashboard-list">
              <div className="dashboard-row">
                <strong>已发现导入源</strong>
                <span>{draftSettings.chromeImportSources.length} 个</span>
              </div>
              <div className="dashboard-row">
                <strong>最近一次导入</strong>
                <span>
                  {draftSettings.importedChromeSites[0]
                    ? formatTimestamp(draftSettings.importedChromeSites[0].importedAt)
                    : '暂无'}
                </span>
              </div>
            </div>
            <div className="provider-note mt-4">
              <p>这里只会导入所选站点的 Cookie / Session，不会导入密码、书签、扩展或完整浏览历史。</p>
            </div>
            <div className="provider-note mt-3">
              <p>Chrome Profile 发现和站点级登录态导入还未开始实现，这里暂时只呈现持久化结构和真实数据列表。</p>
            </div>
          </section>

          <section className="dashboard-card">
            <div className="section-title">已导入站点管理</div>
            {draftSettings.importedChromeSites.length > 0 ? (
              <div className="dashboard-list">
                {draftSettings.importedChromeSites.map(site => (
                  <div key={site.id} className="dashboard-row">
                    <strong>{site.domain}</strong>
                    <span>
                      {site.cookieCount} cookies · {formatTimestamp(site.lastRefreshedAt || site.importedAt)}
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="muted">还没有导入任何站点。后续会支持刷新导入、删除记录和清理 Aura Profile 中的站点会话。</p>
            )}
          </section>

          <section className="dashboard-card">
            <div className="section-title">用户接管 / 可见浏览器</div>
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

            <div className="dashboard-list mt-4">
              <div className="dashboard-row">
                <strong>当前接管策略</strong>
                <span>{draftSettings.browser.takeoverMode === 'ask' ? '先询问' : '自动打开可见浏览器'}</span>
              </div>
              <div className="dashboard-row">
                <strong>状态占位</strong>
                <span>{runtimeStatus ? '浏览器空闲 / 检测已就绪' : '等待首次检测'}</span>
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
                <div className="asset-card-head">
                  <div>
                    <strong>{server.name}</strong>
                    <p>{server.description || server.command || '尚未添加描述'}</p>
                  </div>
                  <label className="relative flex cursor-pointer items-center gap-2.5 truncate">
                    <input
                      checked={server.enabled}
                      disabled
                      type="checkbox"
                      className="peer sr-only"
                    />
                    <div className="relative h-4.5 w-8 shrink-0 rounded-full bg-black/10 transition-all peer-checked:bg-green-500/80 after:absolute after:top-0.5 after:left-[2px] after:h-3.5 after:w-3.5 after:rounded-full after:bg-white after:shadow-sm after:transition-all after:content-[''] peer-checked:after:translate-x-3.5" />
                    <span className="text-12px font-600 text-black/40 truncate whitespace-nowrap">
                      {server.enabled ? '已启用' : '已停用'}
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
                </div>
                {mcpInspectResults[server.id] ? (
                  <div
                    className={`provider-feedback ${mcpInspectResults[server.id]?.tone === 'success' ? 'success' : 'error'}`}
                  >
                    <strong>{mcpInspectResults[server.id]?.message}</strong>
                    {mcpInspectResults[server.id]?.tools.length ? (
                      <div className="mcp-tool-chip-list">
                        {mcpInspectResults[server.id]?.tools.map(tool => (
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
                ) : null}
                <div className="header-actions">
                  <button
                    className="secondary-button"
                    disabled={testingMcpServerId === server.id}
                    onClick={() => void testMcpServer(server.id)}
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
