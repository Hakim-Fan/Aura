import type { AgentSettings, Session } from '../types'

const SETTINGS_KEY = 'desk-agent-settings-v1'
const SESSIONS_KEY = 'desk-agent-sessions-v1'

export const defaultSettings: AgentSettings = {
  provider: 'anthropic',
  apiKey: '',
  baseUrl: 'https://api.anthropic.com',
  model: 'claude-sonnet-4-20250514',
  cwd: '/Users/fanhuaze/Documents/YunWork/desk-agent',
  maxSteps: 8,
  enableMultiAgent: true,
  enableComputerUse: true,
  enableChromeAutomation: true,
  autoApproveShell: false,
  autoApproveFileWrite: false,
  autoApproveComputerUse: false,
  autoApproveChromeAutomation: false,
  enabledSkillIds: ['repair-planner', 'desktop-operator'],
  enabledPluginIds: ['workspace-inspector'],
  mcpServers: [],
}

export function loadSettings(): AgentSettings {
  const raw = localStorage.getItem(SETTINGS_KEY)
  if (!raw) {
    return defaultSettings
  }

  try {
    return {
      ...defaultSettings,
      ...JSON.parse(raw),
    } as AgentSettings
  } catch {
    return defaultSettings
  }
}

export function saveSettings(settings: AgentSettings) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings))
}

export function loadSessions(): Session[] {
  const raw = localStorage.getItem(SESSIONS_KEY)
  if (!raw) {
    return []
  }

  try {
    const parsed = JSON.parse(raw) as Session[]
    return parsed.sort((a, b) => b.updatedAt - a.updatedAt)
  } catch {
    return []
  }
}

export function saveSessions(sessions: Session[]) {
  localStorage.setItem(SESSIONS_KEY, JSON.stringify(sessions))
}
