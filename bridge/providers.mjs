import {
  appendRuntimeToolEvidenceToSystemPrompt,
  invokeTool,
  spillRuntimeArtifact,
} from './tools.mjs'
import { createStructuredError } from './runtimeErrors.mjs'
import { buildDeliveryPolicy } from './agentEvidence.mjs'
import { normalizeBaseUrl, stringifyOutput, truncate } from './utils.mjs'
import { guardedFetch } from './web/net/guardedFetch.mjs'
import { createApplyPatchStreamingReporter } from './editing/applyPatchStreaming.mjs'
import {
  buildContextCompressionBudget,
  buildCompactionSystemPrompt,
  buildCompactionUserPrompt,
  buildCompressedSummaryMessage,
  calculateTranscriptBudget,
  DEFAULT_RECENT_USER_MESSAGE_TOKEN_BUDGET,
  estimateTextTokens,
  estimateMessagesTokens,
  selectRecentUserMessagesForCompactionSummary,
  splitMessagesIntoTokenBatches,
} from './contextCompression.mjs'

function createRuntimeId(prefix = 'runtime') {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

const ASSISTANT_SPILLOVER_TRIGGER_TOKENS = 6_000
const ASSISTANT_SPILLOVER_SUMMARY_CHARS = 1_200
const FINALIZER_DRAFT_MESSAGE_MAX_CHARS = 6_000

function buildTranscriptTruncationBudgets(settings = {}) {
  const budget = calculateTranscriptBudget(settings)
  return {
    assistantContentMaxTokens: budget.assistantContentMaxTokens,
    toolOutputMaxTokens: budget.toolOutputMaxTokens,
  }
}

function middleTruncateText(text, maxTokens, settings = {}) {
  const source = String(text || '')
  if (!source.trim()) {
    return source
  }
  const currentTokens = estimateTextTokens(source, settings)
  if (currentTokens <= maxTokens) {
    return source
  }

  const ratio = maxTokens / currentTokens
  const targetChars = Math.max(200, Math.floor(source.length * ratio))
  const headChars = Math.floor(targetChars * 0.6)
  const tailChars = Math.floor(targetChars * 0.3)
  const head = source.slice(0, headChars)
  const tail = source.slice(-tailChars)
  return `${head}\n\n... [truncated: ${currentTokens} -> ~${maxTokens} tokens] ...\n\n${tail}`
}

function truncateAssistantContentForTranscript(content, settings = {}) {
  const source = String(content || '')
  if (!source.trim()) {
    return source
  }
  const budgets = buildTranscriptTruncationBudgets(settings)
  return middleTruncateText(source, budgets.assistantContentMaxTokens, settings)
}

function truncateToolOutputForTranscript(toolOutput, settings = {}) {
  const source =
    typeof toolOutput === 'string' ? toolOutput : JSON.stringify(toolOutput)
  if (!source?.trim()) {
    return toolOutput
  }
  const budgets = buildTranscriptTruncationBudgets(settings)
  const truncated = middleTruncateText(
    source,
    budgets.toolOutputMaxTokens,
    settings,
  )
  if (truncated === source) {
    return toolOutput
  }
  return truncated
}

function summarizeSpilloverText(content = '') {
  const normalized = String(content || '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!normalized) {
    return 'No textual summary available.'
  }
  const head = normalized.slice(
    0,
    Math.floor(ASSISTANT_SPILLOVER_SUMMARY_CHARS * 0.7),
  )
  const tail =
    normalized.length > ASSISTANT_SPILLOVER_SUMMARY_CHARS
      ? normalized.slice(-Math.floor(ASSISTANT_SPILLOVER_SUMMARY_CHARS * 0.25))
      : ''
  return tail ? `${head} ... ${tail}` : head
}

function maybeSpillAssistantContent({
  content = '',
  settings = {},
  hooks,
  toolEvents = [],
  providerKind = 'provider',
  reason = 'continuation',
  order,
  stage,
}) {
  const source = String(content || '')
  if (!source.trim() || !hooks?.workMemoryContext) {
    return {
      content: source,
      spilled: false,
    }
  }
  const tokenEstimate = estimateTextTokens(source, settings)
  if (tokenEstimate < ASSISTANT_SPILLOVER_TRIGGER_TOKENS) {
    return {
      content: source,
      spilled: false,
      tokenEstimate,
    }
  }

  const summaryText = summarizeSpilloverText(source)
  const spilled = spillRuntimeArtifact(hooks.workMemoryContext, {
    type: 'draft',
    title: `Intermediate ${providerKind} output`,
    content: {
      providerKind,
      reason,
      stage,
      text: source,
    },
    summary: summaryText,
    metadata: {
      providerKind,
      reason,
      tokenEstimate,
      charCount: source.length,
    },
    sourceRefs: [
      {
        providerKind,
        stage,
        reason,
      },
    ],
  })

  if (!spilled?.summary?.id) {
    return {
      content: source,
      spilled: false,
      tokenEstimate,
    }
  }

  const replacement = [
    '[Large intermediate assistant output saved outside the active transcript]',
    `Artifact: ${spilled.summary.id}`,
    `Reason: ${reason}`,
    `Original estimate: ${tokenEstimate} tokens, ${source.length} chars.`,
    `Summary: ${summaryText}`,
    'Continue from runtime progress/artifact summaries. Read a bounded artifact slice only if exact prior content is needed.',
  ].join('\n')

  const event = {
    id: createRuntimeId('assistant-output-spillover'),
    source: 'builtin',
    name: 'assistant_output_spillover',
    summary: `Long intermediate assistant output saved as artifact ${spilled.summary.id}.`,
    order: typeof order === 'number' ? order : undefined,
    status: 'success',
    input: `${providerKind}:${reason}`,
    output: stringifyOutput({
      artifact: spilled.summary,
      tokenEstimate,
      charCount: source.length,
      replacementPreview: truncate(replacement, 900),
    }),
  }
  toolEvents.push(event)
  hooks?.onToolEvent?.(event)
  hooks?.onReasoningDelta?.(
    `Assistant output spillover: ${tokenEstimate} estimated tokens saved as ${spilled.summary.id}.`,
    {
      blockId: `assistant-output-spillover-${providerKind}-${stage || 'runtime'}`,
      kind: 'summary',
      order: typeof order === 'number' ? order : -90,
    },
  )

  return {
    content: replacement,
    originalContent: source,
    spilled: true,
    artifact: spilled.summary,
    tokenEstimate,
  }
}

function flattenOpenAiMessageContent(content) {
  if (typeof content === 'string') {
    return content
  }
  if (!Array.isArray(content)) {
    return ''
  }
  return content
    .map((block) => {
      if (!block || typeof block !== 'object') {
        return ''
      }
      if (block.type === 'text' && typeof block.text === 'string') {
        return block.text
      }
      if (typeof block.text === 'string') {
        return block.text
      }
      return ''
    })
    .filter(Boolean)
    .join('\n')
}

function normalizeOpenAiUsage(usage) {
  if (!usage || typeof usage !== 'object') {
    return undefined
  }
  const inputTokens = Math.max(0, Math.round(Number(usage.prompt_tokens) || 0))
  const outputTokens = Math.max(
    0,
    Math.round(Number(usage.completion_tokens) || 0),
  )
  if (inputTokens <= 0 && outputTokens <= 0) {
    return undefined
  }
  return {
    inputTokens,
    outputTokens,
  }
}

function normalizeGoogleUsage(usage) {
  if (!usage || typeof usage !== 'object') {
    return undefined
  }
  const inputTokens = Math.max(
    0,
    Math.round(Number(usage.promptTokenCount) || 0),
  )
  const outputTokens = Math.max(
    0,
    Math.round(Number(usage.candidatesTokenCount) || 0),
  )
  if (inputTokens <= 0 && outputTokens <= 0) {
    return undefined
  }
  return {
    inputTokens,
    outputTokens,
  }
}

function attachEstimatedInputTokens(usage, estimatedInputTokens) {
  if (!usage) {
    return undefined
  }
  const estimate = Math.max(0, Math.round(Number(estimatedInputTokens) || 0))
  return estimate > 0 ? { ...usage, estimatedInputTokens: estimate } : usage
}

function buildEstimatedUsage(
  estimatedInputTokens,
  outputText = '',
  settings = {},
) {
  const inputTokens = Math.max(0, Math.round(Number(estimatedInputTokens) || 0))
  if (inputTokens <= 0) {
    return undefined
  }
  return {
    inputTokens,
    outputTokens: estimateTextTokens(outputText || '', settings),
    estimatedInputTokens: inputTokens,
  }
}

function estimateSerializedInputTokens(value, settings = {}) {
  try {
    return estimateTextTokens(JSON.stringify(value), settings)
  } catch {
    return 0
  }
}

function estimateOpenAiRequestInputTokens(
  transcript,
  tools = [],
  settings = {},
) {
  return estimateSerializedInputTokens(
    {
      messages: transcript,
      tools: openAiToolDefs(tools),
    },
    settings,
  )
}

function estimateGoogleRequestInputTokens(
  systemPrompt,
  transcript,
  tools = [],
  settings = {},
) {
  return estimateSerializedInputTokens(
    {
      system_instruction: {
        parts: [{ text: systemPrompt }],
      },
      contents: transcript,
      tools: geminiToolDefs(tools),
    },
    settings,
  )
}

function openAiToolDefs(tools) {
  return tools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    },
  }))
}

function geminiToolDefs(tools) {
  return tools.map((tool) => ({
    functionDeclarations: [
      {
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
      },
    ],
  }))
}

function normalizeMessageParts(message) {
  if (Array.isArray(message.parts) && message.parts.length > 0) {
    return message.parts
  }
  return message.content ? [{ type: 'text', text: message.content }] : []
}

function splitDataUrl(dataUrl) {
  const match = /^data:([^;,]+);base64,(.+)$/u.exec(dataUrl || '')
  if (!match) {
    return null
  }
  return {
    mimeType: match[1],
    data: match[2],
  }
}

function toOpenAiContent(message) {
  const parts = normalizeMessageParts(message)
  const blocks = parts.flatMap((part) => {
    if (part.type === 'text') {
      return part.text.trim() ? [{ type: 'text', text: part.text }] : []
    }
    if (part.type === 'image' && part.dataUrl) {
      return [
        {
          type: 'image_url',
          image_url: {
            url: part.dataUrl,
          },
        },
      ]
    }
    return []
  })

  if (blocks.length === 0) {
    return message.content || ''
  }
  if (
    blocks.length === 1 &&
    blocks[0].type === 'text' &&
    !Array.isArray(message.parts)
  ) {
    return blocks[0].text
  }
  return blocks
}

function toOpenAiTranscript(systemPrompt, messages) {
  return [
    {
      role: 'system',
      content: systemPrompt,
    },
    ...messages.map((message) => {
      if (message.role === 'assistant') {
        return {
          role: 'assistant',
          content: message.content,
        }
      }
      return {
        role: message.role,
        content: toOpenAiContent(message),
      }
    }),
  ]
}

function toGeminiParts(message) {
  const parts = normalizeMessageParts(message)
  const mapped = parts.flatMap((part) => {
    if (part.type === 'text') {
      return part.text.trim() ? [{ text: part.text }] : []
    }
    if (part.type === 'image' && part.dataUrl) {
      const parsed = splitDataUrl(part.dataUrl)
      if (!parsed) {
        return []
      }
      return [
        {
          inline_data: {
            mime_type: part.mimeType || parsed.mimeType,
            data: parsed.data,
          },
        },
      ]
    }
    return []
  })

  return mapped.length > 0
    ? mapped
    : message.content
      ? [{ text: message.content }]
      : []
}

function toGeminiContents(messages) {
  return messages.map((message) => ({
    role: message.role === 'assistant' ? 'model' : 'user',
    parts: toGeminiParts(message),
  }))
}

function resolveCompactionSettings(settings = {}) {
  const profiles = Array.isArray(settings.providerProfiles)
    ? settings.providerProfiles
    : []
  const requestedProfileId =
    typeof settings.analysisProviderProfileId === 'string'
      ? settings.analysisProviderProfileId.trim()
      : ''
  const requestedModel =
    typeof settings.analysisModel === 'string'
      ? settings.analysisModel.trim()
      : ''

  if (requestedProfileId && requestedModel) {
    const profile = profiles.find((entry) => entry?.id === requestedProfileId)
    const modelEnabled = Array.isArray(profile?.models)
      ? profile.models.some(
          (model) => model?.enabled !== false && model?.id === requestedModel,
        )
      : false

    if (profile && modelEnabled) {
      return {
        ...settings,
        provider: profile.provider || settings.provider,
        apiKey: profile.apiKey || settings.apiKey,
        baseUrl: profile.baseUrl || settings.baseUrl,
        model: requestedModel,
      }
    }
  }

  return settings
}

