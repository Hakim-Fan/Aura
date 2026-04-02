import { useEffect } from 'react'
import { z } from 'zod/v4'
import type { MCPServerConnection } from '../services/mcp/types.js'
import { getConnectedIdeClient } from '../utils/ide.js'
import { lazySchema } from '../utils/lazySchema.js'

const LogEventSchema = lazySchema(() =>
  z.object({
    method: z.literal('log_event'),
    params: z.object({
      eventName: z.string(),
      eventData: z.object({}).passthrough(),
    }),
  }),
)

export function useIdeLogging(mcpClients: MCPServerConnection[]): void {
  useEffect(() => {
    // Skip if there are no clients
    if (!mcpClients.length) {
      return
    }

    // Find the IDE client from the MCP clients list (Analytics notification handler removed)
    const ideClient = getConnectedIdeClient(mcpClients)
    if (ideClient) {
      // IDE logging notifications disabled for privacy
    }
  }, [mcpClients])
}
