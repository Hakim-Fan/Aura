import { encodingForModel, getEncoding } from 'js-tiktoken'

const DEFAULT_ENCODING_NAME = 'cl100k_base'

type Encoder = {
  encode(value: string): ArrayLike<number>
}

const encoderCache = new Map<string, Encoder>()

function inferEncodingName(model = '') {
  const normalized = String(model || '').toLowerCase()
  if (
    normalized.includes('gpt-4o') ||
    normalized.includes('gpt-5') ||
    /^o\d/u.test(normalized)
  ) {
    return 'o200k_base'
  }
  return DEFAULT_ENCODING_NAME
}

function getCachedEncoding(key: string, createEncoding: () => Encoder) {
  let encoding = encoderCache.get(key)
  if (!encoding) {
    encoding = createEncoding()
    encoderCache.set(key, encoding)
  }
  return encoding
}

function resolveEncoding(model = '') {
  const normalizedModel = model.trim()
  if (normalizedModel) {
    try {
      return getCachedEncoding(`model:${normalizedModel}`, () =>
        encodingForModel(normalizedModel as Parameters<typeof encodingForModel>[0]),
      )
    } catch {
      const encodingName = inferEncodingName(normalizedModel)
      return getCachedEncoding(`encoding:${encodingName}`, () => getEncoding(encodingName))
    }
  }
  return getCachedEncoding(`encoding:${DEFAULT_ENCODING_NAME}`, () =>
    getEncoding(DEFAULT_ENCODING_NAME),
  )
}

export function countTextTokens(value = '', model = '') {
  const text = String(value || '')
  if (!text) {
    return 0
  }
  return resolveEncoding(model).encode(text).length
}

export function countJsonTokens(value: unknown, model = '') {
  try {
    return countTextTokens(JSON.stringify(value), model)
  } catch {
    return 0
  }
}
