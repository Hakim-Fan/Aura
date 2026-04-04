import { useEffect, useState, type KeyboardEvent } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  Bot,
  BrainCircuit,
  Copy,
  ChevronDown,
  ChevronUp,
  Eye,
  FolderOpen,
  Pencil,
  RefreshCw,
  SendHorizontal,
  Settings2,
  Sparkles,
  Wand2,
  Wrench,
} from 'lucide-react'
import { TaskTreeView } from '../components/TaskTreeView'
import type {
  AgentSettings,
  AgentTaskSnapshot,
  ChatMessage,
  MessageEvent,
  TaskNode,
  ToolEvent,
} from '../types'

type Props = {
  messages: ChatMessage[]
  displayedToolEvents: ToolEvent[]
  displayedTaskTree: TaskNode[]
  settings: AgentSettings
  sessionWorkspaceRoot: string
  sessionWorkspaceMode: 'explicit' | 'default'
  draft: string
  error: string
  isRunning: boolean
  agentTask: AgentTaskSnapshot | null
  workspaceError: string
  selectedFilePath: string | null
  previewContent: string
  previewLoading: boolean
  previewError: string
  onDraftChange: (value: string) => void
  onSubmit: () => void
  onOpenProviders: () => void
  onHandleApproval: (decision: 'approve' | 'deny') => void
  onRefreshWorkspace: () => void
  onChooseWorkspace: () => void
  onInsertFileReference: (path: string) => void
  onCopyPath: (path: string) => void
  onCopyText: (value: string) => void
  onEditMessage: (messageId: string) => void
  onRegenerateMessage: (messageId: string) => void
  onResendMessage: (messageId: string) => void
  onToggleMessageActivity: (messageId: string) => void
}

