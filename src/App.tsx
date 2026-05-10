import { getInitialSettingsTab, getWindowKind } from './lib/windows'
import { LogViewerWindowApp } from './LogViewerWindowApp'
import { MainWindowApp } from './MainWindowApp'
import { McpEditorWindowApp } from './McpEditorWindowApp'
import { SettingsWindowApp } from './SettingsWindowApp'

export default function App() {
  const windowKind = getWindowKind()

  // Splash dismiss is handled by each WindowApp after full hydration.
  // See index.html for the splash screen and window.__dismissSplash().

  if (windowKind === 'settings') {
    return <SettingsWindowApp initialTab={getInitialSettingsTab()} />
  }

  if (windowKind === 'mcp-editor') {
    return <McpEditorWindowApp />
  }

  if (windowKind === 'log-viewer') {
    return <LogViewerWindowApp />
  }

  return <MainWindowApp />
}