function drainAppendedInputs(hooks) {
  if (typeof hooks?.consumeAppendedInputs !== 'function') {
    return []
  }
  const consumed = hooks.consumeAppendedInputs()
  return Array.isArray(consumed) ? consumed : []
}

function appendQueuedInputsToOpenAiTranscript(transcript, messages, hooks) {
  const queuedInputs = drainAppendedInputs(hooks)
  if (queuedInputs.length === 0) {
    return 0
  }

  for (const input of queuedInputs) {
    messages.push(input)
    transcript.push({
      role: 'user',
      content: toOpenAiContent(input),
    })
  }

  return queuedInputs.length
}

function appendQueuedInputsToGeminiTranscript(transcript, messages, hooks) {
  const queuedInputs = drainAppendedInputs(hooks)
  if (queuedInputs.length === 0) {
    return 0
  }

  for (const input of queuedInputs) {
    messages.push(input)
    transcript.push({
      role: 'user',
      parts: toGeminiParts(input),
    })
  }

  return queuedInputs.length
}

function buildFinalizerPrompt({
  toolEvents,
  reasoningText,
  draftMessage,
  completionState,
  deliveryPolicy,
  responseStyle,
  includeToolDigest = true,
  includeReasoningText = true,
}) {
  const toolDigest = includeToolDigest
    ? toolEvents
        .slice(-8)
        .map((event) => {
          const pieces = [
            `- ${event.name} [${event.status}]`,
            event.output
              ? `输出摘要: ${String(event.output).slice(0, 600)}`
              : null,
            event.error ? `错误: ${String(event.error).slice(0, 300)}` : null,
          ].filter(Boolean)
          return pieces.join('\n')
        })
        .join('\n')
    : ''
  const reasoningDigest =
    includeReasoningText && reasoningText?.trim()
      ? `本轮原始思考流（仅供你整理最终回答，不要照抄）：\n${reasoningText.slice(0, 6000)}`
      : null

  return [
    '请基于当前对话和以下执行结果，直接输出给用户的最终回答。',
    '不要继续思考，不要调用工具，不要输出 <think> 标签。',
    '如果前面已经写了一句开场白，请直接补成完整、可交付的最终回答。',
    '把答案整理成专业、克制、面向用户的表述。删掉内部实现细节，不要提预算、路由层级、pass limit、控制器、系统提示或工具挂载状态。',
    responseStyle === 'research-structured'
      ? '当前任务更适合证据驱动的表达。必要时可以使用简洁的小标题来区分结论、已印证信息、存疑点或下一步，但只有在这些结构确实提升可读性时才使用。'
      : '简单问题请直接简洁回答。不要为了显得完整而强行套用研究报告结构。',
    completionState ? `System completion state: ${completionState}` : null,
    deliveryPolicy?.allowedWording
      ? `Allowed wording: ${deliveryPolicy.allowedWording}`
      : null,
    draftMessage?.trim()
      ? `当前已有但不完整的回答：\n${truncate(draftMessage, FINALIZER_DRAFT_MESSAGE_MAX_CHARS)}`
      : null,
    toolDigest ? `本轮工具结果摘要：\n${toolDigest}` : null,
    reasoningDigest,
  ]
    .filter(Boolean)
    .join('\n\n')
}

function resolveCompactionOutputTokens(targetTokens, recentTokens = 0) {
  return Math.max(
    800,
    Math.min(
      8_000,
      Math.floor(Number(targetTokens) || 0) - Math.floor(recentTokens),
    ),
  )
}

function chooseRecentMessagesForCompaction(
  allMessages,
  requestedRecentCount,
  targetTokens,
  settings = {},
) {
  const maxRecentCount = Math.min(
    requestedRecentCount,
    Math.max(0, (Array.isArray(allMessages) ? allMessages.length : 0) - 1),
  )
  const recentTokenBudget = Math.max(
    1_200,
    Math.min(
      Math.max(1_200, Math.floor(Number(targetTokens) || 0) - 1_200),
      Math.floor((Number(targetTokens) || 0) * 0.5),
    ),
  )

  let recentCount = maxRecentCount
  while (recentCount > 0) {
    const recentMessages = allMessages.slice(-recentCount)
    const recentTokens = estimateMessagesTokens(recentMessages, settings)
    if (recentTokens <= recentTokenBudget) {
      return {
        recentCount,
        recentMessages,
        olderMessages: allMessages.slice(0, -recentCount),
        recentTokens,
      }
    }
    recentCount -= 1
  }

  return {
    recentCount: 0,
    recentMessages: [],
    olderMessages: allMessages,
    recentTokens: 0,
  }
}

function compactionErrorText(error) {
  if (error && typeof error === 'object') {
    return [
      error.code,
      error.status,
      error.rawMessage,
      error.message,
      error.stack,
    ]
      .filter((value) => value !== undefined && value !== null)
      .join('\n')
  }
  return String(error || '')
}

function isLikelyContextWindowError(error) {
  const text = compactionErrorText(error).toLowerCase()
  return (
    text.includes('context length') ||
    text.includes('context window') ||
    text.includes('maximum context') ||
    text.includes('max context') ||
    text.includes('too many tokens') ||
    text.includes('token limit') ||
    text.includes('input is too long') ||
    text.includes('request too large') ||
    text.includes('payload too large') ||
    text.includes('exceeds the model') ||
    text.includes('exceed context') ||
    text.includes('context_length_exceeded') ||
    text.includes('413')
  )
}

function buildCompactionFallbackPlans(maxInputBatchTokens, compactionBudget) {
  const baseLimit = Math.max(
    1_000,
    Math.floor(
      Math.min(
        maxInputBatchTokens,
        compactionBudget.compactionInputBatchTokens,
      ),
    ),
  )
  const limits = [
    baseLimit,
    Math.floor(baseLimit * 0.5),
    Math.floor(baseLimit * 0.25),
  ]
    .map((limit) => Math.max(1_000, limit))
    .filter((limit, index, all) => all.indexOf(limit) === index)

  return [
    ...limits.map((limit) => ({
      batchTokenLimit: limit,
      dropOldestRatio: 0,
    })),
    {
      batchTokenLimit: limits.at(-1) || baseLimit,
      dropOldestRatio: 0.25,
    },
  ]
}

function flattenGeminiTextResponse(data) {
  const parts = data?.candidates?.[0]?.content?.parts || []
  return parts
    .map((part) => (typeof part.text === 'string' ? part.text : ''))
    .join('\n')
    .trim()
}

function openAiTranscriptEntryText(entry, index) {
  const lines = [
    `### Transcript entry ${index + 1} (${entry?.role || 'unknown'})`,
  ]
  if (typeof entry?.content === 'string' && entry.content.trim()) {
    lines.push(entry.content.trim())
  } else if (Array.isArray(entry?.content)) {
    const text = entry.content
      .map((part) => {
        if (part?.type === 'text') {
          return part.text || ''
        }
        if (part?.type === 'image_url') {
          return '[Image input omitted; preserve that an image input existed.]'
        }
        return JSON.stringify(part)
      })
      .filter(Boolean)
      .join('\n')
    if (text.trim()) {
      lines.push(text)
    }
  }
  if (Array.isArray(entry?.tool_calls) && entry.tool_calls.length > 0) {
    lines.push(
      `Tool calls:\n${entry.tool_calls
        .map((toolCall) =>
          [
            `- ${toolCall?.function?.name || 'unknown'}`,
            toolCall?.function?.arguments
              ? `args=${toolCall.function.arguments}`
              : null,
          ]
            .filter(Boolean)
            .join(' '),
        )
        .join('\n')}`,
    )
  }
  if (entry?.tool_call_id) {
    lines.push(`tool_call_id: ${entry.tool_call_id}`)
  }
  return lines.join('\n\n')
}

function estimateOpenAiTranscriptTokens(transcript = [], settings = {}) {
  return (Array.isArray(transcript) ? transcript : []).reduce(
    (total, entry, index) =>
      total +
      estimateTextTokens(openAiTranscriptEntryText(entry, index), settings) +
      4,
    0,
  )
}

function geminiPartText(part) {
  if (typeof part?.text === 'string') {
    return part.text
  }
  if (part?.functionCall) {
    return `Function call: ${part.functionCall.name || 'unknown'} args=${JSON.stringify(part.functionCall.args || {})}`
  }
  if (part?.functionResponse) {
    return `Function response: ${part.functionResponse.name || 'unknown'} output=${JSON.stringify(part.functionResponse.response || {})}`
  }
  if (part?.inline_data || part?.inlineData) {
    return '[Inline binary input omitted; preserve that binary input existed.]'
  }
  return part ? JSON.stringify(part) : ''
}

function geminiTranscriptEntryText(entry, index) {
  const lines = [
    `### Transcript entry ${index + 1} (${entry?.role || 'unknown'})`,
  ]
  const parts = Array.isArray(entry?.parts)
    ? entry.parts.map(geminiPartText).filter(Boolean).join('\n')
    : ''
  if (parts.trim()) {
    lines.push(parts)
  }
  return lines.join('\n\n')
}

function estimateGeminiTranscriptTokens(transcript = [], settings = {}) {
  return (Array.isArray(transcript) ? transcript : []).reduce(
    (total, entry, index) =>
      total +
      estimateTextTokens(geminiTranscriptEntryText(entry, index), settings) +
      4,
    0,
  )
}

function hasOpenAiToolCall(entry) {
  return Array.isArray(entry?.tool_calls) && entry.tool_calls.length > 0
}

function chooseOpenAiRecentTranscriptStart(transcript, keepRecentEntries) {
  let start = Math.max(1, transcript.length - keepRecentEntries)
  while (start > 1 && transcript[start]?.role === 'tool') {
    start -= 1
  }
  while (start > 1 && transcript[start - 1]?.role === 'tool') {
    start -= 1
  }
  if (start > 1 && hasOpenAiToolCall(transcript[start - 1])) {
    start -= 1
  }
  return start
}

function hasGeminiFunctionCall(entry) {
  return (
    Array.isArray(entry?.parts) &&
    entry.parts.some((part) => part?.functionCall)
  )
}

function hasGeminiFunctionResponse(entry) {
  return (
    Array.isArray(entry?.parts) &&
    entry.parts.some((part) => part?.functionResponse)
  )
}

function chooseGeminiRecentTranscriptStart(transcript, keepRecentEntries) {
  let start = Math.max(0, transcript.length - keepRecentEntries)
  while (start > 0 && hasGeminiFunctionResponse(transcript[start])) {
    start -= 1
  }
  if (start > 0 && hasGeminiFunctionCall(transcript[start - 1])) {
    start -= 1
  }
  return start
}

function transcriptEntriesToMessages(entries, formatter) {
  return entries.map((entry, index) => ({
    role: entry?.role === 'user' ? 'user' : 'assistant',
    content: formatter(entry, index),
    parts: [],
  }))
}

