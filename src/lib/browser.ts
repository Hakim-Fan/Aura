import { invoke } from '@tauri-apps/api/core'
import type { LightpandaRuntimeStatusRecord } from '../types'

type DetectLightpandaRuntimeArgs = {
  executablePath?: string
}

export async function detectLightpandaRuntime(
  args: DetectLightpandaRuntimeArgs = {},
): Promise<LightpandaRuntimeStatusRecord> {
  return invoke<LightpandaRuntimeStatusRecord>('detect_lightpanda_runtime', {
    executablePath: args.executablePath,
  })
}

export function resolveLightpandaExecutablePath(executablePath?: string) {
  return typeof executablePath === 'string' ? executablePath.trim() : ''
}
