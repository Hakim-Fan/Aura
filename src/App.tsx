import { useEffect, useMemo, useState } from 'react'
import { open } from '@tauri-apps/plugin-dialog'
import { advancedCapabilities, builtinPlugins, builtinSkills } from './catalog'
import { AppSidebar } from './components/AppSidebar'
import { getAgentTask, respondToApproval, startAgentTask } from './lib/agent'
import { loadSessions, loadSettings, saveSessions, saveSettings } from './lib/storage'
import { readTextFile, readWorkspaceTree } from './lib/workspace'
import type {
  AgentSettings,
  AgentTaskSnapshot,
  ChatMessage,
  McpServerConfig,
  ProviderPreset,
  Session,
  WorkspaceNode,
} from './types'
import { ChatView } from './views/ChatView'
import { HomeView } from './views/HomeView'
import { ProvidersView } from './views/ProvidersView'

type ViewId = 'home' | 'chat' | 'providers' | 'mcp' | 'skills' | 'plugins'

const navItems: Array<{ id: ViewId; label: string; glyph: string }> = [
  { id: 'home', label: '首页', glyph: 'H' },
  { id: 'chat', label: '聊天', glyph: 'C' },
  { id: 'providers', label: '提供商', glyph: 'P' },
  { id: 'mcp', label: 'MCP 服务器', glyph: 'M' },
  { id: 'skills', label: '技能', glyph: 'S' },
  { id: 'plugins', label: 'Plugins', glyph: 'L' },
]

const providerPresets: ProviderPreset[] = [
  {
    id: 'openrouter',
    name: 'OpenRouter',
    subtitle: '聚合多模型和多厂商路由',
    dot: 'ready',
    provider: 'openai-compatible',
    baseUrl: 'https://openrouter.ai/api/v1',
    modelHint: 'openai/gpt-4.1 or anthropic/claude-sonnet-4',
  },
  {
    id: 'github-copilot',
    name: 'GitHub Copilot',
    subtitle: '适合作为企业现有开发账号的补充入口',
    dot: 'ready',
    provider: 'openai-compatible',
    baseUrl: 'https://api.githubcopilot.com',
    modelHint: 'gpt-4.1',
  },
  {
    id: 'openai',
    name: 'OpenAI',
    subtitle: 'OpenAI models including GPT-4.1, GPT-4o, o3',
    dot: 'active',
    provider: 'openai-compatible',
    baseUrl: 'https://api.openai.com/v1',
    modelHint: 'gpt-4.1',
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    subtitle: 'Claude 系列模型和 Agent 风格推理循环',
    dot: 'idle',
    provider: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    modelHint: 'claude-sonnet-4-20250514',
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    subtitle: '高性价比推理和代码模型',
    dot: 'idle',
    provider: 'openai-compatible',
    baseUrl: 'https://api.deepseek.com/v1',
    modelHint: 'deepseek-chat',
  },
  {
    id: 'gemini',
    name: 'Google Gemini',
    subtitle: 'Google 模型入口，可用于研究和多模态任务',
    dot: 'idle',
    provider: 'openai-compatible',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    modelHint: 'gemini-2.5-pro',
  },
  {
    id: 'moonshot',
    name: 'Moonshot',
    subtitle: '面向中文体验和长文本场景',
    dot: 'idle',
    provider: 'openai-compatible',
    baseUrl: 'https://api.moonshot.cn/v1',
    modelHint: 'moonshot-v1-128k',
  },
  {
    id: 'custom',
    name: 'Custom Provider',
    subtitle: '兼容 OpenAI 风格接口的自定义模型服务',
    badge: 'CUSTOM',
    dot: 'ready',
    provider: 'openai-compatible',
    baseUrl: '',
    modelHint: 'your-model-id',
  },
]

const promptSuggestions = [
  '分析这个仓库并给出最小修复路径',
  '查看当前工作区结构，告诉我核心模块分布',
  '帮我实现一个新功能，并说明验证步骤',
  '结合 MCP 和本地工具调查一个线上问题',
]

function createId() {
  return Math.random().toString(36).slice(2, 10)
}

