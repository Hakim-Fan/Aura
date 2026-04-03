import { getInitialSettingsTab, getWindowKind } from './lib/windows'
import { MainWindowApp } from './MainWindowApp'
import { McpEditorWindowApp } from './McpEditorWindowApp'
import { SettingsWindowApp } from './SettingsWindowApp'

export default function App() {
  const windowKind = getWindowKind()

  if (windowKind === 'settings') {
    return <SettingsWindowApp initialTab={getInitialSettingsTab()} />
  }

  if (windowKind === 'mcp-editor') {
    return <McpEditorWindowApp />
  }

  return <MainWindowApp />
}
