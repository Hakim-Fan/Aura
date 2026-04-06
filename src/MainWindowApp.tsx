import { useEffect, useMemo, useState, type MouseEvent as ReactMouseEvent } from 'react'
import { listen } from '@tauri-apps/api/event'
import { TrayIcon } from '@tauri-apps/api/tray'
import { Menu, MenuItem, Submenu } from '@tauri-apps/api/menu'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { invoke } from '@tauri-apps/api/core'
import { open } from '@tauri-apps/plugin-dialog'
import { AppSidebar } from './components/AppSidebar'
import { abortAgentTask, getAgentTask, respondToApproval, startAgentTask } from './lib/agent'
import {
  hydrateStorageFromAuraHome,
  loadSessions,
  loadSettings,
  saveSessions,
  saveSettings,
} from './lib/storage'
import { openSettingsWindow } from './lib/windows'
import {
  createSessionWorkspace,
  importAttachmentFromPath,
  openPathInDefaultApp,
  readImagePreview,
  readTextFile,
  readWorkspaceTree,
  writeAttachmentBytes,
} from './lib/workspace'
import type {
  AgentSettings,
  AgentTaskSnapshot,
  ChatContentPart,
  ChatMessage,
  MessageAttachment,
  MessageActivity,
  MessageEvent,
  ProviderProfile,
  ReasoningEffort,
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
  const activeProfile =
    settings.providerProfiles.find(profile => profile.id === settings.activeProviderProfileId) ||
    settings.providerProfiles[0] ||
    null
  const preferredModel =
    activeProfile?.models.some(model => model.enabled && model.id === settings.model)
      ? settings.model
      : activeProfile?.models.find(model => model.enabled)?.id || ''

  return {
    id: createId(),
    title: '新建聊天',
    providerProfileId: settings.activeProviderProfileId,
    provider: settings.provider,
    model: preferredModel,
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
  return nodes.reduce((total, node) => {
    const normalizedSummary = node.summary.trim().toLowerCase()
    const isGenericSummary =
      !normalizedSummary ||
      normalizedSummary === 'primary agent task' ||
      normalizedSummary === '生成最终回答' ||
      normalizedSummary === 'generate final answer'
    const nestedCount = countTaskNodes(node.children)

    if (node.kind === 'main' && isGenericSummary) {
      return total + nestedCount
    }

    return total + 1 + nestedCount
  }, 0)
}

function prettifyIdentifier(identifier: string) {
  return identifier
    .split(/[_-]+/)
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

const imageExtensions = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'])
const textPreviewExtensions = new Set([
  'md',
  'txt',
  'json',
  'js',
  'jsx',
  'ts',
  'tsx',
  'html',
  'css',
  'scss',
  'less',
  'yaml',
  'yml',
  'toml',
  'rs',
  'py',
  'java',
  'go',
  'rb',
  'sh',
  'zsh',
  'bash',
  'xml',
  'csv',
  'sql',
])

function getFileExtension(filePath: string) {
  return filePath.split('.').at(-1)?.toLowerCase() || ''
}

function canPreviewAsText(filePath: string) {
  return textPreviewExtensions.has(getFileExtension(filePath))
}

function mimeTypeFromPath(filePath: string) {
  switch (getFileExtension(filePath)) {
    case 'png':
      return 'image/png'
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg'
    case 'gif':
      return 'image/gif'
    case 'webp':
      return 'image/webp'
    case 'bmp':
      return 'image/bmp'
    case 'svg':
      return 'image/svg+xml'
    case 'pdf':
      return 'application/pdf'
    default:
      return ''
  }
}

function mimeTypeFromDataUrl(dataUrl?: string) {
  const match = /^data:([^;,]+)[;,]/u.exec(dataUrl || '')
  return match?.[1] || ''
}

function resolveAttachmentMimeType(attachment: {
  mimeType?: string
  path?: string
  preview?: string
}) {
  return (
    attachment.mimeType ||
    mimeTypeFromDataUrl(attachment.preview) ||
    (attachment.path ? mimeTypeFromPath(attachment.path) : '')
  )
}

function isImageAttachment(attachment: {
  mimeType?: string
  path?: string
  preview?: string
}) {
  return resolveAttachmentMimeType(attachment).startsWith('image/')
}

function buildUserMessageParts(
  content: string,
  attachments: MessageAttachment[],
): ChatContentPart[] {
  const normalizedContent = content.trim()
  const imageAttachments = attachments.filter(attachment => isImageAttachment(attachment))
  const fileAttachments = attachments.filter(attachment => !isImageAttachment(attachment))
  const promptText =
    normalizedContent ||
    `请分析这${attachments.length > 1 ? '些' : '个'}附件。`
  const attachmentContextParts = []

  if (imageAttachments.length > 0) {
    attachmentContextParts.push(
      `这些图片已经作为视觉输入直接提供给你，请优先基于图片内容回答，不要把 PNG/JPG 文件当纯文本读取。${fileAttachments.length > 0 ? '如果还附带了普通文件，可按需读取它们。' : ''
      }`,
    )
    attachmentContextParts.push(
      `图片文件路径（仅供必要时引用，不必默认读取）:\n${imageAttachments
        .map(attachment => `- ${attachment.path}`)
        .join('\n')}`,
    )
  }

  if (fileAttachments.length > 0) {
    attachmentContextParts.push(
      `当前工作区还附加了以下可读取文件：\n${fileAttachments
        .map(attachment => `- ${attachment.path}`)
        .join('\n')}`,
    )
  }

  const attachmentContext =
    attachmentContextParts.length > 0
      ? `\n\n${attachmentContextParts.join('\n\n')}`
      : ''

  const parts: ChatContentPart[] = [
    {
      type: 'text',
      text: `${promptText}${attachmentContext}`,
    },
  ]

  for (const attachment of attachments) {
    const mimeType = resolveAttachmentMimeType(attachment)
    if (
      mimeType.startsWith('image/') &&
      attachment.preview?.startsWith('data:')
    ) {
      parts.push({
        type: 'image',
        name: attachment.name,
        mimeType,
        path: attachment.path,
        dataUrl: attachment.preview,
      })
      continue
    }

    parts.push({
      type: 'file',
      name: attachment.name,
      path: attachment.path,
      mimeType: mimeType || undefined,
    })
  }

  return parts
}

type DraftAttachment = {
  id: string
  name: string
  path?: string
  preview?: string
  mimeType?: string
  file?: File
}

function extensionFromMimeType(mimeType: string) {
  switch (mimeType) {
    case 'image/png':
      return 'png'
    case 'image/jpeg':
      return 'jpg'
    case 'image/gif':
      return 'gif'
    case 'image/webp':
      return 'webp'
    case 'image/bmp':
      return 'bmp'
    case 'image/svg+xml':
      return 'svg'
    case 'application/pdf':
      return 'pdf'
    default:
      return ''
  }
}

function guessAttachmentName(file: File, fallbackPrefix = 'attachment') {
  if (file.name.trim()) {
    return file.name
  }
  const extension = extensionFromMimeType(file.type)
  return extension ? `${fallbackPrefix}.${extension}` : fallbackPrefix
}

function arrayBufferToBase64(buffer: ArrayBuffer) {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  const chunkSize = 0x8000
  for (let index = 0; index < bytes.length; index += chunkSize) {
    const chunk = bytes.subarray(index, index + chunkSize)
    binary += String.fromCharCode(...chunk)
  }
  return btoa(binary)
}

async function createDraftAttachmentFromFile(file: File): Promise<DraftAttachment> {
  const name = guessAttachmentName(file, `pasted-${Date.now()}`)
  let preview = ''

  if (file.type.startsWith('image/')) {
    preview = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '')
      reader.onerror = () => reject(reader.error)
      reader.readAsDataURL(file)
    })
  }

  return {
    id: createId(),
    name,
    preview,
    mimeType: file.type || undefined,
    file,
  }
}

