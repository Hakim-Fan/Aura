import { useEffect, useState, type KeyboardEvent } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  Bot,
  BrainCircuit,
  ChevronDown,
  ChevronUp,
  Clipboard,
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
  activeSessionTitle: string
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
            <a href={href} target="_blank" rel="noreferrer">
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
                  <button className="ghost-inline-button" onClick={() => onCopyText(raw)}>
                    <Clipboard size={14} />
                    复制
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
  const toneClass = `message-event-card ${event.status}`
  const hasRawPayload = Boolean(event.input || event.output || event.error)

  return (
    <article className={toneClass}>
      <div className="message-event-head">
        <div className="message-event-meta">
          <span className="event-kind">{eventKindLabel(event)}</span>
          <strong>{event.title}</strong>
        </div>
        <span className={`event-status ${event.status}`}>{eventStatusLabel(event.status)}</span>
      </div>
      <p>{event.summary}</p>
      {hasRawPayload ? (
        <details className="message-event-raw">
          <summary>查看原始输入 / 输出</summary>
          <div className="message-event-raw-body">
            {event.input ? (
              <div className="message-event-raw-section">
                <span>Input</span>
                <pre>{event.input}</pre>
              </div>
            ) : null}
            {event.output ? (
              <div className="message-event-raw-section">
                <span>Output</span>
                <pre>{event.output}</pre>
              </div>
            ) : null}
            {event.error ? (
              <div className="message-event-raw-section">
                <span>Error</span>
                <pre>{event.error}</pre>
              </div>
            ) : null}
          </div>
        </details>
      ) : null}
      <div className="message-event-actions">
        <button className="ghost-inline-button" onClick={() => onCopyText(event.summary)}>
          <Clipboard size={14} />
          复制摘要
        </button>
      </div>
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
  const duration = activity
    ? (activity.finishedAt || Date.now()) - activity.startedAt
    : undefined
  const hasExecution =
    Boolean(activity) || (message.events?.length || 0) > 0 || (message.steps?.length || 0) > 0
  const isStreaming = message.status === 'pending' || message.status === 'streaming'

  return (
    <article className={`message-card assistant ${message.status || 'completed'}`}>
      <div className="message-card-head">
        <div className="message-author">
          <span className="message-avatar assistant">
            <Bot size={15} />
          </span>
          <div>
            <div className="message-title">Desk Agent</div>
            <div className="message-subtitle">
              {message.status === 'failed' ? '执行失败' : isStreaming ? '正在生成回复' : '最终回答'}
            </div>
          </div>
        </div>
        {activity ? (
          <button className="activity-pill" onClick={() => onToggleActivity(message.id)}>
            <BrainCircuit size={14} />
            <span>{activityStatusLabel(activity.status)}</span>
            {duration ? <span>{formatDuration(duration)}</span> : null}
            {activity.expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          </button>
        ) : null}
      </div>

      {hasExecution ? (
        <section className="activity-panel">
          <div className="activity-panel-summary">
            {activity ? (
              <>
                <span>{duration ? `思考了 ${formatDuration(duration)}` : activityStatusLabel(activity.status)}</span>
                <span>{activity.stepCount} 个步骤</span>
                <span>{activity.toolCount} 个工具</span>
                {activity.skillCount > 0 ? <span>{activity.skillCount} 个技能</span> : null}
              </>
            ) : null}
          </div>

          {activity?.expanded ? (
            <div className="activity-panel-details">
              {message.events?.map(event => (
                <MessageEventCard key={event.id} event={event} onCopyText={onCopyText} />
              ))}
              {message.steps && message.steps.length > 0 ? (
                <div className="activity-steps">
                  <TaskTreeView nodes={message.steps} />
                </div>
              ) : null}
            </div>
          ) : null}
        </section>
      ) : null}

      {message.error ? <div className="error-banner inline">{message.error}</div> : null}

      {message.content ? (
        <MarkdownAnswer content={message.content} onCopyText={onCopyText} />
      ) : !isStreaming ? (
        <div className="empty-answer-state">
          <strong>本次执行没有生成最终文本</strong>
          <p>模型完成了步骤或工具调用，但没有返回可展示的最终回答。你可以重新生成，或把本次过程编辑成新提示继续追问。</p>
        </div>
      ) : (
        <div className="assistant-placeholder">
          <span className="assistant-placeholder-dot" />
          <span>Agent 正在组织答案与工具结果…</span>
        </div>
      )}

      <div className="message-actions">
        <button className="ghost-inline-button" onClick={() => onCopyText(message.content)}>
          <Clipboard size={14} />
          复制
        </button>
        <button
          className="ghost-inline-button"
          disabled={isStreaming}
          onClick={() => onRegenerateMessage(message.id)}
        >
          <RefreshCw size={14} />
          重新生成
        </button>
        <button
          className="ghost-inline-button"
          disabled={isStreaming}
          onClick={() => onEditMessage(message.id)}
        >
          <Pencil size={14} />
          编辑为新提示
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
    <article className="message-card user">
      <div className="user-bubble">{message.content}</div>
      <div className="message-actions user">
        <button className="ghost-inline-button" onClick={() => onCopyText(message.content)}>
          <Clipboard size={14} />
          复制
        </button>
        <button className="ghost-inline-button" onClick={() => onEditMessage(message.id)}>
          <Pencil size={14} />
          编辑
        </button>
        <button className="ghost-inline-button" onClick={() => onResend(message.id)}>
          <RefreshCw size={14} />
          重发
        </button>
      </div>
    </article>
  )
}

export function ChatView({
  activeSessionTitle,
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

  const workspaceLabel =
    settings.cwd.split('/').filter(Boolean).at(-1) || settings.cwd || '选择工作目录'
  const modelLabel =
    settings.model.split('/').filter(Boolean).at(-1) || settings.model || '选择模型'
  const providerLabel = providerLabelMap[settings.provider]
  const workspaceHint = settings.cwd
    ? summarizePath(settings.cwd)
    : sessionWorkspaceMode === 'default'
      ? `默认目录 ${summarizePath(sessionWorkspaceRoot || '未设置')}`
      : '当前会话还没有工作目录'
  const composerMetaHint = settings.cwd ? '⌘/Ctrl + Enter 发送' : workspaceHint

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
    <section className="chat-workbench-shell">
      <div className="chat-surface">
        <header className="chat-topbar">
          <div className="chat-heading">
            <div className="eyebrow">Session</div>
            <h2>{activeSessionTitle}</h2>
            <p className="chat-heading-subtle">
              {messages.length > 0 ? '对话与执行记录' : '准备开始一个新的任务'}
            </p>
          </div>
          <div className="chat-topbar-actions">
            <span className="micro-pill">{messages.length} 条消息</span>
            <span className="micro-pill">
              <FolderOpen size={13} />
              {summarizePath(settings.cwd)}
            </span>
            {hasInspectorContent ? (
              <button
                className={inspectorOpen ? 'toolbar-toggle active' : 'toolbar-toggle'}
                onClick={() => setInspectorOpen(current => !current)}
              >
                <Eye size={14} />
                运行详情
              </button>
            ) : null}
          </div>
        </header>

        <div className={inspectorOpen && hasInspectorContent ? 'chat-workbench with-inspector' : 'chat-workbench'}>
          <div className="conversation-column">
            <div className={messages.length === 0 ? 'conversation-stage empty' : 'conversation-stage'}>
              {messages.length === 0 ? (
                <div className="conversation-empty-state">
                  <div className="conversation-empty-copy">
                    <div className="eyebrow">Workspace Ready</div>
                    <h3>开始一个新会话</h3>
                    <p>把任务直接交给 Desk Agent。模型、工作区和工具入口已经收纳进下方命令栏。</p>
                  </div>
                  <div className="suggestion-prompt-grid">
                    {suggestedPrompts.map(prompt => (
                      <button
                        key={prompt}
                        className="suggestion-card"
                        onClick={() => onDraftChange(prompt)}
                      >
                        <Sparkles size={15} />
                        <span>{prompt}</span>
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}

              <div className="message-stack">
                {messages.map(message =>
                  message.role === 'user' ? (
                    <div key={message.id} className="message-row user">
                      <UserMessageCard
                        message={message}
                        onCopyText={onCopyText}
                        onEditMessage={onEditMessage}
                        onResend={onResendMessage}
                      />
                    </div>
                  ) : (
                    <div key={message.id} className="message-row assistant">
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
            </div>

            <div className="composer-panel">
              <div className="composer-input-shell">
                <textarea
                  value={draft}
                  onChange={event => onDraftChange(event.target.value)}
                  onKeyDown={handleComposerKeyDown}
                  placeholder="输入消息…"
                />

                <div className="composer-toolbar-row">
                  <div className="composer-tools-left">
                    <button className="composer-context-button" onClick={onChooseWorkspace}>
                      <FolderOpen size={16} />
                      <span>{workspaceLabel}</span>
                    </button>
                    <button className="composer-icon-button" onClick={onOpenProviders}>
                      <Settings2 size={16} />
                    </button>
                    <button className="composer-icon-button" onClick={onRefreshWorkspace}>
                      <Wrench size={16} />
                    </button>
                    {selectedFilePath ? (
                      <button
                        className="composer-icon-button"
                        onClick={() => onInsertFileReference(selectedFilePath)}
                      >
                        <Wand2 size={16} />
                      </button>
                    ) : null}
                    <button className="composer-model-button" onClick={onOpenProviders}>
                      <Bot size={16} />
                      <span>
                        {providerLabel} / {modelLabel}
                      </span>
                      <ChevronDown size={14} />
                    </button>
                  </div>

                  <div className="composer-tools-right">
                    <span className="composer-hint">{composerMetaHint}</span>
                    {error ? <div className="error-banner inline">{error}</div> : null}
                    <button className="composer-send-button" disabled={isRunning} onClick={onSubmit}>
                      <SendHorizontal size={16} />
                      {isRunning ? '执行中' : '发送'}
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {inspectorOpen && hasInspectorContent ? (
            <aside className="execution-drawer">
              {agentTask?.pendingApproval ? (
                <section className="inspector-card approval">
                  <div className="section-title">审批中心</div>
                  <div className="approval-card">
                    <div className="inline-between">
                      <strong>{agentTask.pendingApproval.toolName}</strong>
                      <span className="micro-pill warn">{agentTask.pendingApproval.category}</span>
                    </div>
                    <p>{agentTask.pendingApproval.summary}</p>
                    {agentTask.pendingApproval.input ? <pre>{agentTask.pendingApproval.input}</pre> : null}
                    <div className="approval-actions">
                      <button className="secondary-button" onClick={() => onHandleApproval('deny')}>
                        拒绝
                      </button>
                      <button className="primary-button" onClick={() => onHandleApproval('approve')}>
                        允许
                      </button>
                    </div>
                  </div>
                </section>
              ) : null}

              {(displayedToolEvents.length > 0 || displayedTaskTree.length > 0) && isRunning ? (
                <section className="inspector-card">
                  <div className="section-title">运行详情</div>
                  {displayedToolEvents.length > 0 ? (
                    <div className="inspector-event-list">
                      {displayedToolEvents.map(event => (
                        <MessageEventCard
                          key={event.id}
                          event={{
                            id: event.id,
                            kind:
                              event.source === 'plugin'
                                ? 'skill'
                                : event.source === 'subagent'
                                  ? 'subagent'
                                  : event.name.toLowerCase().includes('shell')
                                    ? 'shell'
                                    : 'tool',
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
                  ) : null}
                  {displayedTaskTree.length > 0 ? (
                    <div className="activity-steps drawer">
                      <TaskTreeView nodes={displayedTaskTree} />
                    </div>
                  ) : null}
                </section>
              ) : null}

              {(selectedFilePath || previewError || workspaceError || previewLoading) ? (
                <section className="inspector-card">
                  <div className="section-title">当前上下文</div>
                  <div className="context-panel compact">
                    {workspaceError ? <div className="error-banner">{workspaceError}</div> : null}
                    {selectedFilePath ? (
                      <>
                        <div className="context-row">
                          <strong>聚焦文件</strong>
                          <button className="ghost-inline-button" onClick={() => onCopyPath(selectedFilePath)}>
                            <Clipboard size={14} />
                            复制路径
                          </button>
                        </div>
                        <div className="focused-file-name">{selectedFilePath}</div>
                      </>
                    ) : null}
                    {previewLoading ? <p className="muted">正在读取文件...</p> : null}
                    {previewError ? <div className="error-banner">{previewError}</div> : null}
                    {previewContent ? <pre className="preview-content compact">{previewContent}</pre> : null}
                  </div>
                </section>
              ) : null}
            </aside>
          ) : null}
        </div>
      </div>
    </section>
  )
}