function createSession(title = '新会话'): Session {
  return {
    id: createId(),
    title,
    messages: [],
    toolEvents: [],
    taskTree: [],
    updatedAt: Date.now(),
  }
}

function summarizeTitle(input: string) {
  const compact = input.replace(/\s+/g, ' ').trim()
  if (!compact) {
    return '新会话'
  }
  return compact.length > 28 ? `${compact.slice(0, 28)}...` : compact
}

function collectExpandablePaths(tree: WorkspaceNode | null) {
  if (!tree) {
    return []
  }
  const paths = [tree.path]
  for (const child of tree.children) {
    if (child.kind === 'directory' && child.children.length > 0) {
      paths.push(child.path)
    }
  }
  return paths
}

export default function App() {
  const [settings, setSettings] = useState<AgentSettings>(() => loadSettings())
  const [sessions, setSessions] = useState<Session[]>(() => {
    const existing = loadSessions()
    return existing.length > 0 ? existing : [createSession()]
  })
  const [activeSessionId, setActiveSessionId] = useState<string>(() => {
    const existing = loadSessions()
    return existing[0]?.id ?? createSession().id
  })
  const [activeView, setActiveView] = useState<ViewId>('home')
  const [sessionFilter, setSessionFilter] = useState('')
  const [providerSearch, setProviderSearch] = useState('')
  const [selectedProviderId, setSelectedProviderId] = useState('openai')
  const [draft, setDraft] = useState('')
  const [error, setError] = useState('')
  const [agentTask, setAgentTask] = useState<AgentTaskSnapshot | null>(null)
  const [runningSessionId, setRunningSessionId] = useState<string | null>(null)
  const [workspaceTree, setWorkspaceTree] = useState<WorkspaceNode | null>(null)
  const [workspaceLoading, setWorkspaceLoading] = useState(false)
  const [workspaceError, setWorkspaceError] = useState('')
  const [expandedPaths, setExpandedPaths] = useState<string[]>([])
  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null)
  const [previewContent, setPreviewContent] = useState('')
  const [previewLoading, setPreviewLoading] = useState(false)
  const [previewError, setPreviewError] = useState('')

  const activeSession = useMemo(() => {
    return (
      sessions.find(session => session.id === activeSessionId) ??
      sessions[0] ??
      createSession()
    )
  }, [activeSessionId, sessions])

  const filteredSessions = useMemo(() => {
    const keyword = sessionFilter.trim().toLowerCase()
    if (!keyword) {
      return sessions
    }
    return sessions.filter(session =>
      `${session.title} ${session.messages.map(message => message.content).join(' ')}`
        .toLowerCase()
        .includes(keyword),
    )
  }, [sessionFilter, sessions])

  const visibleProviders = useMemo(() => {
    const keyword = providerSearch.trim().toLowerCase()
    if (!keyword) {
      return providerPresets
    }
    return providerPresets.filter(provider =>
      `${provider.name} ${provider.subtitle}`.toLowerCase().includes(keyword),
    )
  }, [providerSearch])

  const selectedProvider =
    providerPresets.find(provider => provider.id === selectedProviderId) ??
    providerPresets[0]

  const isRunning =
    agentTask?.status === 'queued' ||
    agentTask?.status === 'running' ||
    agentTask?.status === 'awaiting_approval'

  const displayedToolEvents =
    agentTask && agentTask.toolEvents.length > 0
      ? agentTask.toolEvents
      : activeSession.toolEvents

  const displayedTaskTree =
    agentTask && agentTask.taskTree.length > 0
      ? agentTask.taskTree
      : activeSession.taskTree

  useEffect(() => {
    saveSettings(settings)
  }, [settings])

  useEffect(() => {
    saveSessions(sessions)
  }, [sessions])

  useEffect(() => {
    if (!sessions.some(session => session.id === activeSessionId) && sessions[0]) {
      setActiveSessionId(sessions[0].id)
    }
  }, [activeSessionId, sessions])

  useEffect(() => {
    if (!agentTask?.id || !runningSessionId) {
      return
    }

    const taskId = agentTask.id
    const currentSessionId = runningSessionId
    let cancelled = false

    async function poll() {
      try {
        const snapshot = await getAgentTask(taskId)
        if (cancelled) {
          return
        }

        setAgentTask(snapshot)
        updateSession(currentSessionId, session => ({
          ...session,
          toolEvents: snapshot.toolEvents,
          taskTree: snapshot.taskTree,
          updatedAt: session.updatedAt,
        }))

        if (snapshot.status === 'completed') {
          const assistantMessage: ChatMessage = {
            id: createId(),
            role: 'assistant',
            content: snapshot.message || 'Agent 已完成，但没有返回文本。',
          }
          setSessions(current =>
            current
              .map(session =>
                session.id === currentSessionId
                  ? {
                      ...session,
                      messages: [...session.messages, assistantMessage],
                      toolEvents: snapshot.toolEvents,
                      taskTree: snapshot.taskTree,
                      updatedAt: Date.now(),
                    }
                  : session,
              )
              .sort((a, b) => b.updatedAt - a.updatedAt),
          )
          setAgentTask(null)
          setRunningSessionId(null)
          return
        }

        if (snapshot.status === 'failed') {
          setError(snapshot.error || 'Agent 执行失败。')
          setSessions(current =>
            current
              .map(session =>
                session.id === currentSessionId
                  ? {
                      ...session,
                      toolEvents: snapshot.toolEvents,
                      taskTree: snapshot.taskTree,
                      updatedAt: Date.now(),
                    }
                  : session,
              )
              .sort((a, b) => b.updatedAt - a.updatedAt),
          )
          setAgentTask(null)
          setRunningSessionId(null)
        }
      } catch (caught) {
        if (!cancelled) {
          setError(caught instanceof Error ? caught.message : '轮询任务状态失败。')
          setAgentTask(null)
          setRunningSessionId(null)
        }
      }
    }

    void poll()
    const timer = window.setInterval(() => void poll(), 900)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [agentTask?.id, runningSessionId])

  useEffect(() => {
    let cancelled = false

    async function loadTree() {
      if (!settings.cwd.trim()) {
        setWorkspaceTree(null)
        setWorkspaceError('')
        return
      }

      setWorkspaceLoading(true)
      setWorkspaceError('')

      try {
        const tree = await readWorkspaceTree(settings.cwd)
        if (cancelled) {
          return
        }
        setWorkspaceTree(tree)
        setExpandedPaths(collectExpandablePaths(tree))
      } catch (caught) {
        if (!cancelled) {
          setWorkspaceTree(null)
          setWorkspaceError(caught instanceof Error ? caught.message : '读取工作区失败。')
        }
      } finally {
        if (!cancelled) {
          setWorkspaceLoading(false)
        }
      }
    }

    void loadTree()
    return () => {
      cancelled = true
    }
  }, [settings.cwd])

  useEffect(() => {
    if (!selectedFilePath) {
      setPreviewContent('')
      setPreviewError('')
      return
    }

    const filePath = selectedFilePath
    let cancelled = false

    async function loadPreview() {
      setPreviewLoading(true)
      setPreviewError('')
      try {
        const content = await readTextFile(filePath)
        if (!cancelled) {
          setPreviewContent(content)
        }
      } catch (caught) {
        if (!cancelled) {
          setPreviewContent('')
          setPreviewError(caught instanceof Error ? caught.message : '读取文件失败。')
        }
      } finally {
        if (!cancelled) {
          setPreviewLoading(false)
        }
      }
    }

    void loadPreview()
    return () => {
      cancelled = true
    }
  }, [selectedFilePath])

  function updateSession(sessionId: string, updater: (session: Session) => Session) {
    setSessions(current =>
      current
        .map(session => (session.id === sessionId ? updater(session) : session))
        .sort((a, b) => b.updatedAt - a.updatedAt),
    )
  }

  function handleSettingsChange<K extends keyof AgentSettings>(
    key: K,
    value: AgentSettings[K],
  ) {
    setSettings(current => ({
      ...current,
      [key]: value,
    }))
  }

  function toggleSkill(skillId: string) {
    const next = settings.enabledSkillIds.includes(skillId)
      ? settings.enabledSkillIds.filter(id => id !== skillId)
      : [...settings.enabledSkillIds, skillId]
    handleSettingsChange('enabledSkillIds', next)
  }

  function togglePlugin(pluginId: string) {
    const next = settings.enabledPluginIds.includes(pluginId)
      ? settings.enabledPluginIds.filter(id => id !== pluginId)
      : [...settings.enabledPluginIds, pluginId]
    handleSettingsChange('enabledPluginIds', next)
  }

  function addMcpServer() {
    const nextServer: McpServerConfig = {
      id: createId(),
      name: 'new-mcp',
      command: '',
      args: '',
      env: '{}',
      cwd: '',
      enabled: true,
    }
    handleSettingsChange('mcpServers', [...settings.mcpServers, nextServer])
  }

  function updateMcpServer(
    serverId: string,
    updater: (server: McpServerConfig) => McpServerConfig,
  ) {
    handleSettingsChange(
      'mcpServers',
      settings.mcpServers.map(server =>
        server.id === serverId ? updater(server) : server,
      ),
    )
  }

  function removeMcpServer(serverId: string) {
    handleSettingsChange(
      'mcpServers',
      settings.mcpServers.filter(server => server.id !== serverId),
    )
  }

  function applyProviderPreset(preset: ProviderPreset) {
    setSelectedProviderId(preset.id)
    setSettings(current => ({
      ...current,
      provider: preset.provider,
      baseUrl: preset.baseUrl || current.baseUrl,
      model: preset.modelHint || current.model,
    }))
  }

  async function chooseWorkspace() {
    const selected = await open({
      directory: true,
      multiple: false,
      title: '选择 Agent 工作目录',
    })
    if (typeof selected === 'string') {
      handleSettingsChange('cwd', selected)
      setSelectedFilePath(null)
    }
  }

  function createFreshSession() {
    const next = createSession()
    setSessions(current => [next, ...current])
    setActiveSessionId(next.id)
    setActiveView('chat')
    setError('')
  }

  function openSession(sessionId: string) {
    setActiveSessionId(sessionId)
    setActiveView('chat')
  }

  function injectPromptSuggestion(prompt: string) {
    setDraft(prompt)
    setActiveView('chat')
  }

  function insertFileReference(path: string) {
    setDraft(current =>
      current.trim()
        ? `${current.trim()}\n\n请重点查看文件：${path}`
        : `请重点查看文件：${path}`,
    )
    setActiveView('chat')
  }

  async function submit() {
    const content = draft.trim()
    if (!content || isRunning) {
      return
    }
    if (!settings.apiKey.trim()) {
      setError('请先在提供商配置里填入 API Key。')
      setActiveView('providers')
      return
    }
    if (!settings.cwd.trim()) {
      setError('请先设置工作目录。')
      return
    }

    setError('')
    const userMessage: ChatMessage = {
      id: createId(),
      role: 'user',
      content,
    }

    const sessionId = activeSession.id
    const nextMessages = [...activeSession.messages, userMessage]
    updateSession(sessionId, session => ({
      ...session,
      title: session.messages.length === 0 ? summarizeTitle(content) : session.title,
      messages: nextMessages,
      toolEvents: [],
      taskTree: [],
      updatedAt: Date.now(),
    }))
    setDraft('')
    setActiveView('chat')

    try {
      const taskId = await startAgentTask(settings, nextMessages)
      setRunningSessionId(sessionId)
      setAgentTask({
        id: taskId,
        status: 'queued',
        toolEvents: [],
        taskTree: [],
      })
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Agent 启动失败。')
      setRunningSessionId(null)
      setAgentTask(null)
    }
  }

  async function handleApproval(decision: 'approve' | 'deny') {
    if (!agentTask?.id) {
      return
    }
    await respondToApproval(agentTask.id, decision)
    setAgentTask(current =>
      current
        ? {
            ...current,
            status: 'running',
            pendingApproval: undefined,
          }
        : current,
    )
  }

  async function copyText(value: string) {
    try {
      await navigator.clipboard.writeText(value)
    } catch {
      setError('复制失败，请检查系统剪贴板权限。')
    }
  }

  async function refreshWorkspace() {
    if (!settings.cwd.trim()) {
      return
    }
    setWorkspaceLoading(true)
    setWorkspaceError('')
    try {
      const tree = await readWorkspaceTree(settings.cwd)
      setWorkspaceTree(tree)
      setExpandedPaths(current => (current.length > 0 ? current : collectExpandablePaths(tree)))
    } catch (caught) {
      setWorkspaceError(caught instanceof Error ? caught.message : '刷新工作区失败。')
    } finally {
      setWorkspaceLoading(false)
    }
  }

  function toggleWorkspacePath(path: string) {
    setExpandedPaths(current =>
      current.includes(path)
        ? current.filter(entry => entry !== path)
        : [...current, path],
    )
  }

  function renderSkills() {
    return (
      <section className="section-shell">
        <header className="section-header">
          <div>
            <div className="eyebrow">Skills</div>
            <h2>技能</h2>
          </div>
          <p className="muted">把固定工作流和专家提示做成可组合的本地技能。</p>
        </header>
        <div className="tile-grid">
          {builtinSkills.map(skill => (
            <label key={skill.id} className="feature-tile">
              <input
                checked={settings.enabledSkillIds.includes(skill.id)}
                onChange={() => toggleSkill(skill.id)}
                type="checkbox"
              />
              <div>
                <strong>{skill.name}</strong>
                <p>{skill.description}</p>
              </div>
            </label>
          ))}
        </div>
      </section>
    )
  }

  function renderPlugins() {
    return (
      <section className="section-shell">
        <header className="section-header">
          <div>
            <div className="eyebrow">Plugins</div>
            <h2>插件</h2>
          </div>
          <p className="muted">本地扩展能力，适合把更深的系统能力和业务接口封装成工具。</p>
        </header>
        <div className="tile-grid">
          {builtinPlugins.map(plugin => (
            <label key={plugin.id} className="feature-tile">
              <input
                checked={settings.enabledPluginIds.includes(plugin.id)}
                onChange={() => togglePlugin(plugin.id)}
                type="checkbox"
              />
              <div>
                <strong>{plugin.name}</strong>
                <p>{plugin.description}</p>
              </div>
            </label>
          ))}
        </div>
      </section>
    )
  }

  function renderMcp() {
    return (
      <section className="section-shell">
        <header className="section-header">
          <div>
            <div className="eyebrow">MCP</div>
            <h2>MCP 服务器</h2>
          </div>
          <div className="header-actions">
            <button className="secondary-button" onClick={chooseWorkspace}>
              选择工作区
            </button>
            <button className="primary-button" onClick={addMcpServer}>
              添加 MCP Server
            </button>
          </div>
        </header>
        <div className="tile-grid mcp-grid">
          {settings.mcpServers.map(server => (
            <div key={server.id} className="feature-tile as-card">
              <div className="inline-between">
                <strong>{server.name}</strong>
                <button className="mini-button" onClick={() => removeMcpServer(server.id)}>
                  删除
                </button>
              </div>
              <label>
                Name
                <input
                  value={server.name}
                  onChange={event =>
                    updateMcpServer(server.id, current => ({
                      ...current,
                      name: event.target.value,
                    }))
                  }
                />
              </label>
              <label>
                Command
                <input
                  value={server.command}
                  onChange={event =>
                    updateMcpServer(server.id, current => ({
                      ...current,
                      command: event.target.value,
                    }))
                  }
                  placeholder="npx"
                />
              </label>
              <label>
                Args
                <input
                  value={server.args}
                  onChange={event =>
                    updateMcpServer(server.id, current => ({
                      ...current,
                      args: event.target.value,
                    }))
                  }
                  placeholder="-y @modelcontextprotocol/server-filesystem /path"
                />
              </label>
              <label>
                Cwd
                <input
                  value={server.cwd}
                  onChange={event =>
                    updateMcpServer(server.id, current => ({
                      ...current,
                      cwd: event.target.value,
                    }))
                  }
                />
              </label>
              <label>
                Env (JSON)
                <textarea
                  rows={4}
                  value={server.env}
                  onChange={event =>
                    updateMcpServer(server.id, current => ({
                      ...current,
                      env: event.target.value,
                    }))
                  }
                />
              </label>
              <label className="toggle-inline">
                <input
                  checked={server.enabled}
                  onChange={event =>
                    updateMcpServer(server.id, current => ({
                      ...current,
                      enabled: event.target.checked,
                    }))
                  }
                  type="checkbox"
                />
                启用这个 MCP server
              </label>
            </div>
          ))}
          {settings.mcpServers.length === 0 ? (
            <div className="feature-empty">
              <h3>还没有 MCP Server</h3>
              <p>添加一个 stdio MCP 服务后，Agent 就能自动把它的工具纳入工具池。</p>
            </div>
          ) : null}
        </div>
      </section>
    )
  }

  function renderCurrentView() {
    switch (activeView) {
      case 'home':
        return (
          <HomeView
            sessions={sessions}
            capabilities={advancedCapabilities}
            onOpenSession={openSession}
            onNewSession={createFreshSession}
            onOpenProviders={() => setActiveView('providers')}
            onOpenChat={() => setActiveView('chat')}
          />
        )
      case 'providers':
        return (
          <ProvidersView
            providerSearch={providerSearch}
            visibleProviders={visibleProviders}
            selectedProviderId={selectedProviderId}
            selectedProvider={selectedProvider}
            customProviderPreset={providerPresets.find(provider => provider.id === 'custom') ?? selectedProvider}
            settings={settings}
            onProviderSearchChange={setProviderSearch}
            onApplyPreset={applyProviderPreset}
            onSettingsChange={handleSettingsChange}
            onCopyApiKey={() => void copyText(settings.apiKey || '')}
            onClose={() => setActiveView('home')}
            onStartChat={() => setActiveView('chat')}
          />
        )
      case 'mcp':
        return renderMcp()
      case 'skills':
        return renderSkills()
      case 'plugins':
        return renderPlugins()
      case 'chat':
      default:
        return (
          <ChatView
            activeSessionTitle={activeSession.title}
            messages={activeSession.messages}
            displayedToolEvents={displayedToolEvents}
            displayedTaskTree={displayedTaskTree}
            settings={settings}
            draft={draft}
            error={error}
            isRunning={isRunning}
            agentTask={agentTask}
            promptSuggestions={promptSuggestions}
            workspaceTree={workspaceTree}
            workspaceLoading={workspaceLoading}
            workspaceError={workspaceError}
            expandedPaths={expandedPaths}
            selectedFilePath={selectedFilePath}
            previewContent={previewContent}
            previewLoading={previewLoading}
            previewError={previewError}
            onDraftChange={setDraft}
            onSubmit={() => void submit()}
            onInjectPrompt={injectPromptSuggestion}
            onOpenProviders={() => setActiveView('providers')}
            onHandleApproval={decision => void handleApproval(decision)}
            onPolicyChange={handleSettingsChange}
            onRefreshWorkspace={() => void refreshWorkspace()}
            onChooseWorkspace={() => void chooseWorkspace()}
            onToggleWorkspacePath={toggleWorkspacePath}
            onSelectWorkspaceFile={setSelectedFilePath}
            onInsertFileReference={insertFileReference}
            onCopyPath={path => void copyText(path)}
            onCopyText={value => void copyText(value)}
          />
        )
    }
  }

  return (
    <div className="app-shell">
      <AppSidebar
        navItems={navItems}
        activeView={activeView}
        onSelectView={viewId => setActiveView(viewId as ViewId)}
        sessionFilter={sessionFilter}
        onSessionFilterChange={setSessionFilter}
        sessions={filteredSessions}
        activeSessionId={activeSession.id}
        onOpenSession={openSession}
        onOpenHome={() => setActiveView('home')}
      />

      <main className="content-shell">{renderCurrentView()}</main>
    </div>
  )
}
