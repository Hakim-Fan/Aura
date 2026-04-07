import { invoke } from '@tauri-apps/api/core'
import type {
  ResolvedAgentCapabilities,
  AgentTaskSnapshot,
  ChatMessage,
  ChatRole,
  AgentSettings,
} from '../types'

export async function startAgentTask(
  settings: AgentSettings,
  messages: ChatMessage[],
  capabilities?: ResolvedAgentCapabilities,
): Promise<string> {
  const payload = {
    settings,
    capabilities,
    messages: messages.map(message => ({
      role: message.role as ChatRole,
      content: message.content,
      parts: message.parts || [],
    })),
  }

  return invoke<string>('start_agent_task', { payload })
}

export async function getAgentTask(taskId: string): Promise<AgentTaskSnapshot> {
  return invoke<AgentTaskSnapshot>('get_agent_task', { taskId })
}

export async function respondToApproval(
  taskId: string,
  decision: 'approve' | 'deny',
): Promise<void> {
  return invoke('respond_to_agent_approval', { taskId, decision })
}

export async function appendInputToAgentTask(
  taskId: string,
  input: {
    id: string
    content: string
    parts: ChatMessage['parts']
    attachments?: ChatMessage['attachments']
    createdAt: number
  },
): Promise<void> {
  return invoke('append_input_to_agent_task', { taskId, input })
}

export async function abortAgentTask(taskId: string): Promise<void> {
  return invoke('abort_agent_task', { taskId })
}
