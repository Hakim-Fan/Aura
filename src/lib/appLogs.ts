import { invoke } from '@tauri-apps/api/core'

export const APP_LOG_ENTRY_EVENT = 'app-log-entry'

export type AppLogLevel = 'debug' | 'info' | 'warn' | 'error'

export type AppLogEntry = {
  timestamp: string
  timestampMs: number
  level: AppLogLevel | string
  event: string
  details: Record<string, unknown>
}

export type AppLogFile = {
  date: string
  name: string
  path: string
  size: number
  modifiedAt?: number | null
}

export async function listAppLogFiles(): Promise<AppLogFile[]> {
  return invoke<AppLogFile[]>('list_app_log_files')
}

export async function readAppLogFile(date: string): Promise<AppLogEntry[]> {
  return invoke<AppLogEntry[]>('read_app_log_file', { date })
}
