import type { Session } from '../types'

type Props = {
  sessions: Session[]
  providerConfigured: boolean
  workspaceConfigured: boolean
  onOpenSession: (sessionId: string) => void
  onNewSession: () => void
  onOpenProviders: () => void
  onOpenSettings: () => void
}

export function HomeView({
  sessions,
  providerConfigured,
  workspaceConfigured,
  onOpenSession,
  onNewSession,
  onOpenProviders,
  onOpenSettings,
}: Props) {
  return (
    <section className="hero-shell">
      <div className="hero-card">
        <div className="hero-mark">DA</div>
        <h2>Desk Agent</h2>
        <p className="hero-copy">
          本地优先的桌面 Agent。先配置模型提供商和工作目录，再开始真实会话。
        </p>
        <div className="hero-actions">
          <button className="primary-button wide" onClick={onNewSession}>
            新建聊天
          </button>
          <button className="secondary-button" onClick={onOpenProviders}>
            配置提供商
          </button>
          <button className="secondary-button" onClick={onOpenSettings}>
            设置
          </button>
        </div>
        <p className="muted">
          {providerConfigured && workspaceConfigured
            ? '基础配置已完成，可以直接开始会话。'
            : '请先完成基础配置。'}
        </p>
      </div>

      <div className="hero-grid">
        <section className="dashboard-card">
          <div className="section-title">准备状态</div>
          <div className="dashboard-list">
            <div className="dashboard-row">
              <strong>提供商</strong>
              <span>{providerConfigured ? '已配置' : '未配置'}</span>
            </div>
            <div className="dashboard-row">
              <strong>工作目录</strong>
              <span>{workspaceConfigured ? '已选择' : '未选择'}</span>
            </div>
          </div>
        </section>

        <section className="dashboard-card">
          <div className="section-title">最近会话</div>
          <div className="dashboard-list">
            {sessions.length > 0 ? (
              sessions.slice(0, 5).map(session => (
                <button
                  key={session.id}
                  className="dashboard-row"
                  onClick={() => onOpenSession(session.id)}
                >
                  <strong>{session.title}</strong>
                  <span>{new Date(session.updatedAt).toLocaleString()}</span>
                </button>
              ))
            ) : (
              <p className="muted">还没有真实会话记录。</p>
            )}
          </div>
        </section>
      </div>
    </section>
  )
}