async function compactRuntimeTranscript({
  settings,
  transcript,
  estimateTokens,
  formatEntry,
  buildSummaryEntry,
  chooseRecentStart,
  systemPrompt = '',
  toolSchemaTokens = 0,
  hooks,
  providerKind,
}) {
  const estimatedTokens = estimateTokens(transcript, settings)
  const budget = buildContextCompressionBudget(settings, {
    systemPrompt,
    toolSchemaTokens,
  })
  if (estimatedTokens <= budget.effectiveThresholdTokens) {
    return transcript
  }

  const recentStart = chooseRecentStart(transcript, 8)
  const preservedPrefix =
    providerKind === 'openai' ? transcript.slice(0, 1) : []
  const olderEntries = transcript.slice(
    providerKind === 'openai' ? 1 : 0,
    recentStart,
  )
  const recentEntries = transcript.slice(recentStart)
  if (olderEntries.length === 0) {
    return transcript
  }

  const summaryMessages = await compactMessagesWithProvider({
    settings,
    messages: transcriptEntriesToMessages(olderEntries, formatEntry),
    targetTokens: Math.max(
      1_500,
      budget.targetConversationTokens - estimateTokens(recentEntries, settings),
    ),
    keepRecentCount: 0,
    maxInputBatchTokens: budget.compactionInputBatchTokens,
    hooks,
  })
  const summaryText = summaryMessages
    .map((message) => message.content)
    .join('\n\n')
  const compactedTranscript = [
    ...preservedPrefix,
    buildSummaryEntry(summaryText),
    ...recentEntries,
  ]
  const afterTokens = estimateTokens(compactedTranscript, settings)
  hooks?.onContextCompression?.({
    id: createRuntimeId(`runtime-transcript-compression-${providerKind}`),
    kind: 'provider_runtime_transcript',
    summary: summaryText,
    compressedThroughMessageId: '',
    originalMessageCount: Array.isArray(transcript) ? transcript.length : 0,
    originalTokenEstimate: Math.max(
      0,
      Math.round(Number(estimatedTokens) || 0),
    ),
    compressedTokenEstimate: Math.max(0, Math.round(Number(afterTokens) || 0)),
    createdAt: Date.now(),
    trigger: 'provider_runtime_transcript',
    contextWindowTokens: budget.contextWindowTokens,
    configuredContextWindowTokens: budget.configuredContextWindowTokens,
    configuredThresholdTokens: budget.configuredThresholdTokens,
    compressionThresholdTokens: budget.compressionThresholdTokens,
    effectiveThresholdTokens: budget.effectiveThresholdTokens,
    systemPromptTokens: budget.systemPromptTokens,
    toolSchemaTokens: budget.toolSchemaTokens,
    maxOutputTokens: budget.maxOutputTokens,
    toolResultBufferTokens: budget.toolResultBufferTokens,
    summaryTokens: estimateTextTokens(summaryText, settings),
    windowSource: budget.windowSource,
    preserved: [
      'compressed_summary',
      'recent_transcript_entries',
      'system_prompt',
    ],
    providerProfileId:
      typeof settings?.activeProviderProfileId === 'string'
        ? settings.activeProviderProfileId
        : undefined,
    model: typeof settings?.model === 'string' ? settings.model : undefined,
  })
  hooks?.onActiveContextEstimate?.({
    latestInputTokens: afterTokens,
    contextWindow: budget.contextWindowTokens,
    allowDecrease: true,
    reason: 'provider_runtime_transcript_compression',
  })
  hooks?.onReasoningDelta?.(
    `Runtime transcript compression: ${estimatedTokens} estimated tokens -> ${afterTokens} estimated tokens.`,
    {
      blockId: `runtime-transcript-compression-${providerKind}`,
      kind: 'summary',
      order: -99,
    },
  )
  return compactedTranscript
}

function compactOpenAiRuntimeTranscript({
  settings,
  transcript,
  systemPrompt,
  hooks,
  tools = [],
}) {
  const toolSchemaTokens = estimateTextTokens(
    JSON.stringify(openAiToolDefs(tools)),
    settings,
  )
  return compactRuntimeTranscript({
    settings,
    transcript,
    estimateTokens: estimateOpenAiTranscriptTokens,
    formatEntry: openAiTranscriptEntryText,
    buildSummaryEntry(summary) {
      return {
        role: 'assistant',
        content: `[Compressed runtime transcript summary]\n\n${summary}`,
      }
    },
    chooseRecentStart: chooseOpenAiRecentTranscriptStart,
    systemPrompt,
    toolSchemaTokens,
    hooks,
    providerKind: 'openai',
  })
}

function compactGeminiRuntimeTranscript({
  settings,
  transcript,
  systemPrompt,
  hooks,
  tools = [],
}) {
  const toolSchemaTokens = estimateTextTokens(
    JSON.stringify(geminiToolDefs(tools)),
    settings,
  )
  return compactRuntimeTranscript({
    settings,
    transcript,
    estimateTokens: estimateGeminiTranscriptTokens,
    formatEntry: geminiTranscriptEntryText,
    buildSummaryEntry(summary) {
      return {
        role: 'model',
        parts: [
          { text: `[Compressed runtime transcript summary]\n\n${summary}` },
        ],
      }
    },
    chooseRecentStart: chooseGeminiRecentTranscriptStart,
    systemPrompt,
    toolSchemaTokens,
    hooks,
    providerKind: 'gemini',
  })
}

async function callOpenAiCompatibleCompaction(
  settings,
  { systemPrompt, userPrompt, maxOutputTokens, messages, hooks },
) {
  const apiBase = normalizeBaseUrl(
    settings.baseUrl,
    'https://api.openai.com/v1',
  )
  const requestMessages = [
    {
      role: 'system',
      content: systemPrompt,
    },
    {
      role: 'user',
      content: userPrompt,
    },
  ]
  const estimatedInputTokens = estimateOpenAiRequestInputTokens(
    requestMessages,
    [],
    settings,
  )
  const response = await fetchWithTimeout(
    `${apiBase}/chat/completions`,
    {
      method: 'POST',
      headers: openAiCompatibleHeaders(settings),
      body: JSON.stringify({
        model: settings.model,
        messages: requestMessages,
        max_tokens: maxOutputTokens,
        stream: false,
      }),
    },
    {
      timeoutMs: PROVIDER_FINALIZATION_TIMEOUT_MS,
      timeoutMessage: 'Timed out while compacting conversation context.',
      messages,
      settings,
    },
  )

  if (!response.ok) {
    const data = await parseJsonResponse(response)
    throw buildProviderHttpError(
      response,
      data.error?.message || 'OpenAI-compatible compaction request failed',
      messages,
    )
  }

  const data = await parseJsonResponse(response)
  const content = flattenOpenAiMessageContent(
    data.choices?.[0]?.message?.content,
  ).trim()
  pushUsage(
    hooks,
    normalizeOpenAiUsage(data.usage) ||
      buildEstimatedUsage(estimatedInputTokens, content, settings),
  )
  return content
}

async function callGoogleCompaction(
  settings,
  { systemPrompt, userPrompt, maxOutputTokens, messages, hooks },
) {
  const apiBase = normalizeBaseUrl(
    settings.baseUrl,
    'https://generativelanguage.googleapis.com/v1beta',
  )
  const requestContents = [
    {
      role: 'user',
      parts: [{ text: userPrompt }],
    },
  ]
  const estimatedInputTokens = estimateGoogleRequestInputTokens(
    systemPrompt,
    requestContents,
    [],
    settings,
  )
  const response = await fetchWithTimeout(
    `${apiBase}/models/${settings.model}:generateContent`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-goog-api-key': settings.apiKey,
      },
      body: JSON.stringify({
        system_instruction: {
          parts: [{ text: systemPrompt }],
        },
        contents: requestContents,
        generationConfig: {
          maxOutputTokens,
        },
      }),
    },
    {
      timeoutMs: PROVIDER_FINALIZATION_TIMEOUT_MS,
      timeoutMessage: 'Timed out while compacting conversation context.',
      messages,
      settings,
    },
  )

  if (!response.ok) {
    const data = await parseJsonResponse(response)
    throw buildProviderHttpError(
      response,
      data.error?.message || 'Google compaction request failed',
      messages,
    )
  }

  const data = await parseJsonResponse(response)
  const content = flattenGeminiTextResponse(data)
  pushUsage(
    hooks,
    normalizeGoogleUsage(data.usageMetadata) ||
      buildEstimatedUsage(estimatedInputTokens, content, settings),
  )
  return content
}

async function callProviderForCompaction(settings, options) {
  if (settings.provider === 'google') {
    return callGoogleCompaction(settings, options)
  }

  if (settings.provider === 'openai' || settings.provider === 'custom') {
    return callOpenAiCompatibleCompaction(settings, options)
  }

  throw createStructuredError(
    `模型调用失败，当前 Provider "${settings.provider}" 不支持上下文压缩。`,
    {
      source: 'provider',
      category: 'unsupported',
      code: 'UNSUPPORTED_COMPACTION_PROVIDER',
      detail: `Unsupported compaction provider: ${settings.provider}`,
      suggestedAction: '请切换到 OpenAI-compatible 或 Google Provider 后再试。',
    },
  )
}

export async function compactMessagesWithProvider({
  settings,
  messages,
  targetTokens,
  keepRecentCount = 6,
  maxInputBatchTokens = 48_000,
  recentUserMessageTokenBudget = DEFAULT_RECENT_USER_MESSAGE_TOKEN_BUDGET,
  hooks,
  callProvider = callProviderForCompaction,
} = {}) {
  const allMessages = Array.isArray(messages) ? messages : []
  const requestedRecentCount =
    Number.isFinite(Number(keepRecentCount)) && Number(keepRecentCount) >= 0
      ? Math.floor(Number(keepRecentCount))
      : 6
  if (allMessages.length <= 1 && requestedRecentCount !== 0) {
    return allMessages
  }

  const compactionSettings = resolveCompactionSettings(settings)
  const compactionBudget = buildContextCompressionBudget(compactionSettings)
  const fallbackPlans = buildCompactionFallbackPlans(
    maxInputBatchTokens,
    compactionBudget,
  )
  let lastError

  for (const [attemptIndex, plan] of fallbackPlans.entries()) {
    try {
      const { recentMessages, olderMessages, recentTokens } =
        chooseRecentMessagesForCompaction(
          allMessages,
          requestedRecentCount,
          targetTokens,
          compactionSettings,
        )
      const maxOutputTokens = resolveCompactionOutputTokens(
        targetTokens,
        recentTokens,
      )
      const dropOldestCount =
        plan.dropOldestRatio > 0
          ? Math.min(
              Math.max(0, olderMessages.length - 1),
              Math.floor(olderMessages.length * plan.dropOldestRatio),
            )
          : 0
      const summarizableMessages =
        dropOldestCount > 0
          ? olderMessages.slice(dropOldestCount)
          : olderMessages
      const batches = splitMessagesIntoTokenBatches(
        summarizableMessages,
        plan.batchTokenLimit,
        compactionSettings,
      )
      let rollingSummary = ''

      hooks?.onPhaseChange?.('compressing_context')

      for (const [index, batch] of batches.entries()) {
        const batchTargetTokens = maxOutputTokens
        const summary = await callProvider(compactionSettings, {
          systemPrompt: buildCompactionSystemPrompt(batchTargetTokens),
          userPrompt: buildCompactionUserPrompt(batch, {
            batchIndex: index,
            batchCount: batches.length,
            previousSummary: rollingSummary,
          }),
          maxOutputTokens: batchTargetTokens,
          messages: allMessages,
          hooks,
        })
        rollingSummary = summary
      }

      const recentUserMessages = selectRecentUserMessagesForCompactionSummary(
        olderMessages,
        recentUserMessageTokenBudget,
        compactionSettings,
      )
      const beforeTokens = estimateMessagesTokens(
        olderMessages,
        compactionSettings,
      )
      const summaryMessage = buildCompressedSummaryMessage(
        rollingSummary || 'No older messages required model summarization.',
        olderMessages.length,
        {
          beforeTokens,
          recentUserMessages,
          droppedMessageCount: dropOldestCount,
        },
      )
      summaryMessage.content = buildCompressedSummaryMessage(
        rollingSummary || 'No older messages required model summarization.',
        olderMessages.length,
        {
          beforeTokens,
          afterTokens: estimateMessagesTokens(
            [summaryMessage],
            compactionSettings,
          ),
          recentUserMessages,
          droppedMessageCount: dropOldestCount,
        },
      ).content

      return [summaryMessage, ...recentMessages]
    } catch (error) {
      lastError = error
      const canFallback =
        attemptIndex < fallbackPlans.length - 1 &&
        isLikelyContextWindowError(error)
      if (!canFallback) {
        throw error
      }
      const nextPlan = fallbackPlans[attemptIndex + 1]
      hooks?.onReasoningDelta?.(
        [
          'Context compression fallback:',
          nextPlan.dropOldestRatio > 0
            ? 'dropping the oldest history slice and retrying with a smaller compaction batch.'
            : `retrying with smaller compaction batches (${nextPlan.batchTokenLimit} estimated tokens).`,
        ].join(' '),
        {
          blockId: `context-compression-fallback-${attemptIndex + 1}`,
          kind: 'summary',
          order: -101,
        },
      )
    }
  }

  throw lastError || new Error('Context compression failed.')
}

async function parseJsonResponse(response) {
  const text = await response.text()
  try {
    return JSON.parse(text)
  } catch {
    throw createStructuredError('模型服务返回了无法解析的数据。', {
      source: 'provider',
      category: 'invalid_input',
      code: 'INVALID_PROVIDER_JSON',
      detail: `Provider returned invalid JSON\n\n${text}`,
      suggestedAction: '请稍后重试，或切换到更稳定的模型 / 兼容接口。',
    })
  }
}

