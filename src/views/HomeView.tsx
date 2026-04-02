import type { Session } from '../types'

type Capability = {
  title: string
  status: string
  detail: string
}

type Props = {
  sessions: Session[]
  capabilities: Capability[]
  onOpenSession: (sessionId: string) => void
  onNewSession: () => void
  onOpenProviders: () => void
  onOpenChat: () => void
}

export function HomeView({
  sessions,
  capabilities,
  onOpenSession,
  onNewSession,
  onOpenProviders,
  onOpenChat,
}: Props) {
  return (
    <section className="hero-shell">
      <div className="hero-card">
        <div className="hero-mark">DA</div>
        <h2>Desk Agent</h2>
        <p className="hero-copy">
          本地优先的 AI Agent 桌面应用，支持 Provider、MCP、Skills、Plugins、多 Agent 和桌面自动化。
        </p>
        <div className="hero-actions">
          <button className="primary-button wide" onClick={onNewSession}>
            新建聊天
          </button>
          <button className="secondary-button" onClick={onOpenProviders}>
            配置提供商
          </button>
          <button className="secondary-button" onClick={onOpenChat}>
            打开工作台
          </button>
        </div>
        <p className="muted">请至少配置一个 AI 提供商以开始聊天。</p>
      </div>

      <div className="hero-grid">
        <section className="dashboard-card">
          <div className="section-title">最近会话</div>
          <div className="dashboard-list">
            {sessions.slice(0, 5).map(session => (
              <button
                key={session.id}
                className="dashboard-row"
                onClick={() => onOpenSession(session.id)}
              >
                <strong>{session.title}</strong>
                <span>{new Date(session.updatedAt).toLocaleString()}</span>
              </button>
            ))}
          </div>
        </section>

        <section className="dashboard-card">
          <div className="section-title">能力地图</div>
          <div className="dashboard-list">
            {capabilities.slice(0, 4).map(capability => (
              <article key={capability.title} className="capability-mini">
                <div className="inline-between">
                  <strong>{capability.title}</strong>
                  <span className="micro-pill">{capability.status}</span>
                </div>
                <p>{capability.detail}</p>
              </article>
            ))}
          </div>
        </section>
      </div>
    </section>
  )
}
