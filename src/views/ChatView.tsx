import {
  forwardRef,
  memo,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type HTMLAttributes,
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type RefObject,
  type ReactNode,
} from 'react'
import ReactMarkdown from 'react-markdown'
import rehypeKatex from 'rehype-katex'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import 'katex/dist/katex.min.css'
import '@xterm/xterm/css/xterm.css'
import {
  ArrowDown,
  Bot,
  Brain,
  Telescope,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Copy,
  Download,
  Eye,
  FolderOpen,
  LayoutGrid,
  MoreHorizontal,
  Paperclip,
  Pencil,
  RefreshCw,
  Search,
  SendHorizontal,
  SlidersHorizontal,
  Sparkles,
  Square,
  Trash2,
  Wrench,
  X,
} from 'lucide-react'
import { readImagePreview } from '../lib/workspace'
import { WorkspaceExplorer } from '../components/WorkspaceExplorer'
import { TaskTreeView } from '../components/TaskTreeView'
import {
  WebFetchEventCard,
  WebResearchEventCard,
  WebSearchEventCard,
} from '../components/WebToolEventCards'
import { formatConversationTimestamp } from '../lib/sessionMeta'
import { countTextTokens } from '../lib/tokenizer'
import { buildRuntimeMessagesWithContextCompression } from '../lib/agent'
import { toggleEditTransactionSnapshots } from '../lib/workspace'
import type {
  AgentExecutionPhase,
  AgentSettings,
  AgentTaskSnapshot,
  ApprovalDecision,
  AppendedInput,
  CapabilityOverrideMode,
  CapabilityPanelItem,
  CapabilityUsageSnapshot,
  ChatMessage,
  ChatMessageVariant,
  CompletionState,
  MessageAttachment,
  MessageEvent,
  MessagePhaseOutput,
  MessageReasoning,
  MessageStatus,
  MessageUsage,
  ProviderMode,
  ReasoningEffort,
  ResearchMode,
  RouteDecisionSnapshot,
  RuntimeErrorInfo,
  SessionContextCompression,
  TaskNode,
  ToolEvent,
  WorkspaceNode,
} from '../types'

type ModelGroup = {
  profileId: string
  profileName: string
  provider: ProviderMode
  models: Array<{ id: string; enabled: boolean }>
}

type CopyTextHandler = (value: string, html?: string) => void

type Props = {
  sessionId: string
  messages: ChatMessage[]
  displayedToolEvents: ToolEvent[]
  displayedTaskTree: TaskNode[]
  settings: AgentSettings
  contextCompression?: SessionContextCompression
  draft: string
  error: string
  isRunning: boolean
  agentTask: AgentTaskSnapshot | null
  workspaceRootPath: string
  workspaceTree: WorkspaceNode | null
  workspaceLoading: boolean
  workspaceError: string
  expandedPaths: string[]
  selectedFilePath: string | null
  previewContent: string
  previewImage: string
  previewLoading: boolean
  previewError: string
  canChangeWorkspace: boolean
  inspectorWidth: number
  attachments: Array<{
    id: string
    name: string
    path?: string
    preview?: string
  }>
  capabilityItems: CapabilityPanelItem[]
  capabilitySnapshot?: CapabilityUsageSnapshot
  modelGroups: ModelGroup[]
  activeModelProfileId: string
  researchMode: ResearchMode
  onDraftChange: (value: string) => void
  onToggleResearchMode: () => void
  onSetCapabilityOverride: (
    kind: 'skills' | 'plugins' | 'mcp',
    id: string,
    mode: CapabilityOverrideMode,
  ) => void
  onSubmit: () => void
  onOpenProviders: () => void
  onHandleApproval: (decision: ApprovalDecision) => void
  onOpenWorkspaceExplorer: () => void
  onChooseWorkspace: () => void
  onPickAttachment: () => void
  onPasteAttachments: (files: File[]) => void
  onSelectModel: (profileId: string, modelId: string) => void
  onSelectReasoningEffort: (value: ReasoningEffort) => void
  onOpenAttachment: (path: string) => void
  onRemoveAttachment: (attachmentId: string) => void
  onRefreshWorkspace: () => void
  onToggleWorkspacePath: (path: string) => void
  onSelectWorkspaceFile: (path: string) => void
  onInsertFileReference: (path: string) => void
  onInspectorWidthChange: (value: number) => void
  onCopyPath: (path: string) => void
  onCopyText: CopyTextHandler
  onEditMessage: (messageId: string) => void
  onDeleteMessage: (messageId: string) => void
  onSelectMessageVersion: (messageId: string, nextIndex: number) => void
  onRegenerateMessage: (messageId: string) => void
  onRegenerateMessageWithModel: (messageId: string, profileId: string, modelId: string) => void
  onResendMessage: (messageId: string) => void
  onForceExecuteAppendedInput: (messageId: string, inputId: string) => void
  onCancelCurrentStep: () => void
  onCompressContext: () => void
  onToggleMessageActivity: (messageId: string) => void
  onStop: () => void
  contextCompressionRunning?: boolean
}

const reasoningEffortOptions: Array<{
  value: ReasoningEffort
  label: string
  description: string
}> = [
    { value: 'off', label: '关闭', description: '禁用扩展思考' },
    { value: 'low', label: '低', description: '快速响应，最少推理' },
    { value: 'medium', label: '中', description: '平衡速度与推理深度' },
    { value: 'high', label: '高', description: '深度推理，适合复杂任务' },
    { value: 'max', label: '超高', description: '最强推理强度，适合最复杂任务' },
  ]

const DEFAULT_CONTEXT_WINDOW_TOKENS = 256_000
const IMAGE_PART_TOKEN_COST = 1_200
const FILE_PART_TOKEN_COST = 80

function formatTokenCount(value: number) {
  if (value >= 1000) {
    return `${(value / 1000).toFixed(value >= 100_000 ? 0 : 1)}k`
  }
  return String(value)
}

function resolveConfiguredContextWindowTokens(settings: AgentSettings) {
  const profiles = Array.isArray(settings.providerProfiles) ? settings.providerProfiles : []
  const activeProfile =
    profiles.find(profile => profile.id === settings.activeProviderProfileId) ||
    profiles.find(profile => profile.provider === settings.provider)
  const model = activeProfile?.models?.find(entry => entry.id === settings.model)
  const modelWindow = Number(model?.contextWindowTokens)
  if (Number.isFinite(modelWindow) && modelWindow > 0) {
    return Math.round(modelWindow)
  }

  const localBudget = Number(settings.contextCompressionThresholdTokens)
  if (Number.isFinite(localBudget) && localBudget > 0) {
    return Math.round(localBudget)
  }

  return DEFAULT_CONTEXT_WINDOW_TOKENS
}

function estimateTextTokens(value = '', model = '') {
  return countTextTokens(value, model)
}

function estimateMessageContextTokens(message: ChatMessage, model = '') {
  const contentTokens = estimateTextTokens(message.content || '', model)
  const parts = message.parts || []
  const partTokens = parts.reduce((total, part) => {
    if (part.type === 'text') {
      return total + estimateTextTokens(part.text || '', model)
    }
    if (part.type === 'image') {
      return total + IMAGE_PART_TOKEN_COST +
        estimateTextTokens([part.name, part.mimeType, part.path].filter(Boolean).join(' '), model)
    }
    if (part.type === 'file') {
      return total + FILE_PART_TOKEN_COST +
        estimateTextTokens([part.name, part.path, part.mimeType].filter(Boolean).join(' '), model)
    }
    return total
  }, 0)
  const textPartContent = parts.reduce<string[]>((entries, part) => {
    if (part.type === 'text' && typeof part.text === 'string') {
      const text = part.text.trim()
      if (text) {
        entries.push(text)
      }
    }
    return entries
  }, []).join('\n')
  const contentMirrorsTextParts =
    textPartContent &&
    typeof message.content === 'string' &&
    textPartContent === message.content.trim()
  return 4 + (contentMirrorsTextParts ? 0 : contentTokens) + partTokens
}

function estimateSessionContextTokens(messages: ChatMessage[], model = '') {
  return messages.reduce(
    (total, message) => total + estimateMessageContextTokens(message, model),
    0,
  )
}

function getActiveMessageVariant(message: ChatMessage): ChatMessageVariant {
  const variants =
    Array.isArray(message.versions) && message.versions.length > 0
      ? message.versions
      : [message as ChatMessageVariant]
  const requestedIndex = Number.isFinite(message.activeVersionIndex)
    ? Math.max(0, Math.floor(message.activeVersionIndex || 0))
    : 0
  return variants[requestedIndex] || variants[0]
}

function findLatestRouteDecision(
  messages: ChatMessage[],
  activeRouteDecision?: RouteDecisionSnapshot,
) {
  if (activeRouteDecision) {
    return activeRouteDecision
  }

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    const activeVariant = getActiveMessageVariant(message)
    if (activeVariant.routeDecision) {
      return activeVariant.routeDecision
    }
    if (message.routeDecision) {
      return message.routeDecision
    }
  }

  return undefined
}

function mergeUsageTotals(
  current: { inputTokens: number; outputTokens: number },
  usage?: MessageUsage,
) {
  current.inputTokens += usage?.inputTokens || 0
  current.outputTokens += usage?.outputTokens || 0
  return current
}

function collectMessageUsage(message: ChatMessage) {
  const variants =
    Array.isArray(message.versions) && message.versions.length > 0
      ? message.versions
      : [message as ChatMessageVariant]

  return variants.reduce(
    (total, variant) => mergeUsageTotals(total, variant.usage),
    { inputTokens: 0, outputTokens: 0 },
  )
}

function collectSessionUsage(messages: ChatMessage[]) {
  return messages.reduce((total, message) => {
    const messageUsage = collectMessageUsage(message)
    total.inputTokens += messageUsage.inputTokens
    total.outputTokens += messageUsage.outputTokens
    return total
  }, { inputTokens: 0, outputTokens: 0 })
}

function findLatestUsage(messages: ChatMessage[]) {
  for (const message of [...messages].reverse()) {
    const variant = getActiveMessageVariant(message)
    if (variant.usage) {
      return variant.usage
    }
    if (message.usage) {
      return message.usage
    }
  }
  return undefined
}

function usageRows(usage?: MessageUsage) {
  const inputTokens = usage?.inputTokens || 0
  const outputTokens = usage?.outputTokens || 0

  return [
    { label: '输入 Token', value: formatTokenCount(inputTokens) },
    { label: '输出 Token', value: formatTokenCount(outputTokens) },
    { label: '总 Token', value: formatTokenCount(inputTokens + outputTokens) },
  ]
}

function ContextTokenMeter({
  currentTokens,
  cumulativeTokens,
  contextWindowTokens,
  contextCompression,
  compressionRunning,
  compressionDisabled,
  onCompressContext,
}: {
  currentTokens: number
  cumulativeTokens: number
  contextWindowTokens: number
  contextCompression?: SessionContextCompression
  compressionRunning?: boolean
  compressionDisabled?: boolean
  onCompressContext: () => void
}) {
  const [open, setOpen] = useState(false)
  const closeTimerRef = useRef<number | null>(null)
  const safeContextWindow = Math.max(1, contextWindowTokens || DEFAULT_CONTEXT_WINDOW_TOKENS)
  const effectiveWindow = contextCompression?.contextWindowTokens || safeContextWindow
  const effectiveThreshold =
    contextCompression?.effectiveThresholdTokens ||
    contextCompression?.compressionThresholdTokens ||
    0
  const windowSourceLabel =
    contextCompression?.windowSource === 'model_metadata'
      ? '模型配置'
      : contextCompression?.windowSource === 'settings'
        ? '本地设置'
        : contextCompression?.windowSource === 'inferred'
          ? '系统推断'
          : contextCompression?.windowSource || ''
  const ratio = Math.max(0, Math.min(1, currentTokens / safeContextWindow))
  const percent = Math.round(ratio * 100)
  const circumference = 2 * Math.PI * 8
  const strokeDashoffset = circumference * (1 - ratio)

  function openTooltip() {
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current)
      closeTimerRef.current = null
    }
    setOpen(true)
  }

  function scheduleCloseTooltip() {
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current)
    }
    closeTimerRef.current = window.setTimeout(() => {
      setOpen(false)
      closeTimerRef.current = null
    }, 140)
  }

  useEffect(() => () => {
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current)
    }
  }, [])

  return (
    <div
      className="relative ml-1"
      onMouseEnter={openTooltip}
      onMouseLeave={scheduleCloseTooltip}
      onFocus={openTooltip}
      onBlur={event => {
        if (!event.currentTarget.contains(event.relatedTarget)) {
          scheduleCloseTooltip()
        }
      }}
    >
      <button
        type="button"
        className="flex items-center gap-1 rounded-full bg-[rgba(15,23,42,0.04)] px-1.5 py-0.5 text-9px font-700 opacity-70 transition-colors hover:bg-[rgba(15,23,42,0.07)] hover:opacity-100"
        aria-label="当前上下文"
        onClick={() => setOpen(current => !current)}
      >
        <svg width="18" height="18" viewBox="0 0 20 20" aria-hidden="true">
          <circle
            cx="10"
            cy="10"
            r="8"
            fill="none"
            stroke="rgba(15,23,42,0.12)"
            strokeWidth="2.4"
          />
          <circle
            cx="10"
            cy="10"
            r="8"
            fill="none"
            stroke="var(--accent-soft-strong)"
            strokeWidth="2.4"
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={strokeDashoffset}
            transform="rotate(-90 10 10)"
          />
        </svg>
        <span>{formatTokenCount(currentTokens)}</span>
      </button>
      {open ? (
        <div className="absolute bottom-full left-1/2 z-[80] w-[240px] -translate-x-1/2 pb-2">
          <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-panel)] px-3 py-2.5 text-center shadow-2xl backdrop-blur-md">
            <div className="text-11px font-500 text-[var(--text-secondary)] opacity-80">当前上下文</div>
            <div className="mt-1 text-14px font-700 text-[var(--text-primary)]">{percent}% 已用</div>
            <div className="mt-1 text-12px text-[var(--text-secondary)]">
              {formatTokenCount(currentTokens)} / {formatTokenCount(safeContextWindow)}
            </div>
            {contextCompression?.contextWindowTokens || contextCompression?.windowSource ? (
              <div className="mt-1 text-10px text-[var(--text-secondary)] opacity-65">
                实际窗口 {formatTokenCount(effectiveWindow)}
                {windowSourceLabel ? ` · ${windowSourceLabel}` : ''}
              </div>
            ) : null}
            {effectiveThreshold > 0 ? (
              <div className="mt-1 text-10px text-[var(--text-secondary)] opacity-65">
                有效压缩阈值 {formatTokenCount(effectiveThreshold)}
              </div>
            ) : null}
            <div className="mt-2 border-t border-[var(--border-subtle)] pt-2 text-10px text-[var(--text-secondary)] opacity-70">
              模型总消耗 {formatTokenCount(cumulativeTokens)}
            </div>
            {contextCompression ? (
              <div className="mt-1 text-10px text-[var(--text-secondary)] opacity-65">
                上次压缩 {formatTokenCount(contextCompression.originalTokenEstimate)}{' -> '}
                {formatTokenCount(contextCompression.compressedTokenEstimate)}
                {contextCompression.kind ? ` · ${contextCompression.kind}` : ''}
              </div>
            ) : (
              <div className="mt-1 text-10px text-[var(--text-secondary)] opacity-50">上次压缩 暂无</div>
            )}
            <button
              type="button"
              className="mt-2 inline-flex items-center justify-center rounded-lg border border-[rgba(79,123,116,0.2)] bg-white px-2.5 py-1 text-10px font-700 text-[var(--accent-soft-strong)] transition-colors hover:bg-[rgba(79,123,116,0.06)] disabled:cursor-not-allowed disabled:opacity-45"
              disabled={compressionRunning || compressionDisabled}
              onClick={() => {
                onCompressContext()
                setOpen(false)
              }}
            >
              {compressionRunning ? '压缩中...' : '立即压缩'}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  )
}

const suggestedPrompts = [
  '分析当前项目结构，并说明核心模块职责',
  '帮我定位一个 bug，并给出最小修复方案',
  '为当前工作区设计一个新功能的实现计划',
  '解释这个项目的启动流程和关键依赖',
]

function summarizePath(path: string) {
  if (!path.trim()) {
    return '未设置工作区'
  }
  const segments = path.split('/').filter(Boolean)
  if (segments.length <= 2) {
    return path
  }
  return `.../${segments.slice(-2).join('/')}`
}

function mimeTypeFromAttachmentPath(filePath?: string) {
  const normalized = typeof filePath === 'string' ? filePath.trim() : ''
  if (!normalized) {
    return ''
  }
  const extension = normalized.split('.').pop()?.toLowerCase() || ''
  switch (extension) {
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
    default:
      return ''
  }
}

function attachmentLooksLikeImage(attachment: {
  path?: string
  preview?: string
  mimeType?: string
}) {
  if (attachment.preview?.startsWith('data:image/')) {
    return true
  }
  return (
    (typeof attachment.mimeType === 'string' && attachment.mimeType.startsWith('image/')) ||
    mimeTypeFromAttachmentPath(attachment.path).startsWith('image/')
  )
}

function AttachmentThumbnail({
  attachment,
  alt,
  className,
  fallbackClassName,
  iconSize = 16,
}: {
  attachment: {
    path?: string
    preview?: string
    mimeType?: string
    name: string
  }
  alt: string
  className: string
  fallbackClassName: string
  iconSize?: number
}) {
  const [preview, setPreview] = useState(attachment.preview || '')

  useEffect(() => {
    if (attachment.preview) {
      setPreview(attachment.preview)
      return
    }
    if (!attachmentLooksLikeImage(attachment) || !attachment.path) {
      setPreview('')
      return
    }

    let cancelled = false
    void readImagePreview(attachment.path)
      .then(nextPreview => {
        if (!cancelled && nextPreview) {
          setPreview(nextPreview)
        }
      })
      .catch(() => {
        if (!cancelled) {
          setPreview('')
        }
      })

    return () => {
      cancelled = true
    }
  }, [attachment.mimeType, attachment.path, attachment.preview])

  if (preview) {
    return (
      <img
        src={preview}
        alt={alt}
        className={className}
      />
    )
  }

  return (
    <div className={fallbackClassName}>
      <Paperclip size={iconSize} />
    </div>
  )
}

function parseJsonOutput(value?: string) {
  if (!value?.trim()) {
    return null
  }

  try {
    return JSON.parse(value) as Record<string, unknown>
  } catch {
    return null
  }
}

function readEventStructuredOutput(event: MessageEvent) {
  return isRecord(event.structuredOutput) ? event.structuredOutput : parseJsonOutput(event.output)
}

