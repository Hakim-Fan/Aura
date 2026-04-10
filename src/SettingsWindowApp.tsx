import { useEffect, useMemo, useState } from 'react'
import { listen } from '@tauri-apps/api/event'
import { ask, open } from '@tauri-apps/plugin-dialog'
import { ChevronDown, ChevronUp, FolderOpen, RefreshCw, Search, Trash2 } from 'lucide-react'
import { builtinPlugins, builtinSkills } from './catalog'
import { inspectMcpServer, type McpInspectResult } from './lib/mcp'
import { fetchProviderModels, testProviderConnection } from './lib/provider'
import { ensureAuraHome, deleteAuraAsset, resetAuraHome, type AuraAsset, type AuraHomeState } from './lib/aura'
import { hydrateStorageFromAuraHome, loadSettings, saveSettings } from './lib/storage'
import { openPathInDefaultApp, readTextFile } from './lib/workspace'
import { ConfirmModal } from './components/ConfirmModal'
import { broadcastSettingsUpdated, closeCurrentWindow, openMcpEditorWindow } from './lib/windows'
import type { AgentSettings, ProviderMode, ProviderProfile } from './types'
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
  const [isTestingProvider, setIsTestingProvider] = useState(false)
  const [isFetchingModels, setIsFetchingModels] = useState(false)
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

  useEffect(() => {
    let unlistenOpenTab: (() => void) | undefined
    let unlistenSettingsUpdated: (() => void) | undefined

    void (async () => {
      try {
        const hydrated = await hydrateStorageFromAuraHome()
        setSavedSettings(hydrated.settings)
        setDraftSettings(cloneSettings(hydrated.settings))
        setSelectedProviderProfileId(hydrated.settings.activeProviderProfileId)
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
        setDraftSettings(latest)
        setSelectedProviderProfileId(latest.activeProviderProfileId)
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
    saveSettings(draftSettings)
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
                      handleSettingsChange(item.key as keyof AgentSettings, event.target.checked)
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
        <div className="muted">{saveState === 'saved' ? '所有更改已保存' : isDirty ? '有未保存更改' : '所有更改已同步'}</div>
        <div className="header-actions">
          <button className="secondary-button" onClick={() => void closeCurrentWindow()}>
            关闭
          </button>
          <button className="primary-button" disabled={!isDirty} onClick={() => void saveDraftSettings()}>
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
