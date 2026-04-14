import { useEffect, useState } from 'react'
import { listen } from '@tauri-apps/api/event'
import { Check, RefreshCw } from 'lucide-react'
import {
  inspectMcpServer,
  parseMcpImportJson,
  type McpFieldErrors,
  type McpInspectResult,
  validateMcpServerInput,
} from './lib/mcp'
import { broadcastSettingsUpdated, closeCurrentWindow, getEditingMcpServerId } from './lib/windows'
import {
  hydrateStorageFromAuraHome,
  loadSettings,
  saveSettingsAndAwaitPersistence,
} from './lib/storage'
import type { McpServerConfig } from './types'

function createId() {
  return Math.random().toString(36).slice(2, 10)
}

function createEmptyServer(): McpServerConfig {
  return {
    id: createId(),
    name: 'new-mcp',
    description: '',
    command: '',
    args: '',
    env: '{}',
    cwd: '',
    enabled: false,
    healthStatus: 'unknown',
    healthMessage: '',
    toolCount: 0,
  }
}

function markServerUnvalidated(server: McpServerConfig): McpServerConfig {
  return {
    ...server,
    enabled: false,
    healthStatus: 'unknown',
    healthMessage: '',
    lastCheckedAt: undefined,
    toolCount: 0,
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
  const [isTesting, setIsTesting] = useState(false)
  const [testResult, setTestResult] = useState<{
    tone: 'success' | 'error'
    message: string
    tools: McpInspectResult['tools']
  } | null>(null)
  const [fieldErrors, setFieldErrors] = useState<McpFieldErrors>({})
  const [importJson, setImportJson] = useState('')
  const [importState, setImportState] = useState<{
    tone: 'success' | 'error'
    message: string
  } | null>(null)

  useEffect(() => {
    let unlistenOpen: (() => void) | undefined

    void (async () => {
      try {
        const hydrated = await hydrateStorageFromAuraHome()
        const serverId = getEditingMcpServerId()
        setEditingServerId(serverId)
        setFieldErrors({})
        setImportState(null)
        setImportJson('')
        setServer(
          hydrated.settings.mcpServers.find(entry => entry.id === serverId) || createEmptyServer(),
        )
      } catch {
        // Continue with cached settings if Aura hydration is unavailable.
      }

      unlistenOpen = await listen<{ serverId: string | null }>('mcp-editor:open', event => {
        const nextServerId = event.payload.serverId
        const settings = loadSettings()
        setEditingServerId(nextServerId)
        setTestResult(null)
        setFieldErrors({})
        setImportState(null)
        setImportJson('')
        setServer(
          settings.mcpServers.find(entry => entry.id === nextServerId) || createEmptyServer(),
        )
      })
    })()

    return () => {
      unlistenOpen?.()
    }
  }, [])

  function updateServer(nextServer: McpServerConfig) {
    setServer(nextServer)
    setSaveState('')
    setTestResult(null)
    setFieldErrors({})
  }

  function getValidationResult(target: McpServerConfig) {
    const result = validateMcpServerInput(target)
    setFieldErrors(result.errors)
    if (!result.isValid && result.firstMessage) {
      setTestResult({
        tone: 'error',
        message: result.firstMessage,
        tools: [],
      })
    }
    return result
  }

  async function validateServer(
    target: McpServerConfig,
    options?: {
      enableOnSuccess?: boolean
    },
  ) {
    try {
      const result = await inspectMcpServer(target)
      const nextServer = {
        ...target,
        enabled: options?.enableOnSuccess ? true : target.enabled,
        healthStatus: 'ok' as const,
        healthMessage: result.message,
        lastCheckedAt: Date.now(),
        toolCount: result.tools.length,
      }

      setTestResult({
        tone: 'success',
        message: result.message,
        tools: result.tools,
      })
      setServer(nextServer)
      return nextServer
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : 'MCP 连接测试失败。'
      const nextServer = {
        ...target,
        enabled: false,
        healthStatus: 'error' as const,
        healthMessage: message,
        lastCheckedAt: Date.now(),
        toolCount: 0,
      }

      setTestResult({
        tone: 'error',
        message,
        tools: [],
      })
      setServer(nextServer)
      return nextServer
    }
  }

  async function saveServer() {
    const validation = getValidationResult(server)
    if (!validation.isValid) {
      return
    }

    const settings = loadSettings()
    let nextServer: McpServerConfig = {
      ...server,
      healthStatus:
        server.healthStatus === 'ok' || server.healthStatus === 'error'
          ? server.healthStatus
          : 'unknown',
      healthMessage: server.healthMessage || '',
      toolCount: server.toolCount || 0,
    }

    if (nextServer.enabled) {
      setIsTesting(true)
      nextServer = await validateServer(nextServer, {
        enableOnSuccess: true,
      })
      setIsTesting(false)
    } else {
      nextServer = {
        ...nextServer,
        enabled: false,
      }
    }

    const nextServers = editingServerId
      ? settings.mcpServers.map(entry => (entry.id === editingServerId ? nextServer : entry))
      : [...settings.mcpServers, nextServer]

    await saveSettingsAndAwaitPersistence({
      ...settings,
      mcpServers: nextServers,
    })
    setSaveState(nextServer.enabled ? '已保存' : '已保存为未启用')
    await broadcastSettingsUpdated()
    if (nextServer.enabled) {
      await closeCurrentWindow()
    }
  }

  async function deleteServer() {
    if (!editingServerId) {
      await closeCurrentWindow()
      return
    }

    const settings = loadSettings()
    await saveSettingsAndAwaitPersistence({
      ...settings,
      mcpServers: settings.mcpServers.filter(entry => entry.id !== editingServerId),
    })
    await broadcastSettingsUpdated()
    await closeCurrentWindow()
  }

  async function testServer() {
    const validation = getValidationResult(server)
    if (!validation.isValid) {
      return
    }

    setIsTesting(true)
    setTestResult(null)
    await validateServer(server)
    setIsTesting(false)
  }

  function importServerFromJson() {
    try {
      const { servers } = parseMcpImportJson(importJson)
      const [firstServer] = servers
      updateServer(
        markServerUnvalidated({
          ...server,
          name: firstServer.name,
          description: firstServer.description,
          command: firstServer.command,
          args: firstServer.args,
          env: firstServer.env,
          cwd: firstServer.cwd,
        }),
      )
      setImportState({
        tone: 'success',
        message:
          servers.length > 1
            ? `已解析 ${servers.length} 个 MCP 配置，当前编辑器先载入第一个：${firstServer.name}。`
            : `已从 JSON 填充 MCP：${firstServer.name}。`,
      })
    } catch (error) {
      setImportState({
        tone: 'error',
        message: error instanceof Error ? error.message : 'MCP JSON 导入失败。',
      })
    }
  }

  const premiumInputClass =
    'w-full px-4 py-2.5 rounded-xl border border-black/8 bg-white focus:border-black/20 focus:ring-4 focus:ring-black/2 transition-all duration-200 outline-none text-14px font-500 placeholder:text-black/20'
  const labelClass =
    'text-11px font-700 text-black/40 uppercase tracking-0.1em mb-1.5 px-1 block'
  const errorTextClass = 'mt-2 px-1 text-12px text-red-500'

  return (
    <div className="flex h-screen flex-col bg-[#f6f6f6] font-sans text-[#1a1a1a]">
      {/* Header - Fixed */}
      <header className="shrink-0 border-b border-black/5 bg-white/80 px-8 py-5 backdrop-blur-md">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-9px font-800 tracking-0.2em text-black/30 uppercase mb-1">
              Protocol Extension
            </p>
            <h2 className="text-18px font-700 tracking-tight text-black/80">
              {editingServerId ? '编辑 MCP Server' : '新增 MCP Server'}
            </h2>
          </div>
          {saveState ? (
            <span className="flex items-center gap-1.5 rounded-full bg-green-50 px-3 py-1 text-10px font-700 text-green-600 border border-green-100 animate-fade-in">
              <Check size={10} strokeWidth={3} />
              {saveState}
            </span>
          ) : (
            <div className={`h-2 w-2 rounded-full ${server.enabled ? 'bg-green-500 shadow-[0_0_8px_rgba(34,197,94,0.4)]' : 'bg-black/10'}`} />
          )}
        </div>
      </header>

      {/* Main Content - Scrollable */}
      <main className="flex-1 overflow-y-auto custom-scrollbar">
        <div className="mx-auto max-w-2xl px-6 py-8 pb-40">
          <div className="flex flex-col gap-7">
            {/* Form Fields */}
            <div className="grid grid-cols-1 gap-6">
              <div>
                <label className={labelClass}>JSON 导入</label>
                <textarea
                  rows={6}
                  className={`${premiumInputClass} font-mono !text-12px resize-none`}
                  value={importJson}
                  onChange={event => {
                    setImportJson(event.target.value)
                    setImportState(null)
                  }}
                  placeholder={`支持直接粘贴 MCP JSON，例如:\n{\n  "mcpServers": {\n    "ddg-search": {\n      "command": "uvx",\n      "args": ["duckduckgo-mcp-server"]\n    }\n  }\n}`}
                />
                <div className="mt-3 flex items-center gap-3">
                  <button
                    className="h-9 px-4 text-12px font-700 rounded-xl border border-black/8 text-black/60 hover:bg-black/4 transition-all"
                    type="button"
                    onClick={importServerFromJson}
                  >
                    从 JSON 填充
                  </button>
                  <span className="text-12px text-black/45">支持单个 server，或包含 mcpServers 的根对象。</span>
                </div>
                {importState ? (
                  <div
                    className={`mt-3 rounded-xl border px-4 py-3 text-12px ${
                      importState.tone === 'success'
                        ? 'border-green-100 bg-green-50/60 text-green-700'
                        : 'border-red-100 bg-red-50/60 text-red-700'
                    }`}
                  >
                    {importState.message}
                  </div>
                ) : null}
              </div>

              <div>
                <label className={labelClass}>名称</label>
                <input
                  className={premiumInputClass}
                  value={server.name}
                  onChange={event => updateServer({ ...server, name: event.target.value })}
                  placeholder="例如: filesystem"
                />
                {fieldErrors.name ? <div className={errorTextClass}>{fieldErrors.name}</div> : null}
              </div>

              <div>
                <label className={labelClass}>描述</label>
                <textarea
                  rows={2}
                  className={`${premiumInputClass} resize-none`}
                  value={server.description}
                  onChange={event => updateServer({ ...server, description: event.target.value })}
                  placeholder="例如: 检索最新文档、浏览器自动化、GitHub 操作等"
                />
              </div>

              <div>
                <label className={labelClass}>安装命令</label>
                <input
                  className={`${premiumInputClass} font-mono !text-12px`}
                  value={server.command}
                  onChange={event =>
                    updateServer(markServerUnvalidated({ ...server, command: event.target.value }))
                  }
                  placeholder="可直接填完整命令，例如: npx -y @upstash/context7-mcp@latest"
                />
                {fieldErrors.command ? (
                  <div className={errorTextClass}>{fieldErrors.command}</div>
                ) : null}
              </div>

              <div>
                <label className={labelClass}>参数</label>
                <textarea
                  rows={2}
                  className={`${premiumInputClass} font-mono !text-12px resize-none`}
                  value={server.args}
                  onChange={event =>
                    updateServer(markServerUnvalidated({ ...server, args: event.target.value }))
                  }
                  placeholder="可选；如果安装命令里已经写完整，这里可以留空"
                />
              </div>

              <div>
                <label className={labelClass}>环境变量</label>
                <textarea
                  rows={4}
                  className={`${premiumInputClass} font-mono !text-12px resize-none`}
                  value={server.env}
                  onChange={event =>
                    updateServer(markServerUnvalidated({ ...server, env: event.target.value }))
                  }
                  placeholder='{ "KEY": "VALUE" }'
                />
                {fieldErrors.env ? <div className={errorTextClass}>{fieldErrors.env}</div> : null}
              </div>

              <div>
                <label className={labelClass}>工作目录</label>
                <input
                  className={`${premiumInputClass} font-mono !text-12px`}
                  value={server.cwd}
                  onChange={event =>
                    updateServer(markServerUnvalidated({ ...server, cwd: event.target.value }))
                  }
                  placeholder="可选；留空则使用 Aura 默认环境"
                />
              </div>

              <div className="flex items-center gap-3 pt-2">
                <label className="relative flex cursor-pointer items-center gap-3 group">
                  <input
                    type="checkbox"
                    className="peer sr-only"
                    checked={server.enabled}
                    onChange={event =>
                      updateServer({ ...server, enabled: event.target.checked })
                    }
                  />
                  <div className="relative h-5 w-9 shrink-0 rounded-full bg-black/10 transition-all peer-checked:bg-[var(--bg-user-bubble)] after:absolute after:top-0.5 after:left-[2px] after:h-4 after:w-4 after:rounded-full after:bg-white after:shadow-sm after:transition-all after:content-[''] peer-checked:after:translate-x-4" />
                  <span className="text-13px font-600 text-black/60 group-hover:text-black/80 transition-colors whitespace-nowrap">开启 MCP Server 服务</span>
                </label>
              </div>
            </div>

            {/* Test Connection Output */}
            {testResult && (
              <div className={`rounded-2xl border p-5 animate-slide-up ${
                testResult.tone === 'success' 
                  ? 'border-green-100 bg-green-50/50 text-green-800' 
                  : 'border-red-100 bg-red-50/50 text-red-800'
              }`}>
                <div className="flex items-center gap-2.5 mb-4">
                  {testResult.tone === 'success' ? <Check size={14} className="text-green-600" /> : <RefreshCw size={14} className="text-red-600" />}
                  <strong className="text-13px font-700">{testResult.message}</strong>
                </div>
                {testResult.tools.length > 0 && (
                  <div className="mcp-tool-chip-list">
                    {testResult.tools.map(tool => (
                      <div key={tool.name} className="mcp-tool-chip-group">
                        <span className="mcp-tool-chip">
                          {tool.name}
                        </span>
                        <div className="mcp-tool-tooltip">
                          {tool.description}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </main>

      {/* Footer Actions - Fixed */}
      <footer className="shrink-0 flex justify-center py-6 px-10 bg-gradient-to-t from-[#f6f6f6] via-[#f6f6f6]/95 to-transparent absolute bottom-0 left-0 right-0 pointer-events-none">
        <div className="pointer-events-auto flex items-center gap-2 p-1.5 rounded-2xl bg-white/90 border border-black/5 shadow-2xl shadow-black/10 backdrop-blur-xl">
          {editingServerId && (
            <button 
              className="h-9 px-4 text-12px font-700 text-red-500 hover:bg-red-50 rounded-xl transition-colors"
              onClick={() => void deleteServer()}
            >
              删除
            </button>
          )}
          {editingServerId && <div className="w-px h-4 bg-black/5 mx-1" />}
          <button 
            className={`h-9 flex items-center gap-2 px-4 text-12px font-700 rounded-xl transition-all ${
              isTesting ? 'text-black/30' : 'text-black/60 hover:bg-black/4'
            }`}
            disabled={isTesting}
            onClick={() => void testServer()}
          >
            <RefreshCw size={13} className={isTesting ? 'animate-spin' : ''} />
            {isTesting ? '测试中...' : '测试连接'}
          </button>
          <button 
            className="h-9 px-6 text-12px font-700 bg-[var(--accent-soft-strong)] text-white rounded-xl shadow-lg shadow-[#4f7b74]/20 hover:brightness-110 active:scale-95 transition-all"
            onClick={() => void saveServer()}
          >
            保存
          </button>
        </div>
      </footer>
    </div>
  )
}
