import {
  readSessionProviderHealth,
  rememberSessionProviderFailure,
  rememberSessionProviderSuccess,
} from '../../retrievalProviders/sessionHealth.mjs'

const FETCH_PROVIDER_SESSION_SCOPE = 'web-fetch'
const FETCH_PROVIDER_SUCCESS_MEMORY_MS = 30 * 60_000
const FETCH_PROVIDER_COOLDOWN_MS = {
  authentication: 15 * 60_000,
  rate_limit: 2 * 60_000,
  unavailable: 90_000,
  timeout: 60_000,
  network: 45_000,
  unsupported: 5 * 60_000,
  execution_failed: 60_000,
}
const FETCH_PROVIDER_CATEGORY_PENALTY = {
  authentication: 140,
  rate_limit: 95,
  unavailable: 65,
  timeout: 45,
  network: 35,
  unsupported: 110,
  execution_failed: 40,
}

function getWebFetchRuntimeState(runtime = {}) {
  if (!runtime.__webFetchState || typeof runtime.__webFetchState !== 'object') {
    runtime.__webFetchState = {
      providers: {},
    }
  }

  if (
    !runtime.__webFetchState.providers ||
    typeof runtime.__webFetchState.providers !== 'object'
  ) {
    runtime.__webFetchState.providers = {}
  }

  return runtime.__webFetchState
}

function normalizeProviderFailure(error) {
  const errorInfo =
    error && typeof error === 'object' && error.errorInfo && typeof error.errorInfo === 'object'
      ? error.errorInfo
      : null
  const rawStatus = Number(errorInfo?.status || error?.status)
  const code =
    typeof errorInfo?.code === 'string'
      ? errorInfo.code
      : typeof error?.code === 'string'
        ? error.code
        : ''
  const summary =
    typeof errorInfo?.summary === 'string' && errorInfo.summary.trim()
      ? errorInfo.summary.trim()
      : error instanceof Error && error.message.trim()
        ? error.message.trim()
        : typeof error === 'string' && error.trim()
          ? error.trim()
          : 'Fetch provider failed'
  const detail =
    typeof errorInfo?.detail === 'string' && errorInfo.detail.trim()
      ? errorInfo.detail.trim()
      : ''
  const message = String(detail || summary || '').toLowerCase()
  const statusFromMessageMatch = message.match(/\bhttp\s+(\d{3})\b/u)
  const status = Number.isFinite(rawStatus)
    ? rawStatus
    : statusFromMessageMatch
      ? Number(statusFromMessageMatch[1])
      : NaN

  if (
    status === 401 ||
    status === 403 ||
    code.includes('AUTH') ||
    message.includes('api key') ||
    message.includes('authentication')
  ) {
    return {
      category: 'authentication',
      code: code || 'WEB_FETCH_PROVIDER_AUTH_FAILED',
      summary,
      detail,
    }
  }

  if (
    status === 402 ||
    status === 429 ||
    code.includes('RATE') ||
    code.includes('QUOTA') ||
    message.includes('rate limit') ||
    message.includes('quota') ||
    message.includes('challenge')
  ) {
    return {
      category: 'rate_limit',
      code: code || 'WEB_FETCH_PROVIDER_RATE_LIMITED',
      summary,
      detail,
    }
  }

  if (
    status === 408 ||
    code.includes('TIMEOUT') ||
    message.includes('timed out') ||
    message.includes('timeout')
  ) {
    return {
      category: 'timeout',
      code: code || 'WEB_FETCH_PROVIDER_TIMEOUT',
      summary,
      detail,
    }
  }

  if (
    status === 502 ||
    status === 503 ||
    status === 504 ||
    code.includes('UNAVAILABLE') ||
    message.includes('unavailable')
  ) {
    return {
      category: 'unavailable',
      code: code || 'WEB_FETCH_PROVIDER_UNAVAILABLE',
      summary,
      detail,
    }
  }

  if (
    code.includes('DISABLED') ||
    code.includes('NOT_ENABLED') ||
    code.includes('EMPTY_CONTENT') ||
    code.includes('UNSUPPORTED') ||
    code.includes('REQUIRES_BROWSER') ||
    message.includes('not enabled') ||
    message.includes('not configured')
  ) {
    return {
      category: 'unsupported',
      code: code || 'WEB_FETCH_PROVIDER_NOT_CONFIGURED',
      summary,
      detail,
    }
  }

  if (status >= 500 || code.includes('NETWORK')) {
    return {
      category: 'network',
      code: code || 'WEB_FETCH_PROVIDER_FAILED',
      summary,
      detail,
    }
  }

  return {
    category: 'execution_failed',
    code: code || 'WEB_FETCH_PROVIDER_FAILED',
    summary,
    detail,
  }
}

function resolveProviderCooldownMs(category = '') {
  return FETCH_PROVIDER_COOLDOWN_MS[category] || 45_000
}

function resolveProviderHealthExpiresAt(blockedUntil, now = Date.now()) {
  return Math.max(blockedUntil, now + FETCH_PROVIDER_SUCCESS_MEMORY_MS)
}

