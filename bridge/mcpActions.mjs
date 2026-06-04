import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { parseCommandSpec } from './utils.mjs'
import { APP_VERSION } from '../app-version.mjs'

function parseEnv(input) {
  if (!input || !input.trim()) {
    return {}
  }

  try {
    const parsed = JSON.parse(input)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Env must be a JSON object.')
    }
    return parsed
  } catch (error) {
    throw new Error(
      error instanceof Error ? `Env JSON 无法解析：${error.message}` : 'Env JSON 无法解析。',
    )
  }
}

function normalizeServer(server) {
  if (!server?.command?.trim()) {
    throw new Error('缺少 MCP 启动命令。')
  }

  const commandSpec = parseCommandSpec(server.command, server.args || '')

  return {
    name: server.name?.trim() || 'unnamed-mcp',
    command: commandSpec.command,
    args: commandSpec.args,
    env: parseEnv(server.env || '{}'),
    cwd: server.cwd?.trim() || undefined,
  }
}

async function inspectServer(server) {
  const normalized = normalizeServer(server)

  const transport = new StdioClientTransport({
    command: normalized.command,
    args: normalized.args,
    env: {
      ...process.env,
      ...normalized.env,
    },
    cwd: normalized.cwd,
  })

  const client = new Client(
    {
      name: 'aura-desktop',
      version: APP_VERSION,
    },
    {
      capabilities: {},
    },
  )

  try {
    try {
      await client.connect(transport)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (message.includes('ENOENT') || message.includes('spawn')) {
        throw new Error(`无法启动 MCP 命令：${normalized.command}。请确认命令已安装且在 PATH 中可用。`)
      }
      throw new Error(`MCP 握手失败：${message}`)
    }

    let response
    try {
      response = await client.listTools()
    } catch (error) {
      throw new Error(
        `MCP 已连接，但读取工具列表失败：${error instanceof Error ? error.message : String(error)}`,
      )
    }
    const tools = (response.tools || []).map(tool => ({
      name: tool.name,
      description: tool.description || tool.name,
    }))

    return {
      ok: true,
      message: `连接成功，发现 ${tools.length} 个工具。`,
      tools,
    }
  } finally {
    await client.close?.().catch(() => { })
    await transport.close?.().catch(() => { })
  }
}

async function runAction(payload) {
  const { action, server } = payload || {}

  if (action === 'inspect') {
    return inspectServer(server)
  }

  throw new Error(`Unsupported MCP action: ${action}`)
}

const rawPayload = process.argv[2]

if (!rawPayload) {
  process.stderr.write('Missing MCP action payload.\n')
  process.exit(1)
}

try {
  const payload = JSON.parse(rawPayload)
  const result = await runAction(payload)
  process.stdout.write(JSON.stringify(result))
} catch (error) {
  process.stderr.write(error instanceof Error ? error.message : String(error))
  process.exit(1)
}
