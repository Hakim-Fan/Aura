import { invoke } from '@tauri-apps/api/core'
import type { AgentSettings, ProviderModel } from '../types'

export type ProviderActionResult = {
  ok: boolean
  message: string
  models: ProviderModel[]
}

type ProviderAction = 'test' | 'fetch-models' | 'test-proxy'

async function runProviderAction(
  action: ProviderAction,
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

export async function testProxyConnectivity(settings: AgentSettings) {
  return runProviderAction('test-proxy', settings)
}
