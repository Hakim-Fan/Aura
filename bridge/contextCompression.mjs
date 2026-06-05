import { countTextTokens } from './tokenizer.mjs'

const DEFAULT_CONTEXT_WINDOW_TOKENS = 256_000
const DEFAULT_LOCAL_CONTEXT_WINDOW_TOKENS = 32_000
export const DEFAULT_CONTEXT_COMPRESSION_THRESHOLD_TOKENS = 256_000
const COMPACT_MAX_OUTPUT_TOKENS = 20_000
const AUTOCOMPACT_BUFFER_TOKENS = 13_000
const DEFAULT_KEEP_RECENT_MESSAGE_COUNT = 6
export const DEFAULT_RECENT_USER_MESSAGE_TOKEN_BUDGET = 20_000
const DEFAULT_COMPACTION_INPUT_BATCH_RATIO = 0.45
const IMAGE_PART_TOKEN_COST = 1_200
const FILE_PART_TOKEN_COST = 80

function resolveReasoningOutputBudgetTokens(settings = {}) {
  switch (settings.reasoningEffort) {
    case 'off':
      return 16_000
    case 'low':
      return 32_000
    case 'high':
    case 'max':
    case 'medium':
    default:
      return 64_000
  }
}

export function estimateTextTokens(value = '', options = {}) {
  return countTextTokens(value, options)
}

function estimatePartTokens(part, options = {}) {
  if (!part || typeof part !== 'object') {
    return 0
  }

  if (part.type === 'text') {
    return estimateTextTokens(part.text || '', options)
  }

  if (part.type === 'image') {
    return (
      IMAGE_PART_TOKEN_COST +
      estimateTextTokens(
        [part.name, part.mimeType, part.path].filter(Boolean).join(' '),
        options,
      )
    )
  }

  if (part.type === 'file') {
    return (
      FILE_PART_TOKEN_COST +
      estimateTextTokens(
        [part.name, part.path, part.mimeType].filter(Boolean).join(' '),
        options,
      )
    )
  }

  return estimateTextTokens(JSON.stringify(part), options)
}

export function estimateMessageTokens(message = {}, options = {}) {
  const roleTokens = 4
  const contentTokens = estimateTextTokens(message.content || '', options)
  const parts = Array.isArray(message.parts) ? message.parts : []
  const partTokens = parts.reduce(
    (total, part) => total + estimatePartTokens(part, options),
    0,
  )
  const textPartContent = parts
    .filter((part) => part?.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text.trim())
    .filter(Boolean)
    .join('\n')
  const contentMirrorsTextParts =
    textPartContent &&
    typeof message.content === 'string' &&
    textPartContent === message.content.trim()
  return roleTokens + (contentMirrorsTextParts ? 0 : contentTokens) + partTokens
}

export function estimateMessagesTokens(messages = [], options = {}) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return 0
  }
  return messages.reduce(
    (total, message) => total + estimateMessageTokens(message, options),
    0,
  )
}

function findActiveProviderProfile(settings = {}) {
  const profiles = Array.isArray(settings.providerProfiles)
    ? settings.providerProfiles
    : []
  const activeId =
    typeof settings.activeProviderProfileId === 'string'
      ? settings.activeProviderProfileId.trim()
      : ''
  return (
    profiles.find((profile) => profile?.id === activeId) ||
    profiles.find((profile) => profile?.provider === settings.provider) ||
    profiles[0] ||
    null
  )
}

function findModelMetadata(settings = {}) {
  const profile = findActiveProviderProfile(settings)
  const models = Array.isArray(profile?.models) ? profile.models : []
  const modelId =
    typeof settings.model === 'string' ? settings.model.trim() : ''
  return models.find((model) => model?.id === modelId) || null
}

function inferContextWindowFromModel(settings = {}) {
  const provider = settings.provider
  const model = String(settings.model || '').toLowerCase()

  if (provider === 'google') {
    if (model.includes('gemini-1.5') || model.includes('gemini-2')) {
      return 1_000_000
    }
    return DEFAULT_CONTEXT_WINDOW_TOKENS
  }

  if (provider === 'custom') {
    if (
      /(ollama|llama|local|lmstudio|vllm)/u.test(
        String(settings.baseUrl || '').toLowerCase(),
      )
    ) {
      return DEFAULT_LOCAL_CONTEXT_WINDOW_TOKENS
    }
  }

  return DEFAULT_CONTEXT_WINDOW_TOKENS
}

