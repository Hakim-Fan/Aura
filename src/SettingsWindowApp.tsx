import { useEffect, useMemo, useState } from 'react'
import { listen } from '@tauri-apps/api/event'
import { ask, open } from '@tauri-apps/plugin-dialog'
import { builtinPlugins, builtinSkills } from './catalog'
import { fetchProviderModels, testProviderConnection } from './lib/provider'
import { loadSettings, saveSettings } from './lib/storage'
import { broadcastSettingsUpdated, closeCurrentWindow, openMcpEditorWindow } from './lib/windows'
import type { AgentSettings, ProviderMode, ProviderProfile } from './types'
import { ProvidersView } from './views/ProvidersView'
import { SettingsView, type SettingsTab } from './views/SettingsView'

const PROVIDER_BASE_URLS: Record<ProviderMode, string> = {
  openai: 'https://api.openai.com/v1',
  google: 'https://generativelanguage.googleapis.com/v1beta',
  custom: 'https://api.openai.com/v1',
}

function cloneSettings(settings: AgentSettings): AgentSettings {
  return JSON.parse(JSON.stringify(settings)) as AgentSettings
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
      providerProfiles: current.providerProfiles.map(profile =>
        profile.id === profileId
          ? {
            ...profile,
            models: profile.models.map(model =>
              model.id === modelId ? { ...model, enabled: !model.enabled } : model,
            ),
          }
          : profile,
      ),
    }))
    setSaveState('idle')
  }

  function getPrimaryModelId(profile: ProviderProfile) {
    return profile.models.find(model => model.enabled)?.id || ''
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
    const next = draftSettings.enabledSkillIds.includes(skillId)
      ? draftSettings.enabledSkillIds.filter(id => id !== skillId)
      : [...draftSettings.enabledSkillIds, skillId]
    handleSettingsChange('enabledSkillIds', next)
  }

  function togglePlugin(pluginId: string) {
    const next = draftSettings.enabledPluginIds.includes(pluginId)
      ? draftSettings.enabledPluginIds.filter(id => id !== pluginId)
      : [...draftSettings.enabledPluginIds, pluginId]
    handleSettingsChange('enabledPluginIds', next)
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
    return (
      <section className="section-shell settings-panel">
        <div className="settings-grid">
          <section className="dashboard-card">
            <div className="section-title">默认工作目录</div>
            <p className="muted">
              {draftSettings.cwd.trim()
                ? draftSettings.cwd
                : '新建聊天没有手动选择目录时，会使用这里作为默认根目录。'}
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
            <div className="section-title">审批策略</div>
            <div className="toggle-stack">
              <label className="toggle-inline">
                <input
                  checked={draftSettings.autoApproveShell}
                  onChange={event =>
                    handleSettingsChange('autoApproveShell', event.target.checked)
                  }
                  type="checkbox"
                />
                Shell 默认自动允许
              </label>
              <label className="toggle-inline">
                <input
                  checked={draftSettings.autoApproveFileWrite}
                  onChange={event =>
                    handleSettingsChange('autoApproveFileWrite', event.target.checked)
                  }
                  type="checkbox"
                />
                文件写入默认自动允许
              </label>
              <label className="toggle-inline">
                <input
                  checked={draftSettings.autoApproveComputerUse}
                  onChange={event =>
                    handleSettingsChange('autoApproveComputerUse', event.target.checked)
                  }
                  type="checkbox"
                />
                Computer Use 默认自动允许
              </label>
              <label className="toggle-inline">
                <input
                  checked={draftSettings.autoApproveChromeAutomation}
                  onChange={event =>
                    handleSettingsChange('autoApproveChromeAutomation', event.target.checked)
                  }
                  type="checkbox"
                />
                Chrome 自动化默认自动允许
              </label>
            </div>
          </section>
        </div>
      </section>
    )
  }

  function renderMcp() {
    return (
      <section className="section-shell settings-panel">
        <header className="section-header">
          <div>
            <div className="eyebrow">MCP Servers</div>
            <h2>MCP 服务器</h2>
          </div>
          <button className="primary-button" onClick={() => void openMcpEditorWindow()}>
            新增 MCP
          </button>
        </header>

        <div className="asset-card-list">
          {draftSettings.mcpServers.length > 0 ? (
            draftSettings.mcpServers.map(server => (
              <article key={server.id} className="asset-card">
                <div className="asset-card-head">
                  <div>
                    <strong>{server.name}</strong>
                    <p>{server.command || '尚未配置 command'}</p>
                  </div>
                  <label className="toggle-inline">
                    <input checked={server.enabled} disabled type="checkbox" />
                    {server.enabled ? '已启用' : '已停用'}
                  </label>
                </div>
                <div className="asset-card-meta">
                  <span className="micro-pill">{server.cwd || '无单独 cwd'}</span>
                  <span className="micro-pill">{server.args || '无 args'}</span>
                </div>
                <div className="header-actions">
                  <button
                    className="secondary-button"
                    onClick={() => void openMcpEditorWindow(server.id)}
                  >
                    编辑
                  </button>
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
    items: typeof builtinSkills | typeof builtinPlugins,
    enabledIds: string[],
    onToggle: (id: string) => void,
  ) {
    const title = kind === 'skills' ? '技能' : '插件'

    return (
      <section className="section-shell settings-panel">
        <header className="section-header">
          <div>
            <div className="eyebrow">{title}</div>
            <h2>{title}</h2>
          </div>
          <span className="micro-pill">{items.length} 个可用</span>
        </header>

        <div className="asset-card-list">
          {items.map(item => (
            <article key={item.id} className="asset-card">
              <div className="asset-card-head">
                <div>
                  <strong>{item.name}</strong>
                  <p>{item.description}</p>
                </div>
                <label className="switch-pill">
                  <input
                    checked={enabledIds.includes(item.id)}
                    onChange={() => onToggle(item.id)}
                    type="checkbox"
                  />
                  <span>{enabledIds.includes(item.id) ? '启用中' : '已关闭'}</span>
                </label>
              </div>
              <div className="asset-card-meta">
                <span className="micro-pill">{item.id}</span>
              </div>
            </article>
          ))}
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
            onSelectProfile={setSelectedProviderProfileId}
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
            builtinSkills,
            draftSettings.enabledSkillIds,
            toggleSkill,
          )
          : null}
        {activeTab === 'plugins'
          ? renderAssets(
            'plugins',
            builtinPlugins,
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
    </div>
  )
}
