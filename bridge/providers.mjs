import { invokeTool } from './tools.mjs'
import { normalizeBaseUrl } from './utils.mjs'

function anthropicToolDefs(tools) {
  return tools.map(tool => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema,
  }))
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

async function parseJsonResponse(response) {
  const text = await response.text()
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`Provider returned invalid JSON\n\n${text}`)
  }
}

export async function runAnthropicAgent({
  settings,
  systemPrompt,
  messages,
  tools,
  toolEvents,
  hooks,
}) {
  const apiBase = normalizeBaseUrl(settings.baseUrl, 'https://api.anthropic.com')
  const registry = new Map(tools.map(tool => [tool.name, tool]))
  const transcript = messages.map(message => ({
    role: message.role,
    content: message.content,
  }))

  for (let step = 0; step < settings.maxSteps; step += 1) {
    const response = await fetch(`${apiBase}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': settings.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: settings.model,
        max_tokens: 4096,
        system: systemPrompt,
        messages: transcript,
        tools: anthropicToolDefs(tools),
      }),
    })

    const data = await parseJsonResponse(response)
    if (!response.ok) {
      throw new Error(data.error?.message || 'Anthropic request failed')
    }

    const assistantBlocks = data.content || []
    const textParts = assistantBlocks
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .filter(Boolean)
    const toolUses = assistantBlocks.filter(block => block.type === 'tool_use')

    if (toolUses.length === 0) {
      return {
        message: textParts.join('\n\n') || '模型没有返回文本内容。',
        toolEvents,
        usage: {
          inputTokens: data.usage?.input_tokens,
          outputTokens: data.usage?.output_tokens,
        },
      }
    }

    transcript.push({
      role: 'assistant',
      content: assistantBlocks,
    })

    const toolResults = []
    for (const toolUse of toolUses) {
      const tool = registry.get(toolUse.name)
      if (!tool) {
        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: `Tool not found: ${toolUse.name}`,
          is_error: true,
        })
        continue
      }
      const result = await invokeTool(tool, toolUse.input || {}, toolEvents, hooks)
      toolResults.push({
        type: 'tool_result',
        tool_use_id: toolUse.id,
        content: result,
      })
    }

    transcript.push({
      role: 'user',
      content: toolResults,
    })
  }

  throw new Error('Agent reached the max step limit without a final answer.')
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
