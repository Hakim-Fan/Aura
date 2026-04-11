import { invoke } from '@tauri-apps/api/core'

export type AuraAsset = {
  id: string
  name: string
  description: string
  path: string
  entryPath?: string | null
  supported: boolean
  supportMessage?: string | null
  readonly: boolean
}

export async function deleteAuraAsset(relativePath: string): Promise<void> {
  await invoke('delete_aura_asset', { relativePath })
}

export type AuraHomeState = {
  homeDir: string
  configDir: string
  browserDir: string
  browserProfilesDir: string
  browserRuntimesDir: string
  skillsDir: string
  pluginsDir: string
  mcpDir: string
  workspaceDir: string
  logsDir: string
  settingsPath: string
  sessionsPath: string
  mcpServersPath: string
  skills: AuraAsset[]
  plugins: AuraAsset[]
}

export async function ensureAuraHome(): Promise<AuraHomeState> {
  return invoke<AuraHomeState>('ensure_aura_home')
}

export async function readAuraFile(relativePath: string): Promise<string | null> {
  return invoke<string | null>('read_aura_file', { relativePath })
}

export async function writeAuraFile(relativePath: string, content: string): Promise<void> {
  await invoke('write_aura_file', { relativePath, content })
}

export async function resetAuraHome(): Promise<void> {
  await invoke('reset_aura_home')
}
