import type { Session } from '../types'

type Props = {
  sessionFilter: string
  onSessionFilterChange: (value: string) => void
  sessions: Session[]
  activeSessionId: string | null
  onOpenSession: (sessionId: string) => void
  onCreateSession: () => void
  onOpenSettings: () => void
  settingsOpen: boolean
}

export function AppSidebar({
  sessionFilter,
  onSessionFilterChange,
  sessions,
  activeSessionId,
  onOpenSession,
  onCreateSession,
  onOpenSettings,
  settingsOpen,
}: Props) {
  return (
    <aside className="nav-shell">
      <div className="sidebar-header">
        <div>
          <div className="eyebrow">Sessions</div>
          <h2 className="sidebar-title">会话</h2>
        </div>
        <button className="top-icon" onClick={onCreateSession}>
          +
        </button>
      </div>

      <div className="session-search">
        <input
          value={sessionFilter}
          onChange={event => onSessionFilterChange(event.target.value)}
          placeholder="搜索会话..."
        />
      </div>

      <div className="session-pane">
        {sessions.map(session => (
          <button
            key={session.id}
            className={session.id === activeSessionId ? 'session-card active' : 'session-card'}
            onClick={() => onOpenSession(session.id)}
          >
            <span>{session.title}</span>
            <small>{new Date(session.updatedAt).toLocaleDateString()}</small>
          </button>
        ))}
      </div>

      <div className="sidebar-footer">
        <button
          className={settingsOpen ? 'mini-ghost active-settings' : 'mini-ghost'}
          onClick={onOpenSettings}
        >
          设置
        </button>
      </div>
    </aside>
  )
}