async function fetchWithTimeout(
  url,
  init,
  { timeoutMs, timeoutMessage, messages, settings },
) {
  try {
    return await guardedFetch(url, init, {
      timeoutMs,
      timeoutMessage,
      settings,
      proxyMode: 'provider-explicit',
      allowLocal: true,
    })
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    if (
      detail.includes(timeoutMessage) ||
      detail.includes('Request timed out after')
    ) {
      throw createClassifiedError('模型服务响应超时。', {
        source: 'provider',
        category: 'timeout',
        code: 'PROVIDER_REQUEST_TIMEOUT',
        rawMessage: presentProviderError(timeoutMessage, messages),
        suggestedAction:
          '当前模型响应较慢。你可以稍后重试，或切换到更稳定的 Provider / 模型。',
        retryable: true,
      })
    }
    throw error
  }
}

function openAiCompatibleHeaders(settings = {}) {
  const headers = {
    'content-type': 'application/json',
  }
  const apiKey =
    typeof settings.apiKey === 'string' ? settings.apiKey.trim() : ''
  if (apiKey) {
    headers.authorization = `Bearer ${apiKey}`
  }
  return headers
}

async function readChunkWithTimeout(
  reader,
  timeoutMs,
  timeoutMessage,
  messages,
) {
  let timerId
  try {
    return await Promise.race([
      reader.read(),
      new Promise((_, reject) => {
        timerId = setTimeout(() => {
          reject(
            createClassifiedError('模型服务流式输出长时间没有继续。', {
              source: 'provider',
              category: 'timeout',
              code: 'PROVIDER_STREAM_STALLED',
              rawMessage: presentProviderError(timeoutMessage, messages),
              suggestedAction:
                '当前流式连接似乎已经停滞。你可以稍后重试，或切换到更稳定的模型 / Provider。',
              retryable: true,
            }),
          )
        }, timeoutMs)
      }),
    ])
  } finally {
    clearTimeout(timerId)
  }
}

async function readSseStream(response, onData, options = {}) {
  if (!response.body) {
    throw createStructuredError('模型服务没有返回可读取的流式结果。', {
      source: 'provider',
      category: 'unavailable',
      code: 'EMPTY_PROVIDER_STREAM',
      detail: 'Provider returned an empty streaming response body.',
      suggestedAction: '请稍后重试，或切换到其他可用模型 / 服务。',
      retryable: true,
    })
  }

  const decoder = new TextDecoder()
  const reader = response.body.getReader()
  let buffer = ''
  let isFirstChunk = true
  const firstChunkTimeoutMs = options.firstChunkTimeoutMs || 45_000
  const idleTimeoutMs = options.idleTimeoutMs || 90_000

  while (true) {
    const { value, done } = await readChunkWithTimeout(
      reader,
      isFirstChunk ? firstChunkTimeoutMs : idleTimeoutMs,
      isFirstChunk
        ? 'Timed out while waiting for the first streaming chunk.'
        : 'Streaming response stalled while waiting for the next chunk.',
      options.messages,
    )
    if (done) {
      break
    }

    isFirstChunk = false
    options.onChunk?.()
    buffer += decoder.decode(value, { stream: true })

    while (true) {
      const delimiterMatch = /\r?\n\r?\n/u.exec(buffer)
      if (!delimiterMatch || delimiterMatch.index === undefined) {
        break
      }

      const rawEvent = buffer.slice(0, delimiterMatch.index)
      buffer = buffer.slice(delimiterMatch.index + delimiterMatch[0].length)
      const dataLines = rawEvent
        .split(/\r?\n/u)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())

      if (dataLines.length === 0) {
        continue
      }

      const payload = dataLines.join('\n')
      if (payload === '[DONE]') {
        return
      }

      await onData(payload)
    }
  }

  const trailing = buffer.trim()
  if (!trailing) {
    return
  }

  const dataLines = trailing
    .split(/\r?\n/u)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart())

  for (const payload of dataLines) {
    if (payload && payload !== '[DONE]') {
      await onData(payload)
    }
  }
}

function extractCompleteApplyPatchText(rawArgs) {
  const text = String(rawArgs || '')
  const beginMarker = '*** Begin Patch'
  const endMarker = '*** End Patch'
  const begin = text.indexOf(beginMarker)
  const end =
    begin >= 0 ? text.indexOf(endMarker, begin + beginMarker.length) : -1
  if (begin < 0 || end < 0) {
    return ''
  }
  return text.slice(begin, end + endMarker.length).trim()
}

function parseToolArguments(rawArgs, toolName = '') {
  if (!rawArgs?.trim()) {
    return {}
  }

  const rawApplyPatchText =
    toolName === 'apply_patch' ? extractCompleteApplyPatchText(rawArgs) : ''
  if (rawApplyPatchText && rawArgs.trim().startsWith('*** Begin Patch')) {
    return {
      patch: rawApplyPatchText,
    }
  }

  try {
    return JSON.parse(rawArgs)
  } catch (error) {
    if (rawApplyPatchText) {
      return {
        patch: rawApplyPatchText,
      }
    }

    const detail = error instanceof Error ? error.message : String(error)
    const preview =
      rawArgs.length > 1200 ? `${rawArgs.slice(0, 1200)}...` : rawArgs
    throw createClassifiedError('模型返回了无法解析的工具参数。', {
      source: 'provider',
      category: 'invalid_input',
      code: 'INVALID_TOOL_ARGUMENTS_JSON',
      rawMessage: `Tool arguments are not valid JSON: ${detail}\n\n${preview}`,
      suggestedAction:
        '当前模型 / 兼容接口返回的工具参数格式不稳定。请重试，或切换到工具调用兼容性更好的模型 / Provider。',
    })
  }
}

function mergeStreamedField(currentValue, incomingValue) {
  const current = currentValue || ''
  const incoming = incomingValue || ''

  if (!current) {
    return incoming
  }
  if (!incoming) {
    return current
  }
  if (incoming.startsWith(current)) {
    return incoming
  }
  if (current.endsWith(incoming)) {
    return current
  }

  const maxOverlap = Math.min(current.length, incoming.length)
  for (let size = maxOverlap; size > 0; size -= 1) {
    if (current.slice(-size) === incoming.slice(0, size)) {
      return `${current}${incoming.slice(size)}`
    }
  }

  return `${current}${incoming}`
}

function mergeOpenAiToolCalls(existingCalls, deltaCalls) {
  for (const deltaCall of deltaCalls || []) {
    const index = deltaCall.index ?? existingCalls.length
    const current = existingCalls[index] || {
      id: deltaCall.id || `tool-call-${index}`,
      type: 'function',
      function: {
        name: '',
        arguments: '',
      },
    }

    if (deltaCall.id) {
      current.id = deltaCall.id
    }
    if (deltaCall.function?.name) {
      current.function.name = mergeStreamedField(
        current.function.name,
        deltaCall.function.name,
      )
    }
    if (deltaCall.function?.arguments) {
      current.function.arguments = mergeStreamedField(
        current.function.arguments,
        deltaCall.function.arguments,
      )
    }

    existingCalls[index] = current
  }
}

function camelCaseKey(value) {
  return String(value || '').replace(/_([a-z])/g, (_, letter) =>
    letter.toUpperCase(),
  )
}

function normalizeInlineToolArgsValue(value) {
  if (Array.isArray(value)) {
    return value.map(normalizeInlineToolArgsValue)
  }
  if (!value || typeof value !== 'object') {
    return value
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      camelCaseKey(key),
      normalizeInlineToolArgsValue(entry),
    ]),
  )
}

function normalizeInlineToolName(rawName) {
  const normalized = String(rawName || '').trim()
  if (!normalized) {
    return ''
  }

  return normalized
    .replace(/^functions\./, '')
    .replace(/:\d+$/, '')
    .trim()
}

function normalizeInlineToolArgs(toolName, args) {
  const normalized =
    args && typeof args === 'object' && !Array.isArray(args)
      ? { ...normalizeInlineToolArgsValue(args) }
      : args

  if (
    !normalized ||
    typeof normalized !== 'object' ||
    Array.isArray(normalized)
  ) {
    return normalized
  }

  if (!normalized.path && typeof normalized.filePath === 'string') {
    normalized.path = normalized.filePath
  }
  if (!normalized.workdir && typeof normalized.cwd === 'string') {
    normalized.workdir = normalized.cwd
  }

  if (
    toolName === 'exec_command' &&
    !normalized.cmd &&
    typeof normalized.command === 'string'
  ) {
    normalized.cmd = normalized.command
  }
  if (
    toolName === 'run_shell' &&
    !normalized.command &&
    typeof normalized.cmd === 'string'
  ) {
    normalized.command = normalized.cmd
  }

  return normalized
}

function extractInlineToolCalls(text, startIndex = 0) {
  const normalizedText = typeof text === 'string' ? text : ''
  if (!normalizedText.includes('<|tool_calls_section_begin|>')) {
    return {
      text: normalizedText,
      toolCalls: [],
    }
  }

  const toolCalls = []
  const cleanedText = normalizedText
    .replace(
      /<\|tool_calls_section_begin\|>([\s\S]*?)<\|tool_calls_section_end\|>/gu,
      (_, sectionBody) => {
        const callPattern =
          /<\|tool_call_begin\|>\s*([^\s<]+)\s*<\|tool_call_argument_begin\|>\s*([\s\S]*?)\s*<\|tool_call_end\|>/gu

        for (const match of sectionBody.matchAll(callPattern)) {
          const rawName = typeof match[1] === 'string' ? match[1].trim() : ''
          const toolName = normalizeInlineToolName(rawName)
          if (!toolName) {
            continue
          }

          const rawArguments =
            typeof match[2] === 'string' ? match[2].trim() : '{}'
          let normalizedArguments = rawArguments

          try {
            const parsedArgs = JSON.parse(rawArguments)
            normalizedArguments = JSON.stringify(
              normalizeInlineToolArgs(toolName, parsedArgs),
            )
          } catch {
            normalizedArguments = rawArguments
          }

          toolCalls.push({
            index: startIndex + toolCalls.length,
            id: `inline-tool-call-${startIndex + toolCalls.length}`,
            type: 'function',
            function: {
              name: toolName,
              arguments: normalizedArguments,
            },
          })
        }

        return ''
      },
    )
    .replace(/\n{3,}/g, '\n\n')
    .trim()

  return {
    text: cleanedText,
    toolCalls,
  }
}

function dedupeInlineToolCalls(existingCalls, nextCalls) {
  return (nextCalls || []).filter((nextCall) => {
    const nextName = nextCall?.function?.name || ''
    const nextArguments = nextCall?.function?.arguments || ''
    return !existingCalls.some(
      (existingCall) =>
        (existingCall?.function?.name || '') === nextName &&
        (existingCall?.function?.arguments || '') === nextArguments,
    )
  })
}

export const __testInternals = {
  buildFinalizerPrompt,
  buildProviderRetryInfo,
  compactMessagesWithProvider,
  dedupeInlineToolCalls,
  extractInlineToolCalls,
  getProviderFailureRecoveryMaxRetries,
  getProviderRetryDelayMs,
  hasWriteRepairAttemptSince,
  maybeSpillAssistantContent,
  mergeStreamedField,
  mergeOpenAiToolCalls,
  parseToolArguments,
  resolveCompactionOutputTokens,
  resolveCompactionSettings,
  runProviderOperationWithRetry,
  updateUnresolvedToolErrorForRepair,
}

function pushUsage(hooks, usage) {
  if (!usage) {
    return
  }
  hooks?.onUsage?.(usage)
}

function createThinkStreamParser({ onContent, onReasoning }) {
  const openTag = '<think>'
  const closeTag = '</think>'
  const state = {
    buffer: '',
    insideThink: false,
  }

  function emitVisible(text) {
    if (!text) {
      return
    }
    onContent(text)
  }

  function emitReasoning(text) {
    if (!text) {
      return
    }
    onReasoning(text)
  }

  function consume(delta) {
    if (!delta) {
      return
    }
    state.buffer += delta

    while (state.buffer) {
      if (state.insideThink) {
        const closeIndex = state.buffer.indexOf(closeTag)
        if (closeIndex >= 0) {
          emitReasoning(state.buffer.slice(0, closeIndex))
          state.buffer = state.buffer.slice(closeIndex + closeTag.length)
          state.insideThink = false
          continue
        }

        const safeLength = Math.max(
          0,
          state.buffer.length - (closeTag.length - 1),
        )
        if (safeLength === 0) {
          break
        }
        emitReasoning(state.buffer.slice(0, safeLength))
        state.buffer = state.buffer.slice(safeLength)
        break
      }

      const openIndex = state.buffer.indexOf(openTag)
      if (openIndex >= 0) {
        emitVisible(state.buffer.slice(0, openIndex))
        state.buffer = state.buffer.slice(openIndex + openTag.length)
        state.insideThink = true
        continue
      }

      const safeLength = Math.max(0, state.buffer.length - (openTag.length - 1))
      if (safeLength === 0) {
        break
      }
      emitVisible(state.buffer.slice(0, safeLength))
      state.buffer = state.buffer.slice(safeLength)
      break
    }
  }

  function flush() {
    if (!state.buffer) {
      return
    }
    if (state.insideThink) {
      emitReasoning(state.buffer)
    } else {
      emitVisible(state.buffer)
    }
    state.buffer = ''
  }

  return {
    consume,
    flush,
  }
}

