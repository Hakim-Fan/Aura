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