const ANSI_OSC_PATTERN = /\u001B\][\s\S]*?(?:\u0007|\u001B\\)/g
const ANSI_CSI_PATTERN = /(?:\u001B\[|\u009B)[0-?]*[ -/]*[@-~]/g
const ANSI_SINGLE_PATTERN = /\u001B[@-_]/g

function sanitizeTerminalOutput(value?: string) {
  const input = typeof value === 'string' ? value : ''
  if (!input) {
    return ''
  }

  const stripped = input
    .replace(ANSI_OSC_PATTERN, '')
    .replace(ANSI_CSI_PATTERN, '')
    .replace(ANSI_SINGLE_PATTERN, '')
    .replace(/\uFFFD/g, '')

  const lines: string[] = []
  let currentLine = ''

  for (let index = 0; index < stripped.length; index += 1) {
    const char = stripped[index]

    if (char === '\r') {
      currentLine = ''
      continue
    }

    if (char === '\n') {
      lines.push(currentLine)
      currentLine = ''
      continue
    }

    if (char === '\b') {
      currentLine = currentLine.slice(0, -1)
      continue
    }

    if (char === '\t') {
      currentLine += '  '
      continue
    }

    if (char < ' ' || char === '\u007F') {
      continue
    }

    currentLine += char
  }

  if (currentLine) {
    lines.push(currentLine)
  }

  return lines
    .join('\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd()
}

function parseShellEventSnapshot(output?: string) {
  const parsed = parseJsonOutput(output)
  if (!parsed) {
    return null
  }

  const hasShellShape =
    typeof parsed.command === 'string' ||
    typeof parsed.output === 'string' ||
    typeof parsed.stdout === 'string' ||
    typeof parsed.stderr === 'string' ||
    typeof parsed.status === 'string' ||
    typeof parsed.running === 'boolean'

  if (!hasShellShape) {
    return null
  }

  return {
    command: typeof parsed.command === 'string' ? parsed.command : '',
    status: typeof parsed.status === 'string' ? parsed.status : '',
    running: parsed.running === true,
    output: typeof parsed.output === 'string' ? parsed.output : '',
    stdout: typeof parsed.stdout === 'string' ? parsed.stdout : '',
    stderr: typeof parsed.stderr === 'string' ? parsed.stderr : '',
    truncated: parsed.truncated === true,
    wallTimeMs:
      typeof parsed.wallTimeMs === 'number' && Number.isFinite(parsed.wallTimeMs)
        ? parsed.wallTimeMs
        : undefined,
    exitCode:
      typeof parsed.exitCode === 'number' && Number.isFinite(parsed.exitCode)
        ? parsed.exitCode
        : undefined,
  }
}

function formatDuration(ms: number) {
  if (ms < 1000) {
    return `${ms} ms`
  }
  if (ms < 10_000) {
    return `${(ms / 1000).toFixed(1)} 秒`
  }
  return `${Math.round(ms / 1000)} 秒`
}

function clampToTwoLines(value: string, maxChars = 68) {
  const normalized = value.replace(/\s+/g, ' ').trim()
  if (!normalized) {
    return ''
  }
  return normalized.length > maxChars ? `${normalized.slice(0, maxChars).trimEnd()}...` : normalized
}

function summarizeFailureReason(value?: string, fallback = '未返回更具体的失败原因。') {
  const normalized = (value || '').replace(/\s+/g, ' ').trim()
  if (!normalized) {
    return fallback
  }
  return normalized.length > 140 ? `${normalized.slice(0, 140).trimEnd()}...` : normalized
}

function formatFailureDetail(errorInfo?: RuntimeErrorInfo, error?: string) {
  const summary = (errorInfo?.summary || '').replace(/\s+/g, ' ').trim()
  const candidates = [errorInfo?.detail, error, errorInfo?.suggestedAction]

  for (const candidate of candidates) {
    const normalized = (candidate || '').trim()
    if (!normalized) {
      continue
    }
    if (summary && normalized.replace(/\s+/g, ' ') === summary) {
      continue
    }
    return normalized.length > 1200 ? `${normalized.slice(0, 1200).trimEnd()}...` : normalized
  }

  return ''
}

function activityStatusLabel(status?: string) {
  switch (status) {
    case 'queued':
      return '准备执行'
    case 'running':
      return '执行中'
    case 'awaiting_approval':
      return '等待审批'
    case 'awaiting_user_input':
      return '等待回复'
    case 'completed':
      return '已完成'
    case 'failed':
      return '执行失败'
    default:
      return '空闲'
  }
}

function activityPhaseLabel(phase?: AgentExecutionPhase, stalled = false) {
  const suffix = stalled ? '，连接较慢' : ''
  switch (phase) {
    case 'preparing':
      return `准备上下文${suffix}`
    case 'planning':
      return `判断任务规划${suffix}`
    case 'compressing_context':
      return `压缩上下文${suffix}`
    case 'model_connecting':
      return `连接模型${suffix}`
    case 'model_streaming':
      return `接收回复${suffix}`
    case 'tool_running':
      return `执行工具${suffix}`
    case 'finalizing':
      return `整理最终回答${suffix}`
    case 'recovering':
      return `连接中断，正在恢复${suffix}`
    case 'awaiting_approval':
      return '等待审批'
    case 'awaiting_user_input':
      return '等待你回复'
    default:
      return stalled ? '执行较慢' : ''
  }
}

function hasToolFailure(message?: ChatMessage) {
  return (message?.events || []).some(event => event.status === 'error')
}

function runningActivityStatusLabel(
  activity?: ChatMessage['activity'],
  isRetryInProgress = false,
  hasCurrentToolFailure = false,
) {
  if (activity?.phase === 'recovering') {
    return hasCurrentToolFailure ? '整理失败结果' : '连接中断，正在恢复'
  }
  if (isRetryInProgress) {
    return '模型响应重试中'
  }

  switch (activity?.phase) {
    case 'tool_running':
      return '工具执行中'
    case 'model_connecting':
    case 'model_streaming':
    case 'finalizing':
      return '继续回答'
    case 'compressing_context':
      return '整理上下文'
    case 'preparing':
    case 'planning':
      return '准备中'
    default:
      return '处理中'
  }
}

function isCancelledActivity(message: ChatMessage, activity?: ChatMessage['activity']) {
  const code = message.errorInfo?.code || ''
  const category = message.errorInfo?.category || ''
  return (
    activity?.status === 'failed' &&
    (category === 'cancelled' ||
      code === 'USER_ABORTED' ||
      code === 'APPENDED_INPUT_FORCE_REPLAN')
  )
}

function userFacingActivityStatusLabel(
  activity?: ChatMessage['activity'],
  message?: ChatMessage,
  isRetryInProgress = false,
) {
  switch (activity?.status) {
    case 'queued':
      return '准备中'
    case 'running':
      return runningActivityStatusLabel(
        activity,
        isRetryInProgress,
        hasToolFailure(message),
      )
    case 'awaiting_approval':
      return '等待确认'
    case 'awaiting_user_input':
      return '等待回复'
    case 'completed':
      return '已完成'
    case 'failed':
      return message && isCancelledActivity(message, activity) ? '已停止' : '执行失败'
    case 'blocked':
      return '已暂停'
    default:
      return ''
  }
}

function messageDetailStatusTitle(options: {
  activity?: ChatMessage['activity']
  message: ChatMessage
  isStreaming: boolean
  isRetryInProgress: boolean
  hasAnswer: boolean
  hasFallbackStatus: boolean
  hasToolFailure: boolean
}) {
  const {
    activity,
    message,
    isStreaming,
    isRetryInProgress,
    hasAnswer,
    hasFallbackStatus,
    hasToolFailure,
  } = options

  if (activity?.status === 'failed' || message.error) {
    return isCancelledActivity(message, activity) ? '已停止' : '执行失败'
  }
  if (activity?.status === 'blocked') {
    return '已暂停'
  }
  if (hasFallbackStatus) {
    return '未生成回答'
  }
  if (!isStreaming) {
    return ''
  }
  if (activity?.status === 'awaiting_approval') {
    return '等待确认'
  }
  if (activity?.status === 'awaiting_user_input') {
    return '等待回复'
  }
  if (activity?.phase === 'recovering') {
    return hasToolFailure ? '整理失败结果' : '连接中断，正在恢复'
  }
  if (isRetryInProgress) {
    return '模型响应重试中'
  }

  switch (activity?.phase) {
    case 'compressing_context':
      return '整理上下文'
    case 'tool_running':
      return '工具执行中'
    case 'model_connecting':
    case 'model_streaming':
    case 'finalizing':
      return hasAnswer ? '' : '继续回答'
    case 'preparing':
    case 'planning':
      return '准备中'
    default:
      return activity ? '准备中' : ''
  }
}

function messageDetailStatusDescription(options: {
  title: string
  detail?: string
  fallbackDetail?: string
  retryDetail?: string
  stalled?: boolean
}) {
  const { title, detail, fallbackDetail, retryDetail, stalled } = options
  switch (title) {
    case '整理上下文':
      return stalled
        ? '正在整理较长上下文，连接较慢，完成后会继续回答。'
        : '正在整理较长上下文，完成后会继续回答。'
    case '等待确认':
      return '需要你确认后才能继续。'
    case '等待回复':
      return '需要你补充信息后才能继续。'
    case '模型响应重试中':
      return retryDetail || '模型响应暂时失败，正在重新请求。'
    case '整理失败结果':
      return '工具执行失败，正在整理失败原因和可行的下一步。'
    case '连接中断，正在恢复':
      return retryDetail || '遇到中断，正在尝试恢复并继续回答。'
    case '已停止':
    case '执行失败':
      return detail || ''
    case '未生成回答':
      return fallbackDetail || ''
    case '已暂停':
      return '当前任务已暂停，需要处理阻塞项后继续。'
    default:
      return ''
  }
}

function formatRetryLabel(retryInfo?: ChatMessage['retryInfo'], status?: MessageStatus) {
  const terminal = status === 'completed' || status === 'failed'
  if (terminal || !retryInfo || retryInfo.attemptedRetries <= 0 || retryInfo.inProgress !== true) {
    return ''
  }

  const configuredMaxRetries =
    typeof retryInfo.configuredMaxRetries === 'number'
      ? retryInfo.configuredMaxRetries
      : typeof retryInfo.configuredMaxAttempts === 'number'
        ? Math.max(0, retryInfo.configuredMaxAttempts - 1)
        : undefined
  const showBoundedLimit =
    typeof configuredMaxRetries === 'number' &&
    Number.isFinite(configuredMaxRetries) &&
    configuredMaxRetries > 0 &&
    retryInfo.attemptedRetries <= configuredMaxRetries

  const attemptLabel =
    typeof retryInfo.nextAttemptNumber === 'number' &&
      Number.isFinite(retryInfo.nextAttemptNumber) &&
      retryInfo.nextAttemptNumber > 1
      ? `，第 ${Math.round(retryInfo.nextAttemptNumber)} 次尝试`
      : ''

  return showBoundedLimit
    ? `重试中 ${retryInfo.attemptedRetries}/${configuredMaxRetries}${attemptLabel}`
    : `重试中 ${retryInfo.attemptedRetries}${attemptLabel}`
}

function RetryStatusDots() {
  return (
    <span className="retry-status-dots" aria-hidden="true">
      <span className="retry-status-dot" />
      <span className="retry-status-dot" />
      <span className="retry-status-dot" />
    </span>
  )
}

type MessageStatusNoticeTone = 'error' | 'progress' | 'neutral'

function messageStatusNoticeTone(tone: MessageStatusNoticeTone) {
  switch (tone) {
    case 'error':
      return {
        shell: 'border-red-100 bg-red-50 text-red-500',
        detail: 'text-red-400/90',
      }
    case 'progress':
      return {
        shell:
          'border-[rgba(79,123,116,0.14)] bg-[rgba(79,123,116,0.06)] text-[var(--accent-soft-strong)]',
        detail: 'text-[rgba(79,123,116,0.82)]',
      }
    default:
      return {
        shell:
          'border-[rgba(15,23,42,0.08)] bg-[rgba(15,23,42,0.02)] text-[var(--text-secondary)]',
        detail: 'text-[var(--text-secondary)] opacity-80',
      }
  }
}

function MessageStatusNotice({
  tone,
  title,
  detail,
  animateDetail = false,
}: {
  tone: MessageStatusNoticeTone
  title?: string
  detail?: string
  animateDetail?: boolean
}) {
  if (!title && !detail) {
    return null
  }

  const palette = messageStatusNoticeTone(tone)

  return (
    <div className={`rounded-xl border px-4 py-3 text-13px leading-relaxed ${palette.shell}`}>
      {title ? (
        <div className="flex items-center gap-2 font-600">
          <span>{title}</span>
          {animateDetail ? <RetryStatusDots /> : null}
        </div>
      ) : null}
      {detail ? (
        <div className={`${title ? 'mt-1 ' : ''}flex items-start gap-2 text-12px ${palette.detail}`}>
          {animateDetail && !title ? <RetryStatusDots /> : null}
          <span className="whitespace-pre-wrap">{detail}</span>
        </div>
      ) : null}
    </div>
  )
}

function routeAnswerModeLabel(answerMode?: RouteDecisionSnapshot['answerMode']) {
  switch (answerMode) {
    case 'advise':
      return '建议'
    case 'diagnose':
      return '诊断'
    case 'execute':
      return '执行'
    default:
      return ''
  }
}

function routeCapabilityTierLabel(capabilityTier?: RouteDecisionSnapshot['capabilityTier']) {
  switch (capabilityTier) {
    case 'none':
      return '无工具'
    case 'local-readonly':
      return '本地只读'
    case 'local-write':
      return '本地可写'
    case 'web-lookup':
      return '联网查询'
    case 'browser-interactive':
      return '浏览器交互'
    default:
      return ''
  }
}

function buildRouteSummary(routeDecision?: RouteDecisionSnapshot) {
  if (!routeDecision) {
    return null
  }

  const summary = [
    routeAnswerModeLabel(routeDecision.answerMode),
    routeCapabilityTierLabel(routeDecision.capabilityTier),
    typeof routeDecision.escalationCount === 'number' && routeDecision.escalationCount > 0
      ? `升级 ${routeDecision.escalationCount} 次`
      : null,
  ]
    .filter(Boolean)
    .join(' · ')

  return summary || null
}

function buildRouteTooltip(routeDecision?: RouteDecisionSnapshot) {
  if (!routeDecision) {
    return ''
  }

  const stopReasonLabel =
    routeDecision.stopReason === 'completed'
      ? '已形成可交付回答'
      : routeDecision.stopReason === 'completed_with_evidence'
        ? '已完成执行并拿到证据'
        : routeDecision.stopReason === 'no_incremental_progress'
          ? '升级后无新增信息，已收束'
          : routeDecision.stopReason === 'budget_exhausted'
            ? '当前路径已收束，基于现有证据回答'
            : routeDecision.stopReason === 'runtime_pass_limit'
              ? '达到路由运行上限'
              : null

  return [
    `回答模式：${routeAnswerModeLabel(routeDecision.answerMode) || routeDecision.answerMode}`,
    `当前层级：${routeCapabilityTierLabel(routeDecision.capabilityTier) || routeDecision.capabilityTier}`,
    routeDecision.tierHistory && routeDecision.tierHistory.length > 0
      ? `层级路径：${routeDecision.tierHistory
        .map(tier => routeCapabilityTierLabel(tier) || tier)
        .join(' -> ')}`
      : null,
    routeDecision.budgets
      ? `预算：搜索 ${routeDecision.budgets.searchesRemaining}，写升级 ${routeDecision.budgets.writeEscalationsRemaining}，浏览器升级 ${routeDecision.budgets.browserEscalationsRemaining}`
      : null,
    routeDecision.availableEscalations && routeDecision.availableEscalations.length > 0
      ? `仍可升级到：${routeDecision.availableEscalations.join(' / ')}`
      : null,
    stopReasonLabel ? `停止原因：${stopReasonLabel}` : null,
  ]
    .filter(Boolean)
    .join('\n')
}

function completionStateLabel(completionState?: CompletionState) {
  switch (completionState) {
    case 'not_executed':
      return '未执行'
    case 'executed_unverified':
      return '已执行未验证'
    case 'executed_verified':
      return '已验证完成'
    case 'blocked_by_approval':
      return '等待审批'
    case 'blocked_by_capability':
      return '能力受限'
    case 'failed_after_execution':
      return '执行失败'
    default:
      return ''
  }
}

function completionStateTone(completionState?: CompletionState) {
  switch (completionState) {
    case 'executed_verified':
      return 'border-emerald-200 bg-emerald-50 text-emerald-700'
    case 'executed_unverified':
      return 'border-amber-200 bg-amber-50 text-amber-700'
    case 'blocked_by_approval':
    case 'blocked_by_capability':
      return 'border-orange-200 bg-orange-50 text-orange-700'
    case 'failed_after_execution':
      return 'border-red-200 bg-red-50 text-red-700'
    case 'not_executed':
    default:
      return 'border-[rgba(15,23,42,0.08)] bg-[rgba(15,23,42,0.03)] text-[var(--text-secondary)]'
  }
}

function eventKindLabel(event: MessageEvent) {
  switch (event.kind) {
    case 'shell':
      return '命令'
    case 'skill':
      return '技能'
    case 'progress':
      return '进展'
    case 'approval':
      return '审批'
    case 'user_input':
      return '确认'
    case 'subagent':
      return '子 Agent'
    default:
      return '工具'
  }
}

function eventStatusLabel(status: MessageEvent['status']) {
  switch (status) {
    case 'running':
      return '执行中'
    case 'awaiting_approval':
      return '待审批'
    case 'awaiting_user_input':
      return '待回复'
    case 'error':
      return '失败'
    default:
      return '成功'
  }
}

function eventStatusPillClassName(status: MessageEvent['status']) {
  switch (status) {
    case 'running':
      return 'border-[rgba(79,123,116,0.18)] bg-[rgba(79,123,116,0.07)] text-[var(--accent-soft-strong)]'
    case 'awaiting_approval':
    case 'awaiting_user_input':
      return 'border-amber-200 bg-amber-50 text-amber-700'
    case 'error':
      return 'border-red-200 bg-red-50 text-red-600'
    default:
      return 'border-emerald-100 bg-emerald-50 text-emerald-700'
  }
}

function eventKindPillClassName(event: MessageEvent) {
  if (event.status === 'error') {
    return 'bg-red-50 text-red-500'
  }
  if (event.status === 'awaiting_approval' || event.status === 'awaiting_user_input') {
    return 'bg-amber-50 text-amber-700'
  }
  if (event.kind === 'progress') {
    return 'bg-[rgba(79,123,116,0.08)] text-[var(--accent-soft-strong)]'
  }
  return 'bg-[rgba(15,23,42,0.04)] text-[var(--text-secondary)]'
}

function eventSourceLabel(source?: MessageEvent['source']) {
  switch (source) {
    case 'plugin':
      return 'Plugin'
    case 'mcp':
      return 'MCP'
    case 'subagent':
      return '子 Agent'
    case 'builtin':
      return '内置'
    default:
      return ''
  }
}

function isGenericToolSummary(event: MessageEvent) {
  const summary = normalizeComparableText(event.summary)
  if (!summary) {
    return false
  }
  return (
    /^read the full content of an installed aura skill by id/i.test(summary) ||
    /^run a shell command/i.test(summary) ||
    /^execute a shell command/i.test(summary) ||
    /^execute command/i.test(summary) ||
    /^apply a patch/i.test(summary) ||
    /^write a file/i.test(summary) ||
    /^read a file/i.test(summary)
  )
}

function appendedInputStatusLabel(status: AppendedInput['status']) {
  return status === 'consumed' ? '已完成中途判断' : '将在当前步骤后判断处理'
}

function isSearchControllerDecisionEvent(event: MessageEvent) {
  if (event.toolName !== 'web_search' || !event.output) {
    return false
  }

  const parsedOutput = readEventStructuredOutput(event)
  return Boolean(parsedOutput && isSearchControllerDecisionOutput(parsedOutput))
}

function prettifyIdentifier(identifier: string) {
  return identifier
    .split(/[_-]+/)
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

function presentToolEventTitle(event: Pick<ToolEvent, 'name' | 'source'>) {
  const rawName = event.name?.trim()
  if (!rawName) {
    return event.source === 'plugin' ? '插件' : '工具'
  }
  if (event.source === 'plugin') {
    const tail = rawName.split('__').filter(Boolean).at(-1) || rawName
    return prettifyIdentifier(tail)
  }
  if (event.source === 'subagent') {
    return rawName
  }
  if (rawName.toLowerCase().includes('shell')) {
    return 'Shell 命令'
  }
  return prettifyIdentifier(rawName)
}

function isGenericTaskSummary(summary?: string) {
  const normalized = summary?.trim().toLowerCase() || ''
  return (
    !normalized ||
    normalized === 'primary agent task' ||
    normalized === '生成最终回答' ||
    normalized === 'generate final answer'
  )
}

function normalizeComparableText(value?: string) {
  return (value || '').replace(/\s+/g, ' ').trim()
}

type RevealSegment = {
  id: string
  text: string
  animate: boolean
}

const MIN_PROVIDER_REASONING_CHARS = 8
const MIN_PROVIDER_REASONING_WITH_OUTPUT_CHARS = 4
const MAX_STREAM_REVEAL_SEGMENTS = 72

function splitRevealDelta(delta: string) {
  const segments: string[] = []
  let buffer = ''

  const pushBuffer = () => {
    if (!buffer) {
      return
    }
    segments.push(buffer)
    buffer = ''
  }

  for (let index = 0; index < delta.length; index += 1) {
    const char = delta[index]
    const next = delta[index + 1] || ''
    buffer += char

    const reachedLineBreak = char === '\n'
    const reachedSentenceEnd =
      /[。！？!?；;：:]/u.test(char) && (!next || /\s|\n/u.test(next))
    const reachedSoftChunkBoundary = buffer.length >= 32 && /\s/u.test(char)

    if (reachedLineBreak || reachedSentenceEnd || reachedSoftChunkBoundary) {
      pushBuffer()
    }
  }

  pushBuffer()
  return segments.length > 0 ? segments : [delta]
}

function compactRevealSegments(segments: RevealSegment[], maxSegments = MAX_STREAM_REVEAL_SEGMENTS) {
  if (segments.length <= maxSegments) {
    return segments
  }

  const overflow = segments.length - maxSegments + 1
  const mergedText = segments
    .slice(0, overflow)
    .map(segment => segment.text)
    .join('')

  return [
    {
      id: segments[overflow - 1]?.id || segments[0]?.id || 'reveal-merged',
      text: mergedText,
      animate: false,
    },
    ...segments.slice(overflow),
  ]
}

function useIncrementalRevealSegments(text: string, resetKey = '') {
  const previousRef = useRef({ text, resetKey })
  const sequenceRef = useRef(text ? 1 : 0)
  const [segments, setSegments] = useState<RevealSegment[]>(() =>
    text
      ? [
        {
          id: 'reveal-1',
          text,
          animate: false,
        },
      ]
      : [],
  )

  useEffect(() => {
    const previous = previousRef.current
    if (text === previous.text && resetKey === previous.resetKey) {
      return
    }

    const nextId = () => {
      sequenceRef.current += 1
      return `reveal-${sequenceRef.current}`
    }

    if (!text) {
      setSegments([])
    } else if (resetKey !== previous.resetKey || !text.startsWith(previous.text)) {
      setSegments([
        {
          id: nextId(),
          text,
          animate: false,
        },
      ])
    } else {
      const delta = text.slice(previous.text.length)
      if (delta) {
        const deltaSegments = splitRevealDelta(delta).map(segment => ({
          id: nextId(),
          text: segment,
          animate: true,
        }))
        setSegments(current => compactRevealSegments([...current, ...deltaSegments]))
      }
    }

    previousRef.current = { text, resetKey }
  }, [resetKey, text])

  return segments
}

function RevealTextSegments({
  text,
  resetKey = '',
  className,
  inline = false,
}: {
  text: string
  resetKey?: string
  className?: string
  inline?: boolean
}) {
  const segments = useIncrementalRevealSegments(text, resetKey)
  if (segments.length === 0) {
    return null
  }

  const content = segments.map(segment => (
    <span
      key={segment.id}
      className={segment.animate ? 'stream-reveal-segment' : undefined}
    >
      {segment.text}
    </span>
  ))

  if (inline) {
    return <span className={className}>{content}</span>
  }

  return <div className={className}>{content}</div>
}

function shouldDisplayReasoningEntry(
  entry: MessageReasoning,
  options: {
    isStreaming: boolean
    hasLinkedOutput: boolean
  },
) {
  const normalized = normalizeComparableText(entry.content)
  if (!normalized) {
    return false
  }

  if (entry.kind === 'summary') {
    return normalized.length >= 4
  }

  if (options.hasLinkedOutput && normalized.length >= MIN_PROVIDER_REASONING_WITH_OUTPUT_CHARS) {
    return true
  }

  if (normalized.length >= MIN_PROVIDER_REASONING_CHARS) {
    return true
  }

  return !options.isStreaming && normalized.length >= MIN_PROVIDER_REASONING_WITH_OUTPUT_CHARS
}

function sanitizeTaskNodes(nodes: TaskNode[], finalAnswer = ''): TaskNode[] {
  const normalizedAnswer = normalizeComparableText(finalAnswer)
  return nodes.flatMap(node => {
    const children = sanitizeTaskNodes(node.children || [], finalAnswer)
    const normalizedSummary = normalizeComparableText(node.summary)
    const summary =
      isGenericTaskSummary(node.summary) ||
        (normalizedAnswer && normalizedSummary === normalizedAnswer)
        ? ''
        : node.summary

    if (node.kind === 'main' && !summary && children.length > 0) {
      return children
    }

    if (node.kind === 'main' && !summary && children.length === 0) {
      return []
    }

    return [{ ...node, summary, children }]
  })
}

const ENHANCED_CODE_LANGUAGES = new Set([
  'csv',
  'flowchart',
  'json',
  'jsonc',
  'json5',
  'mermaid',
  'mmd',
  'sequencediagram',
  'tsv',
])

let mermaidInitialized = false

function normalizeCodeLanguage(value = '') {
  const language = String(value || '')
    .replace(/^language-/u, '')
    .trim()
    .split(/\s+/u)[0]
    .toLowerCase()

  if (
    language === 'mmd' ||
    language === 'flowchart' ||
    language === 'sequencediagram'
  ) {
    return 'mermaid'
  }
  if (language === 'json5') {
    return 'jsonc'
  }
  return language || 'code'
}

function getFenceStart(line: string) {
  const match = line.match(/^ {0,3}(`{3,}|~{3,})\s*([^`]*)$/u)
  if (!match) {
    return null
  }
  const marker = match[1]
  return {
    char: marker[0],
    length: marker.length,
    language: normalizeCodeLanguage(match[2] || ''),
  }
}

function isFenceClose(line: string, fence: { char: string; length: number }) {
  const escaped = fence.char === '`' ? '`' : '~'
  const expression = new RegExp(`^ {0,3}${escaped}{${fence.length},}\\s*$`, 'u')
  return expression.test(line)
}

function isCodeFenceClosed(markdown: string, language: string, raw: string) {
  const normalizedLanguage = normalizeCodeLanguage(language)
  const normalizedRaw = raw.trimEnd()
  const lines = markdown.split(/\r?\n/u)
  let activeFence: { char: string; length: number; language: string } | null = null
  let activeLines: string[] = []

  for (const line of lines) {
    if (!activeFence) {
      const fence = getFenceStart(line)
      if (fence) {
        activeFence = fence
        activeLines = []
      }
      continue
    }

    if (isFenceClose(line, activeFence)) {
      const blockContent = activeLines.join('\n').trimEnd()
      if (activeFence.language === normalizedLanguage && blockContent === normalizedRaw) {
        return true
      }
      activeFence = null
      activeLines = []
      continue
    }

    activeLines.push(line)
  }

  if (
    activeFence?.language === normalizedLanguage &&
    activeLines.join('\n').trimEnd() === normalizedRaw
  ) {
    return false
  }

  return true
}

function hashText(value: string) {
  let hash = 0
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) - hash + value.charCodeAt(index)) | 0
  }
  return Math.abs(hash).toString(36)
}

function sanitizeDownloadBasename(value: string, fallback: string) {
  const cleaned = value
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 72)
  return cleaned || fallback
}

function timestampedFilename(base: string, extension: string) {
  return `${sanitizeDownloadBasename(base, 'download')}-${Date.now()}.${extension}`
}

function codeFileExtension(language: string) {
  const normalized = normalizeCodeLanguage(language)
  const extensionByLanguage: Record<string, string> = {
    bash: 'sh',
    c: 'c',
    cpp: 'cpp',
    csharp: 'cs',
    css: 'css',
    diff: 'diff',
    dockerfile: 'Dockerfile',
    go: 'go',
    html: 'html',
    java: 'java',
    javascript: 'js',
    js: 'js',
    json: 'json',
    jsonc: 'jsonc',
    jsx: 'jsx',
    kotlin: 'kt',
    markdown: 'md',
    md: 'md',
    php: 'php',
    powershell: 'ps1',
    py: 'py',
    python: 'py',
    rb: 'rb',
    ruby: 'rb',
    rust: 'rs',
    sh: 'sh',
    shell: 'sh',
    sql: 'sql',
    swift: 'swift',
    toml: 'toml',
    ts: 'ts',
    tsx: 'tsx',
    typescript: 'ts',
    xml: 'xml',
    yaml: 'yaml',
    yml: 'yml',
  }
  return extensionByLanguage[normalized] || 'txt'
}

function mimeTypeForExtension(extension: string) {
  const normalized = extension.toLowerCase()
  if (normalized === 'html') {
    return 'text/html;charset=utf-8'
  }
  if (normalized === 'json' || normalized === 'jsonc') {
    return 'application/json;charset=utf-8'
  }
  if (normalized === 'svg') {
    return 'image/svg+xml;charset=utf-8'
  }
  if (normalized === 'csv') {
    return 'text/csv;charset=utf-8'
  }
  if (normalized === 'tsv') {
    return 'text/tab-separated-values;charset=utf-8'
  }
  return 'text/plain;charset=utf-8'
}

function MarkdownCodeBlock({
  language,
  source,
  onCopyText,
  pendingLabel,
}: {
  language: string
  source: string
  onCopyText: CopyTextHandler
  pendingLabel?: string
}) {
  return (
    <div className="markdown-codeblock">
      <div className="markdown-codeblock-head">
        <span>{pendingLabel || language}</span>
        <div className="markdown-data-actions">
          <button className="p-1 rounded hover:bg-[rgba(0,0,0,0.05)] text-[var(--text-secondary)]" title="复制代码" aria-label="复制代码" onClick={() => onCopyText(source)}>
            <Copy size={12} />
          </button>
          <button
            className="p-1 rounded hover:bg-[rgba(0,0,0,0.05)] text-[var(--text-secondary)]"
            title="下载代码"
            aria-label="下载代码"
            onClick={() => {
              const extension = codeFileExtension(language)
              downloadTextFile(
                timestampedFilename(`code-${language || 'block'}`, extension),
                source,
                mimeTypeForExtension(extension),
              )
            }}
          >
            <Download size={12} />
          </button>
        </div>
      </div>
      <pre>
        <code>{source}</code>
      </pre>
    </div>
  )
}

function parseDelimitedRows(source: string, delimiter: ',' | '\t') {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]
    const next = source[index + 1]

    if (char === '"') {
      if (quoted && next === '"') {
        cell += '"'
        index += 1
      } else {
        quoted = !quoted
      }
      continue
    }

    if (!quoted && char === delimiter) {
      row.push(cell)
      cell = ''
      continue
    }

    if (!quoted && (char === '\n' || char === '\r')) {
      if (char === '\r' && next === '\n') {
        index += 1
      }
      row.push(cell)
      rows.push(row)
      row = []
      cell = ''
      continue
    }

    cell += char
  }

  if (cell || row.length > 0) {
    row.push(cell)
    rows.push(row)
  }

  return rows.filter(cells => cells.some(cellValue => cellValue.trim()))
}

