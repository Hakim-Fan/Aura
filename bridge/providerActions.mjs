import { normalizeBaseUrl } from './utils.mjs'

async function parseJsonResponse(response) {
  const text = await response.text()
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`Provider returned invalid JSON\n\n${text}`)
  }
}

async function fetchOpenAiModels(settings) {
  const apiBase = normalizeBaseUrl(settings.baseUrl, 'https://api.openai.com/v1')
  const response = await fetch(`${apiBase}/models`, {
    headers: {
      authorization: `Bearer ${settings.apiKey}`,
    },
  })
  const data = await parseJsonResponse(response)
  if (!response.ok) {
    throw new Error(data.error?.message || 'Failed to fetch models from OpenAI-compatible provider')
  }
  const models = (data.data || [])
    .map(entry => entry.id)
    .filter(Boolean)
    .sort((left, right) => left.localeCompare(right))
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
  const response = await fetch(
    `${apiBase}/models?key=${encodeURIComponent(settings.apiKey)}`,
  )
  const data = await parseJsonResponse(response)
  if (!response.ok) {
    throw new Error(data.error?.message || 'Failed to fetch models from Google')
  }
  const models = (data.models || [])
    .map(entry => String(entry.name || '').replace(/^models\//, ''))
    .filter(Boolean)
    .sort((left, right) => left.localeCompare(right))
  return {
    ok: true,
    message: `成功获取 ${models.length} 个模型。`,
    models,
  }
}

async function runAction(payload) {
  const { action, settings } = payload
  if (!settings?.apiKey?.trim()) {
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
