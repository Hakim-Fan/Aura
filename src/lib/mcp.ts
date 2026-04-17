import { invoke } from '@tauri-apps/api/core'
import type { McpServerConfig } from '../types'

export type McpToolDescriptor = {
  name: string
  description: string
}

export type McpInspectResult = {
  ok: true
  message: string
  tools: McpToolDescriptor[]
}

export type McpFieldErrors = Partial<Record<'name' | 'command' | 'env' | 'importJson', string>>

type ParsedMcpImportResult = {
  servers: Array<Pick<McpServerConfig, 'name' | 'description' | 'command' | 'args' | 'env' | 'cwd'>>
}

export async function inspectMcpServer(server: McpServerConfig): Promise<McpInspectResult> {
  return invoke<McpInspectResult>('run_mcp_action', {
    payload: {
      action: 'inspect',
      server,
    },
  })
}

function quoteShellArg(value: string) {
  if (!value) {
    return '""'
  }
  if (!/[\s"'\\]/.test(value)) {
    return value
  }
  return `"${value.replace(/(["\\$`])/g, '\\$1')}"`
}

function stringifyArgs(value: unknown) {
  if (typeof value === 'string') {
    return value
  }
  if (!Array.isArray(value)) {
    return ''
  }
  return value
    .filter(item => item !== null && item !== undefined)
    .map(item => quoteShellArg(String(item)))
    .join(' ')
}

function stringifyEnv(value: unknown) {
  if (!value) {
    return '{}'
  }
  if (typeof value === 'string') {
    return value.trim() || '{}'
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('环境变量必须是 JSON 对象。')
  }
  return JSON.stringify(value, null, 2)
}

function parseNamedServers(source: Record<string, unknown>) {
  return Object.entries(source)
    .filter(([, value]) => value && typeof value === 'object' && !Array.isArray(value))
    .map(([fallbackName, value]) => {
      const entry = value as Record<string, unknown>
      return {
        name:
          typeof entry.name === 'string' && entry.name.trim() ? entry.name.trim() : fallbackName,
        description:
          typeof entry.description === 'string' ? entry.description : '',
        command: typeof entry.command === 'string' ? entry.command.trim() : '',
        args: stringifyArgs(entry.args),
        env: stringifyEnv(entry.env),
        cwd: typeof entry.cwd === 'string' ? entry.cwd.trim() : '',
      }
    })
}

export function validateMcpServerInput(server: Pick<McpServerConfig, 'name' | 'command' | 'env'>) {
  const errors: McpFieldErrors = {}

  if (!server.name.trim()) {
    errors.name = '请填写 MCP 名称。'
  }
  if (!server.command.trim()) {
    errors.command = '请填写 MCP 启动命令。'
  }

  const envText = server.env.trim()
  if (envText) {
    try {
      const parsed = JSON.parse(envText)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        errors.env = '环境变量必须是 JSON 对象。'
      }
    } catch (error) {
      errors.env = error instanceof Error ? `环境变量 JSON 解析失败：${error.message}` : '环境变量 JSON 解析失败。'
    }
  }

  return {
    isValid: Object.keys(errors).length === 0,
    errors,
    firstMessage:
      errors.name || errors.command || errors.env || '',
  }
}

export function parseMcpImportJson(raw: string): ParsedMcpImportResult {
  if (!raw.trim()) {
    throw new Error('请先粘贴 MCP JSON 配置。')
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new Error(error instanceof Error ? `JSON 解析失败：${error.message}` : 'JSON 解析失败。')
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('MCP 导入内容必须是 JSON 对象。')
  }

  const root = parsed as Record<string, unknown>
  let servers: ParsedMcpImportResult['servers'] = []

  if (root.mcpServers !== undefined) {
    if (!root.mcpServers || typeof root.mcpServers !== 'object' || Array.isArray(root.mcpServers)) {
      throw new Error('mcpServers 必须是一个对象。')
    }
    servers = parseNamedServers(root.mcpServers as Record<string, unknown>)
  }

  if (!servers.length && typeof root.command === 'string') {
    servers = [
      {
        name: typeof root.name === 'string' && root.name.trim() ? root.name.trim() : 'new-mcp',
        description: typeof root.description === 'string' ? root.description : '',
        command: root.command.trim(),
        args: stringifyArgs(root.args),
        env: stringifyEnv(root.env),
        cwd: typeof root.cwd === 'string' ? root.cwd.trim() : '',
      },
    ]
  }

  if (!servers.length) {
    throw new Error('没有找到可导入的 MCP 配置。请提供单个 server，或包含 mcpServers 的 JSON。')
  }

  const invalid = servers.find(server => !server.command)
  if (invalid) {
    throw new Error(`MCP “${invalid.name}”缺少 command，无法导入。`)
  }

  return { servers }
}
