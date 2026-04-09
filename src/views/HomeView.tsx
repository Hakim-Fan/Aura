/*
 * @Author: Haki fanhuaze_1114@126.com
 * @Date: 2026-04-05 00:15:25
 * @LastEditors: Haki fanhuaze_1114@126.com
 * @LastEditTime: 2026-04-06 12:11:42
 * @FilePath: /desk-agent/src/views/HomeView.tsx
 * @Description: 这是默认设置,请设置`customMade`, 打开koroFileHeader查看配置 进行设置: https://github.com/OBKoro1/koro1FileHeader/wiki/%E9%85%8D%E7%BD%AE
 */
import { Plus, Settings2, Sparkles } from 'lucide-react'

type Props = {
  providerConfigured: boolean
  workspaceConfigured: boolean
  onNewSession: () => void
  onOpenProviders: () => void
  onOpenSettings: () => void
}

export function HomeView({
  providerConfigured,
  workspaceConfigured,
  onNewSession,
  onOpenProviders,
  onOpenSettings,
}: Props) {
  return (
    <section className="hero-shell custom-scrollbar">
      {/* Top drag region spacer */}
      <div className="absolute top-0 h-10 w-full shrink-0 bg-red" data-tauri-drag-region />

      <div className="hero-card modern">
        <div className="hero-badge">Aura Beta</div>
        <h2>你好，我是 Aura</h2>
        <p className="hero-copy">
          一切准备就绪。唤起 Aura 融入工作区，帮你梳理复杂信息、处理日常事务，或者解答任何疑问。
        </p>

        <div className="hero-actions">
          <button className="primary-button wide shadow-md" onClick={onNewSession}>
            <Plus size={18} />
            <span>新会话</span>
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
    </section>
  )
}
