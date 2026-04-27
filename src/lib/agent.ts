import { invoke } from '@tauri-apps/api/core'
import type {
  ResolvedAgentCapabilities,
  AgentTaskSnapshot,
  ChatMessage,
  ChatRole,
  AgentSettings,
} from '../types'

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function clipText(value: string, limit = 0): string {
  const normalized = collapseWhitespace(value || '')
  if (!normalized) {
    return ''
  }
  if (!limit || normalized.length <= limit) {
    return normalized
  }
  return `${normalized.slice(0, Math.max(0, limit - 3)).trim()}...`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function safeParseJson(value?: string): Record<string, unknown> | null {
  const normalized = typeof value === 'string' ? value.trim() : ''
  if (!normalized || normalized.includes('...<truncated>')) {
    return null
  }
  try {
    const parsed = JSON.parse(normalized)
    return isRecord(parsed) ? parsed : null
  } catch {
    return null
  }
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function readStringArray(value: unknown, limit = 3): string[] {
  if (!Array.isArray(value)) {
    return []
  }
  return value
    .filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    .slice(0, limit)
}

function buildResearchCarryoverLines(output: Record<string, unknown>): string[] {
  const query = readString(output.query)
  const provider = readString(output.provider)
  const total = readNumber(output.total)
  const successfulTotal = readNumber(output.successfulTotal)
  const sourceDiversity = readNumber(output.sourceDiversity)
  const lead = [
    'Earlier web research already ran',
    query ? `for "${query}"` : '',
    provider ? `via ${provider}` : '',
    successfulTotal !== null ? `and gathered ${successfulTotal} usable sources` : '',
    sourceDiversity !== null ? `across ${sourceDiversity} domains` : '',
    successfulTotal === null && total !== null ? `with ${total} ranked results` : '',
  ]
    .filter(Boolean)
    .join(' ')

  const lines = [lead.endsWith('.') ? lead : `${lead}.`]
  const results = Array.isArray(output.results) ? output.results.filter(isRecord).slice(0, 2) : []
  for (const entry of results) {
    const status = readString(entry.status)
    if (status === 'error') {
      continue
    }
    const title = readString(entry.title) || readString(entry.url)
    const site = readString(entry.site)
    const publishedAt = readString(entry.publishedAt)
    const keyPoints = readStringArray(entry.keyPoints, 1)
    const detail =
      keyPoints[0] ||
      readString(entry.excerpt) ||
      readString(entry.snippet) ||
      clipText(readString(entry.summary) || readString(entry.content), 180)
    const sourceLabel = [title, site].filter(Boolean).join(' | ')
    lines.push(
      clipText(
        `Source: ${sourceLabel || 'unnamed source'}${publishedAt ? ` (${publishedAt})` : ''}. ${detail}`,
        240,
      ),
    )
  }

  const crossSourceInsights = isRecord(output.crossSourceInsights)
    ? output.crossSourceInsights
    : null
  const overallSignal = readString(crossSourceInsights?.overallSignal)
  if (overallSignal) {
    lines.push(`Cross-source signal: ${overallSignal}.`)
  }

  return lines.filter(Boolean)
}

function buildSearchCarryoverLines(output: Record<string, unknown>): string[] {
  const query = readString(output.query)
  const provider = readString(output.provider)
  const total = readNumber(output.total)
  const lead = [
    'Earlier web search already ran',
    query ? `for "${query}"` : '',
    provider ? `via ${provider}` : '',
    total !== null ? `and returned ${total} ranked results` : '',
  ]
    .filter(Boolean)
    .join(' ')
  const lines = [lead.endsWith('.') ? lead : `${lead}.`]
  const results = Array.isArray(output.results) ? output.results.filter(isRecord).slice(0, 2) : []
  for (const entry of results) {
    const title = readString(entry.title) || readString(entry.url)
    const site = readString(entry.site)
    const snippet = clipText(readString(entry.snippet), 180)
    lines.push(clipText(`Candidate: ${[title, site].filter(Boolean).join(' | ')}. ${snippet}`, 220))
  }
  return lines.filter(Boolean)
}

function buildFetchCarryoverLines(output: Record<string, unknown>): string[] {
  const title = readString(output.title) || readString(output.url)
  const site = readString(output.site)
  const keyPoints = readStringArray(output.keyPoints, 1)
  const excerpt = readString(output.excerpt)
  const detail = keyPoints[0] || excerpt || clipText(readString(output.content), 180)
  return [
    clipText(
      `Earlier web fetch already read ${[title, site].filter(Boolean).join(' | ') || 'a page'}. ${detail}`,
      260,
    ),
  ]
}

function buildCarryoverLinesFromMessage(message: ChatMessage): string[] {
  const events = Array.isArray(message.events) ? message.events : []
  const webEvents = events
    .filter(event => event.status === 'success')
    .filter(event =>
      event.toolName === 'web_research' ||
      event.toolName === 'web_search' ||
      event.toolName === 'web_fetch',
    )
    .slice(-3)

  if (webEvents.length === 0) {
    return []
  }

  const lines: string[] = []
  if (message.status === 'failed') {
    lines.push(
      'A previous answer in this conversation stopped after collecting web evidence. That evidence can still be reused.',
    )
  }

  for (const event of webEvents) {
    const parsedOutput = safeParseJson(event.output)
    if (event.toolName === 'web_research' && parsedOutput) {
      lines.push(...buildResearchCarryoverLines(parsedOutput))
      continue
    }
    if (event.toolName === 'web_search' && parsedOutput) {
      lines.push(...buildSearchCarryoverLines(parsedOutput))
      continue
    }
    if (event.toolName === 'web_fetch' && parsedOutput) {
      lines.push(...buildFetchCarryoverLines(parsedOutput))
      continue
    }
    if (event.summary) {
      lines.push(`Earlier ${event.toolName || 'web step'} already ran: ${clipText(event.summary, 220)}.`)
    }
  }

  return lines.filter(Boolean)
}

function buildCarryoverWebContext(messages: ChatMessage[]): string | undefined {
  const sections: string[] = []
  const assistantMessages = [...messages]
    .reverse()
    .filter(message => message.role === 'assistant')
    .slice(0, 4)

  for (const message of assistantMessages) {
    const lines = buildCarryoverLinesFromMessage(message)
    if (lines.length === 0) {
      continue
    }
    sections.push(lines.join('\n'))
    if (sections.length >= 2) {
      break
    }
  }

  if (sections.length === 0) {
    return undefined
  }

  return clipText(
    [
      'Prior-turn web evidence is already available in this conversation.',
      'Reuse it before calling web_research, web_search, or web_fetch again unless the user explicitly asks for fresh verification or the evidence is clearly stale.',
      sections.join('\n\n'),
    ].join('\n\n'),
    2_800,
  )
}

function mergeCarryoverContext(...sections: Array<string | undefined>): string | undefined {
  const normalized = sections
    .map(section => (typeof section === 'string' ? section.trim() : ''))
    .filter(Boolean)

  if (normalized.length === 0) {
    return undefined
  }

  return normalized.join('\n\n')
}

export async function startAgentTask(
  settings: AgentSettings,
  messages: ChatMessage[],
  capabilities?: ResolvedAgentCapabilities,
  extraCarryoverContext?: string,
): Promise<string> {
  const payload = {
    settings,
    capabilities,
    carryoverContext: mergeCarryoverContext(
      buildCarryoverWebContext(messages),
      extraCarryoverContext,
    ),
    messages: messages.map(message => ({
      role: message.role as ChatRole,
      content: message.content,
      parts: message.parts || [],
      researchMode: message.researchMode,
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
    researchMode?: ChatMessage['researchMode']
  },
): Promise<void> {
  return invoke('append_input_to_agent_task', { taskId, input })
}

export async function cancelAgentTaskStep(taskId: string): Promise<void> {
  return invoke('cancel_agent_task_step', { taskId })
}

export async function abortAgentTask(taskId: string): Promise<void> {
  return invoke('abort_agent_task', { taskId })
}
