import { normalizeBaseUrl } from './utils.mjs'
import { guardedFetch } from './web/net/guardedFetch.mjs'

const PROXY_CONNECTIVITY_TEST_URL = 'https://api.ipify.org?format=json'

async function parseJsonResponse(response) {
  const text = await response.text()
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`Provider returned invalid JSON\n\n${text}`)
  }
}

function pickFiniteNumber(...values) {
  for (const value of values) {
    const parsed = Number(value)
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.round(parsed)
    }
  }
  return undefined
}

function dedupeModels(entries) {
  const byId = new Map()

  for (const entry of entries) {
    if (!entry?.id) {
      continue
    }
    const existing = byId.get(entry.id)
    if (!existing) {
      byId.set(entry.id, entry)
      continue
    }

    byId.set(entry.id, {
      ...existing,
      contextWindowTokens: Math.max(
        existing.contextWindowTokens || 0,
        entry.contextWindowTokens || 0,
      ) || undefined,
      maxOutputTokens: Math.max(
        existing.maxOutputTokens || 0,
        entry.maxOutputTokens || 0,
      ) || undefined,
    })
  }

  return Array.from(byId.values()).sort((left, right) => left.id.localeCompare(right.id))
}

function toProviderModel(entry) {
  if (!entry || typeof entry !== 'object') {
    return null
  }

  const id = typeof entry.id === 'string' ? entry.id.trim() : ''
  if (!id) {
    return null
  }

  return {
    id,
    enabled: false,
    contextWindowTokens: pickFiniteNumber(
      entry.context_window,
      entry.contextWindow,
      entry.context_length,
      entry.contextLength,
      entry.max_context_length,
      entry.maxContextLength,
      entry.input_token_limit,
      entry.inputTokenLimit,
      entry.inputTokenLimit,
      entry.max_input_tokens,
      entry.maxInputTokens,
    ),
    maxOutputTokens: pickFiniteNumber(
      entry.max_output_tokens,
      entry.maxOutputTokens,
      entry.output_token_limit,
      entry.outputTokenLimit,
      entry.outputTokenLimit,
      entry.completion_token_limit,
      entry.completionTokenLimit,
    ),
  }
}

function openAiCompatibleHeaders(settings = {}) {
  const headers = {}
  const apiKey = typeof settings.apiKey === 'string' ? settings.apiKey.trim() : ''
  if (apiKey) {
    headers.authorization = `Bearer ${apiKey}`
  }
  return headers
}

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
      if (typeof block.text === 'string') {
        return block.text
      }
      return ''
    })
    .filter(Boolean)
    .join('\n')
}

function flattenGeminiTextResponse(data) {
  const parts = data?.candidates?.[0]?.content?.parts || []
  return parts
    .map(part => (typeof part.text === 'string' ? part.text : ''))
    .join('\n')
    .trim()
}