export function resolveContextWindowTokens(settings = {}) {
  return resolveContextWindowInfo(settings).contextWindowTokens
}

export function resolveContextWindowInfo(settings = {}) {
  const modelMetadata = findModelMetadata(settings)
  const modelContextWindowTokens = Number(modelMetadata?.contextWindowTokens)
  const configuredContextWindowTokens = Number(
    settings.contextCompressionThresholdTokens,
  )
  if (
    Number.isFinite(modelContextWindowTokens) &&
    modelContextWindowTokens > 0
  ) {
    return {
      contextWindowTokens: Math.round(modelContextWindowTokens),
      windowSource: 'model_metadata',
      modelContextWindowTokens: Math.round(modelContextWindowTokens),
      configuredContextWindowTokens:
        Number.isFinite(configuredContextWindowTokens) &&
        configuredContextWindowTokens > 0
          ? Math.round(configuredContextWindowTokens)
          : undefined,
    }
  }
  if (
    Number.isFinite(configuredContextWindowTokens) &&
    configuredContextWindowTokens > 0
  ) {
    return {
      contextWindowTokens: Math.round(configuredContextWindowTokens),
      windowSource: 'settings',
      configuredContextWindowTokens: Math.round(configuredContextWindowTokens),
    }
  }
  return {
    contextWindowTokens: inferContextWindowFromModel(settings),
    windowSource: 'inferred',
  }
}

export function resolveMaxOutputTokens(
  settings = {},
  contextWindowTokens = resolveContextWindowTokens(settings),
) {
  const modelMetadata = findModelMetadata(settings)
  const configured = Number(modelMetadata?.maxOutputTokens)
  const reasoningBudget = resolveReasoningOutputBudgetTokens(settings)
  if (Number.isFinite(configured) && configured > 0) {
    return Math.round(Math.min(configured, reasoningBudget))
  }
  return Math.round(
    Math.max(
      2_000,
      Math.min(reasoningBudget, Math.max(2_000, contextWindowTokens * 0.5)),
    ),
  )
}

export function buildContextCompressionBudget(settings = {}, options = {}) {
  const contextWindowInfo = resolveContextWindowInfo(settings)
  const contextWindowTokens = contextWindowInfo.contextWindowTokens
  const systemPromptTokens = estimateTextTokens(
    options.systemPrompt || '',
    settings,
  )
  const toolSchemaTokens = Math.max(
    0,
    Math.round(Number(options.toolSchemaTokens) || 0),
  )
  const maxOutputTokens = resolveMaxOutputTokens(settings, contextWindowTokens)
  const configuredThresholdTokens =
    Number.isFinite(Number(settings.contextCompressionThresholdTokens)) &&
    Number(settings.contextCompressionThresholdTokens) > 0
      ? Math.round(Number(settings.contextCompressionThresholdTokens))
      : DEFAULT_CONTEXT_COMPRESSION_THRESHOLD_TOKENS
  const autoCompactWindowTokens = Math.min(
    contextWindowTokens,
    configuredThresholdTokens,
  )
  const compactionReservedOutputTokens = Math.round(
    Math.max(0, Math.min(maxOutputTokens, COMPACT_MAX_OUTPUT_TOKENS)),
  )
  const autoCompactBufferTokens = AUTOCOMPACT_BUFFER_TOKENS
  const effectiveContextWindowTokens = Math.max(
    1_000,
    autoCompactWindowTokens - compactionReservedOutputTokens,
  )
  const compressionThresholdTokens = Math.max(
    1_000,
    effectiveContextWindowTokens - autoCompactBufferTokens,
  )
  const effectiveThresholdTokens = Math.max(
    1_000,
    compressionThresholdTokens - systemPromptTokens - toolSchemaTokens,
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
    windowSource: contextWindowInfo.windowSource,
    modelContextWindowTokens: contextWindowInfo.modelContextWindowTokens,
    configuredContextWindowTokens:
      contextWindowInfo.configuredContextWindowTokens,
    configuredThresholdTokens,
    systemPromptTokens,
    toolSchemaTokens,
    maxOutputTokens,
    compactionReservedOutputTokens,
    autoCompactBufferTokens,
    toolResultBufferTokens: autoCompactBufferTokens,
    effectiveContextWindowTokens,
    compressionThresholdTokens,
    effectiveThresholdTokens,
    targetConversationTokens,
    compactionInputBatchTokens,
  }
}

