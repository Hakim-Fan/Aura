/*
 * @Author: Haki fanhuaze_1114@126.com
 * @Date: 2026-04-12 15:11:57
 * @LastEditors: Haki fanhuaze_1114@126.com
 * @LastEditTime: 2026-06-01 00:24:34
 * @FilePath: /desk-agent/bridge/mcp.mjs
 * @Description: 这是默认设置,请设置`customMade`, 打开koroFileHeader查看配置 进行设置: https://github.com/OBKoro1/koro1FileHeader/wiki/%E9%85%8D%E7%BD%AE
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { createStructuredError } from './runtimeErrors.mjs'
import { readCache, normalizeCacheKey, writeCache } from './web/shared/cache.mjs'
import {
  readPersistentCacheEntry,
  writePersistentCache,
} from './web/shared/persistentCache.mjs'
import { parseCommandSpec, parseLooseJson, stringifyOutput } from './utils.mjs'

const MCP_TOOL_METADATA_CACHE = new Map()
const MCP_TOOL_METADATA_NAMESPACE = 'mcp-tools'
const MCP_TOOL_METADATA_CACHE_MAX_ENTRIES = 64
const MCP_TOOL_METADATA_TTL_MS = 15 * 60_000

function buildMcpConnectError(server, error) {
  return createStructuredError(`MCP 服务“${server.name}”连接失败。`, {
    source: 'mcp',
    category: 'unavailable',
    code:
      error && typeof error === 'object' && typeof error.code === 'string'
        ? error.code
        : 'MCP_CONNECT_FAILED',
    detail: error instanceof Error ? error.stack || error.message : String(error),
    suggestedAction: '请检查 MCP 启动命令、工作目录和环境变量，并确认该服务可以正常启动。',
    retryable: true,
  })
}

function buildMcpCallError(server, toolName, error) {
  return createStructuredError(`MCP 工具“${server.name}/${toolName}”调用失败。`, {
    source: 'mcp',
    category: 'execution_failed',
    code:
      error && typeof error === 'object' && typeof error.code === 'string'
        ? error.code
        : 'MCP_TOOL_CALL_FAILED',
    detail: error instanceof Error ? error.stack || error.message : String(error),
    suggestedAction: '请检查 MCP 服务日志，确认该工具当前仍可用且输入参数合法。',
    retryable: true,
  })
}

function normalizeToolMetadata(tool) {
  return {
    name: tool?.name || '',
    description: tool?.description || tool?.name || '',
    inputSchema: tool?.inputSchema || {
      type: 'object',
      properties: {},
    },
  }
}

function normalizeServerEnv(env) {
  if (env && typeof env === 'object' && !Array.isArray(env)) {
    return { ...env }
  }

  return parseLooseJson(typeof env === 'string' ? env : '{}', {})
}

function normalizeServerEntry(server) {
  if (!server || typeof server !== 'object') {
    return null
  }

  const command = typeof server.command === 'string' ? server.command.trim() : ''
  const args = typeof server.args === 'string' ? server.args : ''
  const env = normalizeServerEnv(server.env)

  return {
    ...server,
    id: typeof server.id === 'string' && server.id.trim() ? server.id.trim() : server.name || 'mcp',
    name:
      typeof server.name === 'string' && server.name.trim()
        ? server.name.trim()
        : typeof server.id === 'string' && server.id.trim()
          ? server.id.trim()
          : 'MCP',
    description: typeof server.description === 'string' ? server.description.trim() : '',
    command,
    args,
    env,
    enabled: server.enabled === true,
    healthStatus:
      server.healthStatus === 'ok' || server.healthStatus === 'error'
        ? server.healthStatus
        : 'unknown',
  }
}

function buildMcpActivationHint(server) {
  const reason =
    server.enabled !== true
      ? 'It is currently disabled.'
      : server.healthStatus === 'error'
        ? 'Its last recorded health status was error.'
        : server.healthStatus !== 'ok'
          ? `Its current health status is ${server.healthStatus}.`
          : 'It is not active in the current session.'

  return [
    `Configured MCP server "${server.name}" is not active for the current workspace or session.`,
    reason,
    `Enable or fix this MCP server before trying to use its tools directly.`,
  ].join(' ')
}

function buildMcpCatalogHint(server) {
  return [
    `Configured MCP server "${server.name}" may expose additional tools, but no cached tool metadata is available in this runtime yet.`,
    `Enable or reconnect the server once to populate its tool catalog before expecting tool_search to surface individual MCP tools.`,
  ].join(' ')
}

function buildMcpToolName(server, toolName) {
  return `mcp__${server.name}__${toolName}`
}

function buildMcpToolObjects(server, toolMetadata, options = {}) {
  const exposure =
    options.exposure === 'discoverable-only'
      ? 'discoverable-only'
      : options.exposure === 'direct'
        ? 'direct'
        : 'deferred'
  const activationHint =
    typeof options.activationHint === 'string' ? options.activationHint.trim() : ''
  const session = options.session || null

  return toolMetadata.map(tool => ({
    source: 'mcp',
    capabilityId: server.id,
    capabilityName: server.name,
    capabilityDescription: server.description || '',
    name: buildMcpToolName(server, tool.name),
    description: `[MCP:${server.name}] ${tool.description || tool.name}`,
    inputSchema: tool.inputSchema,
    deferLoading: exposure !== 'direct',
    discoverable: true,
    discoverOnly: exposure === 'discoverable-only',
    availability:
      exposure === 'discoverable-only'
        ? 'activation_required'
        : exposure === 'deferred'
          ? 'loadable'
          : 'mounted',
    activationHint,
    async run(args, runtime = {}) {
      if (!session) {
        throw createStructuredError(`MCP 工具“${server.name}/${tool.name}”当前不可直接调用。`, {
          source: 'mcp',
          category: 'unavailable',
          code: 'MCP_TOOL_NOT_ACTIVE',
          detail: activationHint || `MCP server "${server.name}" is not active in the current turn.`,
          suggestedAction: '请先启用或修复对应 MCP 服务，再重新加载工具后调用。',
        })
      }
      return session.callTool(tool.name, args, runtime)
    },
  }))
}

function buildDiscoverableMcpCatalogEntry(server) {
  return {
    source: 'mcp',
    capabilityId: server.id,
    capabilityName: server.name,
    capabilityDescription: server.description || '',
    name: buildMcpToolName(server, 'catalog'),
    aliases: [server.id, server.name],
    description: `[MCP:${server.name}] Server catalog placeholder. Enable or reconnect this MCP server to expose its tools.`,
    inputSchema: {
      type: 'object',
      properties: {},
    },
    discoverable: true,
    discoverOnly: true,
    availability: 'activation_required',
    activationHint: buildMcpCatalogHint(server),
    async run() {
      throw createStructuredError(`MCP 服务“${server.name}”当前未激活。`, {
        source: 'mcp',
        category: 'unavailable',
        code: 'MCP_SERVER_NOT_ACTIVE',
        detail: buildMcpCatalogHint(server),
        suggestedAction: '请先启用或修复对应 MCP 服务，再重新加载工具。',
      })
    },
  }
}

function buildServerCacheKey(server, commandSpec, env) {
  return normalizeCacheKey(
    JSON.stringify({
      id: server.id || '',
      name: server.name || '',
      command: commandSpec.command || '',
      args: Array.isArray(commandSpec.args) ? commandSpec.args : [],
      env: Object.fromEntries(
        Object.entries(env || {}).sort(([left], [right]) => left.localeCompare(right)),
      ),
      cwd: server.cwd || '',
    }),
  )
}

function readMcpToolMetadataCache(cacheKey) {
  const inMemory = readCache(MCP_TOOL_METADATA_CACHE, cacheKey)
  if (inMemory) {
    return {
      value: inMemory,
      layer: 'memory',
    }
  }

  const persisted = readPersistentCacheEntry(MCP_TOOL_METADATA_NAMESPACE, cacheKey, {
    maxEntries: MCP_TOOL_METADATA_CACHE_MAX_ENTRIES,
  })
  if (!persisted) {
    return null
  }

  writeCache(
    MCP_TOOL_METADATA_CACHE,
    cacheKey,
    persisted.value,
    Math.max(1, persisted.expiresAt - Date.now()),
  )
  return {
    value: persisted.value,
    layer: 'persistent',
  }
}

function writeMcpToolMetadataCache(cacheKey, value, ttlMs = MCP_TOOL_METADATA_TTL_MS) {
  writeCache(MCP_TOOL_METADATA_CACHE, cacheKey, value, ttlMs)
  writePersistentCache(MCP_TOOL_METADATA_NAMESPACE, cacheKey, value, ttlMs, {
    maxEntries: MCP_TOOL_METADATA_CACHE_MAX_ENTRIES,
  })
}

function createMcpSession(server, commandSpec, env) {
  let client = null
  let transport = null
  let connectPromise = null

  async function ensureConnected() {
    if (client && transport) {
      return client
    }

    if (connectPromise) {
      return connectPromise
    }

    connectPromise = (async () => {
      const nextTransport = new StdioClientTransport({
        command: commandSpec.command,
        args: commandSpec.args,
        env: {
          ...process.env,
          ...env,
        },
        cwd: server.cwd || undefined,
      })

      const nextClient = new Client(
        {
          name: 'aura-desktop',
          version: '2.1.2',
        },
        {
          capabilities: {},
        },
      )

      try {
        await nextClient.connect(nextTransport)
        client = nextClient
        transport = nextTransport
        return client
      } catch (error) {
        await nextClient.close?.().catch(() => { })
        await nextTransport.close?.().catch(() => { })
        throw buildMcpConnectError(server, error)
      }
    })()

    try {
      return await connectPromise
    } finally {
      connectPromise = null
    }
  }

  return {
    async listTools() {
      const connectedClient = await ensureConnected()
      const response = await connectedClient.listTools()
      return Array.isArray(response?.tools) ? response.tools.map(normalizeToolMetadata) : []
    },
    async callTool(toolName, args, runtime = {}) {
      runtime.throwIfAborted?.()
      try {
        const connectedClient = await ensureConnected()
        const result = await connectedClient.callTool({
          name: toolName,
          arguments: args,
        })
        runtime.throwIfAborted?.()
        return stringifyOutput(result.content ?? result)
      } catch (error) {
        throw buildMcpCallError(server, toolName, error)
      }
    },
    async close() {
      const currentClient = client
      const currentTransport = transport
      client = null
      transport = null
      connectPromise = null
      await currentClient?.close?.()
      await currentTransport?.close?.()
    },
  }
}

export async function connectMcpTools(servers) {
  const inventory = await loadMcpToolInventory({
    activeServers: servers,
    configuredServers: servers,
  })
  return {
    tools: inventory.activeTools,
    close: inventory.close,
  }
}

export async function loadMcpToolInventory({
  activeServers = [],
  configuredServers = [],
} = {}) {
  const sessions = []
  const activeTools = []
  const discoverableTools = []

  const normalizedActiveServers = activeServers
    .map(normalizeServerEntry)
    .filter(server => server && server.command)
  const normalizedConfiguredServers = configuredServers
    .map(normalizeServerEntry)
    .filter(server => server && server.command)
  const activeServerIds = new Set(normalizedActiveServers.map(server => server.id))

  for (const server of normalizedActiveServers.filter(item => item.enabled && item.command.trim())) {
    const commandSpec = parseCommandSpec(server.command, server.args || '')
    const env = server.env || {}
    const cacheKey = buildServerCacheKey(server, commandSpec, env)
    const session = createMcpSession(server, commandSpec, env)
    sessions.push(session)

    let toolMetadata = readMcpToolMetadataCache(cacheKey)?.value
    if (!Array.isArray(toolMetadata)) {
      toolMetadata = await session.listTools()
      writeMcpToolMetadataCache(cacheKey, toolMetadata)
    }

    activeTools.push(
      ...buildMcpToolObjects(server, toolMetadata, {
        exposure: 'deferred',
        session,
      }),
    )
  }

  for (const server of normalizedConfiguredServers) {
    if (!server.command || activeServerIds.has(server.id)) {
      continue
    }

    const commandSpec = parseCommandSpec(server.command, server.args || '')
    const cacheKey = buildServerCacheKey(server, commandSpec, server.env || {})
    const cachedToolMetadata = readMcpToolMetadataCache(cacheKey)?.value

    if (Array.isArray(cachedToolMetadata) && cachedToolMetadata.length > 0) {
      discoverableTools.push(
        ...buildMcpToolObjects(server, cachedToolMetadata, {
          exposure: 'discoverable-only',
          activationHint: buildMcpActivationHint(server),
        }),
      )
      continue
    }

    discoverableTools.push(buildDiscoverableMcpCatalogEntry(server))
  }

  return {
    activeTools,
    discoverableTools,
    async close() {
      for (const session of sessions) {
        await session.close()
      }
    },
  }
}
