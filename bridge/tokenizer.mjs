import { encodingForModel, getEncoding } from 'js-tiktoken'

const DEFAULT_ENCODING_NAME = 'cl100k_base'

const encoderCache = new Map()

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

function getCachedEncoding(key, createEncoding) {
  if (!encoderCache.has(key)) {
    encoderCache.set(key, createEncoding())
  }
  return encoderCache.get(key)
}

function resolveEncoding(options = {}) {
  const model = typeof options.model === 'string' ? options.model.trim() : ''
  if (model) {
    try {
      return getCachedEncoding(`model:${model}`, () => encodingForModel(model))
    } catch {
      const encodingName = inferEncodingName(model)
      return getCachedEncoding(`encoding:${encodingName}`, () => getEncoding(encodingName))
    }
  }
  return getCachedEncoding(`encoding:${DEFAULT_ENCODING_NAME}`, () =>
    getEncoding(DEFAULT_ENCODING_NAME),
  )
}

export function countTextTokens(value = '', options = {}) {
  const text = String(value || '')
  if (!text) {
    return 0
  }
  return resolveEncoding(options).encode(text).length
}

export function countJsonTokens(value, options = {}) {
  try {
    return countTextTokens(JSON.stringify(value), options)
  } catch {
    return 0
  }
}
