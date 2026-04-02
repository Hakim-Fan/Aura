import type { Session } from '../types'

type NavItem = {
  id: string
  label: string
  glyph: string
}

type Props = {
  navItems: NavItem[]
  activeView: string
  onSelectView: (viewId: string) => void
  sessionFilter: string
  onSessionFilterChange: (value: string) => void
  sessions: Session[]
  activeSessionId: string
  onOpenSession: (sessionId: string) => void
  onOpenHome: () => void
}

export function AppSidebar({
  navItems,
  activeView,
  onSelectView,
  sessionFilter,
  onSessionFilterChange,
  sessions,
  activeSessionId,
  onOpenSession,
  onOpenHome,
}: Props) {
  return (
    <aside className="nav-shell">
      <div className="sidebar-topbar">
        <button className="top-icon">[]</button>
        <button className="top-icon">/</button>
        <button className="top-icon">+</button>
      </div>

      <nav className="nav-list">
        {navItems.map(item => (
          <button
            key={item.id}
            className={item.id === activeView ? 'nav-item active' : 'nav-item'}
            onClick={() => onSelectView(item.id)}
          >
            <span className="nav-glyph">{item.glyph}</span>
            <span>{item.label}</span>
          </button>
        ))}
      </nav>

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
        <button className="mini-ghost" onClick={onOpenHome}>
          ...
        </button>
        <span className="update-pill">更新</span>
      </div>
    </aside>
  )
}
