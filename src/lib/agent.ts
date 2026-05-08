import { invoke } from '@tauri-apps/api/core'
import type {
  ResolvedAgentCapabilities,
  AgentTaskSnapshot,
  ChatContentPart,
  ChatMessage,
  ChatRole,
  AgentSettings,
  MessageAttachment,
  SessionContextCompression,
} from '../types'
import { readImageDataUrl } from './workspace'

const DEFAULT_MANUAL_CONTEXT_COMPRESSION_KEEP_RECENT_MESSAGES = 6

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

function mimeTypeFromPath(filePath?: string) {
  const normalized = typeof filePath === 'string' ? filePath.trim() : ''
  if (!normalized) {
    return ''
  }
  const extension = normalized.split('.').pop()?.toLowerCase() || ''
  switch (extension) {
    case 'png':
      return 'image/png'
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg'
    case 'gif':
      return 'image/gif'
    case 'webp':
      return 'image/webp'
    case 'bmp':
      return 'image/bmp'
    case 'svg':
      return 'image/svg+xml'
    case 'pdf':
      return 'application/pdf'
    default:
      return ''
  }
}

function mimeTypeFromDataUrl(dataUrl?: string) {
  const match = /^data:([^;,]+)[;,]/u.exec(dataUrl || '')
  return match?.[1] || ''
}

function resolveAttachmentMimeType(attachment: {
  mimeType?: string
  path?: string
  preview?: string
}) {
  return (
    attachment.mimeType ||
    mimeTypeFromDataUrl(attachment.preview) ||
    mimeTypeFromPath(attachment.path)
  )
}

function isImageAttachment(attachment: {
  mimeType?: string
  path?: string
  preview?: string
}) {
  return resolveAttachmentMimeType(attachment).startsWith('image/')
}

function attachmentLookupKeys(value: { path?: string; name?: string }) {
  const keys: string[] = []
  if (typeof value.path === 'string' && value.path.trim()) {
    keys.push(`path:${value.path.trim()}`)
  }
  if (typeof value.name === 'string' && value.name.trim()) {
    keys.push(`name:${value.name.trim()}`)
  }
  return keys
}

async function buildAgentRuntimeMessage(
  message: ChatMessage,
  imageDataUrlCache: Map<string, Promise<string | undefined>>,
) {
  const attachments = Array.isArray(message.attachments) ? message.attachments : []
  const imageAttachments = attachments.filter(isImageAttachment)
  const imageAttachmentsByKey = new Map<string, MessageAttachment>()
  for (const attachment of imageAttachments) {
    for (const key of attachmentLookupKeys(attachment)) {
      imageAttachmentsByKey.set(key, attachment)
    }
  }

  const loadImageDataUrl = (filePath?: string) => {
    const normalizedPath = typeof filePath === 'string' ? filePath.trim() : ''
    if (!normalizedPath) {
      return Promise.resolve(undefined)
    }
    const existing = imageDataUrlCache.get(normalizedPath)
    if (existing) {
      return existing
    }
    const next = readImageDataUrl(normalizedPath)
      .then(value => (typeof value === 'string' && value.trim() ? value : undefined))
      .catch(() => undefined)
    imageDataUrlCache.set(normalizedPath, next)
    return next
  }

  const nextParts = await Promise.all(
    (message.parts || []).map(async part => {
      if (part.type === 'image') {
        if (part.dataUrl?.trim()) {
          return part
        }
        const dataUrl = await loadImageDataUrl(part.path)
        return dataUrl ? { ...part, dataUrl } : part
      }

      if (part.type === 'file') {
        const matchingAttachment = attachmentLookupKeys(part)
          .map(key => imageAttachmentsByKey.get(key))
          .find(Boolean)
        if (!matchingAttachment) {
          return part
        }
        const dataUrl = await loadImageDataUrl(matchingAttachment.path || part.path)
        return {
          type: 'image' as const,
          name: part.name,
          mimeType:
            resolveAttachmentMimeType(matchingAttachment) ||
            part.mimeType ||
            mimeTypeFromPath(part.path) ||
            'image/*',
          path: part.path,
          dataUrl,
        }
      }

      return part
    }),
  )

  const existingAttachmentPartKeys = new Set(
    nextParts.flatMap(part =>
      part.type === 'image' || part.type === 'file' ? attachmentLookupKeys(part) : [],
    ),
  )

  for (const attachment of attachments) {
    const keys = attachmentLookupKeys(attachment)
    if (keys.some(key => existingAttachmentPartKeys.has(key))) {
      continue
    }
    if (isImageAttachment(attachment)) {
      const dataUrl = await loadImageDataUrl(attachment.path)
      nextParts.push({
        type: 'image',
        name: attachment.name,
        mimeType: resolveAttachmentMimeType(attachment) || 'image/*',
        path: attachment.path,
        dataUrl,
      })
      continue
    }
    nextParts.push({
      type: 'file',
      name: attachment.name,
      path: attachment.path,
      mimeType: resolveAttachmentMimeType(attachment) || undefined,
    })
  }

  if (nextParts.length === 0 && message.content.trim()) {
    nextParts.push({
      type: 'text',
      text: message.content,
    })
  }

  return {
    role: message.role as ChatRole,
    content: message.content,
    parts: nextParts as ChatContentPart[],
    researchMode: message.researchMode,
  }
}