export function shouldCompressMessages(
  messages = [],
  settings = {},
  options = {},
) {
  const estimatedTokens = estimateMessagesTokens(messages, settings)
  const budget = buildContextCompressionBudget(settings, options)
  const latestInputTokens = Math.max(
    0,
    Math.round(
      Number(options.latestInputTokens || options.activeInputTokens) || 0,
    ),
  )
  const estimatedPromptTokens =
    budget.systemPromptTokens + budget.toolSchemaTokens + estimatedTokens
  const activePromptTokens = Math.max(latestInputTokens, estimatedPromptTokens)
  const activePromptLimit = Math.max(
    1_000,
    budget.compressionThresholdTokens,
  )
  const activePromptLimitReached = activePromptTokens > activePromptLimit
  const trigger =
    !activePromptLimitReached
      ? 'none'
      : latestInputTokens > 0 && latestInputTokens >= estimatedPromptTokens
        ? 'provider_usage'
        : 'active_context'
  return {
    shouldCompress:
      activePromptLimitReached &&
      Array.isArray(messages) &&
      messages.length > 1,
    estimatedTokens,
    estimatedPromptTokens,
    latestInputTokens,
    activePromptTokens,
    activePromptLimit,
    trigger,
    budget,
  }
}

function splitTextIntoTokenChunks(text, maxTokens, options = {}) {
  const source = String(text || '')
  if (!source) {
    return []
  }

  const limit = Math.max(200, Math.floor(maxTokens))
  const chunks = []
  let start = 0

  while (start < source.length) {
    let end = Math.min(source.length, start + Math.max(1_000, limit * 3))
    while (
      end > start + 200 &&
      estimateTextTokens(source.slice(start, end), options) > limit
    ) {
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

function splitOversizedMessageForBatch(message, maxBatchTokens, options = {}) {
  const messageTokens = estimateMessageTokens(message, options)
  const limit = Math.max(1_000, Math.floor(maxBatchTokens))
  if (messageTokens <= limit) {
    return [message]
  }

  const content = typeof message?.content === 'string' ? message.content : ''
  if (!content) {
    return [message]
  }

  const chunks = splitTextIntoTokenChunks(
    content,
    Math.max(500, limit - 200),
    options,
  )
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

function userMessageTextForCompaction(message = {}) {
  const pieces = []
  if (typeof message.content === 'string' && message.content.trim()) {
    pieces.push(message.content.trim())
  }
  if (Array.isArray(message.parts)) {
    const textParts = message.parts
      .filter((part) => part?.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text.trim())
      .filter(Boolean)
    for (const text of textParts) {
      if (!pieces.includes(text)) {
        pieces.push(text)
      }
    }
  }
  return pieces.join('\n\n').trim()
}

function truncateTextToTokenBudget(text, maxTokens, options = {}) {
  const source = String(text || '')
  const limit = Math.max(0, Math.floor(Number(maxTokens) || 0))
  if (!source || limit <= 0) {
    return ''
  }
  if (estimateTextTokens(source, options) <= limit) {
    return source
  }

  let end = Math.min(source.length, Math.max(200, limit * 4))
  while (
    end > 200 &&
    estimateTextTokens(source.slice(0, end), options) > limit
  ) {
    end = Math.floor(end * 0.75)
  }
  return source.slice(0, Math.max(1, end)).trim()
}

export function selectRecentUserMessagesForCompactionSummary(
  messages = [],
  maxTokens = DEFAULT_RECENT_USER_MESSAGE_TOKEN_BUDGET,
  options = {},
) {
  const limit = Math.max(0, Math.floor(Number(maxTokens) || 0))
  if (!Array.isArray(messages) || messages.length === 0 || limit <= 0) {
    return []
  }

  let remaining = limit
  const selected = []
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.role !== 'user') {
      continue
    }
    const text = userMessageTextForCompaction(message)
    if (!text || text.startsWith('[Compressed summary')) {
      continue
    }

    const tokens = estimateTextTokens(text, options)
    if (tokens <= remaining) {
      selected.push({
        index,
        content: text,
        truncated: false,
        tokens,
      })
      remaining -= tokens
      continue
    }

    if (remaining >= 200) {
      const truncated = truncateTextToTokenBudget(text, remaining, options)
      if (truncated) {
        selected.push({
          index,
          content: truncated,
          truncated: true,
          tokens: estimateTextTokens(truncated, options),
        })
      }
    }
    break
  }

  return selected.reverse()
}

export function splitMessagesIntoTokenBatches(
  messages = [],
  maxBatchTokens = 40_000,
  options = {},
) {
  const batches = []
  let current = []
  let currentTokens = 0
  const limit = Math.max(1_000, Math.floor(maxBatchTokens))

  const expandedMessages = (Array.isArray(messages) ? messages : []).flatMap(
    (message) => splitOversizedMessageForBatch(message, limit, options),
  )

  for (const message of expandedMessages) {
    const messageTokens = estimateMessageTokens(message, options)
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
    'Preserve runtime execution context: current work, completed stages, next step, reusable artifact IDs, and successful tool evidence such as file reads, searches, commands, writes, and verifications.',
    'Do not invent details. If something is uncertain, label it as uncertain.',
  ].join('\n')
}

export function buildCompactionUserPrompt(messages = [], options = {}) {
  const previousSummary =
    typeof options.previousSummary === 'string'
      ? options.previousSummary.trim()
      : ''
  const batchLabel =
    typeof options.batchCount === 'number' && options.batchCount > 1
      ? `This is batch ${(options.batchIndex || 0) + 1} of ${options.batchCount}.`
      : ''

  return [
    previousSummary
      ? `Update the running compacted summary with the following ${messages.length} earlier conversation message(s).`
      : `Compress the following ${messages.length} earlier conversation message(s).`,
    batchLabel,
    previousSummary ? 'Running summary from earlier batches:' : '',
    previousSummary || '',
    previousSummary
      ? 'Revise that running summary with the new batch below. Preserve continuing state, and let newer facts override older ones when they conflict.'
      : '',
    'The most recent conversation messages will be provided separately and should not be repeated unless needed to connect context.',
    '',
    formatMessagesForCompaction(messages),
  ]
    .filter(Boolean)
    .join('\n')
}

export function buildCompressedSummaryMessage(
  summary,
  originalMessageCount,
  metadata = {},
) {
  const recentUserMessages = Array.isArray(metadata.recentUserMessages)
    ? metadata.recentUserMessages
    : []
  const recentUserMessageSection =
    recentUserMessages.length > 0
      ? [
          '',
          '## Recent User Messages Preserved Verbatim',
          ...recentUserMessages.map((message, index) =>
            [
              `### User message ${index + 1}${message.truncated ? ' (truncated)' : ''}`,
              String(message.content || '').trim(),
            ].join('\n'),
          ),
        ]
      : []
  const lines = [
    `[Compressed summary of ${originalMessageCount} earlier conversation message(s).]`,
    metadata.beforeTokens && metadata.afterTokens
      ? `Estimated tokens: ${metadata.beforeTokens} -> ${metadata.afterTokens}.`
      : null,
    metadata.droppedMessageCount
      ? `Compaction fallback omitted ${metadata.droppedMessageCount} oldest message(s) from the summarization prompt.`
      : null,
    '',
    String(summary || '').trim(),
    ...recentUserMessageSection,
  ].filter((line) => line !== null)

  return {
    role: 'assistant',
    content: lines.join('\n').trim(),
    parts: [],
  }
}

export function calculateTranscriptBudget(settings = {}, options = {}) {
  const budget = buildContextCompressionBudget(settings, options)
  const conversationBudget = Math.max(1_000, budget.effectiveThresholdTokens)

  const assistantContentRatio =
    Number(settings.assistantContentBudgetRatio) || 0.08
  const assistantWindowRatio =
    Number(settings.assistantContentWindowRatio) || 0.03
  const assistantContentMaxTokens = Math.max(
    1_000,
    Math.floor(
      Math.min(
        conversationBudget * assistantContentRatio,
        budget.contextWindowTokens * assistantWindowRatio,
      ),
    ),
  )

  const toolOutputRatio = Number(settings.toolOutputBudgetRatio) || 0.05
  const toolOutputWindowRatio = Number(settings.toolOutputWindowRatio) || 0.02
  const toolOutputMaxTokens = Math.max(
    500,
    Math.floor(
      Math.min(
        conversationBudget * toolOutputRatio,
        budget.contextWindowTokens * toolOutputWindowRatio,
      ),
    ),
  )

  return {
    ...budget,
    assistantContentMaxTokens,
    toolOutputMaxTokens,
  }
}

export const __testInternals = {
  DEFAULT_KEEP_RECENT_MESSAGE_COUNT,
  estimatePartTokens,
  findActiveProviderProfile,
  findModelMetadata,
}