function normalizeGeneratedTitle(value) {
  return String(value || '')
    .replace(/<think>[\s\S]*?<\/think>/giu, '')
    .replace(/^["'“”‘’「」『』\s]+|["'“”‘’「」『』\s]+$/gu, '')
    .replace(/^标题\s*[:：]\s*/u, '')
    .replace(/[。.!！?？；;，,、]+$/u, '')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 48)
}

function buildTitleGenerationPrompts(titleContext = {}) {
  const systemPrompt = [
    '你是一个会话标题生成器。',
    '根据给定的精简会话上下文，生成一个简短中文标题。',
    '要求：12 到 24 个汉字左右，准确反映任务主题，不要标点，不要解释，不要输出多行。',
    '如果上下文主要是代码或产品问题，标题要包含核心对象和动作。',
  ].join('\n')
  const userPrompt = [
    `当前标题：${titleContext.currentTitle || '新会话'}`,
    titleContext.compressedSummary
      ? `已有会话摘要：\n${titleContext.compressedSummary}`
      : '',
    Array.isArray(titleContext.openingMessages) && titleContext.openingMessages.length > 0
      ? `开头信息：\n${titleContext.openingMessages
          .map((entry, index) => `${index + 1}. [${entry.role}] ${entry.content}`)
          .join('\n')}`
      : '',
    Array.isArray(titleContext.recentMessages) && titleContext.recentMessages.length > 0
      ? `最近上下文：\n${titleContext.recentMessages
          .map((entry, index) => `${index + 1}. [${entry.role}] ${entry.content}`)
          .join('\n')}`
      : '',
    Array.isArray(titleContext.attachments) && titleContext.attachments.length > 0
      ? `附件和文件线索：\n${titleContext.attachments.join('\n')}`
      : '',
    '请只返回一个标题。',
  ]
    .filter(Boolean)
    .join('\n\n')
  return { systemPrompt, userPrompt }
}

async function generateOpenAiTitle(settings, titleContext) {
  const apiBase = normalizeBaseUrl(settings.baseUrl, 'https://api.openai.com/v1')
  const { systemPrompt, userPrompt } = buildTitleGenerationPrompts(titleContext)
  const response = await guardedFetch(
    `${apiBase}/chat/completions`,
    {
      method: 'POST',
      headers: {
        ...openAiCompatibleHeaders(settings),
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: settings.model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        max_tokens: 80,
        temperature: 0.2,
        stream: false,
      }),
    },
    {
      settings,
      proxyMode: 'provider-explicit',
      allowLocal: true,
      timeoutMs: 30_000,
      timeoutMessage: 'Timed out while generating session title.',
    },
  )
  const data = await parseJsonResponse(response)
  if (!response.ok) {
    throw new Error(data.error?.message || 'OpenAI-compatible title generation failed')
  }
  return normalizeGeneratedTitle(
    flattenOpenAiMessageContent(data.choices?.[0]?.message?.content),
  )
}

async function generateGoogleTitle(settings, titleContext) {
  const apiBase = normalizeBaseUrl(
    settings.baseUrl,
    'https://generativelanguage.googleapis.com/v1beta',
  )
  const { systemPrompt, userPrompt } = buildTitleGenerationPrompts(titleContext)
  const response = await guardedFetch(
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
        contents: [
          {
            role: 'user',
            parts: [{ text: userPrompt }],
          },
        ],
        generationConfig: {
          maxOutputTokens: 80,
          temperature: 0.2,
        },
      }),
    },
    {
      settings,
      proxyMode: 'provider-explicit',
      allowLocal: true,
      timeoutMs: 30_000,
      timeoutMessage: 'Timed out while generating session title.',
    },
  )
  const data = await parseJsonResponse(response)
  if (!response.ok) {
    throw new Error(data.error?.message || 'Google title generation failed')
  }
  return normalizeGeneratedTitle(flattenGeminiTextResponse(data))
}

async function generateSessionTitle(settings, titleContext) {
  const title =
    settings.provider === 'google'
      ? await generateGoogleTitle(settings, titleContext)
      : await generateOpenAiTitle(settings, titleContext)
  if (!title) {
    throw new Error('模型没有返回可用标题。')
  }
  return {
    ok: true,
    message: '已生成会话标题。',
    models: [],
    title,
  }
}

async function fetchOpenAiModels(settings) {
  const apiBase = normalizeBaseUrl(settings.baseUrl, 'https://api.openai.com/v1')
  const response = await guardedFetch(
    `${apiBase}/models`,
    {
      headers: openAiCompatibleHeaders(settings),
    },
    {
      settings,
      proxyMode: 'provider-explicit',
      allowLocal: true,
      timeoutMs: 20_000,
      timeoutMessage: 'Timed out while fetching provider models.',
    },
  )
  const data = await parseJsonResponse(response)
  if (!response.ok) {
    throw new Error(data.error?.message || 'Failed to fetch models from OpenAI-compatible provider')
  }
  const models = dedupeModels((data.data || []).map(toProviderModel))
  return {
    ok: true,
    message: `成功获取 ${models.length} 个模型。`,
    models,
  }
}

