import { TaskTreeView } from '../components/TaskTreeView'
import { WorkspaceExplorer } from '../components/WorkspaceExplorer'
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
  draft: string
  error: string
  isRunning: boolean
  agentTask: AgentTaskSnapshot | null
  promptSuggestions: string[]
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
  onInjectPrompt: (prompt: string) => void
  onOpenProviders: () => void
  onHandleApproval: (decision: 'approve' | 'deny') => void
  onPolicyChange: <K extends keyof AgentSettings>(
    key: K,
    value: AgentSettings[K],
  ) => void
  onRefreshWorkspace: () => void
  onChooseWorkspace: () => void
  onToggleWorkspacePath: (path: string) => void
  onSelectWorkspaceFile: (path: string) => void
  onInsertFileReference: (path: string) => void
  onCopyPath: (path: string) => void
  onCopyText: (value: string) => void
}

export function ChatView({
  activeSessionTitle,
  messages,
  displayedToolEvents,
  displayedTaskTree,
  settings,
  draft,
  error,
  isRunning,
  agentTask,
  promptSuggestions,
  workspaceTree,
  workspaceLoading,
  workspaceError,
  expandedPaths,
  selectedFilePath,
  previewContent,
  previewLoading,
  previewError,
  onDraftChange,
  onSubmit,
  onInjectPrompt,
  onOpenProviders,
  onHandleApproval,
  onPolicyChange,
  onRefreshWorkspace,
  onChooseWorkspace,
  onToggleWorkspacePath,
  onSelectWorkspaceFile,
  onInsertFileReference,
  onCopyPath,
  onCopyText,
}: Props) {
  const workspaceLabel =
    settings.cwd.split('/').filter(Boolean).at(-1) || settings.cwd || '未设置工作区'
  const modelLabel =
    settings.model.split('/').filter(Boolean).at(-1) || settings.model || '未配置模型'

  return (
    <section className="chat-workbench">
      <div className="workbench-main">
        <header className="chat-toolbar">
          <div className="chat-heading">
            <div className="eyebrow">Session</div>
            <h2>{activeSessionTitle}</h2>
            <p className="chat-subtitle">{settings.cwd}</p>
          </div>
          <div className="toolbar-meta">
            <span className="micro-pill">{messages.length} 条消息</span>
            <span className="micro-pill">{workspaceLabel}</span>
            <span className="micro-pill">{modelLabel}</span>
          </div>
        </header>

        <WorkspaceExplorer
          rootPath={settings.cwd}
          tree={workspaceTree}
          loading={workspaceLoading}
          error={workspaceError}
          selectedFilePath={selectedFilePath}
          previewContent={previewContent}
          previewLoading={previewLoading}
          previewError={previewError}
          expandedPaths={expandedPaths}
          onRefresh={onRefreshWorkspace}
          onChooseWorkspace={onChooseWorkspace}
          onToggle={onToggleWorkspacePath}
          onSelectFile={onSelectWorkspaceFile}
          onInsertReference={onInsertFileReference}
          onCopyPath={onCopyPath}
        />

        <div className="chat-column">
          <div className="messages">
            {messages.length === 0 ? (
              <div className="empty-state rich">
                <div className="empty-state-head">
                  <span className="status-pill">工作台已就绪</span>
                  <h3>开始一个能读项目、会审批、可调用工具的 Agent 会话</h3>
                  <p>
                    你可以让它改代码、查文件、调用 Shell、连 MCP、派发子 Agent，或者直接操作桌面与浏览器。
                  </p>
                </div>
                <div className="suggestion-grid">
                  {promptSuggestions.map(prompt => (
                    <button
                      key={prompt}
                      className="suggestion-chip"
                      onClick={() => onInjectPrompt(prompt)}
                    >
                      {prompt}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              messages.map(message => (
                <article
                  key={message.id}
                  className={message.role === 'user' ? 'message user' : 'message assistant'}
                >
                  <div className="message-role">{message.role === 'user' ? '你' : 'Agent'}</div>
                  <div className="message-body">{message.content}</div>
                  {message.role === 'assistant' ? (
                    <div className="message-actions">
                      <button
                        className="ghost-button"
                        onClick={() => onCopyText(message.content)}
                      >
                        复制
                      </button>
                    </div>
                  ) : null}
                </article>
              ))
            )}
            {isRunning ? (
              <div className="running-card">
                <div className="inline-between">
                  <strong>Agent 正在后台执行</strong>
                  <span className="micro-pill">{agentTask?.status ?? 'running'}</span>
                </div>
                <p>
                  {agentTask?.status === 'awaiting_approval'
                    ? '当前流程停在审批节点，右侧审批中心可继续。'
                    : '你可以继续浏览项目、查看工具时间线和任务树。'}
                </p>
              </div>
            ) : null}
          </div>

          <div className="composer-shell">
            <div className="chip-row compact">
              <button
                className="tool-chip"
                onClick={() => onInjectPrompt('分析当前工作区并给出执行计划')}
              >
                Plan
              </button>
              <button
                className="tool-chip"
                onClick={() =>
                  onInjectPrompt('需要时可以启用多 Agent 协作，优先把任务拆清楚')
                }
              >
                Agent
              </button>
              <button
                className="tool-chip"
                onClick={() => onInjectPrompt('如果需要，请调用 MCP 工具并汇总结果')}
              >
                MCP
              </button>
              <button
                className="tool-chip"
                onClick={() => onInjectPrompt('必要时操作浏览器并回传关键结果')}
              >
                Web
              </button>
            </div>
            <textarea
              value={draft}
              onChange={event => onDraftChange(event.target.value)}
              placeholder="输入任务描述、目标目录、限制条件和预期交付物。Agent 会自动选择工具、子 Agent、MCP、桌面控制或浏览器能力。"
            />
            <div className="composer-footer">
              <div className="muted">
                {agentTask?.status === 'awaiting_approval'
                  ? 'Agent 正在等待你的审批。'
                  : isRunning
                    ? 'Agent 正在后台执行中...'
                    : '当前会话支持后台执行、审批流、任务树和时间线。'}
              </div>
              <div className="header-actions">
                <button className="secondary-button" onClick={onOpenProviders}>
                  提供商
                </button>
                <button className="primary-button" disabled={isRunning} onClick={onSubmit}>
                  {isRunning ? '执行中...' : '发送'}
                </button>
              </div>
            </div>
            {error ? <div className="error-banner">{error}</div> : null}
          </div>
        </div>
      </div>

      <aside className="inspector-column">
        <section className="inspector-card">
          <div className="section-title">审批中心</div>
          {agentTask?.pendingApproval ? (
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
          ) : (
            <p className="muted">当前没有待审批动作。</p>
          )}
        </section>

        <section className="inspector-card">
          <div className="section-title">任务树</div>
          <TaskTreeView nodes={displayedTaskTree} />
        </section>

        <section className="inspector-card">
          <div className="section-title">执行时间线</div>
          {displayedToolEvents.length === 0 ? (
            <p className="muted">还没有工具执行记录。</p>
          ) : (
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
          )}
        </section>

        <section className="inspector-card">
          <div className="section-title">运行策略</div>
          <div className="policy-grid">
            <label className="toggle-inline">
              <input
                checked={settings.enableMultiAgent}
                onChange={event => onPolicyChange('enableMultiAgent', event.target.checked)}
                type="checkbox"
              />
              Multi-Agent
            </label>
            <label className="toggle-inline">
              <input
                checked={settings.enableComputerUse}
                onChange={event => onPolicyChange('enableComputerUse', event.target.checked)}
                type="checkbox"
              />
              Computer Use
            </label>
            <label className="toggle-inline">
              <input
                checked={settings.enableChromeAutomation}
                onChange={event =>
                  onPolicyChange('enableChromeAutomation', event.target.checked)
                }
                type="checkbox"
              />
              Chrome
            </label>
            <label className="toggle-inline">
              <input
                checked={settings.autoApproveShell}
                onChange={event => onPolicyChange('autoApproveShell', event.target.checked)}
                type="checkbox"
              />
              Auto Shell
            </label>
            <label className="toggle-inline">
              <input
                checked={settings.autoApproveFileWrite}
                onChange={event =>
                  onPolicyChange('autoApproveFileWrite', event.target.checked)
                }
                type="checkbox"
              />
              Auto Write
            </label>
          </div>
        </section>
      </aside>
    </section>
  )
}
