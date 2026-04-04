import { useLayoutEffect } from 'react'
import { getInitialSettingsTab, getWindowKind } from './lib/windows'
import { MainWindowApp } from './MainWindowApp'
import { McpEditorWindowApp } from './McpEditorWindowApp'
import { SettingsWindowApp } from './SettingsWindowApp'

export default function App() {
  const windowKind = getWindowKind()

  // Anti-FOUC: reveal UI after React has mounted and UnoCSS styles are applied
  useLayoutEffect(() => {
    requestAnimationFrame(() => {
      document.getElementById('root')?.classList.add('ready')
    })
  }, [])

  if (windowKind === 'settings') {
    return <SettingsWindowApp initialTab={getInitialSettingsTab()} />
  }

  if (windowKind === 'mcp-editor') {
    return <McpEditorWindowApp />
  }

  return <MainWindowApp />
}
