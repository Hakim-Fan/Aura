import {
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  ArrowDown,
  Bot,
  Brain,
  Check,
  ChevronDown,
  ChevronUp,
  Copy,
  Eye,
  FolderOpen,
  LayoutGrid,
  Paperclip,
  Pencil,
  RefreshCw,
  Search,
  SendHorizontal,
  SlidersHorizontal,
  Sparkles,
  Square,
  Wrench,
  X,
} from 'lucide-react'
import { WorkspaceExplorer } from '../components/WorkspaceExplorer'
import { TaskTreeView } from '../components/TaskTreeView'
import type {
  AgentSettings,
  AgentTaskSnapshot,
  CapabilityOverrideMode,
  CapabilityPanelItem,
  CapabilityUsageSnapshot,
  ChatMessage,
  MessageAttachment,
  MessageEvent,
  MessageReasoning,
  ProviderMode,
  ReasoningEffort,
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

type Props = {
  messages: ChatMessage[]
  displayedToolEvents: ToolEvent[]
  displayedTaskTree: TaskNode[]
  settings: AgentSettings
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
  onDraftChange: (value: string) => void
  onSetCapabilityOverride: (
    kind: 'skills' | 'plugins' | 'mcp',
    id: string,
    mode: CapabilityOverrideMode,
  ) => void
  onSubmit: () => void
  onOpenProviders: () => void
  onHandleApproval: (decision: 'approve' | 'deny') => void
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
  onCopyText: (value: string) => void
  onEditMessage: (messageId: string) => void
  onRegenerateMessage: (messageId: string) => void
  onResendMessage: (messageId: string) => void
  onToggleMessageActivity: (messageId: string) => void
  onStop: () => void
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

function estimateTokenCount(value: string) {
  const trimmed = value.trim()
  if (!trimmed) {
    return 0
  }
  return Math.ceil(trimmed.length / 2.2)
}

function formatTokenCount(value: number) {
  if (value >= 1000) {
    return `${(value / 1000).toFixed(1)}k`
  }
  return String(value)
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

function activityStatusLabel(status?: string) {
  switch (status) {
    case 'queued':
      return '准备执行'
    case 'running':
      return '思考中'
    case 'awaiting_approval':
      return '等待审批'
    case 'completed':
      return '已完成'
    case 'failed':
      return '执行失败'
    default:
      return '空闲'
  }
}

function eventKindLabel(event: MessageEvent) {
  switch (event.kind) {
    case 'shell':
      return '命令'
    case 'skill':
      return '技能'
    case 'approval':
      return '审批'
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
    case 'error':
      return '失败'
    default:
      return '成功'
  }
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
    return event.source === 'plugin' ? '技能' : '工具'
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

function MarkdownAnswer({
  content,
  onCopyText,
}: {
  content: string
  onCopyText: (value: string) => void
}) {
  return (
    <div className="markdown-body">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) => (
            <a className="text-[var(--bg-user-bubble)] hover:underline" href={href} target="_blank" rel="noreferrer">
              {children}
            </a>
          ),
          code: ({ className, children, ...props }) => {
            const raw = String(children).replace(/\n$/, '')
            const language = className?.replace('language-', '') || 'code'
            const isBlock = className?.startsWith('language-') || raw.includes('\n')

            if (!isBlock) {
              return (
                <code className="inline-code" {...props}>
                  {children}
                </code>
              )
            }

            return (
              <div className="markdown-codeblock">
                <div className="markdown-codeblock-head">
                  <span>{language}</span>
                  <button className="p-1 rounded hover:bg-[rgba(0,0,0,0.05)] text-[var(--text-secondary)]" title="复制代码" onClick={() => onCopyText(raw)}>
                    <Copy size={12} />
                  </button>
                </div>
                <pre>
                  <code {...props}>{raw}</code>
                </pre>
              </div>
            )
          },
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  )
}

function summarizeReasoningPreview(content: string) {
  const firstLine = content
    .split('\n')
    .map(line => line.trim())
    .find(Boolean)

  if (!firstLine) {
    return '正在整理这一阶段的思路。'
  }

  return firstLine.length > 96 ? `${firstLine.slice(0, 96)}...` : firstLine
}

function buildExecutionTimeline(
  reasoningEntries: MessageReasoning[],
  events: MessageEvent[],
) {
  const reasoningTimeline = reasoningEntries.map((entry, index) => ({
    key: `reasoning-${entry.id}`,
    kind: 'reasoning' as const,
    order: typeof entry.order === 'number' ? entry.order : index * 2,
    phaseIndex: index + 1,
    originalIndex: index,
    entry,
  }))

  const eventTimeline = events.map((event, index) => ({
    key: `event-${event.id}`,
    kind: 'event' as const,
    order: typeof event.order === 'number' ? event.order : index * 2 + 1,
    originalIndex: index,
    event,
  }))

  return [...reasoningTimeline, ...eventTimeline].sort((left, right) => {
    if (left.order !== right.order) {
      return left.order - right.order
    }
    if (left.kind !== right.kind) {
      return left.kind === 'reasoning' ? -1 : 1
    }
    return left.originalIndex - right.originalIndex
  })
}

function ReasoningPhaseCard({
  content,
  isActive,
}: {
  content: string
  isActive: boolean
}) {
  const [expanded, setExpanded] = useState(isActive)
  const previousActiveRef = useRef(isActive)
  const trimmedContent = content.trim()
  const firstLine = trimmedContent
    .split('\n')
    .map(line => line.trim())
    .find(Boolean) || summarizeReasoningPreview(trimmedContent)
  const remainingContent = trimmedContent.startsWith(firstLine)
    ? trimmedContent.slice(firstLine.length).trimStart()
    : trimmedContent

  useEffect(() => {
    if (isActive) {
      setExpanded(true)
    } else if (previousActiveRef.current && !isActive) {
      setExpanded(false)
    }
    previousActiveRef.current = isActive
  }, [isActive])

  return (
    <article className="rounded-xl border border-[rgba(79,123,116,0.10)] bg-[rgba(79,123,116,0.05)] px-3 py-2.5">
      <button
        className="flex w-full items-start justify-between gap-3 text-left"
        onClick={() => setExpanded(current => !current)}
        type="button"
      >
        <div className="min-w-0">
          <div className="mb-1 flex items-center gap-2">
            <span className="text-9px font-700 tracking-wider uppercase px-1.5 py-0.5 min-w-12 text-center rounded bg-white/80 text-[var(--accent-soft-strong)]">
              {isActive ? '思考中' : '思考'}
            </span>
            <strong className="text-12px text-[var(--text-primary)] opacity-85">{firstLine}</strong>
            {/* <span className="text-10px text-[var(--text-secondary)] opacity-55">
              {isActive ? '思考中' : ''}
            </span> */}
          </div>
        </div>
        {expanded ? (
          <ChevronUp size={14} className="mt-0.5 shrink-0 text-[var(--text-secondary)] opacity-60" />
        ) : (
          <ChevronDown size={14} className="mt-0.5 shrink-0 text-[var(--text-secondary)] opacity-60" />
        )}
      </button>
      {expanded && remainingContent ? (
        <div className="mt-2 text-12px leading-relaxed whitespace-pre-wrap text-[var(--text-secondary)] opacity-80">
          {remainingContent}
        </div>
      ) : null}
    </article>
  )
}

function MessageEventCard({
  event,
  onHandleApproval,
}: {
  event: MessageEvent
  onHandleApproval?: (decision: 'approve' | 'deny') => void
}) {
  const isShellLog = event.kind === 'shell'
  const hasShellDetails = isShellLog && (event.input || event.output || event.error)
  const isApproval = event.kind === 'approval' && event.status === 'awaiting_approval'

  return (
    <article className="rounded-xl border border-[rgba(15,23,42,0.05)] bg-[rgba(15,23,42,0.02)] px-3 py-2">
      <div className="mb-1 flex items-start justify-between gap-3">
        <div className="min-w-0 flex items-center gap-2">
          <span
            className={`text-9px font-700 tracking-wider uppercase px-1.5 py-0.5 rounded ${event.status === 'error'
              ? 'bg-red-50 text-red-500'
              : event.status === 'awaiting_approval'
                ? 'bg-amber-50 text-amber-600'
                : 'bg-gray-100 text-gray-500'
              }`}
          >
            {eventKindLabel(event)}
          </span>
          <strong className="text-12px text-[var(--text-primary)] opacity-80 leading-tight">{event.title}</strong>
        </div>
        <span
          className={`shrink-0 text-10px font-500 ${event.status === 'error'
            ? 'text-red-500'
            : event.status === 'awaiting_approval'
              ? 'text-amber-600'
              : 'text-green-600'
            }`}
        >
          {eventStatusLabel(event.status)}
        </span>
      </div>
      <p className="text-12px leading-relaxed text-[var(--text-secondary)] opacity-75">{event.summary}</p>
      {isApproval ? (
        <div className="mt-2 rounded-xl border border-amber-200 bg-white p-3">
          {event.input ? (
            <pre className="overflow-x-auto rounded-lg border border-gray-100 bg-gray-50 p-3 text-11px">
              {event.input}
            </pre>
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
              允许
            </button>
          </div>
        </div>
      ) : null}
      {hasShellDetails ? (
        <div className="mt-2 rounded-xl border border-[rgba(15,23,42,0.06)] bg-[#f4f4f5] p-3">
          {event.input ? (
            <div className="mb-2 font-[SFMono-Regular,Menlo,monospace] text-12px text-[var(--text-primary)]">
              {event.input}
            </div>
          ) : null}
          {event.output ? (
            <pre className="max-h-260px overflow-auto whitespace-pre-wrap break-words font-[SFMono-Regular,Menlo,monospace] text-12px leading-6 text-[#52525b]">
              {event.output}
            </pre>
          ) : event.status === 'running' ? (
            <div className="font-[SFMono-Regular,Menlo,monospace] text-12px text-[#71717a]">
              正在等待命令输出...
            </div>
          ) : null}
          {event.error ? (
            <pre className="mt-2 max-h-180px overflow-auto whitespace-pre-wrap break-words font-[SFMono-Regular,Menlo,monospace] text-12px leading-6 text-red-600">
              {event.error}
            </pre>
          ) : null}
        </div>
      ) : null}
      {!isApproval && (!isShellLog || event.error) && (event.input || event.output || event.error) && (
        <details className="mt-1.5 group" open={!isShellLog && event.status === 'error'}>
          <summary className="text-11px text-[var(--text-secondary)] cursor-pointer hover:text-[var(--text-primary)] transition-colors opacity-55">显示详细信息</summary>
          <div className="mt-2 flex flex-col gap-3 rounded-lg border border-[rgba(15,23,42,0.05)] bg-white/85 p-3">
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

function CapabilitySnapshotCard({
  snapshot,
}: {
  snapshot: CapabilityUsageSnapshot
}) {
  const sections = [
    { key: 'skills', label: 'Skills', items: snapshot.skills },
    { key: 'plugins', label: 'Plugins', items: snapshot.plugins },
    { key: 'mcp', label: 'MCP', items: snapshot.mcpServers },
  ]

  return (
    <details className="rounded-xl border border-[rgba(15,23,42,0.05)] bg-[rgba(15,23,42,0.02)] px-3 py-2">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <span className="rounded-full bg-[rgba(79,123,116,0.10)] px-2 py-0.5 text-9px font-700 uppercase tracking-wider text-[var(--accent-soft-strong)]">
            能力
          </span>
          <span className="text-12px text-[var(--text-secondary)]">
            {[
              snapshot.skills.length > 0 ? `Skills ${snapshot.skills.length}` : null,
              snapshot.plugins.length > 0 ? `Plugins ${snapshot.plugins.length}` : null,
              snapshot.mcpServers.length > 0 ? `MCP ${snapshot.mcpServers.length}` : null,
            ]
              .filter(Boolean)
              .join(' · ') || '本轮未启用额外能力'}
          </span>
        </div>
        <ChevronDown size={14} className="text-[var(--text-secondary)] opacity-60" />
      </summary>
      <div className="mt-3 flex flex-col gap-3">
        {sections.map(section => (
          <div key={section.key}>
            <div className="mb-1 text-10px font-700 uppercase tracking-wider text-[var(--text-secondary)] opacity-55">
              {section.label}
            </div>
            {section.items.length > 0 ? (
              <div className="flex flex-wrap gap-2">
                {section.items.map(item => (
                  <span
                    key={`${section.key}-${item.id}`}
                    className="rounded-full border border-[rgba(15,23,42,0.08)] bg-white px-2.5 py-1 text-11px text-[var(--text-primary)]"
                  >
                    {item.name}
                  </span>
                ))}
              </div>
            ) : (
              <div className="text-12px text-[var(--text-secondary)] opacity-60">未启用</div>
            )}
          </div>
        ))}
      </div>
    </details>
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

  function resolveNextOverrideMode(item: CapabilityPanelItem) {
    const nextEffectiveEnabled = !item.effectiveEnabled
    if (nextEffectiveEnabled === item.globalEnabled) {
      return 'inherit' as const
    }
    return nextEffectiveEnabled ? ('on' as const) : ('off' as const)
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
              生效 {snapshot.skills.length + snapshot.plugins.length + snapshot.mcpServers.length}
            </div>
          ) : null}
        </div>
      </div>

      <div className="max-h-[420px] overflow-y-auto custom-scrollbar p-2">
        {sections.map(section => {
          const sectionItems = items.filter(item => item.kind === section.key)
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

function AssistantMessageCard({
  message,
  onCopyText,
  onEditMessage,
  onRegenerateMessage,
  onHandleApproval,
  onToggleActivity,
}: {
  message: ChatMessage
  onCopyText: (value: string) => void
  onEditMessage: (messageId: string) => void
  onRegenerateMessage: (messageId: string) => void
  onHandleApproval: (decision: 'approve' | 'deny') => void
  onToggleActivity: (messageId: string) => void
}) {
  const activity = message.activity
  const duration = activity ? (activity.finishedAt || Date.now()) - activity.startedAt : undefined
  const visibleSteps = sanitizeTaskNodes(message.steps || [], message.content)
  const visibleReasoning = (message.reasoning || []).filter(entry =>
    normalizeComparableText(entry.content),
  )
  const providerReasoning = visibleReasoning.filter(entry => entry.kind === 'provider')
  const displayReasoning =
    providerReasoning.length > 0
      ? providerReasoning
      : visibleReasoning.filter(entry => entry.kind === 'summary')
  const executionTimeline = buildExecutionTimeline(displayReasoning, message.events || [])
  const latestReasoningId = displayReasoning.at(-1)?.id || ''
  const hasExecution =
    Boolean(activity) ||
    (message.events?.length || 0) > 0 ||
    visibleSteps.length > 0 ||
    visibleReasoning.length > 0
  const isStreaming = message.status === 'pending' || message.status === 'streaming'
  const activitySummary = activity
    ? [
      activityStatusLabel(activity.status),
      duration ? formatDuration(duration) : null,
      activity.toolCount > 0 ? `${activity.toolCount} 个工具` : null,
      activity.skillCount > 0 ? `${activity.skillCount} 个技能` : null,
      activity.stepCount > 0 ? `${activity.stepCount} 个步骤` : null,
    ]
      .filter(Boolean)
      .join(' · ')
    : null

  return (
    <article className="group relative flex flex-col gap-3">
      <div className="flex items-start gap-4">
        <div className="mt-0.5 h-8 w-8 shrink-0 flex items-center justify-center rounded-lg bg-[rgba(69,119,108,0.05)] border border-[rgba(69,119,108,0.08)] text-[var(--accent-soft-strong)]">
          <Bot size={16} />
        </div>

        <div className="min-w-0 flex-1 flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-12px text-[var(--text-secondary)] opacity-60">
            <span className="font-600 text-[var(--text-primary)] opacity-70">Aura</span>
            {activitySummary ? (
              <button
                className="inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 hover:bg-[rgba(15,23,42,0.04)] transition-colors"
                onClick={() => onToggleActivity(message.id)}
                title={activity?.expanded ? '折叠执行详情' : '展开执行详情'}
              >
                <Brain size={12} className="opacity-70" />
                <span>{activitySummary}</span>
                {activity?.expanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
              </button>
            ) : null}
          </div>

          {hasExecution && activity?.expanded ? (
            <section className="flex flex-col gap-3 border-l border-[rgba(15,23,42,0.08)] pl-4">
              <div className="flex flex-col gap-2.5">
                {executionTimeline.map(item =>
                  item.kind === 'reasoning' ? (
                    <ReasoningPhaseCard
                      key={item.key}
                      content={item.entry.content}
                      isActive={isStreaming && item.entry.id === latestReasoningId}
                    />
                  ) : (
                    <MessageEventCard
                      key={item.key}
                      event={item.event}
                      onHandleApproval={onHandleApproval}
                    />
                  ),
                )}
                {visibleSteps.length > 0 ? (
                  <div className="rounded-xl border border-[rgba(15,23,42,0.05)] bg-[rgba(15,23,42,0.02)] px-3 py-2.5">
                    <TaskTreeView nodes={visibleSteps} />
                  </div>
                ) : null}
              </div>
            </section>
          ) : null}

          {message.error ? (
            <div className="rounded-xl border border-red-100 bg-red-50 px-4 py-2 text-13px text-red-500">
              {message.error}
            </div>
          ) : null}

          {message.content ? (
            <MarkdownAnswer content={message.content} onCopyText={onCopyText} />
          ) : !isStreaming ? (
            <div className="rounded-xl border border-dashed border-[rgba(15,23,42,0.08)] bg-[rgba(15,23,42,0.02)] px-4 py-3 text-13px text-[var(--text-secondary)]">
              {(message.events?.length || 0) > 0
                ? '模型执行了操作，但没有生成最终总结回答。'
                : providerReasoning.length > 0
                  ? '模型在思考中计划了后续动作，但没有成功形成最终回答。'
                  : '模型执行了操作，但没有生成最终总结回答。'}
            </div>
          ) : (
            <div className="flex items-center gap-2 text-13px text-[var(--text-secondary)] opacity-50 italic">
              <span className="w-2 h-2 rounded-full bg-[var(--accent-soft-strong)] animate-pulse" />
              正在整理信息并生成最终回答...
            </div>
          )}

          <div className="flex items-center justify-end pt-1">
            <div className="flex items-center gap-1 rounded-xl border border-[rgba(15,23,42,0.06)] bg-white/88 p-1 opacity-0 shadow-sm backdrop-blur-md transition-all group-hover:opacity-100">
              <button
                className="p-1.5 rounded-md hover:bg-[rgba(0,0,0,0.05)] text-[var(--text-secondary)]"
                title="复制"
                onClick={() => onCopyText(message.content)}
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
            </div>
          </div>
        </div>
      </div>
    </article>
  )
}

function UserMessageCard({
  message,
  onCopyText,
  onEditMessage,
  onResend,
  onOpenAttachment,
}: {
  message: ChatMessage
  onCopyText: (value: string) => void
  onEditMessage: (messageId: string) => void
  onResend: (messageId: string) => void
  onOpenAttachment: (path: string) => void
}) {
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
              {attachment.preview ? (
                <img
                  src={attachment.preview}
                  alt={attachment.name}
                  className="h-10 w-10 shrink-0 rounded-xl object-cover border border-[rgba(15,23,42,0.06)]"
                />
              ) : (
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-[rgba(15,23,42,0.06)] bg-[rgba(15,23,42,0.03)] text-[var(--text-secondary)]">
                  <Paperclip size={16} />
                </div>
              )}
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
      <div className="flex items-center gap-1 rounded-xl border border-[rgba(15,23,42,0.06)] bg-white/90 p-1 opacity-0 shadow-sm backdrop-blur-md transition-all group-hover:opacity-100">
        <button className="p-1.5 rounded-md hover:bg-[rgba(0,0,0,0.05)] text-[var(--text-secondary)]" title="复制" onClick={() => onCopyText(message.content)}>
          <Copy size={14} />
        </button>
        <button className="p-1.5 rounded-md hover:bg-[rgba(0,0,0,0.05)] text-[var(--text-secondary)]" title="编辑" onClick={() => onEditMessage(message.id)}>
          <Pencil size={14} />
        </button>
        <button className="p-1.5 rounded-md hover:bg-[rgba(0,0,0,0.05)] text-[var(--text-secondary)]" title="重发" onClick={() => onResend(message.id)}>
          <RefreshCw size={14} />
        </button>
      </div>
    </article>
  )
}

export function ChatView({
  messages,
  displayedToolEvents,
  displayedTaskTree,
  settings,
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
  onDraftChange,
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
  onRegenerateMessage,
  onResendMessage,
  onToggleMessageActivity,
  onStop,
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
    return [
      messages.length,
      lastMessage.id,
      lastMessage.content.length,
      lastMessage.status || '',
      eventSignal,
      reasoningSignal,
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
  const isMetaEnter = settings.sendShortcut === 'meta-enter'
  const composerMetaHint = settings.cwd
    ? isMetaEnter
      ? '⌘/Ctrl + Enter 发送'
      : 'Enter 发送，Shift + Enter 换行'
    : '请设置工作区'

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

  const currentContextTokenCount = useMemo(() => {
    const messageTokens = messages.reduce((total, message) => total + estimateTokenCount(message.content), 0)
    const attachmentTokens = attachments.reduce(
      (total, attachment) => total + estimateTokenCount(attachment.name),
      0,
    )
    return messageTokens + attachmentTokens + estimateTokenCount(draft)
  }, [attachments, draft, messages])

  const latestUsage = useMemo(() => {
    return [...messages]
      .reverse()
      .find(
        message =>
          message.role === 'assistant' &&
          ((message.usage?.inputTokens || 0) > 0 || (message.usage?.outputTokens || 0) > 0),
      )?.usage
  }, [messages])

  const usageLabel = latestUsage
    ? [
      latestUsage.inputTokens ? `输入 ${formatTokenCount(latestUsage.inputTokens)}` : null,
      latestUsage.outputTokens ? `输出 ${formatTokenCount(latestUsage.outputTokens)}` : null,
      latestUsage.contextWindow && latestUsage.inputTokens
        ? `${Math.min(
          100,
          Math.round((latestUsage.inputTokens / latestUsage.contextWindow) * 100),
        )}%`
        : null,
    ]
      .filter(Boolean)
      .join(' · ')
    : `${formatTokenCount(currentContextTokenCount)} tok 估算`

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
        <div className="absolute inset-x-0 top-0 h-7" data-tauri-drag-region />
        <div className="flex items-center gap-2 text-12px text-[var(--text-secondary)] opacity-60">
          <span>{messages.length} 条消息</span>
          <span>·</span>
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
          </button>
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
          <div
            ref={scrollRef}
            className="flex-1 overflow-y-auto custom-scrollbar pt-8 pb-72 scroll-smooth"
            onScroll={handleMessageScroll}
          >
            {messages.length === 0 ? (
              <div className="max-w-1000px mx-auto px-6 py-20 flex flex-col items-center text-center">
                <h3 className="text-28px font-600 mb-2">你好，我是 Aura</h3>
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
                      onResend={onResendMessage}
                      onOpenAttachment={onOpenAttachment}
                    />
                  ) : (
                    <AssistantMessageCard
                      key={message.id}
                      message={message}
                      onCopyText={onCopyText}
                      onEditMessage={onEditMessage}
                      onRegenerateMessage={onRegenerateMessage}
                      onHandleApproval={onHandleApproval}
                      onToggleActivity={onToggleMessageActivity}
                    />
                  ),
                )}
              </div>
            )}
          </div>

          {/* Docked Composer */}
          <div className="absolute bottom-0 left-0 right-0 p-6 bg-gradient-to-t from-[var(--bg-app)]/80 to-transparent pointer-events-none flex justify-center">
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
                          {attachment.preview ? (
                            <img
                              src={attachment.preview}
                              alt={attachment.name}
                              className="h-8 w-8 shrink-0 rounded-lg object-cover border border-[rgba(15,23,42,0.06)]"
                            />
                          ) : (
                            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-[rgba(15,23,42,0.06)] bg-white text-[var(--text-secondary)]">
                              <Paperclip size={14} />
                            </div>
                          )}
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
                        {capabilitySnapshot ? (
                          <span className="rounded-full bg-white px-1.5 py-0.5 text-10px text-[var(--text-secondary)]">
                            {capabilitySnapshot.skills.length + capabilitySnapshot.plugins.length + capabilitySnapshot.mcpServers.length}
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
                          setModelMenuOpen(current => {
                            const next = !current
                            if (next) {
                              setCollapsedModelGroups(
                                new Set(modelGroups.map(group => group.profileId)),
                              )
                            }
                            return next
                          })
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
                    {/* 上下文占用量 */}
                    <div className="ml-1 flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-[rgba(15,23,42,0.04)] text-9px font-700 opacity-60">
                      <RefreshCw size={8} />
                      <span>{usageLabel}</span>
                    </div>
                  </div>

                  <div className="flex items-center gap-4">
                    <span className="text-11px text-[var(--text-secondary)] opacity-40 hidden sm:inline">{composerMetaHint}</span>
                    <button
                      className={`flex items-center justify-center p-1.5 rounded-lg text-white transition-all ${isRunning
                        ? 'bg-red-500 hover:bg-red-600 shadow-md shadow-red-200'
                        : 'bg-[var(--accent-soft-strong)] hover:brightness-110 disabled:opacity-40 disabled:grayscale'
                        }`}
                      title={isRunning ? '停止生成' : '发送'}
                      disabled={!isRunning && !draft.trim() && attachments.length === 0}
                      onClick={isRunning ? onStop : onSubmit}
                    >
                      {isRunning ? (
                        <Square size={16} fill="currentColor" strokeWidth={0} />
                      ) : (
                        <SendHorizontal size={18} />
                      )}
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
                canChooseWorkspace={canChangeWorkspace}
                onRefresh={onRefreshWorkspace}
                onChooseWorkspace={onChooseWorkspace}
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
