import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react'
import { listen } from '@tauri-apps/api/event'
import { TrayIcon } from '@tauri-apps/api/tray'
import { Menu, MenuItem, Submenu } from '@tauri-apps/api/menu'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { invoke } from '@tauri-apps/api/core'
import { open } from '@tauri-apps/plugin-dialog'
import { AppSidebar } from './components/AppSidebar'
import {
  abortAgentTask,
  appendInputToAgentTask,
  buildRuntimeMessagesWithContextCompression,
  cancelAgentTaskStep,
  compressAgentContext,
  getAgentTask,
  releaseAgentTask,
  respondToApproval,
  startAgentTask,
} from './lib/agent'
import { ensureAuraHome, type AuraHomeState } from './lib/aura'
import { builtinPlugins, builtinSkills } from './catalog'
import {
  hydrateStorageFromAuraHome,
  isSessionMessagesLoaded,
  loadDeletedSessions,
  loadSessionMessages,
  loadSessions,
  loadSessionFolders,
  loadSettings,
  purgeSessionFromTrash,
  resolveCapabilitiesForWorkspace,
  restoreSessionFromTrash,
  searchSessionIds,
  saveSessionFolders,
  saveSessions,
  saveSessionsAndAwaitPersistence,
  saveSettings,
} from './lib/storage'
import {
  compactMessageEvent,
  compactToolEventPayload,
  readMessageEventDetailPayload,
  stripMessageEventDetail,
} from './lib/eventCompaction'
import {
  loadPersistedMessageEventDetail,
  upsertPersistedMessageEventDetails,
} from './lib/persistence'
import { openSettingsWindow } from './lib/windows'
import {
  createSessionWorkspace,
  deleteWorkspaceDirectory,
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
  ApprovalDecision,
  ApprovalRequest,
  AppendedInput,
  CapabilityOverrideMode,
  CapabilityPanelItem,
  ChatContentPart,
  ChatMessage,
  ChatMessageVariant,
  MessageEventDetailPayload,
  MessageAttachment,
  MessageActivity,
  MessageEvent,
  MessagePhaseOutput,
  MessageModelInfo,
  MessageReasoning,
  ProviderProfile,
  ProviderRetryInfo,
  ReasoningEffort,
  ResearchMode,
  Session,
  SessionContextCompression,
  SessionFolder,
  TaskNode,
  ToolEvent,
  WorkspaceCapabilityOverrides,
  WorkspaceNode,
} from './types'
import { ChatView } from './views/ChatView'
import { HomeView } from './views/HomeView'
import { checkForUpdates, type ReleaseInfo } from './lib/updater'
import { UpdateModal } from './components/UpdateModal'
import { getVersion } from '@tauri-apps/api/app'
import { sortSessionsByRecentActivity } from './lib/sessionMeta'
import { setRendererLogContext } from './lib/logging'
import {
  generateSessionTitle as generateSessionTitleWithProvider,
  type TitleGenerationContext,
} from './lib/provider'

function createId() {
  return Math.random().toString(36).slice(2, 10)
}

function randomIdPart(length = 8) {
  return Math.random().toString(36).slice(2, 2 + length)
}

function timestampIdPart(includeSeconds = false) {
  const now = new Date()
  const pad = (value: number) => String(value).padStart(2, '0')
  const parts = [
    pad(now.getFullYear() % 100),
    pad(now.getMonth() + 1),
    pad(now.getDate()),
    pad(now.getHours()),
    pad(now.getMinutes()),
  ]
  if (includeSeconds) {
    parts.push(pad(now.getSeconds()))
  }
  return parts.join('')
}

function createSessionId() {
  return `${timestampIdPart()}-${randomIdPart()}`
}

function createMessageGroupId(sessionId: string) {
  return `${sessionId}-grp_${randomIdPart(6)}`
}

function createVersionMessageId(groupId: string) {
  return `${groupId}-msg_${randomIdPart(6)}`
}

function getMessageGroupId(message: Pick<ChatMessage, 'id' | 'groupId'>) {
  return message.groupId || message.id
}

const MANUAL_CONTEXT_COMPRESSION_KEEP_RECENT_MESSAGES = 6

function clearRetryProgressInfo(retryInfo?: ProviderRetryInfo): ProviderRetryInfo | undefined {
  if (!retryInfo) {
    return undefined
  }

  return {
    ...retryInfo,
    inProgress: false,
    nextRetryDelayMs: undefined,
    nextAttemptNumber: undefined,
  }
}

function findCompressedThroughIndex(session: Session) {
  const compressedThroughMessageId = session.contextCompression?.compressedThroughMessageId
  if (!compressedThroughMessageId) {
    return -1
  }
  return session.messages.findIndex(message => message.id === compressedThroughMessageId)
}

function shouldInvalidateContextCompressionForMessage(session: Session, messageId: string) {
  if (!session.contextCompression) {
    return false
  }
  const changedIndex = session.messages.findIndex(message => message.id === messageId)
  const compressedThroughIndex = findCompressedThroughIndex(session)
  return changedIndex !== -1 && compressedThroughIndex !== -1 && changedIndex <= compressedThroughIndex
}

function normalizeTaskContextCompression(
  session: Session,
  compression?: SessionContextCompression,
) {
  if (!compression) {
    return session.contextCompression
  }
  const summary = compression?.summary?.trim()
  const compressedThroughMessageId = compression?.compressedThroughMessageId?.trim()
  if (!summary || !compressedThroughMessageId) {
    return session.contextCompression
  }
  if (!session.messages.some(message => message.id === compressedThroughMessageId)) {
    return session.contextCompression
  }
  const numberField = (key: keyof SessionContextCompression) => {
    const raw = compression[key]
    return typeof raw === 'number' && Number.isFinite(raw)
      ? Math.max(0, Math.round(raw))
      : undefined
  }
  const stringField = (key: keyof SessionContextCompression) => {
    const raw = compression[key]
    return typeof raw === 'string' ? raw.trim() || undefined : undefined
  }

  return {
    id: compression.id?.trim() || createId(),
    summary,
    compressedThroughMessageId,
    originalMessageCount: Math.max(
      0,
      Math.round(Number(compression.originalMessageCount) || session.messages.length),
    ),
    originalTokenEstimate: Math.max(
      0,
      Math.round(Number(compression.originalTokenEstimate) || 0),
    ),
    compressedTokenEstimate: Math.max(
      0,
      Math.round(Number(compression.compressedTokenEstimate) || 0),
    ),
    createdAt: Math.max(0, Math.round(Number(compression.createdAt) || Date.now())),
    kind: stringField('kind'),
    trigger: stringField('trigger'),
    activePromptTokens: numberField('activePromptTokens'),
    activePromptLimit: numberField('activePromptLimit'),
    contextWindowTokens: numberField('contextWindowTokens'),
    configuredContextWindowTokens: numberField('configuredContextWindowTokens'),
    configuredThresholdTokens: numberField('configuredThresholdTokens'),
    compressionThresholdTokens: numberField('compressionThresholdTokens'),
    effectiveThresholdTokens: numberField('effectiveThresholdTokens'),
    systemPromptTokens: numberField('systemPromptTokens'),
    toolSchemaTokens: numberField('toolSchemaTokens'),
    maxOutputTokens: numberField('maxOutputTokens'),
    toolResultBufferTokens: numberField('toolResultBufferTokens'),
    summaryTokens: numberField('summaryTokens'),
    windowSource: stringField('windowSource'),
    preserved: Array.isArray(compression.preserved)
      ? compression.preserved
        .map(item => (typeof item === 'string' ? item.trim() : ''))
        .filter(Boolean)
        .slice(0, 8)
      : undefined,
    providerProfileId: compression.providerProfileId,
    model: compression.model,
  }
}

function getErrorMessage(caught: unknown, fallback: string) {
  if (caught instanceof Error && caught.message.trim()) {
    return caught.message
  }
  if (typeof caught === 'string' && caught.trim()) {
    return caught
  }
  if (
    caught &&
    typeof caught === 'object' &&
    'message' in caught &&
    typeof (caught as { message?: unknown }).message === 'string' &&
    (caught as { message: string }).message.trim()
  ) {
    return (caught as { message: string }).message
  }
  if (caught !== undefined && caught !== null) {
    try {
      const serialized = JSON.stringify(caught)
      if (serialized && serialized !== '{}' && serialized !== 'null') {
        return serialized
      }
    } catch {
      return String(caught)
    }
    return String(caught)
  }
  return fallback
}

function isAgentTaskNotFoundError(caught: unknown) {
  return getErrorMessage(caught, '').includes('Agent task not found')
}

