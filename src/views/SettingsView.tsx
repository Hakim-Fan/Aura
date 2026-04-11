import type { ReactNode } from 'react'

export type SettingsTab = 'general' | 'providers' | 'browser' | 'mcp' | 'skills' | 'plugins'

const tabs: Array<{ id: SettingsTab; label: string }> = [
  { id: 'general', label: '通用' },
  { id: 'providers', label: '提供商' },
  { id: 'browser', label: '浏览器' },
  { id: 'mcp', label: 'MCP' },
  { id: 'skills', label: '技能' },
  { id: 'plugins', label: '插件' },
]

type Props = {
  activeTab: SettingsTab
  onSelectTab: (tab: SettingsTab) => void
  children: ReactNode
}

export function SettingsView({ activeTab, onSelectTab, children }: Props) {
  return (
    <section className="settings-shell">
      <header className="settings-header">
        <div>
          <div className="eyebrow">Settings</div>
          <h2>设置</h2>
        </div>
      </header>

      <div className="settings-tabs">
        {tabs.map(tab => (
          <button
            key={tab.id}
            className={tab.id === activeTab ? 'settings-tab active' : 'settings-tab'}
            onClick={() => onSelectTab(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div className="settings-content">{children}</div>
    </section>
  )
}
