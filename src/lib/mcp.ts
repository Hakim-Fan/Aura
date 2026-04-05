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

export async function inspectMcpServer(server: McpServerConfig): Promise<McpInspectResult> {
  return invoke<McpInspectResult>('run_mcp_action', {
    payload: {
      action: 'inspect',
      server,
    },
  })
}