async function fetchGoogleModels(settings) {
  const apiBase = normalizeBaseUrl(
    settings.baseUrl,
    'https://generativelanguage.googleapis.com/v1beta',
  )
  const response = await guardedFetch(
    `${apiBase}/models?key=${encodeURIComponent(settings.apiKey)}`,
    {},
    {
      settings,
      proxyMode: 'provider-explicit',
      allowLocal: true,
      timeoutMs: 20_000,
      timeoutMessage: 'Timed out while fetching provider models.',
    },
  )
  const data = await parseJsonResponse(response)
  if (!response.ok) {
    throw new Error(data.error?.message || 'Failed to fetch models from Google')
  }
  const models = dedupeModels(
    (data.models || []).map(entry => ({
      id: String(entry.name || '').replace(/^models\//, ''),
      enabled: false,
      contextWindowTokens: pickFiniteNumber(
        entry.inputTokenLimit,
        entry.input_token_limit,
      ),
      maxOutputTokens: pickFiniteNumber(
        entry.outputTokenLimit,
        entry.output_token_limit,
      ),
    })),
  )
  return {
    ok: true,
    message: `成功获取 ${models.length} 个模型。`,
    models,
  }
}

async function testProxyConnectivity(settings = {}) {
  const configuredProxy =
    typeof settings.networkProxy === 'string' ? settings.networkProxy.trim() : ''

  const response = await guardedFetch(
    PROXY_CONNECTIVITY_TEST_URL,
    {},
    {
      settings,
      networkProxy: configuredProxy,
      proxyMode: configuredProxy ? 'always' : 'direct',
      timeoutMs: 15_000,
      timeoutMessage: 'Timed out while testing proxy connectivity.',
    },
  )

  if (!response.ok) {
    throw new Error(
      `${configuredProxy ? '代理地址' : '直连'}连通性测试失败：测试地址返回 HTTP ${response.status}。`,
    )
  }

  let ipAddress = ''
  try {
    const payload = await response.json()
    ipAddress = typeof payload?.ip === 'string' ? payload.ip.trim() : ''
  } catch {
    ipAddress = ''
  }

  const modeLabel = configuredProxy ? '代理地址' : '直连'
  return {
    ok: true,
    message: ipAddress
      ? `${modeLabel}连通性测试成功，当前出口 IP 为 ${ipAddress}。`
      : `${modeLabel}连通性测试成功，已访问 ${PROXY_CONNECTIVITY_TEST_URL}。`,
    models: [],
  }
}

async function runAction(payload) {
  const { action, settings } = payload

  if (action === 'test-proxy') {
    return testProxyConnectivity(settings)
  }

  if (settings?.provider !== 'custom' && !settings?.apiKey?.trim()) {
    throw new Error('Missing API key.')
  }

  if (action === 'test') {
    const result =
      settings.provider === 'google'
        ? await fetchGoogleModels(settings)
        : await fetchOpenAiModels(settings)
    return {
      ok: true,
      message: `连通性测试成功，可访问服务并读取到 ${result.models.length} 个模型。`,
      models: result.models,
    }
  }

  if (action === 'fetch-models') {
    return settings.provider === 'google'
      ? fetchGoogleModels(settings)
      : fetchOpenAiModels(settings)
  }

  if (action === 'generate-title') {
    return generateSessionTitle(settings, payload.titleContext || {})
  }

  throw new Error(`Unsupported provider action: ${action}`)
}

const rawPayload = process.argv[2]

if (!rawPayload) {
  process.stderr.write('Missing provider action payload.\n')
  process.exit(1)
}

try {
  const payload = JSON.parse(rawPayload)
  const result = await runAction(payload)
  process.stdout.write(JSON.stringify(result))
} catch (error) {
  process.stderr.write(error instanceof Error ? error.message : String(error))
  process.exit(1)
}
