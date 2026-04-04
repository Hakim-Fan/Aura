import { invokeTool } from './tools.mjs'
import { normalizeBaseUrl } from './utils.mjs'

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
      current.function.name += deltaCall.function.name
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

  for (let step = 0; step < settings.maxSteps; step += 1) {
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
    const toolCalls = []
    const streamParser = createThinkStreamParser({
      onContent(text) {
        content += text
        hooks?.onTextDelta?.(text)
      },
      onReasoning(text) {
        providerReasoning += text
        hooks?.onReasoningDelta?.(text, {
          blockId: 'provider',
          kind: 'provider',
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

    const finalizedToolCalls = toolCalls.filter(
      toolCall => toolCall?.function?.name?.trim(),
    )

    if (finalizedToolCalls.length === 0) {
      return {
        message: content || '模型没有返回文本内容。',
        toolEvents,
        reasoning: providerReasoning.trim()
          ? [
              {
                id: 'provider',
                kind: 'provider',
                content: providerReasoning,
              },
            ]
          : undefined,
        usage: latestUsage,
      }
    }

    transcript.push({
      role: 'assistant',
      content,
      tool_calls: finalizedToolCalls,
    })

    for (const toolCall of finalizedToolCalls) {
      const tool = registry.get(toolCall.function.name)
      const args = parseToolArguments(toolCall.function.arguments || '{}')
      const result = tool
        ? await invokeTool(tool, args, toolEvents, hooks)
        : `Tool not found: ${toolCall.function.name}`

      transcript.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        content: result,
      })
    }
  }

  throw new Error('Agent reached the max step limit without a final answer.')
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

  for (let step = 0; step < settings.maxSteps; step += 1) {
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
    const functionCalls = []
    const streamParser = createThinkStreamParser({
      onContent(text) {
        content += text
        hooks?.onTextDelta?.(text)
      },
      onReasoning(text) {
        providerReasoning += text
        hooks?.onReasoningDelta?.(text, {
          blockId: 'provider',
          kind: 'provider',
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

    if (functionCalls.length === 0) {
      return {
        message: content || '模型没有返回文本内容。',
        toolEvents,
        reasoning: providerReasoning.trim()
          ? [
              {
                id: 'provider',
                kind: 'provider',
                content: providerReasoning,
              },
            ]
          : undefined,
        usage: latestUsage,
      }
    }

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
        ? await invokeTool(tool, entry.args || {}, toolEvents, hooks)
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

  throw new Error('Agent reached the max step limit without a final answer.')
}
