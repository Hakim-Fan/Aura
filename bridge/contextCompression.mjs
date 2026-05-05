const DEFAULT_CONTEXT_WINDOW_TOKENS = 128_000
const DEFAULT_LOCAL_CONTEXT_WINDOW_TOKENS = 32_000
export const DEFAULT_CONTEXT_COMPRESSION_THRESHOLD_TOKENS = 256_000
const DEFAULT_MAX_OUTPUT_TOKENS = 16_000
const MAX_DEFAULT_OUTPUT_TOKENS = 32_000
const MIN_TOOL_BUFFER_TOKENS = 4_000
const MAX_TOOL_BUFFER_TOKENS = 20_000
const DEFAULT_KEEP_RECENT_MESSAGE_COUNT = 6
const DEFAULT_COMPACTION_INPUT_BATCH_RATIO = 0.45

function isCjkCharacter(char) {
  return /[\u3400-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/u.test(char)
}

export function estimateTextTokens(value = '') {
  const text = String(value || '')
  if (!text) {
    return 0
  }

  let cjkCount = 0
  let otherCount = 0
  let whitespaceCount = 0

  for (const char of text) {
    if (/\s/u.test(char)) {
      whitespaceCount += 1
      continue
    }
    if (isCjkCharacter(char)) {
      cjkCount += 1
      continue
    }
    otherCount += 1
  }

  return Math.ceil(cjkCount * 0.9 + otherCount / 3.7 + whitespaceCount / 8)
}

function estimatePartTokens(part) {
  if (!part || typeof part !== 'object') {
    return 0
  }

  if (part.type === 'text') {
    return estimateTextTokens(part.text || '')
  }

  if (part.type === 'image') {
    return 1_200 + estimateTextTokens([part.name, part.mimeType, part.path].filter(Boolean).join(' '))
  }

  if (part.type === 'file') {
    return 80 + estimateTextTokens([part.name, part.path, part.mimeType].filter(Boolean).join(' '))
  }

  return estimateTextTokens(JSON.stringify(part))
}

export function estimateMessageTokens(message = {}) {
  const roleTokens = 4
  const contentTokens = estimateTextTokens(message.content || '')
  const partTokens = Array.isArray(message.parts)
    ? message.parts.reduce((total, part) => total + estimatePartTokens(part), 0)
    : 0
  return roleTokens + Math.max(contentTokens, partTokens)
}

export function estimateMessagesTokens(messages = []) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return 0
  }
  return messages.reduce((total, message) => total + estimateMessageTokens(message), 0)
}

function findActiveProviderProfile(settings = {}) {
  const profiles = Array.isArray(settings.providerProfiles) ? settings.providerProfiles : []
  const activeId =
    typeof settings.activeProviderProfileId === 'string'
      ? settings.activeProviderProfileId.trim()
      : ''
  return (
    profiles.find(profile => profile?.id === activeId) ||
    profiles.find(profile => profile?.provider === settings.provider) ||
    profiles[0] ||
    null
  )
}

function findModelMetadata(settings = {}) {
  const profile = findActiveProviderProfile(settings)
  const models = Array.isArray(profile?.models) ? profile.models : []
  const modelId = typeof settings.model === 'string' ? settings.model.trim() : ''
  return models.find(model => model?.id === modelId) || null
}

function inferContextWindowFromModel(settings = {}) {
  const provider = settings.provider
  const model = String(settings.model || '').toLowerCase()

  if (provider === 'google') {
    if (model.includes('gemini-1.5') || model.includes('gemini-2')) {
      return 1_000_000
    }
    return 128_000
  }

  if (provider === 'custom') {
    if (/(ollama|llama|local|lmstudio|vllm)/u.test(String(settings.baseUrl || '').toLowerCase())) {
      return DEFAULT_LOCAL_CONTEXT_WINDOW_TOKENS
    }
  }

  return DEFAULT_CONTEXT_WINDOW_TOKENS
}

export function resolveContextWindowTokens(settings = {}) {
  const modelMetadata = findModelMetadata(settings)
  const configured = Number(modelMetadata?.contextWindowTokens)
  if (Number.isFinite(configured) && configured > 0) {
    return Math.round(configured)
  }
  return inferContextWindowFromModel(settings)
}

