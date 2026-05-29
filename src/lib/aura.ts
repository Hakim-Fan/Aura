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
  external?: boolean
  scope?: 'global' | 'workspace' | 'external'
}

export async function deleteAuraAsset(relativePath: string): Promise<void> {
  await invoke('delete_aura_asset', { relativePath })
}

export type AuraHomeState = {
  homeDir: string
  configDir: string
  skillsDir: string
  externalSkillDirs: string[]
  pluginsDir: string
  mcpDir: string
  workspaceDir: string
  logsDir: string
  browserDir: string
  settingsPath: string
  sessionsPath: string
  mcpServersPath: string
  skills: AuraAsset[]
  plugins: AuraAsset[]
}

export async function ensureAuraHome(workspaceRoot?: string): Promise<AuraHomeState> {
  return invoke<AuraHomeState>('ensure_aura_home', {
    workspaceRoot: workspaceRoot?.trim() || null,
  })
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
