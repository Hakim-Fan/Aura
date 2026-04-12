/*
 * @Author: Haki fanhuaze_1114@126.com
 * @Date: 2026-04-12 15:11:57
 * @LastEditors: Haki fanhuaze_1114@126.com
 * @LastEditTime: 2026-04-12 16:02:26
 * @FilePath: /desk-agent/bridge/mcp.mjs
 * @Description: 这是默认设置,请设置`customMade`, 打开koroFileHeader查看配置 进行设置: https://github.com/OBKoro1/koro1FileHeader/wiki/%E9%85%8D%E7%BD%AE
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { createStructuredError } from './runtimeErrors.mjs'
import { parseCommandSpec, parseLooseJson, stringifyOutput } from './utils.mjs'

export async function connectMcpTools(servers) {
  const clients = []
  const tools = []

  for (const server of servers.filter(item => item.enabled && item.command.trim())) {
    const commandSpec = parseCommandSpec(server.command, server.args || '')
    const transport = new StdioClientTransport({
      command: commandSpec.command,
      args: commandSpec.args,
      env: {
        ...process.env,
        ...parseLooseJson(server.env || '{}', {}),
      },
      cwd: server.cwd || undefined,
    })

    const client = new Client(
      {
        name: 'aura-desktop',
        version: '0.1.1', // 客户端标识版本，随应用版本同步更新
      },
      {
        capabilities: {},
      },
    )

    let response
    try {
      await client.connect(transport)
      response = await client.listTools()
    } catch (error) {
      throw createStructuredError(`MCP 服务“${server.name}”连接失败。`, {
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
    clients.push({ client, transport })

    for (const tool of response.tools || []) {
      tools.push({
        source: 'mcp',
        capabilityId: server.id,
        capabilityName: server.name,
        capabilityDescription: server.description || '',
        name: `mcp__${server.name}__${tool.name}`,
        description: `[MCP:${server.name}] ${tool.description || tool.name}`,
        inputSchema: tool.inputSchema || {
          type: 'object',
          properties: {},
        },
        async run(args, runtime = {}) {
          runtime.throwIfAborted?.()
          const result = await client.callTool({
            name: tool.name,
            arguments: args,
          })
          runtime.throwIfAborted?.()
          return stringifyOutput(result.content ?? result)
        },
      })
    }
  }

  return {
    tools,
    async close() {
      for (const entry of clients) {
        await entry.client.close?.()
        await entry.transport.close?.()
      }
    },
  }
}
