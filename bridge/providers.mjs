import { invokeTool } from './tools.mjs'
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

function buildFinalizerPrompt({ toolEvents, reasoningText, draftMessage }) {
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
    throw new Error(`Provider returned invalid JSON\n\n${text}`)
  }
}

async function readSseStream(response, onData) {
  if (!response.body) {
    throw new Error('Provider returned an empty streaming response body.')
  }

  const decoder = new TextDecoder()
  let buffer = ''

  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true })

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

function createClassifiedError(message, extras = {}) {
  const error = new Error(message)
  Object.assign(error, extras)
  return error
}

function maybeNormalizeProviderTermination(error, messages) {
  const message = error instanceof Error ? error.message : String(error)
  const normalized = message.trim().toLowerCase()
  if (
    normalized === 'terminated' ||
    normalized.includes('terminated') ||
    normalized.includes('socket hang up') ||
    normalized.includes('eof') ||
    normalized.includes('aborted')
  ) {
    return createClassifiedError(
      '模型连接在生成过程中被中断。可能是 Provider 侧超时、连接断开，或当前模型/兼容接口对工具调用支持不稳定。',
      {
        code: 'provider_terminated',
        source: 'provider',
        rawMessage: presentProviderError(message, messages),
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
}) {
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
      }),
    },
  ])

  const response = await fetch(`${apiBase}/chat/completions`, {
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
  })

  if (!response.ok) {
    const data = await parseJsonResponse(response)
    throw new Error(data.error?.message || 'OpenAI-compatible finalization request failed')
  }

  const data = await parseJsonResponse(response)
  const content = flattenOpenAiMessageContent(data.choices?.[0]?.message?.content)
  return content.trim()
}

export async function finalizeGoogleAnswer({
  settings,
  systemPrompt,
  messages,
  toolEvents,
  reasoningText,
  draftMessage,
}) {
  const apiBase = normalizeBaseUrl(
    settings.baseUrl,
    'https://generativelanguage.googleapis.com/v1beta',
  )
  const response = await fetch(`${apiBase}/models/${settings.model}:generateContent`, {
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
          }),
        },
      ]),
    }),
  })

  if (!response.ok) {
    const data = await parseJsonResponse(response)
    throw new Error(data.error?.message || 'Google finalization request failed')
  }

  const data = await parseJsonResponse(response)
  const parts = data.candidates?.[0]?.content?.parts || []
  return parts
    .map(part => (typeof part.text === 'string' ? part.text : ''))
    .join('\n')
    .trim()
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
  const transcript = toOpenAiTranscript(systemPrompt, messages)
  let latestUsage
  let providerReasoning = ''
  const providerReasoningBlocks = []
  const loopConfig = getLoopConfig(settings)
  const loopGuard = createLongTaskGuard(loopConfig)

  try {
    for (let step = 0; step < loopConfig.maxIterations; step += 1) {
    const reasoningBlockId = `provider-phase-${step + 1}`
    const reasoningOrder = step * 2
    const toolOrder = reasoningOrder + 1
    const response = await fetch(`${apiBase}/chat/completions`, {
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
    })

    if (!response.ok) {
      const data = await parseJsonResponse(response)
      throw new Error(
        presentProviderError(
          data.error?.message || 'OpenAI-compatible request failed',
          messages,
        ),
      )
    }

    let content = ''
    let phaseReasoning = ''
    const toolCalls = []
    const streamParser = createThinkStreamParser({
      onContent(text) {
        content += text
        hooks?.onTextDelta?.(text)
      },
      onReasoning(text) {
        providerReasoning += text
        phaseReasoning += text
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
        latestUsage = usage
        pushUsage(hooks, usage)
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

      if (Array.isArray(choice.delta?.tool_calls)) {
        mergeOpenAiToolCalls(toolCalls, choice.delta.tool_calls)
      }
    })

    streamParser.flush()

    if (phaseReasoning.trim()) {
      providerReasoningBlocks.push({
        id: reasoningBlockId,
        kind: 'provider',
        content: phaseReasoning,
        order: reasoningOrder,
      })
    }

    const finalizedToolCalls = toolCalls.filter(
      toolCall => toolCall?.function?.name?.trim(),
    )

    if (finalizedToolCalls.length === 0) {
      return {
        message: content || '模型没有返回文本内容。',
        toolEvents,
        reasoning: providerReasoningBlocks.length > 0 ? providerReasoningBlocks : undefined,
        usage: latestUsage,
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
    throw maybeNormalizeProviderTermination(error, messages)
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
  const transcript = toGeminiContents(messages)
  let latestUsage
  let providerReasoning = ''
  const providerReasoningBlocks = []
  const loopConfig = getLoopConfig(settings)
  const loopGuard = createLongTaskGuard(loopConfig)

  try {
    for (let step = 0; step < loopConfig.maxIterations; step += 1) {
    const reasoningBlockId = `provider-phase-${step + 1}`
    const reasoningOrder = step * 2
    const toolOrder = reasoningOrder + 1
    const response = await fetch(
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
    )

    if (!response.ok) {
      const data = await parseJsonResponse(response)
      throw new Error(
        presentProviderError(data.error?.message || 'Google request failed', messages),
      )
    }

    let content = ''
    let phaseReasoning = ''
    const functionCalls = []
    const streamParser = createThinkStreamParser({
      onContent(text) {
        content += text
        hooks?.onTextDelta?.(text)
      },
      onReasoning(text) {
        providerReasoning += text
        phaseReasoning += text
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
        latestUsage = usage
        pushUsage(hooks, usage)
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

      collectGeminiFunctionCalls(functionCalls, parts)
    })

    streamParser.flush()

    if (phaseReasoning.trim()) {
      providerReasoningBlocks.push({
        id: reasoningBlockId,
        kind: 'provider',
        content: phaseReasoning,
        order: reasoningOrder,
      })
    }

    if (functionCalls.length === 0) {
      return {
        message: content || '模型没有返回文本内容。',
        toolEvents,
        reasoning: providerReasoningBlocks.length > 0 ? providerReasoningBlocks : undefined,
        usage: latestUsage,
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
    throw maybeNormalizeProviderTermination(error, messages)
  }
}
