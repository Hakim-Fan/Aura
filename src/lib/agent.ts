import { invoke } from '@tauri-apps/api/core'
import type {
  AgentTaskSnapshot,
  ChatMessage,
  ChatRole,
  AgentSettings,
} from '../types'

export async function startAgentTask(
  settings: AgentSettings,
  messages: ChatMessage[],
): Promise<string> {
  const payload = {
    settings,
    messages: messages.map(message => ({
      role: message.role as ChatRole,
      content: message.content,
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