function getActiveProviderProfile(settings: AgentSettings) {
  return (
    settings.providerProfiles.find(profile => profile.id === settings.activeProviderProfileId) ||
    settings.providerProfiles[0] ||
    null
  )
}

function getFirstEnabledModelId(profile: ProviderProfile | null) {
  if (!profile) {
    return ''
  }
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
  return getFirstEnabledModelId(profile)
}

function getSessionProviderProfile(settings: AgentSettings, session: Session | null) {
  if (!session) {
    return getActiveProviderProfile(settings)
  }
  return (
    settings.providerProfiles.find(profile => profile.id === session.providerProfileId) ||
    settings.providerProfiles.find(
      profile =>
        profile.provider === session.provider &&
        profile.models.some(model => model.id === session.model),
    ) ||
    getActiveProviderProfile(settings)
  )
}

function collectEnabledModelsByProfile(settings: AgentSettings) {
  return settings.providerProfiles
    .filter(profile => profile.enabled)
    .map(profile => ({
      profileId: profile.id,
      profileName: profile.name,
      provider: profile.provider,
      models: profile.models.filter(model => model.enabled),
    }))
    .filter(group => group.models.length > 0)
}

function presentToolEventTitle(event: ToolEvent) {
  const rawName = event.name?.trim()
  if (!rawName) {
    return event.source === 'plugin' ? '技能' : '工具'
  }
  if (event.source === 'plugin') {
    const tail = rawName.split('__').filter(Boolean).at(-1) || rawName
    return prettifyIdentifier(tail)
  }
  if (event.source === 'subagent') {
    return rawName || '子 Agent'
  }
  if (rawName.toLowerCase().includes('shell')) {
    return 'Shell 命令'
  }
  return prettifyIdentifier(rawName)
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
    order: event.order,
    source: event.source,
    status:
      event.status === 'running'
        ? 'running'
        : event.status === 'error'
          ? 'error'
          : 'success',
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
    reasoning: [],
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

const SIDEBAR_WIDTH_KEY = 'desk-agent-main-sidebar-width'
const INSPECTOR_WIDTH_KEY = 'desk-agent-main-inspector-width'

function loadPaneWidth(storageKey: string, fallback: number, min: number, max: number) {
  const raw = localStorage.getItem(storageKey)
  const parsed = raw ? Number(raw) : Number.NaN
  if (!Number.isFinite(parsed)) {
    return fallback
  }
  return Math.max(min, Math.min(max, parsed))
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
  const [previewImage, setPreviewImage] = useState('')
  const [previewLoading, setPreviewLoading] = useState(false)
  const [previewError, setPreviewError] = useState('')
  const [draftAttachments, setDraftAttachments] = useState<DraftAttachment[]>([])
  const [storageReady, setStorageReady] = useState(false)
  const [sidebarWidth, setSidebarWidth] = useState(() =>
    loadPaneWidth(SIDEBAR_WIDTH_KEY, 260, 220, 420),
  )
  const [inspectorWidth, setInspectorWidth] = useState(() =>
    loadPaneWidth(INSPECTOR_WIDTH_KEY, 360, 280, 640),
  )

  useEffect(() => {
    let cancelled = false

    void (async () => {
      try {
        const hydrated = await hydrateStorageFromAuraHome()
        if (cancelled) {
          return
        }
        setSettings(hydrated.settings)
        setSessions(hydrated.sessions)
      } catch (caught) {
        if (!cancelled) {
          setError(caught instanceof Error ? caught.message : '初始化 Aura 目录失败。')
        }
      } finally {
        if (!cancelled) {
          setStorageReady(true)
        }
      }
    })()

    return () => {
      cancelled = true
    }
  }, [])

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
    agentTask ? agentTask.toolEvents : activeSession?.toolEvents || []

  const displayedTaskTree =
    agentTask ? agentTask.taskTree : activeSession?.taskTree || []

  const activeWorkspacePath =
    activeSession?.workspacePath || activeSession?.workspaceRoot || ''
  const activeProviderProfile = getSessionProviderProfile(settings, activeSession)
  const effectiveProvider = activeProviderProfile?.provider || settings.provider
  const effectiveModel =
    activeSession?.model ||
    resolvePreferredModelId(activeProviderProfile, settings.model) ||
    settings.model
  const enabledModelGroups = collectEnabledModelsByProfile(settings)

  useEffect(() => {
    if (!storageReady) {
      return
    }
    saveSessions(sessions)
  }, [sessions, storageReady])

  useEffect(() => {
    localStorage.setItem(SIDEBAR_WIDTH_KEY, String(sidebarWidth))
  }, [sidebarWidth])

  useEffect(() => {
    localStorage.setItem(INSPECTOR_WIDTH_KEY, String(inspectorWidth))
  }, [inspectorWidth])

  useEffect(() => {
    if (!storageReady) return

    let cancelled = false;
    let currentMenu: Menu | null = null;

    async function updateTray() {
      try {
        const historyItems = await Promise.all(
          sessions.slice(0, 10).map(s =>
            MenuItem.new({
              text: s.title || '新会话',
              action: async () => {
                const win = await getCurrentWindow()
                await win.show()
                await win.setFocus()
                setActiveSessionId(s.id)
              },
            })
          )
        )

        const historyMenu = await Submenu.new({
          text: '会话历史',
          items: [
            ...historyItems,
            await MenuItem.new({
              text: '更多...',
              action: async () => {
                const win = await getCurrentWindow()
                await win.show()
                await win.setFocus()
              },
            }),
          ],
        })

        const menu = await Menu.new({
          items: [
            await MenuItem.new({
              text: '显示 Aura',
              action: async () => {
                const win = await getCurrentWindow()
                await win.show()
                await win.setFocus()
              },
            }),
            await MenuItem.new({
              text: '快速开始',
              action: async () => {
                const win = await getCurrentWindow()
                await win.show()
                await win.setFocus()
                const newSess = createSession(settings)
                setSessions(cur => [newSess, ...cur])
                setActiveSessionId(newSess.id)
              },
            }),
            historyMenu,
            await MenuItem.new({
              text: '设置',
              action: async () => {
                await openSettingsWindow()
              },
            }),
            await MenuItem.new({
              text: '退出 Aura',
              action: async () => {
                await invoke('quit_app')
              },
            }),
          ],
        })

        if (cancelled) return
        currentMenu = menu

        const existingTray = await TrayIcon.getById('main-tray')
        if (existingTray) {
          await existingTray.setMenu(menu)
        } else {
          await TrayIcon.new({
            id: 'main-tray',
            menu,
            action: async (event) => {
              // optional left click action on tray itself could toggle window
            }
          })
        }
      } catch (err) {
        console.error('Failed to update Tray menu:', err)
      }
    }

    updateTray()

    return () => {
      cancelled = true
      // Tauri 2 beta doesn't strictly require menu closing in garbage collected envs, but good practice.
      if (currentMenu && typeof currentMenu.close === 'function') {
        currentMenu.close().catch(console.error)
      }
    }
  }, [sessions, settings, storageReady])

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
                reasoning: snapshot.reasoning || message.reasoning,
                usage: snapshot.usage || message.usage,
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
                        order:
                          (snapshot.toolEvents
                            .map(event => event.order || 0)
                            .reduce((max, value) => Math.max(max, value), 0) || 0) + 1,
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
                          reasoning: snapshot.reasoning || message.reasoning,
                          usage: snapshot.usage || message.usage,
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
                          reasoning: snapshot.reasoning || message.reasoning,
                          usage: snapshot.usage || message.usage,
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
    const timer = window.setInterval(() => void poll(), 250)
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
      setPreviewImage('')
      setPreviewError('')
      return
    }

    const filePath = selectedFilePath
    let cancelled = false

    async function loadPreview() {
      setPreviewLoading(true)
      setPreviewImage('')
      setPreviewContent('')
      setPreviewError('')
      try {
        const imageData = await readImagePreview(filePath)
        if (cancelled) {
          return
        }

        if (imageData) {
          setPreviewImage(imageData)
          return
        }

        if (!canPreviewAsText(filePath)) {
          return
        }

        const content = await readTextFile(filePath)
        if (!cancelled) {
          setPreviewContent(content)
        }
      } catch (caught) {
        if (!cancelled) {
          setPreviewContent('')
          setPreviewImage('')
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
    if (activeSession?.messages.length) {
      setError('当前会话已经有消息记录，工作区已锁定。请新建会话后再切换目录。')
      return
    }

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

  async function appendAttachmentsFromPaths(paths: string[]) {
    const nextAttachments = await Promise.all(
      paths.map(async path => {
        let preview = ''
        try {
          preview = (await readImagePreview(path)) || ''
        } catch {
          preview = ''
        }

        return {
          id: createId(),
          name: path.split('/').pop() || '附件',
          path,
          preview,
          mimeType: mimeTypeFromDataUrl(preview) || mimeTypeFromPath(path) || undefined,
        } satisfies DraftAttachment
      }),
    )

    setDraftAttachments(current => {
      const existingPaths = new Set(current.map(attachment => attachment.path).filter(Boolean))
      const deduped = nextAttachments.filter(
        attachment => !attachment.path || !existingPaths.has(attachment.path),
      )
      return [...current, ...deduped]
    })
  }

  async function appendAttachmentsFromFiles(files: File[]) {
    if (files.length === 0) {
      return
    }

    const nextAttachments = await Promise.all(files.map(file => createDraftAttachmentFromFile(file))).catch(
      caught => {
        setError(caught instanceof Error ? caught.message : '读取剪贴板附件失败。')
        return null
      },
    )
    if (!nextAttachments) {
      return
    }
    setDraftAttachments(current => {
      const existingSignatures = new Set(
        current
          .filter(attachment => attachment.file)
          .map(attachment =>
            `${attachment.file?.name || attachment.name}:${attachment.file?.size || 0}:${attachment.file?.lastModified || 0}`,
          ),
      )
      const deduped = nextAttachments.filter(attachment => {
        const file = attachment.file
        if (!file) {
          return true
        }
        const signature = `${file.name}:${file.size}:${file.lastModified}`
        return !existingSignatures.has(signature)
      })
      return [...current, ...deduped]
    })
  }

  async function chooseAttachmentForDraft() {
    const selected = await open({
      directory: false,
      multiple: true,
      title: '选择要引用的附件',
    })

    if (!selected) {
      return
    }

    const paths = Array.isArray(selected) ? selected : [selected]
    await appendAttachmentsFromPaths(paths)
  }

  function removeDraftAttachment(attachmentId: string) {
    setDraftAttachments(current =>
      current.filter(attachment => attachment.id !== attachmentId),
    )
  }

  function createFreshSession() {
    const latestSettings = loadSettings()
    setSettings(latestSettings)
    const next = createSession(latestSettings)
    setSessions(current => [next, ...current])
    setActiveSessionId(next.id)
    setDraft('')
    setDraftAttachments([])
    setError('')
  }

  function openSession(sessionId: string) {
    setActiveSessionId(sessionId)
    setDraftAttachments([])
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
      setDraftAttachments([])
      setError('')
      setSelectedFilePath(null)
      setPreviewContent('')
      setPreviewImage('')
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
    if ((!content && draftAttachments.length === 0) || isRunning || !activeSession) {
      return
    }
    if (!settings.apiKey.trim()) {
      setError('请先在设置窗口里完成 Provider 配置。')
      await openSettingsWindow('providers').catch(caught => {
        setError(caught instanceof Error ? caught.message : '打开设置窗口失败。')
      })
      return
    }

    const workspaceHint =
      content || draftAttachments[0]?.name || activeSession.title
    const workspacePath = await ensureSessionWorkspace(activeSession, workspaceHint).catch(caught => {
      setError(caught instanceof Error ? caught.message : '创建会话工作目录失败。')
      return ''
    })

    if (!workspacePath) {
      return
    }

    const materializedAttachments = await Promise.all(
      draftAttachments.map(async attachment => {
        const path = attachment.path
          ? await importAttachmentFromPath(workspacePath, attachment.path)
          : await writeAttachmentBytes(
            workspacePath,
            attachment.name,
            arrayBufferToBase64(await attachment.file!.arrayBuffer()),
          )

        return {
          id: attachment.id,
          name: attachment.name,
          path,
          preview: attachment.preview,
          mimeType: resolveAttachmentMimeType(attachment) || undefined,
        } satisfies MessageAttachment
      }),
    ).catch(caught => {
      setError(caught instanceof Error ? caught.message : '导入附件到当前会话失败。')
      return null
    })

    if (!materializedAttachments) {
      return
    }

    const contentForDisplay =
      content ||
      `已附加 ${materializedAttachments.length} 个附件：${materializedAttachments
        .map(attachment => attachment.name)
        .join('、')}`
    const userMessageParts = buildUserMessageParts(content, materializedAttachments)

    const userMessage: ChatMessage = {
      id: createId(),
      role: 'user',
      content: contentForDisplay,
      parts: userMessageParts,
      status: 'completed',
      createdAt: Date.now(),
      attachments: materializedAttachments,
    }
    const pendingAssistantMessage = createPendingAssistantMessage()

    const runtimeSettings: AgentSettings = {
      ...settings,
      activeProviderProfileId: activeProviderProfile?.id || settings.activeProviderProfileId,
      provider: effectiveProvider,
      apiKey: activeProviderProfile?.apiKey || settings.apiKey,
      baseUrl: activeProviderProfile?.baseUrl || settings.baseUrl,
      model: effectiveModel,
      cwd: workspacePath,
    }

    const sessionId = activeSession.id
    const nextMessages = [...activeSession.messages, userMessage]
    updateSession(sessionId, session => ({
      ...session,
      title: session.messages.length === 0 ? summarizeTitle(content) : session.title,
      providerProfileId: activeProviderProfile?.id || session.providerProfileId,
      provider: effectiveProvider,
      model: effectiveModel,
      messages: [...nextMessages, pendingAssistantMessage],
      toolEvents: [],
      taskTree: [],
      workspacePath,
      updatedAt: Date.now(),
    }))
    setDraft('')
    setDraftAttachments([])
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
        reasoning: [],
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

  async function handleStopAgentTask() {
    if (!agentTask?.id) {
      return
    }
    try {
      await abortAgentTask(agentTask.id)
      setAgentTask(null)
      setRunningSessionId(null)
      setRunningMessageId(null)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '终止任务失败。')
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

  function switchSessionModel(profileId: string, modelId: string) {
    const profile = settings.providerProfiles.find(entry => entry.id === profileId)
    if (!activeSession || !profile) {
      return
    }

    const nextSettings: AgentSettings = {
      ...settings,
      activeProviderProfileId: profile.id,
      provider: profile.provider,
      apiKey: profile.apiKey,
      baseUrl: profile.baseUrl,
      model: modelId,
    }

    updateSession(activeSession.id, session => ({
      ...session,
      providerProfileId: profile.id,
      provider: profile.provider,
      model: modelId,
      updatedAt: Date.now(),
    }))
    setSettings(nextSettings)
    saveSettings(nextSettings)
  }

  function updateReasoningEffort(effort: ReasoningEffort) {
    const nextSettings: AgentSettings = {
      ...settings,
      reasoningEffort: effort,
    }
    setSettings(nextSettings)
    saveSettings(nextSettings)
  }

  const effectiveSettings: AgentSettings = {
    ...settings,
    activeProviderProfileId: activeProviderProfile?.id || settings.activeProviderProfileId,
    provider: effectiveProvider,
    apiKey: activeProviderProfile?.apiKey || settings.apiKey,
    baseUrl: activeProviderProfile?.baseUrl || settings.baseUrl,
    model: effectiveModel,
    cwd: activeWorkspacePath,
  }

  function handleSidebarResizeStart(event: ReactMouseEvent<HTMLDivElement>) {
    event.preventDefault()
    const startX = event.clientX
    const startWidth = sidebarWidth

    function handleMouseMove(moveEvent: MouseEvent) {
      const delta = moveEvent.clientX - startX
      setSidebarWidth(Math.max(220, Math.min(420, startWidth + delta)))
    }

    function handleMouseUp() {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }

    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
  }

  return (
    <>
      <div className="flex h-screen overflow-hidden bg-[var(--bg-app)]">
        <AppSidebar
          width={sidebarWidth}
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
        <div
          className="w-1 shrink-0 cursor-col-resize bg-transparent hover:bg-[rgba(79,123,116,0.18)] transition-colors"
          onMouseDown={handleSidebarResizeStart}
          title="拖动调整会话列表宽度"
        />

        <main className="flex-1 flex flex-col min-w-0">
          {activeSession ? (
            <ChatView
              messages={activeSession.messages}
              displayedToolEvents={displayedToolEvents}
              displayedTaskTree={displayedTaskTree}
              settings={effectiveSettings}
              draft={draft}
              error={error}
              isRunning={isRunning}
              agentTask={agentTask}
              workspaceRootPath={activeWorkspacePath}
              workspaceTree={workspaceTree}
              workspaceLoading={workspaceLoading}
              workspaceError={workspaceError}
              expandedPaths={expandedPaths}
              selectedFilePath={selectedFilePath}
              previewContent={previewContent}
              previewImage={previewImage}
              previewLoading={previewLoading}
              previewError={previewError}
              canChangeWorkspace={activeSession.messages.length === 0 && !isRunning}
              inspectorWidth={inspectorWidth}
              attachments={draftAttachments}
              modelGroups={enabledModelGroups}
              activeModelProfileId={activeProviderProfile?.id || ''}
              onDraftChange={setDraft}
              onSubmit={() => void submit()}
              onOpenProviders={() =>
                void openSettingsWindow('providers').catch(caught => {
                  setError(caught instanceof Error ? caught.message : '打开设置窗口失败。')
                })
              }
              onHandleApproval={decision => void handleApproval(decision)}
              onOpenWorkspaceExplorer={() => {
                if (activeWorkspacePath.trim() && !workspaceTree && !workspaceLoading) {
                  void refreshWorkspace()
                }
              }}
              onChooseWorkspace={() => void chooseExplicitWorkspaceForSession()}
              onPickAttachment={() => void chooseAttachmentForDraft()}
              onPasteAttachments={files => void appendAttachmentsFromFiles(files)}
              onSelectModel={(profileId, modelId) => switchSessionModel(profileId, modelId)}
              onSelectReasoningEffort={updateReasoningEffort}
              onOpenAttachment={path =>
                void openPathInDefaultApp(path).catch(caught => {
                  setError(caught instanceof Error ? caught.message : '打开文件失败。')
                })
              }
              onRefreshWorkspace={() => void refreshWorkspace()}
              onToggleWorkspacePath={toggleWorkspacePath}
              onSelectWorkspaceFile={setSelectedFilePath}
              onInsertFileReference={insertFileReference}
              onInspectorWidthChange={setInspectorWidth}
              onRemoveAttachment={removeDraftAttachment}
              onCopyPath={path => void copyText(path)}
              onCopyText={value => void copyText(value)}
              onEditMessage={applyMessageToDraft}
              onRegenerateMessage={messageId => void regenerateFromMessage(messageId)}
              onResendMessage={messageId => void resendUserMessage(messageId)}
              onToggleMessageActivity={toggleMessageActivity}
              onStop={() => void handleStopAgentTask()}
            />
          ) : (
            <HomeView
              sessions={sessions}
              providerConfigured={Boolean(
                activeProviderProfile?.apiKey.trim() && getFirstEnabledModelId(activeProviderProfile),
              )}
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