const providerLabelMap: Record<AgentSettings['provider'], string> = {
  openai: 'OpenAI',
  google: 'Google',
  custom: 'Custom',
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

function MessageEventCard({
  event,
  onCopyText,
}: {
  event: MessageEvent
  onCopyText: (value: string) => void
}) {
  return (
    <article className="p-3 rounded-xl border border-[var(--border-subtle)] bg-[rgba(0,0,0,0.01)] last:mb-0">
      <div className="flex-between mb-1.5 px-0.5">
        <div className="flex items-center gap-2">
          <span className={`text-9px font-700 tracking-wider uppercase px-1.5 py-0.5 rounded ${event.status === 'error' ? 'bg-red-50 text-red-500' : 'bg-gray-100 text-gray-500'
            }`}>{eventKindLabel(event)}</span>
          <strong className="text-13px text-[var(--text-primary)] opacity-80">{event.title}</strong>
        </div>
        <span className={`text-10px font-500 ${event.status === 'error' ? 'text-red-500' : 'text-green-600'}`}>
          {eventStatusLabel(event.status)}
        </span>
      </div>
      <p className="text-12px text-[var(--text-secondary)] mb-2 px-0.5 opacity-80">{event.summary}</p>
      {(event.input || event.output || event.error) && (
        <details className="mt-2 group">
          <summary className="text-11px text-[var(--text-secondary)] cursor-pointer hover:text-[var(--text-primary)] transition-colors opacity-60">显示详细信息</summary>
          <div className="mt-2 p-3 bg-gray-50 rounded-lg border border-gray-100 flex flex-col gap-3">
            {event.input && (
              <div className="flex flex-col gap-1">
                <span className="text-10px font-600 text-gray-400 uppercase">Input</span>
                <pre className="text-11px text-gray-600 whitespace-pre-wrap">{event.input}</pre>
              </div>
            )}
            {event.output && (
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

function AssistantMessageCard({
  message,
  onCopyText,
  onEditMessage,
  onRegenerateMessage,
  onToggleActivity,
}: {
  message: ChatMessage
  onCopyText: (value: string) => void
  onEditMessage: (messageId: string) => void
  onRegenerateMessage: (messageId: string) => void
  onToggleActivity: (messageId: string) => void
}) {
  const activity = message.activity
  const duration = activity ? (activity.finishedAt || Date.now()) - activity.startedAt : undefined
  const hasExecution = Boolean(activity) || (message.events?.length || 0) > 0 || (message.steps?.length || 0) > 0
  const isStreaming = message.status === 'pending' || message.status === 'streaming'

  return (
    <article className="group flex flex-col gap-4">
      {/* Assistant Header */}
      <div className="flex-between">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-[rgba(0,122,255,0.05)] border border-[rgba(0,122,255,0.1)] flex-center text-[var(--bg-user-bubble)]">
            <Bot size={18} />
          </div>
          <div className="flex flex-col">
            <div className="text-14px font-600">Desk Agent</div>
            <div className="text-11px text-[var(--text-secondary)] opacity-50">
              {message.status === 'failed' ? '执行中途中断' : isStreaming ? '正在思考并撰写回答...' : '最终回答'}
            </div>
          </div>
        </div>

        {activity && (
          <button
            className="flex items-center gap-1.5 py-1.5 px-3 rounded-full bg-[rgba(0,0,0,0.03)] hover:bg-[rgba(0,0,0,0.06)] text-11px text-[var(--text-secondary)] transition-all"
            onClick={() => onToggleActivity(message.id)}
          >
            <BrainCircuit size={13} className="opacity-70" />
            <span>{activityStatusLabel(activity.status)}</span>
            {duration && <span className="opacity-40">· {formatDuration(duration)}</span>}
            {activity.expanded ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
          </button>
        )}
      </div>

      {hasExecution && activity?.expanded && (
        <section className="ml-11 flex flex-col gap-4">
          <div className="flex flex-col gap-2 p-4 rounded-xl bg-[rgba(0,0,0,0.02)] border border-[rgba(0,0,0,0.04)]">
            <div className="text-10px font-600 text-[var(--text-secondary)] opacity-40 uppercase tracking-wider mb-1">执行链路总结</div>
            <div className="flex gap-4 text-11px text-[var(--text-secondary)] opacity-70">
              <span>{activity.stepCount} 个步骤</span>
              <span>{activity.toolCount} 个操作工具</span>
              {activity.skillCount > 0 && <span>{activity.skillCount} 个专用技能</span>}
            </div>
            <div className="mt-2 flex flex-col gap-3">
              {message.events?.map(event => (
                <MessageEventCard key={event.id} event={event} onCopyText={onCopyText} />
              ))}
              {message.steps && message.steps.length > 0 && (
                <div className="mt-1">
                  <TaskTreeView nodes={message.steps} />
                </div>
              )}
            </div>
          </div>
        </section>
      )}

      {message.error && <div className="ml-11 px-4 py-2 bg-red-50 text-red-500 rounded-lg text-13px border border-red-100">{message.error}</div>}

      <div className="ml-11">
        {message.content ? (
          <MarkdownAnswer content={message.content} onCopyText={onCopyText} />
        ) : !isStreaming ? (
          <div className="p-4 rounded-xl bg-gray-50 border border-dashed border-gray-200 text-center">
            <p className="text-13px text-[var(--text-secondary)]">模型执行了操作但未生成总结回答。</p>
          </div>
        ) : (
          <div className="flex items-center gap-2 text-13px text-[var(--text-secondary)] opacity-40 italic">
            <span className="w-2 h-2 rounded-full bg-blue-500 animate-pulse" />
            正在整理信息并生成最终回答...
          </div>
        )}
      </div>

      {/* Actions */}
      <div className="ml-11 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
        <button className="p-1.5 rounded-md hover:bg-[rgba(0,0,0,0.05)] text-[var(--text-secondary)]" title="复制" onClick={() => onCopyText(message.content)}>
          <Copy size={14} />
        </button>
        <button className="p-1.5 rounded-md hover:bg-[rgba(0,0,0,0.05)] text-[var(--text-secondary)]" title="编辑" onClick={() => onEditMessage(message.id)}>
          <Pencil size={14} />
        </button>
        <button className="p-1.5 rounded-md hover:bg-[rgba(0,0,0,0.05)] text-[var(--text-secondary)]" title="重新生成" disabled={isStreaming} onClick={() => onRegenerateMessage(message.id)}>
          <RefreshCw size={14} />
        </button>
      </div>
    </article>
  )
}

function UserMessageCard({
  message,
  onCopyText,
  onEditMessage,
  onResend,
}: {
  message: ChatMessage
  onCopyText: (value: string) => void
  onEditMessage: (messageId: string) => void
  onResend: (messageId: string) => void
}) {
  return (
    <article className="group flex flex-col items-end gap-2">
      <div className="max-w-85% bg-[var(--bg-user-bubble)] text-[var(--text-user-bubble)] px-4 py-2.5 rounded-2xl rounded-tr-4px shadow-md shadow-[rgba(0,122,255,0.15)] text-15px leading-relaxed">
        {message.content}
      </div>
      <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
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
  sessionWorkspaceRoot,
  sessionWorkspaceMode,
  draft,
  error,
  isRunning,
  agentTask,
  workspaceError,
  selectedFilePath,
  previewContent,
  previewLoading,
  previewError,
  onDraftChange,
  onSubmit,
  onOpenProviders,
  onHandleApproval,
  onRefreshWorkspace,
  onChooseWorkspace,
  onInsertFileReference,
  onCopyPath,
  onCopyText,
  onEditMessage,
  onRegenerateMessage,
  onResendMessage,
  onToggleMessageActivity,
}: Props) {
  const [inspectorOpen, setInspectorOpen] = useState(false)

  const modelLabel =
    settings.model.split('/').filter(Boolean).at(-1) || settings.model || '选择模型'
  const providerLabel = providerLabelMap[settings.provider]
  const composerMetaHint = settings.cwd ? '⌘/Ctrl + Enter 发送' : '请设置工作区'

  const hasInspectorContent =
    isRunning ||
    Boolean(agentTask?.pendingApproval) ||
    Boolean(selectedFilePath) ||
    Boolean(previewError) ||
    Boolean(workspaceError)

  useEffect(() => {
    if (agentTask?.pendingApproval || workspaceError || previewError) {
      setInspectorOpen(true)
    }
  }, [agentTask?.pendingApproval, previewError, workspaceError])

  function handleComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault()
      onSubmit()
    }
  }

  return (
    <section className="flex-1 flex flex-col h-screen bg-[var(--bg-app)] relative overflow-hidden">
      <header
        className="relative h-10 border-b border-[var(--border-subtle)] px-4 flex items-center justify-center shrink-0"
        data-tauri-drag-region
      >
        <div className="flex items-center gap-2 text-12px text-[var(--text-secondary)] opacity-60">
          <span>{messages.length} 条消息</span>
          <span>·</span>
          <button
            className="flex items-center gap-1 hover:text-[var(--text-primary)] cursor-pointer transition-colors bg-transparent border-none p-0 text-12px text-[var(--text-secondary)] opacity-100"
            title={settings.cwd || '未设置工作区'}
            onClick={onChooseWorkspace}
          >
            <FolderOpen size={12} />
            {summarizePath(settings.cwd)}
          </button>
        </div>

        {hasInspectorContent && (
          <div className="absolute right-4">
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
          <div className="flex-1 overflow-y-auto custom-scrollbar pt-6 pb-32">
            {messages.length === 0 ? (
              <div className="max-w-1000px mx-auto px-6 py-20 flex flex-col items-center text-center">
                <div className="text-11px font-700 text-[var(--text-secondary)] tracking-0.2em uppercase mb-4 opacity-50">
                  Ready to work
                </div>
                <h3 className="text-28px font-600 mb-2">有什么可以帮你的？</h3>
                <p className="text-[var(--text-secondary)] mb-10 opacity-70">
                  选择一个示例或输入你的任务开始协作
                </p>
                <div className="grid grid-cols-2 gap-4 w-full">
                  {suggestedPrompts.map(prompt => (
                    <button
                      key={prompt}
                      className="group p-4 text-left border border-[var(--border-subtle)] rounded-xl hover:border-[var(--bg-user-bubble)] hover:shadow-lg hover:shadow-[rgba(0,122,255,0.05)] transition-all bg-white"
                      onClick={() => onDraftChange(prompt)}
                    >
                      <div className="flex items-start gap-3">
                        <Sparkles size={16} className="mt-0.5 text-[var(--bg-user-bubble)] opacity-60" />
                        <span className="text-14px leading-relaxed">{prompt}</span>
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <div className="max-w-1000px mx-auto px-6 flex flex-col gap-10">
                {messages.map(message =>
                  message.role === 'user' ? (
                    <div key={message.id} className="flex flex-col items-end gap-2">
                      <article className="max-w-85% bg-[var(--bg-user-bubble)] text-[var(--text-user-bubble)] px-4 py-2.5 rounded-2xl rounded-tr-4px shadow-md shadow-[rgba(0,122,255,0.15)] text-15px leading-relaxed">
                        {message.content}
                      </article>
                      <div className="flex gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                        {/* Optional actions for user message */}
                      </div>
                    </div>
                  ) : (
                    <div key={message.id} className="flex flex-col gap-4">
                      <AssistantMessageCard
                        message={message}
                        onCopyText={onCopyText}
                        onEditMessage={onEditMessage}
                        onRegenerateMessage={onRegenerateMessage}
                        onToggleActivity={onToggleMessageActivity}
                      />
                    </div>
                  ),
                )}
              </div>
            )}
          </div>

          {/* Docked Composer */}
          <div className="absolute bottom-0 left-0 right-0 p-6 bg-gradient-to-t from-[var(--bg-app)] via-[var(--bg-app)] to-transparent pointer-events-none">
            <div className="max-w-1000px mx-auto pointer-events-auto">
              <div className="bg-white border border-[var(--border-subtle)] rounded-2xl shadow-xl shadow-[rgba(0,0,0,0.06)] overflow-hidden transition-all focus-within:border-[rgba(0,122,255,0.3)] focus-within:shadow-[rgba(0,122,255,0.05)]">
                <textarea
                  className="w-full min-h-120px max-h-400px p-4 text-15px leading-relaxed resize-none border-none bg-transparent"
                  value={draft}
                  onChange={event => onDraftChange(event.target.value)}
                  onKeyDown={handleComposerKeyDown}
                  placeholder="在这里输入你的需求或问题..."
                />

                <div className="h-10 px-3 border-t border-[var(--border-subtle)] bg-[rgba(0,0,0,0.01)] flex items-center justify-between">
                  <div className="flex items-center gap-1">
                    <button className="p-1.5 rounded-md hover:bg-[rgba(0,0,0,0.05)] text-[var(--text-secondary)]" onClick={onChooseWorkspace} title="工作目录">
                      <FolderOpen size={16} />
                    </button>
                    <button className="p-1.5 rounded-md hover:bg-[rgba(0,0,0,0.05)] text-[var(--text-secondary)]" onClick={onOpenProviders} title="模型设置">
                      <Settings2 size={16} />
                    </button>
                    <div className="h-4 w-1px bg-[var(--border-subtle)] mx-1" />
                    <button
                      className="flex items-center gap-1.5 px-2 py-1 rounded-md hover:bg-[rgba(0,0,0,0.05)] text-12px text-[var(--text-secondary)] transition-colors"
                      onClick={onOpenProviders}
                    >
                      <Bot size={14} className="opacity-70" />
                      <span className="max-w-100px truncate">{modelLabel}</span>
                      <ChevronDown size={12} className="opacity-40" />
                    </button>
                  </div>

                  <div className="flex items-center gap-4">
                    {error && <span className="text-11px text-red-500 font-500">{error}</span>}
                    <span className="text-11px text-[var(--text-secondary)] opacity-40 hidden sm:inline">{composerMetaHint}</span>
                    <button
                      className="flex items-center justify-center p-1.5 rounded-lg bg-[var(--bg-user-bubble)] text-white hover:brightness-110 disabled:opacity-40 disabled:grayscale transition-all"
                      disabled={isRunning || !draft.trim()}
                      onClick={onSubmit}
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
          <aside className="w-320px border-l border-[var(--border-subtle)] bg-[rgba(0,0,0,0.01)] flex flex-col shrink-0 overflow-y-auto custom-scrollbar p-5 gap-6">
            {agentTask?.pendingApproval ? (
              <div className="p-4 bg-white border border-amber-200 rounded-xl shadow-sm">
                <div className="text-12px font-600 text-amber-600 uppercase tracking-wider mb-2">待执行审批</div>
                <div className="flex-between mb-3">
                  <strong className="text-14px">{agentTask.pendingApproval.toolName}</strong>
                  <span className="text-10px px-2 py-0.5 bg-amber-50 text-amber-600 rounded-full border border-amber-100">{agentTask.pendingApproval.category}</span>
                </div>
                <p className="text-13px text-[var(--text-secondary)] mb-4">{agentTask.pendingApproval.summary}</p>
                {agentTask.pendingApproval.input && (
                  <pre className="text-11px bg-gray-50 p-3 rounded-lg overflow-x-auto mb-4 border border-gray-100">{agentTask.pendingApproval.input}</pre>
                )}
                <div className="grid grid-cols-2 gap-3">
                  <button className="py-2 px-3 text-13px font-500 rounded-lg bg-gray-100 hover:bg-gray-200 transition-colors" onClick={() => onHandleApproval('deny')}>拒绝</button>
                  <button className="py-2 px-3 text-13px font-500 rounded-lg bg-[var(--bg-user-bubble)] text-white hover:brightness-110 transition-all" onClick={() => onHandleApproval('approve')}>允许</button>
                </div>
              </div>
            ) : null}

            {(displayedToolEvents.length > 0 || displayedTaskTree.length > 0) && isRunning && (
              <div className="flex flex-col gap-4">
                <div className="text-12px font-600 text-[var(--text-secondary)] opacity-50 uppercase tracking-wider">执行详情</div>
                <div className="flex flex-col gap-3">
                  {displayedToolEvents.map(event => (
                    <MessageEventCard
                      key={event.id}
                      event={{
                        id: event.id,
                        kind: event.source === 'plugin' ? 'skill' : event.source === 'subagent' ? 'subagent' : event.name.toLowerCase().includes('shell') ? 'shell' : 'tool',
                        title: event.name,
                        summary: event.summary,
                        source: event.source,
                        status: event.status === 'error' ? 'error' : 'success',
                        input: event.input,
                        output: event.output,
                        error: event.error,
                      }}
                      onCopyText={onCopyText}
                    />
                  ))}
                </div>
              </div>
            )}

            {selectedFilePath && (
              <div className="flex flex-col gap-3">
                <div className="text-12px font-600 text-[var(--text-secondary)] opacity-50 uppercase tracking-wider">当前文件</div>
                <div className="bg-white p-3 rounded-xl border border-[var(--border-subtle)]">
                  <div className="flex-between mb-2">
                    <span className="text-13px font-500 truncate flex-1 pr-4">{selectedFilePath.split('/').pop()}</span>
                    <button className="p-1 hover:bg-gray-100 rounded" onClick={() => onCopyPath(selectedFilePath)} title="复制路径">
                      <Copy size={12} />
                    </button>
                  </div>
                  <div className="text-11px text-[var(--text-secondary)] mb-3 opacity-60 break-all">{selectedFilePath}</div>
                  {previewContent && (
                    <pre className="text-10px bg-gray-50 p-2 rounded border border-gray-100 max-h-300px overflow-y-auto whitespace-pre-wrap">{previewContent}</pre>
                  )}
                  {previewLoading && <div className="text-11px text-center py-4 animate-pulse">正在读取...</div>}
                </div>
              </div>
            )}
          </aside>
        )}
      </div>
    </section>
  )
}
