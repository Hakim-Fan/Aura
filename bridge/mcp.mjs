import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { parseArgString, parseLooseJson, stringifyOutput } from './utils.mjs'

export async function connectMcpTools(servers) {
  const clients = []
  const tools = []

  for (const server of servers.filter(item => item.enabled && item.command.trim())) {
    const transport = new StdioClientTransport({
      command: server.command,
      args: parseArgString(server.args || ''),
      env: {
        ...process.env,
        ...parseLooseJson(server.env || '{}', {}),
      },
      cwd: server.cwd || undefined,
    })

    const client = new Client(
      {
        name: 'aura-desktop',
        version: '0.1.0',
      },
      {
        capabilities: {},
      },
    )

    await client.connect(transport)
    const response = await client.listTools()
    clients.push({ client, transport })

    for (const tool of response.tools || []) {
      tools.push({
        source: 'mcp',
        name: `mcp__${server.name}__${tool.name}`,
        description: `[MCP:${server.name}] ${tool.description || tool.name}`,
        inputSchema: tool.inputSchema || {
          type: 'object',
          properties: {},
        },
        async run(args) {
          const result = await client.callTool({
            name: tool.name,
            arguments: args,
          })
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
