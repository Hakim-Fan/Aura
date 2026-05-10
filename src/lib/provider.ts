import { invoke } from '@tauri-apps/api/core'
import type { AgentSettings, ProviderModel } from '../types'

export type ProviderActionResult = {
  ok: boolean
  message: string
  models: ProviderModel[]
  title?: string
}

export type TitleGenerationContext = {
  currentTitle: string
  compressedSummary?: string
  openingMessages: Array<{ role: string; content: string }>
  recentMessages: Array<{ role: string; content: string }>
  attachments: string[]
}

type ProviderAction = 'test' | 'fetch-models' | 'test-proxy' | 'generate-title'

async function runProviderAction(
  action: ProviderAction,
  settings: AgentSettings,
  extraPayload: Record<string, unknown> = {},
): Promise<ProviderActionResult> {
  return invoke<ProviderActionResult>('run_provider_action', {
    payload: {
      action,
      settings,
      ...extraPayload,
    },
  })
}

export async function testProviderConnection(settings: AgentSettings) {
  return runProviderAction('test', settings)
}

export async function fetchProviderModels(settings: AgentSettings) {
  return runProviderAction('fetch-models', settings)
}

export async function testProxyConnectivity(settings: AgentSettings) {
  return runProviderAction('test-proxy', settings)
}

export async function generateSessionTitle(
  settings: AgentSettings,
  titleContext: TitleGenerationContext,
) {
  const result = await runProviderAction('generate-title', settings, { titleContext })
  const title = result.title?.trim()
  if (!title) {
    throw new Error(result.message || '模型没有返回可用标题。')
  }
  return title
}