function hasImageInput(messages) {
  return messages.some((message) =>
    normalizeMessageParts(message).some((part) => part.type === 'image'),
  )
}

function presentProviderError(message, messages) {
  const normalized = (message || '').toLowerCase()
  if (
    hasImageInput(messages) &&
    /(image|vision|multimodal|inline_data|unsupported media type|does not support)/u.test(
      normalized,
    )
  ) {
    return `${message}\n\n当前模型可能不支持图片理解，或当前 Provider 对图片输入格式不兼容。请切换到支持视觉的模型后再试。`
  }
  return message
}

function classifyProviderHttpCategory(status) {
  if (status === 401 || status === 403) {
    return 'authentication'
  }
  if (status === 429) {
    return 'rate_limit'
  }
  if (
    status === 408 ||
    status === 409 ||
    status === 425 ||
    status === 499 ||
    (status >= 500 && status <= 599)
  ) {
    return 'unavailable'
  }
  return 'execution_failed'
}

function buildProviderHttpError(response, message, messages) {
  const presented = presentProviderError(message, messages)
  const status = response.status
  const category = classifyProviderHttpCategory(status)

  return createStructuredError('模型服务请求失败。', {
    source: 'provider',
    category,
    code: `HTTP_${status}`,
    status,
    detail: presented,
    suggestedAction:
      category === 'authentication'
        ? '请检查当前 Provider 的 API Key、账号权限或模型访问权限。'
        : category === 'rate_limit'
          ? '请稍后重试，或切换到其他可用模型 / 服务。'
          : category === 'unavailable'
            ? '请稍后重试，或确认当前 Provider 服务状态正常。'
            : '请展开详细信息查看原始报错，并确认当前 Provider / 模型配置是否正确。',
    retryable: category === 'rate_limit' || category === 'unavailable',
  })
}

function createClassifiedError(message, extras = {}) {
  return createStructuredError(message, {
    source: extras.source || 'provider',
    category: extras.category || 'execution_failed',
    code: extras.code,
    detail: extras.detail || extras.rawMessage || message,
    rawMessage: extras.rawMessage,
    suggestedAction: extras.suggestedAction,
    retryable: extras.retryable,
    status: extras.status,
  })
}

function isRetryableProviderError(error) {
  return error?.errorInfo?.retryable === true
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

const PROVIDER_CONNECT_TIMEOUT_MS = 45_000
const PROVIDER_STREAM_IDLE_TIMEOUT_MS = 90_000
const PROVIDER_FINALIZATION_TIMEOUT_MS = 60_000
const PROVIDER_RETRY_DELAYS_MS = [0, 1_200, 3_000, 7_000, 15_000]
const STEP_LIMIT_TOOL_ERROR_REPAIR_TURNS = 6
const STEP_LIMIT_TOOL_ERROR_WRITE_REPAIR_ATTEMPTS = 4

function providerRetryStageLabel(stage) {
  switch (stage) {
    case 'finalization':
      return '补充整理'
    case 'recovery':
      return '恢复回答'
    default:
      return '主回答'
  }
}

function getProviderFailureRecoveryMaxRetries() {
  return PROVIDER_RETRY_DELAYS_MS.length
}

function getProviderRetryDelayMs(retryNumber) {
  const normalizedRetryNumber =
    typeof retryNumber === 'number' && Number.isFinite(retryNumber)
      ? Math.max(1, Math.round(retryNumber))
      : 1
  const index = Math.min(
    PROVIDER_RETRY_DELAYS_MS.length - 1,
    normalizedRetryNumber - 1,
  )
  return PROVIDER_RETRY_DELAYS_MS[index] || 0
}

function buildProviderRetryInfo(retryCount, maxRetries, extras = {}) {
  if (retryCount <= 0) {
    return undefined
  }

  const stage = extras.stage || 'response'
  const retryInfo = {
    attemptedRetries: retryCount,
    configuredMaxRetries: maxRetries,
    configuredMaxAttempts: maxRetries + 1,
    stage,
    stageLabel: extras.stageLabel || providerRetryStageLabel(stage),
    recovered: extras.recovered === true,
  }

  if (typeof extras.inProgress === 'boolean') {
    retryInfo.inProgress = extras.inProgress
  }
  if (
    typeof extras.nextRetryDelayMs === 'number' &&
    Number.isFinite(extras.nextRetryDelayMs)
  ) {
    retryInfo.nextRetryDelayMs = Math.max(
      0,
      Math.round(extras.nextRetryDelayMs),
    )
  }
  if (
    typeof extras.nextAttemptNumber === 'number' &&
    Number.isFinite(extras.nextAttemptNumber)
  ) {
    retryInfo.nextAttemptNumber = Math.max(
      1,
      Math.round(extras.nextAttemptNumber),
    )
  }
  if (
    typeof extras.lastErrorSummary === 'string' &&
    extras.lastErrorSummary.trim()
  ) {
    retryInfo.lastErrorSummary = extras.lastErrorSummary.trim()
  }

  return retryInfo
}

function mergeProviderRetryInfo(...entries) {
  const validEntries = entries.filter(
    (entry) =>
      entry &&
      typeof entry.attemptedRetries === 'number' &&
      Number.isFinite(entry.attemptedRetries) &&
      entry.attemptedRetries > 0,
  )

  if (validEntries.length === 0) {
    return undefined
  }

  return validEntries.reduce((selected, entry) => {
    if (!selected) {
      return { ...entry }
    }

    if (selected.stage && entry.stage && selected.stage !== entry.stage) {
      return {
        ...entry,
        recovered: selected.recovered === true || entry.recovered === true,
      }
    }

    return {
      ...selected,
      ...entry,
      attemptedRetries: Math.max(
        selected.attemptedRetries,
        entry.attemptedRetries,
      ),
      configuredMaxRetries: Math.max(
        selected.configuredMaxRetries || 0,
        entry.configuredMaxRetries || 0,
      ),
      configuredMaxAttempts: Math.max(
        selected.configuredMaxAttempts || 0,
        entry.configuredMaxAttempts || 0,
      ),
      recovered: selected.recovered === true || entry.recovered === true,
    }
  }, undefined)
}

function extractProviderRetryInfo(value) {
  if (
    !value ||
    typeof value !== 'object' ||
    !value.retryInfo ||
    typeof value.retryInfo !== 'object'
  ) {
    return undefined
  }

  const retryInfo = value.retryInfo
  const configuredMaxRetries =
    typeof retryInfo.configuredMaxRetries === 'number' &&
    Number.isFinite(retryInfo.configuredMaxRetries)
      ? Math.max(0, Math.round(retryInfo.configuredMaxRetries))
      : typeof retryInfo.configuredMaxAttempts === 'number' &&
          Number.isFinite(retryInfo.configuredMaxAttempts)
        ? Math.max(0, Math.round(retryInfo.configuredMaxAttempts) - 1)
        : undefined
  const configuredMaxAttempts =
    typeof retryInfo.configuredMaxAttempts === 'number' &&
    Number.isFinite(retryInfo.configuredMaxAttempts)
      ? Math.max(1, Math.round(retryInfo.configuredMaxAttempts))
      : typeof configuredMaxRetries === 'number'
        ? configuredMaxRetries + 1
        : undefined
  if (
    typeof retryInfo.attemptedRetries !== 'number' ||
    !Number.isFinite(retryInfo.attemptedRetries) ||
    retryInfo.attemptedRetries <= 0 ||
    typeof configuredMaxAttempts !== 'number' ||
    configuredMaxAttempts <= 0
  ) {
    return undefined
  }

  return {
    attemptedRetries: Math.round(retryInfo.attemptedRetries),
    configuredMaxRetries,
    configuredMaxAttempts,
    stage:
      retryInfo.stage === 'response' ||
      retryInfo.stage === 'finalization' ||
      retryInfo.stage === 'recovery'
        ? retryInfo.stage
        : undefined,
    stageLabel:
      typeof retryInfo.stageLabel === 'string'
        ? retryInfo.stageLabel
        : undefined,
    recovered: retryInfo.recovered === true,
    inProgress: retryInfo.inProgress === true,
    nextRetryDelayMs:
      typeof retryInfo.nextRetryDelayMs === 'number' &&
      Number.isFinite(retryInfo.nextRetryDelayMs)
        ? Math.max(0, Math.round(retryInfo.nextRetryDelayMs))
        : undefined,
    nextAttemptNumber:
      typeof retryInfo.nextAttemptNumber === 'number' &&
      Number.isFinite(retryInfo.nextAttemptNumber)
        ? Math.max(1, Math.round(retryInfo.nextAttemptNumber))
        : undefined,
    lastErrorSummary:
      typeof retryInfo.lastErrorSummary === 'string'
        ? retryInfo.lastErrorSummary
        : undefined,
  }
}

function scorePartialProviderState(partialState) {
  if (!partialState) {
    return 0
  }

  const messageLength = (partialState.partialMessage || '').trim().length
  const reasoningLength = (partialState.partialReasoning || '').trim().length
  return messageLength * 4 + reasoningLength
}

function hasPartialProviderState(partialState) {
  return scorePartialProviderState(partialState) > 0
}

function pickPreferredPartialProviderState(currentState, nextState) {
  if (!hasPartialProviderState(nextState)) {
    return currentState
  }
  if (!hasPartialProviderState(currentState)) {
    return nextState
  }
  return scorePartialProviderState(nextState) >=
    scorePartialProviderState(currentState)
    ? nextState
    : currentState
}

function attachPartialProviderState(error, partialState) {
  if (!hasPartialProviderState(partialState)) {
    return error
  }

  const target = error instanceof Error ? error : new Error(String(error))
  const nextErrorInfo =
    target.errorInfo && typeof target.errorInfo === 'object'
      ? { ...target.errorInfo }
      : {}

  nextErrorInfo.partialMessage = partialState.partialMessage || ''
  nextErrorInfo.partialReasoning = partialState.partialReasoning || ''
  target.errorInfo = nextErrorInfo
  return target
}

function attachProviderRetryInfo(error, retryInfo) {
  if (!retryInfo) {
    return error
  }

  const target = error instanceof Error ? error : new Error(String(error))
  const existing = extractProviderRetryInfo(target)
  target.retryInfo = mergeProviderRetryInfo(existing, retryInfo) || retryInfo
  return target
}

function summarizeRetryError(error) {
  if (
    typeof error?.errorInfo?.summary === 'string' &&
    error.errorInfo.summary.trim()
  ) {
    return error.errorInfo.summary.trim()
  }
  if (error instanceof Error && error.message.trim()) {
    return error.message.trim()
  }
  return String(error || '').trim()
}

async function runProviderOperationWithRetry(
  operation,
  {
    messages,
    maxRetries = PROVIDER_RETRY_DELAYS_MS.length,
    stage = 'response',
    hooks,
  } = {},
) {
  let lastError
  let bestPartialState = null
  let retryCount = 0
  const maxAttempts = maxRetries + 1

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const attemptState = {
      receivedOutput: false,
      partialMessage: '',
      partialReasoning: '',
    }

    try {
      const value = await operation(attemptState, attempt)
      if (retryCount > 0) {
        hooks?.onRetryProgress?.(
          buildProviderRetryInfo(retryCount, maxRetries, {
            stage,
            lastErrorSummary: summarizeRetryError(lastError),
          }),
        )
      }
      return {
        value,
        retryCount,
        attemptsUsed: retryCount + 1,
      }
    } catch (error) {
      let normalized = maybeNormalizeProviderTermination(error, messages)
      bestPartialState = pickPreferredPartialProviderState(
        bestPartialState,
        attemptState,
      )
      normalized = attachPartialProviderState(normalized, bestPartialState)
      normalized = attachProviderRetryInfo(
        normalized,
        buildProviderRetryInfo(retryCount, maxRetries, {
          stage,
          lastErrorSummary: summarizeRetryError(normalized),
        }),
      )
      lastError = normalized

      if (attempt >= maxAttempts || !isRetryableProviderError(normalized)) {
        throw normalized
      }

      const nextRetryCount = retryCount + 1
      const nextRetryDelayMs = getProviderRetryDelayMs(nextRetryCount)
      hooks?.onRetryProgress?.(
        buildProviderRetryInfo(nextRetryCount, maxRetries, {
          stage,
          inProgress: true,
          nextRetryDelayMs,
          nextAttemptNumber: attempt + 1,
          lastErrorSummary: summarizeRetryError(normalized),
        }),
      )
      retryCount = nextRetryCount
      if (nextRetryDelayMs > 0) {
        await wait(nextRetryDelayMs)
      }
    }
  }

  throw lastError
}

