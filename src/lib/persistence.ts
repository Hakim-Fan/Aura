import { invoke } from '@tauri-apps/api/core'
import type { AgentSettings, ChatMessage, ChatMessageVariant, ProjectCapabilityOverrides, Session } from '../types'

type PersistedAppState = {
  settings: unknown | null
  sessions: unknown[] | null
  projectCapabilityOverrides: unknown | null
}

export function loadPersistedAppState() {
  return invoke<PersistedAppState>('load_persisted_app_state')
}

export function savePersistedSettings(settings: AgentSettings) {
  return invoke('save_settings_sqlite', { settings })
}

export function savePersistedProjectCapabilityOverrides(
  overrides: ProjectCapabilityOverrides,
) {
  return invoke('save_project_capability_overrides_sqlite', { overrides })
}

export function upsertPersistedSession(session: Session) {
  return invoke('upsert_session_sqlite', { session })
}

export function deletePersistedSession(sessionId: string) {
  return invoke('delete_session_sqlite', { sessionId })
}

export function upsertPersistedMessage(
  sessionId: string,
  message: ChatMessage,
  sortIndex: number,
) {
  return invoke('upsert_message_sqlite', { sessionId, message, sortIndex })
}

export function deletePersistedMessage(messageId: string) {
  return invoke('delete_message_sqlite', { messageId })
}

export function upsertPersistedMessageVersion(
  messageId: string,
  version: ChatMessageVariant,
  versionIndex: number,
) {
  return invoke('upsert_message_version_sqlite', { messageId, version, versionIndex })
}

export function deletePersistedMessageVersion(messageId: string, versionIndex: number) {
  return invoke('delete_message_version_sqlite', { messageId, versionIndex })
}
