import { useEffect, useState } from 'react'
import { listen } from '@tauri-apps/api/event'
import { broadcastSettingsUpdated, closeCurrentWindow, getEditingMcpServerId } from './lib/windows'
import { loadSettings, saveSettings } from './lib/storage'
import type { McpServerConfig } from './types'

function createId() {
  return Math.random().toString(36).slice(2, 10)
}

function createEmptyServer(): McpServerConfig {
  return {
    id: createId(),
    name: 'new-mcp',
    command: '',
    args: '',
    env: '{}',
    cwd: '',
    enabled: true,
  }
}

export function McpEditorWindowApp() {
  const [editingServerId, setEditingServerId] = useState<string | null>(() =>
    getEditingMcpServerId(),
  )
  const [server, setServer] = useState<McpServerConfig>(() => {
    const settings = loadSettings()
    const serverId = getEditingMcpServerId()
    return settings.mcpServers.find(entry => entry.id === serverId) || createEmptyServer()
  })
  const [saveState, setSaveState] = useState('')

  useEffect(() => {
    let unlistenOpen: (() => void) | undefined

    void (async () => {
      unlistenOpen = await listen<{ serverId: string | null }>('mcp-editor:open', event => {
        const nextServerId = event.payload.serverId
        const settings = loadSettings()
        setEditingServerId(nextServerId)
        setServer(
          settings.mcpServers.find(entry => entry.id === nextServerId) || createEmptyServer(),
        )
      })
    })()

    return () => {
      unlistenOpen?.()
    }
  }, [])

  async function saveServer() {
    const settings = loadSettings()
    const nextServers = editingServerId
      ? settings.mcpServers.map(entry => (entry.id === editingServerId ? server : entry))
      : [...settings.mcpServers, server]

    saveSettings({
      ...settings,
      mcpServers: nextServers,
    })
    setSaveState('已保存')
    await broadcastSettingsUpdated()
    await closeCurrentWindow()
  }

  async function deleteServer() {
    if (!editingServerId) {
      await closeCurrentWindow()
      return
    }

    const settings = loadSettings()
    saveSettings({
      ...settings,
      mcpServers: settings.mcpServers.filter(entry => entry.id !== editingServerId),
    })
    await broadcastSettingsUpdated()
    await closeCurrentWindow()
  }

  return (
    <div className="editor-window-shell">
      <section className="section-shell editor-card">
        <header className="section-header">
          <div>
            <div className="eyebrow">MCP Server</div>
            <h2>{editingServerId ? '编辑 MCP Server' : '新增 MCP Server'}</h2>
          </div>
          {saveState ? <span className="micro-pill">{saveState}</span> : null}
        </header>

        <div className="form-grid">
          <label>
            名称
            <input
              value={server.name}
              onChange={event => setServer(current => ({ ...current, name: event.target.value }))}
            />
          </label>

          <label>
            Command
            <input
              value={server.command}
              onChange={event =>
                setServer(current => ({ ...current, command: event.target.value }))
              }
              placeholder="npx"
            />
          </label>

          <label>
            Args
            <input
              value={server.args}
              onChange={event => setServer(current => ({ ...current, args: event.target.value }))}
              placeholder="-y @modelcontextprotocol/server-filesystem /path"
            />
          </label>

          <label>
            Cwd
            <input
              value={server.cwd}
              onChange={event => setServer(current => ({ ...current, cwd: event.target.value }))}
              placeholder="可选，留空时继承当前会话工作目录"
            />
          </label>

          <label>
            Env (JSON)
            <textarea
              rows={8}
              value={server.env}
              onChange={event => setServer(current => ({ ...current, env: event.target.value }))}
            />
          </label>

          <label className="toggle-inline">
            <input
              checked={server.enabled}
              onChange={event =>
                setServer(current => ({ ...current, enabled: event.target.checked }))
              }
              type="checkbox"
            />
            启用这个 MCP Server
          </label>
        </div>

        <footer className="settings-window-footer">
          <div className="header-actions">
            {editingServerId ? (
              <button className="ghost-danger" onClick={() => void deleteServer()}>
                删除
              </button>
            ) : null}
            <button className="secondary-button" onClick={() => void closeCurrentWindow()}>
              取消
            </button>
            <button className="primary-button" onClick={() => void saveServer()}>
              保存
            </button>
          </div>
        </footer>
      </section>
    </div>
  )
}