function maybeNormalizeProviderTermination(error, messages) {
  const message = error instanceof Error ? error.message : String(error)
  const normalized = message.trim().toLowerCase()
  if (
    normalized === 'terminated' ||
    normalized.includes('terminated') ||
    normalized.includes('socket hang up') ||
    normalized.includes('eof') ||
    normalized.includes('aborted') ||
    normalized.includes('fetch failed') ||
    normalized.includes('network error') ||
    normalized.includes('networkerror') ||
    normalized.includes('timeout') ||
    normalized.includes('timed out') ||
    normalized.includes('econnreset') ||
    normalized.includes('econnrefused') ||
    normalized.includes('enotfound') ||
    normalized.includes('eai_again')
  ) {
    return createClassifiedError(
      '模型连接在生成过程中被中断。可能是 Provider 侧超时、连接断开，或当前模型/兼容接口对工具调用支持不稳定。',
      {
        code: 'provider_terminated',
        source: 'provider',
        category: 'network',
        rawMessage: presentProviderError(message, messages),
        suggestedAction:
          '请稍后重试，或切换到对工具调用支持更稳定的模型 / Provider。',
        retryable: true,
      },
    )
  }
  return error
}

function getLoopConfig(settings) {
  const boundedLimit = Math.max(
    1,
    Math.min(128, Number(settings.maxSteps) || 8),
  )
  if (settings.executionMode === 'long-task') {
    return {
      mode: 'long-task',
      maxIterations: 128,
      limitMessage:
        'Agent 长任务模式已被保护性停止：持续执行过久仍未收敛到最终回答。请尝试缩小任务范围、切换模型，或改用更高轮数的普通模式。',
    }
  }
  return {
    mode: 'bounded',
    maxIterations: boundedLimit,
    limitMessage: 'Agent reached the max step limit without a final answer.',
  }
}

const TOOL_ERROR_REPAIR_CLEARING_TOOLS = new Set([
  'apply_patch',
  'write_file',
  'edit_file',
  'multi_edit_file',
  'replace_line_range',
  'aura_install_skill',
  'aura_import_skill',
  'aura_enable_skill',
  'aura_install_plugin',
  'aura_import_plugin',
  'aura_enable_plugin',
  'aura_upsert_mcp_server',
  'aura_remove_mcp_server',
])

function hasWriteRepairAttemptSince(toolEvents, startIndex) {
  return toolEvents
    .slice(startIndex)
    .some(
      (event) =>
        TOOL_ERROR_REPAIR_CLEARING_TOOLS.has(event?.name) &&
        event?.errorInfo?.category !== 'invalid_input',
    )
}

function updateUnresolvedToolErrorForRepair(
  toolEvents,
  startIndex,
  previousValue,
) {
  let hasUnresolvedError = previousValue
  for (const event of toolEvents.slice(startIndex)) {
    if (event?.status === 'error') {
      hasUnresolvedError = true
      continue
    }
    if (
      event?.status === 'success' &&
      TOOL_ERROR_REPAIR_CLEARING_TOOLS.has(event?.name)
    ) {
      hasUnresolvedError = false
    }
  }
  return hasUnresolvedError
}

function joinReasoningBlocks(blocks = []) {
  return blocks
    .map((block) =>
      typeof block?.content === 'string' ? block.content.trim() : '',
    )
    .filter(Boolean)
    .join('\n\n')
}

async function finalizeOpenAiTranscriptAfterStepLimit({
  settings,
  apiBase,
  transcript,
  conversationMessages,
  toolEvents,
  providerReasoningBlocks,
  draftMessage,
  latestUsage,
  providerRetryCount,
  maxRetries,
  hooks,
}) {
  hooks?.onPhaseChange?.('finalizing')
  const prompt = buildFinalizerPrompt({
    toolEvents,
    reasoningText: joinReasoningBlocks(providerReasoningBlocks),
    draftMessage,
    completionState: 'needs_final_answer_after_tool_results',
    responseStyle: hooks?.routeState?.responseStyle,
    includeToolDigest: false,
    includeReasoningText: false,
  })
  const attemptResult = await runProviderOperationWithRetry(
    async () => {
      const requestMessages = [
        ...transcript,
        {
          role: 'user',
          content: prompt,
        },
      ]
      const estimatedInputTokens = estimateOpenAiRequestInputTokens(
        requestMessages,
        [],
        settings,
      )
      const response = await fetchWithTimeout(
        `${apiBase}/chat/completions`,
        {
          method: 'POST',
          headers: openAiCompatibleHeaders(settings),
          body: JSON.stringify({
            model: settings.model,
            messages: requestMessages,
            stream: false,
          }),
        },
        {
          timeoutMs: PROVIDER_FINALIZATION_TIMEOUT_MS,
          timeoutMessage:
            'Timed out while waiting for the final answer completion request.',
          messages: conversationMessages,
          settings,
        },
      )

      if (!response.ok) {
        const data = await parseJsonResponse(response)
        throw buildProviderHttpError(
          response,
          data.error?.message ||
            'OpenAI-compatible finalization request failed',
          conversationMessages,
        )
      }

      const data = await parseJsonResponse(response)
      const content = flattenOpenAiMessageContent(
        data.choices?.[0]?.message?.content,
      ).trim()
      pushUsage(
        hooks,
        normalizeOpenAiUsage(data.usage) ||
          buildEstimatedUsage(estimatedInputTokens, content, settings),
      )
      return content
    },
    {
      messages: conversationMessages,
      maxRetries,
      stage: 'finalization',
      hooks,
    },
  )

  return {
    message: attemptResult.value || '模型没有返回文本内容。',
    toolEvents,
    reasoning:
      providerReasoningBlocks.length > 0 ? providerReasoningBlocks : undefined,
    usage: latestUsage,
    messages: conversationMessages,
    retryInfo: mergeProviderRetryInfo(
      buildProviderRetryInfo(providerRetryCount, maxRetries, {
        stage: 'response',
      }),
      buildProviderRetryInfo(attemptResult.retryCount, maxRetries, {
        stage: 'finalization',
      }),
    ),
  }
}

async function finalizeGoogleTranscriptAfterStepLimit({
  settings,
  apiBase,
  systemPrompt,
  transcript,
  conversationMessages,
  toolEvents,
  providerReasoningBlocks,
  draftMessage,
  latestUsage,
  providerRetryCount,
  maxRetries,
  hooks,
}) {
  hooks?.onPhaseChange?.('finalizing')
  const prompt = buildFinalizerPrompt({
    toolEvents,
    reasoningText: joinReasoningBlocks(providerReasoningBlocks),
    draftMessage,
    completionState: 'needs_final_answer_after_tool_results',
    responseStyle: hooks?.routeState?.responseStyle,
    includeToolDigest: false,
    includeReasoningText: false,
  })
  const attemptResult = await runProviderOperationWithRetry(
    async () => {
      const requestContents = [
        ...transcript,
        {
          role: 'user',
          parts: [{ text: prompt }],
        },
      ]
      const estimatedInputTokens = estimateGoogleRequestInputTokens(
        systemPrompt,
        requestContents,
        [],
        settings,
      )
      const response = await fetchWithTimeout(
        `${apiBase}/models/${settings.model}:generateContent`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-goog-api-key': settings.apiKey,
          },
          body: JSON.stringify({
            system_instruction: {
              parts: [{ text: systemPrompt }],
            },
            contents: requestContents,
          }),
        },
        {
          timeoutMs: PROVIDER_FINALIZATION_TIMEOUT_MS,
          timeoutMessage:
            'Timed out while waiting for the final answer completion request.',
          messages: conversationMessages,
          settings,
        },
      )

      if (!response.ok) {
        const data = await parseJsonResponse(response)
        throw buildProviderHttpError(
          response,
          data.error?.message || 'Google finalization request failed',
          conversationMessages,
        )
      }

      const data = await parseJsonResponse(response)
      const parts = data.candidates?.[0]?.content?.parts || []
      const content = parts
        .map((part) => (typeof part.text === 'string' ? part.text : ''))
        .join('\n')
        .trim()
      pushUsage(
        hooks,
        normalizeGoogleUsage(data.usageMetadata) ||
          buildEstimatedUsage(estimatedInputTokens, content, settings),
      )
      return content
    },
    {
      messages: conversationMessages,
      maxRetries,
      stage: 'finalization',
      hooks,
    },
  )

  return {
    message: attemptResult.value || '模型没有返回文本内容。',
    toolEvents,
    reasoning:
      providerReasoningBlocks.length > 0 ? providerReasoningBlocks : undefined,
    usage: latestUsage,
    messages: conversationMessages,
    retryInfo: mergeProviderRetryInfo(
      buildProviderRetryInfo(providerRetryCount, maxRetries, {
        stage: 'response',
      }),
      buildProviderRetryInfo(attemptResult.retryCount, maxRetries, {
        stage: 'finalization',
      }),
    ),
  }
}

function createLongTaskGuard(loopConfig) {
  let lastFingerprint = ''
  let repeatedCount = 0

  return {
    record(toolFingerprint) {
      if (loopConfig.mode !== 'long-task' || !toolFingerprint) {
        return
      }
      if (toolFingerprint === lastFingerprint) {
        repeatedCount += 1
      } else {
        repeatedCount = 0
        lastFingerprint = toolFingerprint
      }

      if (repeatedCount >= 2) {
        throw new Error(
          'Agent 长任务模式已被保护性停止：连续多轮重复调用相同工具但没有形成最终回答。请尝试缩小任务范围，或改用更高轮数的普通模式。',
        )
      }
    },
  }
}

function shouldFinalizeAnswer(message, toolEvents, reasoningText) {
  const normalized = (message || '').trim()
  const hasContext = toolEvents.length > 0 || reasoningText.trim().length > 200
  if (!hasContext) {
    return false
  }
  if (!normalized || normalized === '模型没有返回文本内容。') {
    return true
  }
  if (normalized.length >= 120) {
    return false
  }
  return !/[。！？!?\n]/u.test(normalized.slice(60))
}

export async function finalizeOpenAiCompatibleAnswer({
  settings,
  systemPrompt,
  messages,
  toolEvents,
  reasoningText,
  draftMessage,
  completionState,
  deliveryPolicy = completionState
    ? buildDeliveryPolicy(completionState)
    : undefined,
  responseStyle,
  stage = 'finalization',
  hooks,
}) {
  const maxRetries = getProviderFailureRecoveryMaxRetries()
  const attemptResult = await runProviderOperationWithRetry(
    async () => {
      const apiBase = normalizeBaseUrl(
        settings.baseUrl,
        'https://api.openai.com/v1',
      )
      const transcript = toOpenAiTranscript(systemPrompt, [
        ...messages,
        ...(draftMessage?.trim()
          ? [
              {
                role: 'assistant',
                content: draftMessage,
              },
            ]
          : []),
        {
          role: 'user',
          content: buildFinalizerPrompt({
            toolEvents,
            reasoningText,
            draftMessage,
            completionState,
            deliveryPolicy,
            responseStyle,
          }),
        },
      ])
      const estimatedInputTokens = estimateOpenAiRequestInputTokens(
        transcript,
        [],
        settings,
      )

      const response = await fetchWithTimeout(
        `${apiBase}/chat/completions`,
        {
          method: 'POST',
          headers: openAiCompatibleHeaders(settings),
          body: JSON.stringify({
            model: settings.model,
            messages: transcript,
            stream: false,
          }),
        },
        {
          timeoutMs: PROVIDER_FINALIZATION_TIMEOUT_MS,
          timeoutMessage:
            'Timed out while waiting for the final answer completion request.',
          messages,
          settings,
        },
      )

      if (!response.ok) {
        const data = await parseJsonResponse(response)
        throw buildProviderHttpError(
          response,
          data.error?.message ||
            'OpenAI-compatible finalization request failed',
          messages,
        )
      }

      const data = await parseJsonResponse(response)
      const content = flattenOpenAiMessageContent(
        data.choices?.[0]?.message?.content,
      )
      const trimmedContent = content.trim()
      pushUsage(
        hooks,
        normalizeOpenAiUsage(data.usage) ||
          buildEstimatedUsage(estimatedInputTokens, trimmedContent, settings),
      )
      return trimmedContent
    },
    {
      messages,
      maxRetries,
      stage,
      hooks,
    },
  )
  return {
    message: attemptResult.value,
    retryInfo: buildProviderRetryInfo(attemptResult.retryCount, maxRetries, {
      stage,
    }),
  }
}