export function resolveMaxOutputTokens(settings = {}, contextWindowTokens = resolveContextWindowTokens(settings)) {
  const modelMetadata = findModelMetadata(settings)
  const configured = Number(modelMetadata?.maxOutputTokens)
  if (Number.isFinite(configured) && configured > 0) {
    return Math.round(configured)
  }
  return Math.round(
    Math.max(2_000, Math.min(MAX_DEFAULT_OUTPUT_TOKENS, contextWindowTokens * 0.125, DEFAULT_MAX_OUTPUT_TOKENS)),
  )
}

export function buildContextCompressionBudget(settings = {}, options = {}) {
  const contextWindowTokens = resolveContextWindowTokens(settings)
  const systemPromptTokens = estimateTextTokens(options.systemPrompt || '')
  const maxOutputTokens = resolveMaxOutputTokens(settings, contextWindowTokens)
  const configuredThresholdTokens =
    Number.isFinite(Number(settings.contextCompressionThresholdTokens)) &&
    Number(settings.contextCompressionThresholdTokens) > 0
      ? Math.round(Number(settings.contextCompressionThresholdTokens))
      : DEFAULT_CONTEXT_COMPRESSION_THRESHOLD_TOKENS
  const toolResultBufferTokens = Math.round(
    Math.max(
      MIN_TOOL_BUFFER_TOKENS,
      Math.min(MAX_TOOL_BUFFER_TOKENS, contextWindowTokens * 0.12),
    ),
  )
  const compressionThresholdTokens = Math.min(
    configuredThresholdTokens,
    Math.floor(contextWindowTokens * 0.85),
  )
  const effectiveThresholdTokens = Math.max(
    1_000,
    compressionThresholdTokens -
      systemPromptTokens -
      maxOutputTokens -
      toolResultBufferTokens,
  )
  const targetConversationTokens = Math.max(
    1_500,
    Math.floor(compressionThresholdTokens * 0.35) - systemPromptTokens,
  )
  const compactionInputBatchTokens = Math.max(
    4_000,
    Math.floor(contextWindowTokens * DEFAULT_COMPACTION_INPUT_BATCH_RATIO),
  )

  return {
    contextWindowTokens,
    configuredThresholdTokens,
    systemPromptTokens,
    maxOutputTokens,
    toolResultBufferTokens,
    compressionThresholdTokens,
    effectiveThresholdTokens,
    targetConversationTokens,
    compactionInputBatchTokens,
  }
}

export function shouldCompressMessages(messages = [], settings = {}, options = {}) {
  const estimatedTokens = estimateMessagesTokens(messages)
  const budget = buildContextCompressionBudget(settings, options)
  return {
    shouldCompress:
      estimatedTokens > budget.effectiveThresholdTokens &&
      Array.isArray(messages) &&
      messages.length > 1,
    estimatedTokens,
    budget,
  }
}

function splitTextIntoTokenChunks(text, maxTokens) {
  const source = String(text || '')
  if (!source) {
    return []
  }

  const limit = Math.max(200, Math.floor(maxTokens))
  const chunks = []
  let start = 0

  while (start < source.length) {
    let end = Math.min(source.length, start + Math.max(1_000, limit * 3))
    while (end > start + 200 && estimateTextTokens(source.slice(start, end)) > limit) {
      end = start + Math.floor((end - start) * 0.75)
    }
    if (end <= start) {
      end = Math.min(source.length, start + 1_000)
    }
    chunks.push(source.slice(start, end))
    start = end
  }

  return chunks
}

function splitOversizedMessageForBatch(message, maxBatchTokens) {
  const messageTokens = estimateMessageTokens(message)
  const limit = Math.max(1_000, Math.floor(maxBatchTokens))
  if (messageTokens <= limit) {
    return [message]
  }

  const content = typeof message?.content === 'string' ? message.content : ''
  if (!content) {
    return [message]
  }

  const chunks = splitTextIntoTokenChunks(content, Math.max(500, limit - 200))
  return chunks.map((chunk, index) => ({
    ...message,
    content: [
      `[Chunk ${index + 1}/${chunks.length} of an oversized ${message?.role || 'unknown'} message.]`,
      chunk,
    ].join('\n\n'),
    parts: index === 0 ? message.parts || [] : [],
  }))
}

