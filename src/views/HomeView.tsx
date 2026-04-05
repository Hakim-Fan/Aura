import { ArrowUpRight, FolderOpen, Plus, Settings2, Sparkles } from 'lucide-react'
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
    <section className="hero-shell custom-scrollbar">
      {/* Top drag region spacer */}
      <div className="h-10 w-full shrink-0" data-tauri-drag-region />

      <div className="hero-card modern">
        <div className="hero-badge">Aura Beta</div>
        <h2>开发者桌面 Agent</h2>
        <p className="hero-copy">
          本地工作区、模型配置和工具执行全部收纳在一个现代化的桌面工作台里。你可以直接开始对话，或者检查环境状态。
        </p>

        <div className="hero-actions">
          <button className="primary-button wide shadow-md" onClick={onNewSession}>
            <Plus size={18} />
            <span>新建聊天</span>
          </button>
          <button className="secondary-button" onClick={onOpenProviders}>
            <Sparkles size={16} />
            <span>配置提供商</span>
          </button>
          <button className="secondary-button" onClick={onOpenSettings} title="设置">
            <Settings2 size={16} />
          </button>
        </div>

        <div className="hero-status-row">
          <div className={providerConfigured ? 'status-chip success' : 'status-chip'}>
            Provider {providerConfigured ? '已配置' : '未配置'}
          </div>
          <div className={workspaceConfigured ? 'status-chip success' : 'status-chip'}>
            Workspace {workspaceConfigured ? '已就绪' : '未连接'}
          </div>
        </div>
      </div>

      <div className="hero-grid">
        <section className="dashboard-card">
          <div className="section-title flex items-center gap-2">
            <Sparkles size={14} className="text-amber-500" />
            快速开始
          </div>
          <div className="suggestion-prompt-grid home">
            {suggestedPrompts.map(prompt => (
              <button key={prompt} className="suggestion-card static group" onClick={onNewSession}>
                <div className="flex-1 truncate">{prompt}</div>
                <ArrowUpRight size={14} className="opacity-0 group-hover:opacity-100 transition-opacity" />
              </button>
            ))}
          </div>
        </section>

        <section className="dashboard-card">
          <div className="section-title flex items-center gap-2">
            <FolderOpen size={14} className="text-blue-500" />
            最近会话
          </div>
          <div className="dashboard-list">
            {sessions.length > 0 ? (
              sessions.slice(0, 5).map(session => (
                <button
                  key={session.id}
                  className="dashboard-row modern group"
                  onClick={() => onOpenSession(session.id)}
                >
                  <div className="min-w-0 flex-1">
                    <strong className="truncate">{session.title}</strong>
                    <span>{new Date(session.updatedAt).toLocaleString('zh-CN', { hour: '2-digit', minute: '2-digit', month: 'short', day: 'numeric' })}</span>
                  </div>
                  <ArrowUpRight size={14} className="shrink-0 opacity-0 group-hover:opacity-40 transition-opacity" />
                </button>
              ))
            ) : (
              <div className="py-10 text-center flex flex-col items-center gap-2">
                <div className="w-10 h-10 rounded-full bg-gray-50 flex items-center justify-center text-gray-300">
                  <Plus size={20} />
                </div>
                <p className="muted text-12px">还没有任何真实会话记录</p>
              </div>
            )}
          </div>
        </section>
      </div>
    </section>
  )
}