export async function finalizeGoogleAnswer({
  settings,
  systemPrompt,
  messages,
  toolEvents,
  reasoningText,
  draftMessage,
  completionState,
  deliveryPolicy = completionState
    ? buildDeliveryPolicy(completionState)
    : undefined,
  responseStyle,
  stage = 'finalization',
  hooks,
}) {
  const maxRetries = getProviderFailureRecoveryMaxRetries()
  const attemptResult = await runProviderOperationWithRetry(
    async () => {
      const apiBase = normalizeBaseUrl(
        settings.baseUrl,
        'https://generativelanguage.googleapis.com/v1beta',
      )
      const requestContents = toGeminiContents([
        ...messages,
        ...(draftMessage?.trim()
          ? [
              {
                role: 'assistant',
                content: draftMessage,
              },
            ]
          : []),
        {
          role: 'user',
          content: buildFinalizerPrompt({
            toolEvents,
            reasoningText,
            draftMessage,
            completionState,
            deliveryPolicy,
            responseStyle,
          }),
        },
      ])
      const estimatedInputTokens = estimateGoogleRequestInputTokens(
        systemPrompt,
        requestContents,
        [],
        settings,
      )
      const response = await fetchWithTimeout(
        `${apiBase}/models/${settings.model}:generateContent`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-goog-api-key': settings.apiKey,
          },
          body: JSON.stringify({
            system_instruction: {
              parts: [{ text: systemPrompt }],
            },
            contents: requestContents,
          }),
        },
        {
          timeoutMs: PROVIDER_FINALIZATION_TIMEOUT_MS,
          timeoutMessage:
            'Timed out while waiting for the final answer completion request.',
          messages,
          settings,
        },
      )

      if (!response.ok) {
        const data = await parseJsonResponse(response)
        throw buildProviderHttpError(
          response,
          data.error?.message || 'Google finalization request failed',
          messages,
        )
      }

      const data = await parseJsonResponse(response)
      const parts = data.candidates?.[0]?.content?.parts || []
      const content = parts
        .map((part) => (typeof part.text === 'string' ? part.text : ''))
        .join('\n')
        .trim()
      pushUsage(
        hooks,
        normalizeGoogleUsage(data.usageMetadata) ||
          buildEstimatedUsage(estimatedInputTokens, content, settings),
      )
      return content
    },
    {
      messages,
      maxRetries,
      stage,
      hooks,
    },
  )
  return {
    message: attemptResult.value,
    retryInfo: buildProviderRetryInfo(attemptResult.retryCount, maxRetries, {
      stage,
    }),
  }
}

export async function runOpenAiCompatibleAgent({
  settings,
  systemPrompt,
  messages,
  tools,
  toolEvents,
  hooks,
}) {
  const apiBase = normalizeBaseUrl(
    settings.baseUrl,
    'https://api.openai.com/v1',
  )
  const activeTools = [...tools]
  const registry = new Map(activeTools.map((tool) => [tool.name, tool]))
  const conversationMessages = [...messages]
  let transcript = toOpenAiTranscript(systemPrompt, conversationMessages)
  let latestUsage
  let providerRetryCount = 0
  let providerReasoning = ''
  const providerReasoningBlocks = []
  let lastDraftMessage = ''
  const loopConfig = getLoopConfig(settings)
  const loopGuard = createLongTaskGuard(loopConfig)
  const maxRetries = getProviderFailureRecoveryMaxRetries()

  try {
    let step = 0
    let repairTurns = 0
    let writeRepairAttempts = 0
    let hasUnresolvedToolError = false
    while (
      step < loopConfig.maxIterations ||
      (hasUnresolvedToolError &&
        repairTurns < STEP_LIMIT_TOOL_ERROR_REPAIR_TURNS &&
        writeRepairAttempts < STEP_LIMIT_TOOL_ERROR_WRITE_REPAIR_ATTEMPTS)
    ) {
      const isRepairIteration = step >= loopConfig.maxIterations
      if (isRepairIteration) {
        repairTurns += 1
      }
      appendQueuedInputsToOpenAiTranscript(
        transcript,
        conversationMessages,
        hooks,
      )
      const activeSystemPrompt = appendRuntimeToolEvidenceToSystemPrompt(
        systemPrompt,
        hooks?.workMemoryContext,
      )
      if (transcript[0]?.role === 'system') {
        transcript[0] = {
          ...transcript[0],
          content: activeSystemPrompt,
        }
      }
      transcript = await compactOpenAiRuntimeTranscript({
        settings,
        transcript,
        systemPrompt: activeSystemPrompt,
        hooks,
        tools: activeTools,
      })
      const reasoningBlockId = `provider-phase-${step + 1}`
      const reasoningOrder = step * 2
      const toolOrder = reasoningOrder + 1

      const attemptResult = await runProviderOperationWithRetry(
        async (attemptState) => {
          hooks?.onPhaseChange?.('model_connecting')
          const estimatedInputTokens = estimateOpenAiRequestInputTokens(
            transcript,
            activeTools,
            settings,
          )
          const response = await fetchWithTimeout(
            `${apiBase}/chat/completions`,
            {
              method: 'POST',
              headers: openAiCompatibleHeaders(settings),
              body: JSON.stringify({
                model: settings.model,
                messages: transcript,
                tools: openAiToolDefs(activeTools),
                tool_choice: 'auto',
                stream: true,
                ...(settings.provider === 'openai'
                  ? {
                      stream_options: {
                        include_usage: true,
                      },
                    }
                  : {}),
              }),
            },
            {
              timeoutMs: PROVIDER_CONNECT_TIMEOUT_MS,
              timeoutMessage:
                'Timed out while waiting for the streaming response to start.',
              messages: conversationMessages,
              settings,
            },
          )

          if (!response.ok) {
            const data = await parseJsonResponse(response)
            throw buildProviderHttpError(
              response,
              data.error?.message || 'OpenAI-compatible request failed',
              messages,
            )
          }
          hooks?.onPhaseChange?.('model_streaming')

          let content = ''
          let phaseReasoning = ''
          const toolCalls = []
          let usageForAttempt
          const applyPatchStreamingReporter = createApplyPatchStreamingReporter(
            {
              hooks,
              order: toolOrder,
            },
          )
          const streamParser = createThinkStreamParser({
            onContent(text) {
              content += text
              attemptState.receivedOutput = true
              attemptState.partialMessage += text
              hooks?.onTextDelta?.(text, {
                blockId: reasoningBlockId,
                order: reasoningOrder,
              })
            },
            onReasoning(text) {
              providerReasoning += text
              phaseReasoning += text
              attemptState.receivedOutput = true
              attemptState.partialReasoning += text
              hooks?.onReasoningDelta?.(text, {
                blockId: reasoningBlockId,
                kind: 'provider',
                order: reasoningOrder,
              })
            },
          })

          await readSseStream(
            response,
            async (payload) => {
              const data = JSON.parse(payload)
              const usage = attachEstimatedInputTokens(
                normalizeOpenAiUsage(data.usage),
                estimatedInputTokens,
              )
              if (usage) {
                usageForAttempt = usage
              }

              const choice = data.choices?.[0]
              if (!choice) {
                return
              }

              const reasoningDelta =
                choice.delta?.reasoning ||
                choice.delta?.reasoning_content ||
                choice.delta?.thinking
              if (typeof reasoningDelta === 'string' && reasoningDelta) {
                streamParser.consume(`<think>${reasoningDelta}</think>`)
              }

              if (
                typeof choice.delta?.content === 'string' &&
                choice.delta.content
              ) {
                streamParser.consume(choice.delta.content)
              }

              if (
                Array.isArray(choice.delta?.tool_calls) &&
                choice.delta.tool_calls.length > 0
              ) {
                attemptState.receivedOutput = true
                mergeOpenAiToolCalls(toolCalls, choice.delta.tool_calls)
                applyPatchStreamingReporter.inspect(toolCalls)
              }
            },
            {
              messages: conversationMessages,
              firstChunkTimeoutMs: PROVIDER_CONNECT_TIMEOUT_MS,
              idleTimeoutMs: PROVIDER_STREAM_IDLE_TIMEOUT_MS,
              onChunk() {
                attemptState.receivedOutput = true
                hooks?.onProgress?.()
              },
            },
          )

          streamParser.flush()
          const inlineReasoningToolCalls = extractInlineToolCalls(
            phaseReasoning,
            toolCalls.length,
          )
          phaseReasoning = inlineReasoningToolCalls.text
          mergeOpenAiToolCalls(
            toolCalls,
            dedupeInlineToolCalls(
              toolCalls,
              inlineReasoningToolCalls.toolCalls,
            ),
          )
          applyPatchStreamingReporter.inspect(toolCalls)

          const inlineContentToolCalls = extractInlineToolCalls(
            content,
            toolCalls.length,
          )
          content = inlineContentToolCalls.text
          mergeOpenAiToolCalls(
            toolCalls,
            dedupeInlineToolCalls(toolCalls, inlineContentToolCalls.toolCalls),
          )
          applyPatchStreamingReporter.inspect(toolCalls)

          return {
            content,
            phaseReasoning,
            finalizedToolCalls: toolCalls.filter((toolCall) =>
              toolCall?.function?.name?.trim(),
            ),
            usage:
              usageForAttempt ||
              buildEstimatedUsage(estimatedInputTokens, content, settings),
          }
        },
        {
          messages: conversationMessages,
          maxRetries,
          stage: 'response',
          hooks,
        },
      )
      const stepResult = attemptResult.value
      providerRetryCount += attemptResult.retryCount

      if (stepResult.usage) {
        latestUsage = stepResult.usage
        pushUsage(hooks, stepResult.usage)
      }

      if (stepResult.phaseReasoning.trim()) {
        providerReasoningBlocks.push({
          id: reasoningBlockId,
          kind: 'provider',
          content: stepResult.phaseReasoning,
          order: reasoningOrder,
        })
      }

      const { content, finalizedToolCalls } = stepResult
      if (finalizedToolCalls.length === 0) {
        const queuedInputs = drainAppendedInputs(hooks)
        if (queuedInputs.length > 0) {
          const assistantContent = maybeSpillAssistantContent({
            content,
            settings,
            hooks,
            toolEvents,
            providerKind: 'openai',
            reason: 'queued_user_input',
            order: reasoningOrder,
            stage: `step-${step + 1}`,
          }).content
          if (assistantContent.trim()) {
            lastDraftMessage = assistantContent
          }
          if (assistantContent.trim()) {
            transcript.push({
              role: 'assistant',
              content: assistantContent,
            })
            conversationMessages.push({
              role: 'assistant',
              content: assistantContent,
            })
          }
          for (const input of queuedInputs) {
            conversationMessages.push(input)
            transcript.push({
              role: 'user',
              content: toOpenAiContent(input),
            })
          }
          step += 1
          continue
        }
        return {
          message: content || '模型没有返回文本内容。',
          toolEvents,
          reasoning:
            providerReasoningBlocks.length > 0
              ? providerReasoningBlocks
              : undefined,
          usage: latestUsage,
          messages: conversationMessages,
          retryInfo: buildProviderRetryInfo(providerRetryCount, maxRetries, {
            stage: 'response',
          }),
        }
      }

      loopGuard.record(
        JSON.stringify(
          finalizedToolCalls.map((toolCall) => ({
            name: toolCall.function.name,
            args: toolCall.function.arguments || '{}',
          })),
        ),
      )

      const assistantContent = maybeSpillAssistantContent({
        content,
        settings,
        hooks,
        toolEvents,
        providerKind: 'openai',
        reason: 'tool_calls',
        order: reasoningOrder,
        stage: `step-${step + 1}`,
      }).content
      if (assistantContent.trim()) {
        lastDraftMessage = assistantContent
      }

      transcript.push({
        role: 'assistant',
        content: truncateAssistantContentForTranscript(
          assistantContent,
          settings,
        ),
        tool_calls: finalizedToolCalls,
      })
      conversationMessages.push({
        role: 'assistant',
        content: assistantContent,
      })

      hooks?.onPhaseChange?.('tool_running')
      const toolEventStartIndex = toolEvents.length
      for (const toolCall of finalizedToolCalls) {
        const tool = registry.get(toolCall.function.name)
        const args = parseToolArguments(
          toolCall.function.arguments || '{}',
          toolCall.function.name,
        )
        const result = tool
          ? await invokeTool(tool, args, toolEvents, {
              ...hooks,
              timelineOrder: toolOrder,
              registerDynamicTools(nextTools) {
                for (const nextTool of Array.isArray(nextTools)
                  ? nextTools
                  : []) {
                  if (!nextTool?.name || registry.has(nextTool.name)) {
                    continue
                  }
                  registry.set(nextTool.name, nextTool)
                  activeTools.push(nextTool)
                }
              },
            })
          : `Tool not found: ${toolCall.function.name}`

        transcript.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: truncateToolOutputForTranscript(result, settings),
        })
      }
      hasUnresolvedToolError = updateUnresolvedToolErrorForRepair(
        toolEvents,
        toolEventStartIndex,
        hasUnresolvedToolError,
      )
      if (
        isRepairIteration &&
        hasWriteRepairAttemptSince(toolEvents, toolEventStartIndex)
      ) {
        writeRepairAttempts += 1
      }
      step += 1
    }

    return await finalizeOpenAiTranscriptAfterStepLimit({
      settings,
      apiBase,
      transcript,
      conversationMessages,
      toolEvents,
      providerReasoningBlocks,
      draftMessage: lastDraftMessage,
      latestUsage,
      providerRetryCount,
      maxRetries,
      hooks,
    })
  } catch (error) {
    const normalized = maybeNormalizeProviderTermination(
      error,
      conversationMessages,
    )
    const aggregateRetryInfo = mergeProviderRetryInfo(
      buildProviderRetryInfo(providerRetryCount, maxRetries, {
        stage: 'response',
      }),
      extractProviderRetryInfo(error),
    )
    throw attachProviderRetryInfo(normalized, aggregateRetryInfo)
  }
}