function createSession(settings: AgentSettings): Session {
  const sessionId = createSessionId()
  const activeProfile =
    settings.providerProfiles.find(profile => profile.id === settings.activeProviderProfileId) ||
    settings.providerProfiles[0] ||
    null
  const preferredModel =
    activeProfile?.models.some(model => model.enabled && model.id === settings.model)
      ? settings.model
      : activeProfile?.models.find(model => model.enabled)?.id || ''

  return {
    id: sessionId,
    title: '新会话',
    providerProfileId: settings.activeProviderProfileId,
    provider: settings.provider,
    model: preferredModel,
    workspacePath: '',
    workspaceRoot: '',
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

function clipTitleContextText(value = '', limit = 500) {
  const compact = value
    .replace(/```[\s\S]*?```/g, block => `${block.slice(0, 260)}\n[代码块已截断]`)
    .replace(/\s+/g, ' ')
    .trim()
  if (!compact) {
    return ''
  }
  return compact.length > limit ? `${compact.slice(0, Math.max(0, limit - 3)).trim()}...` : compact
}

function pathBaseName(path = '') {
  return path.split(/[\\/]/).filter(Boolean).at(-1) || path
}

function collectMessageAttachmentHints(message: ChatMessage) {
  const hints = new Set<string>()
  for (const attachment of message.attachments || []) {
    const label = attachment.name || pathBaseName(attachment.path)
    if (label) {
      hints.add(`- ${label}`)
    }
  }
  for (const part of message.parts || []) {
    if ((part.type === 'file' || part.type === 'image') && (part.name || part.path)) {
      hints.add(`- ${part.name || pathBaseName(part.path || '')}`)
    }
  }
  return Array.from(hints)
}

function titleContextMessage(message: ChatMessage, limit: number) {
  const partText = (message.parts || [])
    .filter(part => part.type === 'text')
    .map(part => part.text)
    .join('\n')
  return {
    id: message.id,
    role: message.role,
    content: clipTitleContextText(message.content || partText, limit),
  }
}

function buildTitleGenerationContext(session: Session): TitleGenerationContext {
  const messages = session.messages
  const openingMessages = messages
    .filter(message => message.role === 'user')
    .slice(0, 2)
    .map(message => titleContextMessage(message, 500))
    .filter(message => message.content)
  const recentMessages = messages
    .slice(-8)
    .map(message => titleContextMessage(message, message.role === 'user' ? 600 : 420))
    .filter(message => message.content)
  const attachments = messages.flatMap(collectMessageAttachmentHints).slice(0, 12)

  return {
    currentTitle: session.title,
    compressedSummary: session.contextCompression?.summary
      ? clipTitleContextText(session.contextCompression.summary, 1200)
      : undefined,
    openingMessages,
    recentMessages,
    attachments,
  }
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
  const hasContent = content.trim().length > 0
  const imageAttachments = attachments.filter(attachment => isImageAttachment(attachment))
  const fileAttachments = attachments.filter(attachment => !isImageAttachment(attachment))
  const promptText = hasContent
    ? content
    : `请分析这${attachments.length > 1 ? '些' : '个'}附件。`
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
    if (mimeType.startsWith('image/')) {
      parts.push({
        type: 'image',
        name: attachment.name,
        mimeType,
        path: attachment.path,
        dataUrl: attachment.preview?.startsWith('data:') ? attachment.preview : undefined,
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

function stripInlineImageDataFromParts(parts: ChatContentPart[] = []) {
  return parts.map(part =>
    part.type === 'image'
      ? {
        ...part,
        dataUrl: undefined,
      }
      : part,
  )
}

function stripAttachmentPreviews(attachments: MessageAttachment[] = []) {
  return attachments.map(attachment => ({
    ...attachment,
    preview: undefined,
  }))
}

type DraftAttachment = {
  id: string
  name: string
  path?: string
  preview?: string
  mimeType?: string
  bytesBase64?: string
  file?: File
}

type ComposerState = {
  draft: string
  attachments: DraftAttachment[]
  researchMode: ResearchMode
}

type RunningTaskBinding = {
  taskId: string
  messageId: string
  variantIndex: number
}

type AgentTaskUpdateEvent = {
  taskId?: string
  sessionId?: string
  messageId?: string
  assistantMessageId?: string
  userMessageId?: string
  status?: string
  phase?: string
  eventType?: string
  terminal?: boolean
  updatedAt?: number
}

type ToastState = {
  id: number
  message: string
  tone: 'success' | 'error'
}

function createEmptyComposerState(): ComposerState {
  return {
    draft: '',
    attachments: [],
    researchMode: 'auto',
  }
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
  if (file.size > MAX_DRAFT_ATTACHMENT_BYTES) {
    throw new Error(`附件“${file.name || '未命名文件'}”过大，请通过文件路径添加。`)
  }

  const name = guessAttachmentName(file, `pasted-${Date.now()}`)
  const bytesBase64 = arrayBufferToBase64(await file.arrayBuffer())
  const preview = file.type.startsWith('image/')
    ? `data:${file.type || 'application/octet-stream'};base64,${bytesBase64}`
    : ''

  return {
    id: createId(),
    name,
    preview,
    mimeType: file.type || undefined,
    bytesBase64,
  }
}

async function materializeDraftAttachments(
  workspacePath: string,
  attachments: DraftAttachment[],
): Promise<MessageAttachment[]> {
  return Promise.all(
    attachments.map(async attachment => {
      const path = attachment.path
        ? await importAttachmentFromPath(workspacePath, attachment.path)
        : attachment.bytesBase64
          ? await writeAttachmentBytes(
            workspacePath,
            attachment.name,
            attachment.bytesBase64,
          )
          : attachment.file
            ? await writeAttachmentBytes(
              workspacePath,
              attachment.name,
              arrayBufferToBase64(await attachment.file.arrayBuffer()),
            )
            : await Promise.reject(
              new Error(`附件“${attachment.name}”缺少可写入的数据，请重新添加后再试。`),
            )

      return {
        id: attachment.id,
        name: attachment.name,
        path,
        preview: attachment.preview,
        mimeType: resolveAttachmentMimeType(attachment) || undefined,
      } satisfies MessageAttachment
    }),
  )
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

function providerModeRequiresApiKey(provider?: string) {
  return provider !== 'custom'
}

function providerRequiresApiKey(profile: ProviderProfile | null) {
  return providerModeRequiresApiKey(profile?.provider)
}

function isProviderReady(profile: ProviderProfile | null, fallbackSettings?: AgentSettings) {
  if (!profile || !getFirstEnabledModelId(profile)) {
    return false
  }
  if (!providerRequiresApiKey(profile)) {
    return true
  }
  return Boolean(profile.apiKey.trim() || fallbackSettings?.apiKey.trim())
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
  if (
    profile.defaultModel &&
    profile.models.some(model => model.enabled && model.id === profile.defaultModel)
  ) {
    return profile.defaultModel
  }
  return getFirstEnabledModelId(profile)
}

function resolveTitleModelProfile(settings: AgentSettings) {
  const profileId = settings.titleProviderProfileId.trim()
  const modelId = settings.titleModel.trim()
  if (!profileId || !modelId) {
    return null
  }

  const profile =
    settings.providerProfiles.find(entry => entry.id === profileId && entry.enabled) || null
  if (!profile) {
    return null
  }

  const modelEnabled = profile.models.some(model => model.enabled && model.id === modelId)
  return modelEnabled ? { profile, modelId } : null
}

function buildMessageModelInfo(
  profile: ProviderProfile | null,
  modelId: string,
): MessageModelInfo | undefined {
  if (!profile || !modelId.trim()) {
    return undefined
  }

  return {
    providerProfileId: profile.id,
    providerProfileName: profile.name,
    provider: profile.provider,
    modelId,
    label: modelId.split('/').filter(Boolean).at(-1) || modelId,
  }
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
    return event.source === 'plugin' ? '插件' : '工具'
  }
  if (event.source === 'plugin') {
    const tail = rawName.split('__').filter(Boolean).at(-1) || rawName
    return prettifyIdentifier(tail)
  }
  if (event.source === 'subagent') {
    return rawName || 'Multi-Agent'
  }
  if (rawName.toLowerCase().includes('shell')) {
    return 'Shell 命令'
  }
  return prettifyIdentifier(rawName)
}

const EDITING_TOOL_NAMES = new Set([
  'apply_patch',
  'write_file',
  'edit_file',
  'multi_edit_file',
  'replace_line_range',
  'exec_command',
  'run_shell',
  'write_stdin',
])

function firstEditingPathFromStructuredOutput(output?: Record<string, unknown>) {
  if (!output) {
    return ''
  }
  if (typeof output.path === 'string' && output.path.trim()) {
    return output.path.trim()
  }
  const pathList = [
    ...(Array.isArray(output.affectedPaths) ? output.affectedPaths : []),
    ...(Array.isArray(output.paths) ? output.paths : []),
  ].filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
  if (pathList.length > 0) {
    return pathList[0].trim()
  }
  const files = Array.isArray(output.files)
    ? output.files
    : Array.isArray(output.preview)
      ? output.preview
      : []
  const file = files.find(entry => entry && typeof entry === 'object') as
    | Record<string, unknown>
    | undefined
  return typeof file?.path === 'string' && file.path.trim()
    ? file.path.trim()
    : typeof file?.relativePath === 'string' && file.relativePath.trim()
      ? file.relativePath.trim()
      : ''
}

function presentEditingEventTitle(event: ToolEvent, structuredOutput?: Record<string, unknown>) {
  if (!EDITING_TOOL_NAMES.has(event.name)) {
    return ''
  }
  const isShellFileMutation =
    structuredOutput?.operation === 'shell_file_mutation' ||
    structuredOutput?.stage === 'shell_file_mutation'
  if (
    !isShellFileMutation &&
    (event.name === 'exec_command' || event.name === 'run_shell' || event.name === 'write_stdin')
  ) {
    return ''
  }
  const path = firstEditingPathFromStructuredOutput(structuredOutput)
  if (event.status === 'running') {
    return path ? `正在写入 ${path}` : '正在写入文件'
  }
  if (event.status === 'error') {
    return path ? `写入失败 ${path}` : '文件写入失败'
  }
  return path ? `已写入 ${path}` : '文件写入完成'
}

function mapToolEventToMessageEvent(
  event: ToolEvent,
  options: { lazyDetails?: boolean } = {},
): MessageEvent {
  const compactPayload = compactToolEventPayload(event)
  const kind =
    event.source === 'subagent'
      ? 'subagent'
      : event.name.toLowerCase().includes('shell')
        ? 'shell'
        : 'tool'

  const messageEvent: MessageEvent = {
    id: event.id,
    kind,
    title: presentEditingEventTitle(event, compactPayload.structuredOutput) || presentToolEventTitle(event),
    summary: event.summary,
    toolName: event.name,
    order: event.order,
    source: event.source,
    status:
      event.status === 'running'
        ? 'running'
        : event.status === 'error'
          ? 'error'
          : 'success',
    startedAt: event.startedAt,
    finishedAt: event.finishedAt,
    durationMs: event.durationMs,
    input: compactPayload.input,
    output: compactPayload.output,
    structuredOutput: compactPayload.structuredOutput,
    error: compactPayload.error,
    errorInfo: event.errorInfo,
  }
  return options.lazyDetails ? stripMessageEventDetail(messageEvent) : messageEvent
}

function approvalCategoryLabel(category?: string) {
  switch (category) {
    case 'shell':
      return 'Shell 命令'
    case 'file_write':
      return '文件写入'
    case 'external_file_read':
      return '外部文件读取'
    case 'external_file_write':
      return '外部文件写入'
    case 'computer_use':
      return 'Computer Use'
    case 'plan':
      return '执行计划'
    default:
      return '工具执行'
  }
}

function formatCompactTokenCount(value?: number) {
  const safe = Math.max(0, Math.round(Number(value) || 0))
  if (safe >= 1000) {
    return `${(safe / 1000).toFixed(safe >= 10000 ? 0 : 1)}k`
  }
  return String(safe)
}

function contextCompressionEvent(snapshot: AgentTaskSnapshot): MessageEvent | null {
  const compression = snapshot.contextCompression
  if (!compression?.summary?.trim()) {
    return null
  }
  const before = compression.originalTokenEstimate
  const after = compression.compressedTokenEstimate
  const threshold =
    compression.activePromptLimit ||
    compression.effectiveThresholdTokens ||
    compression.compressionThresholdTokens ||
    compression.contextWindowTokens ||
    0
  const source =
    compression.windowSource === 'model_metadata'
      ? '模型配置'
      : compression.windowSource === 'settings'
        ? '本地设置'
        : compression.windowSource === 'inferred'
          ? '系统推断'
          : compression.windowSource || '未知'
  return {
    id: `context-compression-${compression.id}`,
    kind: 'tool',
    title: '上下文压缩',
    summary: [
      `已自动压缩上下文：${formatCompactTokenCount(before)} -> ${formatCompactTokenCount(after)}`,
      threshold ? `触发阈值：${formatCompactTokenCount(threshold)}` : null,
      `窗口来源：${source}`,
    ].filter(Boolean).join(' · '),
    toolName: 'context_compression',
    order: -98,
    source: 'builtin',
    status: 'success',
    output: JSON.stringify({
      kind: compression.kind,
      trigger: compression.trigger,
      activeContextTokensBefore: before,
      activeContextTokensAfter: after,
      activePromptLimit: compression.activePromptLimit,
      effectiveThresholdTokens: compression.effectiveThresholdTokens,
      contextWindowTokens: compression.contextWindowTokens,
      windowSource: compression.windowSource,
      preserved: compression.preserved,
    }, null, 2),
  }
}

function buildSnapshotMessageEvents(
  snapshot: AgentTaskSnapshot,
  options: { lazyDetails?: boolean } = {},
): MessageEvent[] {
  return [
    contextCompressionEvent(snapshot),
    ...snapshot.toolEvents.map(event => mapToolEventToMessageEvent(event, options)),
    ...(snapshot.pendingApproval
      ? [
        {
          id: snapshot.pendingApproval.id,
          kind: 'approval' as const,
          title: snapshot.pendingApproval.toolName,
          summary: `${approvalCategoryLabel(snapshot.pendingApproval.category)} · ${snapshot.pendingApproval.summary}`,
          order:
            (snapshot.toolEvents
              .map(event => event.order || 0)
              .reduce((max, value) => Math.max(max, value), 0) || 0) + 1,
          status: 'awaiting_approval' as const,
          input: snapshot.pendingApproval.input,
          output: snapshot.pendingApproval.output,
        },
      ]
      : []),
    ...(snapshot.pendingUserInput
      ? [
        {
          id: snapshot.pendingUserInput.id,
          kind: 'user_input' as const,
          title: '等待你的确认',
          summary: snapshot.pendingUserInput.question,
          order:
            (snapshot.toolEvents
              .map(event => event.order || 0)
              .reduce((max, value) => Math.max(max, value), 0) || 0) + 2,
          status: 'awaiting_user_input' as const,
          input: snapshot.pendingUserInput.context,
        },
      ]
      : []),
  ].filter((event): event is MessageEvent => Boolean(event))
}

function buildMessageEventDetailRecords(toolEvents: ToolEvent[]) {
  return toolEvents.flatMap(event => {
    const detail = readMessageEventDetailPayload(event)
    return detail ? [{ eventId: event.id, detail }] : []
  })
}

function buildSnapshotErrorMessage(
  snapshot: AgentTaskSnapshot,
  fallback = 'Agent 执行失败。',
) {
  const candidates = [
    snapshot.rawError,
    snapshot.errorInfo?.detail,
    snapshot.error,
    snapshot.errorInfo?.suggestedAction,
    snapshot.errorInfo?.summary,
    fallback,
  ]
  return candidates.find(value => typeof value === 'string' && value.trim())?.trim() || fallback
}

function shouldKeepActivityExpanded(status: AgentTaskSnapshot['status']) {
  return (
    status === 'queued' ||
    status === 'running' ||
    status === 'awaiting_approval' ||
    status === 'awaiting_user_input'
  )
}

function resolveActivityExpanded(
  status: AgentTaskSnapshot['status'],
  currentExpanded?: boolean,
) {
  if (!shouldKeepActivityExpanded(status)) {
    return false
  }
  return currentExpanded ?? true
}

function buildMessageActivity(
  status: AgentTaskSnapshot['status'],
  startedAt: number,
  toolEvents: ToolEvent[],
  taskTree: TaskNode[],
  runtimeStatus: Pick<
    AgentTaskSnapshot,
    'phase' | 'phaseStartedAt' | 'lastHeartbeatAt' | 'lastProgressAt' | 'stalled'
  > = {},
  expanded = resolveActivityExpanded(status),
): MessageActivity {
  return {
    status,
    startedAt,
    finishedAt: status === 'completed' || status === 'failed' ? Date.now() : undefined,
    toolCount: toolEvents.length,
    skillCount: 0,
    stepCount: countTaskNodes(taskTree),
    phase: runtimeStatus.phase,
    phaseStartedAt: runtimeStatus.phaseStartedAt,
    lastHeartbeatAt: runtimeStatus.lastHeartbeatAt,
    lastProgressAt: runtimeStatus.lastProgressAt,
    stalled: runtimeStatus.stalled,
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
    phaseOutputs: [],
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
      phase: 'preparing',
      phaseStartedAt: startedAt,
      lastHeartbeatAt: startedAt,
      lastProgressAt: startedAt,
      stalled: false,
      expanded: true,
    },
  }
}

const REPLAN_ARCHIVE_PREFIX = 'replan-archive'
const REPLAN_ARCHIVE_ORDER_OFFSET = 10_000
const AGENT_TASK_EVENT_SYNC_DEBOUNCE_MS = 180
const AGENT_TASK_FALLBACK_CHECK_INTERVAL_MS = 5_000
const AGENT_TASK_EVENT_STALE_MS = 15_000
const MAX_ARCHIVED_REASONING_ENTRIES = 2
const MAX_ARCHIVED_REASONING_CHARS = 1_200
const MAX_ARCHIVED_PHASE_OUTPUTS = 3
const MAX_ARCHIVED_PHASE_OUTPUT_CHARS = 1_600
const MAX_ARCHIVED_EVENTS = 6
const MAX_ARCHIVED_EVENT_INPUT_CHARS = 280
const MAX_ARCHIVED_EVENT_OUTPUT_CHARS = 360
const MAX_ARCHIVED_TASK_NODES = 12
const MAX_ARCHIVED_TASK_DEPTH = 2
const MAX_DRAFT_ATTACHMENT_BYTES = 12 * 1024 * 1024

function archiveExecutionId(kind: string, value: string) {
  return `${REPLAN_ARCHIVE_PREFIX}:${kind}:${value}`
}

function isArchivedExecutionId(value?: string) {
  return typeof value === 'string' && value.startsWith(`${REPLAN_ARCHIVE_PREFIX}:`)
}

function archiveExecutionOrder(order?: number) {
  return typeof order === 'number' ? order - REPLAN_ARCHIVE_ORDER_OFFSET : undefined
}

function truncateArchivedExecutionText(value?: string, maxLength = 0) {
  const normalized = typeof value === 'string' ? value.trim() : ''
  if (!normalized || !maxLength || normalized.length <= maxLength) {
    return normalized
  }
  return `${normalized.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`
}

function archiveReasoningEntries(entries: MessageReasoning[] = []): MessageReasoning[] {
  return entries.slice(-MAX_ARCHIVED_REASONING_ENTRIES).map(entry => ({
    ...entry,
    id: archiveExecutionId('reasoning', entry.id),
    content: truncateArchivedExecutionText(entry.content, MAX_ARCHIVED_REASONING_CHARS),
    order: archiveExecutionOrder(entry.order),
  }))
}

function archivePhaseOutputs(outputs: MessagePhaseOutput[] = []): MessagePhaseOutput[] {
  return outputs.slice(-MAX_ARCHIVED_PHASE_OUTPUTS).map(output => ({
    ...output,
    id: archiveExecutionId('phase-output', output.id),
    blockId: archiveExecutionId('phase-block', output.blockId),
    content: truncateArchivedExecutionText(output.content, MAX_ARCHIVED_PHASE_OUTPUT_CHARS),
    order: archiveExecutionOrder(output.order),
  }))
}

function archiveMessageEvents(events: MessageEvent[] = []): MessageEvent[] {
  return events.slice(-MAX_ARCHIVED_EVENTS).map(event => ({
    ...event,
    id: archiveExecutionId('event', event.id),
    summary: truncateArchivedExecutionText(event.summary, 220),
    input: truncateArchivedExecutionText(event.input, MAX_ARCHIVED_EVENT_INPUT_CHARS) || undefined,
    output:
      truncateArchivedExecutionText(event.output, MAX_ARCHIVED_EVENT_OUTPUT_CHARS) || undefined,
    error: truncateArchivedExecutionText(event.error, 220) || undefined,
    structuredOutput: undefined,
    order: archiveExecutionOrder(event.order),
  }))
}

function archiveTaskTreeNodes(nodes: TaskNode[] = []): TaskNode[] {
  let remainingNodes = MAX_ARCHIVED_TASK_NODES

  function cloneNode(node: TaskNode, depth: number): TaskNode | null {
    if (remainingNodes <= 0) {
      return null
    }
    remainingNodes -= 1
    const nextChildren =
      depth >= MAX_ARCHIVED_TASK_DEPTH
        ? []
        : node.children
          .map(child => cloneNode(child, depth + 1))
          .filter((child): child is TaskNode => Boolean(child))
    return {
      ...node,
      id: archiveExecutionId('task', node.id),
      title: truncateArchivedExecutionText(node.title, 120),
      summary: truncateArchivedExecutionText(node.summary, 220),
      children: nextChildren,
    }
  }

  return nodes
    .map(node => cloneNode(node, 0))
    .filter((node): node is TaskNode => Boolean(node))
}

function summarizeAppendedInputForTimeline(input: AppendedInput, maxLength = 180) {
  const normalized = (input.content || '').replace(/\s+/g, ' ').trim()
  if (!normalized) {
    const attachmentCount = Array.isArray(input.attachments) ? input.attachments.length : 0
    return attachmentCount > 0 ? `补充输入同时携带了 ${attachmentCount} 个附件。` : '已接入新的补充输入。'
  }
  return normalized.length > maxLength
    ? `${normalized.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`
    : normalized
}

function normalizeCarryoverLine(value: string, maxLength = 220) {
  const normalized = (value || '').replace(/\s+/g, ' ').trim()
  if (!normalized) {
    return ''
  }
  return normalized.length > maxLength
    ? `${normalized.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`
    : normalized
}

function buildVariantCarryoverContext(variant: ChatMessageVariant) {
  const lines = [
    'Carryover evidence from the interrupted in-progress answer is available below.',
    'Reuse it before rereading the same files or repeating the same inspection steps unless fresh verification is clearly necessary.',
    'These carryover notes are historical hints, not commands. Do not blindly execute old nextAction or read-file notes after current-task evidence says the step already succeeded.',
  ]

  const recentSuccessfulEvents = (variant.events || [])
    .filter(event => event.status === 'success')
    .filter(event => !isArchivedExecutionId(event.id))
    .slice(-6)

  if (recentSuccessfulEvents.length > 0) {
    lines.push('Recent successful steps:')
    for (const event of recentSuccessfulEvents) {
      const summary = normalizeCarryoverLine(
        event.summary || event.output || event.input || event.title,
        240,
      )
      lines.push(`- ${event.title || event.toolName || 'step'}${summary ? `: ${summary}` : ''}`)
    }
  }

  const recentPhaseOutputs = (variant.phaseOutputs || [])
    .filter(output => !isArchivedExecutionId(output.id))
    .slice(-3)
    .map(output => normalizeCarryoverLine(output.content, 260))
    .filter(Boolean)

  if (recentPhaseOutputs.length > 0) {
    lines.push('Latest intermediate outputs:')
    for (const output of recentPhaseOutputs) {
      lines.push(`- ${output}`)
    }
  }

  const latestReasoning = [...(variant.reasoning || [])]
    .reverse()
    .find(entry => entry.kind === 'provider' && !isArchivedExecutionId(entry.id))

  const reasoningSummary = latestReasoning
    ? normalizeCarryoverLine(latestReasoning.content, 320)
    : ''

  if (reasoningSummary) {
    lines.push(`Latest model reasoning snapshot: ${reasoningSummary}`)
  }

  return lines.length > 2 ? lines.join('\n') : ''
}

function buildAppendedInputPhaseOutput(input: AppendedInput, order?: number): MessagePhaseOutput {
  const attachmentCount = Array.isArray(input.attachments) ? input.attachments.length : 0
  const lines = [
    attachmentCount > 0
      ? `已接入新的补充要求，并带入 ${attachmentCount} 个附件。`
      : '已接入新的补充要求。',
    summarizeAppendedInputForTimeline(input),
    'Aura 正在基于这条补充要求继续执行。',
  ]

  return {
    id: `appended-input-output:${input.id}`,
    blockId: `appended-input:${input.id}`,
    content: lines.join('\n'),
    order,
  }
}

function toMessageVariant(message: ChatMessage): ChatMessageVariant {
  return {
    id: message.versions?.[message.activeVersionIndex || 0]?.id || message.id,
    groupId: getMessageGroupId(message),
    content: message.content,
    parts: message.parts,
    status: message.status,
    createdAt: message.createdAt,
    researchMode: message.researchMode,
    attachments: message.attachments,
    reasoning: message.reasoning,
    phaseOutputs: message.phaseOutputs,
    usage: message.usage,
    capabilitySnapshot: message.capabilitySnapshot,
    activity: message.activity,
    events: message.events,
    steps: message.steps,
    error: message.error,
    errorInfo: message.errorInfo,
    retryInfo: message.retryInfo,
    appendedInputs: message.appendedInputs,
    modelInfo: message.modelInfo,
    agentMode: message.agentMode,
    routeDecision: message.routeDecision,
    completionState: message.completionState,
    evidenceSummary: message.evidenceSummary,
    deliveryNote: message.deliveryNote,
  }
}

function getActiveMessageVariant(message: ChatMessage): ChatMessageVariant {
  const variants = ensureMessageVariants(message)
  const activeIndex =
    typeof message.activeVersionIndex === 'number'
      ? Math.max(0, Math.min(message.activeVersionIndex, variants.length - 1))
      : variants.length - 1
  return variants[activeIndex] || toMessageVariant(message)
}

function mergeEntriesById<T extends { id: string }>(existing: T[] = [], incoming: T[] = []): T[] {
  if (existing.length === 0) {
    return incoming
  }
  if (incoming.length === 0) {
    return existing
  }

  const merged = [...existing]
  const indexById = new Map(merged.map((entry, index) => [entry.id, index]))

  for (const entry of incoming) {
    const existingIndex = indexById.get(entry.id)
    if (typeof existingIndex === 'number') {
      merged[existingIndex] = entry
      continue
    }
    indexById.set(entry.id, merged.length)
    merged.push(entry)
  }

  return merged
}

function mergeMessageEvents(existing: MessageEvent[] = [], incoming: MessageEvent[] = []): MessageEvent[] {
  const preservedExisting = existing.filter(
    event => event.kind !== 'approval' || isArchivedExecutionId(event.id),
  )
  return mergeEntriesById(preservedExisting, incoming).map(compactMessageEvent)
}

function isInternalPlanTaskNode(node?: TaskNode) {
  if (!node) {
    return false
  }
  return (
    node.kind === 'classify' ||
    node.title === 'Understand goal and approved plan' ||
    node.title === 'Understand goal and execution constraints' ||
    node.title === '理解目标与执行约束'
  )
}

function filterVisibleTaskNodes(nodes: TaskNode[] = []): TaskNode[] {
  return nodes.flatMap(node => {
    if (isInternalPlanTaskNode(node)) {
      return []
    }
    return [
      {
        ...node,
        children: filterVisibleTaskNodes(node.children || []),
      },
    ]
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function parseJsonRecord(value?: string): Record<string, unknown> | null {
  if (!value?.trim()) {
    return null
  }
  try {
    const parsed = JSON.parse(value)
    return isRecord(parsed) ? parsed : null
  } catch {
    return null
  }
}

function readTextField(record: Record<string, unknown> | null | undefined, key: string) {
  const value = record?.[key]
  return typeof value === 'string' ? value.trim() : ''
}

const MAX_VISIBLE_TASK_TITLE_CHARS = 20

function compactVisibleTaskTitle(value: string, fallback = '') {
  const normalized = String(value || '').replace(/\s+/g, ' ').trim()
  const title = normalized || String(fallback || '').replace(/\s+/g, ' ').trim()
  if (!title) {
    return ''
  }
  if (title.length <= MAX_VISIBLE_TASK_TITLE_CHARS) {
    return title
  }
  return `${title.slice(0, Math.max(0, MAX_VISIBLE_TASK_TITLE_CHARS - 3))}...`
}

function readPlanApprovalSteps(approval?: ApprovalRequest): Array<Record<string, unknown>> {
  if (approval?.category !== 'plan') {
    return []
  }

  const preview = isRecord(approval.preview) ? approval.preview : null
  const input = parseJsonRecord(approval.input)
  const steps = preview?.subtasks || input?.subtasks
  return Array.isArray(steps)
    ? steps.filter((step): step is Record<string, unknown> => isRecord(step))
    : []
}

function taskTreeFromPlanApproval(approval?: ApprovalRequest): TaskNode[] {
  const steps = readPlanApprovalSteps(approval)
  if (steps.length === 0) {
    return []
  }

  const preview = isRecord(approval?.preview) ? approval.preview : null
  const input = parseJsonRecord(approval?.input)
  const planId =
    readTextField(preview, 'planId') ||
    readTextField(input, 'planId') ||
    approval?.id ||
    'approved-plan'
  const goal =
    readTextField(preview, 'goal') ||
    readTextField(input, 'goal') ||
    approval?.summary ||
    '执行计划'

  return [
    {
      id: `${planId}-task-tree-root`,
      title: goal,
      summary: '',
      kind: 'plan',
      status: 'running',
      children: steps.map((step, index) => ({
        id: readTextField(step, 'id') || `${planId}-approval-step-${index + 1}`,
        title: compactVisibleTaskTitle(
          readTextField(step, 'title') || readTextField(step, 'description'),
          `步骤 ${index + 1}`,
        ),
        summary: '',
        kind: (readTextField(step, 'kind') || 'plan_step') as TaskNode['kind'],
        status: index === 0 ? 'running' : 'queued',
        children: [],
      })),
    },
  ]
}

function resolveVisibleTaskTree(
  taskTree: TaskNode[] = [],
  approval?: ApprovalRequest,
): TaskNode[] {
  return taskTree.length > 0 ? taskTree : taskTreeFromPlanApproval(approval)
}

function mergeTaskTreeNode(existing: TaskNode, incoming: TaskNode): TaskNode {
  return {
    ...existing,
    ...incoming,
    children: mergeTaskTreeRoots(existing.children || [], incoming.children || []),
  }
}

function mergeTaskTreeRoots(existing: TaskNode[] = [], incoming: TaskNode[] = []): TaskNode[] {
  const visibleExisting = filterVisibleTaskNodes(existing)
  const visibleIncoming = filterVisibleTaskNodes(incoming)

  const existingHasPlanRoot = visibleExisting.some(node => node.kind !== 'main')
  const incomingNonMainRoots = visibleIncoming.filter(node => node.kind !== 'main')
  const normalizedIncoming =
    existingHasPlanRoot && incomingNonMainRoots.length > 0
      ? incomingNonMainRoots
      : existingHasPlanRoot && visibleIncoming.every(node => node.kind === 'main')
        ? []
        : visibleIncoming

  if (visibleExisting.length === 0) {
    return normalizedIncoming
  }
  if (normalizedIncoming.length === 0) {
    return visibleExisting
  }

  const merged = [...visibleExisting]
  const indexById = new Map(merged.map((node, index) => [node.id, index]))

  for (const node of normalizedIncoming) {
    const existingIndex = indexById.get(node.id)
    if (typeof existingIndex === 'number') {
      merged[existingIndex] = mergeTaskTreeNode(merged[existingIndex], node)
      continue
    }
    indexById.set(node.id, merged.length)
    merged.push(node)
  }

  return merged
}

function resolveMaxExecutionOrder(
  reasoning: MessageReasoning[] = [],
  phaseOutputs: MessagePhaseOutput[] = [],
  events: MessageEvent[] = [],
) {
  const orders = [
    ...reasoning.map(entry => entry.order).filter((value): value is number => typeof value === 'number'),
    ...phaseOutputs.map(entry => entry.order).filter((value): value is number => typeof value === 'number'),
    ...events.map(entry => entry.order).filter((value): value is number => typeof value === 'number'),
  ]
  return orders.length > 0 ? Math.max(...orders) : 0
}

function collectConsumedAppendedInputPhaseOutputs(options: {
  currentPhaseOutputs?: MessagePhaseOutput[]
  nextAppendedInputs?: AppendedInput[]
  reasoning?: MessageReasoning[]
  events?: MessageEvent[]
}) {
  const currentPhaseOutputs = options.currentPhaseOutputs || []
  const nextAppendedInputs = options.nextAppendedInputs || []
  const existingIds = new Set(currentPhaseOutputs.map(output => output.id))
  let nextOrder =
    resolveMaxExecutionOrder(
      options.reasoning || [],
      currentPhaseOutputs,
      options.events || [],
    ) + 0.1

  return nextAppendedInputs.flatMap(input => {
    if (input.status !== 'consumed') {
      return []
    }
    const outputId = `appended-input-output:${input.id}`
    if (existingIds.has(outputId)) {
      return []
    }
    existingIds.add(outputId)
    const output = buildAppendedInputPhaseOutput(input, nextOrder)
    nextOrder += 0.1
    return [output]
  })
}

function mergeExecutionArtifacts(
  currentVariant: ChatMessageVariant,
  snapshot: AgentTaskSnapshot,
  snapshotMessageEvents: MessageEvent[],
) {
  const reasoning = mergeEntriesById(
    currentVariant.reasoning || [],
    snapshot.reasoning || [],
  )
  const events = mergeMessageEvents(
    currentVariant.events || [],
    snapshotMessageEvents,
  )
  const basePhaseOutputs = mergeEntriesById(
    currentVariant.phaseOutputs || [],
    snapshot.phaseOutputs || [],
  )
  const appendedInputPhaseOutputs = collectConsumedAppendedInputPhaseOutputs({
    currentPhaseOutputs: basePhaseOutputs,
    nextAppendedInputs: snapshot.appendedInputs || currentVariant.appendedInputs,
    reasoning,
    events,
  })

  return {
    reasoning,
    events,
    phaseOutputs: mergeEntriesById(basePhaseOutputs, appendedInputPhaseOutputs),
    steps: mergeTaskTreeRoots(
      currentVariant.steps || [],
      snapshot.taskTree || [],
    ),
  }
}

function applyMessageVariant(
  message: ChatMessage,
  variants: ChatMessageVariant[],
  activeIndex: number,
): ChatMessage {
  const groupId = getMessageGroupId(message)
  const normalizedVariants = variants.map(variant => ({
    ...variant,
    groupId: variant.groupId || groupId,
  }))
  const safeIndex = Math.max(0, Math.min(activeIndex, normalizedVariants.length - 1))
  const activeVariant = normalizedVariants[safeIndex]

  return {
    ...message,
    groupId,
    content: activeVariant.content,
    parts: activeVariant.parts,
    status: activeVariant.status,
    createdAt: activeVariant.createdAt,
    researchMode: activeVariant.researchMode,
    attachments: activeVariant.attachments,
    reasoning: activeVariant.reasoning,
    phaseOutputs: activeVariant.phaseOutputs,
    usage: activeVariant.usage,
    capabilitySnapshot: activeVariant.capabilitySnapshot,
    activity: activeVariant.activity,
    events: activeVariant.events,
    steps: activeVariant.steps,
    error: activeVariant.error,
    errorInfo: activeVariant.errorInfo,
    retryInfo: activeVariant.retryInfo,
    appendedInputs: activeVariant.appendedInputs,
    modelInfo: activeVariant.modelInfo,
    agentMode: activeVariant.agentMode,
    routeDecision: activeVariant.routeDecision,
    completionState: activeVariant.completionState,
    evidenceSummary: activeVariant.evidenceSummary,
    deliveryNote: activeVariant.deliveryNote,
    versions: normalizedVariants,
    activeVersionIndex: safeIndex,
  }
}

function ensureMessageVariants(message: ChatMessage): ChatMessageVariant[] {
  if (message.versions && message.versions.length > 0) {
    return message.versions
  }
  return [toMessageVariant(message)]
}

function appendMessageVariant(
  message: ChatMessage,
  variant: ChatMessageVariant,
): ChatMessage {
  const variants = [...ensureMessageVariants(message), variant]
  return applyMessageVariant(message, variants, variants.length - 1)
}

function getMessageVariantId(message: ChatMessage, variantIndex?: number) {
  const variants = ensureMessageVariants(message)
  const safeIndex =
    typeof variantIndex === 'number'
      ? Math.max(0, Math.min(variantIndex, variants.length - 1))
      : typeof message.activeVersionIndex === 'number'
        ? Math.max(0, Math.min(message.activeVersionIndex, variants.length - 1))
        : variants.length - 1
  return variants[safeIndex]?.id || message.id
}

function retryInfoForSnapshot(snapshot: AgentTaskSnapshot) {
  const retryInfo = snapshot.retryInfo
  if (!retryInfo) {
    return undefined
  }
  if (snapshot.status === 'completed' || snapshot.status === 'failed') {
    return clearRetryProgressInfo(retryInfo)
  }
  if (
    retryInfo.inProgress === true &&
    (
      snapshot.phase === 'model_streaming' ||
      snapshot.phase === 'tool_running' ||
      snapshot.phase === 'finalizing' ||
      snapshot.phase === 'recovering'
    )
  ) {
    return clearRetryProgressInfo(retryInfo)
  }
  return retryInfo
}

function updateActiveMessageVariant(
  message: ChatMessage,
  updater: (variant: ChatMessageVariant) => ChatMessageVariant,
): ChatMessage {
  const variants = ensureMessageVariants(message)
  const activeIndex =
    typeof message.activeVersionIndex === 'number'
      ? Math.max(0, Math.min(message.activeVersionIndex, variants.length - 1))
      : variants.length - 1
  const nextVariants = [...variants]
  nextVariants[activeIndex] = updater(nextVariants[activeIndex] || toMessageVariant(message))
  return applyMessageVariant(message, nextVariants, activeIndex)
}

function updateMessageVariantAtIndex(
  message: ChatMessage,
  targetIndex: number,
  updater: (variant: ChatMessageVariant) => ChatMessageVariant,
): ChatMessage {
  const variants = ensureMessageVariants(message)
  const safeTargetIndex = Math.max(0, Math.min(targetIndex, variants.length - 1))
  const activeIndex =
    typeof message.activeVersionIndex === 'number'
      ? Math.max(0, Math.min(message.activeVersionIndex, variants.length - 1))
      : variants.length - 1
  const nextVariants = [...variants]
  nextVariants[safeTargetIndex] = updater(nextVariants[safeTargetIndex] || toMessageVariant(message))
  return applyMessageVariant(message, nextVariants, activeIndex)
}

function deleteActiveMessageVariant(message: ChatMessage): ChatMessage | null {
  const variants = ensureMessageVariants(message)
  if (variants.length <= 1) {
    return null
  }

  const activeIndex =
    typeof message.activeVersionIndex === 'number'
      ? Math.max(0, Math.min(message.activeVersionIndex, variants.length - 1))
      : variants.length - 1
  const nextVariants = variants.filter((_, index) => index !== activeIndex)
  const nextActiveIndex = Math.min(activeIndex, nextVariants.length - 1)
  return applyMessageVariant(message, nextVariants, nextActiveIndex)
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

const builtinSkillIds = new Set(builtinSkills.map(skill => skill.id))
const builtinPluginIds = new Set(builtinPlugins.map(plugin => plugin.id))

function createEmptyCapabilityOverrides(): WorkspaceCapabilityOverrides {
  return {
    skills: {},
    plugins: {},
    mcp: {},
  }
}

function updateCapabilityOverride(
  overrides: WorkspaceCapabilityOverrides | undefined,
  kind: 'skills' | 'plugins' | 'mcp',
  id: string,
  mode: CapabilityOverrideMode,
): WorkspaceCapabilityOverrides | undefined {
  const current = overrides || createEmptyCapabilityOverrides()
  const nextKindEntries = {
    ...current[kind],
  }

  if (mode === 'inherit') {
    delete nextKindEntries[id]
  } else {
    nextKindEntries[id] = mode
  }

  const nextOverrides: WorkspaceCapabilityOverrides = {
    ...current,
    [kind]: nextKindEntries,
  }
  const hasAnyOverrides =
    Object.keys(nextOverrides.skills).length > 0 ||
    Object.keys(nextOverrides.plugins).length > 0 ||
    Object.keys(nextOverrides.mcp).length > 0

  return hasAnyOverrides ? nextOverrides : undefined
}

function buildCapabilityPanelItems(
  aura: AuraHomeState | null,
  settings: AgentSettings,
  sessionOverrides: WorkspaceCapabilityOverrides | undefined,
): CapabilityPanelItem[] {
  const capabilityOverrides = sessionOverrides || createEmptyCapabilityOverrides()

  const skillItems = (aura?.skills || []).map(skill => ({
    id: skill.id,
    kind: 'skill' as const,
    name: skill.name,
    description: skill.description,
    source: builtinSkillIds.has(skill.id) ? ('builtin' as const) : ('user' as const),
    installed: true,
    supported: skill.supported,
    supportMessage: skill.supportMessage || undefined,
    path: skill.path || undefined,
    entryPath: skill.entryPath || undefined,
    readonly: skill.readonly,
    scope: skill.scope || (skill.external ? 'external' : 'global'),
    globalEnabled: settings.enabledSkillIds.includes(skill.id),
    sessionOverride: capabilityOverrides.skills[skill.id] || 'inherit',
    effectiveEnabled:
      capabilityOverrides.skills[skill.id] === 'on'
        ? true
        : capabilityOverrides.skills[skill.id] === 'off'
          ? false
          : settings.enabledSkillIds.includes(skill.id),
  }))
    .filter(skill => !builtinSkillIds.has(skill.id))
    .filter(skill => skill.globalEnabled || skill.sessionOverride !== 'inherit')

  const pluginItems = (aura?.plugins || []).map(plugin => ({
    id: plugin.id,
    kind: 'plugin' as const,
    name: plugin.name,
    description: plugin.description,
    source: builtinPluginIds.has(plugin.id) ? ('builtin' as const) : ('user' as const),
    installed: true,
    supported: plugin.supported,
    supportMessage: plugin.supportMessage || undefined,
    path: plugin.path || undefined,
    entryPath: plugin.entryPath || undefined,
    readonly: plugin.readonly,
    scope: plugin.scope || 'global',
    globalEnabled: settings.enabledPluginIds.includes(plugin.id),
    sessionOverride: capabilityOverrides.plugins[plugin.id] || 'inherit',
    effectiveEnabled:
      capabilityOverrides.plugins[plugin.id] === 'on'
        ? true
        : capabilityOverrides.plugins[plugin.id] === 'off'
          ? false
          : settings.enabledPluginIds.includes(plugin.id),
  })).filter(plugin => plugin.globalEnabled || plugin.sessionOverride !== 'inherit')

  const mcpItems = settings.mcpServers.map(server => ({
    id: server.id,
    kind: 'mcp' as const,
    name: server.name,
    description: server.description || server.command || 'MCP server',
    source: 'user' as const,
    installed: true,
    supported: Boolean(server.command.trim()) && server.healthStatus !== 'error',
    supportMessage:
      !server.command.trim()
        ? '尚未填写 MCP 启动命令。'
        : server.healthStatus === 'error'
          ? server.healthMessage || '连接测试失败，暂不可启用。'
          : server.healthStatus === 'unknown'
            ? '尚未验证连接，测试通过后才会真正启用。'
            : undefined,
    path: server.cwd || undefined,
    entryPath: undefined,
    readonly: Boolean(server.isDefault),
    globalEnabled: server.enabled,
    sessionOverride: capabilityOverrides.mcp[server.id] || 'inherit',
    effectiveEnabled:
      server.healthStatus === 'ok' &&
        capabilityOverrides.mcp[server.id] === 'on'
        ? true
        : capabilityOverrides.mcp[server.id] === 'off' || server.healthStatus !== 'ok'
          ? false
          : server.enabled,
  })).filter(server => server.globalEnabled)

  return [...skillItems, ...pluginItems, ...mcpItems]
}

export function MainWindowApp() {
  const [settings, setSettings] = useState<AgentSettings>(() => loadSettings())
  const [sessions, setSessions] = useState<Session[]>(() => loadSessions())
  const [deletedSessions, setDeletedSessions] = useState<Session[]>([])
  const [sessionFolders, setSessionFolders] = useState<SessionFolder[]>(() => loadSessionFolders())
  const [auraHome, setAuraHome] = useState<AuraHomeState | null>(null)
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)
  const [sessionFilter, setSessionFilter] = useState('')
  const [sessionFilterMatches, setSessionFilterMatches] = useState<Set<string> | null>(null)
  const [composerStates, setComposerStates] = useState<Record<string, ComposerState>>({})
  const [error, setError] = useState('')
  const [agentTasksBySession, setAgentTasksBySession] = useState<
    Record<string, AgentTaskSnapshot>
  >({})
  const [runningTasksBySession, setRunningTasksBySession] = useState<
    Record<string, RunningTaskBinding>
  >({})
  const [sessionMessagesLoading, setSessionMessagesLoading] = useState<Record<string, boolean>>({})
  const [contextCompressionSessionId, setContextCompressionSessionId] = useState<string | null>(null)
  const [toast, setToast] = useState<ToastState | null>(null)
  const toastTimerRef = useRef<number | null>(null)

  // --- Update Check Logic ---
  const [currentVersion, setCurrentVersion] = useState('')
  const [updateRelease, setUpdateRelease] = useState<ReleaseInfo | null>(null)
  const [isUpdateModalOpen, setUpdateModalOpen] = useState(false)
  const lastCheckTime = useRef<number>(0)

  function showToast(message: string, tone: ToastState['tone'] = 'success') {
    if (toastTimerRef.current !== null) {
      window.clearTimeout(toastTimerRef.current)
    }
    setToast({
      id: Date.now(),
      message,
      tone,
    })
    toastTimerRef.current = window.setTimeout(() => {
      setToast(null)
      toastTimerRef.current = null
    }, 1800)
  }

  useEffect(() => {
    return () => {
      if (toastTimerRef.current !== null) {
        window.clearTimeout(toastTimerRef.current)
      }
    }
  }, [])

  const handleCheckUpdate = async (force = false) => {
    const now = Date.now()
    if (!force && now - lastCheckTime.current < 10 * 60 * 1000) {
      return
    }
    lastCheckTime.current = now
    const release = await checkForUpdates()
    if (release) {
      setUpdateRelease(release)
    }
  }

  useEffect(() => {
    getVersion().then(setCurrentVersion)
    handleCheckUpdate(true)

    const unlistenPromise = listen('tauri://focus', () => {
      handleCheckUpdate()
    })

    return () => {
      unlistenPromise.then(unlisten => unlisten())
    }
  }, [])
  // --- End Update Check Logic ---
  const [workspaceTree, setWorkspaceTree] = useState<WorkspaceNode | null>(null)
  const [workspaceLoading, setWorkspaceLoading] = useState(false)
  const [workspaceError, setWorkspaceError] = useState('')
  const [expandedPaths, setExpandedPaths] = useState<string[]>([])
  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null)
  const runningTasksBySessionRef = useRef<Record<string, RunningTaskBinding>>({})
  const previousRunningTasksBySessionRef = useRef<Record<string, RunningTaskBinding>>({})
  const agentTaskLastEventAtRef = useRef<Record<string, number>>({})
  const abortingAgentTaskIdsRef = useRef<Set<string>>(new Set())
  const sessionsRef = useRef<Session[]>(sessions)

  useEffect(() => {
    runningTasksBySessionRef.current = runningTasksBySession
  }, [runningTasksBySession])
  useEffect(() => {
    sessionsRef.current = sessions
  }, [sessions])
  const [previewContent, setPreviewContent] = useState('')
  const [previewImage, setPreviewImage] = useState('')
  const [previewLoading, setPreviewLoading] = useState(false)
  const [previewError, setPreviewError] = useState('')
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
        const [hydrated, hydratedDeletedSessions] = await Promise.all([
          hydrateStorageFromAuraHome(),
          loadDeletedSessions(),
        ])
        if (cancelled) {
          return
        }
        setAuraHome(hydrated.aura)
        setSettings(hydrated.settings)
        setSessions(hydrated.sessions)
        setDeletedSessions(hydratedDeletedSessions)
        setSessionFolders(hydrated.sessionFolders)
      } catch (caught) {
        if (!cancelled) {
          setError(caught instanceof Error ? caught.message : '初始化 Aura 目录失败。')
        }
      } finally {
        if (!cancelled) {
          setStorageReady(true)
          // Dismiss splash screen after hydration is complete.
          // __dismissSplash enforces min display time + double-rAF paint verification.
          ;(window as unknown as { __dismissSplash?: () => void }).__dismissSplash?.()
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
  const activeSessionMessagesLoading = activeSession
    ? sessionMessagesLoading[activeSession.id] === true
    : false

  const activeComposerState = activeSession
    ? composerStates[activeSession.id] || createEmptyComposerState()
    : createEmptyComposerState()
  const draft = activeComposerState.draft
  const draftAttachments = activeComposerState.attachments
  const draftResearchMode = activeComposerState.researchMode
  const agentTask = activeSession ? agentTasksBySession[activeSession.id] || null : null
  const activeRunningTask = activeSession ? runningTasksBySession[activeSession.id] || null : null

  useEffect(() => {
    setRendererLogContext({
      sessionId: activeSession?.id,
      taskId: activeRunningTask?.taskId,
      messageId: activeRunningTask?.messageId,
    })
  }, [activeSession?.id, activeRunningTask?.messageId, activeRunningTask?.taskId])

  const filteredSessions = useMemo(() => {
    const keyword = sessionFilter.trim().toLowerCase()
    if (!keyword) {
      return sessions
    }
    if (sessionFilterMatches) {
      return sessions.filter(
        session =>
          sessionFilterMatches.has(session.id) || session.title.toLowerCase().includes(keyword),
      )
    }
    return sessions.filter(session =>
      session.title.toLowerCase().includes(keyword),
    )
  }, [sessionFilter, sessionFilterMatches, sessions])

  useEffect(() => {
    const keyword = sessionFilter.trim()
    if (!keyword) {
      setSessionFilterMatches(null)
      return
    }

    setSessionFilterMatches(null)
    let cancelled = false
    const timer = window.setTimeout(() => {
      void searchSessionIds(keyword)
        .then(ids => {
          if (!cancelled) {
            setSessionFilterMatches(new Set(ids))
          }
        })
        .catch(() => {
          if (!cancelled) {
            setSessionFilterMatches(null)
          }
        })
    }, 160)

    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [sessionFilter])

  useEffect(() => {
    if (!storageReady) {
      return
    }
    if (!activeSessionId) {
      return
    }

    if (sessionMessagesLoading[activeSessionId]) {
      return
    }
    if (isSessionMessagesLoaded(activeSessionId)) {
      setSessionMessagesLoading(current => {
        if (!current[activeSessionId]) {
          return current
        }
        const next = { ...current }
        delete next[activeSessionId]
        return next
      })
      return
    }

    let cancelled = false
    const loadingSessionId = activeSessionId
    setSessionMessagesLoading(current => ({
      ...current,
      [loadingSessionId]: true,
    }))

    void loadSessionMessages(loadingSessionId)
      .then(messages => {
        if (cancelled) {
          return
        }
        setSessions(current =>
          sortSessionsByRecentActivity(
            current.map(session =>
              session.id === loadingSessionId
                ? {
                  ...session,
                  messages,
                }
                : session,
            ),
          ),
        )
      })
      .catch(caught => {
        if (!cancelled) {
          setError(getErrorMessage(caught, '加载会话历史失败。'))
        }
      })
      .finally(() => {
        // Always clear the loading flag for this session id.
        // Otherwise dependency re-runs can cancel this effect and leave UI stuck forever.
        setSessionMessagesLoading(current => {
          if (!current[loadingSessionId]) {
            return current
          }
          const next = { ...current }
          delete next[loadingSessionId]
          return next
        })
      })

    return () => {
      cancelled = true
      setSessionMessagesLoading(current => {
        if (!current[loadingSessionId]) {
          return current
        }
        const next = { ...current }
        delete next[loadingSessionId]
        return next
      })
    }
  }, [activeSessionId, storageReady])

  const isRunning =
    agentTask?.status === 'queued' ||
    agentTask?.status === 'running' ||
    agentTask?.status === 'awaiting_approval' ||
    agentTask?.status === 'awaiting_user_input'

  const displayedToolEvents = agentTask?.toolEvents || []

  const displayedTaskTree = agentTask
    ? resolveVisibleTaskTree(agentTask.taskTree || [], agentTask.pendingApproval)
    : []

  const activeWorkspacePath =
    activeSession?.workspacePath || activeSession?.workspaceRoot || ''
  const activeProjectWorkspaceRoot =
    activeSession?.workspaceRoot || settings.cwd || activeSession?.workspacePath || ''
  const activeProviderProfile = getSessionProviderProfile(settings, activeSession)
  const effectiveProvider = activeProviderProfile?.provider || settings.provider
  const effectiveModel =
    activeSession?.model ||
    resolvePreferredModelId(activeProviderProfile, settings.model) ||
    settings.model
  const enabledModelGroups = collectEnabledModelsByProfile(settings)
  const currentCapabilityItems = useMemo(
    () =>
      buildCapabilityPanelItems(
        auraHome,
        settings,
        activeSession?.capabilityOverrides,
      ),
    [activeSession?.capabilityOverrides, auraHome, settings],
  )
  const currentResolvedCapabilityUsage = useMemo(() => {
    if (!auraHome || !activeProjectWorkspaceRoot.trim()) {
      return undefined
    }
    return resolveCapabilitiesForWorkspace({
      workspaceRoot: activeProjectWorkspaceRoot,
      settings,
      aura: auraHome,
      overrides: {},
      sessionOverrides: activeSession?.capabilityOverrides,
    }).usage
  }, [activeProjectWorkspaceRoot, activeSession?.capabilityOverrides, auraHome, settings])

  useEffect(() => {
    const capabilityScanRoot = activeWorkspacePath || activeProjectWorkspaceRoot
    if (!storageReady || !capabilityScanRoot.trim()) {
      return
    }
    let cancelled = false

    void ensureAuraHome(capabilityScanRoot)
      .then(nextAura => {
        if (!cancelled) {
          setAuraHome(nextAura)
        }
      })
      .catch(() => {
        // Keep the cached Aura state if workspace-local capability scanning is temporarily unavailable.
      })

    return () => {
      cancelled = true
    }
  }, [activeProjectWorkspaceRoot, activeWorkspacePath, storageReady])

  useEffect(() => {
    let unlisten: (() => void) | undefined

    void (async () => {
      unlisten = await listen('aura:session-capability-override', event => {
        const payload = event.payload as {
          sessionId?: string
          kind?: string
          id?: string
          mode?: string
          workspaceRoot?: string
        }
        const sessionId = typeof payload?.sessionId === 'string' ? payload.sessionId : ''
        const kind = payload?.kind
        const id = typeof payload?.id === 'string' ? payload.id : ''
        const mode = payload?.mode
        if (
          !sessionId ||
          !id ||
          (kind !== 'skills' && kind !== 'plugins' && kind !== 'mcp') ||
          (mode !== 'on' && mode !== 'off' && mode !== 'inherit')
        ) {
          return
        }

        updateSession(sessionId, session => ({
          ...session,
          capabilityOverrides: updateCapabilityOverride(
            session.capabilityOverrides,
            kind,
            id,
            mode,
          ),
          updatedAt: Date.now(),
        }))

        const workspaceRoot =
          typeof payload.workspaceRoot === 'string' && payload.workspaceRoot.trim()
            ? payload.workspaceRoot.trim()
            : activeProjectWorkspaceRoot
        if (workspaceRoot) {
          void ensureAuraHome(workspaceRoot)
            .then(setAuraHome)
            .catch(() => {
              // Session override is still applied; Aura state will refresh on the next hydration.
            })
        }
      })
    })()

    return () => {
      unlisten?.()
    }
  }, [activeProjectWorkspaceRoot])

  useEffect(() => {
    if (!storageReady) {
      return
    }
    if (Object.keys(runningTasksBySession).length > 0) {
      return
    }
    saveSessions(sessions)
  }, [runningTasksBySession, sessions, storageReady])

  useEffect(() => {
    const previousBindings = previousRunningTasksBySessionRef.current
    previousRunningTasksBySessionRef.current = runningTasksBySession

    const nextTaskIds = new Set(
      Object.values(runningTasksBySession).map(binding => binding.taskId),
    )
    const releasedTaskIds = new Set(
      Object.values(previousBindings)
        .map(binding => binding.taskId)
        .filter(taskId => !nextTaskIds.has(taskId)),
    )

    for (const taskId of releasedTaskIds) {
      void releaseAgentTask(taskId).catch(() => {
        // Best-effort cleanup: the task may already be gone or still be winding down.
      })
    }
  }, [runningTasksBySession])

  useEffect(() => {
    if (!storageReady) {
      return
    }
    saveSessionFolders(sessionFolders)
  }, [sessionFolders, storageReady])

  useEffect(() => {
    localStorage.setItem(SIDEBAR_WIDTH_KEY, String(sidebarWidth))
  }, [sidebarWidth])

  useEffect(() => {
    localStorage.setItem(INSPECTOR_WIDTH_KEY, String(inspectorWidth))
  }, [inspectorWidth])

  useEffect(() => {
    if (!storageReady) return

    let cancelled = false

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
    }
  }, [sessions, settings, storageReady])

  useEffect(() => {
    let unlisten: (() => void) | undefined

    void (async () => {
      unlisten = await listen('settings:updated', () => {
        void (async () => {
          try {
            const hydrated = await hydrateStorageFromAuraHome()
            setAuraHome(hydrated.aura)
            setSettings(hydrated.settings)
          } catch {
            setSettings(loadSettings())
          }
        })()
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
    const bindings = Object.entries(runningTasksBySession)
    if (bindings.length === 0) {
      return
    }

    let cancelled = false
    let unlistenTaskUpdates: (() => void) | undefined
    const syncTimers: Record<string, number> = {}
    const syncingTaskIds = new Set<string>()
    const pendingSyncs: Record<string, { sessionId: string; binding: RunningTaskBinding }> = {}

    function clearSyncTimer(taskId: string) {
      const timer = syncTimers[taskId]
      if (typeof timer === 'number') {
        window.clearTimeout(timer)
        delete syncTimers[taskId]
      }
    }

    function scheduleTaskSync(sessionId: string, binding: RunningTaskBinding, delayMs: number) {
      clearSyncTimer(binding.taskId)
      syncTimers[binding.taskId] = window.setTimeout(() => {
        delete syncTimers[binding.taskId]
        void syncTaskSnapshot(sessionId, binding)
      }, Math.max(0, delayMs))
    }

    function findRunningBindingForEvent(payload: AgentTaskUpdateEvent) {
      const taskId = payload.taskId?.trim()
      const sessionId = payload.sessionId?.trim()
      if (sessionId) {
        const binding = runningTasksBySessionRef.current[sessionId]
        if (binding && (!taskId || binding.taskId === taskId)) {
          return { sessionId, binding }
        }
      }
      if (taskId) {
        for (const [nextSessionId, binding] of Object.entries(runningTasksBySessionRef.current)) {
          if (binding.taskId === taskId) {
            return { sessionId: nextSessionId, binding }
          }
        }
      }
      return null
    }

    async function syncTaskSnapshot(sessionId: string, binding: RunningTaskBinding) {
      if (syncingTaskIds.has(binding.taskId)) {
        pendingSyncs[binding.taskId] = { sessionId, binding }
        return
      }
      syncingTaskIds.add(binding.taskId)
      try {
        const snapshot = await getAgentTask(binding.taskId)
        if (cancelled) {
          return
        }
        if (runningTasksBySessionRef.current[sessionId]?.taskId !== binding.taskId) {
          return
        }

        setAgentTasksBySession(current => ({
          ...current,
          [sessionId]: snapshot,
        }))

        const snapshotFinished = snapshot.status === 'completed' || snapshot.status === 'failed'
        const snapshotMessageEvents = buildSnapshotMessageEvents(snapshot, {
          lazyDetails: snapshotFinished,
        })

        updateSession(sessionId, session => ({
          ...session,
          contextCompression: normalizeTaskContextCompression(
            session,
            snapshot.contextCompression,
          ),
          messages: session.messages.map(message =>
            message.id === binding.messageId
              ? updateMessageVariantAtIndex(message, binding.variantIndex, currentVariant => {
                const mergedArtifacts = mergeExecutionArtifacts(
                  currentVariant,
                  snapshot,
                  snapshotMessageEvents,
                )
                return {
                  ...currentVariant,
                  content: snapshot.message || currentVariant.content,
                  reasoning: mergedArtifacts.reasoning,
                  phaseOutputs: mergedArtifacts.phaseOutputs,
                  usage: snapshot.usage || currentVariant.usage,
                  capabilitySnapshot:
                    snapshot.capabilitySnapshot || currentVariant.capabilitySnapshot,
                  status:
                    snapshot.status === 'failed'
                      ? ('failed' as const)
                      : snapshot.status === 'completed'
                        ? ('completed' as const)
                        : ('streaming' as const),
                  events: mergedArtifacts.events,
                  steps: mergedArtifacts.steps,
                  activity: buildMessageActivity(
                    snapshot.status,
                    currentVariant.createdAt || Date.now(),
                    snapshot.toolEvents,
                    snapshot.taskTree,
                    snapshot,
                    resolveActivityExpanded(snapshot.status, currentVariant.activity?.expanded),
                  ),
                  appendedInputs: snapshot.appendedInputs || currentVariant.appendedInputs,
                  error:
                    snapshot.status === 'failed'
                      ? buildSnapshotErrorMessage(snapshot)
                      : snapshot.error,
                  errorInfo: snapshot.errorInfo,
                  retryInfo: retryInfoForSnapshot(snapshot),
                  agentMode: snapshot.agentMode || currentVariant.agentMode,
                  routeDecision: snapshot.routeDecision || currentVariant.routeDecision,
                  completionState:
                    snapshot.completionState || currentVariant.completionState,
                  evidenceSummary:
                    snapshot.evidenceSummary || currentVariant.evidenceSummary,
                  deliveryNote:
                    snapshot.deliveryNote || currentVariant.deliveryNote,
                }
              })
              : message,
          ),
        }))

        if (snapshotFinished) {
          const finalSessions = sortSessionsByRecentActivity(
            sessionsRef.current.map(session =>
              session.id === sessionId
                ? {
                  ...session,
                  contextCompression: normalizeTaskContextCompression(
                    session,
                    snapshot.contextCompression,
                  ),
                  messages: session.messages.map(message =>
                    message.id === binding.messageId
                      ? updateMessageVariantAtIndex(message, binding.variantIndex, currentVariant => {
                        const mergedArtifacts = mergeExecutionArtifacts(
                          currentVariant,
                          snapshot,
                          snapshotMessageEvents,
                        )
                        return {
                          ...currentVariant,
                          content:
                            snapshot.status === 'completed'
                              ? snapshot.message || currentVariant.content
                              : snapshot.message || currentVariant.content,
                          reasoning: mergedArtifacts.reasoning,
                          phaseOutputs: mergedArtifacts.phaseOutputs,
                          usage: snapshot.usage || currentVariant.usage,
                          capabilitySnapshot:
                            snapshot.capabilitySnapshot || currentVariant.capabilitySnapshot,
                          status:
                            snapshot.status === 'completed'
                              ? ('completed' as const)
                              : ('failed' as const),
                          events: mergedArtifacts.events,
                          steps: mergedArtifacts.steps,
                          activity: buildMessageActivity(
                            snapshot.status,
                            currentVariant.createdAt || Date.now(),
                            snapshot.toolEvents,
                            snapshot.taskTree,
                            snapshot,
                            resolveActivityExpanded(snapshot.status, currentVariant.activity?.expanded),
                          ),
                          appendedInputs:
                            snapshot.appendedInputs || currentVariant.appendedInputs,
                          error:
                            snapshot.status === 'failed'
                              ? buildSnapshotErrorMessage(snapshot)
                              : undefined,
                          errorInfo:
                            snapshot.status === 'failed'
                              ? snapshot.errorInfo
                              : undefined,
                          retryInfo: retryInfoForSnapshot(snapshot),
                          agentMode: snapshot.agentMode || currentVariant.agentMode,
                          routeDecision:
                            snapshot.routeDecision || currentVariant.routeDecision,
                          completionState:
                            snapshot.completionState || currentVariant.completionState,
                          evidenceSummary:
                            snapshot.evidenceSummary || currentVariant.evidenceSummary,
                          deliveryNote:
                            snapshot.deliveryNote || currentVariant.deliveryNote,
                        }
                      })
                      : message,
                  ),
                  updatedAt: Date.now(),
                }
                : session,
            ),
          )
          sessionsRef.current = finalSessions
          setSessions(finalSessions)
          await saveSessionsAndAwaitPersistence(finalSessions)

          const details = buildMessageEventDetailRecords(snapshot.toolEvents)
          if (details.length > 0) {
            await upsertPersistedMessageEventDetails(
              binding.messageId,
              binding.variantIndex,
              details,
            )
          }

          setRunningTasksBySession(current => {
            const next = { ...current }
            delete next[sessionId]
            return next
          })
          setAgentTasksBySession(current => {
            const next = { ...current }
            delete next[sessionId]
            return next
          })
        }
      } catch (caught) {
        if (cancelled) {
          return
        }
        if (runningTasksBySessionRef.current[sessionId]?.taskId !== binding.taskId) {
          return
        }

        if (isAgentTaskNotFoundError(caught)) {
          setRunningTasksBySession(current => {
            if (current[sessionId]?.taskId !== binding.taskId) {
              return current
            }
            const next = { ...current }
            delete next[sessionId]
            return next
          })
          setAgentTasksBySession(current => {
            const next = { ...current }
            delete next[sessionId]
            return next
          })
          delete agentTaskLastEventAtRef.current[binding.taskId]
          return
        }

        const message = getErrorMessage(caught, '同步任务状态失败。')
        setError(message)
      } finally {
        syncingTaskIds.delete(binding.taskId)
        const pending = pendingSyncs[binding.taskId]
        if (pending && !cancelled) {
          delete pendingSyncs[binding.taskId]
          scheduleTaskSync(pending.sessionId, pending.binding, 0)
        }
      }
    }

    for (const [sessionId, binding] of bindings) {
      agentTaskLastEventAtRef.current[binding.taskId] ||= Date.now()
      scheduleTaskSync(sessionId, binding, AGENT_TASK_EVENT_SYNC_DEBOUNCE_MS)
    }

    void listen<AgentTaskUpdateEvent>('agent-task-updated', event => {
      const payload = event.payload || {}
      const found = findRunningBindingForEvent(payload)
      if (!found) {
        return
      }
      agentTaskLastEventAtRef.current[found.binding.taskId] = Date.now()
      scheduleTaskSync(
        found.sessionId,
        found.binding,
        payload.terminal ? 0 : AGENT_TASK_EVENT_SYNC_DEBOUNCE_MS,
      )
    }).then(unlisten => {
      if (cancelled) {
        unlisten()
        return
      }
      unlistenTaskUpdates = unlisten
    })

    const staleCheckTimer = window.setInterval(() => {
      const now = Date.now()
      for (const [sessionId, binding] of Object.entries(runningTasksBySessionRef.current)) {
        const lastEventAt = agentTaskLastEventAtRef.current[binding.taskId] || 0
        if (now - lastEventAt >= AGENT_TASK_EVENT_STALE_MS) {
          agentTaskLastEventAtRef.current[binding.taskId] = now
          scheduleTaskSync(sessionId, binding, 0)
        }
      }
    }, AGENT_TASK_FALLBACK_CHECK_INTERVAL_MS)

    return () => {
      cancelled = true
      unlistenTaskUpdates?.()
      window.clearInterval(staleCheckTimer)
      for (const timer of Object.values(syncTimers)) {
        window.clearTimeout(timer)
      }
      for (const taskId of Object.keys(pendingSyncs)) {
        delete pendingSyncs[taskId]
      }
    }
  }, [runningTasksBySession])

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
      sortSessionsByRecentActivity(
        current.map(session => (session.id === sessionId ? updater(session) : session)),
      ),
    )
  }

  function updateComposerState(
    sessionId: string,
    updater: (state: ComposerState) => ComposerState,
  ) {
    setComposerStates(current => ({
      ...current,
      [sessionId]: updater(current[sessionId] || createEmptyComposerState()),
    }))
  }

  function clearComposerState(sessionId: string) {
    updateComposerState(sessionId, current => ({
      ...createEmptyComposerState(),
      researchMode: current.researchMode,
    }))
  }

  async function chooseExplicitWorkspaceForSession() {
    if (activeSession?.messages.length) {
      setError('当前会话已经有消息记录，工作区已锁定。请新建会话后再切换目录。')
      return ''
    }

    const selected = await open({
      directory: true,
      multiple: false,
      title: '选择当前会话工作目录',
    })
    if (typeof selected !== 'string') {
      return ''
    }
    if (!activeSession) {
      return ''
    }

    updateSession(activeSession.id, session => ({
      ...session,
      workspacePath: selected,
      workspaceRoot: selected,
      workspaceMode: 'explicit',
      updatedAt: Date.now(),
    }))
    setSelectedFilePath(null)
    setError('')
    return selected
  }

  async function appendAttachmentsFromPaths(paths: string[]) {
    if (!activeSession) {
      return
    }

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

    updateComposerState(activeSession.id, current => {
      const existingPaths = new Set(current.attachments.map(attachment => attachment.path).filter(Boolean))
      const deduped = nextAttachments.filter(
        attachment => !attachment.path || !existingPaths.has(attachment.path),
      )
      return {
        ...current,
        attachments: [...current.attachments, ...deduped],
      }
    })
  }

  async function appendAttachmentsFromFiles(files: File[]) {
    if (files.length === 0 || !activeSession) {
      return
    }

    const nextAttachments = await Promise.all(files.map(file => createDraftAttachmentFromFile(file))).catch(
      caught => {
        setError(getErrorMessage(caught, '读取剪贴板附件失败。'))
        return null
      },
    )
    if (!nextAttachments) {
      return
    }
    updateComposerState(activeSession.id, current => {
      const existingSignatures = new Set(
        current.attachments
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
      return {
        ...current,
        attachments: [...current.attachments, ...deduped],
      }
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
    if (!activeSession) {
      return
    }
    updateComposerState(activeSession.id, current => ({
      ...current,
      attachments: current.attachments.filter(attachment => attachment.id !== attachmentId),
    }))
  }

  function createFreshSession() {
    const latestSettings = loadSettings()
    setSettings(latestSettings)
    const next = createSession(latestSettings)
    setSessions(current => [next, ...current])
    setActiveSessionId(next.id)
    setComposerStates(current => ({
      ...current,
      [next.id]: createEmptyComposerState(),
    }))
    setError('')
  }

  function openSession(sessionId: string) {
    setActiveSessionId(sessionId)
    setError('')
  }

  function createSessionFolder(name: string) {
    const nextName = name.trim()
    if (!nextName) {
      return
    }

    setSessionFolders(current => [
      ...current,
      {
        id: createId(),
        name: nextName,
        expanded: true,
        createdAt: Date.now(),
      },
    ])
  }

  function renameSessionFolder(folderId: string, name: string) {
    const nextName = name.trim()
    if (!nextName) {
      return
    }

    setSessionFolders(current =>
      current.map(folder =>
        folder.id === folderId
          ? {
            ...folder,
            name: nextName,
          }
          : folder,
      ),
    )
  }

  function toggleSessionFolder(folderId: string) {
    setSessionFolders(current =>
      current.map(folder =>
        folder.id === folderId
          ? {
            ...folder,
            expanded: !folder.expanded,
          }
          : folder,
      ),
    )
  }

  function deleteSessionFolder(folderId: string) {
    setSessionFolders(current => current.filter(folder => folder.id !== folderId))
    setSessions(current =>
      current.map(session =>
        session.folderId === folderId
          ? {
            ...session,
            folderId: undefined,
          }
          : session,
      ),
    )
  }

  function moveSessionToFolder(sessionId: string, folderId?: string) {
    const normalizedFolderId =
      typeof folderId === 'string' && sessionFolders.some(folder => folder.id === folderId)
        ? folderId
        : undefined

    setSessions(current =>
      current.map(session =>
        session.id === sessionId
          ? {
            ...session,
            folderId: normalizedFolderId,
          }
          : session,
      ),
    )
  }

  function renameSession(sessionId: string, title: string) {
    const nextTitle = title.trim()
    if (!nextTitle) {
      return
    }

    updateSession(sessionId, session => ({
      ...session,
      title: nextTitle,
    }))
  }

  async function generateTitleForSession(sessionId: string) {
    const latestSettings = loadSettings()
    setSettings(latestSettings)
    const target = sessions.find(session => session.id === sessionId)
    if (!target) {
      throw new Error('会话不存在，无法生成标题。')
    }

    const messages = target.messages.length > 0
      ? target.messages
      : await loadSessionMessages(sessionId)
    if (messages.length === 0) {
      throw new Error('当前会话还没有可用于总结的消息。')
    }

    const hydratedSession: Session = {
      ...target,
      messages,
    }
    const titleModelSelection = resolveTitleModelProfile(latestSettings)
    const sessionProviderProfile = getSessionProviderProfile(latestSettings, hydratedSession)
    const providerProfile = titleModelSelection?.profile || sessionProviderProfile
    const effectiveProvider = providerProfile?.provider || hydratedSession.provider || latestSettings.provider
    const effectiveModel =
      titleModelSelection?.modelId ||
      hydratedSession.model ||
      resolvePreferredModelId(providerProfile, latestSettings.model) ||
      latestSettings.model

    if (
      providerModeRequiresApiKey(effectiveProvider) &&
      !providerProfile?.apiKey.trim() &&
      !latestSettings.apiKey.trim()
    ) {
      throw new Error(
        titleModelSelection
          ? '请先在设置窗口里完成标题模型 Provider 配置。'
          : '请先在设置窗口里完成 Provider 配置。',
      )
    }

    const runtimeSettings: AgentSettings = {
      ...latestSettings,
      activeProviderProfileId:
        providerProfile?.id || hydratedSession.providerProfileId || latestSettings.activeProviderProfileId,
      provider: effectiveProvider,
      apiKey: providerProfile?.apiKey || latestSettings.apiKey,
      baseUrl: providerProfile?.baseUrl || latestSettings.baseUrl,
      model: effectiveModel,
      cwd:
        hydratedSession.workspacePath ||
        hydratedSession.workspaceRoot ||
        latestSettings.cwd,
    }
    return generateSessionTitleWithProvider(
      runtimeSettings,
      buildTitleGenerationContext(hydratedSession),
    )
  }

  async function deleteSession(sessionId: string) {
    if (runningTasksBySession[sessionId]) {
      setError('当前会话仍在执行中，请等待完成后再删除。')
      return
    }

    const target = sessions.find(session => session.id === sessionId)
    if (!target) {
      return
    }

    const remaining = sessions.filter(session => session.id !== sessionId)
    const deletedAt = Date.now()
    setSessions(remaining)
    setDeletedSessions(current => [
      {
        ...target,
        folderId: undefined,
        messages: [],
        toolEvents: [],
        taskTree: [],
        deletedAt,
        updatedAt: deletedAt,
      },
      ...current.filter(session => session.id !== sessionId),
    ])
    setComposerStates(current => {
      const next = { ...current }
      delete next[sessionId]
      return next
    })
    setAgentTasksBySession(current => {
      const next = { ...current }
      delete next[sessionId]
      return next
    })
    setRunningTasksBySession(current => {
      const next = { ...current }
      delete next[sessionId]
      return next
    })

    if (activeSessionId === sessionId) {
      setActiveSessionId(remaining[0]?.id || null)
      setError('')
      setSelectedFilePath(null)
      setPreviewContent('')
      setPreviewImage('')
      setPreviewError('')
      setWorkspaceTree(null)
      setWorkspaceError('')
    }
  }

  async function refreshSessionListsFromPersistence() {
    const [hydrated, trashed] = await Promise.all([
      hydrateStorageFromAuraHome(),
      loadDeletedSessions(),
    ])
    setAuraHome(hydrated.aura)
    setSettings(hydrated.settings)
    setSessions(hydrated.sessions)
    setSessionFolders(hydrated.sessionFolders)
    setDeletedSessions(trashed)
    return hydrated.sessions
  }

  async function restoreDeletedSession(sessionId: string) {
    await restoreSessionFromTrash(sessionId)
    const nextSessions = await refreshSessionListsFromPersistence()
    if (!activeSessionId && nextSessions.length > 0) {
      setActiveSessionId(nextSessions[0].id)
    }
    showToast('会话已恢复')
  }

  function resolveManagedTrashWorkspacePath(session: Session | undefined) {
    if (!session || session.workspaceMode !== 'default') {
      return ''
    }
    const workspacePath = session.workspacePath.trim()
    const managedRoot = auraHome?.workspaceDir?.trim() || ''
    if (!workspacePath || !managedRoot) {
      return ''
    }

    const normalizedPath = workspacePath.replace(/\\/g, '/').replace(/\/+$/u, '')
    const normalizedRoot = managedRoot.replace(/\\/g, '/').replace(/\/+$/u, '')
    if (!normalizedPath || normalizedPath === normalizedRoot) {
      return ''
    }
    return normalizedPath.startsWith(`${normalizedRoot}/`) ? workspacePath : ''
  }

  async function permanentlyDeleteSession(sessionId: string) {
    const target = deletedSessions.find(session => session.id === sessionId)
    const workspacePath = resolveManagedTrashWorkspacePath(target)
    await purgeSessionFromTrash(sessionId)
    if (workspacePath) {
      try {
        await deleteWorkspaceDirectory(workspacePath)
      } catch (caught) {
        const message = caught instanceof Error ? caught.message : String(caught)
        showToast(`会话已永久删除，但临时工作区清理失败：${message}`, 'error')
        setDeletedSessions(current => current.filter(session => session.id !== sessionId))
        return
      }
    }
    setDeletedSessions(current => current.filter(session => session.id !== sessionId))
    showToast(workspacePath ? '会话已永久删除，临时工作区已清理' : '会话已永久删除')
  }

  async function loadMessageEventDetail(
    messageId: string,
    versionIndex: number,
    eventId: string,
  ): Promise<MessageEventDetailPayload | null> {
    return loadPersistedMessageEventDetail(messageId, versionIndex, eventId)
  }

  function insertFileReference(path: string) {
    if (!activeSession) {
      return
    }
    updateComposerState(activeSession.id, current => ({
      ...current,
      draft: current.draft.trim()
        ? `${current.draft}\n\n请重点查看文件：${path}`
        : `请重点查看文件：${path}`,
    }))
  }

  async function ensureSessionWorkspace(
    session: Session,
    _prompt: string,
    fallbackWorkspaceRoot = '',
  ) {
    if (session.workspacePath.trim()) {
      return session.workspacePath
    }
    const workspaceRoot = session.workspaceRoot.trim() || fallbackWorkspaceRoot.trim()

    const workspacePath = await createSessionWorkspace(workspaceRoot, session.id)
    updateSession(session.id, current => ({
      ...current,
      workspacePath,
      workspaceRoot: current.workspaceRoot || workspaceRoot,
      workspaceMode: 'default',
      updatedAt: Date.now(),
    }))
    return workspacePath
  }

  async function appendPromptToRunningTask(
    rawContent: string,
    options?: {
      attachmentsOverride?: MessageAttachment[]
    },
  ) {
    if (!activeSession || !activeRunningTask || !agentTask?.id) {
      return
    }

    const content = rawContent
    const trimmedContent = rawContent.trim()
    const effectiveAttachmentCount =
      options?.attachmentsOverride?.length ?? draftAttachments.length
    if (!trimmedContent && effectiveAttachmentCount === 0) {
      return
    }

    const workspaceHint = trimmedContent || draftAttachments[0]?.name || activeSession.title
    const workspacePath = await ensureSessionWorkspace(
      activeSession,
      workspaceHint,
      settings.cwd,
    ).catch(caught => {
      setError(getErrorMessage(caught, '创建会话工作目录失败。'))
      return ''
    })

    if (!workspacePath) {
      return
    }

    const materializedAttachments = options?.attachmentsOverride
      ? options.attachmentsOverride
      : await materializeDraftAttachments(workspacePath, draftAttachments).catch(caught => {
        setError(getErrorMessage(caught, '导入附件到当前会话失败。'))
        return null
      })

    if (!materializedAttachments) {
      return
    }

    const contentForDisplay = trimmedContent
      ? content
      : `已补充 ${materializedAttachments.length} 个附件：${materializedAttachments
        .map(attachment => attachment.name)
        .join('、')}`
    const runtimeInputParts = buildUserMessageParts(content, materializedAttachments)
    const storedInputAttachments = stripAttachmentPreviews(materializedAttachments)
    const appendedInput: AppendedInput = {
      id: createId(),
      content: contentForDisplay,
      parts: stripInlineImageDataFromParts(runtimeInputParts),
      attachments: storedInputAttachments,
      createdAt: Date.now(),
      status: 'queued',
      researchMode: draftResearchMode,
    }

    try {
      await appendInputToAgentTask(agentTask.id, {
        id: appendedInput.id,
        content: appendedInput.content,
        parts: runtimeInputParts,
        attachments: storedInputAttachments,
        createdAt: appendedInput.createdAt,
        researchMode: appendedInput.researchMode,
      })

      setAgentTasksBySession(current => ({
        ...current,
        [activeSession.id]: current[activeSession.id]
          ? {
            ...current[activeSession.id],
            appendedInputs: [
              ...(current[activeSession.id].appendedInputs || []),
              appendedInput,
            ],
          }
          : current[activeSession.id],
      }))

      updateSession(activeSession.id, session => ({
        ...session,
        messages: session.messages.map(message =>
          message.id === activeRunningTask.messageId
            ? updateActiveMessageVariant(message, currentVariant => ({
              ...currentVariant,
              appendedInputs: [...(currentVariant.appendedInputs || []), appendedInput],
            }))
            : message,
        ),
        updatedAt: Date.now(),
      }))

      if (!options?.attachmentsOverride) {
        clearComposerState(activeSession.id)
      }
      setError('')
    } catch (caught) {
      setError(getErrorMessage(caught, '补充输入发送失败。'))
    }
  }

  async function forceExecuteAppendedInput(messageId: string, inputId: string) {
    if (!activeSession || !activeRunningTask || !agentTask?.id) {
      return
    }
    if (activeRunningTask.messageId !== messageId) {
      return
    }

    const assistantIndex = activeSession.messages.findIndex(
      message => message.id === messageId && message.role === 'assistant',
    )
    if (assistantIndex === -1) {
      return
    }

    const assistantMessage = activeSession.messages[assistantIndex]
    const appendedInputs = assistantMessage.appendedInputs || []
    const targetInput = appendedInputs.find(input => input.id === inputId)
    if (!targetInput || targetInput.status !== 'queued') {
      return
    }

    try {
      await cancelAgentTaskStep(agentTask.id)
      setError('')
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '立即处理当前补充失败。')
    }
  }

  async function handleCompressActiveContext() {
    if (!activeSession || contextCompressionSessionId || isRunning) {
      return
    }

    if (activeSession.messages.length <= MANUAL_CONTEXT_COMPRESSION_KEEP_RECENT_MESSAGES + 1) {
      setError('当前会话中可压缩的历史消息太少。')
      return
    }

    const latestSettings = loadSettings()
    const latestProviderProfile = getSessionProviderProfile(latestSettings, activeSession)
    const latestEffectiveProvider = latestProviderProfile?.provider || latestSettings.provider
    const latestEffectiveModel =
      activeSession.model ||
      resolvePreferredModelId(latestProviderProfile, latestSettings.model) ||
      latestSettings.model

    if (
      providerModeRequiresApiKey(latestEffectiveProvider) &&
      !latestProviderProfile?.apiKey.trim() &&
      !latestSettings.apiKey.trim()
    ) {
      setError('请先在设置窗口里完成 Provider 配置。')
      await openSettingsWindow('providers').catch(caught => {
        setError(caught instanceof Error ? caught.message : '打开设置窗口失败。')
      })
      return
    }

    const runtimeSettings: AgentSettings = {
      ...latestSettings,
      activeProviderProfileId:
        latestProviderProfile?.id || latestSettings.activeProviderProfileId,
      provider: latestEffectiveProvider,
      apiKey: latestProviderProfile?.apiKey || latestSettings.apiKey,
      baseUrl: latestProviderProfile?.baseUrl || latestSettings.baseUrl,
      model: latestEffectiveModel,
      cwd:
        activeSession.workspacePath ||
        activeSession.workspaceRoot ||
        latestSettings.cwd,
    }
    const sourceMessages = activeSession.messages
    const compressedThroughIndex =
      sourceMessages.length - MANUAL_CONTEXT_COMPRESSION_KEEP_RECENT_MESSAGES - 1
    const compressedThroughMessageId = sourceMessages[compressedThroughIndex]?.id
    if (!compressedThroughMessageId) {
      setError('当前会话中可压缩的历史消息太少。')
      return
    }

    setContextCompressionSessionId(activeSession.id)
    setError('')
    try {
      const contextCompressionId = createId()
      const result = await compressAgentContext(
        runtimeSettings,
        sourceMessages,
        MANUAL_CONTEXT_COMPRESSION_KEEP_RECENT_MESSAGES,
        {
          sessionId: activeSession.id,
          compressedThroughMessageId,
          compressionId: contextCompressionId,
        },
      )
      if (!result.ok || !result.summary.trim()) {
        throw new Error(result.message || '上下文压缩没有返回可用摘要。')
      }
      const compressedAt = Date.now()
      updateSession(activeSession.id, session => {
        if (!session.messages.some(message => message.id === compressedThroughMessageId)) {
          return session
        }
        return {
          ...session,
          contextCompression: {
            id: contextCompressionId,
            summary: result.summary,
            compressedThroughMessageId,
            originalMessageCount: result.originalMessageCount || sourceMessages.length,
            originalTokenEstimate: result.originalTokens,
            compressedTokenEstimate: result.compressedTokens,
            createdAt: compressedAt,
            providerProfileId:
              latestProviderProfile?.id || latestSettings.activeProviderProfileId,
            model: latestEffectiveModel,
          },
          updatedAt: compressedAt,
        }
      })
    } catch (caught) {
      setError(getErrorMessage(caught, '立即压缩上下文失败。'))
    } finally {
      setContextCompressionSessionId(current =>
        current === activeSession.id ? null : current,
      )
    }
  }

  async function submitPrompt(
    rawContent: string,
    options?: {
      targetUserMessageId?: string
      targetAssistantMessageId?: string
      attachmentsOverride?: MessageAttachment[]
      appendUserVersion?: boolean
      providerProfileIdOverride?: string
      modelOverride?: string
      researchModeOverride?: ResearchMode
    },
  ) {
    const content = rawContent
    const trimmedContent = rawContent.trim()
    const effectiveAttachmentCount = options?.attachmentsOverride?.length ?? draftAttachments.length
    if ((!trimmedContent && effectiveAttachmentCount === 0) || !activeSession) {
      return
    }

    if (isRunning) {
      await appendPromptToRunningTask(rawContent, {
        attachmentsOverride: options?.attachmentsOverride,
      })
      return
    }

    let latestSettings = loadSettings()
    let latestAuraHome = auraHome

    try {
      const hydrated = await hydrateStorageFromAuraHome()
      latestSettings = hydrated.settings
      latestAuraHome = hydrated.aura
      setSettings(hydrated.settings)
      setAuraHome(hydrated.aura)
    } catch {
      // Fall back to the latest cached state if hydration is temporarily unavailable.
    }

    const latestProviderProfile =
      latestSettings.providerProfiles.find(
        profile => profile.id === options?.providerProfileIdOverride,
      ) || getSessionProviderProfile(latestSettings, activeSession)
    const latestEffectiveProvider = latestProviderProfile?.provider || latestSettings.provider
    const latestEffectiveModel =
      options?.modelOverride ||
      activeSession.model ||
      resolvePreferredModelId(latestProviderProfile, options?.modelOverride) ||
      resolvePreferredModelId(latestProviderProfile, latestSettings.model) ||
      latestSettings.model

    if (
      providerModeRequiresApiKey(latestEffectiveProvider) &&
      !latestProviderProfile?.apiKey.trim() &&
      !latestSettings.apiKey.trim()
    ) {
      setError('请先在设置窗口里完成 Provider 配置。')
      await openSettingsWindow('providers').catch(caught => {
        setError(caught instanceof Error ? caught.message : '打开设置窗口失败。')
      })
      return
    }

    const workspaceHint =
      trimmedContent || draftAttachments[0]?.name || activeSession.title
    const workspacePath = await ensureSessionWorkspace(
      activeSession,
      workspaceHint,
      latestSettings.cwd,
    ).catch(caught => {
      setError(getErrorMessage(caught, '创建会话工作目录失败。'))
      return ''
    })

    if (!workspacePath) {
      return
    }

    const projectWorkspaceRoot =
      activeSession.workspaceRoot || latestSettings.cwd || workspacePath
    try {
      latestAuraHome = await ensureAuraHome(workspacePath)
      setAuraHome(latestAuraHome)
    } catch {
      // Keep using the hydrated global Aura state if workspace-local scanning fails.
    }

    const materializedAttachments = options?.attachmentsOverride
      ? options.attachmentsOverride
      : await materializeDraftAttachments(workspacePath, draftAttachments).catch(caught => {
        setError(getErrorMessage(caught, '导入附件到当前会话失败。'))
        return null
      })

    if (!materializedAttachments) {
      return
    }

    const contentForDisplay = trimmedContent
      ? content
      : `已附加 ${materializedAttachments.length} 个附件：${materializedAttachments
        .map(attachment => attachment.name)
        .join('、')}`
    const userMessageParts = buildUserMessageParts(content, materializedAttachments)
    const storedUserMessageParts = stripInlineImageDataFromParts(userMessageParts)
    const storedUserMessageAttachments = stripAttachmentPreviews(materializedAttachments)

    const sessionId = activeSession.id
    const targetUserMessage = options?.targetUserMessageId
      ? activeSession.messages.find(message => message.id === options.targetUserMessageId)
      : null
    const targetAssistantMessage = options?.targetAssistantMessageId
      ? activeSession.messages.find(message => message.id === options.targetAssistantMessageId)
      : null
    const pendingUserMessageId = targetUserMessage
      ? getMessageGroupId(targetUserMessage)
      : createMessageGroupId(sessionId)
    const pendingAssistantMessageId = targetAssistantMessage
      ? getMessageGroupId(targetAssistantMessage)
      : createMessageGroupId(sessionId)
    const pendingUserVersionId =
      targetUserMessage && options?.appendUserVersion === false
        ? getMessageVariantId(targetUserMessage)
        : createVersionMessageId(pendingUserMessageId)
    const pendingAssistantVersionId = createVersionMessageId(pendingAssistantMessageId)

    const messageCreatedAt = Date.now()
    const userMessageVariant: ChatMessageVariant = {
      id: pendingUserVersionId,
      groupId: pendingUserMessageId,
      content: contentForDisplay,
      parts: storedUserMessageParts,
      status: 'completed',
      createdAt: messageCreatedAt,
      researchMode: options?.researchModeOverride || draftResearchMode,
      attachments: storedUserMessageAttachments,
    }
    const resolvedCapabilities = latestAuraHome
      ? resolveCapabilitiesForWorkspace({
        workspaceRoot: projectWorkspaceRoot,
        settings: latestSettings,
        aura: latestAuraHome,
        overrides: {},
        sessionOverrides: activeSession.capabilityOverrides,
      })
      : {
        runtime: {
          workspaceRoot: projectWorkspaceRoot,
          resolvedAt: Date.now(),
          skills: [],
          plugins: [],
          mcpServers: [],
        },
        usage: {
          workspaceRoot: projectWorkspaceRoot,
          resolvedAt: Date.now(),
          skills: [],
          plugins: [],
          mcpServers: [],
        },
      }
    const runtimeSettings: AgentSettings = {
      ...latestSettings,
      activeProviderProfileId:
        latestProviderProfile?.id || latestSettings.activeProviderProfileId,
      provider: latestEffectiveProvider,
      apiKey: latestProviderProfile?.apiKey || latestSettings.apiKey,
      baseUrl: latestProviderProfile?.baseUrl || latestSettings.baseUrl,
      model: latestEffectiveModel,
      cwd: workspacePath,
    }

    let runtimeMessages: ChatMessage[] = []
    const pendingAssistantVariant: ChatMessageVariant = {
      ...toMessageVariant(createPendingAssistantMessage()),
      id: pendingAssistantVersionId,
      groupId: pendingAssistantMessageId,
      capabilitySnapshot: resolvedCapabilities.usage,
      modelInfo: buildMessageModelInfo(latestProviderProfile, latestEffectiveModel),
    }
    let nextContextCompression = activeSession.contextCompression

    const updatedMessages = (() => {
      if (!targetUserMessage) {
        const assistantMessage = applyMessageVariant(
          {
            ...createPendingAssistantMessage(),
            id: pendingAssistantMessageId,
            groupId: pendingAssistantMessageId,
            linkedMessageId: '',
          },
          [pendingAssistantVariant],
          0,
        )
        const userMessage = applyMessageVariant(
          {
            id: pendingUserMessageId,
            groupId: pendingUserMessageId,
            role: 'user',
            linkedMessageId: assistantMessage.id,
            content: userMessageVariant.content,
          },
          [userMessageVariant],
          0,
        )
        assistantMessage.linkedMessageId = userMessage.id
        runtimeMessages = [...activeSession.messages, userMessage]
        return [...activeSession.messages, userMessage, assistantMessage]
      }

      const userIndex = activeSession.messages.findIndex(message => message.id === targetUserMessage.id)
      if (userIndex === -1) {
        runtimeMessages = [...activeSession.messages]
        return activeSession.messages
      }
      const compressedThroughIndex = findCompressedThroughIndex(activeSession)
      if (compressedThroughIndex !== -1 && userIndex <= compressedThroughIndex) {
        nextContextCompression = undefined
      }

      const nextMessages = [...activeSession.messages]
      const updatedUserMessage =
        options?.appendUserVersion === false
          ? {
            ...targetUserMessage,
            groupId: pendingUserMessageId,
            linkedMessageId: targetAssistantMessage?.id || pendingAssistantMessageId,
          }
          : appendMessageVariant(targetUserMessage, userMessageVariant)
      nextMessages[userIndex] = updatedUserMessage

      if (targetAssistantMessage) {
        const assistantIndex = nextMessages.findIndex(message => message.id === targetAssistantMessage.id)
        if (assistantIndex !== -1) {
          nextMessages[assistantIndex] = appendMessageVariant(
            updateActiveMessageVariant(
              {
                ...targetAssistantMessage,
                groupId: pendingAssistantMessageId,
                linkedMessageId: updatedUserMessage.id,
              },
              currentVariant =>
                currentVariant.activity &&
                  (currentVariant.activity.status === 'running' ||
                    currentVariant.activity.status === 'queued' ||
                    currentVariant.activity.status === 'awaiting_approval' ||
                    currentVariant.activity.status === 'awaiting_user_input')
                  ? {
                    ...currentVariant,
                    activity: {
                      ...currentVariant.activity,
                      status: 'failed',
                      finishedAt: Date.now(),
                    },
                  }
                  : currentVariant,
            ),
            pendingAssistantVariant,
          )
        }
      } else {
        const assistantMessage = applyMessageVariant(
          {
            ...createPendingAssistantMessage(),
            id: pendingAssistantMessageId,
            groupId: pendingAssistantMessageId,
            linkedMessageId: updatedUserMessage.id,
          },
          [pendingAssistantVariant],
          0,
        )
        nextMessages.splice(userIndex + 1, 0, assistantMessage)
      }

      runtimeMessages = nextMessages.slice(0, userIndex + 1)
      return nextMessages.map(message =>
        message.id === updatedUserMessage.id
          ? {
            ...message,
            linkedMessageId: targetAssistantMessage?.id || pendingAssistantMessageId,
          }
          : message.id === (targetAssistantMessage?.id || pendingAssistantMessageId)
            ? {
              ...message,
              linkedMessageId: updatedUserMessage.id,
            }
            : message,
      )
    })()

    const pendingAssistantBindingMessageId = targetAssistantMessage?.id || pendingAssistantMessageId
    const pendingAssistantBindingVariantIndex = (() => {
      const pendingMessage = updatedMessages.find(
        message => message.id === pendingAssistantBindingMessageId,
      )
      if (!pendingMessage) {
        return 0
      }
      const variants = ensureMessageVariants(pendingMessage)
      return typeof pendingMessage.activeVersionIndex === 'number'
        ? Math.max(0, Math.min(pendingMessage.activeVersionIndex, variants.length - 1))
        : variants.length - 1
    })()

    updateSession(sessionId, session => ({
      ...session,
      title: session.messages.length === 0 ? summarizeTitle(contentForDisplay) : session.title,
      providerProfileId: latestProviderProfile?.id || session.providerProfileId,
      provider: latestEffectiveProvider,
      model: latestEffectiveModel,
      contextCompression: nextContextCompression,
      messages: updatedMessages,
      toolEvents: [],
      taskTree: [],
      workspacePath,
      updatedAt: Date.now(),
    }))
    if (!options?.attachmentsOverride) {
      clearComposerState(sessionId)
    }
    setError('')

    try {
      const taskId = await startAgentTask(
        runtimeSettings,
        buildRuntimeMessagesWithContextCompression(runtimeMessages, nextContextCompression),
        resolvedCapabilities.runtime,
        undefined,
        {
          sessionId,
          userMessageId: pendingUserVersionId,
          assistantMessageId: pendingAssistantVersionId,
          messageGroupId: pendingAssistantMessageId,
        },
      )
      setRunningTasksBySession(current => ({
        ...current,
        [sessionId]: {
          taskId,
          messageId: pendingAssistantBindingMessageId,
          variantIndex: pendingAssistantBindingVariantIndex,
        },
      }))
      setAgentTasksBySession(current => ({
        ...current,
        [sessionId]: {
          id: taskId,
          status: 'queued',
          toolEvents: [],
          taskTree: [],
          reasoning: [],
          phaseOutputs: [],
        },
      }))
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Agent 启动失败。')
      updateSession(sessionId, session => ({
        ...session,
        messages: session.messages.map(message => {
          if (message.id === (targetAssistantMessage?.id || pendingAssistantMessageId)) {
            const variants = ensureMessageVariants(message)
            if (variants.length <= 1 && !targetAssistantMessage) {
              return null
            }

            if (targetAssistantMessage) {
              return applyMessageVariant(message, variants.slice(0, -1), variants.length - 2)
            }
          }

          if (message.id === targetUserMessage?.id) {
            const variants = ensureMessageVariants(message)
            return applyMessageVariant(message, variants.slice(0, -1), variants.length - 2)
          }

          return message
        }).filter((message): message is ChatMessage => Boolean(message)),
        updatedAt: Date.now(),
      }))
    }
  }

  async function submit(draftOverride?: string) {
    await submitPrompt(typeof draftOverride === 'string' ? draftOverride : draft)
  }

  async function handleApproval(decision: ApprovalDecision) {
    if (!activeSession || !agentTask?.id) {
      return
    }
    await respondToApproval(agentTask.id, decision)
    setAgentTasksBySession(current => ({
      ...current,
      [activeSession.id]: current[activeSession.id]
        ? {
          ...current[activeSession.id],
          status: 'running',
          taskTree: resolveVisibleTaskTree(
            current[activeSession.id].taskTree || [],
            current[activeSession.id].pendingApproval,
          ),
          pendingApproval: undefined,
          pendingUserInput: undefined,
        }
        : current[activeSession.id],
    }))
  }

  async function handleCancelCurrentStep() {
    if (!activeSession || !agentTask?.id) {
      return
    }
    try {
      await cancelAgentTaskStep(agentTask.id)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '停止当前步骤失败。')
    }
  }

  async function copyText(value: string, html?: string) {
    try {
      if (html && 'ClipboardItem' in window && navigator.clipboard.write) {
        await navigator.clipboard.write([
          new ClipboardItem({
            'text/html': new Blob([html], { type: 'text/html' }),
            'text/plain': new Blob([value], { type: 'text/plain' }),
          }),
        ])
        showToast('已复制富文本内容')
      } else {
        await navigator.clipboard.writeText(value)
        showToast(html ? '已复制纯文本，当前环境不支持富文本剪贴板。' : '已复制到剪贴板')
      }
    } catch {
      try {
        await navigator.clipboard.writeText(value)
        showToast(html ? '已复制纯文本，富文本复制失败。' : '已复制到剪贴板')
      } catch {
        showToast('复制失败，请检查系统剪贴板权限。', 'error')
      }
    }
  }

  function applyMessageToDraft(messageId: string) {
    if (!activeSession) {
      return
    }
    const message = activeSession?.messages.find(entry => entry.id === messageId)
    if (!message) {
      return
    }
    updateComposerState(activeSession.id, current => ({
      ...current,
      draft: message.content,
    }))
  }

  function toggleMessageActivity(messageId: string) {
    if (!activeSession) {
      return
    }
    updateSession(activeSession.id, session => ({
      ...session,
      messages: session.messages.map(message =>
        message.id === messageId && message.activity
          ? updateActiveMessageVariant(message, currentVariant => ({
            ...currentVariant,
            activity: currentVariant.activity
              ? {
                ...currentVariant.activity,
                expanded: !currentVariant.activity.expanded,
              }
              : currentVariant.activity,
          }))
          : message,
      ),
      updatedAt: Date.now(),
    }))
  }

  async function regenerateFromMessage(
    messageId: string,
    options?: {
      providerProfileId?: string
      modelId?: string
    },
  ) {
    if (!activeSession || runningTasksBySession[activeSession.id]) {
      return
    }

    const assistantMessage = activeSession.messages.find(
      message => message.id === messageId && message.role === 'assistant',
    )
    if (!assistantMessage) {
      return
    }

    const sourceUserMessage =
      (assistantMessage.linkedMessageId
        ? activeSession.messages.find(message => message.id === assistantMessage.linkedMessageId)
        : null) ||
      [...activeSession.messages]
        .reverse()
        .find(
          message =>
            message.role === 'user' &&
            activeSession.messages.findIndex(entry => entry.id === message.id) <
            activeSession.messages.findIndex(entry => entry.id === assistantMessage.id),
        )

    if (!sourceUserMessage || sourceUserMessage.role !== 'user') {
      setError('没有找到可用于重新生成的上一条用户消息。')
      return
    }

    await submitPrompt(sourceUserMessage.content, {
      targetUserMessageId: sourceUserMessage.id,
      targetAssistantMessageId: assistantMessage.id,
      attachmentsOverride: sourceUserMessage.attachments || [],
      appendUserVersion: false,
      providerProfileIdOverride: options?.providerProfileId,
      modelOverride: options?.modelId,
      researchModeOverride: sourceUserMessage.researchMode,
    })
  }

  async function resendUserMessage(messageId: string) {
    if (!activeSession || runningTasksBySession[activeSession.id]) {
      return
    }

    const message = activeSession.messages.find(
      entry => entry.id === messageId && entry.role === 'user',
    )
    if (!message) {
      return
    }

    const pairedAssistant =
      (message.linkedMessageId
        ? activeSession.messages.find(entry => entry.id === message.linkedMessageId)
        : null) || null

    await submitPrompt(message.content, {
      targetUserMessageId: message.id,
      targetAssistantMessageId: pairedAssistant?.role === 'assistant' ? pairedAssistant.id : undefined,
      attachmentsOverride: message.attachments || [],
      researchModeOverride: message.researchMode,
    })
  }

  async function regenerateFromMessageWithModel(
    messageId: string,
    profileId: string,
    modelId: string,
  ) {
    await regenerateFromMessage(messageId, {
      providerProfileId: profileId,
      modelId,
    })
  }

  function deleteMessage(messageId: string) {
    if (!activeSession) {
      return
    }

    if (runningTasksBySession[activeSession.id]?.messageId === messageId) {
      setError('当前消息仍在执行中，请等待完成或先停止本轮回答。')
      return
    }

    updateSession(activeSession.id, session => {
      const targetMessage = session.messages.find(message => message.id === messageId)
      const targetWillRemain = targetMessage
        ? ensureMessageVariants(targetMessage).length > 1
        : false

      return {
        ...session,
        contextCompression:
          shouldInvalidateContextCompressionForMessage(session, messageId)
            ? undefined
            : session.contextCompression,
        messages: session.messages
          .map(message =>
            message.id === messageId ? deleteActiveMessageVariant(message) : message,
          )
          .filter((message): message is ChatMessage => Boolean(message))
          .map(message =>
            message.linkedMessageId === messageId && !targetWillRemain
              ? {
                ...message,
                linkedMessageId: undefined,
              }
              : message,
          ),
        updatedAt: Date.now(),
      }
    })
  }

  function selectMessageVersion(messageId: string, nextIndex: number) {
    if (!activeSession) {
      return
    }

    updateSession(activeSession.id, session => ({
      ...session,
      contextCompression:
        shouldInvalidateContextCompressionForMessage(session, messageId)
          ? undefined
          : session.contextCompression,
      messages: session.messages.map(message => {
        if (message.id !== messageId) {
          return message
        }
        const variants = ensureMessageVariants(message)
        return applyMessageVariant(message, variants, nextIndex)
      }),
      updatedAt: Date.now(),
    }))
  }

  async function handleStopAgentTask() {
    if (!activeSession || !agentTask?.id || !activeRunningTask) {
      return
    }
    const taskId = agentTask.id
    if (abortingAgentTaskIdsRef.current.has(taskId)) {
      return
    }
    abortingAgentTaskIdsRef.current.add(taskId)
    try {
      await abortAgentTask(taskId)
      const stoppedAt = Date.now()
      const currentSnapshot = agentTasksBySession[activeSession.id]
      const stoppedSessions = sessionsRef.current.map(session =>
        session.id === activeSession.id
          ? {
            ...session,
            messages: session.messages.map(message =>
              message.id === activeRunningTask.messageId
                ? updateMessageVariantAtIndex(message, activeRunningTask.variantIndex, currentVariant => ({
                  ...currentVariant,
                  status: 'failed' as const,
                  error: '已停止本次回答。',
                  errorInfo: {
                    source: 'system',
                    category: 'cancelled',
                    code: 'USER_ABORTED',
                    summary: '这次回答已被中途停止。',
                    suggestedAction: '如果还需要继续，可以重新发起一次生成。',
                  },
                  appendedInputs:
                    currentSnapshot?.appendedInputs || currentVariant.appendedInputs,
                  phaseOutputs:
                    currentSnapshot?.phaseOutputs || currentVariant.phaseOutputs,
                  events:
                    currentSnapshot?.toolEvents.map(event =>
                      mapToolEventToMessageEvent(event, { lazyDetails: true }),
                    ) ||
                    currentVariant.events,
                  steps: currentSnapshot?.taskTree || currentVariant.steps,
                  activity: currentVariant.activity
                    ? {
                      ...currentVariant.activity,
                      status: 'failed',
                      finishedAt: stoppedAt,
                      expanded: false,
                    }
                    : currentVariant.activity,
                  retryInfo: clearRetryProgressInfo(
                    currentSnapshot?.retryInfo || currentVariant.retryInfo,
                  ),
                }))
                : message,
            ),
            updatedAt: stoppedAt,
          }
          : session,
      )
      sessionsRef.current = stoppedSessions
      setSessions(stoppedSessions)
      await saveSessionsAndAwaitPersistence(stoppedSessions)
      if (currentSnapshot) {
        const details = buildMessageEventDetailRecords(currentSnapshot.toolEvents)
        if (details.length > 0) {
          await upsertPersistedMessageEventDetails(
            activeRunningTask.messageId,
            activeRunningTask.variantIndex,
            details,
          )
        }
      }
      setRunningTasksBySession(current => {
        const next = { ...current }
        delete next[activeSession.id]
        return next
      })
      setAgentTasksBySession(current => {
        const next = { ...current }
        delete next[activeSession.id]
        return next
      })
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '终止任务失败。')
    } finally {
      abortingAgentTaskIdsRef.current.delete(taskId)
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
      providerProfiles: settings.providerProfiles.map(entry =>
        entry.id === profile.id
          ? {
            ...entry,
            defaultModel: modelId,
          }
          : entry,
      ),
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

  function setProjectCapabilityOverride(
    kind: 'skills' | 'plugins' | 'mcp',
    id: string,
    mode: CapabilityOverrideMode,
  ) {
    if (!activeSession) {
      setError('当前会话尚未准备好，暂时无法保存会话工具设置。')
      return
    }

    const nextSessions = sessions.map(session =>
      session.id === activeSession.id
        ? {
          ...session,
          capabilityOverrides: updateCapabilityOverride(
            session.capabilityOverrides,
            kind,
            id,
            mode,
          ),
          updatedAt: Date.now(),
        }
        : session,
    )
    setSessions(nextSessions)
    saveSessions(nextSessions)
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
          deletedSessions={deletedSessions}
          sessionFolders={sessionFolders}
          runningSessionIds={Object.keys(runningTasksBySession)}
          activeSessionId={activeSession?.id || null}
          onOpenSession={openSession}
          onCreateSession={createFreshSession}
          onCreateSessionFolder={createSessionFolder}
          onRenameSessionFolder={renameSessionFolder}
          onDeleteSessionFolder={deleteSessionFolder}
          onToggleSessionFolder={toggleSessionFolder}
          onMoveSessionToFolder={moveSessionToFolder}
          onRenameSession={renameSession}
          onGenerateSessionTitle={generateTitleForSession}
          onShowToast={showToast}
          onDeleteSession={sessionId => void deleteSession(sessionId)}
          onRestoreSession={sessionId => void restoreDeletedSession(sessionId)}
          onPermanentlyDeleteSession={sessionId => void permanentlyDeleteSession(sessionId)}
          onOpenSettings={() =>
            void openSettingsWindow('general').catch(caught => {
              setError(caught instanceof Error ? caught.message : '打开设置窗口失败。')
            })
          }
          settingsOpen={false}
          updateRelease={updateRelease}
          onShowUpdate={() => setUpdateModalOpen(true)}
        />
        <div
          className="w-1 shrink-0 cursor-col-resize bg-transparent hover:bg-[rgba(79,123,116,0.18)] transition-colors"
          onMouseDown={handleSidebarResizeStart}
          title="拖动调整会话列表宽度"
        />

        <main className="flex-1 flex flex-col min-w-0">
          {activeSession ? (
            activeSessionMessagesLoading ? (
              <section className="flex h-full items-center justify-center text-sm text-[var(--text-secondary)]">
                正在加载会话历史...
              </section>
            ) : (
              <ChatView
                sessionId={activeSession.id}
                messages={activeSession.messages}
                displayedToolEvents={displayedToolEvents}
                displayedTaskTree={displayedTaskTree}
                settings={effectiveSettings}
                contextCompression={activeSession.contextCompression}
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
                capabilityItems={currentCapabilityItems}
                capabilitySnapshot={currentResolvedCapabilityUsage}
                modelGroups={enabledModelGroups}
                activeModelProfileId={activeProviderProfile?.id || ''}
                researchMode={draftResearchMode}
                onDraftChange={value => {
                  if (!activeSession) {
                    return
                  }
                  updateComposerState(activeSession.id, current => ({
                    ...current,
                    draft: value,
                  }))
                }}
                onToggleResearchMode={() => {
                  if (!activeSession) {
                    return
                  }
                  updateComposerState(activeSession.id, current => ({
                    ...current,
                    researchMode: current.researchMode === 'deep' ? 'auto' : 'deep',
                  }))
                }}
                onSetCapabilityOverride={setProjectCapabilityOverride}
                onSubmit={value => void submit(value)}
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
                onCopyText={(value, html) => void copyText(value, html)}
                onEditMessage={applyMessageToDraft}
                onDeleteMessage={deleteMessage}
                onSelectMessageVersion={selectMessageVersion}
                onRegenerateMessage={messageId => void regenerateFromMessage(messageId)}
                onRegenerateMessageWithModel={(messageId, profileId, modelId) =>
                  void regenerateFromMessageWithModel(messageId, profileId, modelId)
                }
                onResendMessage={messageId => void resendUserMessage(messageId)}
                onForceExecuteAppendedInput={(messageId, inputId) =>
                  void forceExecuteAppendedInput(messageId, inputId)
                }
                onCancelCurrentStep={() => void handleCancelCurrentStep()}
                onCompressContext={() => void handleCompressActiveContext()}
                onToggleMessageActivity={toggleMessageActivity}
                onLoadMessageEventDetail={loadMessageEventDetail}
                onStop={() => void handleStopAgentTask()}
                contextCompressionRunning={contextCompressionSessionId === activeSession.id}
              />
            )
          ) : (
            <HomeView
              providerConfigured={isProviderReady(activeProviderProfile, settings)}
              workspaceConfigured={Boolean(settings.cwd.trim())}
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
      <UpdateModal
        isOpen={isUpdateModalOpen}
        currentVersion={currentVersion}
        release={updateRelease}
        onClose={() => setUpdateModalOpen(false)}
      />
      {toast ? (
        <div
          key={toast.id}
          className={`app-toast ${toast.tone === 'error' ? 'app-toast--error' : 'app-toast--success'}`}
          role="status"
          aria-live="polite"
        >
          {toast.message}
        </div>
      ) : null}
    </>
  )
}