async function buildAgentRuntimeMessages(messages: ChatMessage[]) {
  const imageDataUrlCache = new Map<string, Promise<string | undefined>>()
  return Promise.all(messages.map(message => buildAgentRuntimeMessage(message, imageDataUrlCache)))
}

function stripInlineImageDataFromPart(part: NonNullable<ChatMessage['parts']>[number]) {
  if (part.type === 'image') {
    return {
      ...part,
      dataUrl: undefined,
    }
  }
  return part
}

function buildAgentCompressionMessages(messages: ChatMessage[]) {
  return messages.map(message => ({
    id: message.id,
    role: message.role as ChatRole,
    content: message.content,
    parts: (message.parts || []).map(stripInlineImageDataFromPart),
    researchMode: message.researchMode,
  }))
}

export function buildRuntimeMessagesWithContextCompression(
  messages: ChatMessage[],
  contextCompression?: SessionContextCompression,
) {
  if (!contextCompression?.summary.trim()) {
    return messages
  }

  const compressedThroughIndex = messages.findIndex(
    message => message.id === contextCompression.compressedThroughMessageId,
  )
  if (compressedThroughIndex === -1) {
    return messages
  }

  const summaryMessage: ChatMessage = {
    id: `context-summary-${contextCompression.id}`,
    role: 'assistant',
    content: contextCompression.summary,
    parts: [],
    status: 'completed',
    createdAt: contextCompression.createdAt,
  }

  return [summaryMessage, ...messages.slice(compressedThroughIndex + 1)]
}

export type AgentContextCompressionResult = {
  ok: boolean
  message: string
  summary: string
  originalTokens: number
  compressedTokens: number
  originalMessageCount: number
  compressedMessageCount: number
  keptRecentCount: number
}

export async function compressAgentContext(
  settings: AgentSettings,
  messages: ChatMessage[],
  keepRecentCount = DEFAULT_MANUAL_CONTEXT_COMPRESSION_KEEP_RECENT_MESSAGES,
): Promise<AgentContextCompressionResult> {
  return invoke<AgentContextCompressionResult>('compress_agent_context', {
    payload: {
      settings,
      messages: buildAgentCompressionMessages(messages),
      keepRecentCount,
    },
  })
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
    messages: await buildAgentRuntimeMessages(messages),
  }

  return invoke<string>('start_agent_task', { payload })
}

export async function getAgentTask(taskId: string): Promise<AgentTaskSnapshot> {
  return invoke<AgentTaskSnapshot>('get_agent_task', { taskId })
}

export async function releaseAgentTask(taskId: string): Promise<void> {
  return invoke('release_agent_task', { taskId })
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
  const runtimeInput = await buildAgentRuntimeMessage(
    {
      id: input.id,
      role: 'user',
      content: input.content,
      parts: input.parts || [],
      attachments: input.attachments || [],
      createdAt: input.createdAt,
      status: 'completed',
      researchMode: input.researchMode,
    },
    new Map<string, Promise<string | undefined>>(),
  )
  return invoke('append_input_to_agent_task', {
    taskId,
    input: {
      ...input,
      parts: runtimeInput.parts,
      snapshotParts: runtimeInput.parts.map(part =>
        part.type === 'image'
          ? {
            ...part,
            dataUrl: undefined,
          }
          : part,
      ),
    },
  })
}

export async function cancelAgentTaskStep(taskId: string): Promise<void> {
  return invoke('cancel_agent_task_step', { taskId })
}

export async function abortAgentTask(taskId: string): Promise<void> {
  return invoke('abort_agent_task', { taskId })
}