function collectGeminiFunctionCalls(existingCalls, parts) {
  for (const part of parts || []) {
    if (!part.functionCall?.name) {
      continue
    }

    const args = part.functionCall.args || {}
    const signature = `${part.functionCall.name}:${JSON.stringify(args)}`
    if (existingCalls.some((entry) => entry.signature === signature)) {
      continue
    }

    existingCalls.push({
      signature,
      name: part.functionCall.name,
      args,
    })
  }
}

export async function runGoogleAgent({
  settings,
  systemPrompt,
  messages,
  tools,
  toolEvents,
  hooks,
}) {
  const apiBase = normalizeBaseUrl(
    settings.baseUrl,
    'https://generativelanguage.googleapis.com/v1beta',
  )
  const activeTools = [...tools]
  const registry = new Map(activeTools.map((tool) => [tool.name, tool]))
  const conversationMessages = [...messages]
  let transcript = toGeminiContents(conversationMessages)
  let latestUsage
  let providerRetryCount = 0
  let providerReasoning = ''
  const providerReasoningBlocks = []
  let lastDraftMessage = ''
  const loopConfig = getLoopConfig(settings)
  const loopGuard = createLongTaskGuard(loopConfig)
  const maxRetries = getProviderFailureRecoveryMaxRetries()

  try {
    let step = 0
    let repairTurns = 0
    let writeRepairAttempts = 0
    let hasUnresolvedToolError = false
    while (
      step < loopConfig.maxIterations ||
      (hasUnresolvedToolError &&
        repairTurns < STEP_LIMIT_TOOL_ERROR_REPAIR_TURNS &&
        writeRepairAttempts < STEP_LIMIT_TOOL_ERROR_WRITE_REPAIR_ATTEMPTS)
    ) {
      const isRepairIteration = step >= loopConfig.maxIterations
      if (isRepairIteration) {
        repairTurns += 1
      }
      appendQueuedInputsToGeminiTranscript(
        transcript,
        conversationMessages,
        hooks,
      )
      const activeSystemPrompt = appendRuntimeToolEvidenceToSystemPrompt(
        systemPrompt,
        hooks?.workMemoryContext,
      )
      transcript = await compactGeminiRuntimeTranscript({
        settings,
        transcript,
        systemPrompt: activeSystemPrompt,
        hooks,
        tools: activeTools,
      })
      const reasoningBlockId = `provider-phase-${step + 1}`
      const reasoningOrder = step * 2
      const toolOrder = reasoningOrder + 1

      const attemptResult = await runProviderOperationWithRetry(
        async (attemptState) => {
          hooks?.onPhaseChange?.('model_connecting')
          const estimatedInputTokens = estimateGoogleRequestInputTokens(
            activeSystemPrompt,
            transcript,
            activeTools,
            settings,
          )
          const response = await fetchWithTimeout(
            `${apiBase}/models/${settings.model}:streamGenerateContent?alt=sse`,
            {
              method: 'POST',
              headers: {
                'content-type': 'application/json',
                'x-goog-api-key': settings.apiKey,
              },
              body: JSON.stringify({
                system_instruction: {
                  parts: [{ text: activeSystemPrompt }],
                },
                contents: transcript,
                tools: geminiToolDefs(activeTools),
              }),
            },
            {
              timeoutMs: PROVIDER_CONNECT_TIMEOUT_MS,
              timeoutMessage:
                'Timed out while waiting for the streaming response to start.',
              messages: conversationMessages,
              settings,
            },
          )

          if (!response.ok) {
            const data = await parseJsonResponse(response)
            throw buildProviderHttpError(
              response,
              data.error?.message || 'Google request failed',
              messages,
            )
          }
          hooks?.onPhaseChange?.('model_streaming')

          let content = ''
          let phaseReasoning = ''
          const functionCalls = []
          let usageForAttempt
          const streamParser = createThinkStreamParser({
            onContent(text) {
              content += text
              attemptState.receivedOutput = true
              attemptState.partialMessage += text
              hooks?.onTextDelta?.(text, {
                blockId: reasoningBlockId,
                order: reasoningOrder,
              })
            },
            onReasoning(text) {
              providerReasoning += text
              phaseReasoning += text
              attemptState.receivedOutput = true
              attemptState.partialReasoning += text
              hooks?.onReasoningDelta?.(text, {
                blockId: reasoningBlockId,
                kind: 'provider',
                order: reasoningOrder,
              })
            },
          })

          await readSseStream(
            response,
            async (payload) => {
              const data = JSON.parse(payload)
              const usage = attachEstimatedInputTokens(
                normalizeGoogleUsage(data.usageMetadata),
                estimatedInputTokens,
              )
              if (usage) {
                usageForAttempt = usage
              }

              const candidate = data.candidates?.[0]
              const parts = candidate?.content?.parts || []

              for (const part of parts) {
                if (
                  typeof part.text === 'string' &&
                  part.text &&
                  part.thought
                ) {
                  streamParser.consume(`<think>${part.text}</think>`)
                  continue
                }
                if (typeof part.text === 'string' && part.text) {
                  streamParser.consume(part.text)
                }
              }

              if (parts.length > 0) {
                attemptState.receivedOutput = true
              }
              collectGeminiFunctionCalls(functionCalls, parts)
            },
            {
              messages: conversationMessages,
              firstChunkTimeoutMs: PROVIDER_CONNECT_TIMEOUT_MS,
              idleTimeoutMs: PROVIDER_STREAM_IDLE_TIMEOUT_MS,
              onChunk() {
                attemptState.receivedOutput = true
                hooks?.onProgress?.()
              },
            },
          )

          streamParser.flush()
          return {
            content,
            phaseReasoning,
            functionCalls,
            usage:
              usageForAttempt ||
              buildEstimatedUsage(estimatedInputTokens, content, settings),
          }
        },
        {
          messages: conversationMessages,
          maxRetries,
          stage: 'response',
          hooks,
        },
      )
      const stepResult = attemptResult.value
      providerRetryCount += attemptResult.retryCount

      if (stepResult.usage) {
        latestUsage = stepResult.usage
        pushUsage(hooks, stepResult.usage)
      }

      if (stepResult.phaseReasoning.trim()) {
        providerReasoningBlocks.push({
          id: reasoningBlockId,
          kind: 'provider',
          content: stepResult.phaseReasoning,
          order: reasoningOrder,
        })
      }

      const { content, functionCalls } = stepResult
      if (functionCalls.length === 0) {
        const queuedInputs = drainAppendedInputs(hooks)
        if (queuedInputs.length > 0) {
          const assistantContent = maybeSpillAssistantContent({
            content,
            settings,
            hooks,
            toolEvents,
            providerKind: 'google',
            reason: 'queued_user_input',
            order: reasoningOrder,
            stage: `step-${step + 1}`,
          }).content
          if (assistantContent.trim()) {
            lastDraftMessage = assistantContent
          }
          if (assistantContent.trim()) {
            transcript.push({
              role: 'model',
              parts: [{ text: assistantContent }],
            })
            conversationMessages.push({
              role: 'assistant',
              content: assistantContent,
            })
          }
          for (const input of queuedInputs) {
            conversationMessages.push(input)
            transcript.push({
              role: 'user',
              parts: toGeminiParts(input),
            })
          }
          step += 1
          continue
        }
        return {
          message: content || '模型没有返回文本内容。',
          toolEvents,
          reasoning:
            providerReasoningBlocks.length > 0
              ? providerReasoningBlocks
              : undefined,
          usage: latestUsage,
          messages: conversationMessages,
          retryInfo: buildProviderRetryInfo(providerRetryCount, maxRetries, {
            stage: 'response',
          }),
        }
      }

      loopGuard.record(
        JSON.stringify(
          functionCalls.map((entry) => ({
            name: entry.name,
            args: entry.args || {},
          })),
        ),
      )

      const assistantContent = maybeSpillAssistantContent({
        content,
        settings,
        hooks,
        toolEvents,
        providerKind: 'google',
        reason: 'function_calls',
        order: reasoningOrder,
        stage: `step-${step + 1}`,
      }).content
      if (assistantContent.trim()) {
        lastDraftMessage = assistantContent
      }

      transcript.push({
        role: 'model',
        parts: [
          ...(assistantContent
            ? [
                {
                  text: truncateAssistantContentForTranscript(
                    assistantContent,
                    settings,
                  ),
                },
              ]
            : []),
          ...functionCalls.map((entry) => ({
            functionCall: {
              name: entry.name,
              args: entry.args,
            },
          })),
        ],
      })
      conversationMessages.push({
        role: 'assistant',
        content: assistantContent,
      })

      hooks?.onPhaseChange?.('tool_running')
      const toolResponses = []
      const toolEventStartIndex = toolEvents.length
      for (const entry of functionCalls) {
        const tool = registry.get(entry.name)
        const result = tool
          ? await invokeTool(tool, entry.args || {}, toolEvents, {
              ...hooks,
              timelineOrder: toolOrder,
              registerDynamicTools(nextTools) {
                for (const nextTool of Array.isArray(nextTools)
                  ? nextTools
                  : []) {
                  if (!nextTool?.name || registry.has(nextTool.name)) {
                    continue
                  }
                  registry.set(nextTool.name, nextTool)
                  activeTools.push(nextTool)
                }
              },
            })
          : `Tool not found: ${entry.name}`

        toolResponses.push({
          functionResponse: {
            name: entry.name,
            response: {
              output: truncateToolOutputForTranscript(result, settings),
            },
          },
        })
      }

      transcript.push({
        role: 'user',
        parts: toolResponses,
      })
      hasUnresolvedToolError = updateUnresolvedToolErrorForRepair(
        toolEvents,
        toolEventStartIndex,
        hasUnresolvedToolError,
      )
      if (
        isRepairIteration &&
        hasWriteRepairAttemptSince(toolEvents, toolEventStartIndex)
      ) {
        writeRepairAttempts += 1
      }
      step += 1
    }

    return await finalizeGoogleTranscriptAfterStepLimit({
      settings,
      apiBase,
      systemPrompt: appendRuntimeToolEvidenceToSystemPrompt(
        systemPrompt,
        hooks?.workMemoryContext,
      ),
      transcript,
      conversationMessages,
      toolEvents,
      providerReasoningBlocks,
      draftMessage: lastDraftMessage,
      latestUsage,
      providerRetryCount,
      maxRetries,
      hooks,
    })
  } catch (error) {
    const normalized = maybeNormalizeProviderTermination(
      error,
      conversationMessages,
    )
    const aggregateRetryInfo = mergeProviderRetryInfo(
      buildProviderRetryInfo(providerRetryCount, maxRetries, {
        stage: 'response',
      }),
      extractProviderRetryInfo(error),
    )
    throw attachProviderRetryInfo(normalized, aggregateRetryInfo)
  }
}
