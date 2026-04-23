import {
  deletePersistentCacheEntry,
  readPersistentCacheEntry,
  writePersistentCache,
} from '../web/shared/persistentCache.mjs'

const PROVIDER_HEALTH_NAMESPACE = 'retrieval-provider-health'
const MAX_PROVIDER_HEALTH_ENTRIES = 128
const SESSION_PROVIDER_HEALTH = new Map()
const FAILURE_HEALTH_RETENTION_MS = 15 * 60_000
const SUCCESS_HEALTH_RETENTION_MS = 30 * 60_000

function normalizeScope(value) {
  return String(value || 'default')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9:_-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'default'
}

function normalizeProviderId(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
}

function buildHealthKey(scope, providerId) {
  const normalizedScope = normalizeScope(scope)
  const normalizedProviderId = normalizeProviderId(providerId)
  if (!normalizedProviderId) {
    return ''
  }
  return `${normalizedScope}:${normalizedProviderId}`
}

function normalizeHealthEntry(entry) {
  if (!entry || typeof entry !== 'object') {
    return null
  }

  const blockedUntil = Number(entry.blockedUntil) || 0
  const healthExpiresAt =
    Number(entry.healthExpiresAt) ||
    blockedUntil ||
    Number(entry.lastSuccessAt) ||
    Number(entry.lastFailureAt) ||
    0
  if (healthExpiresAt <= Date.now()) {
    return null
  }

  return {
    blockedUntil,
    healthExpiresAt,
    category: typeof entry.category === 'string' ? entry.category : '',
    code: typeof entry.code === 'string' ? entry.code : '',
    summary: typeof entry.summary === 'string' ? entry.summary : '',
    detail: typeof entry.detail === 'string' ? entry.detail : '',
    lastFailureAt: Number(entry.lastFailureAt) || 0,
    lastSuccessAt: Number(entry.lastSuccessAt) || 0,
    consecutiveFailures: Math.max(0, Math.round(Number(entry.consecutiveFailures) || 0)),
  }
}

function readMemoryEntry(key) {
  const normalized = normalizeHealthEntry(SESSION_PROVIDER_HEALTH.get(key))
  if (!normalized) {
    SESSION_PROVIDER_HEALTH.delete(key)
    return null
  }
  return normalized
}

function readPersistedEntry(key) {
  const persisted = readPersistentCacheEntry(PROVIDER_HEALTH_NAMESPACE, key, {
    maxEntries: MAX_PROVIDER_HEALTH_ENTRIES,
  })
  if (!persisted) {
    return null
  }

  const normalized = normalizeHealthEntry(persisted.value)
  if (!normalized) {
    deletePersistentCacheEntry(PROVIDER_HEALTH_NAMESPACE, key, {
      maxEntries: MAX_PROVIDER_HEALTH_ENTRIES,
    })
    return null
  }

  SESSION_PROVIDER_HEALTH.set(key, normalized)
  return normalized
}

function withSource(entry, source) {
  return entry ? { ...entry, source } : null
}

export function readSessionProviderHealth(scope, providerId) {
  const key = buildHealthKey(scope, providerId)
  if (!key) {
    return null
  }

  const memoryEntry = readMemoryEntry(key)
  if (memoryEntry) {
    return withSource(memoryEntry, 'session-memory')
  }

  return withSource(readPersistedEntry(key), 'session-persistent')
}

export function rememberSessionProviderFailure(scope, providerId, entry = {}) {
  const key = buildHealthKey(scope, providerId)
  if (!key) {
    return null
  }

  const now = Date.now()
  const blockedUntil = Math.max(0, Number(entry?.blockedUntil) || 0)
  const normalized = normalizeHealthEntry({
    ...entry,
    blockedUntil,
    healthExpiresAt: Math.max(
      Number(entry?.healthExpiresAt) || 0,
      blockedUntil + FAILURE_HEALTH_RETENTION_MS,
      now + FAILURE_HEALTH_RETENTION_MS,
    ),
  })
  if (!normalized) {
    return null
  }

  SESSION_PROVIDER_HEALTH.set(key, normalized)
  writePersistentCache(
    PROVIDER_HEALTH_NAMESPACE,
    key,
    normalized,
    Math.max(1, normalized.blockedUntil - Date.now()),
    {
      maxEntries: MAX_PROVIDER_HEALTH_ENTRIES,
    },
  )

  return withSource(normalized, 'session-memory')
}

export function rememberSessionProviderSuccess(scope, providerId, entry = {}, ttlMs = SUCCESS_HEALTH_RETENTION_MS) {
  const key = buildHealthKey(scope, providerId)
  if (!key) {
    return null
  }

  const now = Date.now()
  const normalized = normalizeHealthEntry({
    ...entry,
    blockedUntil: 0,
    category: typeof entry?.category === 'string' ? entry.category : '',
    code: typeof entry?.code === 'string' ? entry.code : '',
    summary: typeof entry?.summary === 'string' ? entry.summary : '',
    detail: typeof entry?.detail === 'string' ? entry.detail : '',
    lastFailureAt: Number(entry?.lastFailureAt) || 0,
    lastSuccessAt: Math.max(now, Number(entry?.lastSuccessAt) || 0),
    consecutiveFailures: 0,
    healthExpiresAt: now + Math.max(1, Number(ttlMs) || SUCCESS_HEALTH_RETENTION_MS),
  })
  if (!normalized) {
    return null
  }

  SESSION_PROVIDER_HEALTH.set(key, normalized)
  writePersistentCache(
    PROVIDER_HEALTH_NAMESPACE,
    key,
    normalized,
    Math.max(1, normalized.healthExpiresAt - now),
    {
      maxEntries: MAX_PROVIDER_HEALTH_ENTRIES,
    },
  )

  return withSource(normalized, 'session-memory')
}

export function clearSessionProviderFailure(scope, providerId) {
  const key = buildHealthKey(scope, providerId)
  if (!key) {
    return false
  }

  SESSION_PROVIDER_HEALTH.delete(key)
  deletePersistentCacheEntry(PROVIDER_HEALTH_NAMESPACE, key, {
    maxEntries: MAX_PROVIDER_HEALTH_ENTRIES,
  })
  return true
}
