const DEFAULT_ID_PREFIX = 'execution'

function normalizeSegment(value, fallback = 'step') {
  const normalized = String(value || '')
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
  return normalized || fallback
}

function resolveMessageId(logContext = {}) {
  return (
    logContext.assistantMessageId ||
    logContext.messageId ||
    logContext.userMessageId ||
    ''
  )
}

export function createExecutionStepIdFactory(logContext = {}) {
  const resolvedMessageId = normalizeSegment(resolveMessageId(logContext), '')
  const messageId =
    resolvedMessageId ||
    `${DEFAULT_ID_PREFIX}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  const counters = new Map()

  function next(type = 'step', hint = '') {
    const normalizedType = normalizeSegment(type, 'step')
    const count = (counters.get(normalizedType) || 0) + 1
    counters.set(normalizedType, count)
    const countPart = count.toString(36).padStart(4, '0')
    const hintPart = hint ? `-${normalizeSegment(hint)}` : ''
    return `${messageId}-${normalizedType}-${countPart}${hintPart}`
  }

  return {
    messageId,
    next,
  }
}