function readRuntimeProviderEntry(runtime = {}, providerId = '') {
  const normalizedId = String(providerId || '').trim()
  if (!normalizedId) {
    return null
  }

  const state = getWebFetchRuntimeState(runtime)
  const entry = state.providers[normalizedId]
  if (!entry || typeof entry !== 'object') {
    return null
  }

  const healthExpiresAt =
    Number(entry.healthExpiresAt) || Number(entry.blockedUntil) || 0
  if (healthExpiresAt > 0 && healthExpiresAt <= Date.now()) {
    delete state.providers[normalizedId]
    return null
  }

  return entry
}

function resolveEntrySignalAt(entry) {
  if (!entry || typeof entry !== 'object') {
    return 0
  }
  return Math.max(
    Number(entry.healthExpiresAt) || 0,
    Number(entry.blockedUntil) || 0,
    Number(entry.lastFailureAt) || 0,
    Number(entry.lastSuccessAt) || 0,
  )
}

function pickDominantProviderEntry(runtimeEntry, sessionEntry) {
  if (runtimeEntry && sessionEntry) {
    return resolveEntrySignalAt(runtimeEntry) >= resolveEntrySignalAt(sessionEntry)
      ? { ...runtimeEntry, source: 'runtime' }
      : sessionEntry
  }

  if (runtimeEntry) {
    return { ...runtimeEntry, source: 'runtime' }
  }

  return sessionEntry || null
}

function readProviderEntry(runtime = {}, providerId = '') {
  return pickDominantProviderEntry(
    readRuntimeProviderEntry(runtime, providerId),
    readSessionProviderHealth(FETCH_PROVIDER_SESSION_SCOPE, providerId),
  )
}

export function resolveWebFetchProviderHealthScore(availability, now = Date.now()) {
  if (!availability || typeof availability !== 'object') {
    return 0
  }

  if (availability.blocked) {
    return -10_000
  }

  const entry = availability.entry
  if (!entry || typeof entry !== 'object') {
    return 0
  }

  let score = 0
  const lastSuccessAt = Number(entry.lastSuccessAt) || 0
  const lastFailureAt = Number(entry.lastFailureAt) || 0
  const consecutiveFailures = Math.max(0, Number(entry.consecutiveFailures) || 0)
  const category = typeof entry.category === 'string' ? entry.category : ''

  if (lastSuccessAt > 0) {
    score += 80
    score += Math.max(0, 30 - Math.round((now - lastSuccessAt) / 60_000))
  }

  if (lastFailureAt > 0 && lastFailureAt >= lastSuccessAt) {
    score -= FETCH_PROVIDER_CATEGORY_PENALTY[category] || 30
    score -= consecutiveFailures * 8
    score -= Math.min(25, Math.round((now - lastFailureAt) / 60_000))
  }

  if (availability.source === 'runtime') {
    score += 5
  }

  return score
}

export function getWebFetchProviderAvailability(
  runtime = {},
  providerId = '',
  options = {},
) {
  const entry = readProviderEntry(runtime, providerId)
  const enabled = options.enabled !== false
  const blocked = Boolean(entry && (Number(entry.blockedUntil) || 0) > Date.now())

  return {
    enabled,
    blocked,
    usable: enabled && !blocked,
    entry,
    source: entry?.source || '',
  }
}

export function rememberWebFetchProviderFailure(runtime = {}, providerId = '', error) {
  const normalizedId = String(providerId || '').trim()
  if (!normalizedId) {
    return null
  }

  const state = getWebFetchRuntimeState(runtime)
  const previous = readProviderEntry(runtime, normalizedId)
  const failure = normalizeProviderFailure(error)
  const now = Date.now()
  const consecutiveFailures =
    (Number(previous?.lastSuccessAt) || 0) > (Number(previous?.lastFailureAt) || 0)
      ? 1
      : (Number(previous?.consecutiveFailures) || 0) + 1
  const blockedUntil = now + resolveProviderCooldownMs(failure.category)
  state.providers[normalizedId] = {
    blockedUntil,
    healthExpiresAt: resolveProviderHealthExpiresAt(blockedUntil, now),
    category: failure.category,
    code: failure.code,
    summary: failure.summary,
    detail: failure.detail,
    lastFailureAt: now,
    lastSuccessAt: Number(previous?.lastSuccessAt) || 0,
    consecutiveFailures,
  }
  rememberSessionProviderFailure(
    FETCH_PROVIDER_SESSION_SCOPE,
    normalizedId,
    state.providers[normalizedId],
  )
  return {
    ...state.providers[normalizedId],
    source: 'runtime',
  }
}

export function rememberWebFetchProviderSuccess(runtime = {}, providerId = '') {
  const normalizedId = String(providerId || '').trim()
  if (!normalizedId) {
    return null
  }

  const state = getWebFetchRuntimeState(runtime)
  const now = Date.now()
  state.providers[normalizedId] = {
    blockedUntil: 0,
    healthExpiresAt: now + FETCH_PROVIDER_SUCCESS_MEMORY_MS,
    category: '',
    code: '',
    summary: '',
    detail: '',
    lastFailureAt: 0,
    lastSuccessAt: now,
    consecutiveFailures: 0,
  }
  rememberSessionProviderSuccess(
    FETCH_PROVIDER_SESSION_SCOPE,
    normalizedId,
    state.providers[normalizedId],
    FETCH_PROVIDER_SUCCESS_MEMORY_MS,
  )
  return {
    ...state.providers[normalizedId],
    source: 'runtime',
  }
}
