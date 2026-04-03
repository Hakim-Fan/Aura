import { FolderOpen, Plus, Settings2, Sparkles } from 'lucide-react'
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

const suggestedPrompts = [
  '分析这个项目的目录结构和关键模块',
  '帮我定位一个报错并给出修复建议',
  '生成一个新功能的实施计划',
  '解释当前仓库的启动流程',
]

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
      <div className="hero-card modern">
        <div className="hero-badge">Desk Agent</div>
        <h2>开发者桌面 Agent</h2>
        <p className="hero-copy">
          本地工作区、模型配置和工具执行全部收纳在一个桌面工作台里。你可以直接开始对话，也可以先检查环境状态。
        </p>
        <div className="hero-actions">
          <button className="primary-button wide" onClick={onNewSession}>
            <Plus size={16} />
            新建聊天
          </button>
          <button className="secondary-button" onClick={onOpenProviders}>
            <Sparkles size={16} />
            配置提供商
          </button>
          <button className="secondary-button" onClick={onOpenSettings}>
            <Settings2 size={16} />
            设置
          </button>
        </div>
        <div className="hero-status-row">
          <span className={providerConfigured ? 'status-chip success' : 'status-chip'}>
            Provider {providerConfigured ? '已配置' : '未配置'}
          </span>
          <span className={workspaceConfigured ? 'status-chip success' : 'status-chip'}>
            Workspace {workspaceConfigured ? '已连接' : '未连接'}
          </span>
        </div>
      </div>

      <div className="hero-grid">
        <section className="dashboard-card">
          <div className="section-title">快速开始</div>
          <div className="suggestion-prompt-grid home">
            {suggestedPrompts.map(prompt => (
              <button key={prompt} className="suggestion-card static" onClick={onNewSession}>
                <Sparkles size={15} />
                <span>{prompt}</span>
              </button>
            ))}
          </div>
        </section>

        <section className="dashboard-card">
          <div className="section-title">最近会话</div>
          <div className="dashboard-list">
            {sessions.length > 0 ? (
              sessions.slice(0, 5).map(session => (
                <button
                  key={session.id}
                  className="dashboard-row modern"
                  onClick={() => onOpenSession(session.id)}
                >
                  <div>
                    <strong>{session.title}</strong>
                    <span>{new Date(session.updatedAt).toLocaleString()}</span>
                  </div>
                  <FolderOpen size={14} />
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