function escapeDelimitedCell(value: string, delimiter: ',' | '\t') {
  const text = String(value ?? '')
  const needsQuotes =
    delimiter === ','
      ? /[",\r\n]/u.test(text)
      : /["\t\r\n]/u.test(text)

  if (!needsQuotes) {
    return text
  }

  return `"${text.replace(/"/gu, '""')}"`
}

function rowsToDelimited(rows: string[][], delimiter: ',' | '\t') {
  return rows
    .map(row => row.map(cell => escapeDelimitedCell(cell, delimiter)).join(delimiter))
    .join('\n')
}

function escapeHtml(value: string) {
  return String(value ?? '')
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;')
    .replace(/'/gu, '&#39;')
}

function rowsToHtmlTable(rows: string[][]) {
  const [header = [], ...bodyRows] = rows
  const columnCount = Math.max(...rows.map(row => row.length), 0)
  const tableStyle = 'border-collapse:collapse;border:1px solid #d0d7de;'
  const headerStyle = 'border:1px solid #d0d7de;padding:4px 8px;background:#f6f8fa;font-weight:600;text-align:left;'
  const cellStyle = 'border:1px solid #d0d7de;padding:4px 8px;text-align:left;'
  const renderCells = (row: string[], tagName: 'td' | 'th', style: string) =>
    Array.from({ length: columnCount }, (_, index) =>
      `<${tagName} style="${style}">${escapeHtml(row[index] || '')}</${tagName}>`,
    ).join('')

  return [
    `<table style="${tableStyle}">`,
    '<thead>',
    `<tr>${renderCells(header, 'th', headerStyle)}</tr>`,
    '</thead>',
    '<tbody>',
    ...bodyRows.map(row => `<tr>${renderCells(row, 'td', cellStyle)}</tr>`),
    '</tbody>',
    '</table>',
  ].join('')
}

function copyTableRows(
  rows: string[][],
  onCopyText: (value: string, html?: string) => void,
) {
  if (rows.length > 0) {
    onCopyText(rowsToDelimited(rows, '\t'), rowsToHtmlTable(rows))
  }
}

function unwrapElement(element: Element) {
  const parent = element.parentNode
  if (!parent) {
    return
  }
  while (element.firstChild) {
    parent.insertBefore(element.firstChild, element)
  }
  parent.removeChild(element)
}

function styleClipboardMarkdownHtml(root: HTMLElement) {
  root.querySelectorAll('table').forEach(table => {
    table.setAttribute('style', 'border-collapse:collapse;border:1px solid #d0d7de;margin:12px 0;width:100%;')
  })
  root.querySelectorAll('th').forEach(cell => {
    cell.setAttribute('style', 'border:1px solid #d0d7de;padding:4px 8px;background:#f6f8fa;font-weight:600;text-align:left;')
  })
  root.querySelectorAll('td').forEach(cell => {
    cell.setAttribute('style', 'border:1px solid #d0d7de;padding:4px 8px;text-align:left;')
  })
  root.querySelectorAll('pre').forEach(pre => {
    pre.setAttribute('style', 'background:#f6f8fa;border:1px solid #d0d7de;padding:12px;white-space:pre-wrap;')
  })
  root.querySelectorAll('blockquote').forEach(blockquote => {
    blockquote.setAttribute('style', 'border-left:3px solid #d0d7de;margin:12px 0;padding-left:12px;color:#57606a;')
  })
}

function buildMarkdownHtmlFromRenderedBody(body: HTMLElement | null) {
  if (!body) {
    return ''
  }

  const clone = body.cloneNode(true) as HTMLElement
  clone
    .querySelectorAll('.markdown-data-head,.markdown-codeblock-head,.assistant-streaming-markdown__veil,button')
    .forEach(node => node.remove())
  clone
    .querySelectorAll('.markdown-data-block,.markdown-table-wrap')
    .forEach(node => unwrapElement(node))
  clone.querySelectorAll('svg').forEach(svg => {
    if (!svg.getAttribute('xmlns')) {
      svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
    }
  })
  styleClipboardMarkdownHtml(clone)
  return `<!doctype html><html><body>${clone.innerHTML}</body></html>`
}

function copyMarkdownAnswer(
  content: string,
  body: HTMLElement | null,
  onCopyText: CopyTextHandler,
) {
  const html = buildMarkdownHtmlFromRenderedBody(body)
  onCopyText(content, html || undefined)
}

function downloadMarkdownAnswerHtml(content: string, body: HTMLElement | null, filenameBase: string) {
  const html =
    buildMarkdownHtmlFromRenderedBody(body) ||
    `<!doctype html><html><body><pre>${escapeHtml(content)}</pre></body></html>`
  downloadTextFile(
    timestampedFilename(filenameBase, 'html'),
    html,
    'text/html;charset=utf-8',
  )
}

function downloadTextFile(filename: string, content: string, mimeType: string) {
  const blob = new Blob([content], { type: mimeType })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 0)
}

function readRenderedTableRows(table: HTMLTableElement | null) {
  if (!table) {
    return []
  }

  return Array.from(table.rows)
    .map(row =>
      Array.from(row.cells).map(cell =>
        cell.innerText.replace(/\s+/gu, ' ').trim(),
      ),
    )
    .filter(row => row.some(Boolean))
}

function DelimitedTableBlock({
  language,
  source,
  onCopyText,
}: {
  language: string
  source: string
  onCopyText: CopyTextHandler
}) {
  const delimiter = language === 'tsv' ? '\t' : ','
  const rows = useMemo(() => parseDelimitedRows(source, delimiter), [delimiter, source])
  if (rows.length === 0) {
    return <MarkdownCodeBlock language={language} source={source} onCopyText={onCopyText} />
  }

  const [header, ...bodyRows] = rows
  const columnCount = Math.max(...rows.map(row => row.length))
  const extension = language === 'tsv' ? 'tsv' : 'csv'
  const normalizedSource = rowsToDelimited(rows, delimiter)
  const mimeType =
    language === 'tsv'
      ? 'text/tab-separated-values;charset=utf-8'
      : 'text/csv;charset=utf-8'

  return (
    <div className="markdown-data-block">
      <div className="markdown-data-head">
        <span>{language.toUpperCase()} 表格</span>
        <div className="markdown-data-actions">
          <button
            className="p-1 rounded hover:bg-[rgba(0,0,0,0.05)] text-[var(--text-secondary)]"
            title="复制表格"
            aria-label="复制表格"
            onClick={() => copyTableRows(rows, onCopyText)}
          >
            <Copy size={12} />
          </button>
          <button
            className="p-1 rounded hover:bg-[rgba(0,0,0,0.05)] text-[var(--text-secondary)]"
            title={`下载 ${extension.toUpperCase()}`}
            aria-label={`下载 ${extension.toUpperCase()}`}
            onClick={() => downloadTextFile(`table-${Date.now()}.${extension}`, normalizedSource, mimeType)}
          >
            <Download size={12} />
          </button>
        </div>
      </div>
      <div className="markdown-table-wrap">
        <table>
          <thead>
            <tr>
              {Array.from({ length: columnCount }, (_, index) => (
                <th key={index}>{header[index] || `Column ${index + 1}`}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {bodyRows.map((row, rowIndex) => (
              <tr key={rowIndex}>
                {Array.from({ length: columnCount }, (_, columnIndex) => (
                  <td key={columnIndex}>{row[columnIndex] || ''}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function MarkdownTableBlock({
  children,
  onCopyText,
}: {
  children: ReactNode
  onCopyText: CopyTextHandler
}) {
  const tableRef = useRef<HTMLTableElement>(null)

  function getRows() {
    return readRenderedTableRows(tableRef.current)
  }

  function handleCopy() {
    const rows = getRows()
    copyTableRows(rows, onCopyText)
  }

  function handleDownload() {
    const rows = getRows()
    if (rows.length > 0) {
      downloadTextFile(
        `markdown-table-${Date.now()}.csv`,
        rowsToDelimited(rows, ','),
        'text/csv;charset=utf-8',
      )
    }
  }

  return (
    <div className="markdown-data-block markdown-table-block">
      <div className="markdown-data-head">
        <span>Markdown 表格</span>
        <div className="markdown-data-actions">
          <button
            className="p-1 rounded hover:bg-[rgba(0,0,0,0.05)] text-[var(--text-secondary)]"
            title="复制表格"
            aria-label="复制表格"
            onClick={handleCopy}
          >
            <Copy size={12} />
          </button>
          <button
            className="p-1 rounded hover:bg-[rgba(0,0,0,0.05)] text-[var(--text-secondary)]"
            title="下载 CSV"
            aria-label="下载 CSV"
            onClick={handleDownload}
          >
            <Download size={12} />
          </button>
        </div>
      </div>
      <div className="markdown-table-wrap">
        <table ref={tableRef}>{children}</table>
      </div>
    </div>
  )
}

function renderJsonValue(value: unknown, depth = 0): ReactNode {
  if (value === null) {
    return <span className="json-null">null</span>
  }
  if (typeof value === 'string') {
    return <span className="json-string">"{value}"</span>
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return <span className="json-primitive">{String(value)}</span>
  }
  if (depth >= 5) {
    return <span className="json-muted">...</span>
  }
  if (Array.isArray(value)) {
    return (
      <div className="json-children">
        <span className="json-muted">[</span>
        {value.slice(0, 80).map((entry, index) => (
          <div key={index} className="json-row">
            <span className="json-key">{index}</span>
            {renderJsonValue(entry, depth + 1)}
          </div>
        ))}
        {value.length > 80 ? <div className="json-muted">... {value.length - 80} more</div> : null}
        <span className="json-muted">]</span>
      </div>
    )
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
    return (
      <div className="json-children">
        <span className="json-muted">{'{'}</span>
        {entries.slice(0, 80).map(([key, entry]) => (
          <div key={key} className="json-row">
            <span className="json-key">{key}</span>
            {renderJsonValue(entry, depth + 1)}
          </div>
        ))}
        {entries.length > 80 ? <div className="json-muted">... {entries.length - 80} more</div> : null}
        <span className="json-muted">{'}'}</span>
      </div>
    )
  }
  return <span>{String(value)}</span>
}

function normalizeJsonLikeSource(source: string) {
  return source
    .replace(/\/\*[\s\S]*?\*\//gu, '')
    .split('\n')
    .map(line => line.replace(/(^|[^:])\/\/.*$/u, '$1'))
    .join('\n')
    .replace(/,\s*([}\]])/gu, '$1')
}

function JsonBlock({
  source,
  onCopyText,
}: {
  source: string
  onCopyText: CopyTextHandler
}) {
  const parsed = useMemo(() => {
    try {
      return { ok: true as const, value: JSON.parse(normalizeJsonLikeSource(source)) }
    } catch (error) {
      return {
        ok: false as const,
        message: error instanceof Error ? error.message : 'JSON 解析失败',
      }
    }
  }, [source])
  const jsonSource = parsed.ok ? JSON.stringify(parsed.value, null, 2) : source

  if (!parsed.ok) {
    return (
      <div className="markdown-data-block">
        <div className="markdown-data-head">
          <span>JSON 预览失败</span>
          <div className="markdown-data-actions">
            <button className="p-1 rounded hover:bg-[rgba(0,0,0,0.05)] text-[var(--text-secondary)]" title="复制 JSON" aria-label="复制 JSON" onClick={() => onCopyText(jsonSource)}>
              <Copy size={12} />
            </button>
            <button className="p-1 rounded hover:bg-[rgba(0,0,0,0.05)] text-[var(--text-secondary)]" title="下载 JSON" aria-label="下载 JSON" onClick={() => downloadTextFile(timestampedFilename('json-preview', 'json'), jsonSource, 'application/json;charset=utf-8')}>
              <Download size={12} />
            </button>
          </div>
        </div>
        <div className="markdown-render-error">{parsed.message}</div>
        <MarkdownCodeBlock language="json" source={source} onCopyText={onCopyText} />
      </div>
    )
  }

  return (
    <div className="markdown-data-block">
      <div className="markdown-data-head">
        <span>JSON 预览</span>
        <div className="markdown-data-actions">
          <button className="p-1 rounded hover:bg-[rgba(0,0,0,0.05)] text-[var(--text-secondary)]" title="复制 JSON" aria-label="复制 JSON" onClick={() => onCopyText(jsonSource)}>
            <Copy size={12} />
          </button>
          <button className="p-1 rounded hover:bg-[rgba(0,0,0,0.05)] text-[var(--text-secondary)]" title="下载 JSON" aria-label="下载 JSON" onClick={() => downloadTextFile(timestampedFilename('json-preview', 'json'), jsonSource, 'application/json;charset=utf-8')}>
            <Download size={12} />
          </button>
        </div>
      </div>
      <div className="markdown-json-tree">{renderJsonValue(parsed.value)}</div>
    </div>
  )
}

function MermaidBlock({
  source,
  onCopyText,
}: {
  source: string
  onCopyText: CopyTextHandler
}) {
  const reactId = useId().replace(/:/gu, '')
  const [svg, setSvg] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    async function renderMermaid() {
      const trimmed = source.trim()
      if (!trimmed) {
        setSvg('')
        setError('')
        return
      }

      try {
        const { default: mermaid } = await import('mermaid')
        if (!mermaidInitialized) {
          mermaid.initialize({
            startOnLoad: false,
            securityLevel: 'strict',
            theme: 'base',
            themeVariables: {
              fontFamily: 'Inter, ui-sans-serif, system-ui, sans-serif',
              primaryColor: '#eef7f4',
              primaryBorderColor: '#7fb0a7',
              primaryTextColor: '#10201c',
              lineColor: '#55756e',
              secondaryColor: '#f7f8fa',
              tertiaryColor: '#ffffff',
            },
          })
          mermaidInitialized = true
        }
        const result = await mermaid.render(`mermaid-${reactId}-${hashText(trimmed)}`, trimmed)
        if (!cancelled) {
          setSvg(result.svg)
          setError('')
        }
      } catch (caught) {
        if (!cancelled) {
          setSvg('')
          setError(caught instanceof Error ? caught.message : String(caught))
        }
      }
    }

    void renderMermaid()
    return () => {
      cancelled = true
    }
  }, [reactId, source])

  return (
    <div className="markdown-data-block">
      <div className="markdown-data-head">
        <span>Mermaid 图表</span>
        <div className="markdown-data-actions">
          <button className="p-1 rounded hover:bg-[rgba(0,0,0,0.05)] text-[var(--text-secondary)]" title="复制 Mermaid" aria-label="复制 Mermaid" onClick={() => onCopyText(source)}>
            <Copy size={12} />
          </button>
          <button className="p-1 rounded hover:bg-[rgba(0,0,0,0.05)] text-[var(--text-secondary)]" title="下载 MMD" aria-label="下载 MMD" onClick={() => downloadTextFile(timestampedFilename('mermaid-diagram', 'mmd'), source, 'text/plain;charset=utf-8')}>
            <Download size={12} />
          </button>
          <button
            className="p-1 rounded hover:bg-[rgba(0,0,0,0.05)] text-[var(--text-secondary)] disabled:opacity-40 disabled:cursor-not-allowed"
            title="下载 SVG"
            aria-label="下载 SVG"
            disabled={!svg}
            onClick={() => {
              if (svg) {
                downloadTextFile(timestampedFilename('mermaid-diagram', 'svg'), svg, 'image/svg+xml;charset=utf-8')
              }
            }}
          >
            <Download size={12} />
          </button>
        </div>
      </div>
      {error ? (
        <>
          <div className="markdown-render-error">{error}</div>
          <MarkdownCodeBlock language="mermaid" source={source} onCopyText={onCopyText} />
        </>
      ) : svg ? (
        <div className="markdown-mermaid" dangerouslySetInnerHTML={{ __html: svg }} />
      ) : (
        <div className="markdown-render-pending">正在生成图表...</div>
      )}
    </div>
  )
}

function MathDisplayBlock({
  className,
  children,
  onCopyText,
  ...props
}: HTMLAttributes<HTMLSpanElement> & {
  onCopyText: CopyTextHandler
}) {
  const mathRef = useRef<HTMLSpanElement>(null)
  const getTexSource = () =>
    mathRef.current
      ?.querySelector('annotation[encoding="application/x-tex"]')
      ?.textContent?.trim() || ''

  function handleCopy() {
    const tex = getTexSource()
    if (tex) {
      onCopyText(tex)
    }
  }

  function handleDownload() {
    const tex = getTexSource()
    if (tex) {
      downloadTextFile(timestampedFilename('formula', 'tex'), tex, 'text/plain;charset=utf-8')
    }
  }

  return (
    <span className="markdown-math-block">
      <span ref={mathRef} className={className} {...props}>
        {children}
      </span>
      <span className="markdown-math-actions">
        <button className="p-1 rounded hover:bg-[rgba(0,0,0,0.05)] text-[var(--text-secondary)]" title="复制 TeX" aria-label="复制 TeX" onClick={handleCopy}>
          <Copy size={12} />
        </button>
        <button className="p-1 rounded hover:bg-[rgba(0,0,0,0.05)] text-[var(--text-secondary)]" title="下载 TeX" aria-label="下载 TeX" onClick={handleDownload}>
          <Download size={12} />
        </button>
      </span>
    </span>
  )
}

function EnhancedCodeBlock({
  language,
  source,
  isClosed,
  onCopyText,
}: {
  language: string
  source: string
  isClosed: boolean
  onCopyText: CopyTextHandler
}) {
  if (!isClosed) {
    return (
      <MarkdownCodeBlock
        language={language}
        source={source}
        onCopyText={onCopyText}
        pendingLabel={`${language} 生成中`}
      />
    )
  }

  if (language === 'mermaid') {
    return <MermaidBlock source={source} onCopyText={onCopyText} />
  }
  if (language === 'csv' || language === 'tsv') {
    return <DelimitedTableBlock language={language} source={source} onCopyText={onCopyText} />
  }
  if (language === 'json' || language === 'jsonc') {
    return <JsonBlock source={source} onCopyText={onCopyText} />
  }

  return <MarkdownCodeBlock language={language} source={source} onCopyText={onCopyText} />
}

function MarkdownAnswer({
  content,
  onCopyText,
  bodyRef,
  isStreaming = false,
}: {
  content: string
  onCopyText: CopyTextHandler
  bodyRef?: RefObject<HTMLDivElement>
  isStreaming?: boolean
}) {
  return (
    <div className="markdown-body" ref={bodyRef}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[rehypeKatex]}
        components={{
          a: ({ href, children }) => (
            <a className="text-[var(--bg-user-bubble)] hover:underline" href={href} target="_blank" rel="noreferrer">
              {children}
            </a>
          ),
          table: ({ children }) => (
            <MarkdownTableBlock onCopyText={onCopyText}>{children}</MarkdownTableBlock>
          ),
          span: ({ className, children, node: _node, ...props }) => {
            if (typeof className === 'string' && className.split(/\s+/u).includes('katex-display')) {
              return (
                <MathDisplayBlock className={className} onCopyText={onCopyText} {...props}>
                  {children}
                </MathDisplayBlock>
              )
            }
            return (
              <span className={className} {...props}>
                {children}
              </span>
            )
          },
          code: ({ className, children, ...props }) => {
            const raw = String(children).replace(/\n$/, '')
            const language = normalizeCodeLanguage(className || 'code')
            const isBlock = className?.startsWith('language-') || raw.includes('\n')

            if (!isBlock) {
              return (
                <code className="inline-code" {...props}>
                  {children}
                </code>
              )
            }

            if (ENHANCED_CODE_LANGUAGES.has(language)) {
              return (
                <EnhancedCodeBlock
                  language={language}
                  source={raw}
                  isClosed={!isStreaming || isCodeFenceClosed(content, language, raw)}
                  onCopyText={onCopyText}
                />
              )
            }

            return <MarkdownCodeBlock language={language} source={raw} onCopyText={onCopyText} />
          },
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  )
}

function StreamingMarkdownAnswer({
  content,
  onCopyText,
  bodyRef,
}: {
  content: string
  onCopyText: CopyTextHandler
  bodyRef?: RefObject<HTMLDivElement>
}) {
  const previousContentRef = useRef(content)
  const [tailPulseKey, setTailPulseKey] = useState(0)

  useEffect(() => {
    const previousContent = previousContentRef.current
    if (content && content.length > previousContent.length) {
      setTailPulseKey(current => current + 1)
    }
    previousContentRef.current = content
  }, [content])

  return (
    <div className="assistant-streaming-markdown">
      <MarkdownAnswer content={content} onCopyText={onCopyText} bodyRef={bodyRef} isStreaming />
      {tailPulseKey > 0 ? (
        <div key={tailPulseKey} className="assistant-streaming-markdown__veil" />
      ) : null}
    </div>
  )
}

type ReasoningDisplayModel = {
  label: string
  title: string
  summary: string
}

function inferReasoningTitle(content: string, kind: MessageReasoning['kind']) {
  if (kind === 'summary') {
    if (/任务规划判断|规划判断|执行计划/.test(content)) {
      return '任务规划判断'
    }
    return '执行摘要'
  }

  const normalized = normalizeComparableText(content)
  return normalized ? '模型思路' : '思路'
}

function clampProgressSummary(value: string, maxChars = 140) {
  const normalized = value.replace(/\s+/g, ' ').trim()
  if (!normalized) {
    return ''
  }
  return normalized.length > maxChars
    ? `${normalized.slice(0, maxChars).trimEnd()}...`
    : normalized
}

function buildReasoningDisplayModel(
  content: string,
  kind: MessageReasoning['kind'],
): ReasoningDisplayModel {
  const title = inferReasoningTitle(content, kind)
  const summary =
    content.trim() ||
    (kind === 'summary'
      ? '已记录这一阶段的执行摘要。'
      : '正在整理当前阶段的分析进展。')

  return {
    label: kind === 'summary' ? '摘要' : '思路',
    title,
    summary,
  }
}

type ReasoningTimelineItem = {
  key: string
  kind: 'reasoning'
  order: number
  phaseIndex: number
  originalIndex: number
  entry: MessageReasoning
}

type PhaseOutputTimelineItem = {
  key: string
  kind: 'phase_output'
  order: number
  originalIndex: number
  output: MessagePhaseOutput
}

type EventTimelineItem = {
  key: string
  kind: 'event'
  order: number
  originalIndex: number
  event: MessageEvent
}

type ExecutionTimelineItem =
  | ReasoningTimelineItem
  | PhaseOutputTimelineItem
  | EventTimelineItem

function timelineItemTimestamp(item: ExecutionTimelineItem): number | undefined {
  if (item.kind === 'reasoning') {
    return typeof item.entry.createdAt === 'number' ? item.entry.createdAt : undefined
  }
  if (item.kind === 'event') {
    return typeof item.event.startedAt === 'number'
      ? item.event.startedAt
      : typeof item.event.finishedAt === 'number'
        ? item.event.finishedAt
        : undefined
  }
  return undefined
}

function buildExecutionTimeline(
  reasoningEntries: MessageReasoning[],
  phaseOutputs: MessagePhaseOutput[],
  events: MessageEvent[],
): ExecutionTimelineItem[] {
  const reasoningTimeline = reasoningEntries.map((entry, index) => ({
    key: `reasoning-${entry.id}`,
    kind: 'reasoning' as const,
    order: typeof entry.order === 'number' ? entry.order : index * 2,
    phaseIndex: index + 1,
    originalIndex: index,
    entry,
  }))

  const standalonePhaseOutputs = phaseOutputs.filter(
    output => !reasoningEntries.some(entry => entry.id === output.blockId),
  )

  const phaseOutputTimeline = standalonePhaseOutputs.map((output, index) => ({
    key: `phase-output-${output.id}`,
    kind: 'phase_output' as const,
    order: typeof output.order === 'number' ? output.order : index * 2,
    originalIndex: index,
    output,
  }))

  const eventTimeline = events.map((event, index) => ({
    key: `event-${event.id}`,
    kind: 'event' as const,
    order: typeof event.order === 'number' ? event.order : index * 2 + 1,
    originalIndex: index,
    event,
  }))

  return [...reasoningTimeline, ...phaseOutputTimeline, ...eventTimeline].sort((left, right) => {
    const leftTimestamp = timelineItemTimestamp(left)
    const rightTimestamp = timelineItemTimestamp(right)
    if (
      typeof leftTimestamp === 'number' &&
      typeof rightTimestamp === 'number' &&
      leftTimestamp !== rightTimestamp
    ) {
      return leftTimestamp - rightTimestamp
    }
    if (left.order !== right.order) {
      return left.order - right.order
    }
    if (left.kind !== right.kind) {
      const priority = {
        reasoning: 0,
        phase_output: 1,
        event: 2,
      } as const
      return priority[left.kind] - priority[right.kind]
    }
    return left.originalIndex - right.originalIndex
  })
}

type ExecutionTraceNarrative = {
  key: string
  sourceId: string
  label: string
  title: string
  summary: string
  rawContent: string
  sourceKind: MessageReasoning['kind'] | 'phase_output'
  order: number
}
type ExecutionTraceGroup = {
  key: string
  narratives: ExecutionTraceNarrative[]
  items: ExecutionTimelineItem[]
}
type ExecutionDigestPreview = {
  label: string
  text: string
  tone?: 'default' | 'error'
}

const EXECUTION_DIGEST_ENTRY_LIMIT = 80
const EXECUTION_DIGEST_AUTO_SCROLL_THRESHOLD_PX = 24

function isSyntheticRunSummary(value: string) {
  const normalized = normalizeComparableText(value)
  return (
    /^围绕“.*”组织本轮处理。/.test(normalized) &&
    /最后将结果整理成对用户可直接阅读的回复。/.test(normalized)
  )
}

function normalizeTraceComparable(value: string) {
  return normalizeComparableText(value)
    .replace(/执行了\s*\d+\s*个工具步骤/g, '执行了 # 个工具步骤')
    .replace(/本轮同时参考了\s*\d+\s*个文件/g, '本轮同时参考了 # 个文件')
    .replace(/\d+(?:\.\d+)?\s*(?:ms|秒|s)\b/gi, '# time')
}

function isSameExecutionDigestPreview(
  left: ExecutionDigestPreview | null,
  right: ExecutionDigestPreview | null,
) {
  return (
    left?.label === right?.label &&
    left?.text === right?.text &&
    (left?.tone || 'default') === (right?.tone || 'default')
  )
}

function isExecutionDigestPreviewRefinement(
  left: ExecutionDigestPreview | null,
  right: ExecutionDigestPreview | null,
) {
  if (!left || !right) {
    return false
  }
  if (left.label !== right.label || (left.tone || 'default') !== (right.tone || 'default')) {
    return false
  }

  const previousText = normalizeComparableText(left.text)
  const nextText = normalizeComparableText(right.text)
  if (!previousText || !nextText || nextText.length <= previousText.length) {
    return false
  }

  return nextText.startsWith(previousText) || (previousText.length >= 18 && nextText.includes(previousText))
}

function appendExecutionDigestPreview(
  entries: ExecutionDigestPreview[],
  nextPreview: ExecutionDigestPreview | null,
) {
  if (!nextPreview) {
    return
  }

  const lastEntry = entries.at(-1)
  if (lastEntry && isSameExecutionDigestPreview(lastEntry, nextPreview)) {
    return
  }
  if (lastEntry && isExecutionDigestPreviewRefinement(lastEntry, nextPreview)) {
    entries[entries.length - 1] = nextPreview
    return
  }

  entries.push(nextPreview)
  if (entries.length > EXECUTION_DIGEST_ENTRY_LIMIT) {
    entries.splice(0, entries.length - EXECUTION_DIGEST_ENTRY_LIMIT)
  }
}

function isExecutionDigestNearBottom(viewport: HTMLElement) {
  return (
    viewport.scrollHeight - (viewport.scrollTop + viewport.clientHeight) <
    EXECUTION_DIGEST_AUTO_SCROLL_THRESHOLD_PX
  )
}

function phaseOutputLabel(output: MessagePhaseOutput) {
  return output.blockId.startsWith('appended-input:') ? '补充输入' : '阶段输出'
}

function isExecutionEventItem(
  item: ExecutionTimelineItem,
): item is Extract<ExecutionTimelineItem, { kind: 'event' }> {
  return item.kind === 'event'
}

function isAwaitingUserResponseEvent(event: MessageEvent) {
  return (
    (event.kind === 'approval' && event.status === 'awaiting_approval') ||
    (event.kind === 'user_input' && event.status === 'awaiting_user_input')
  )
}

function stripMarkdownForPreview(value: string) {
  return value
    .replace(/```[\s\S]*?```/g, '\n[代码段]\n')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/^(#{1,6}\s*)/gm, '')
    .replace(/(\*\*|__|\*|_|~~)/g, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*\d+\.\s+/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function extractTailPreview(value: string, maxLines = 3, maxChars = 180) {
  const normalized = stripMarkdownForPreview(value)
  if (!normalized) {
    return ''
  }

  const lines = normalized
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)

  if (lines.length === 0) {
    return ''
  }

  const tailLines = lines.slice(-maxLines)
  const joined = tailLines.join('\n')
  if (joined.length > maxChars) {
    return joined.slice(-maxChars).trimStart()
  }

  return joined
}

function findLatestTaskSummary(nodes: TaskNode[]) {
  let latestSummary = ''

  function visit(node: TaskNode) {
    if (normalizeComparableText(node.summary)) {
      latestSummary = node.summary
    }
    node.children.forEach(visit)
  }

  nodes.forEach(visit)
  return latestSummary
}

function buildExecutionDigestPreviewForTimelineItem(
  item: ExecutionTimelineItem,
): ExecutionDigestPreview | null {
  if (item.kind === 'event') {
    const event = item.event
    if (
      isAwaitingUserResponseEvent(event) ||
      isSearchControllerDecisionEvent(event) ||
      event.status === 'error'
    ) {
      return null
    }

    const rawText =
      event.kind === 'shell'
        ? event.input || event.summary || sanitizeTerminalOutput(event.output) || event.title
        : event.summary || event.output || event.input || event.title
    const text = extractTailPreview(rawText)

    if (!text) {
      return null
    }

    return {
      label: event.title || '最新进展',
      text,
    } satisfies ExecutionDigestPreview
  }

  if (item.kind === 'phase_output') {
    const text = extractTailPreview(item.output.content)
    if (!text) {
      return null
    }

    return {
      label: phaseOutputLabel(item.output),
      text,
    } satisfies ExecutionDigestPreview
  }

  if (item.kind === 'reasoning') {
    if (isSyntheticRunSummary(item.entry.content)) {
      return null
    }
    const display = buildReasoningDisplayModel(item.entry.content, item.entry.kind)
    const text = extractTailPreview(display.summary)
    if (!text) {
      return null
    }

    return {
      label: display.title,
      text,
    } satisfies ExecutionDigestPreview
  }

  return null
}

function buildExecutionDigestEntries(options: {
  executionTimeline: ExecutionTimelineItem[]
  taskNodes: TaskNode[]
}) {
  const { executionTimeline, taskNodes } = options
  const entries: ExecutionDigestPreview[] = []

  for (const item of executionTimeline) {
    appendExecutionDigestPreview(entries, buildExecutionDigestPreviewForTimelineItem(item))
  }

  if (entries.length > 0) {
    return entries
  }

  const taskSummary = extractTailPreview(findLatestTaskSummary(taskNodes))
  if (taskSummary) {
    return [{
      label: '执行计划',
      text: taskSummary,
    } satisfies ExecutionDigestPreview]
  }

  return []
}

function buildExecutionTraceNarrative(
  item: Extract<ExecutionTimelineItem, { kind: 'reasoning' | 'phase_output' }>,
): ExecutionTraceNarrative | null {
  if (item.kind === 'reasoning') {
    if (isSyntheticRunSummary(item.entry.content)) {
      return null
    }
    const display = buildReasoningDisplayModel(item.entry.content, item.entry.kind)
    if (!normalizeComparableText(display.summary)) {
      return null
    }
    return {
      key: item.key,
      sourceId: item.entry.id,
      label: display.label,
      title: display.title,
      summary: display.summary,
      rawContent: item.entry.content.trim(),
      sourceKind: item.entry.kind,
      order: item.order,
    }
  }

  const content = item.output.content.trim()
  if (!content) {
    return null
  }
  return {
    key: item.key,
    sourceId: item.output.id,
    label: '输出',
    title: phaseOutputLabel(item.output),
    summary: clampProgressSummary(stripMarkdownForPreview(content), 180),
    rawContent: content,
    sourceKind: 'phase_output',
    order: item.order,
  }
}

function buildExecutionTraceGroups(timeline: ExecutionTimelineItem[]) {
  const groups: ExecutionTraceGroup[] = []
  const seenNarratives = new Set<string>()
  let currentGroup: ExecutionTraceGroup | null = null

  function ensureFallbackGroup(item: ExecutionTimelineItem) {
    if (!currentGroup) {
      currentGroup = {
        key: `trace-group-${item.key}`,
        narratives: [],
        items: [],
      }
      groups.push(currentGroup)
    }
    return currentGroup
  }

  for (const item of timeline) {
    if (item.kind === 'reasoning' || item.kind === 'phase_output') {
      const narrative = buildExecutionTraceNarrative(item)
      if (!narrative) {
        continue
      }
      const comparable = normalizeTraceComparable(`${narrative.title} ${narrative.summary}`)
      if (seenNarratives.has(comparable)) {
        continue
      }
      seenNarratives.add(comparable)

      currentGroup = {
        key: `trace-group-${narrative.key}`,
        narratives: [narrative],
        items: [],
      }
      groups.push(currentGroup)
      continue
    }

    ensureFallbackGroup(item).items.push(item)
  }

  return groups.filter(group => group.narratives.length > 0 || group.items.length > 0)
}

function findCurrentExecutionTraceGroupIndex(
  groups: ExecutionTraceGroup[],
  latestReasoningId: string,
) {
  for (let index = groups.length - 1; index >= 0; index -= 1) {
    if (
      groups[index].items.some(
        item =>
          item.kind === 'event' &&
          (item.event.status === 'running' ||
            item.event.status === 'awaiting_approval' ||
            item.event.status === 'awaiting_user_input'),
      )
    ) {
      return index
    }
  }

  if (latestReasoningId) {
    for (let index = groups.length - 1; index >= 0; index -= 1) {
      if (groups[index].narratives.some(narrative => narrative.sourceId === latestReasoningId)) {
        return index
      }
    }
  }

  return groups.length > 0 ? groups.length - 1 : -1
}

function ExecutionDigestLog({ entries }: { entries: ExecutionDigestPreview[] }) {
  const [expanded, setExpanded] = useState(false)
  const [hasOverflow, setHasOverflow] = useState(false)
  const [autoScrollEnabled, setAutoScrollEnabled] = useState(true)
  const viewportRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const viewport = viewportRef.current
    if (!viewport || expanded) {
      return
    }

    const measureOverflow = () => {
      setHasOverflow(viewport.scrollHeight - viewport.clientHeight > 2)
    }

    measureOverflow()
    const observer = new ResizeObserver(measureOverflow)
    observer.observe(viewport)
    return () => observer.disconnect()
  }, [entries, expanded])

  useEffect(() => {
    if (!viewportRef.current || !autoScrollEnabled) {
      return
    }
    viewportRef.current.scrollTop = viewportRef.current.scrollHeight
  }, [autoScrollEnabled, entries, expanded])

  const canToggle = hasOverflow || expanded
  const showJumpToLatest = !expanded && !autoScrollEnabled && hasOverflow

  function scrollToLatest() {
    if (!viewportRef.current) {
      return
    }
    viewportRef.current.scrollTop = viewportRef.current.scrollHeight
    setAutoScrollEnabled(true)
  }

  return (
    <div className="execution-digest-log">
      <div
        ref={viewportRef}
        onScroll={event => {
          const nextAutoScrollEnabled = isExecutionDigestNearBottom(event.currentTarget)
          setAutoScrollEnabled(current =>
            current === nextAutoScrollEnabled ? current : nextAutoScrollEnabled,
          )
        }}
        className={`execution-digest-log__viewport custom-scrollbar ${expanded ? 'execution-digest-log__viewport--expanded' : ''
          } ${!expanded && hasOverflow ? 'execution-digest-log__viewport--masked' : ''}${canToggle ? ' execution-digest-log__viewport--interactive' : ''
          }`}
      >
        {entries.map((entry, index) => (
          <div
            key={`${entry.label}-${entry.text}-${index}`}
            className={`execution-digest-log__entry ${(entry.tone || 'default') === 'error' ? 'execution-digest-log__entry--error' : ''
              }`}
          >
            <span className="execution-digest-log__entry-label">{entry.label}</span>
            <div className="execution-digest-log__entry-text">{entry.text}</div>
          </div>
        ))}
      </div>
      {showJumpToLatest || canToggle ? (
        <div className="mt-1 flex items-center justify-center">
          <button
            type="button"
            className="execution-digest-log__toggle"
            onClick={showJumpToLatest ? scrollToLatest : () => setExpanded(current => !current)}
            title={showJumpToLatest ? '回到最新' : expanded ? '收起' : '展开'}
            aria-label={showJumpToLatest ? '回到最新' : expanded ? '收起' : '展开'}
          >
            {showJumpToLatest ? (
              <ArrowDown size={14} />
            ) : expanded ? (
              <ChevronUp size={14} />
            ) : (
              <ChevronDown size={14} />
            )}
          </button>
        </div>
      ) : null}
    </div>
  )
}

function ExecutionDigest({
  activity,
  entries,
}: {
  activity?: ChatMessage['activity']
  entries: ExecutionDigestPreview[]
}) {
  const meta = [
    // activity?.toolCount ? `${activity.toolCount} 个工具` : null,
    // activity?.skillCount ? `${activity.skillCount} 个技能` : null,
  ].filter(Boolean)

  return (
    <section className="flex flex-col gap-2 border-l border-[rgba(79,123,116,0.14)] pl-3">
      {meta.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1.5">
          {meta.map(item => (
            <span
              key={item}
              className="inline-flex items-center rounded-full border border-[rgba(15,23,42,0.06)] bg-white/75 px-2 py-0.5 text-[11px] text-[var(--text-secondary)] opacity-80"
            >
              {item}
            </span>
          ))}
        </div>
      ) : null}

      {entries.length > 0 ? (
        <ExecutionDigestLog entries={entries} />
      ) : null}
    </section>
  )
}

function ExecutionTraceHeader({
  itemCount,
  visibleCount,
  expanded,
  canToggle,
  onToggle,
}: {
  itemCount: number
  visibleCount: number
  expanded: boolean
  canToggle: boolean
  onToggle: () => void
}) {
  const progressLabel = canToggle
    ? expanded
      ? `${itemCount} 段`
      : `${visibleCount}/${itemCount}`
    : ''

  return (
    <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
      <div className="flex min-w-0 items-center gap-2">
        <div className="text-13px font-700 text-[var(--text-primary)]">执行轨迹</div>
        {progressLabel ? (
          <span className="text-11px font-600 text-[var(--text-secondary)] opacity-70">
            {progressLabel}
          </span>
        ) : null}
      </div>
      <div className="flex items-center justify-end">
        {canToggle ? (
          <button
            className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-11px font-700 text-[var(--text-secondary)] hover:bg-white hover:text-[var(--text-primary)]"
            onClick={onToggle}
            type="button"
          >
            <span>{expanded ? '收起' : '全部'}</span>
            {expanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
          </button>
        ) : null}
      </div>
    </div>
  )
}

function ExecutionNarrativeCard({
  narrative,
  extraNarratives,
  isActive,
}: {
  narrative: ExecutionTraceNarrative
  extraNarratives: ExecutionTraceNarrative[]
  isActive: boolean
}) {
  const [expanded, setExpanded] = useState(false)
  const hasRawDetails =
    Boolean(narrative.rawContent) &&
    normalizeComparableText(narrative.rawContent) !== normalizeComparableText(narrative.summary)
  const canExpand = hasRawDetails || extraNarratives.length > 0

  return (
    <article className="stream-reveal-item">
      <button
        className="flex w-full items-start justify-between gap-3 text-left"
        onClick={() => canExpand && setExpanded(current => !current)}
        type="button"
      >
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className={`text-9px font-700 tracking-wider uppercase px-1.5 py-0.5 min-w-10 text-center rounded ${isActive
              ? 'bg-[rgba(79,123,116,0.10)] text-[var(--accent-soft-strong)]'
              : 'bg-[rgba(15,23,42,0.04)] text-[var(--text-secondary)]'
              }`}>
              {narrative.label}
            </span>
            <strong className="text-13px text-[var(--text-primary)]">
              {narrative.title}
            </strong>
            {isActive ? (
              <span className="rounded-full bg-[rgba(79,123,116,0.08)] px-2 py-0.5 text-10px font-600 text-[var(--accent-soft-strong)]">
                进行中
              </span>
            ) : null}
          </div>
          <RevealTextSegments
            text={narrative.summary}
            className="mt-1 whitespace-pre-wrap text-12px leading-relaxed text-[var(--text-secondary)]"
          />
          {extraNarratives.length > 0 ? (
            <div className="mt-2 flex flex-col gap-1.5">
              {extraNarratives.map(extra => (
                <div
                  key={extra.key}
                  className="border-l border-[rgba(15,23,42,0.08)] pl-2 text-12px leading-relaxed text-[var(--text-secondary)]"
                >
                  <span className="font-700 text-[var(--text-primary)]">{extra.title}</span>
                  <span className="mx-1 text-[var(--text-secondary)] opacity-50">·</span>
                  <span>{extra.summary}</span>
                </div>
              ))}
            </div>
          ) : null}
        </div>
        {canExpand ? (
          expanded ? (
            <ChevronUp size={14} className="mt-0.5 shrink-0 text-[var(--text-secondary)] opacity-60" />
          ) : (
            <ChevronDown size={14} className="mt-0.5 shrink-0 text-[var(--text-secondary)] opacity-60" />
          )
        ) : null}
      </button>
      {expanded && hasRawDetails ? (
        <details className="mt-2 rounded-lg border border-[rgba(15,23,42,0.06)] bg-[rgba(15,23,42,0.02)]">
          <summary className="cursor-pointer px-3 py-2 text-11px font-600 text-[var(--text-secondary)] opacity-70">
            查看原始片段
          </summary>
          <RevealTextSegments
            text={narrative.rawContent}
            className="border-t border-[rgba(15,23,42,0.05)] px-3 py-2 whitespace-pre-wrap text-11px leading-relaxed text-[var(--text-secondary)] opacity-75"
          />
        </details>
      ) : null}
    </article>
  )
}

function PhaseOutputCard({
  content,
  label = '阶段输出',
}: {
  content: string
  label?: string
}) {
  return (
    <article className="stream-reveal-item rounded-lg border border-[rgba(15,23,42,0.07)] bg-white px-3 py-2.5 shadow-[0_1px_0_rgba(15,23,42,0.02)]">
      <div className="mb-1 flex items-center gap-2">
        <span className="text-9px font-700 tracking-wider uppercase px-1.5 py-0.5 rounded bg-[rgba(15,23,42,0.04)] text-[var(--text-secondary)]">
          输出
        </span>
        <strong className="text-13px text-[var(--text-primary)]">{label}</strong>
      </div>
      <RevealTextSegments
        text={content.trim()}
        className="whitespace-pre-wrap text-12px leading-relaxed text-[var(--text-secondary)]"
      />
    </article>
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function isSearchControllerDecisionOutput(output: Record<string, unknown>) {
  const provider = typeof output.provider === 'string' ? output.provider : ''
  const code = typeof output.code === 'string' ? output.code : ''
  return provider === 'route-search-controller' || code === 'ROUTE_SEARCH_DIMINISHING_RETURNS'
}

function SearchControllerDecisionCard({
  output,
}: {
  output: Record<string, unknown>
}) {
  const query = typeof output.query === 'string' ? output.query.trim() : ''
  const summary =
    typeof output.summary === 'string' && output.summary.trim()
      ? output.summary.trim()
      : '这一步没有继续发起新的网页搜索，而是基于前面已经拿到的线索决定先收束当前搜索方向。'
  const suggestedAction =
    typeof output.suggestedAction === 'string' && output.suggestedAction.trim()
      ? output.suggestedAction.trim()
      : ''
  const recommendedResults = Array.isArray(output.recommendedResults)
    ? output.recommendedResults.filter(isRecord).slice(0, 3)
    : []

  return (
    <article className="stream-reveal-item rounded-xl border border-[rgba(79,123,116,0.10)] bg-[rgba(79,123,116,0.05)] px-3 py-2.5">
      <div className="mb-1 flex items-center gap-2">
        <span className="text-9px font-700 tracking-wider uppercase px-1.5 py-0.5 min-w-12 text-center rounded bg-white/80 text-[var(--accent-soft-strong)]">
          策略
        </span>
        <strong className="text-12px text-[var(--text-primary)] opacity-85">搜索策略调整</strong>
      </div>
      {query ? (
        <div className="mb-2 text-[11px] text-[var(--text-secondary)] opacity-70">
          当前 query：{query}
        </div>
      ) : null}
      <RevealTextSegments
        text={summary}
        className="whitespace-pre-wrap text-12px leading-relaxed text-[var(--text-primary)] opacity-85"
      />
      {suggestedAction ? (
        <RevealTextSegments
          text={suggestedAction}
          className="mt-2 whitespace-pre-wrap text-12px leading-relaxed text-[var(--text-secondary)] opacity-80"
        />
      ) : null}
      {recommendedResults.length > 0 ? (
        <div className="mt-2 text-[10px] font-600 uppercase tracking-[0.12em] text-[var(--accent-soft-strong)] opacity-75">
          已推荐 {recommendedResults.length} 个后续优先阅读的来源
        </div>
      ) : null}
    </article>
  )
}

const EDITING_PREVIEW_TOOL_NAMES = new Set([
  'apply_patch',
  'write_file',
  'edit_file',
  'multi_edit_file',
  'replace_line_range',
])

function hasPatchPreviewOutput(output: Record<string, unknown> | null) {
  if (!output) {
    return false
  }
  if (Array.isArray(output.preview) || Array.isArray(output.files)) {
    return true
  }
  return (
    (output.stage === 'patch_progress' || output.stage === 'edit_transaction_preview') &&
    (output.phase === 'preview' ||
      output.phase === 'approval_preview' ||
      output.phase === 'streaming_preview' ||
      output.phase === 'streaming_complete')
  )
}

function readPatchPreviewFiles(output: Record<string, unknown>) {
  const rawFiles = Array.isArray(output.preview)
    ? output.preview
    : Array.isArray(output.files)
      ? output.files
      : []
  return rawFiles.filter(isRecord).slice(0, 8)
}

function readPatchNumber(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

const FINAL_CHANGE_FILE_LIMIT = 12

function PatchDiffLine({ line }: { line: Record<string, unknown> }) {
  const type = typeof line.type === 'string' ? line.type : 'context'
  const text = typeof line.text === 'string' ? line.text : ''
  const oldLine = readPatchNumber(line.oldLine)
  const newLine = readPatchNumber(line.newLine)
  const prefix =
    type === 'add'
      ? '+'
      : type === 'remove'
        ? '-'
        : type === 'truncated'
          ? '...'
          : ' '
  const tone =
    type === 'add'
      ? 'bg-emerald-50 text-emerald-800'
      : type === 'remove'
        ? 'bg-red-50 text-red-800'
        : type === 'truncated'
          ? 'bg-amber-50 text-amber-700'
          : 'bg-white text-[#52525b]'

  return (
    <div className={`grid grid-cols-[44px_28px_1fr] gap-2 px-2 py-0.5 ${tone}`}>
      <span className="select-none text-right text-[10px] text-gray-400">
        {oldLine || newLine || ''}
      </span>
      <span className="select-none text-[10px] font-700">{prefix}</span>
      <span className="min-w-0 whitespace-pre-wrap break-words">{text}</span>
    </div>
  )
}

type FinalChangedFile = {
  path: string
  kind: string
  addedLines: number
  removedLines: number
  diffLines: Record<string, unknown>[]
  truncated: boolean
  eventCount: number
}

type FinalChangeSummary = {
  files: FinalChangedFile[]
  transactionIds: string[]
}

function readFinalChangeFilesFromOutput(output: Record<string, unknown>) {
  const rawFiles = Array.isArray(output.preview)
    ? output.preview
    : Array.isArray(output.files)
      ? output.files
      : []

  return rawFiles.filter(isRecord)
}

function normalizeFinalChangedFile(
  file: Record<string, unknown>,
  index: number,
): FinalChangedFile | null {
  const pathLabel =
    typeof file.path === 'string'
      ? file.path
      : typeof file.relativePath === 'string'
        ? file.relativePath
        : ''
  if (!pathLabel) {
    return null
  }

  const diffStat = isRecord(file.diffStat) ? file.diffStat : {}
  const diffPreview = isRecord(file.diffPreview) ? file.diffPreview : null
  const diffLines = Array.isArray(diffPreview?.lines)
    ? diffPreview.lines.filter(isRecord)
    : []
  const addedLines = readPatchNumber(diffStat.addedLines)
  const removedLines = readPatchNumber(diffStat.removedLines)
  const changed = file.changed !== false

  if (!changed && addedLines === 0 && removedLines === 0 && diffLines.length === 0) {
    return null
  }

  return {
    path: pathLabel,
    kind: typeof file.kind === 'string' ? file.kind : index === 0 ? 'update' : 'edit',
    addedLines,
    removedLines,
    diffLines,
    truncated: diffPreview?.truncated === true,
    eventCount: 1,
  }
}

function mergeFinalChangedFile(
  current: FinalChangedFile,
  next: FinalChangedFile,
): FinalChangedFile {
  const separator =
    current.diffLines.length > 0 && next.diffLines.length > 0
      ? [
        {
          type: 'truncated',
          text: `下一次编辑：${next.path}`,
        },
      ]
      : []

  return {
    ...current,
    kind: current.kind === next.kind ? current.kind : 'update',
    addedLines: current.addedLines + next.addedLines,
    removedLines: current.removedLines + next.removedLines,
    diffLines: [...current.diffLines, ...separator, ...next.diffLines],
    truncated: current.truncated || next.truncated,
    eventCount: current.eventCount + next.eventCount,
  }
}

function collectFinalChangeSummary(events: MessageEvent[] = []): FinalChangeSummary {
  const byPath = new Map<string, FinalChangedFile>()
  const transactionIds: string[] = []

  for (const event of events) {
    if (
      event.kind === 'approval' ||
      event.status !== 'success' ||
      !EDITING_PREVIEW_TOOL_NAMES.has(event.toolName || '')
    ) {
      continue
    }

    const parsedOutput = readEventStructuredOutput(event)
    if (!parsedOutput) {
      continue
    }

    const transactionId =
      parsedOutput.reversible === true && typeof parsedOutput.transactionId === 'string'
        ? parsedOutput.transactionId
        : ''
    if (transactionId && !transactionIds.includes(transactionId)) {
      transactionIds.push(transactionId)
    }

    for (const [index, file] of readFinalChangeFilesFromOutput(parsedOutput).entries()) {
      const normalized = normalizeFinalChangedFile(file, index)
      if (!normalized) {
        continue
      }

      const existing = byPath.get(normalized.path)
      byPath.set(
        normalized.path,
        existing ? mergeFinalChangedFile(existing, normalized) : normalized,
      )
    }
  }

  return {
    files: Array.from(byPath.values()).slice(0, FINAL_CHANGE_FILE_LIMIT),
    transactionIds,
  }
}

function FinalChangedFilesCard({ summary }: { summary: FinalChangeSummary }) {
  const [expandedFiles, setExpandedFiles] = useState<Record<string, boolean>>({})
  const [changeState, setChangeState] = useState<'applied' | 'reverted'>('applied')
  const [toggleError, setToggleError] = useState('')
  const [isToggling, setIsToggling] = useState(false)
  const visibleFiles = summary.files.slice(0, FINAL_CHANGE_FILE_LIMIT)
  const canToggle = summary.transactionIds.length > 0
  const totalAdded = visibleFiles.reduce((sum, file) => sum + file.addedLines, 0)
  const totalRemoved = visibleFiles.reduce((sum, file) => sum + file.removedLines, 0)

  if (visibleFiles.length === 0) {
    return null
  }

  async function handleToggleChangeSet() {
    if (!canToggle || isToggling) {
      return
    }

    const targetState = changeState === 'applied' ? 'before' : 'after'
    setIsToggling(true)
    setToggleError('')
    try {
      await toggleEditTransactionSnapshots(summary.transactionIds, targetState)
      setChangeState(targetState === 'before' ? 'reverted' : 'applied')
    } catch (caught) {
      setToggleError(caught instanceof Error ? caught.message : '切换变更状态失败。')
    } finally {
      setIsToggling(false)
    }
  }

  return (
    <section className="mt-1 overflow-hidden rounded-xl border border-[rgba(15,23,42,0.08)] bg-white shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[rgba(15,23,42,0.06)] bg-[rgba(15,23,42,0.025)] px-3 py-2.5">
        <div className="flex min-w-0 items-center gap-2">
          <span className="text-13px font-700 text-[var(--text-primary)]">
            {visibleFiles.length} 个文件已更改
          </span>
          <span className="text-12px font-700 text-emerald-600">+{totalAdded}</span>
          <span className="text-12px font-700 text-red-600">-{totalRemoved}</span>
        </div>
        <div className="flex items-center gap-2">
          <span className={`rounded-full px-2 py-0.5 text-10px font-700 ${changeState === 'applied'
            ? 'bg-emerald-50 text-emerald-700'
            : 'bg-amber-50 text-amber-700'
            }`}>
            {changeState === 'applied' ? '已应用' : '已撤销'}
          </span>
          {canToggle ? (
            <button
              className="inline-flex items-center gap-1.5 rounded-lg border border-[rgba(15,23,42,0.08)] bg-white px-2.5 py-1.5 text-12px font-600 text-[var(--text-primary)] transition-colors hover:bg-[rgba(15,23,42,0.04)] disabled:cursor-not-allowed disabled:opacity-50"
              disabled={isToggling}
              onClick={() => void handleToggleChangeSet()}
              type="button"
            >
              <RefreshCw size={13} className={isToggling ? 'animate-spin' : ''} />
              {changeState === 'applied' ? '撤销' : '应用'}
            </button>
          ) : null}
        </div>
      </div>
      {toggleError ? (
        <div className="border-b border-red-100 bg-red-50 px-3 py-2 text-12px text-red-600">
          {toggleError}
        </div>
      ) : null}

      <div className="divide-y divide-[rgba(15,23,42,0.06)]">
        {visibleFiles.map((file, index) => {
          const fileKey = `${file.path}-${index}`
          const isFileExpanded = expandedFiles[fileKey] ?? false

          return (
            <div key={fileKey} className="bg-white">
              <button
                aria-expanded={isFileExpanded}
                className="flex w-full flex-wrap items-center justify-between gap-2 bg-[rgba(15,23,42,0.035)] px-3 py-2 text-left transition-colors hover:bg-[rgba(15,23,42,0.055)]"
                onClick={() =>
                  setExpandedFiles(current => ({
                    ...current,
                    [fileKey]: !isFileExpanded,
                  }))
                }
                type="button"
              >
                <div className="flex min-w-0 items-center gap-2">
                  {isFileExpanded ? (
                    <ChevronDown size={14} className="shrink-0 text-[var(--text-secondary)]" />
                  ) : (
                    <ChevronRight size={14} className="shrink-0 text-[var(--text-secondary)]" />
                  )}
                  <span className="min-w-0 truncate text-13px font-600 text-[var(--text-primary)]">
                    {file.path}
                  </span>
                  {file.eventCount > 1 ? (
                    <span className="shrink-0 rounded-full bg-white px-2 py-0.5 text-10px font-700 text-[var(--text-secondary)]">
                      {file.eventCount} edits
                    </span>
                  ) : null}
                </div>
                <div className="flex shrink-0 items-center gap-1.5 text-12px font-800">
                  <span className="text-emerald-600">+{file.addedLines}</span>
                  <span className="text-red-600">-{file.removedLines}</span>
                </div>
              </button>

              {isFileExpanded && file.diffLines.length > 0 ? (
                <div className="border-t border-[rgba(15,23,42,0.04)]">
                  <div className="max-h-[28rem] overflow-auto font-[SFMono-Regular,Menlo,monospace] text-[12px] leading-5 custom-scrollbar">
                    {file.diffLines.map((line, lineIndex) => (
                      <PatchDiffLine key={`${fileKey}-${lineIndex}`} line={line} />
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
          )
        })}
      </div>
    </section>
  )
}

function PatchPreviewCard({
  output,
  status,
}: {
  output: Record<string, unknown>
  status: MessageEvent['status']
}) {
  const [expandedFiles, setExpandedFiles] = useState<Record<string, boolean>>({})
  const files = readPatchPreviewFiles(output)
  const affectedPaths = Array.isArray(output.affectedPaths)
    ? output.affectedPaths
      .filter((entry): entry is string => typeof entry === 'string')
      .slice(0, 8)
    : []
  const operations = Array.isArray(output.operations)
    ? output.operations.filter(isRecord).slice(0, 8)
    : []
  const isEditTransaction = output.stage === 'edit_transaction_preview'
  const summary =
    typeof output.summary === 'string' && output.summary.trim()
      ? output.summary.trim()
      : status === 'running' || status === 'awaiting_approval'
        ? isEditTransaction
          ? 'Editing preview ready'
          : 'Patch preview ready'
        : isEditTransaction
          ? 'Editing transaction complete'
          : 'Patch applied'

  if (files.length === 0 && affectedPaths.length === 0) {
    return null
  }

  return (
    <div className="mt-2 rounded-xl border border-[rgba(79,123,116,0.12)] bg-[rgba(79,123,116,0.05)] p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="inline-flex items-center rounded-full bg-white/85 px-2 py-1 text-[10px] font-700 uppercase tracking-[0.12em] text-[var(--accent-soft-strong)]">
          {isEditTransaction ? 'Edit' : 'Patch'}
        </span>
        <span className="text-[12px] font-600 text-[var(--text-primary)]">{summary}</span>
        {affectedPaths.length > 0 ? (
          <span className="rounded-full bg-white/75 px-2 py-1 text-[10px] text-[var(--text-secondary)]">
            {affectedPaths.length} file{affectedPaths.length === 1 ? '' : 's'}
          </span>
        ) : null}
      </div>

      {files.length === 0 && affectedPaths.length > 0 ? (
        <div className="mt-2 flex flex-col gap-1.5">
          {affectedPaths.map((pathLabel, index) => {
            const operation = operations.find(
              entry => entry.path === pathLabel || entry.moveTo === pathLabel,
            )
            const kind = typeof operation?.kind === 'string' ? operation.kind : 'pending'
            return (
              <div
                key={`${pathLabel}-${index}`}
                className="flex min-w-0 items-center justify-between gap-2 rounded-lg border border-white/80 bg-white/85 px-3 py-2"
              >
                <span className="min-w-0 truncate text-[12px] font-600 text-[var(--text-primary)]">
                  {pathLabel}
                </span>
                <span className="shrink-0 rounded-full bg-[rgba(79,123,116,0.08)] px-2 py-1 text-[10px] font-700 uppercase tracking-[0.12em] text-[var(--accent-soft-strong)]">
                  {kind}
                </span>
              </div>
            )
          })}
        </div>
      ) : null}

      {files.length > 0 ? (
        <div className="mt-2 flex flex-col gap-2">
          {files.map((file, index) => {
            const pathLabel =
              typeof file.path === 'string'
                ? file.path
                : typeof file.relativePath === 'string'
                  ? file.relativePath
                  : `file-${index + 1}`
            const kind = typeof file.kind === 'string' ? file.kind : 'update'
            const diffStat = isRecord(file.diffStat) ? file.diffStat : {}
            const addedLines = readPatchNumber(diffStat.addedLines)
            const removedLines = readPatchNumber(diffStat.removedLines)
            const diffPreview = isRecord(file.diffPreview) ? file.diffPreview : null
            const diffLines = Array.isArray(diffPreview?.lines)
              ? diffPreview.lines.filter(isRecord).slice(0, 120)
              : []
            const fileKey = `${pathLabel}-${index}`
            const isFileExpanded =
              expandedFiles[fileKey] ?? (files.length === 1 || index === 0)

            return (
              <div
                key={`${pathLabel}-${index}`}
                className="rounded-lg border border-white/80 bg-white/85"
              >
                <button
                  aria-expanded={isFileExpanded}
                  className="flex w-full flex-wrap items-center justify-between gap-2 px-3 py-2 text-left"
                  onClick={() =>
                    setExpandedFiles(current => ({
                      ...current,
                      [fileKey]: !isFileExpanded,
                    }))
                  }
                  type="button"
                >
                  <div className="flex min-w-0 items-center gap-2">
                    {isFileExpanded ? (
                      <ChevronDown size={14} className="shrink-0 text-[var(--text-secondary)]" />
                    ) : (
                      <ChevronRight size={14} className="shrink-0 text-[var(--text-secondary)]" />
                    )}
                    <div className="min-w-0">
                      <div className="truncate text-[12px] font-600 text-[var(--text-primary)]">
                        {pathLabel}
                      </div>
                      <div className="mt-0.5 text-[10px] uppercase tracking-[0.12em] text-[var(--text-secondary)] opacity-70">
                        {kind}
                      </div>
                    </div>
                  </div>
                  <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5 text-[10px] font-700">
                    {diffPreview?.truncated === true ? (
                      <span className="rounded-full bg-amber-50 px-2 py-1 text-amber-700">
                        truncated
                      </span>
                    ) : null}
                    <span className="rounded-full bg-emerald-50 px-2 py-1 text-emerald-700">
                      +{addedLines}
                    </span>
                    <span className="rounded-full bg-red-50 px-2 py-1 text-red-700">
                      -{removedLines}
                    </span>
                  </div>
                </button>
                {isFileExpanded && diffLines.length > 0 ? (
                  <div className="border-t border-[rgba(15,23,42,0.05)]">
                    <div className="max-h-72 overflow-auto font-[SFMono-Regular,Menlo,monospace] text-[11px] leading-5 custom-scrollbar">
                      {diffLines.map((line, lineIndex) => (
                        <PatchDiffLine
                          key={`${pathLabel}-${index}-${lineIndex}`}
                          line={line}
                        />
                      ))}
                    </div>
                  </div>
                ) : null}
              </div>
            )
          })}
        </div>
      ) : null}
    </div>
  )
}

function ShellOutputViewport({
  content,
  isLive,
  tone = 'default',
}: {
  content: string
  isLive: boolean
  tone?: 'default' | 'error'
}) {
  const viewportRef = useRef<HTMLPreElement>(null)
  const [autoFollow, setAutoFollow] = useState(true)

  useEffect(() => {
    const viewport = viewportRef.current
    if (!viewport || !autoFollow) {
      return
    }
    viewport.scrollTop = viewport.scrollHeight
  }, [autoFollow, content])

  useEffect(() => {
    if (!isLive) {
      setAutoFollow(false)
    }
  }, [isLive])

  return (
    <pre
      ref={viewportRef}
      onScroll={event => {
        const nextAutoFollow = isExecutionDigestNearBottom(event.currentTarget)
        setAutoFollow(current => (current === nextAutoFollow ? current : nextAutoFollow))
      }}
      className={`max-h-260px overflow-auto whitespace-pre-wrap break-words font-[SFMono-Regular,Menlo,monospace] text-12px leading-6 custom-scrollbar ${tone === 'error' ? 'text-red-600' : 'text-[#52525b]'
        }`}
    >
      {content}
    </pre>
  )
}

function normalizeTerminalWrite(value: string) {
  return value.replace(/\r?\n/g, '\r\n')
}

function sanitizeXtermWrite(value: string) {
  return value
    .replace(ANSI_OSC_PATTERN, '')
    .replace(/\uFFFD/g, '')
}

function stripDisplayPrompt(value: string) {
  return value.replace(/^\$\s*/u, '').trim()
}

function summarizeShellCommand(command: string) {
  const commandText = sanitizeTerminalOutput(stripDisplayPrompt(command))
  return commandText || 'Shell'
}

function dockedApprovalCategoryLabel(category?: string) {
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
      return '桌面操作'
    case 'plan':
      return '执行计划'
    default:
      return '工具执行'
  }
}

function dockedApprovalGrantLabel(category?: string) {
  switch (category) {
    case 'shell':
      return '本轮 Shell 都允许'
    case 'file_write':
      return '本轮文件写入都允许'
    case 'external_file_read':
      return '本轮外部文件读取都允许'
    case 'external_file_write':
      return '本轮外部文件写入都允许'
    case 'computer_use':
      return '本轮桌面操作都允许'
    case 'plan':
      return '批准计划'
    default:
      return '本轮同类都允许'
  }
}

function readStringField(record: Record<string, unknown> | null, keys: string[]) {
  if (!record) {
    return ''
  }
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) {
      return value.trim()
    }
  }
  return ''
}

type DockedApprovalViewModel = {
  eyebrow: string
  primaryLabel: string
  primaryText: string
  summary: string
}

function buildDockedApprovalViewModel(
  approval: NonNullable<AgentTaskSnapshot['pendingApproval']>,
): DockedApprovalViewModel {
  const inputRecord = parseJsonOutput(approval.input)
  const command = readStringField(inputRecord, ['command', 'cmd', 'script'])
  const path = readStringField(inputRecord, ['path', 'filePath', 'targetPath', 'target'])
  const action = readStringField(inputRecord, ['action', 'operation'])
  const fallbackInput = sanitizeTerminalOutput(approval.input).trim()

  if (approval.category === 'plan') {
    const goal = readStringField(inputRecord, ['goal'])
    const planId = readStringField(inputRecord, ['planId'])
    return {
      eyebrow: '执行计划',
      primaryLabel: '将执行计划',
      primaryText: goal || planId || fallbackInput || approval.summary || '执行计划',
      summary: approval.summary,
    }
  }

  if (approval.category === 'shell') {
    return {
      eyebrow: 'Shell 命令',
      primaryLabel: '将执行',
      primaryText: command || stripDisplayPrompt(fallbackInput) || approval.toolName || 'Shell 命令',
      summary: approval.summary,
    }
  }

  if (approval.category === 'file_write' || approval.category === 'external_file_write') {
    return {
      eyebrow: approval.category === 'external_file_write' ? '外部文件写入' : '文件写入',
      primaryLabel: path ? '将写入' : '将执行文件写入',
      primaryText: path || fallbackInput || approval.toolName || '文件写入',
      summary: approval.summary,
    }
  }

  if (approval.category === 'external_file_read') {
    return {
      eyebrow: '外部文件读取',
      primaryLabel: path ? '将读取' : '将读取外部文件',
      primaryText: path || fallbackInput || approval.toolName || '外部文件读取',
      summary: approval.summary,
    }
  }

  if (approval.category === 'computer_use') {
    return {
      eyebrow: '桌面操作',
      primaryLabel: action ? '将操作' : '将执行桌面操作',
      primaryText: action || fallbackInput || approval.toolName || '桌面操作',
      summary: approval.summary,
    }
  }

  return {
    eyebrow: dockedApprovalCategoryLabel(approval.category),
    primaryLabel: '将执行',
    primaryText: fallbackInput || approval.toolName || approval.summary || '工具执行',
    summary: approval.summary,
  }
}

function shellCollapsedLabel({
  command,
  status,
  duration,
}: {
  command: string
  status: MessageEvent['status']
  duration: string
}) {
  const commandText = summarizeShellCommand(command)
  if (status === 'running') {
    return `正在运行 ${commandText}${duration ? ` · ${duration}` : ''}`
  }
  if (status === 'error') {
    return `运行失败 ${commandText}${duration ? ` · ${duration}` : ''}`
  }
  return `已运行 ${commandText}${duration ? ` · ${duration}` : ''}`
}

function buildTerminalTranscript({
  command,
  output,
  error,
  status,
  truncated,
}: {
  command: string
  output: string
  error: string
  status: MessageEvent['status']
  truncated: boolean
}) {
  const lines: string[] = []
  const commandText = sanitizeTerminalOutput(stripDisplayPrompt(command))

  if (commandText) {
    lines.push(`\x1b[38;2;24;24;27m$\x1b[0m ${commandText}`)
    lines.push('')
  }
  if (output) {
    lines.push(sanitizeXtermWrite(output))
  } else if (status === 'running') {
    lines.push('\x1b[38;2;113;113;122m等待命令输出...\x1b[0m')
  }
  if (error) {
    if (output) {
      lines.push('')
    }
    lines.push('\x1b[1;38;2;220;38;38mError\x1b[0m')
    lines.push(`\x1b[38;2;220;38;38m${sanitizeXtermWrite(error)}\x1b[0m`)
  }
  if (truncated) {
    lines.push('')
    lines.push('\x1b[38;2;180;83;9m输出较长，仅展示最近缓冲内容。\x1b[0m')
  }

  const transcript = lines.join('\n').trimEnd()
  return normalizeTerminalWrite(transcript ? `${transcript}\n\n` : '')
}

function ShellTerminalPanel({
  command,
  output,
  error,
  status,
  isLive,
  truncated,
  exitCode,
}: {
  command: string
  output: string
  error: string
  status: MessageEvent['status']
  isLive: boolean
  truncated: boolean
  exitCode?: number
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const terminalReadyRef = useRef(false)

  useEffect(() => {
    const container = containerRef.current
    if (!container) {
      return
    }

    const terminal = new Terminal({
      allowProposedApi: false,
      convertEol: true,
      cursorBlink: isLive,
      cursorStyle: 'bar',
      disableStdin: true,
      fontFamily: 'SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace',
      fontSize: 12.5,
      lineHeight: 1.5,
      overviewRuler: {
        showBottomBorder: false,
        showTopBorder: false,
        width: 6,
      },
      scrollback: 3000,
      theme: {
        background: '#eeeeef',
        foreground: '#27272a',
        cursor: '#71717a',
        black: '#18181b',
        blue: '#2563eb',
        cyan: '#0891b2',
        green: '#15803d',
        magenta: '#7c3aed',
        red: '#dc2626',
        overviewRulerBorder: '#eeeeef',
        scrollbarSliderActiveBackground: 'rgba(39, 39, 42, 0.28)',
        scrollbarSliderBackground: 'rgba(39, 39, 42, 0.16)',
        scrollbarSliderHoverBackground: 'rgba(39, 39, 42, 0.24)',
        white: '#f4f4f5',
        yellow: '#b45309',
      },
    })
    const fitAddon = new FitAddon()
    terminal.loadAddon(fitAddon)
    terminal.open(container)
    terminalReadyRef.current = true
    try {
      fitAddon.fit()
    } catch {
      // xterm can briefly report zero-size geometry during collapsed layout transitions.
    }

    terminalRef.current = terminal
    fitAddonRef.current = fitAddon

    const resizeObserver = new ResizeObserver(() => {
      try {
        fitAddon.fit()
      } catch {
        // xterm can briefly report zero-size geometry during collapsed layout transitions.
      }
    })
    resizeObserver.observe(container)

    return () => {
      resizeObserver.disconnect()
      terminalReadyRef.current = false
      terminal.dispose()
      terminalRef.current = null
      fitAddonRef.current = null
    }
  }, [])

  useEffect(() => {
    const terminal = terminalRef.current
    if (!terminal) {
      return
    }
    terminal.options.cursorBlink = isLive
  }, [isLive])

  useEffect(() => {
    const terminal = terminalRef.current
    if (!terminal || !terminalReadyRef.current) {
      return
    }
    try {
      terminal.reset()
      terminal.write(buildTerminalTranscript({
        command,
        output,
        error,
        status,
        truncated,
      }), () => {
        if (!terminalReadyRef.current || terminalRef.current !== terminal) {
          return
        }
        try {
          terminal.scrollToBottom()
        } catch {
          // xterm may dispose its renderer while React is unmounting/collapsing the panel.
        }
      })
    } catch {
      // Ignore transient renderer disposal during rapid task/plan UI updates.
    }
  }, [command, output, error, status, truncated, exitCode])

  return (
    <div className="shell-terminal-frame">
      <div ref={containerRef} className="shell-terminal-surface" />
    </div>
  )
}

function DockedAwaitingActionPanel({
  task,
  onHandleApproval,
}: {
  task?: AgentTaskSnapshot | null
  onHandleApproval: (decision: ApprovalDecision) => void
}) {
  const approval = task?.pendingApproval
  const userInput = task?.pendingUserInput

  if (approval) {
    const approvalView = buildDockedApprovalViewModel(approval)
    return (
      <section
        aria-live="polite"
        className="mb-3 w-full pointer-events-auto overflow-hidden rounded-2xl border border-amber-200/80 bg-white/98 shadow-[0_18px_50px_-22px_rgba(15,23,42,0.5)] ring-1 ring-amber-100/60 backdrop-blur-xl"
      >
        <div className="flex flex-col gap-3 p-3.5">
          <div className="flex items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-2">
              <span className="rounded-lg bg-amber-50 px-2 py-1 text-11px font-700 text-amber-700">
                待审批
              </span>
              <span className="truncate text-13px font-700 text-[var(--text-primary)]">
                {approvalView.eyebrow}
              </span>
            </div>
            <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
              <button
                className="rounded-xl border border-[rgba(15,23,42,0.08)] bg-white px-3 py-2 text-13px font-600 text-[var(--text-secondary)] transition-colors hover:bg-[rgba(15,23,42,0.04)]"
                onClick={() => onHandleApproval('deny')}
                type="button"
              >
                拒绝
              </button>
              <button
                className="rounded-xl border border-[rgba(79,123,116,0.20)] bg-white px-3 py-2 text-13px font-700 text-[var(--accent-soft-strong)] transition-colors hover:bg-[rgba(79,123,116,0.06)]"
                onClick={() => onHandleApproval('approve')}
                type="button"
              >
                允许一次
              </button>
              <button
                className="rounded-xl bg-[var(--accent-soft-strong)] px-3 py-2 text-13px font-700 text-white shadow-sm transition-all hover:brightness-110"
                onClick={() => onHandleApproval('approve_for_task')}
                type="button"
              >
                {dockedApprovalGrantLabel(approval.category)}
              </button>
            </div>
          </div>

          <div className="rounded-xl border border-[rgba(15,23,42,0.06)] bg-[rgba(15,23,42,0.025)] px-3 py-2.5">
            <div className="mb-1 text-11px font-700 text-[var(--text-secondary)] opacity-70">
              {approvalView.primaryLabel}
            </div>
            <pre className="max-h-24 overflow-auto whitespace-pre-wrap break-words font-[SFMono-Regular,Menlo,monospace] text-13px leading-relaxed text-[var(--text-primary)] custom-scrollbar">
              {approval.category === 'shell' ? `$ ${approvalView.primaryText}` : approvalView.primaryText}
            </pre>
          </div>
        </div>

        {approvalView.summary ? (
          <details className="border-t border-amber-100/80 bg-amber-50/40">
            <summary className="cursor-pointer px-4 py-2 text-11px font-700 text-amber-700/90">
              查看说明
            </summary>
            <div className="border-t border-amber-100/80 px-4 py-3">
              {approvalView.summary ? (
                <p className="mb-3 text-12px leading-relaxed text-[var(--text-secondary)]">
                  {approvalView.summary}
                </p>
              ) : null}
            </div>
          </details>
        ) : null}
      </section>
    )
  }

  if (userInput) {
    return (
      <section
        aria-live="polite"
        className="mb-3 w-full pointer-events-auto rounded-2xl border border-[rgba(79,123,116,0.18)] bg-white/98 p-4 shadow-[0_18px_50px_-22px_rgba(15,23,42,0.45)] ring-1 ring-[rgba(79,123,116,0.08)] backdrop-blur-xl"
      >
        <div className="mb-1.5 flex items-center gap-2">
          <span className="rounded-lg bg-[rgba(79,123,116,0.08)] px-2 py-1 text-11px font-700 text-[var(--accent-soft-strong)]">
            等待回复
          </span>
          <span className="text-12px text-[var(--text-secondary)]">请在下方输入框补充信息</span>
        </div>
        <p className="text-13px leading-relaxed text-[var(--text-primary)]">
          {userInput.question}
        </p>
        {userInput.context ? (
          <details className="mt-3 rounded-xl border border-[rgba(15,23,42,0.06)] bg-[rgba(15,23,42,0.02)]">
            <summary className="cursor-pointer px-3 py-2 text-11px font-700 text-[var(--text-secondary)]">
              查看上下文
            </summary>
            <pre className="max-h-40 overflow-auto border-t border-[rgba(15,23,42,0.06)] px-3 py-2 text-11px leading-relaxed text-[var(--text-secondary)] custom-scrollbar">
              {userInput.context}
            </pre>
          </details>
        ) : null}
      </section>
    )
  }

  return null
}

function DockedTaskStepsPanel({
  nodes,
  visible,
}: {
  nodes: TaskNode[]
  visible: boolean
}) {
  const [collapsed, setCollapsed] = useState(false)
  const visibleNodes = sanitizeTaskNodes(nodes, '')

  if (!visible || visibleNodes.length === 0) {
    return null
  }

  return (
    <section
      aria-live="polite"
      className="mb-3 w-full sm:w-2/3 pointer-events-auto rounded-2xl border border-[rgba(79,123,116,0.14)] bg-white/96 px-3.5 py-2.5 shadow-[0_18px_50px_-24px_rgba(15,23,42,0.45)] ring-1 ring-[rgba(79,123,116,0.08)] backdrop-blur-xl"
    >
      <div className="flex min-w-0 items-start gap-2">
        <div className="min-w-0 flex-1">
          <TaskTreeView nodes={visibleNodes} collapsed={collapsed} />
        </div>
        <button
          type="button"
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-[rgba(15,23,42,0.08)] bg-white/80 text-[var(--text-secondary)] transition-colors hover:border-[rgba(79,123,116,0.28)] hover:text-[var(--text-primary)]"
          aria-label={collapsed ? '展开执行步骤' : '折叠执行步骤'}
          title={collapsed ? '展开执行步骤' : '折叠执行步骤'}
          onClick={() => setCollapsed(value => !value)}
        >
          {collapsed ? <ChevronDown size={15} /> : <ChevronUp size={15} />}
        </button>
      </div>
    </section>
  )
}

function findLatestLiveAssistantSteps(messages: ChatMessage[]) {
  for (const message of [...messages].reverse()) {
    if (
      message.role === 'assistant' &&
      (message.status === 'pending' || message.status === 'streaming') &&
      (message.steps || []).length > 0
    ) {
      return message.steps || []
    }
  }
  return []
}

function MessageEventCard({
  event,
  onHandleApproval,
  onCancelCurrentStep,
  onCopyText,
}: {
  event: MessageEvent
  onHandleApproval?: (decision: ApprovalDecision) => void
  onCancelCurrentStep?: () => void
  onCopyText?: CopyTextHandler
}) {
  const isShellLog = event.kind === 'shell'
  const hasShellDetails = isShellLog && (event.input || event.output || event.error)
  const isApproval = event.kind === 'approval' && event.status === 'awaiting_approval'
  const isUserInputWait =
    event.kind === 'user_input' && event.status === 'awaiting_user_input'
  const parsedOutput = readEventStructuredOutput(event)
  const parsedShellSnapshot = isShellLog ? parseShellEventSnapshot(event.output) : null
  const toolName = typeof event.toolName === 'string' ? event.toolName : ''
  const isStructuredWebResearchEvent = toolName === 'web_research' && Boolean(parsedOutput)
  const isStructuredWebSearchEvent = toolName === 'web_search' && Boolean(parsedOutput)
  const isStructuredWebFetchEvent = toolName === 'web_fetch' && Boolean(parsedOutput)
  const isStructuredPatchPreviewEvent =
    EDITING_PREVIEW_TOOL_NAMES.has(toolName) && hasPatchPreviewOutput(parsedOutput)
  const isSearchControllerDecisionEvent =
    isStructuredWebSearchEvent &&
    parsedOutput &&
    isSearchControllerDecisionOutput(parsedOutput)
  const failureSummary =
    event.status === 'error'
      ? event.errorInfo?.summary || summarizeFailureReason(event.error || event.output || event.summary)
      : ''
  const failureAction =
    event.status === 'error'
      ? event.errorInfo?.suggestedAction
      : ''
  const shellCommand =
    event.input ||
    (parsedShellSnapshot?.command ? `$ ${parsedShellSnapshot.command}` : '')
  const shellRawOutputText = parsedShellSnapshot
    ? parsedShellSnapshot.output ||
    [parsedShellSnapshot.stdout, parsedShellSnapshot.stderr].filter(Boolean).join('\n\n')
    : event.output || ''
  const shellRawErrorText = event.error || ''
  const shellOutputText = sanitizeTerminalOutput(
    shellRawOutputText,
  )
  const shellErrorText = sanitizeTerminalOutput(shellRawErrorText)
  const shellDuration =
    typeof parsedShellSnapshot?.wallTimeMs === 'number'
      ? formatDuration(parsedShellSnapshot.wallTimeMs)
      : ''
  const eventDuration =
    typeof event.durationMs === 'number' && Number.isFinite(event.durationMs)
      ? formatDuration(event.durationMs)
      : shellDuration
  const eventMeta = [
    eventDuration,
    eventSourceLabel(event.source),
  ].filter(Boolean)
  const shellStatusDetail = isShellLog
    ? event.status === 'running'
      ? `命令仍在执行${shellDuration ? ` · 已运行 ${shellDuration}` : ''}`
      : event.status === 'success'
        ? `命令已执行完成${shellDuration ? ` · 用时 ${shellDuration}` : ''}`
        : `命令执行失败${shellDuration ? ` · 已运行 ${shellDuration}` : ''}${typeof parsedShellSnapshot?.exitCode === 'number'
          ? ` · 退出码 ${parsedShellSnapshot.exitCode}`
          : ''
        }`
    : ''
  const shellTruncationNote =
    parsedShellSnapshot?.truncated === true ? '输出较长，仅保留了最近一部分。' : ''
  const shellSummaryLabel = isShellLog
    ? shellCollapsedLabel({
      command: shellCommand,
      status: event.status,
      duration: shellDuration,
    })
    : ''
  const shouldShowGenericSummary =
    !isShellLog && Boolean(event.summary) && !isGenericToolSummary(event)
  const shellLogText = [
    shellCommand ? `Command\n${shellCommand}` : '',
    shellOutputText ? `Output\n${shellOutputText}` : '',
    shellErrorText ? `Error\n${shellErrorText}` : '',
  ]
    .filter(Boolean)
    .join('\n\n')
  const genericDetailText = !isShellLog
    ? [
      event.input ? `Input\n${event.input}` : '',
      event.output ? `Output\n${event.output}` : '',
      event.error ? `Error\n${event.error}` : '',
    ]
      .filter(Boolean)
      .join('\n\n')
    : ''

  if (!isApproval && !isUserInputWait && isSearchControllerDecisionEvent && parsedOutput) {
    return <SearchControllerDecisionCard output={parsedOutput} />
  }

  return (
    <article className="rounded-lg border border-[rgba(15,23,42,0.07)] bg-white px-3 py-2.5 shadow-[0_1px_0_rgba(15,23,42,0.02)]">
      <div className="mb-1 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-2">
            <span
              className={`text-9px font-700 tracking-wider uppercase px-1.5 py-0.5 rounded ${eventKindPillClassName(event)}`}
            >
              {eventKindLabel(event)}
            </span>
            <strong className="min-w-0 truncate text-13px text-[var(--text-primary)] leading-tight">{event.title}</strong>
          </div>
          {eventMeta.length > 0 ? (
            <div className="mt-1 flex flex-wrap items-center gap-1.5 text-10px text-[var(--text-secondary)] opacity-65">
              {eventMeta.map(meta => (
                <span key={meta}>{meta}</span>
              ))}
            </div>
          ) : null}
        </div>
        <div className="relative shrink-0 group/status">
          <div className="flex items-center gap-2">
            {event.status === 'running' ? (
              <button
                className="flex items-center justify-center p-1 rounded-lg text-red-500 border border-red-200 bg-red-50 hover:bg-red-100 transition-all"
                title="停止当前步骤"
                onClick={onCancelCurrentStep}
                type="button"
              >
                <Square size={10} fill="currentColor" strokeWidth={0} />
              </button>
            ) : null}
            <span
              className={`shrink-0 rounded-full border px-2 py-0.5 text-10px font-700 ${event.status === 'error' ? 'cursor-help ' : ''}${eventStatusPillClassName(event.status)}`}
            >
              {eventStatusLabel(event.status)}
            </span>
          </div>
          {event.status === 'error' ? (
            <div className="pointer-events-none absolute right-0 top-[calc(100%+8px)] z-20 hidden w-72 rounded-xl border border-red-100 bg-white px-3 py-2 text-left text-12px leading-relaxed text-red-600 shadow-lg shadow-[rgba(15,23,42,0.12)] group-hover/status:block">
              <div className="font-600">{failureSummary}</div>
              {failureAction ? (
                <div className="mt-1 text-[11px] leading-relaxed text-red-500/85">
                  {failureAction}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
      {shouldShowGenericSummary ? (
        <p className="text-12px leading-relaxed text-[var(--text-secondary)]">{event.summary}</p>
      ) : null}
      {!isApproval && isStructuredWebResearchEvent && parsedOutput ? (
        <WebResearchEventCard event={event} output={parsedOutput} />
      ) : null}
      {!isApproval && isStructuredWebSearchEvent && parsedOutput ? (
        <WebSearchEventCard event={event} output={parsedOutput} />
      ) : null}
      {!isApproval && isStructuredWebFetchEvent && parsedOutput ? (
        <WebFetchEventCard event={event} output={parsedOutput} />
      ) : null}
      {isStructuredPatchPreviewEvent && parsedOutput ? (
        <PatchPreviewCard output={parsedOutput} status={event.status} />
      ) : null}
      {isApproval ? (
        <div className="mt-2 rounded-xl border border-amber-200 bg-white p-3">
          {event.input ? (
            <details
              className="rounded-lg border border-gray-100 bg-gray-50"
              open={!isStructuredPatchPreviewEvent}
            >
              <summary className="cursor-pointer px-3 py-2 text-11px font-600 text-[var(--text-secondary)]">
                原始请求
              </summary>
              <pre className="max-h-72 overflow-auto border-t border-gray-100 p-3 text-11px custom-scrollbar">
                {event.input}
              </pre>
            </details>
          ) : null}
          <div className="mt-3 flex items-center justify-end gap-2">
            <button
              className="rounded-lg bg-gray-100 px-3 py-2 text-12px font-500 transition-colors hover:bg-gray-200"
              onClick={() => onHandleApproval?.('deny')}
              type="button"
            >
              拒绝
            </button>
            <button
              className="rounded-lg bg-[var(--accent-soft-strong)] px-3 py-2 text-12px font-500 text-white transition-all hover:brightness-110"
              onClick={() => onHandleApproval?.('approve')}
              type="button"
            >
              允许一次
            </button>
          </div>
        </div>
      ) : null}
      {isUserInputWait ? (
        <div className="mt-2 rounded-xl border border-amber-200 bg-white p-3">
          {event.input ? (
            <p className="whitespace-pre-wrap text-12px leading-relaxed text-[var(--text-secondary)]">
              {event.input}
            </p>
          ) : null}
          <div className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-12px leading-relaxed text-amber-700">
            请直接在输入框回复，任务会沿着当前上下文继续，不会重新从头规划。
          </div>
        </div>
      ) : null}
      {hasShellDetails ? (
        <details className="shell-event-details" open={event.status === 'running' || event.status === 'error'}>
          <summary className="shell-event-summary flex items-center justify-between w-full">
            <div className="flex items-center gap-2">
              <span className="shell-event-summary__label">{shellSummaryLabel || shellStatusDetail}</span>
              <ChevronDown size={14} className="shell-event-summary__chevron" />
            </div>
            <div className="flex items-center gap-2">
              {shellLogText ? (
                <span className="shell-event-actions">
                  {onCopyText ? (
                    <button
                      className="shell-event-action"
                      title="复制日志"
                      aria-label="复制日志"
                      onClick={clickEvent => {
                        clickEvent.preventDefault()
                        clickEvent.stopPropagation()
                        onCopyText(shellLogText)
                      }}
                      type="button"
                    >
                      <Copy size={13} />
                    </button>
                  ) : null}
                  <button
                    className="shell-event-action"
                    title="下载 LOG"
                    aria-label="下载 LOG"
                    onClick={clickEvent => {
                      clickEvent.preventDefault()
                      clickEvent.stopPropagation()
                      downloadTextFile(timestampedFilename('shell-log', 'log'), shellLogText, 'text/plain;charset=utf-8')
                    }}
                    type="button"
                  >
                    <Download size={13} />
                  </button>
                </span>
              ) : null}
            </div>
          </summary>
          <div className="shell-event-body">
            <ShellTerminalPanel
              command={shellCommand}
              output={shellRawOutputText}
              error={shellRawErrorText}
              status={event.status}
              isLive={event.status === 'running'}
              truncated={parsedShellSnapshot?.truncated === true}
              exitCode={parsedShellSnapshot?.exitCode}
            />
            {shellTruncationNote ? (
              <div className="mt-2 text-11px text-[var(--text-secondary)] opacity-70">
                {shellTruncationNote}
              </div>
            ) : null}
          </div>
        </details>
      ) : null}
      {!isApproval && !isUserInputWait && !isShellLog && (event.input || event.output || event.error) && (
        <details className="mt-1.5 group" open={!isShellLog && event.status === 'error'}>
          <summary className="text-11px text-[var(--text-secondary)] cursor-pointer hover:text-[var(--text-primary)] transition-colors opacity-65">查看审计详情</summary>
          <div className="mt-2 flex flex-col gap-3 rounded-lg border border-[rgba(15,23,42,0.05)] bg-white/85 p-3">
            {genericDetailText ? (
              <div className="flex items-center justify-end gap-1">
                {onCopyText ? (
                  <button className="p-1 rounded hover:bg-[rgba(0,0,0,0.05)] text-[var(--text-secondary)]" title="复制详情" aria-label="复制详情" onClick={() => onCopyText(genericDetailText)}>
                    <Copy size={12} />
                  </button>
                ) : null}
                <button className="p-1 rounded hover:bg-[rgba(0,0,0,0.05)] text-[var(--text-secondary)]" title="下载详情" aria-label="下载详情" onClick={() => downloadTextFile(timestampedFilename('tool-details', 'txt'), genericDetailText, 'text/plain;charset=utf-8')}>
                  <Download size={12} />
                </button>
              </div>
            ) : null}
            {!isShellLog && event.input && (
              <div className="flex flex-col gap-1">
                <span className="text-10px font-600 text-gray-400 uppercase">Input</span>
                <pre className="text-11px text-gray-600 whitespace-pre-wrap">{event.input}</pre>
              </div>
            )}
            {!isShellLog && event.output && (
              <div className="flex flex-col gap-1">
                <span className="text-10px font-600 text-gray-400 uppercase">Output</span>
                <pre className="text-11px text-gray-600 whitespace-pre-wrap">{event.output}</pre>
              </div>
            )}
            {event.error && (
              <div className="flex flex-col gap-1">
                <span className="text-10px font-600 text-red-400 uppercase">Error</span>
                <pre className="text-11px text-red-600 whitespace-pre-wrap">{event.error}</pre>
              </div>
            )}
          </div>
        </details>
      )}
    </article>
  )
}

function MessageVersionSwitcher({
  message,
  align = 'left',
  onSelectVersion,
}: {
  message: ChatMessage
  align?: 'left' | 'right'
  onSelectVersion: (messageId: string, nextIndex: number) => void
}) {
  const versionCount = message.versions?.length || 1
  const activeIndex = message.activeVersionIndex || 0

  if (versionCount <= 1) {
    return null
  }

  return (
    <div
      className={`flex items-center gap-1 text-[var(--text-secondary)] ${align === 'right' ? 'justify-end' : 'justify-start'
        }`}
    >
      <button
        className="rounded-md p-1 hover:bg-[rgba(15,23,42,0.05)] disabled:opacity-60"
        disabled={activeIndex <= 0}
        onClick={() => onSelectVersion(message.id, activeIndex - 1)}
        title="查看上一版"
        type="button"
      >
        <ChevronLeft size={12} />
      </button>
      <span className="min-w-[30px] text-center text-12px font-500 text-[var(--text-secondary)]">
        {activeIndex + 1}/{versionCount}
      </span>
      <button
        className="rounded-md p-1 hover:bg-[rgba(15,23,42,0.05)] disabled:opacity-60"
        disabled={activeIndex >= versionCount - 1}
        onClick={() => onSelectVersion(message.id, activeIndex + 1)}
        title="查看下一版"
        type="button"
      >
        <ChevronRight size={12} />
      </button>
    </div>
  )
}

function MessageOverflowMenu({
  messageId,
  onDeleteMessage,
  extraActions = [],
}: {
  messageId: string
  onDeleteMessage: (messageId: string) => void
  extraActions?: Array<{
    key: string
    label: string
    icon: typeof LayoutGrid
    onClick?: () => void
    disabled?: boolean
    closeMenuOnClick?: boolean
    panel?: ReactNode
  }>
}) {
  const [open, setOpen] = useState(false)
  const [activePanelKey, setActivePanelKey] = useState<string | null>(null)
  const [placement, setPlacement] = useState<'top' | 'bottom'>('bottom')
  const menuRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) {
      setActivePanelKey(null)
    }
  }, [open])

  useEffect(() => {
    if (!open) {
      return
    }

    function handleClickOutside(event: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setOpen(false)
      }
    }

    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [open])

  useEffect(() => {
    if (!open) {
      return
    }

    function updatePlacement() {
      const anchorRect = menuRef.current?.getBoundingClientRect()
      const panelRect = panelRef.current?.getBoundingClientRect()
      if (!anchorRect || !panelRect) {
        return
      }

      const gap = 8
      const composerRect = document
        .querySelector('[data-chat-composer-root="true"]')
        ?.getBoundingClientRect()
      const lowerBoundary =
        composerRect && composerRect.top > anchorRect.top
          ? Math.min(window.innerHeight, composerRect.top)
          : window.innerHeight
      const spaceBelow = lowerBoundary - anchorRect.bottom
      const spaceAbove = anchorRect.top
      const requiredHeight = panelRect.height + gap

      if (spaceBelow >= requiredHeight) {
        setPlacement('bottom')
        return
      }

      if (spaceAbove >= requiredHeight) {
        setPlacement('top')
        return
      }

      setPlacement(spaceAbove > spaceBelow ? 'top' : 'bottom')
    }

    const rafId = window.requestAnimationFrame(updatePlacement)
    window.addEventListener('resize', updatePlacement)
    window.addEventListener('scroll', updatePlacement, true)
    return () => {
      window.cancelAnimationFrame(rafId)
      window.removeEventListener('resize', updatePlacement)
      window.removeEventListener('scroll', updatePlacement, true)
    }
  }, [open])

  return (
    <div className="relative" ref={menuRef}>
      <button
        className="rounded-md p-1.5 text-[var(--text-secondary)] hover:bg-[rgba(0,0,0,0.05)]"
        onClick={() =>
          setOpen(current => {
            if (current) {
              setActivePanelKey(null)
            }
            return !current
          })
        }
        title="更多操作"
        type="button"
      >
        <MoreHorizontal size={15} />
      </button>
      {open ? (
        <div
          className={`absolute right-0 z-20 ${placement === 'top' ? 'bottom-[calc(100%+8px)]' : 'top-[calc(100%+8px)]'}`}
        >
          <div
            ref={panelRef}
            className="min-w-[190px] overflow-hidden rounded-2xl border border-[rgba(15,23,42,0.08)] bg-white shadow-xl shadow-[rgba(15,23,42,0.12)]"
          >
            {extraActions.map(action => {
              const Icon = action.icon
              const hasPanel = Boolean(action.panel)
              const isPanelOpen = activePanelKey === action.key

              return (
                <button
                  key={action.key}
                  className="flex w-full items-center gap-3 px-4 py-3 text-left text-[15px] font-500 text-[var(--text-primary)] hover:bg-[rgba(15,23,42,0.04)] disabled:cursor-not-allowed disabled:opacity-45"
                  disabled={action.disabled}
                  onClick={() => {
                    if (hasPanel) {
                      setActivePanelKey(current => (current === action.key ? null : action.key))
                    }
                    if (action.closeMenuOnClick !== false && !hasPanel) {
                      setOpen(false)
                      setActivePanelKey(null)
                    }
                    action.onClick?.()
                  }}
                  type="button"
                >
                  <Icon size={16} />
                  <span className="flex-1">{action.label}</span>
                  {hasPanel ? (
                    <ChevronLeft
                      size={14}
                      className={`text-[var(--text-secondary)] opacity-55 transition-transform ${isPanelOpen ? 'rotate-180' : ''}`}
                    />
                  ) : null}
                </button>
              )
            })}
            <button
              className="flex w-full items-center gap-3 px-4 py-3 text-left text-[15px] font-500 text-red-500 hover:bg-red-50"
              onClick={() => {
                setOpen(false)
                setActivePanelKey(null)
                onDeleteMessage(messageId)
              }}
              type="button"
            >
              <Trash2 size={16} />
              <span>删除消息</span>
            </button>
          </div>
          {activePanelKey ? (
            <div className="absolute right-[calc(100%+8px)] top-0">
              {extraActions.find(action => action.key === activePanelKey)?.panel || null}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

function MessageUsagePopover({ usage }: { usage?: MessageUsage }) {
  return (
    <div className="w-[280px] rounded-[24px] border border-[rgba(15,23,42,0.08)] bg-white px-5 py-4 shadow-[0_18px_50px_rgba(15,23,42,0.16)]">
      <div className="mb-3">
        <strong className="block text-[20px] font-700 tracking-tight text-[var(--text-primary)]">
          用量
        </strong>
        <p className="mt-1 text-11px text-[var(--text-secondary)] opacity-75">
          当前回答这一版的累计模型用量
        </p>
      </div>

      <div className="flex flex-col gap-2.5">
        {usageRows(usage).map(row => (
          <div key={row.label} className="flex items-center justify-between gap-4">
            <span className="text-[15px] font-500 text-[#6B7FA0]">{row.label}</span>
            <span className="text-[16px] font-700 tracking-[0.02em] text-[var(--text-primary)]">
              {row.value}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

function ModelPickerDialog({
  title,
  description,
  modelGroups,
  activeProfileId,
  activeModelId,
  onClose,
  onSelect,
}: {
  title: string
  description: string
  modelGroups: ModelGroup[]
  activeProfileId: string
  activeModelId: string
  onClose: () => void
  onSelect: (profileId: string, modelId: string) => void
}) {
  const [searchTerm, setSearchTerm] = useState('')
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set())
  const dialogRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function handleKeyDown(event: globalThis.KeyboardEvent) {
      if (event.key === 'Escape') {
        onClose()
      }
    }

    function handleMouseDown(event: MouseEvent) {
      if (dialogRef.current && !dialogRef.current.contains(event.target as Node)) {
        onClose()
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    document.addEventListener('mousedown', handleMouseDown)
    return () => {
      document.removeEventListener('keydown', handleKeyDown)
      document.removeEventListener('mousedown', handleMouseDown)
    }
  }, [onClose])

  const filteredGroups = modelGroups
    .map(group => ({
      ...group,
      models: group.models.filter(
        model =>
          model.id.toLowerCase().includes(searchTerm.toLowerCase()) ||
          group.profileName.toLowerCase().includes(searchTerm.toLowerCase()),
      ),
    }))
    .filter(group => group.models.length > 0)

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-[rgba(15,23,42,0.16)] px-4 py-6 backdrop-blur-sm">
      <div
        ref={dialogRef}
        className="flex max-h-[78vh] w-full max-w-[540px] flex-col overflow-hidden rounded-[24px] border border-[rgba(15,23,42,0.08)] bg-white shadow-2xl shadow-[rgba(15,23,42,0.18)]"
      >
        <div className="flex items-start justify-between gap-4 border-b border-[rgba(15,23,42,0.05)] px-5 py-4">
          <div className="min-w-0">
            <strong className="block text-16px font-700 text-[var(--text-primary)]">{title}</strong>
            <p className="mt-1 text-13px leading-relaxed text-[var(--text-secondary)]">
              {description}
            </p>
          </div>
          <button
            className="rounded-lg p-2 text-[var(--text-secondary)] hover:bg-[rgba(15,23,42,0.04)]"
            onClick={onClose}
            type="button"
          >
            <X size={16} />
          </button>
        </div>

        <div className="border-b border-[rgba(15,23,42,0.05)] px-4 py-3">
          <div className="flex items-center gap-2.5 rounded-xl border border-[rgba(15,23,42,0.08)] bg-white px-3 shadow-sm focus-within:border-[var(--bg-user-bubble)]/60 focus-within:ring-4 focus-within:ring-[var(--bg-user-bubble)]/5 transition-all">
            <Search size={14} className="text-[var(--text-secondary)] opacity-30" />
            <input
              autoFocus
              className="h-11 flex-1 !border-none !outline-none !ring-0 !shadow-none !bg-transparent appearance-none p-0 text-13px font-medium placeholder:opacity-30 placeholder:text-[var(--text-secondary)]"
              placeholder="搜索模型或 Provider..."
              value={searchTerm}
              onChange={event => setSearchTerm(event.target.value)}
            />
          </div>
        </div>

        <div className="min-h-[260px] max-h-[52vh] overflow-y-auto custom-scrollbar px-2 py-2">
          {filteredGroups.length > 0 ? (
            filteredGroups.map(group => {
              const isCollapsed = collapsedGroups.has(group.profileId)
              return (
                <div key={group.profileId} className="mb-1 last:mb-0">
                  <button
                    className="sticky top-0 z-10 flex w-full items-center justify-between rounded-lg bg-white px-3 py-2 text-left text-10px font-800 uppercase tracking-widest text-[rgba(15,23,42,0.42)] hover:bg-[rgba(15,23,42,0.02)]"
                    onClick={() => {
                      setCollapsedGroups(current => {
                        const next = new Set(current)
                        if (next.has(group.profileId)) next.delete(group.profileId)
                        else next.add(group.profileId)
                        return next
                      })
                    }}
                    type="button"
                  >
                    <div className="flex items-center gap-2">
                      <span>{group.profileName}</span>
                      <span className="normal-case font-500 tracking-normal opacity-45">
                        {group.models.length} items
                      </span>
                    </div>
                    <ChevronDown
                      size={12}
                      className={`transition-transform ${isCollapsed ? '-rotate-90' : ''}`}
                    />
                  </button>

                  {!isCollapsed ? (
                    <div className="mt-1 flex flex-col gap-0.5">
                      {group.models.map(model => {
                        const isActive =
                          group.profileId === activeProfileId && model.id === activeModelId
                        const shortName =
                          model.id.split('/').filter(Boolean).at(-1) || model.id

                        return (
                          <button
                            key={`${group.profileId}:${model.id}`}
                            className={`flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left transition-colors ${isActive
                              ? 'bg-[rgba(79,123,116,0.08)]'
                              : 'hover:bg-[rgba(15,23,42,0.04)]'
                              }`}
                            onClick={() => onSelect(group.profileId, model.id)}
                            type="button"
                          >
                            <div className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-md border ${isActive ? 'border-[var(--accent-soft-strong)] bg-[var(--accent-soft-strong)] text-white' : 'border-[rgba(15,23,42,0.12)] bg-white text-transparent'}`}>
                              <Check size={12} />
                            </div>
                            <div className="min-w-0 flex-1">
                              <div className="truncate text-14px font-700 text-[var(--text-primary)]">
                                {shortName}
                              </div>
                              <div className="truncate text-12px text-[var(--text-secondary)]">
                                {model.id}
                              </div>
                            </div>
                          </button>
                        )
                      })}
                    </div>
                  ) : null}
                </div>
              )
            })
          ) : (
            <div className="px-3 py-8 text-center text-13px text-[var(--text-secondary)]">
              没有匹配到可用模型。
            </div>
          )}
        </div>
      </div>
    </div>
  )
}



function CapabilityPanel({
  items,
  snapshot,
  collapsedGroups,
  onToggleGroup,
  onSetCapabilityOverride,
}: {
  items: CapabilityPanelItem[]
  snapshot?: CapabilityUsageSnapshot
  collapsedGroups: Set<'skill' | 'plugin' | 'mcp'>
  onToggleGroup: (group: 'skill' | 'plugin' | 'mcp') => void
  onSetCapabilityOverride: (
    kind: 'skills' | 'plugins' | 'mcp',
    id: string,
    mode: CapabilityOverrideMode,
  ) => void
}) {
  const sections: Array<{ key: 'skill' | 'plugin' | 'mcp'; label: string }> = [
    { key: 'skill', label: 'Skills' },
    { key: 'plugin', label: 'Plugins' },
    { key: 'mcp', label: 'MCP' },
  ]
  const manageableEnabledCount = items.filter(item => item.effectiveEnabled).length

  function resolveNextOverrideMode(item: CapabilityPanelItem) {
    const nextEffectiveEnabled = !item.effectiveEnabled
    if (nextEffectiveEnabled === item.globalEnabled) {
      return 'inherit' as const
    }
    return nextEffectiveEnabled ? ('on' as const) : ('off' as const)
  }

  function setSectionEnabled(
    sectionKey: 'skill' | 'plugin' | 'mcp',
    enabled: boolean,
  ) {
    const sectionItems = items.filter(item => item.kind === sectionKey)
    for (const item of sectionItems) {
      if (!item.supported) {
        continue
      }
      const settingKey =
        item.kind === 'skill'
          ? 'skills'
          : item.kind === 'plugin'
            ? 'plugins'
            : 'mcp'
      const nextMode =
        enabled === item.globalEnabled
          ? ('inherit' as const)
          : enabled
            ? ('on' as const)
            : ('off' as const)
      onSetCapabilityOverride(settingKey, item.id, nextMode)
    }
  }

  return (
    <div className="overflow-hidden rounded-xl border border-[rgba(15,23,42,0.08)] bg-white/98 shadow-2xl shadow-[rgba(15,23,42,0.15)] backdrop-blur-xl">
      <div className="border-b border-[rgba(15,23,42,0.05)] px-4 py-3">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <Sparkles size={14} className="text-[var(--accent-soft-strong)]" />
              <strong className="text-14px font-700 text-[var(--text-primary)]">项目工具</strong>
            </div>
            <p className="mt-1 text-12px leading-relaxed text-[var(--text-secondary)]">
              这里的开关只影响当前项目，不会修改全局默认设置。
            </p>
          </div>
          {snapshot ? (
            <div className="shrink-0 rounded-full bg-[rgba(79,123,116,0.08)] px-3 py-1 text-11px font-600 text-[var(--accent-soft-strong)]">
              生效 {manageableEnabledCount}
            </div>
          ) : null}
        </div>
      </div>

      <div className="max-h-[420px] overflow-y-auto custom-scrollbar p-2">
        {sections.map(section => {
          const sectionItems = items.filter(item => item.kind === section.key)
          const supportedItems = sectionItems.filter(item => item.supported)
          const allEnabled =
            supportedItems.length > 0 &&
            supportedItems.every(item => item.effectiveEnabled)
          const isCollapsed = collapsedGroups.has(section.key)
          return (
            <div key={section.key} className="mb-1 last:mb-0">
              <button
                className="sticky top-0 z-10 mb-1 flex w-full items-center justify-between gap-3 rounded-lg bg-white px-3 py-2 text-left hover:bg-[rgba(15,23,42,0.03)]"
                onClick={() => onToggleGroup(section.key)}
                type="button"
              >
                <div className="text-10px font-800 uppercase tracking-widest text-[var(--text-secondary)] opacity-55">
                  {section.label}
                </div>
                <div className="flex items-center gap-2 text-11px text-[var(--text-secondary)] opacity-55">
                  <span>
                    {sectionItems.filter(item => item.effectiveEnabled).length}/{sectionItems.length} 生效
                  </span>
                  <ChevronDown size={12} className={`transition-transform ${isCollapsed ? '-rotate-90' : ''}`} />
                </div>
              </button>
              {!isCollapsed && sectionItems.length > 0 ? (
                <div className="mb-2 flex items-center justify-end px-3">
                  <button
                    className="rounded-md px-2.5 py-1 text-11px font-600 text-[var(--text-secondary)] hover:bg-[rgba(15,23,42,0.05)]"
                    onClick={() => setSectionEnabled(section.key, !allEnabled)}
                    type="button"
                  >
                    {allEnabled ? '全部关闭' : '全部打开'}
                  </button>
                </div>
              ) : null}
              {!isCollapsed && sectionItems.length > 0 ? (
                <div className="flex flex-col gap-1">
                  {sectionItems.map(item => {
                    const settingKey =
                      item.kind === 'skill'
                        ? 'skills'
                        : item.kind === 'plugin'
                          ? 'plugins'
                          : 'mcp'
                    return (
                      <div
                        key={`${item.kind}-${item.id}`}
                        className="rounded-xl px-3 py-3 transition-colors hover:bg-[rgba(15,23,42,0.025)]"
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-2">
                              <strong className="max-w-[190px] break-words text-13px text-[var(--text-primary)]">
                                {clampToTwoLines(item.name, 42)}
                              </strong>
                              <span className="rounded-full bg-white px-2 py-0.5 text-10px text-[var(--text-secondary)]">
                                {item.source === 'builtin' ? '内置' : '用户安装'}
                              </span>
                              <span
                                className={`rounded-full px-2 py-0.5 text-10px ${item.effectiveEnabled
                                  ? 'bg-green-50 text-green-600'
                                  : 'bg-gray-100 text-gray-500'
                                  }`}
                              >
                                {item.effectiveEnabled ? '生效中' : '未生效'}
                              </span>
                            </div>
                            <p className="mt-1 max-w-[240px] text-12px leading-relaxed text-[var(--text-secondary)]">
                              {clampToTwoLines(item.description, 86)}
                            </p>
                            {item.supportMessage ? (
                              <p className="mt-1 max-w-[240px] text-11px text-amber-600">
                                {clampToTwoLines(item.supportMessage, 86)}
                              </p>
                            ) : null}
                          </div>
                          <label
                            className={`relative flex shrink-0 items-center gap-3 ${item.supported ? 'cursor-pointer' : 'cursor-not-allowed opacity-40'
                              }`}
                          >
                            <input
                              type="checkbox"
                              className="peer sr-only"
                              checked={item.effectiveEnabled}
                              disabled={!item.supported}
                              onChange={() =>
                                onSetCapabilityOverride(
                                  settingKey,
                                  item.id,
                                  resolveNextOverrideMode(item),
                                )
                              }
                            />
                            <div className="relative h-5 w-9 shrink-0 rounded-full bg-black/10 transition-all peer-checked:bg-[var(--bg-user-bubble)] after:absolute after:top-0.5 after:left-[2px] after:h-4 after:w-4 after:rounded-full after:bg-white after:shadow-sm after:transition-all after:content-[''] peer-checked:after:translate-x-4" />
                          </label>
                        </div>
                      </div>
                    )
                  })}
                </div>
              ) : !isCollapsed ? (
                <div className="rounded-xl px-3 py-3 text-12px text-[var(--text-secondary)] opacity-65">
                  还没有可用的 {section.label}。
                </div>
              ) : null}
            </div>
          )
        })}
      </div>
    </div>
  )
}

function AppendedInputsPanel({
  inputs,
  messageId,
  isStreaming,
  onForceExecute,
}: {
  inputs: AppendedInput[]
  messageId: string
  isStreaming: boolean
  onForceExecute: (messageId: string, inputId: string) => void
}) {
  if (inputs.length === 0) {
    return null
  }

  return (
    <section className="flex flex-col gap-2">
      {inputs.map(input => (
        <div
          key={input.id}
          className="rounded-xl border border-[rgba(15,23,42,0.06)] bg-[rgba(15,23,42,0.02)] px-3 py-2.5"
        >
          <div className="mb-1 flex flex-wrap items-center gap-2">
            <span className="rounded-full bg-[rgba(15,23,42,0.06)] px-2 py-0.5 text-9px font-700 uppercase tracking-wider text-[var(--text-secondary)]">
              补充输入
            </span>
            <span
              className={`text-11px ${input.status === 'consumed'
                ? 'text-[var(--accent-soft-strong)]'
                : 'text-[var(--text-secondary)] opacity-70'
                }`}
            >
              {appendedInputStatusLabel(input.status)}
            </span>
            {isStreaming && input.status === 'queued' ? (
              <button
                className="rounded-full border border-[rgba(79,123,116,0.22)] bg-white px-2.5 py-0.5 text-10px font-700 text-[var(--accent-soft-strong)] hover:bg-[rgba(79,123,116,0.06)]"
                onClick={() => onForceExecute(messageId, input.id)}
                type="button"
              >
                立即处理
              </button>
            ) : null}
          </div>
          <div className="text-13px leading-relaxed text-[var(--text-primary)]">
            {input.content}
          </div>
          {input.attachments?.length ? (
            <div className="mt-2 flex flex-wrap gap-2">
              {input.attachments.map(attachment => (
                <span
                  key={attachment.id}
                  className="rounded-full border border-[rgba(15,23,42,0.08)] bg-white px-2.5 py-1 text-11px text-[var(--text-secondary)]"
                  title={attachment.path}
                >
                  {attachment.name}
                </span>
              ))}
            </div>
          ) : null}
        </div>
      ))}
    </section>
  )
}

function AssistantMessageCard({
  message,
  modelGroups,
  activeModelProfileId,
  activeModelId,
  onCopyText,
  onEditMessage,
  onDeleteMessage,
  onSelectMessageVersion,
  onRegenerateMessage,
  onRegenerateMessageWithModel,
  onForceExecuteAppendedInput,
  showDetailedExecutionDetails,
  onCancelCurrentStep,
  onHandleApproval,
  onToggleActivity,
}: {
  message: ChatMessage
  modelGroups: ModelGroup[]
  activeModelProfileId: string
  activeModelId: string
  onCopyText: CopyTextHandler
  onEditMessage: (messageId: string) => void
  onDeleteMessage: (messageId: string) => void
  onSelectMessageVersion: (messageId: string, nextIndex: number) => void
  onRegenerateMessage: (messageId: string) => void
  onRegenerateMessageWithModel: (messageId: string, profileId: string, modelId: string) => void
  onForceExecuteAppendedInput: (messageId: string, inputId: string) => void
  showDetailedExecutionDetails: boolean
  onCancelCurrentStep: () => void
  onHandleApproval: (decision: ApprovalDecision) => void
  onToggleActivity: (messageId: string) => void
}) {
  const [modelDialogOpen, setModelDialogOpen] = useState(false)
  const [executionTraceExpanded, setExecutionTraceExpanded] = useState(false)
  const answerBodyRef = useRef<HTMLDivElement>(null)
  const messageTimeLabel = formatConversationTimestamp(message.createdAt)
  const activity = message.activity
  const duration = activity
    ? (
      activity.finishedAt ||
      (activity.status === 'running' ||
        activity.status === 'queued' ||
        activity.status === 'awaiting_approval' ||
        activity.status === 'awaiting_user_input'
        ? Date.now()
        : activity.startedAt)
    ) - activity.startedAt
    : undefined
  const visibleSteps = sanitizeTaskNodes(message.steps || [], message.content)
  const visibleReasoning = (message.reasoning || []).filter(entry =>
    normalizeComparableText(entry.content),
  )
  const visiblePhaseOutputs = (message.phaseOutputs || []).filter(output =>
    normalizeComparableText(output.content),
  )
  const phaseOutputBlockIds = new Set(
    visiblePhaseOutputs
      .map(output => output.blockId)
      .filter((blockId): blockId is string => typeof blockId === 'string' && blockId.length > 0),
  )
  const appendedInputs = message.appendedInputs || []
  const isStreaming = message.status === 'pending' || message.status === 'streaming'
  const activeVariantId = getActiveMessageVariant(message).id || message.id
  useEffect(() => {
    setExecutionTraceExpanded(false)
  }, [activeVariantId])
  const isRetryInProgress = isStreaming && message.retryInfo?.inProgress === true
  const messageHasToolFailure = hasToolFailure(message)
  const messageFailureSummary =
    activity?.status === 'failed' || message.error
      ? message.errorInfo?.summary || summarizeFailureReason(message.error)
      : ''
  const messageFailureDetail = messageFailureSummary
    ? formatFailureDetail(message.errorInfo, message.error)
    : ''
  const messageRetryDetail = formatRetryLabel(message.retryInfo, message.status)
  const userFacingActivityStatus = userFacingActivityStatusLabel(
    activity,
    message,
    isRetryInProgress,
  )
  const activitySummary = activity
    ? [
      userFacingActivityStatus || activityStatusLabel(activity.status),
      duration ? formatDuration(duration) : null,
    ]
      .filter(Boolean)
      .join(' · ')
    : null
  const messageModelLabel =
    message.modelInfo?.label ||
    (activeModelId.split('/').filter(Boolean).at(-1) || activeModelId || '未记录模型')
  const messageModelProfileId = message.modelInfo?.providerProfileId || activeModelProfileId
  const messageModelId = message.modelInfo?.modelId || activeModelId
  const hasUsage =
    (message.usage?.inputTokens || 0) > 0 || (message.usage?.outputTokens || 0) > 0
  const filteredReasoning = visibleReasoning.filter(entry =>
    shouldDisplayReasoningEntry(entry, {
      isStreaming,
      hasLinkedOutput: phaseOutputBlockIds.has(entry.id),
    }),
  )
  const providerReasoning = filteredReasoning.filter(entry => entry.kind === 'provider')
  const displayReasoning = filteredReasoning
  const executionTimeline = buildExecutionTimeline(
    displayReasoning,
    visiblePhaseOutputs,
    message.events || [],
  )
  const finalChangeSummary = useMemo(
    () => collectFinalChangeSummary(message.events || []),
    [message.events],
  )
  const nonApprovalTimeline = executionTimeline.filter(
    item => !(isExecutionEventItem(item) && isAwaitingUserResponseEvent(item.event)),
  )
  const executionTraceGroups = buildExecutionTraceGroups(nonApprovalTimeline)
  const latestReasoningId =
    displayReasoning.filter(entry => !isSyntheticRunSummary(entry.content)).at(-1)?.id ||
    displayReasoning.at(-1)?.id ||
    ''
  const currentTraceGroupIndex = findCurrentExecutionTraceGroupIndex(
    executionTraceGroups,
    latestReasoningId,
  )
  const visibleExecutionTraceGroups = executionTraceExpanded
    ? executionTraceGroups
    : currentTraceGroupIndex >= 0
      ? [executionTraceGroups[currentTraceGroupIndex]]
      : []
  const executionDigestEntries = buildExecutionDigestEntries({
    executionTimeline: nonApprovalTimeline,
    taskNodes: [],
  })
  const shouldShowDetailedTimeline =
    activity?.expanded === true &&
    showDetailedExecutionDetails &&
    executionTraceGroups.length > 0
  const shouldShowCompactDigest =
    activity?.expanded === true &&
    !showDetailedExecutionDetails &&
    executionDigestEntries.length > 0
  const shouldSuppressStreamingAnswerBody =
    isStreaming &&
    !showDetailedExecutionDetails &&
    ((message.events?.length || 0) > 0 || visiblePhaseOutputs.length > 0 || visibleSteps.length > 0)
  const identifierActions = [
    {
      key: 'copy-message-id',
      label: '复制 message_id',
      icon: Copy,
      onClick: () => onCopyText(activeVariantId),
    },
  ]

  const usedTools = Array.from(
    new Set(
      (message.events || [])
        .filter(event => !isSearchControllerDecisionEvent(event))
        .filter(event => event.kind !== 'approval')
        .filter(event => event.source === 'builtin' || event.source === 'subagent')
        .map(event => event.title),
    ),
  )
  const usedPlugins = Array.from(
    new Set(
      (message.events || [])
        .filter(event => event.kind !== 'approval')
        .filter(event => event.source === 'plugin')
        .map(event => event.title),
    ),
  )
  const usedMcp = Array.from(
    new Set(
      (message.events || [])
        .filter(event => event.kind !== 'approval')
        .filter(event => event.source === 'mcp')
        .map(event => event.title),
    ),
  )
  const invokedCount = usedTools.length + usedPlugins.length + usedMcp.length
  const hasUsedCapabilities = invokedCount > 0
  const invokedToolsGroups = [
    { label: 'Built-in Tools', items: usedTools, type: 'Tool' },
    { label: 'Plugins', items: usedPlugins, type: 'Plug' },
    { label: 'MCP Servers', items: usedMcp, type: 'MCP' },
  ].filter(group => group.items.length > 0)
  const shouldShowAnswer = Boolean(message.content)
  const canCopyAnswer = Boolean(message.content)
  const answerFilenameBase = `aura-answer-${message.id.slice(0, 8)}`
  const answerExportActions = [
    {
      key: 'download-answer-markdown',
      label: '下载 Markdown',
      icon: Download,
      disabled: !canCopyAnswer,
      onClick: () =>
        downloadTextFile(
          timestampedFilename(answerFilenameBase, 'md'),
          message.content,
          'text/markdown;charset=utf-8',
        ),
    },
    {
      key: 'download-answer-html',
      label: '下载 HTML',
      icon: Download,
      disabled: !canCopyAnswer,
      onClick: () => downloadMarkdownAnswerHtml(message.content, answerBodyRef.current, answerFilenameBase),
    },
  ]
  const fallbackStatusTitle = !isStreaming && !shouldShowAnswer
    ? (message.events?.length || 0) > 0
      ? '模型执行了操作，但没有生成最终总结回答。'
      : providerReasoning.length > 0
        ? '模型已规划后续动作，但没有成功形成最终回答。'
        : '模型执行了操作，但没有生成最终总结回答。'
    : ''
  const retryFailureSummary =
    typeof message.retryInfo?.lastErrorSummary === 'string' && message.retryInfo.lastErrorSummary.trim()
      ? summarizeFailureReason(message.retryInfo.lastErrorSummary)
      : ''
  const statusNoticeTitle = messageDetailStatusTitle({
    activity,
    message,
    isStreaming,
    isRetryInProgress,
    hasAnswer: shouldShowAnswer,
    hasFallbackStatus: Boolean(fallbackStatusTitle),
    hasToolFailure: messageHasToolFailure,
  })
  const statusNoticeTone: MessageStatusNoticeTone =
    statusNoticeTitle === '执行失败' || statusNoticeTitle === '已停止'
      ? 'error'
      : isStreaming
        ? 'progress'
        : 'neutral'
  const statusNoticeDetail = messageDetailStatusDescription({
    title: statusNoticeTitle,
    detail: messageFailureDetail,
    fallbackDetail: fallbackStatusTitle,
    retryDetail: retryFailureSummary || messageRetryDetail,
    stalled: activity?.stalled === true,
  })
  const shouldShowStatusNotice = Boolean(statusNoticeTitle)

  return (
    <article className="group relative flex flex-col gap-3">
      <div className="flex items-start gap-4">
        <div className="mt-0.5 h-8 w-8 shrink-0 flex items-center justify-center rounded-lg bg-[rgba(69,119,108,0.05)] border border-[rgba(69,119,108,0.08)] text-[var(--accent-soft-strong)]">
          <Bot size={16} />
        </div>

        <div className="min-w-0 flex-1 flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-12px text-[var(--text-secondary)]">
            <span className="font-600 text-[var(--text-primary)] opacity-40">Aura</span>
            {activitySummary ? (
              <div className="relative group/activity">
                <button
                  className="inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 hover:bg-[rgba(15,23,42,0.04)] transition-opacity opacity-60 hover:opacity-100"
                  onClick={() => onToggleActivity(message.id)}
                // title={activity?.expanded ? '折叠执行详情' : '展开执行详情'}
                >
                  <Brain size={12} className="opacity-70" />
                  <span
                    className="rounded-full border border-[rgba(15,23,42,0.06)] px-0 py-0.5 text-11px font-600 text-[var(--text-secondary)] opacity-90"
                    title={
                      message.modelInfo
                        ? `${message.modelInfo.providerProfileName} · ${message.modelInfo.modelId}`
                        : messageModelLabel
                    }
                  >
                    {messageModelLabel}
                  </span>
                  <span>{activitySummary}</span>
                  {isStreaming ? <RetryStatusDots /> : null}
                  {activity?.expanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                </button>
                {hasUsedCapabilities ? (
                  <div className="absolute left-0 top-full pt-2 z-30 w-max min-w-[14rem] max-w-[20rem] opacity-0 invisible -translate-y-1.5 group-hover/activity:opacity-100 group-hover/activity:visible group-hover/activity:translate-y-0 transition-all duration-200 ease-out origin-top-left">
                    <div className="relative rounded-[16px] border border-[rgba(15,23,42,0.08)] bg-white px-4 py-3.5 text-left shadow-[0_16px_40px_-8px_rgba(0,0,0,0.15)] ring-1 ring-black/[0.03]">
                      <svg className="absolute left-5 -top-[5.5px] text-white drop-shadow-[0_-1px_1px_rgba(15,23,42,0.06)]" width="12" height="6" viewBox="0 0 12 6" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
                        <path d="M6 0L12 6H0L6 0Z" />
                      </svg>
                      <div className="mb-2.5 flex items-center justify-between gap-1.5 border-b border-[rgba(15,23,42,0.06)] pb-2">
                        <div className="text-[10px] font-800 uppercase tracking-[0.1em] text-[var(--accent-soft-strong)] opacity-90">
                          执行明细
                        </div>
                        <span className="rounded-full bg-[rgba(15,23,42,0.04)] px-1.5 py-[1px] text-[9px] font-700 text-[var(--text-secondary)] opacity-70">
                          {invokedCount} 项
                        </span>
                      </div>
                      <div className="flex flex-col gap-1.5">
                        {invokedToolsGroups.map(group => (
                          <details key={group.label} open className="group/details">
                            <summary className="cursor-pointer list-none flex items-center justify-between mb-1.5 opacity-80 hover:opacity-100 transition-opacity">
                              <span className="text-[10px] font-700 uppercase tracking-widest text-[var(--text-secondary)]">
                                {group.label}
                              </span>
                              <ChevronDown size={12} className="text-[var(--text-secondary)] transition-transform group-open/details:rotate-180" />
                            </summary>
                            <div className="flex flex-wrap gap-1.5 mb-1 last:mb-0">
                              {group.items.map(name => (
                                <span
                                  key={`${group.type}-${name}`}
                                  className="inline-flex items-center gap-1.5 rounded-lg bg-[rgba(15,23,42,0.025)] border border-[rgba(15,23,42,0.05)] px-2.5 py-1 text-[11px] font-500 text-[var(--text-primary)]"
                                >
                                  <span className="text-[9px] font-600 text-[var(--text-secondary)] opacity-60 uppercase tracking-wider">{group.type}</span>
                                  {name}
                                </span>
                              ))}
                            </div>
                          </details>
                        ))}
                      </div>
                    </div>
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>

          {shouldShowDetailedTimeline ? (
            <section className="rounded-xl border border-[rgba(15,23,42,0.06)] bg-[rgba(15,23,42,0.018)] px-3.5 py-3">
              <ExecutionTraceHeader
                itemCount={executionTraceGroups.length}
                visibleCount={visibleExecutionTraceGroups.length}
                expanded={executionTraceExpanded}
                canToggle={executionTraceGroups.length > 1}
                onToggle={() => setExecutionTraceExpanded(current => !current)}
              />
              <div className="flex flex-col gap-4 border-l border-[rgba(15,23,42,0.08)] pl-3">
                {visibleExecutionTraceGroups.map(group => {
                  const primaryNarrative = group.narratives[0]
                  const extraNarratives = group.narratives.slice(1)
                  const isGroupActive =
                    isStreaming &&
                    group.narratives.some(narrative => narrative.sourceId === latestReasoningId)

                  return (
                    <div key={group.key} className="stream-reveal-item">
                      {primaryNarrative ? (
                        <ExecutionNarrativeCard
                          narrative={primaryNarrative}
                          extraNarratives={extraNarratives}
                          isActive={isGroupActive}
                        />
                      ) : null}
                      {group.items.length > 0 ? (
                        <div className={`${primaryNarrative ? 'mt-2 ' : ''}flex flex-col gap-2`}>
                          {group.items.map(item =>
                            item.kind === 'phase_output' ? (
                              <PhaseOutputCard
                                key={item.key}
                                content={item.output.content}
                                label={phaseOutputLabel(item.output)}
                              />
                            ) : item.kind === 'event' ? (
                              <MessageEventCard
                                key={item.key}
                                event={item.event}
                                onHandleApproval={onHandleApproval}
                                onCancelCurrentStep={onCancelCurrentStep}
                                onCopyText={onCopyText}
                              />
                            ) : null,
                          )}
                        </div>
                      ) : null}
                    </div>
                  )
                })}
              </div>
            </section>
          ) : null}

          {shouldShowCompactDigest ? (
            <ExecutionDigest
              activity={activity}
              entries={executionDigestEntries}
            />
          ) : null}

          {message.deliveryNote ? (
            <div className="rounded-xl border border-[rgba(15,23,42,0.08)] bg-[rgba(15,23,42,0.02)] px-4 py-3 text-13px leading-relaxed text-[var(--text-secondary)]">
              {message.deliveryNote}
            </div>
          ) : null}

          {shouldShowAnswer && !shouldSuppressStreamingAnswerBody ? (
            isStreaming ? (
              <StreamingMarkdownAnswer content={message.content} onCopyText={onCopyText} bodyRef={answerBodyRef} />
            ) : (
              <MarkdownAnswer content={message.content} onCopyText={onCopyText} bodyRef={answerBodyRef} />
            )
          ) : isStreaming ? (
            null
          ) : null}

          {!isStreaming && finalChangeSummary.files.length > 0 ? (
            <FinalChangedFilesCard summary={finalChangeSummary} />
          ) : null}

          {shouldShowStatusNotice ? (
            <MessageStatusNotice
              tone={statusNoticeTone}
              title={statusNoticeTitle}
              detail={statusNoticeDetail}
              animateDetail={isStreaming}
            />
          ) : null}

          {appendedInputs.length > 0 ? (
            <AppendedInputsPanel
              inputs={appendedInputs}
              messageId={message.id}
              isStreaming={isStreaming}
              onForceExecute={onForceExecuteAppendedInput}
            />
          ) : null}

          <div className="flex items-center justify-end pt-1">
            <div className="flex items-center gap-2">
              <div className="flex items-center gap-1 rounded-xl border border-[rgba(15,23,42,0.06)] bg-white/88 p-1 opacity-0 shadow-sm backdrop-blur-md transition-all group-hover:opacity-100">
                {messageTimeLabel ? (
                  <span className="px-1.5 text-11px text-[var(--text-secondary)] opacity-80">
                    {messageTimeLabel}
                  </span>
                ) : null}
                <button
                  className="p-1.5 rounded-md hover:bg-[rgba(0,0,0,0.05)] text-[var(--text-secondary)] disabled:opacity-40 disabled:cursor-not-allowed"
                  title="复制富文本"
                  aria-label="复制富文本"
                  disabled={!canCopyAnswer}
                  onClick={() => copyMarkdownAnswer(message.content, answerBodyRef.current, onCopyText)}
                >
                  <Copy size={14} />
                </button>
                <button
                  className="p-1.5 rounded-md hover:bg-[rgba(0,0,0,0.05)] text-[var(--text-secondary)]"
                  title="编辑为新提示"
                  disabled={isStreaming}
                  onClick={() => onEditMessage(message.id)}
                >
                  <Pencil size={14} />
                </button>
                <button
                  className="p-1.5 rounded-md hover:bg-[rgba(0,0,0,0.05)] text-[var(--text-secondary)]"
                  title="重新生成"
                  disabled={isStreaming}
                  onClick={() => onRegenerateMessage(message.id)}
                >
                  <RefreshCw size={14} />
                </button>
                <MessageOverflowMenu
                  messageId={message.id}
                  onDeleteMessage={onDeleteMessage}
                  extraActions={[
                    ...answerExportActions,
                    ...identifierActions,
                    {
                      key: 'switch-model-regenerate',
                      label: '切换模型重新回答',
                      icon: LayoutGrid,
                      disabled: isStreaming,
                      onClick: () => setModelDialogOpen(true),
                    },
                    {
                      key: 'message-usage',
                      label: '用量',
                      icon: Sparkles,
                      disabled: !hasUsage,
                      closeMenuOnClick: false,
                      panel: <MessageUsagePopover usage={message.usage} />,
                    },
                  ]}
                />
                <MessageVersionSwitcher
                  message={message}
                  align="left"
                  onSelectVersion={onSelectMessageVersion}
                />
              </div>
            </div>
          </div>
        </div>
      </div>
      {modelDialogOpen ? (
        <ModelPickerDialog
          title="切换模型重新回答"
          description="选择一个模型后，Aura 会基于同一条用户问题重新生成这一版回答。"
          modelGroups={modelGroups}
          activeProfileId={messageModelProfileId}
          activeModelId={messageModelId}
          onClose={() => setModelDialogOpen(false)}
          onSelect={(profileId, modelId) => {
            setModelDialogOpen(false)
            onRegenerateMessageWithModel(message.id, profileId, modelId)
          }}
        />
      ) : null}
    </article>
  )
}

function UserMessageCard({
  message,
  onCopyText,
  onEditMessage,
  onDeleteMessage,
  onSelectMessageVersion,
  onResend,
  onOpenAttachment,
}: {
  message: ChatMessage
  onCopyText: CopyTextHandler
  onEditMessage: (messageId: string) => void
  onDeleteMessage: (messageId: string) => void
  onSelectMessageVersion: (messageId: string, nextIndex: number) => void
  onResend: (messageId: string) => void
  onOpenAttachment: (path: string) => void
}) {
  const messageTimeLabel = formatConversationTimestamp(message.createdAt)
  const identifierActions = [
    {
      key: 'copy-message-id',
      label: '复制 message_id',
      icon: Copy,
      onClick: () => onCopyText(message.id),
    },
  ]

  return (
    <article className="group flex flex-col items-end gap-2">
      {message.attachments?.length ? (
        <div className="flex max-w-[78%] flex-wrap justify-end gap-2">
          {message.attachments.map((attachment: MessageAttachment) => (
            <button
              key={attachment.id}
              className="inline-flex min-w-0 items-center gap-3 rounded-2xl border border-[rgba(15,23,42,0.08)] bg-white px-3 py-2 text-left shadow-sm"
              onClick={() => onOpenAttachment(attachment.path)}
              title={attachment.path}
            >
              <AttachmentThumbnail
                attachment={attachment}
                alt={attachment.name}
                className="h-10 w-10 shrink-0 rounded-xl object-cover border border-[rgba(15,23,42,0.06)]"
                fallbackClassName="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-[rgba(15,23,42,0.06)] bg-[rgba(15,23,42,0.03)] text-[var(--text-secondary)]"
              />
              <span className="max-w-220px truncate text-13px font-600 text-[var(--text-primary)]">
                {attachment.name}
              </span>
            </button>
          ))}
        </div>
      ) : null}
      <div className="max-w-[78%] bg-[var(--bg-user-bubble)] text-[var(--text-user-bubble)] px-5 py-3 rounded-2xl rounded-tr-8px shadow-[0_10px_30px_rgba(60,87,78,0.10)] text-15px leading-relaxed">
        {message.content}
      </div>
      <div className="flex items-center gap-2">
        <div className="flex items-center gap-1 rounded-xl border border-[rgba(15,23,42,0.06)] bg-white/90 p-1 opacity-0 shadow-sm backdrop-blur-md transition-all group-hover:opacity-100">
          {messageTimeLabel ? (
            <span className="px-1.5 text-11px text-[var(--text-secondary)] opacity-80">
              {messageTimeLabel}
            </span>
          ) : null}
          <button className="p-1.5 rounded-md hover:bg-[rgba(0,0,0,0.05)] text-[var(--text-secondary)]" title="复制" onClick={() => onCopyText(message.content)}>
            <Copy size={14} />
          </button>
          <button className="p-1.5 rounded-md hover:bg-[rgba(0,0,0,0.05)] text-[var(--text-secondary)]" title="编辑" onClick={() => onEditMessage(message.id)}>
            <Pencil size={14} />
          </button>
          <button className="p-1.5 rounded-md hover:bg-[rgba(0,0,0,0.05)] text-[var(--text-secondary)]" title="重发" onClick={() => onResend(message.id)}>
            <RefreshCw size={14} />
          </button>
          <MessageOverflowMenu
            messageId={message.id}
            onDeleteMessage={onDeleteMessage}
            extraActions={identifierActions}
          />
          <MessageVersionSwitcher
            message={message}
            align="right"
            onSelectVersion={onSelectMessageVersion}
          />
        </div>
      </div>
    </article>
  )
}

export function ChatView({
  sessionId,
  messages,
  displayedToolEvents,
  displayedTaskTree,
  settings,
  contextCompression,
  draft,
  error,
  isRunning,
  agentTask,
  workspaceRootPath,
  workspaceTree,
  workspaceLoading,
  workspaceError,
  expandedPaths,
  selectedFilePath,
  previewContent,
  previewImage,
  previewLoading,
  previewError,
  canChangeWorkspace,
  inspectorWidth,
  attachments,
  capabilityItems,
  capabilitySnapshot,
  modelGroups,
  activeModelProfileId,
  researchMode,
  onDraftChange,
  onToggleResearchMode,
  onSetCapabilityOverride,
  onSubmit,
  onOpenProviders,
  onHandleApproval,
  onOpenWorkspaceExplorer,
  onChooseWorkspace,
  onPickAttachment,
  onPasteAttachments,
  onSelectModel,
  onSelectReasoningEffort,
  onOpenAttachment,
  onRemoveAttachment,
  onRefreshWorkspace,
  onToggleWorkspacePath,
  onSelectWorkspaceFile,
  onInsertFileReference,
  onInspectorWidthChange,
  onCopyPath,
  onCopyText,
  onEditMessage,
  onDeleteMessage,
  onSelectMessageVersion,
  onRegenerateMessage,
  onRegenerateMessageWithModel,
  onResendMessage,
  onForceExecuteAppendedInput,
  onCancelCurrentStep,
  onCompressContext,
  onToggleMessageActivity,
  onStop,
  contextCompressionRunning = false,
}: Props) {
  const [inspectorOpen, setInspectorOpen] = useState(false)
  const [capabilityPanelOpen, setCapabilityPanelOpen] = useState(false)
  const [modelMenuOpen, setModelMenuOpen] = useState(false)
  const [reasoningMenuOpen, setReasoningMenuOpen] = useState(false)
  const [modelSearchTerm, setModelSearchTerm] = useState('')
  const [collapsedModelGroups, setCollapsedModelGroups] = useState<Set<string>>(new Set())
  const [collapsedCapabilityGroups, setCollapsedCapabilityGroups] = useState<
    Set<'skill' | 'plugin' | 'mcp'>
  >(new Set(['skill', 'plugin', 'mcp']))
  const [lightboxAttachment, setLightboxAttachment] = useState<{
    name: string
    preview: string
  } | null>(null)
  const [autoScrollEnabled, setAutoScrollEnabled] = useState(true)

  const modelMenuRef = useRef<HTMLDivElement>(null)
  const reasoningMenuRef = useRef<HTMLDivElement>(null)
  const capabilityMenuRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  const scrollFollowKey = useMemo(() => {
    const lastMessage = messages.at(-1)
    if (!lastMessage) {
      return 'empty'
    }
    const eventSignal = (lastMessage.events || [])
      .map(
        event =>
          `${event.id}:${event.status}:${event.output?.length || 0}:${event.error?.length || 0}`,
      )
      .join('|')
    const reasoningSignal = (lastMessage.reasoning || [])
      .map(entry => `${entry.id}:${entry.content.length}`)
      .join('|')
    const phaseOutputSignal = (lastMessage.phaseOutputs || [])
      .map(output => `${output.id}:${output.content.length}`)
      .join('|')
    const appendedSignal = (lastMessage.appendedInputs || [])
      .map(input => `${input.id}:${input.status}:${input.content.length}`)
      .join('|')
    return [
      messages.length,
      lastMessage.id,
      lastMessage.content.length,
      lastMessage.status || '',
      eventSignal,
      reasoningSignal,
      phaseOutputSignal,
      appendedSignal,
      isRunning ? 'running' : 'idle',
    ].join(':')
  }, [isRunning, messages])
  function isNearBottom() {
    const container = scrollRef.current
    if (!container) {
      return true
    }
    return container.scrollHeight - (container.scrollTop + container.clientHeight) < 72
  }

  useEffect(() => {
    if (!autoScrollEnabled || !scrollRef.current) {
      return
    }
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight
  }, [autoScrollEnabled, scrollFollowKey])

  useEffect(() => {
    setAutoScrollEnabled(true)
  }, [messages.at(-1)?.id])

  useEffect(() => {
    if (!modelMenuOpen && !reasoningMenuOpen && !capabilityPanelOpen) return
    function handleClickOutside(event: MouseEvent) {
      if (modelMenuRef.current && !modelMenuRef.current.contains(event.target as Node)) {
        setModelMenuOpen(false)
      }
      if (
        reasoningMenuRef.current &&
        !reasoningMenuRef.current.contains(event.target as Node)
      ) {
        setReasoningMenuOpen(false)
      }
      if (
        capabilityMenuRef.current &&
        !capabilityMenuRef.current.contains(event.target as Node)
      ) {
        setCapabilityPanelOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [capabilityPanelOpen, modelMenuOpen, reasoningMenuOpen])

  const modelLabel =
    settings.model.split('/').filter(Boolean).at(-1) || settings.model || '选择模型'
  const selectedReasoningOption =
    reasoningEffortOptions.find(option => option.value === settings.reasoningEffort) ||
    reasoningEffortOptions[2]
  const deepResearchEnabled = researchMode === 'deep'
  const isMetaEnter = settings.sendShortcut === 'meta-enter'
  const composerMetaHint = settings.cwd
    ? isMetaEnter
      ? `⌘/Ctrl + Enter ${isRunning ? '补充当前任务' : '发送'}`
      : `Enter ${isRunning ? '补充当前任务' : '发送'}，Shift + Enter 换行`
    : '请设置工作区'
  const canSubmitComposer = Boolean(draft.trim() || attachments.length > 0)

  const hasInspectorContent = true

  useEffect(() => {
    if (workspaceError || previewError || selectedFilePath) {
      setInspectorOpen(true)
    }
  }, [previewError, selectedFilePath, workspaceError])

  const filteredModelGroups = modelGroups
    .map(group => ({
      ...group,
      models: group.models.filter(m =>
        m.id.toLowerCase().includes(modelSearchTerm.toLowerCase()) ||
        group.profileName.toLowerCase().includes(modelSearchTerm.toLowerCase())
      )
    }))
    .filter(group => group.models.length > 0)

  const enabledSkillSummary = useMemo(() => {
    if (!capabilitySnapshot || capabilitySnapshot.skills.length === 0) {
      return ''
    }
    return capabilitySnapshot.skills.map(skill => skill.name).join(' · ')
  }, [capabilitySnapshot])
  const manageableCapabilityCount = useMemo(
    () => capabilityItems.filter(item => item.effectiveEnabled).length,
    [capabilityItems],
  )
  const liveTaskStepsVisible =
    isRunning &&
    Boolean(agentTask) &&
    agentTask?.status !== 'completed' &&
    agentTask?.status !== 'failed'
  const liveTaskStepNodes = useMemo(() => {
    if (displayedTaskTree.length > 0) {
      return displayedTaskTree
    }
    return findLatestLiveAssistantSteps(messages)
  }, [displayedTaskTree, messages])

  const sessionUsage = useMemo(() => collectSessionUsage(messages), [messages])
  const sessionTotalTokens = sessionUsage.inputTokens + sessionUsage.outputTokens
  const latestMessageUsage = useMemo(() => findLatestUsage(messages), [messages])
  const liveContextCompression = agentTask?.contextCompression || contextCompression
  const autoCompressionRunning = agentTask?.phase === 'compressing_context'
  const sessionContextMessages = useMemo(
    () => buildRuntimeMessagesWithContextCompression(messages, liveContextCompression),
    [liveContextCompression, messages],
  )
  const sessionContextTokens = useMemo(
    () => estimateSessionContextTokens(sessionContextMessages, settings.model),
    [sessionContextMessages, settings.model],
  )
  const latestRouteDecision = useMemo(
    () => findLatestRouteDecision(messages, agentTask?.routeDecision),
    [agentTask?.routeDecision, messages],
  )
  const configuredContextWindowTokens = useMemo(
    () => resolveConfiguredContextWindowTokens(settings),
    [settings],
  )
  const promptContextFromRouteDecision =
    latestRouteDecision?.contextEstimate?.promptTokens || 0
  const promptEnvelopeTokens =
    latestRouteDecision?.contextEstimate?.promptEnvelopeTokens || 0
  const livePromptTokensFromUsage =
    Math.max(0, Math.round(Number(agentTask?.usage?.latestInputTokens) || 0))
  const persistedPromptTokensFromUsage = Math.max(
    0,
    Math.round(
      Number(
        latestMessageUsage?.latestInputTokens ||
        latestMessageUsage?.inputTokens ||
        0,
      ),
    ),
  )
  const promptContextWindowTokens =
    liveContextCompression?.contextWindowTokens ||
    latestMessageUsage?.contextWindow ||
    configuredContextWindowTokens ||
    latestRouteDecision?.contextEstimate?.contextWindowTokens ||
    DEFAULT_CONTEXT_WINDOW_TOKENS
  const localCurrentPromptContextTokens = sessionContextTokens + promptEnvelopeTokens
  const hasLocalPromptEnvelope = promptEnvelopeTokens > 0
  const currentPromptContextTokens =
    isRunning && livePromptTokensFromUsage > 0
      ? livePromptTokensFromUsage
      : localCurrentPromptContextTokens > 0 && hasLocalPromptEnvelope
        ? localCurrentPromptContextTokens
        : promptContextFromRouteDecision > 0
          ? promptContextFromRouteDecision
          : persistedPromptTokensFromUsage > 0
            ? persistedPromptTokensFromUsage
            : localCurrentPromptContextTokens

  function handleComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (isMetaEnter) {
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
        event.preventDefault()
        onSubmit()
      }
    } else {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault()
        onSubmit()
      }
    }
  }

  function handleComposerPaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    const clipboardFiles = Array.from(event.clipboardData.files || [])
    const itemFiles = Array.from(event.clipboardData.items || [])
      .filter(item => item.kind === 'file')
      .map(item => item.getAsFile())
      .filter((file): file is File => Boolean(file))

    const files = clipboardFiles.length > 0 ? clipboardFiles : itemFiles
    if (files.length === 0) {
      return
    }

    event.preventDefault()
    onPasteAttachments(files)
  }

  function handleMessageScroll() {
    setAutoScrollEnabled(isNearBottom())
  }

  function handleInspectorResizeStart(event: ReactMouseEvent<HTMLDivElement>) {
    event.preventDefault()
    const startX = event.clientX
    const startWidth = inspectorWidth

    function handleMouseMove(moveEvent: MouseEvent) {
      const delta = startX - moveEvent.clientX
      onInspectorWidthChange(Math.max(280, Math.min(640, startWidth + delta)))
    }

    function handleMouseUp() {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }

    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
  }

  return (
    <section className="flex-1 flex flex-col h-screen bg-[var(--bg-app)] relative overflow-hidden">
      <header
        className="relative h-12 border-b border-[var(--border-subtle)] px-4 flex items-center justify-center shrink-0"
        data-tauri-drag-region
      >
        <div className="absolute inset-0" data-tauri-drag-region />
        <div className="flex items-center gap-2 text-12px text-[var(--text-secondary)] opacity-60">
          <span>{messages.length} 条消息</span>
          <span>·</span>
          <button
            className="relative z-10 flex items-center gap-1 hover:text-[var(--text-primary)] cursor-pointer transition-colors bg-transparent border-none p-0 text-12px text-[var(--text-secondary)] opacity-100"
            title="复制 session_id"
            onClick={() => onCopyText(sessionId)}
            type="button"
          >
            <span>{sessionId}</span>
          </button>
          {/* <span>·</span>
          <button
            className="relative z-10 flex items-center gap-1 hover:text-[var(--text-primary)] cursor-pointer transition-colors bg-transparent border-none p-0 text-12px text-[var(--text-secondary)] opacity-100"
            title={settings.cwd || '未设置工作区'}
            onClick={() => {
              setInspectorOpen(true)
              onOpenWorkspaceExplorer()
            }}
          >
            <FolderOpen size={12} />
            {summarizePath(settings.cwd)}
          </button> */}
        </div>

        {hasInspectorContent && (
          <div className="absolute right-4 z-10">
            <button
              className={`p-1.5 rounded-md transition-colors ${inspectorOpen ? 'bg-[rgba(0,0,0,0.05)] text-[var(--text-primary)]' : 'text-[var(--text-secondary)] hover:bg-[rgba(0,0,0,0.03)]'}`}
              onClick={() => setInspectorOpen(current => !current)}
              title="运行详情"
            >
              <Eye size={14} />
            </button>
          </div>
        )}
      </header>

      <div className="flex-1 flex overflow-hidden">
        {/* Messages Stage */}
        <div className="flex-1 flex flex-col min-w-0 relative">
          {error ? (
            <div className="mx-auto mt-4 w-full max-w-980px px-8">
              <div className="rounded-2xl border border-red-100 bg-red-50 px-4 py-3 text-13px leading-relaxed text-red-600 shadow-sm">
                {error}
              </div>
            </div>
          ) : null}
          <div
            ref={scrollRef}
            className="flex-1 overflow-y-auto custom-scrollbar pt-8 pb-72 scroll-smooth"
            onScroll={handleMessageScroll}
          >
            {messages.length === 0 ? (
              <div className="max-w-1000px mx-auto px-6 py-20 flex flex-col items-center text-center">
                <h3 className="text-28px font-600 mb-2">你好，我是 Aura</h3>
                <p className="max-w-560px text-14px leading-relaxed text-[var(--text-secondary)] opacity-80">
                  你可以先选择当前会话的工作区，也可以直接发出第一条消息，Aura 会在默认工作目录下自动创建本会话的工作区。
                </p>
                <div className="mt-6 flex items-center gap-3">
                  <button
                    className="inline-flex items-center gap-2 rounded-xl border border-[rgba(79,123,116,0.18)] bg-white px-4 py-2.5 text-14px font-600 text-[var(--accent-soft-strong)] shadow-sm hover:bg-[rgba(79,123,116,0.05)]"
                    onClick={onChooseWorkspace}
                    type="button"
                  >
                    <FolderOpen size={16} />
                    <span>选择工作区</span>
                  </button>
                  {workspaceRootPath.trim() ? (
                    <div className="max-w-280px truncate rounded-full bg-[rgba(15,23,42,0.04)] px-3 py-1.5 text-12px text-[var(--text-secondary)]">
                      当前: {summarizePath(workspaceRootPath)}
                    </div>
                  ) : null}
                </div>
              </div>
            ) : (
              <div className="max-w-980px mx-auto px-8 flex flex-col gap-14">
                {messages.map(message =>
                  message.role === 'user' ? (
                    <UserMessageCard
                      key={message.id}
                      message={message}
                      onCopyText={onCopyText}
                      onEditMessage={onEditMessage}
                      onDeleteMessage={onDeleteMessage}
                      onSelectMessageVersion={onSelectMessageVersion}
                      onResend={onResendMessage}
                      onOpenAttachment={onOpenAttachment}
                    />
                  ) : (
                    <AssistantMessageCard
                      key={message.id}
                      message={message}
                      modelGroups={modelGroups}
                      activeModelProfileId={activeModelProfileId}
                      activeModelId={settings.model}
                      onCopyText={onCopyText}
                      onEditMessage={onEditMessage}
                      onDeleteMessage={onDeleteMessage}
                      onSelectMessageVersion={onSelectMessageVersion}
                      onRegenerateMessage={onRegenerateMessage}
                      onRegenerateMessageWithModel={onRegenerateMessageWithModel}
                      onForceExecuteAppendedInput={onForceExecuteAppendedInput}
                      showDetailedExecutionDetails={settings.showDetailedExecutionDetails}
                      onCancelCurrentStep={onCancelCurrentStep}
                      onHandleApproval={onHandleApproval}
                      onToggleActivity={onToggleMessageActivity}
                    />
                  ),
                )}
              </div>
            )}
          </div>

          {/* Docked Composer */}
          <div
            className="absolute bottom-0 left-0 right-0 p-6 bg-gradient-to-t from-[var(--bg-app)]/80 to-transparent pointer-events-none flex justify-center"
            data-chat-composer-root="true"
          >
            <div className="max-w-1000px w-full flex flex-col items-center">
              {!autoScrollEnabled && messages.length > 0 && (
                <button
                  className="mb-4 flex h-10 w-10 items-center justify-center rounded-full border border-[rgba(0,0,0,0.06)] bg-white/95 shadow-[0_8px_30px_rgb(0,0,0,0.12)] text-[var(--text-secondary)] hover:bg-white hover:scale-110 active:scale-95 transition-all pointer-events-auto backdrop-blur-md group"
                  onClick={() => {
                    if (scrollRef.current) {
                      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
                      setAutoScrollEnabled(true)
                    }
                  }}
                  title="回到最底部"
                >
                  <ArrowDown size={18} strokeWidth={2.5} className="text-[var(--text-secondary)] group-hover:text-[var(--accent-soft-strong)] transition-colors" />
                </button>
              )}

              <DockedTaskStepsPanel
                nodes={liveTaskStepNodes}
                visible={liveTaskStepsVisible}
              />

              <DockedAwaitingActionPanel
                task={agentTask}
                onHandleApproval={onHandleApproval}
              />

              <div className="w-full pointer-events-auto bg-white border border-solid border-[#4f7b7466] rounded-2xl shadow-lg shadow-[rgba(15,23,42,0.05)] transition-all ring-4 ring-offset-0 ring-[rgba(79,123,116,0.08)] !outline-none relative">
                <textarea
                  className="w-full h-120px p-4 text-15px leading-relaxed resize-none !border-none bg-transparent !outline-none !ring-0 !shadow-none"
                  value={draft}
                  onChange={event => onDraftChange(event.target.value)}
                  onKeyDown={handleComposerKeyDown}
                  onPaste={handleComposerPaste}
                  placeholder="在这里输入你的需求或问题..."
                />

                {attachments.length > 0 ? (
                  <div className="mx-3 mb-3 flex items-center gap-2 overflow-x-auto custom-scrollbar">
                    {attachments.map(attachment => (
                      <div
                        key={attachment.id}
                        className="group inline-flex min-w-0 items-center gap-3 rounded-full border border-[rgba(15,23,42,0.08)] bg-[rgba(15,23,42,0.02)] px-3 py-2"
                        title={attachment.path || attachment.name}
                      >
                        <button
                          className="min-w-0 inline-flex items-center gap-3 text-left"
                          onClick={() => {
                            if (attachment.preview) {
                              setLightboxAttachment({
                                name: attachment.name,
                                preview: attachment.preview,
                              })
                              return
                            }
                            if (attachment.path) {
                              onOpenAttachment(attachment.path)
                            }
                          }}
                          title={attachment.preview ? '预览图片' : '打开附件'}
                        >
                          <AttachmentThumbnail
                            attachment={attachment}
                            alt={attachment.name}
                            className="h-8 w-8 shrink-0 rounded-lg object-cover border border-[rgba(15,23,42,0.06)]"
                            fallbackClassName="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-[rgba(15,23,42,0.06)] bg-white text-[var(--text-secondary)]"
                            iconSize={14}
                          />
                          <span className="max-w-180px truncate text-13px font-600 text-[var(--text-primary)]">
                            {attachment.name}
                          </span>
                        </button>
                        <button
                          className="p-1 rounded-md hover:bg-[rgba(0,0,0,0.05)] text-[var(--text-secondary)] opacity-70"
                          title="移除附件"
                          onClick={() => onRemoveAttachment(attachment.id)}
                        >
                          <X size={13} />
                        </button>
                      </div>
                    ))}
                  </div>
                ) : null}

                <div className="h-10 px-3 border-t border-[var(--border-subtle)] bg-[rgba(0,0,0,0.01)] rounded-b-2xl flex items-center justify-between">
                  <div className="flex items-center gap-1">
                    <button className="p-1.5 rounded-md hover:bg-[rgba(0,0,0,0.05)] text-[var(--text-secondary)]" onClick={onPickAttachment} title="上传附件">
                      <Paperclip size={16} />
                    </button>
                    <button
                      className={`flex items-center gap-1.5 px-2 py-1 rounded-md transition-colors ${deepResearchEnabled
                        ? 'bg-[rgba(186,111,75,0.14)] text-[#9f4723]'
                        : 'hover:bg-[rgba(0,0,0,0.05)] text-[var(--text-secondary)]'
                        }`}
                      onClick={onToggleResearchMode}
                      title={
                        deepResearchEnabled
                          ? '已启用深度研究：更高搜索预算、更强推理强度、更多来源交叉验证'
                          : '启用深度研究'
                      }
                    >
                      <Telescope size={15} />
                      <span className="text-12px font-600">深度研究</span>
                    </button>
                    <div className="relative" ref={capabilityMenuRef}>
                      <button
                        className={`flex items-center gap-1.5 px-2 py-1 rounded-md transition-colors ${capabilityPanelOpen
                          ? 'bg-[rgba(79,123,116,0.10)] text-[var(--accent-soft-strong)]'
                          : 'hover:bg-[rgba(0,0,0,0.05)] text-[var(--text-secondary)]'
                          }`}
                        onClick={() =>
                          setCapabilityPanelOpen(current => {
                            const next = !current
                            if (next) {
                              setCollapsedCapabilityGroups(new Set())
                            }
                            return next
                          })
                        }
                        title="项目能力"
                      >
                        <Wrench size={15} />
                        <span className="text-12px font-600">
                          工具
                        </span>
                        {manageableCapabilityCount > 0 ? (
                          <span className="rounded-full bg-white px-1.5 py-0.5 text-10px text-[var(--text-secondary)]">
                            {manageableCapabilityCount}
                          </span>
                        ) : null}
                        <ChevronDown size={12} className="opacity-40" />
                      </button>

                      {capabilityPanelOpen ? (
                        <div className="absolute bottom-[calc(100%+10px)] left-0 z-20 w-[min(390px,calc(100vw-48px))] max-w-[390px]">
                          <CapabilityPanel
                            items={capabilityItems}
                            snapshot={capabilitySnapshot}
                            collapsedGroups={collapsedCapabilityGroups}
                            onToggleGroup={group =>
                              setCollapsedCapabilityGroups(current => {
                                const next = new Set(current)
                                if (next.has(group)) next.delete(group)
                                else next.add(group)
                                return next
                              })
                            }
                            onSetCapabilityOverride={onSetCapabilityOverride}
                          />
                        </div>
                      ) : null}
                    </div>
                    <div className="relative" ref={reasoningMenuRef}>
                      <button
                        className={`p-1.5 rounded-md transition-colors ${reasoningMenuOpen ? 'bg-[rgba(0,0,0,0.07)] text-[var(--text-primary)]' : 'hover:bg-[rgba(0,0,0,0.05)] text-[var(--text-secondary)]'}`}
                        onClick={() => setReasoningMenuOpen(current => !current)}
                        title={`推理强度：${selectedReasoningOption.label}`}
                      >
                        <SlidersHorizontal size={16} />
                      </button>

                      {reasoningMenuOpen ? (
                        <div className="absolute bottom-[calc(100%+10px)] left-0 z-20 w-300px overflow-hidden rounded-xl border border-[rgba(15,23,42,0.08)] bg-white/98 shadow-2xl shadow-[rgba(15,23,42,0.15)] backdrop-blur-xl">
                          <div className="border-b border-[rgba(15,23,42,0.05)] px-4 py-3">
                            <strong className="block text-14px font-700 text-[var(--text-primary)]">推理</strong>
                            <p className="mt-1 text-12px leading-relaxed text-[var(--text-secondary)]">
                              调整支持扩展思考模型的推理强度。
                            </p>
                          </div>
                          <div className="p-2">
                            {reasoningEffortOptions.map(option => {
                              const checked = option.value === settings.reasoningEffort
                              return (
                                <button
                                  key={option.value}
                                  className={`flex w-full items-start gap-3 rounded-xl px-3 py-3 text-left transition-colors ${checked ? 'bg-[rgba(79,123,116,0.08)]' : 'hover:bg-[rgba(15,23,42,0.03)]'}`}
                                  onClick={() => {
                                    onSelectReasoningEffort(option.value)
                                    setReasoningMenuOpen(false)
                                  }}
                                >
                                  <div className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-md border ${checked ? 'border-[var(--accent-soft-strong)] bg-[var(--accent-soft-strong)] text-white' : 'border-[rgba(15,23,42,0.12)] bg-white text-transparent'}`}>
                                    <Check size={12} />
                                  </div>
                                  <div className="flex min-w-0 flex-col">
                                    <span className="text-15px font-700 text-[var(--text-primary)]">{option.label}</span>
                                    <span className="text-12px leading-relaxed text-[var(--text-secondary)]">
                                      {option.description}
                                    </span>
                                  </div>
                                </button>
                              )
                            })}
                          </div>
                        </div>
                      ) : null}
                    </div>
                    <div className="h-4 w-1px bg-[var(--border-subtle)] mx-1" />
                    <div className="relative">
                      <button
                        className="flex items-center gap-1.5 px-2 py-1 rounded-md hover:bg-[rgba(0,0,0,0.05)] text-12px text-[var(--text-secondary)] transition-colors group"
                        onClick={() => {
                          setModelMenuOpen(current => !current)
                          setModelSearchTerm('')
                        }}
                        title="切换模型"
                      >
                        <LayoutGrid size={14} className="opacity-60" />
                        <span className="max-w-120px truncate font-600 text-[var(--text-primary)] opacity-70 group-hover:opacity-100">{modelLabel}</span>
                        <ChevronDown size={12} className="opacity-30" />
                      </button>

                      {modelMenuOpen ? (
                        <div
                          ref={modelMenuRef}
                          className="absolute bottom-[calc(100%+10px)] left-0 z-20 w-320px flex flex-col rounded-xl border border-[rgba(15,23,42,0.08)] bg-white/98 shadow-2xl shadow-[rgba(15,23,42,0.15)] backdrop-blur-xl overflow-hidden duration-200"
                        >
                          <div className="p-3 border-b border-[rgba(15,23,42,0.04)] bg-[rgba(15,23,42,0.01)]">
                            <div className="flex items-center gap-2.5 px-3 h-10 rounded-xl bg-white border border-[rgba(15,23,42,0.08)] shadow-sm focus-within:border-[var(--bg-user-bubble)]/60 focus-within:ring-4 focus-within:ring-[var(--bg-user-bubble)]/5 transition-all">
                              <Search size={14} className="text-[var(--text-secondary)] opacity-30" />
                              <input
                                autoFocus
                                className="flex-1 h-full !border-none !outline-none !ring-0 !shadow-none !bg-transparent appearance-none p-0 text-13px font-medium placeholder:opacity-30 placeholder:text-[var(--text-secondary)]"
                                placeholder="Search models..."
                                value={modelSearchTerm}
                                onChange={e => setModelSearchTerm(e.target.value)}
                              />
                            </div>
                          </div>

                          <div className="flex-1 overflow-y-auto custom-scrollbar min-h-260px max-h-360px px-1.5 pb-1.5 pt-1">
                            {filteredModelGroups.length > 0 ? (
                              <div className="flex flex-col">
                                {filteredModelGroups.map(group => {
                                  const isCollapsed = collapsedModelGroups.has(group.profileId)
                                  return (
                                    <div key={group.profileId} className="flex flex-col mb-1 last:mb-0">
                                      <button
                                        className="sticky top-0 z-10 px-3 py-2 flex items-center justify-between bg-white text-9px font-800 text-[rgba(15,23,42,0.4)] uppercase tracking-widest hover:bg-[rgba(15,23,42,0.02)] transition-colors rounded-lg group/head"
                                        onClick={() => {
                                          setCollapsedModelGroups(prev => {
                                            const next = new Set(prev)
                                            if (next.has(group.profileId)) next.delete(group.profileId)
                                            else next.add(group.profileId)
                                            return next
                                          })
                                        }}
                                      >
                                        <div className="flex items-center gap-2">
                                          {group.profileName}
                                          <span className="normal-case opacity-40 font-500 tracking-normal">{group.models.length} items</span>
                                        </div>
                                        <ChevronDown
                                          size={12}
                                          className={`transition-transform duration-200 opacity-40 group-hover/head:opacity-80 ${isCollapsed ? '-rotate-90' : ''}`}
                                        />
                                      </button>

                                      {!isCollapsed && (
                                        <div className="flex flex-col gap-0.5 mt-0.5">
                                          {group.models.map(model => {
                                            const isActive =
                                              group.profileId === activeModelProfileId &&
                                              model.id === settings.model
                                            const shortName = model.id.split('/').filter(Boolean).at(-1) || model.id

                                            return (
                                              <button
                                                key={model.id}
                                                className={`group/item flex items-center gap-3 rounded-xl px-2.5 py-2.5 text-left transition-all ${isActive
                                                  ? 'bg-[rgba(15,23,42,0.04)] ring-1 ring-[rgba(15,23,42,0.02)]'
                                                  : 'hover:bg-[rgba(15,23,42,0.04)]'
                                                  }`}
                                                onClick={() => {
                                                  onSelectModel(group.profileId, model.id)
                                                  setModelMenuOpen(false)
                                                }}
                                              >
                                                <div className="flex-shrink-0 w-4 flex flex-center">
                                                  {isActive ? <Check size={14} className="text-[var(--accent-soft-strong)]" strokeWidth={3} /> : null}
                                                </div>

                                                <div className="flex-1 min-w-0 flex flex-col gap-0.5">
                                                  <div className={`truncate text-13px font-700 tracking-tight leading-tight ${isActive ? 'text-[var(--text-primary)]' : 'text-[var(--text-primary)]'}`}>
                                                    {shortName}
                                                  </div>
                                                  <div className={`truncate text-11px tracking-tighter opacity-35 transition-opacity ${isActive ? 'text-[var(--text-secondary)] opacity-50' : 'text-[var(--text-secondary)]'}`}>
                                                    {model.id}
                                                  </div>
                                                </div>
                                              </button>
                                            )
                                          })}
                                        </div>
                                      )}
                                    </div>
                                  )
                                })}
                              </div>
                            ) : (
                              <div className="px-4 py-12 text-center flex flex-col items-center gap-3">
                                <Search size={28} className="opacity-5" />
                                <div className="text-12px text-[var(--text-secondary)] opacity-30">
                                  No models matching "{modelSearchTerm}"
                                </div>
                              </div>
                            )}
                          </div>
                        </div>
                      ) : null}
                    </div>
                    <ContextTokenMeter
                      currentTokens={currentPromptContextTokens}
                      cumulativeTokens={sessionTotalTokens}
                      contextWindowTokens={promptContextWindowTokens}
                      contextCompression={liveContextCompression}
                      compressionRunning={contextCompressionRunning || autoCompressionRunning}
                      compressionDisabled={contextCompressionRunning || isRunning}
                      onCompressContext={onCompressContext}
                    />
                  </div>

                  <div className="flex items-center gap-4">
                    <span className="text-11px text-[var(--text-secondary)] opacity-40 hidden sm:inline">{composerMetaHint}</span>
                    {isRunning ? (
                      <button
                        className="flex items-center justify-center p-1.5 rounded-lg text-red-500 border border-red-200 bg-red-50 hover:bg-red-100 transition-all"
                        title="停止生成"
                        onClick={onStop}
                        type="button"
                      >
                        <Square size={14} fill="currentColor" strokeWidth={0} />
                      </button>
                    ) : null}
                    <button
                      className={`flex items-center justify-center p-1.5 rounded-lg text-white transition-all ${isRunning
                        ? 'bg-[var(--accent-soft-strong)] hover:brightness-110 disabled:opacity-40 disabled:grayscale'
                        : 'bg-[var(--accent-soft-strong)] hover:brightness-110 disabled:opacity-40 disabled:grayscale'
                        }`}
                      title={isRunning ? '补充当前任务' : '发送'}
                      disabled={!canSubmitComposer}
                      onClick={onSubmit}
                      type="button"
                    >
                      <SendHorizontal size={18} />
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Inspector Panel */}
        {inspectorOpen && hasInspectorContent && (
          <>
            <div
              className="w-1 shrink-0 cursor-col-resize bg-transparent hover:bg-[rgba(79,123,116,0.18)] transition-colors"
              onMouseDown={handleInspectorResizeStart}
              title="拖动调整文件管理器宽度"
            />
            <aside
              className="border-l border-[var(--border-subtle)] bg-[rgba(0,0,0,0.01)] flex flex-col shrink-0 overflow-y-auto custom-scrollbar p-5 gap-6"
              style={{
                width: inspectorWidth,
                minWidth: inspectorWidth,
                maxWidth: inspectorWidth,
              }}
            >
              <WorkspaceExplorer
                rootPath={workspaceRootPath}
                tree={workspaceTree}
                loading={workspaceLoading}
                error={workspaceError}
                selectedFilePath={selectedFilePath}
                previewContent={previewContent}
                previewImage={previewImage}
                previewLoading={previewLoading}
                previewError={previewError}
                expandedPaths={expandedPaths}
                onRefresh={onRefreshWorkspace}
                onOpenRootPath={() => {
                  if (workspaceRootPath.trim()) {
                    onOpenAttachment(workspaceRootPath)
                  }
                }}
                onToggle={onToggleWorkspacePath}
                onSelectFile={onSelectWorkspaceFile}
                onInsertReference={onInsertFileReference}
                onCopyPath={onCopyPath}
              />
            </aside>
          </>
        )}
      </div>

      {lightboxAttachment ? (
        <div
          className="absolute inset-0 z-40 flex items-center justify-center bg-[rgba(15,23,42,0.55)] p-10 backdrop-blur-sm"
          onClick={() => setLightboxAttachment(null)}
        >
          <div className="relative max-h-full max-w-full rounded-2xl bg-white p-3 shadow-2xl">
            <button
              className="absolute right-3 top-3 rounded-full bg-white/90 p-2 text-[var(--text-secondary)] shadow-sm"
              onClick={() => setLightboxAttachment(null)}
              title="关闭预览"
            >
              <X size={16} />
            </button>
            <img
              src={lightboxAttachment.preview}
              alt={lightboxAttachment.name}
              className="max-h-[80vh] max-w-[80vw] rounded-xl object-contain"
            />
          </div>
        </div>
      ) : null}
    </section>
  )
}
