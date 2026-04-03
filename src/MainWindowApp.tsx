import { useEffect, useMemo, useState } from 'react'
import { listen } from '@tauri-apps/api/event'
import { open } from '@tauri-apps/plugin-dialog'
import { AppSidebar } from './components/AppSidebar'
import { getAgentTask, respondToApproval, startAgentTask } from './lib/agent'
import { loadSessions, loadSettings, saveSessions } from './lib/storage'
import { openSettingsWindow } from './lib/windows'
import { createSessionWorkspace, readTextFile, readWorkspaceTree } from './lib/workspace'
import type {
  AgentSettings,
  AgentTaskSnapshot,
  ChatMessage,
  Session,
  WorkspaceNode,
} from './types'
import { ChatView } from './views/ChatView'
import { HomeView } from './views/HomeView'

function createId() {
  return Math.random().toString(36).slice(2, 10)
}

function createSession(settings: AgentSettings): Session {
  return {
    id: createId(),
    title: '新建聊天',
    provider: settings.provider,
    model: settings.model,
    workspacePath: '',
    workspaceRoot: settings.cwd,
    workspaceMode: 'default',
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

export function MainWindowApp() {
  const [settings, setSettings] = useState<AgentSettings>(() => loadSettings())
  const [sessions, setSessions] = useState<Session[]>(() => loadSessions())
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)
  const [sessionFilter, setSessionFilter] = useState('')
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
    if (!activeSessionId) {
      return null
    }
    return sessions.find(session => session.id === activeSessionId) ?? null
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

  const isRunning =
    agentTask?.status === 'queued' ||
    agentTask?.status === 'running' ||
    agentTask?.status === 'awaiting_approval'

  const displayedToolEvents =
    activeSession && agentTask && agentTask.toolEvents.length > 0
      ? agentTask.toolEvents
      : activeSession?.toolEvents || []

  const displayedTaskTree =
    activeSession && agentTask && agentTask.taskTree.length > 0
      ? agentTask.taskTree
      : activeSession?.taskTree || []

  const activeWorkspacePath = activeSession?.workspacePath || ''
  const effectiveProvider = activeSession?.provider || settings.provider
  const effectiveModel = activeSession?.model || settings.model

  useEffect(() => {
    saveSessions(sessions)
  }, [sessions])

  useEffect(() => {
    let unlisten: (() => void) | undefined

    void (async () => {
      unlisten = await listen('settings:updated', () => {
        const next = loadSettings()
        setSettings(next)
      })
    })()

    return () => {
      unlisten?.()
    }
  }, [])

  useEffect(() => {
    if (activeSessionId && !sessions.some(session => session.id === activeSessionId)) {
      setActiveSessionId(null)
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
      if (!activeWorkspacePath.trim()) {
        setWorkspaceTree(null)
        setWorkspaceError('')
        return
      }

      setWorkspaceLoading(true)
      setWorkspaceError('')

      try {
        const tree = await readWorkspaceTree(activeWorkspacePath)
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

    setSelectedFilePath(null)
    void loadTree()
    return () => {
      cancelled = true
    }
  }, [activeWorkspacePath])

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

  async function chooseExplicitWorkspaceForSession() {
    const selected = await open({
      directory: true,
      multiple: false,
      title: '选择当前会话工作目录',
    })
    if (typeof selected !== 'string') {
      return
    }
    if (!activeSession) {
      return
    }

    updateSession(activeSession.id, session => ({
      ...session,
      workspacePath: selected,
      workspaceRoot: selected,
      workspaceMode: 'explicit',
      updatedAt: Date.now(),
    }))
    setSelectedFilePath(null)
  }

  function createFreshSession() {
    const next = createSession(settings)
    setSessions(current => [next, ...current])
    setActiveSessionId(next.id)
    setDraft('')
    setError('')
  }

  function openSession(sessionId: string) {
    setActiveSessionId(sessionId)
    setError('')
  }

  function insertFileReference(path: string) {
    setDraft(current =>
      current.trim()
        ? `${current.trim()}\n\n请重点查看文件：${path}`
        : `请重点查看文件：${path}`,
    )
  }

  async function ensureSessionWorkspace(session: Session, prompt: string) {
    if (session.workspacePath.trim()) {
      return session.workspacePath
    }
    if (!session.workspaceRoot.trim()) {
      throw new Error('请先在设置里配置默认工作目录，或者在新建聊天时手动选择目录。')
    }

    const workspacePath = await createSessionWorkspace(session.workspaceRoot, prompt)
    updateSession(session.id, current => ({
      ...current,
      workspacePath,
      workspaceRoot: current.workspaceRoot || session.workspaceRoot,
      workspaceMode: 'default',
      updatedAt: Date.now(),
    }))
    return workspacePath
  }

  async function submit() {
    const content = draft.trim()
    if (!content || isRunning || !activeSession) {
      return
    }
    if (!settings.apiKey.trim()) {
      setError('请先在设置窗口里完成 Provider 配置。')
      await openSettingsWindow('providers').catch(caught => {
        setError(caught instanceof Error ? caught.message : '打开设置窗口失败。')
      })
      return
    }

    const workspacePath = await ensureSessionWorkspace(activeSession, content).catch(caught => {
      setError(caught instanceof Error ? caught.message : '创建会话工作目录失败。')
      return ''
    })

    if (!workspacePath) {
      return
    }

    const userMessage: ChatMessage = {
      id: createId(),
      role: 'user',
      content,
    }

    const runtimeSettings: AgentSettings = {
      ...settings,
      provider: effectiveProvider,
      model: effectiveModel,
      cwd: workspacePath,
    }

    const sessionId = activeSession.id
    const nextMessages = [...activeSession.messages, userMessage]
    updateSession(sessionId, session => ({
      ...session,
      title: session.messages.length === 0 ? summarizeTitle(content) : session.title,
      messages: nextMessages,
      toolEvents: [],
      taskTree: [],
      workspacePath,
      updatedAt: Date.now(),
    }))
    setDraft('')
    setError('')

    try {
      const taskId = await startAgentTask(runtimeSettings, nextMessages)
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
    if (!activeWorkspacePath.trim()) {
      return
    }
    setWorkspaceLoading(true)
    setWorkspaceError('')
    try {
      const tree = await readWorkspaceTree(activeWorkspacePath)
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

  const effectiveSettings: AgentSettings = {
    ...settings,
    provider: effectiveProvider,
    model: effectiveModel,
    cwd: activeWorkspacePath,
  }

  return (
    <>
      <div className="app-shell">
        <AppSidebar
          sessionFilter={sessionFilter}
          onSessionFilterChange={setSessionFilter}
          sessions={filteredSessions}
          activeSessionId={activeSession?.id || null}
          onOpenSession={openSession}
          onCreateSession={createFreshSession}
          onOpenSettings={() =>
            void openSettingsWindow('general').catch(caught => {
              setError(caught instanceof Error ? caught.message : '打开设置窗口失败。')
            })
          }
          settingsOpen={false}
        />

        <main className="content-shell">
          {activeSession ? (
            <ChatView
              activeSessionTitle={activeSession.title}
              messages={activeSession.messages}
              displayedToolEvents={displayedToolEvents}
              displayedTaskTree={displayedTaskTree}
              settings={effectiveSettings}
              sessionWorkspaceRoot={activeSession.workspaceRoot}
              sessionWorkspaceMode={activeSession.workspaceMode}
              draft={draft}
              error={error}
              isRunning={isRunning}
              agentTask={agentTask}
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
              onOpenProviders={() =>
                void openSettingsWindow('providers').catch(caught => {
                  setError(caught instanceof Error ? caught.message : '打开设置窗口失败。')
                })
              }
              onHandleApproval={decision => void handleApproval(decision)}
              onRefreshWorkspace={() => void refreshWorkspace()}
              onChooseWorkspace={() => void chooseExplicitWorkspaceForSession()}
              onToggleWorkspacePath={toggleWorkspacePath}
              onSelectWorkspaceFile={setSelectedFilePath}
              onInsertFileReference={insertFileReference}
              onCopyPath={path => void copyText(path)}
              onCopyText={value => void copyText(value)}
            />
          ) : (
            <HomeView
              sessions={sessions}
              providerConfigured={Boolean(settings.apiKey.trim() && settings.model.trim())}
              workspaceConfigured={Boolean(settings.cwd.trim())}
              onOpenSession={openSession}
              onNewSession={createFreshSession}
              onOpenProviders={() =>
                void openSettingsWindow('providers').catch(caught => {
                  setError(caught instanceof Error ? caught.message : '打开设置窗口失败。')
                })
              }
              onOpenSettings={() =>
                void openSettingsWindow('general').catch(caught => {
                  setError(caught instanceof Error ? caught.message : '打开设置窗口失败。')
                })
              }
            />
          )}
        </main>
      </div>
    </>
  )
}
