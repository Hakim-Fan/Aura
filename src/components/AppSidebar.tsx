import { Plus, Search, Settings2, Trash2 } from 'lucide-react'
import type { Session } from '../types'

type Props = {
  sessionFilter: string
  onSessionFilterChange: (value: string) => void
  sessions: Session[]
  activeSessionId: string | null
  onOpenSession: (sessionId: string) => void
  onCreateSession: () => void
  onDeleteSession: (sessionId: string) => void
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
  onDeleteSession,
  onOpenSettings,
  settingsOpen,
}: Props) {
  return (
    <aside className="nav-shell">
      <div className="sidebar-header">
        <div className="sidebar-brand">
          <div className="eyebrow">Desk Agent</div>
        </div>
        <button className="sidebar-action-button" onClick={onCreateSession} title="新建会话">
          <Plus size={16} />
        </button>
      </div>

      <div className="session-search modern">
        <Search size={15} />
        <input
          value={sessionFilter}
          onChange={event => onSessionFilterChange(event.target.value)}
          placeholder="搜索会话..."
        />
      </div>

      <div className="session-pane">
        {sessions.map(session => (
          <article
            key={session.id}
            className={session.id === activeSessionId ? 'session-row active' : 'session-row'}
          >
            <button
              className="session-row-button"
              onClick={() => onOpenSession(session.id)}
              title={session.title}
            >
              <div className="session-row-title">{session.title}</div>
              <div className="session-row-meta">
                <span>{new Date(session.updatedAt).toLocaleDateString()}</span>
              </div>
            </button>
            <button
              className="session-row-delete"
              aria-label={`删除会话 ${session.title}`}
              title="删除会话"
              onClick={() => onDeleteSession(session.id)}
            >
              <Trash2 size={14} />
            </button>
          </article>
        ))}
      </div>

      <div className="sidebar-footer">
        <button
          className={settingsOpen ? 'sidebar-utility-button active-settings' : 'sidebar-utility-button'}
          onClick={onOpenSettings}
          title="设置"
        >
          <Settings2 size={15} />
        </button>
      </div>
    </aside>
  )
}
