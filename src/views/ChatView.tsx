import { TaskTreeView } from '../components/TaskTreeView'
import type {
  AgentSettings,
  AgentTaskSnapshot,
  ChatMessage,
  TaskNode,
  ToolEvent,
  WorkspaceNode,
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
  workspaceTree: WorkspaceNode | null
  workspaceLoading: boolean
  workspaceError: string
  expandedPaths: string[]
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
  onToggleWorkspacePath: (path: string) => void
  onSelectWorkspaceFile: (path: string) => void
  onInsertFileReference: (path: string) => void
  onCopyPath: (path: string) => void
  onCopyText: (value: string) => void
}

const providerLabelMap: Record<AgentSettings['provider'], string> = {
  openai: 'OpenAI',
  google: 'Google',
  custom: 'Custom',
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
  workspaceTree,
  workspaceLoading,
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
}: Props) {
  const workspaceLabel =
    settings.cwd.split('/').filter(Boolean).at(-1) || settings.cwd || '选择工作目录'
  const modelLabel =
    settings.model.split('/').filter(Boolean).at(-1) || settings.model || '选择模型'
  const providerLabel = providerLabelMap[settings.provider]
  const workspaceHint = settings.cwd
    ? settings.cwd
    : sessionWorkspaceMode === 'default'
      ? `未手动选择目录，发送时会在默认工作目录 ${sessionWorkspaceRoot || '未设置'} 下创建子目录`
      : '当前会话还没有工作目录'

  const showSidebar =
    Boolean(agentTask?.pendingApproval) ||
    displayedTaskTree.length > 0 ||
    displayedToolEvents.length > 0 ||
    Boolean(selectedFilePath) ||
    Boolean(previewError) ||
    Boolean(workspaceError)

  return (
    <section className={showSidebar ? 'chat-workbench' : 'chat-workbench compact'}>
      <div className="workbench-main conversation-main">
        <header className="chat-toolbar minimal">
          <div className="chat-heading">
            <div className="eyebrow">Session</div>
            <h2>{activeSessionTitle}</h2>
          </div>
          <div className="toolbar-meta">
            <span className="micro-pill">{messages.length} 条消息</span>
            <span className="micro-pill">{settings.cwd ? workspaceLabel : '未设置工作区'}</span>
          </div>
        </header>

        <div className={messages.length === 0 ? 'conversation-stage empty' : 'conversation-stage'}>
          {messages.length === 0 ? (
            <div className="conversation-empty">
              <h3>开始一个新会话</h3>
              <p>直接输入你的任务。模型、工作目录和提供商入口都在下方输入框里。</p>
            </div>
          ) : null}

          <div className="messages conversation-flow">
            {messages.map(message => (
              <article
                key={message.id}
                className={message.role === 'user' ? 'message user' : 'message assistant'}
              >
                <div className="message-role">{message.role === 'user' ? '你' : 'Agent'}</div>
                <div className="message-body">{message.content}</div>
                {message.role === 'assistant' ? (
                  <div className="message-actions">
                    <button className="ghost-button" onClick={() => onCopyText(message.content)}>
                      复制
                    </button>
                  </div>
                ) : null}
              </article>
            ))}

            {isRunning ? (
              <div className="running-card">
                <div className="inline-between">
                  <strong>Agent 正在后台执行</strong>
                  <span className="micro-pill">{agentTask?.status ?? 'running'}</span>
                </div>
                <p>
                  {agentTask?.status === 'awaiting_approval'
                    ? '当前流程停在审批节点，右侧审批中心可继续。'
                    : '你可以继续输入补充说明，或查看右侧执行细节。'}
                </p>
              </div>
            ) : null}
          </div>
        </div>

        <div className="composer-shell integrated">
          <div className="composer-toolbar">
            <button className="tool-chip" onClick={onChooseWorkspace}>
              {workspaceLabel}
            </button>
            <button className="tool-chip" onClick={onOpenProviders}>
              {providerLabel}
            </button>
            <button className="tool-chip" onClick={onOpenProviders}>
              {modelLabel}
            </button>
            <button className="tool-chip" onClick={onRefreshWorkspace}>
              刷新目录
            </button>
            {selectedFilePath ? (
              <button className="tool-chip" onClick={() => onInsertFileReference(selectedFilePath)}>
                引用当前文件
              </button>
            ) : null}
          </div>

          <textarea
            value={draft}
            onChange={event => onDraftChange(event.target.value)}
            placeholder="输入消息..."
          />

          <div className="composer-footer integrated">
            <div className="composer-meta">
              <span className="muted">{workspaceHint}</span>
              {error ? <div className="error-banner inline">{error}</div> : null}
            </div>
            <div className="composer-actions">
              <button className="ghost-button" onClick={onOpenProviders}>
                提供商
              </button>
              <button className="primary-button" disabled={isRunning} onClick={onSubmit}>
                {isRunning ? '执行中...' : '发送'}
              </button>
            </div>
          </div>
        </div>
      </div>

      {showSidebar ? (
        <aside className="inspector-column compact">
          {agentTask?.pendingApproval ? (
            <section className="inspector-card">
              <div className="section-title">审批中心</div>
              <div className="approval-card">
                <div className="inline-between">
                  <strong>{agentTask.pendingApproval.toolName}</strong>
                  <span className="micro-pill">{agentTask.pendingApproval.category}</span>
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

          {displayedTaskTree.length > 0 ? (
            <section className="inspector-card">
              <div className="section-title">任务树</div>
              <TaskTreeView nodes={displayedTaskTree} />
            </section>
          ) : null}

          {displayedToolEvents.length > 0 ? (
            <section className="inspector-card">
              <div className="section-title">执行时间线</div>
              <div className="tool-log">
                {displayedToolEvents.map(event => (
                  <article key={event.id} className="tool-event">
                    <div className="inline-between">
                      <strong>{event.name}</strong>
                      <span className="micro-pill">
                        {event.source} / {event.status}
                      </span>
                    </div>
                    <p>{event.summary}</p>
                    {event.input ? <pre>{event.input}</pre> : null}
                    {event.output ? <pre>{event.output}</pre> : null}
                    {event.error ? <pre>{event.error}</pre> : null}
                  </article>
                ))}
              </div>
            </section>
          ) : null}

          {settings.cwd || workspaceLoading || workspaceError || selectedFilePath ? (
            <section className="inspector-card">
              <div className="section-title">项目上下文</div>
              <div className="context-panel">
                <div className="context-row">
                  <strong>工作目录</strong>
                  <span>{settings.cwd || '未设置'}</span>
                </div>
                {workspaceLoading ? <p className="muted">正在读取目录...</p> : null}
                {workspaceError ? <div className="error-banner">{workspaceError}</div> : null}
                {workspaceTree ? (
                  <div className="context-row">
                    <strong>根目录</strong>
                    <button className="ghost-button" onClick={() => onCopyPath(workspaceTree.path)}>
                      复制路径
                    </button>
                  </div>
                ) : null}
                {selectedFilePath ? (
                  <>
                    <div className="context-row">
                      <strong>当前文件</strong>
                      <button className="ghost-button" onClick={() => onCopyPath(selectedFilePath)}>
                        复制
                      </button>
                    </div>
                    {previewLoading ? <p className="muted">正在读取文件...</p> : null}
                    {previewError ? <div className="error-banner">{previewError}</div> : null}
                    {previewContent ? <pre className="preview-content compact">{previewContent}</pre> : null}
                  </>
                ) : null}
              </div>
            </section>
          ) : null}
        </aside>
      ) : null}
    </section>
  )
}