function summarizePartForCompaction(part) {
  if (!part || typeof part !== 'object') {
    return ''
  }

  if (part.type === 'text') {
    return part.text || ''
  }

  if (part.type === 'image') {
    return [
      '[Image attachment]',
      part.name ? `name=${part.name}` : null,
      part.mimeType ? `mimeType=${part.mimeType}` : null,
      part.path ? `path=${part.path}` : null,
      'binary image data omitted from the compaction prompt; preserve the fact that this image existed.',
    ]
      .filter(Boolean)
      .join(' ')
  }

  if (part.type === 'file') {
    return [
      '[File attachment]',
      part.name ? `name=${part.name}` : null,
      part.path ? `path=${part.path}` : null,
      part.mimeType ? `mimeType=${part.mimeType}` : null,
    ]
      .filter(Boolean)
      .join(' ')
  }

  return `[Unsupported part] ${JSON.stringify(part)}`
}

export function formatMessagesForCompaction(messages = []) {
  return (Array.isArray(messages) ? messages : [])
    .map((message, index) => {
      const role = message?.role || 'unknown'
      const sections = [`### Message ${index + 1} (${role})`]
      if (typeof message?.content === 'string' && message.content.trim()) {
        sections.push(message.content.trim())
      }
      if (Array.isArray(message?.parts) && message.parts.length > 0) {
        const partText = message.parts
          .map(summarizePartForCompaction)
          .filter(Boolean)
          .join('\n')
        if (partText.trim()) {
          sections.push(`Parts:\n${partText}`)
        }
      }
      if (message?.researchMode) {
        sections.push(`researchMode: ${message.researchMode}`)
      }
      return sections.join('\n\n')
    })
    .join('\n\n---\n\n')
}

export function splitMessagesIntoTokenBatches(messages = [], maxBatchTokens = 40_000) {
  const batches = []
  let current = []
  let currentTokens = 0
  const limit = Math.max(1_000, Math.floor(maxBatchTokens))

  const expandedMessages = (Array.isArray(messages) ? messages : []).flatMap(message =>
    splitOversizedMessageForBatch(message, limit),
  )

  for (const message of expandedMessages) {
    const messageTokens = estimateMessageTokens(message)
    if (current.length > 0 && currentTokens + messageTokens > limit) {
      batches.push(current)
      current = []
      currentTokens = 0
    }
    current.push(message)
    currentTokens += messageTokens
  }

  if (current.length > 0) {
    batches.push(current)
  }

  return batches
}

export function buildCompactionSystemPrompt(targetTokens) {
  return [
    'You compact conversation history for a coding agent.',
    `Target budget: about ${Math.round(targetTokens)} tokens.`,
    'Preserve information. Do not omit facts merely because they are old.',
    'Use dense Markdown with these sections when applicable: User Goals, Current State, Completed Work, Important Files And Symbols, Decisions, Errors And Blockers, Pending Work, User Preferences.',
    'Keep concrete file paths, commands, error messages, tool outcomes, IDs, model/provider choices, and unresolved questions.',
    'Do not invent details. If something is uncertain, label it as uncertain.',
  ].join('\n')
}

export function buildCompactionUserPrompt(messages = [], options = {}) {
  return [
    `Compress the following ${messages.length} earlier conversation message(s).`,
    'The most recent conversation messages will be provided separately and should not be repeated unless needed to connect context.',
    '',
    formatMessagesForCompaction(messages),
  ].join('\n')
}

export function buildCompressedSummaryMessage(summary, originalMessageCount, metadata = {}) {
  const lines = [
    `[Compressed summary of ${originalMessageCount} earlier conversation message(s).]`,
    metadata.beforeTokens && metadata.afterTokens
      ? `Estimated tokens: ${metadata.beforeTokens} -> ${metadata.afterTokens}.`
      : null,
    '',
    String(summary || '').trim(),
  ].filter(line => line !== null)

  return {
    role: 'assistant',
    content: lines.join('\n').trim(),
    parts: [],
  }
}

export const __testInternals = {
  DEFAULT_KEEP_RECENT_MESSAGE_COUNT,
  estimatePartTokens,
  findActiveProviderProfile,
  findModelMetadata,
}
