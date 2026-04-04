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
  MessageActivity,
  MessageEvent,
  Session,
  TaskNode,
  ToolEvent,
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

function countTaskNodes(nodes: TaskNode[]): number {
  return nodes.reduce((total, node) => total + 1 + countTaskNodes(node.children), 0)
}

function prettifyIdentifier(identifier: string) {
  return identifier
    .split(/[_-]+/)
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

function presentToolEventTitle(event: ToolEvent) {
  if (event.source === 'plugin') {
    const tail = event.name.split('__').filter(Boolean).at(-1) || event.name
    return prettifyIdentifier(tail)
  }
  if (event.source === 'subagent') {
    return event.name || '子 Agent'
  }
  if (event.name.toLowerCase().includes('shell')) {
    return 'Shell 命令'
  }
  return event.name
}

function mapToolEventToMessageEvent(event: ToolEvent): MessageEvent {
  const kind =
    event.source === 'plugin'
      ? 'skill'
      : event.source === 'subagent'
        ? 'subagent'
        : event.name.toLowerCase().includes('shell')
          ? 'shell'
          : 'tool'

  return {
    id: event.id,
    kind,
    title: presentToolEventTitle(event),
    summary: event.summary,
    source: event.source,
    status: event.status === 'error' ? 'error' : 'success',
    input: event.input,
    output: event.output,
    error: event.error,
  }
}

function buildMessageActivity(
  status: AgentTaskSnapshot['status'],
  startedAt: number,
  toolEvents: ToolEvent[],
  taskTree: TaskNode[],
  expanded = status !== 'completed',
): MessageActivity {
  return {
    status,
    startedAt,
    finishedAt: status === 'completed' || status === 'failed' ? Date.now() : undefined,
    toolCount: toolEvents.filter(event => event.source !== 'plugin').length,
    skillCount: toolEvents.filter(event => event.source === 'plugin').length,
    stepCount: countTaskNodes(taskTree),
    expanded,
  }
}

function createPendingAssistantMessage(): ChatMessage {
  const startedAt = Date.now()
  return {
    id: createId(),
    role: 'assistant',
    content: '',
    status: 'streaming',
    createdAt: startedAt,
    events: [],
    steps: [],
    activity: {
      status: 'queued',
      startedAt,
      toolCount: 0,
      skillCount: 0,
      stepCount: 0,
      expanded: true,
    },
  }
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
  const [runningMessageId, setRunningMessageId] = useState<string | null>(null)
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
    if (!activeSessionId && sessions.length > 0) {
      setActiveSessionId(sessions[0].id)
    }
  }, [activeSessionId, sessions])

  useEffect(() => {
    if (!agentTask?.id || !runningSessionId || !runningMessageId) {
      return
    }

    const taskId = agentTask.id
    const currentSessionId = runningSessionId
    const currentMessageId = runningMessageId
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
          messages: session.messages.map(message =>
            message.id === currentMessageId
              ? {
                  ...message,
                  content:
                    snapshot.message ||
                    (snapshot.status === 'awaiting_approval'
                      ? '等待你的审批后继续执行。'
                      : message.content),
                  status:
                    snapshot.status === 'failed'
                      ? ('failed' as const)
                      : snapshot.status === 'completed'
                        ? ('completed' as const)
                        : ('streaming' as const),
                  events: [
                    ...snapshot.toolEvents.map(mapToolEventToMessageEvent),
                    ...(snapshot.pendingApproval
                      ? [
                          {
                            id: snapshot.pendingApproval.id,
                            kind: 'approval' as const,
                            title: snapshot.pendingApproval.toolName,
                            summary: snapshot.pendingApproval.summary,
                            status: 'awaiting_approval' as const,
                            input: snapshot.pendingApproval.input,
                          },
                        ]
                      : []),
                  ],
                  steps: snapshot.taskTree,
                  activity: buildMessageActivity(
                    snapshot.status,
                    message.createdAt || Date.now(),
                    snapshot.toolEvents,
                    snapshot.taskTree,
                    message.activity?.expanded ?? true,
                  ),
                  error: snapshot.error,
                }
              : message,
          ),
          toolEvents: snapshot.toolEvents,
          taskTree: snapshot.taskTree,
        }))

        if (snapshot.status === 'completed') {
          setSessions(current =>
            current
              .map(session =>
                session.id === currentSessionId
                  ? {
                      ...session,
                      messages: session.messages.map(message =>
                        message.id === currentMessageId
                          ? {
                              ...message,
                              content: snapshot.message || '',
                              status: 'completed' as const,
                              events: snapshot.toolEvents.map(mapToolEventToMessageEvent),
                              steps: snapshot.taskTree,
                              activity: buildMessageActivity(
                                snapshot.status,
                                message.createdAt || Date.now(),
                                snapshot.toolEvents,
                                snapshot.taskTree,
                                false,
                              ),
                              error: undefined,
                            }
                          : message,
                      ),
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
          setRunningMessageId(null)
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
                      messages: session.messages.map(message =>
                        message.id === currentMessageId
                          ? {
                              ...message,
                              content: snapshot.message || '',
                              status: 'failed' as const,
                              events: snapshot.toolEvents.map(mapToolEventToMessageEvent),
                              steps: snapshot.taskTree,
                              activity: buildMessageActivity(
                                snapshot.status,
                                message.createdAt || Date.now(),
                                snapshot.toolEvents,
                                snapshot.taskTree,
                                true,
                              ),
                              error: snapshot.error || 'Agent 执行失败。',
                            }
                          : message,
                      ),
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
          setRunningMessageId(null)
        }
      } catch (caught) {
        if (!cancelled) {
          const message = caught instanceof Error ? caught.message : '轮询任务状态失败。'
          setError(message)
          updateSession(currentSessionId, session => ({
            ...session,
            messages: session.messages.map(entry =>
              entry.id === currentMessageId
                ? {
                    ...entry,
                    status: 'failed' as const,
                    error: message,
                  }
                : entry,
            ),
            updatedAt: Date.now(),
          }))
          setAgentTask(null)
          setRunningSessionId(null)
          setRunningMessageId(null)
        }
      }
    }

    void poll()
    const timer = window.setInterval(() => void poll(), 900)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [agentTask?.id, runningMessageId, runningSessionId])

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

  function deleteSession(sessionId: string) {
    if (sessionId === runningSessionId) {
      setError('当前会话仍在执行中，请等待完成后再删除。')
      return
    }

    const target = sessions.find(session => session.id === sessionId)
    if (!target) {
      return
    }

    const requiresConfirm = target.messages.length > 0 || target.title.trim() !== '新建聊天'
    if (requiresConfirm && !window.confirm(`删除会话“${target.title}”？此操作不可恢复。`)) {
      return
    }

    const remaining = sessions.filter(session => session.id !== sessionId)
    setSessions(remaining)

    if (activeSessionId === sessionId) {
      setActiveSessionId(remaining[0]?.id || null)
      setDraft('')
      setError('')
      setSelectedFilePath(null)
      setPreviewContent('')
      setPreviewError('')
      setWorkspaceTree(null)
      setWorkspaceError('')
    }
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

  async function submitPrompt(rawContent: string) {
    const content = rawContent.trim()
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
      status: 'completed',
      createdAt: Date.now(),
    }
    const pendingAssistantMessage = createPendingAssistantMessage()

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
      messages: [...nextMessages, pendingAssistantMessage],
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
      setRunningMessageId(pendingAssistantMessage.id)
      setAgentTask({
        id: taskId,
        status: 'queued',
        toolEvents: [],
        taskTree: [],
      })
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Agent 启动失败。')
      setRunningSessionId(null)
      setRunningMessageId(null)
      setAgentTask(null)
      updateSession(sessionId, session => ({
        ...session,
        messages: session.messages.filter(message => message.id !== pendingAssistantMessage.id),
        updatedAt: Date.now(),
      }))
    }
  }

  async function submit() {
    await submitPrompt(draft)
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

  function applyMessageToDraft(messageId: string) {
    const message = activeSession?.messages.find(entry => entry.id === messageId)
    if (!message) {
      return
    }
    setDraft(message.content)
  }

  function toggleMessageActivity(messageId: string) {
    if (!activeSession) {
      return
    }
    updateSession(activeSession.id, session => ({
      ...session,
      messages: session.messages.map(message =>
        message.id === messageId && message.activity
          ? {
              ...message,
              activity: {
                ...message.activity,
                expanded: !message.activity.expanded,
              },
            }
          : message,
      ),
      updatedAt: Date.now(),
    }))
  }

  async function regenerateFromMessage(messageId: string) {
    if (!activeSession) {
      return
    }

    const messageIndex = activeSession.messages.findIndex(message => message.id === messageId)
    if (messageIndex === -1) {
      return
    }

    for (let index = messageIndex - 1; index >= 0; index -= 1) {
      const candidate = activeSession.messages[index]
      if (candidate.role === 'user') {
        await submitPrompt(candidate.content)
        return
      }
    }

    setError('没有找到可用于重新生成的上一条用户消息。')
  }

  async function resendUserMessage(messageId: string) {
    const message = activeSession?.messages.find(entry => entry.id === messageId && entry.role === 'user')
    if (!message) {
      return
    }
    await submitPrompt(message.content)
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
          onDeleteSession={deleteSession}
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
              workspaceError={workspaceError}
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
              onInsertFileReference={insertFileReference}
              onCopyPath={path => void copyText(path)}
              onCopyText={value => void copyText(value)}
              onEditMessage={applyMessageToDraft}
              onRegenerateMessage={messageId => void regenerateFromMessage(messageId)}
              onResendMessage={messageId => void resendUserMessage(messageId)}
              onToggleMessageActivity={toggleMessageActivity}
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
