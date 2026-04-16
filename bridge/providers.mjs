import { invokeTool } from './tools.mjs'
import { createStructuredError } from './runtimeErrors.mjs'
import { buildDeliveryPolicy } from './agentEvidence.mjs'
import { normalizeBaseUrl } from './utils.mjs'

function flattenOpenAiMessageContent(content) {
  if (typeof content === 'string') {
    return content
  }
  if (!Array.isArray(content)) {
    return ''
  }
  return content
    .map(block => {
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

function openAiToolDefs(tools) {
  return tools.map(tool => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    },
  }))
}

function geminiToolDefs(tools) {
  return tools.map(tool => ({
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
  return message.content
    ? [{ type: 'text', text: message.content }]
    : []
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
  const blocks = parts.flatMap(part => {
    if (part.type === 'text') {
      return part.text.trim()
        ? [{ type: 'text', text: part.text }]
        : []
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
    ...messages.map(message => {
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
  const mapped = parts.flatMap(part => {
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
  return messages.map(message => ({
    role: message.role === 'assistant' ? 'model' : 'user',
    parts: toGeminiParts(message),
  }))
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
}) {
  const toolDigest = toolEvents
    .slice(-8)
    .map(event => {
      const pieces = [
        `- ${event.name} [${event.status}]`,
        event.output ? `输出摘要: ${String(event.output).slice(0, 600)}` : null,
        event.error ? `错误: ${String(event.error).slice(0, 300)}` : null,
      ].filter(Boolean)
      return pieces.join('\n')
    })
    .join('\n')

  return [
    '请基于当前对话和以下执行结果，直接输出给用户的最终回答。',
    '不要继续思考，不要调用工具，不要输出 <think> 标签。',
    '如果前面已经写了一句开场白，请直接补成完整、可交付的最终回答。',
    completionState ? `System completion state: ${completionState}` : null,
    deliveryPolicy?.allowedWording
      ? `Allowed wording: ${deliveryPolicy.allowedWording}`
      : null,
    draftMessage?.trim() ? `当前已有但不完整的回答：\n${draftMessage}` : null,
    toolDigest ? `本轮工具结果摘要：\n${toolDigest}` : null,
    reasoningText?.trim() ? `本轮原始思考流（仅供你整理最终回答，不要照抄）：\n${reasoningText.slice(0, 6000)}` : null,
  ]
    .filter(Boolean)
    .join('\n\n')
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

async function fetchWithTimeout(url, init, { timeoutMs, timeoutMessage, messages }) {
  const controller = new AbortController()
  const timer = setTimeout(() => {
    controller.abort(new Error(timeoutMessage))
  }, timeoutMs)

  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
    })
  } catch (error) {
    if (controller.signal.aborted) {
      throw createClassifiedError('模型服务响应超时。', {
        source: 'provider',
        category: 'timeout',
        code: 'PROVIDER_REQUEST_TIMEOUT',
        rawMessage: presentProviderError(timeoutMessage, messages),
        suggestedAction: '当前模型响应较慢。你可以稍后重试，或切换到更稳定的 Provider / 模型。',
        retryable: true,
      })
    }
    throw error
  } finally {
    clearTimeout(timer)
  }
}

async function readChunkWithTimeout(reader, timeoutMs, timeoutMessage, messages) {
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
      isFirstChunk ? 'Timed out while waiting for the first streaming chunk.' : 'Streaming response stalled while waiting for the next chunk.',
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
        .filter(line => line.startsWith('data:'))
        .map(line => line.slice(5).trimStart())

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
    .filter(line => line.startsWith('data:'))
    .map(line => line.slice(5).trimStart())

  for (const payload of dataLines) {
    if (payload && payload !== '[DONE]') {
      await onData(payload)
    }
  }
}

function parseToolArguments(rawArgs) {
  if (!rawArgs?.trim()) {
    return {}
  }

  try {
    return JSON.parse(rawArgs)
  } catch (error) {
    throw new Error(
      `Tool arguments are not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    )
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
      current.function.arguments += deltaCall.function.arguments
    }

    existingCalls[index] = current
  }
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

        const safeLength = Math.max(0, state.buffer.length - (closeTag.length - 1))
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
  return messages.some(message =>
    normalizeMessageParts(message).some(part => part.type === 'image'),
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
  return new Promise(resolve => setTimeout(resolve, ms))
}

const PROVIDER_CONNECT_TIMEOUT_MS = 45_000
const PROVIDER_STREAM_IDLE_TIMEOUT_MS = 90_000
const PROVIDER_FINALIZATION_TIMEOUT_MS = 60_000

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

function getProviderFailureRecoveryMaxRetries(settings) {
  if (settings?.enableProviderFailureRecovery === false) {
    return 0
  }

  const configured = Number(settings?.providerFailureRecoveryMaxAttempts)
  if (!Number.isFinite(configured)) {
    return 3
  }

  return Math.max(0, Math.min(5, Math.round(configured)))
}

function buildProviderRetryInfo(retryCount, maxRetries, extras = {}) {
  if (retryCount <= 0) {
    return undefined
  }

  const stage = extras.stage || 'response'
  return {
    attemptedRetries: retryCount,
    configuredMaxRetries: maxRetries,
    configuredMaxAttempts: maxRetries + 1,
    stage,
    stageLabel: extras.stageLabel || providerRetryStageLabel(stage),
    recovered: extras.recovered === true,
  }
}

function mergeProviderRetryInfo(...entries) {
  const validEntries = entries.filter(
    entry =>
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
      attemptedRetries: Math.max(selected.attemptedRetries, entry.attemptedRetries),
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
  if (!value || typeof value !== 'object' || !value.retryInfo || typeof value.retryInfo !== 'object') {
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
    stageLabel: typeof retryInfo.stageLabel === 'string' ? retryInfo.stageLabel : undefined,
    recovered: retryInfo.recovered === true,
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
  return scorePartialProviderState(nextState) >= scorePartialProviderState(currentState)
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

async function runProviderOperationWithRetry(operation, { messages, maxRetries = 3, baseDelayMs = 800 }) {
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
      return {
        value,
        retryCount,
        attemptsUsed: retryCount + 1,
      }
    } catch (error) {
      let normalized = maybeNormalizeProviderTermination(error, messages)
      bestPartialState = pickPreferredPartialProviderState(bestPartialState, attemptState)
      normalized = attachPartialProviderState(normalized, bestPartialState)
      normalized = attachProviderRetryInfo(
        normalized,
        buildProviderRetryInfo(retryCount, maxRetries),
      )
      lastError = normalized

      if (attempt >= maxAttempts || !isRetryableProviderError(normalized)) {
        throw normalized
      }

      retryCount += 1
      await wait(baseDelayMs * attempt)
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
        suggestedAction: '请稍后重试，或切换到对工具调用支持更稳定的模型 / Provider。',
        retryable: true,
      },
    )
  }
  return error
}

function getLoopConfig(settings) {
  const boundedLimit = Math.max(1, Math.min(128, Number(settings.maxSteps) || 8))
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
  deliveryPolicy = completionState ? buildDeliveryPolicy(completionState) : undefined,
  stage = 'finalization',
}) {
  const maxRetries = getProviderFailureRecoveryMaxRetries(settings)
  const attemptResult = await runProviderOperationWithRetry(async () => {
    const apiBase = normalizeBaseUrl(settings.baseUrl, 'https://api.openai.com/v1')
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
        }),
      },
    ])

    const response = await fetchWithTimeout(
      `${apiBase}/chat/completions`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${settings.apiKey}`,
        },
        body: JSON.stringify({
          model: settings.model,
          messages: transcript,
          stream: false,
        }),
      },
      {
        timeoutMs: PROVIDER_FINALIZATION_TIMEOUT_MS,
        timeoutMessage: 'Timed out while waiting for the final answer completion request.',
        messages,
      },
    )

    if (!response.ok) {
      const data = await parseJsonResponse(response)
      throw buildProviderHttpError(
        response,
        data.error?.message || 'OpenAI-compatible finalization request failed',
        messages,
      )
    }

    const data = await parseJsonResponse(response)
    const content = flattenOpenAiMessageContent(data.choices?.[0]?.message?.content)
    return content.trim()
  }, {
    messages,
    maxRetries,
  })
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
  deliveryPolicy = completionState ? buildDeliveryPolicy(completionState) : undefined,
  stage = 'finalization',
}) {
  const maxRetries = getProviderFailureRecoveryMaxRetries(settings)
  const attemptResult = await runProviderOperationWithRetry(async () => {
    const apiBase = normalizeBaseUrl(
      settings.baseUrl,
      'https://generativelanguage.googleapis.com/v1beta',
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
          contents: toGeminiContents([
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
              }),
            },
          ]),
        }),
      },
      {
        timeoutMs: PROVIDER_FINALIZATION_TIMEOUT_MS,
        timeoutMessage: 'Timed out while waiting for the final answer completion request.',
        messages,
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
    return parts
      .map(part => (typeof part.text === 'string' ? part.text : ''))
      .join('\n')
      .trim()
  }, {
    messages,
    maxRetries,
  })
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
  const apiBase = normalizeBaseUrl(settings.baseUrl, 'https://api.openai.com/v1')
  const registry = new Map(tools.map(tool => [tool.name, tool]))
  const conversationMessages = [...messages]
  const transcript = toOpenAiTranscript(systemPrompt, conversationMessages)
  let latestUsage
  let providerRetryCount = 0
  let providerReasoning = ''
  const providerReasoningBlocks = []
  const loopConfig = getLoopConfig(settings)
  const loopGuard = createLongTaskGuard(loopConfig)
  const maxRetries = getProviderFailureRecoveryMaxRetries(settings)

  try {
    for (let step = 0; step < loopConfig.maxIterations; step += 1) {
      appendQueuedInputsToOpenAiTranscript(transcript, conversationMessages, hooks)
      const reasoningBlockId = `provider-phase-${step + 1}`
      const reasoningOrder = step * 2
      const toolOrder = reasoningOrder + 1

      const attemptResult = await runProviderOperationWithRetry(async attemptState => {
        hooks?.onPhaseChange?.('model_connecting')
        const response = await fetchWithTimeout(
          `${apiBase}/chat/completions`,
          {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              authorization: `Bearer ${settings.apiKey}`,
            },
            body: JSON.stringify({
              model: settings.model,
              messages: transcript,
              tools: openAiToolDefs(tools),
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
            timeoutMessage: 'Timed out while waiting for the streaming response to start.',
            messages: conversationMessages,
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

        await readSseStream(response, async payload => {
          const data = JSON.parse(payload)
          const usage = data.usage
            ? {
                inputTokens: data.usage.prompt_tokens,
                outputTokens: data.usage.completion_tokens,
              }
            : undefined
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

          if (typeof choice.delta?.content === 'string' && choice.delta.content) {
            streamParser.consume(choice.delta.content)
          }

          if (Array.isArray(choice.delta?.tool_calls) && choice.delta.tool_calls.length > 0) {
            attemptState.receivedOutput = true
            mergeOpenAiToolCalls(toolCalls, choice.delta.tool_calls)
          }
        }, {
          messages: conversationMessages,
          firstChunkTimeoutMs: PROVIDER_CONNECT_TIMEOUT_MS,
          idleTimeoutMs: PROVIDER_STREAM_IDLE_TIMEOUT_MS,
          onChunk() {
            attemptState.receivedOutput = true
            hooks?.onProgress?.()
          },
        })

        streamParser.flush()
        return {
          content,
          phaseReasoning,
          finalizedToolCalls: toolCalls.filter(toolCall => toolCall?.function?.name?.trim()),
          usage: usageForAttempt,
        }
      }, {
        messages: conversationMessages,
        maxRetries,
      })
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
        if (content.trim()) {
          transcript.push({
            role: 'assistant',
            content,
          })
          conversationMessages.push({
            role: 'assistant',
            content,
          })
        }
        for (const input of queuedInputs) {
          conversationMessages.push(input)
          transcript.push({
            role: 'user',
            content: toOpenAiContent(input),
          })
        }
        continue
      }
      return {
        message: content || '模型没有返回文本内容。',
        toolEvents,
        reasoning: providerReasoningBlocks.length > 0 ? providerReasoningBlocks : undefined,
        usage: latestUsage,
        messages: conversationMessages,
        retryInfo: buildProviderRetryInfo(providerRetryCount, maxRetries, {
          stage: 'response',
        }),
      }
      }

      loopGuard.record(
        JSON.stringify(
          finalizedToolCalls.map(toolCall => ({
            name: toolCall.function.name,
            args: toolCall.function.arguments || '{}',
          })),
        ),
      )

      transcript.push({
        role: 'assistant',
        content,
        tool_calls: finalizedToolCalls,
      })
      conversationMessages.push({
        role: 'assistant',
        content,
      })

      hooks?.onPhaseChange?.('tool_running')
      for (const toolCall of finalizedToolCalls) {
        const tool = registry.get(toolCall.function.name)
        const args = parseToolArguments(toolCall.function.arguments || '{}')
        const result = tool
          ? await invokeTool(tool, args, toolEvents, {
              ...hooks,
              timelineOrder: toolOrder,
            })
          : `Tool not found: ${toolCall.function.name}`

        transcript.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: result,
        })
      }
    }

    throw new Error(loopConfig.limitMessage)
  } catch (error) {
    const normalized = maybeNormalizeProviderTermination(error, conversationMessages)
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
    if (existingCalls.some(entry => entry.signature === signature)) {
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
  const registry = new Map(tools.map(tool => [tool.name, tool]))
  const conversationMessages = [...messages]
  const transcript = toGeminiContents(conversationMessages)
  let latestUsage
  let providerRetryCount = 0
  let providerReasoning = ''
  const providerReasoningBlocks = []
  const loopConfig = getLoopConfig(settings)
  const loopGuard = createLongTaskGuard(loopConfig)
  const maxRetries = getProviderFailureRecoveryMaxRetries(settings)

  try {
    for (let step = 0; step < loopConfig.maxIterations; step += 1) {
      appendQueuedInputsToGeminiTranscript(transcript, conversationMessages, hooks)
      const reasoningBlockId = `provider-phase-${step + 1}`
      const reasoningOrder = step * 2
      const toolOrder = reasoningOrder + 1

      const attemptResult = await runProviderOperationWithRetry(async attemptState => {
        hooks?.onPhaseChange?.('model_connecting')
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
                parts: [{ text: systemPrompt }],
              },
              contents: transcript,
              tools: geminiToolDefs(tools),
            }),
          },
          {
            timeoutMs: PROVIDER_CONNECT_TIMEOUT_MS,
            timeoutMessage: 'Timed out while waiting for the streaming response to start.',
            messages: conversationMessages,
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

        await readSseStream(response, async payload => {
          const data = JSON.parse(payload)
          const usage = data.usageMetadata
            ? {
                inputTokens: data.usageMetadata.promptTokenCount,
                outputTokens: data.usageMetadata.candidatesTokenCount,
              }
            : undefined
          if (usage) {
            usageForAttempt = usage
          }

          const candidate = data.candidates?.[0]
          const parts = candidate?.content?.parts || []

          for (const part of parts) {
            if (typeof part.text === 'string' && part.text && part.thought) {
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
        }, {
          messages: conversationMessages,
          firstChunkTimeoutMs: PROVIDER_CONNECT_TIMEOUT_MS,
          idleTimeoutMs: PROVIDER_STREAM_IDLE_TIMEOUT_MS,
          onChunk() {
            attemptState.receivedOutput = true
            hooks?.onProgress?.()
          },
        })

        streamParser.flush()
        return {
          content,
          phaseReasoning,
          functionCalls,
          usage: usageForAttempt,
        }
      }, {
        messages: conversationMessages,
        maxRetries,
      })
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
        if (content.trim()) {
          transcript.push({
            role: 'model',
            parts: [{ text: content }],
          })
          conversationMessages.push({
            role: 'assistant',
            content,
          })
        }
        for (const input of queuedInputs) {
          conversationMessages.push(input)
          transcript.push({
            role: 'user',
            parts: toGeminiParts(input),
          })
        }
        continue
      }
      return {
        message: content || '模型没有返回文本内容。',
        toolEvents,
        reasoning: providerReasoningBlocks.length > 0 ? providerReasoningBlocks : undefined,
        usage: latestUsage,
        messages: conversationMessages,
        retryInfo: buildProviderRetryInfo(providerRetryCount, maxRetries, {
          stage: 'response',
        }),
      }
      }

      loopGuard.record(
        JSON.stringify(
          functionCalls.map(entry => ({
            name: entry.name,
            args: entry.args || {},
          })),
        ),
      )

      transcript.push({
        role: 'model',
        parts: [
          ...(content ? [{ text: content }] : []),
          ...functionCalls.map(entry => ({
            functionCall: {
              name: entry.name,
              args: entry.args,
            },
          })),
        ],
      })
      conversationMessages.push({
        role: 'assistant',
        content,
      })

      hooks?.onPhaseChange?.('tool_running')
      const toolResponses = []
      for (const entry of functionCalls) {
        const tool = registry.get(entry.name)
        const result = tool
          ? await invokeTool(tool, entry.args || {}, toolEvents, {
              ...hooks,
              timelineOrder: toolOrder,
            })
          : `Tool not found: ${entry.name}`

        toolResponses.push({
          functionResponse: {
            name: entry.name,
            response: {
              output: result,
            },
          },
        })
      }

      transcript.push({
        role: 'user',
        parts: toolResponses,
      })
    }

    throw new Error(loopConfig.limitMessage)
  } catch (error) {
    const normalized = maybeNormalizeProviderTermination(error, conversationMessages)
    const aggregateRetryInfo = mergeProviderRetryInfo(
      buildProviderRetryInfo(providerRetryCount, maxRetries, {
        stage: 'response',
      }),
      extractProviderRetryInfo(error),
    )
    throw attachProviderRetryInfo(normalized, aggregateRetryInfo)
  }
}
