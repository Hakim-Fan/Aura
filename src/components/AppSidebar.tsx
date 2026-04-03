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
        <div>
          <div className="eyebrow">Desk Agent</div>
          <h2 className="sidebar-title">会话</h2>
        </div>
        <button className="sidebar-action-button" onClick={onCreateSession}>
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
            <button className="session-row-button" onClick={() => onOpenSession(session.id)}>
              <div className="session-row-title">{session.title}</div>
              <div className="session-row-meta">
                <span>{new Date(session.updatedAt).toLocaleDateString()}</span>
                <span>{session.model.split('/').filter(Boolean).at(-1) || 'Model'}</span>
              </div>
            </button>
            <button
              className="session-row-delete"
              aria-label={`删除会话 ${session.title}`}
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
        >
          <Settings2 size={15} />
          <span>设置</span>
        </button>
      </div>
    </aside>
  )
}
