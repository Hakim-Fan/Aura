import { invoke } from '@tauri-apps/api/core'
import type { AgentSettings } from '../types'

export type ProviderActionResult = {
  ok: boolean
  message: string
  models: string[]
}

async function runProviderAction(
  action: 'test' | 'fetch-models',
  settings: AgentSettings,
): Promise<ProviderActionResult> {
  return invoke<ProviderActionResult>('run_provider_action', {
    payload: {
      action,
      settings,
    },
  })
}

export async function testProviderConnection(settings: AgentSettings) {
  return runProviderAction('test', settings)
}

export async function fetchProviderModels(settings: AgentSettings) {
  return runProviderAction('fetch-models', settings)
}
