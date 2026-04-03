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

function toGeminiContents(messages) {
  return messages.map(message => ({
    role: message.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: message.content }],
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
  const transcript = [
    {
      role: 'system',
      content: systemPrompt,
    },
    ...messages.map(message => ({
      role: message.role,
      content: message.content,
    })),
  ]

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
      }),
    })

    const data = await parseJsonResponse(response)
    if (!response.ok) {
      throw new Error(data.error?.message || 'OpenAI-compatible request failed')
    }

    const message = data.choices?.[0]?.message
    const toolCalls = message?.tool_calls || []
    if (!toolCalls.length) {
      return {
        message: message?.content || '模型没有返回文本内容。',
        toolEvents,
        usage: {
          inputTokens: data.usage?.prompt_tokens,
          outputTokens: data.usage?.completion_tokens,
        },
      }
    }

    transcript.push({
      role: 'assistant',
      content: message.content || '',
      tool_calls: toolCalls,
    })

    for (const toolCall of toolCalls) {
      const tool = registry.get(toolCall.function.name)
      const args = JSON.parse(toolCall.function.arguments || '{}')
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

  for (let step = 0; step < settings.maxSteps; step += 1) {
    const response = await fetch(
      `${apiBase}/models/${settings.model}:generateContent?key=${encodeURIComponent(settings.apiKey)}`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
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

    const data = await parseJsonResponse(response)
    if (!response.ok) {
      throw new Error(data.error?.message || 'Google request failed')
    }

    const candidate = data.candidates?.[0]
    const parts = candidate?.content?.parts || []
    const textParts = parts
      .filter(part => typeof part.text === 'string' && part.text.trim())
      .map(part => part.text)
    const functionCalls = parts.filter(part => part.functionCall)

    if (!functionCalls.length) {
      return {
        message: textParts.join('\n\n') || '模型没有返回文本内容。',
        toolEvents,
        usage: {
          inputTokens: data.usageMetadata?.promptTokenCount,
          outputTokens: data.usageMetadata?.candidatesTokenCount,
        },
      }
    }

    transcript.push({
      role: 'model',
      parts,
    })

    const toolResponses = []
    for (const entry of functionCalls) {
      const toolCall = entry.functionCall
      const tool = registry.get(toolCall.name)
      const result = tool
        ? await invokeTool(tool, toolCall.args || {}, toolEvents, hooks)
        : `Tool not found: ${toolCall.name}`

      toolResponses.push({
        functionResponse: {
          name: toolCall.name,
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
