import { emit, emitTo } from '@tauri-apps/api/event'
import { WebviewWindow, getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'
import type { SettingsTab } from '../views/SettingsView'
import { openPathInDefaultApp } from './workspace'
import { loadSettings } from './storage'

export type WindowKind = 'main' | 'settings' | 'mcp-editor' | 'log-viewer'

const SETTINGS_WINDOW_LABEL = 'settings'
const MCP_EDITOR_WINDOW_LABEL = 'mcp-editor'
const LOG_VIEWER_WINDOW_LABEL = 'log-viewer'

function createWindowUrl(search: string) {
  return `${window.location.origin}/${search}`
}

export function getWindowKind(): WindowKind {
  const params = new URLSearchParams(window.location.search)
  const kind = params.get('window')
  if (kind === 'settings' || kind === 'mcp-editor' || kind === 'log-viewer') {
    return kind
  }
  return 'main'
}

export function getInitialSettingsTab(): SettingsTab {
  const params = new URLSearchParams(window.location.search)
  const tab = params.get('tab')
  if (
    tab === 'general' ||
    tab === 'providers' ||
    tab === 'browser' ||
    tab === 'mcp' ||
    tab === 'skills' ||
    tab === 'plugins'
  ) {
    return tab
  }
  return 'general'
}

export function getEditingMcpServerId(): string | null {
  const params = new URLSearchParams(window.location.search)
  return params.get('serverId')
}

export async function openSettingsWindow(tab: SettingsTab = 'general') {
  const existing = await WebviewWindow.getByLabel(SETTINGS_WINDOW_LABEL)
  if (existing) {
    await emitTo(SETTINGS_WINDOW_LABEL, 'settings:open-tab', tab)
    await existing.show()
    await existing.setFocus()
    return
  }

  const next = new WebviewWindow(SETTINGS_WINDOW_LABEL, {
    title: '设置',
    width: 900,
    height: 720,
    minWidth: 800,
    minHeight: 600,
    resizable: true,
    url: createWindowUrl(`?window=settings&tab=${tab}`),
  })

  next.once('tauri://created', async () => {
    await emitTo(SETTINGS_WINDOW_LABEL, 'settings:open-tab', tab)
  })
}

export async function openMcpEditorWindow(serverId?: string) {
  const existing = await WebviewWindow.getByLabel(MCP_EDITOR_WINDOW_LABEL)
  const query = serverId ? `&serverId=${serverId}` : ''

  if (existing) {
    await emitTo(MCP_EDITOR_WINDOW_LABEL, 'mcp-editor:open', {
      serverId: serverId || null,
    })
    await existing.show()
    await existing.setFocus()
    return
  }

  const next = new WebviewWindow(MCP_EDITOR_WINDOW_LABEL, {
    title: serverId ? '编辑 MCP Server' : '新增 MCP Server',
    width: 680,
    height: 740,
    minWidth: 600,
    minHeight: 580,
    resizable: true,
    url: createWindowUrl(`?window=mcp-editor${query}`),
  })

  next.once('tauri://created', async () => {
    await emitTo(MCP_EDITOR_WINDOW_LABEL, 'mcp-editor:open', {
      serverId: serverId || null,
    })
  })
}

export async function openLogViewerWindow() {
  const existing = await WebviewWindow.getByLabel(LOG_VIEWER_WINDOW_LABEL)
  if (existing) {
    await emitTo(LOG_VIEWER_WINDOW_LABEL, 'log-viewer:reset-live')
    await existing.show()
    await existing.setFocus()
    return
  }

  new WebviewWindow(LOG_VIEWER_WINDOW_LABEL, {
    title: '日志看板',
    width: 1120,
    height: 760,
    minWidth: 900,
    minHeight: 620,
    resizable: true,
    url: createWindowUrl('?window=log-viewer'),
  })
}

export async function openWorkspaceFolder(path?: string) {
  const target = path?.trim() || loadSettings().cwd.trim()
  if (target) {
    await openPathInDefaultApp(target)
  }
}

export async function closeCurrentWindow() {
  await getCurrentWebviewWindow().close()
}

export async function broadcastSettingsUpdated() {
  await emit('settings:updated')
}
