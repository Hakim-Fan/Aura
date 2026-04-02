

import type { ConnectedMCPServer, MCPServerConnection } from './types.js'

// Mirror of AutoModeEnabledState in permissionSetup.ts — inlined because that
// file pulls in too many deps for this thin IPC module.
type AutoModeEnabledState = 'enabled' | 'disabled' | 'opt-in'
function readAutoModeEnabledState(): AutoModeEnabledState | undefined {
  const v = getFeatureValue_CACHED_MAY_BE_STALE<{ enabled?: string }>(
    'tengu_auto_mode_config',
    {},
  )?.enabled
  return v === 'enabled' || v === 'disabled' || v === 'opt-in' ? v : undefined
}

export const LogEventNotificationSchema = lazySchema(() =>
  z.object({
    method: z.literal('log_event'),
    params: z.object({
      eventName: z.string(),
      eventData: z.object({}).passthrough(),
    }),
  }),
)

// Store the VSCode MCP client reference for sending notifications
let vscodeMcpClient: ConnectedMCPServer | null = null

/**
 * Sends a file_updated notification to the VSCode MCP server. This is used to
 * notify VSCode when files are edited or written by Claude.
 */
export function notifyVscodeFileUpdated(
  filePath: string,
  oldContent: string | null,
  newContent: string | null,
): void {
  if (process.env.USER_TYPE !== 'ant' || !vscodeMcpClient) {
    return
  }

  void vscodeMcpClient.client
    .notification({
      method: 'file_updated',
      params: { filePath, oldContent, newContent },
    })
    .catch((error: Error) => {
      // Do not throw if the notification failed
      logForDebugging(
        `[VSCode] Failed to send file_updated notification: ${error.message}`,
      )
    })
}

/**
 * Sets up the speicial internal VSCode MCP for bidirectional communication using notifications.
 */
export function setupVscodeSdkMcp(sdkClients: MCPServerConnection[]): void {
  const client = sdkClients.find(client => client.name === 'claude-vscode')

  if (client && client.type === 'connected') {
    // Store the client reference for later use
    vscodeMcpClient = client

    // SDK communication initialized (Analytics handlers removed)
  }
}
