import fs from 'node:fs'
import path from 'node:path'

const CACHE_ROOT = path.resolve(process.cwd(), '.cache', 'web')
const CACHE_FILE_VERSION = 1
const STORE_REGISTRY = new Map()

function normalizeNamespace(value) {
  return String(value || 'default')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'default'
}

function resolveStorePath(namespace) {
  return path.join(CACHE_ROOT, `${normalizeNamespace(namespace)}.json`)
}

function pruneEntries(entries = {}, maxEntries = 0) {
  const now = Date.now()
  const records = Object.entries(entries)
    .filter(([, entry]) => {
      const expiresAt = Number(entry?.expiresAt)
      return Number.isFinite(expiresAt) && expiresAt > now
    })
    .sort(
      ([, left], [, right]) =>
        (Number(right?.updatedAt) || 0) - (Number(left?.updatedAt) || 0),
    )

  const capped =
    maxEntries > 0 ? records.slice(0, maxEntries) : records

  return Object.fromEntries(
    capped.map(([key, entry]) => [
      key,
      {
        value: entry.value,
        expiresAt: Number(entry.expiresAt),
        updatedAt: Number(entry.updatedAt) || now,
      },
    ]),
  )
}

function persistStore(store) {
  fs.mkdirSync(CACHE_ROOT, { recursive: true })
  const payload = JSON.stringify(
    {
      version: CACHE_FILE_VERSION,
      savedAt: Date.now(),
      entries: pruneEntries(store.entries, store.maxEntries),
    },
    null,
    2,
  )
  const tempPath = `${store.filePath}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(tempPath, payload, 'utf8')
  fs.renameSync(tempPath, store.filePath)
}

function loadStore(namespace, maxEntries = 0) {
  const normalizedNamespace = normalizeNamespace(namespace)
  const existing = STORE_REGISTRY.get(normalizedNamespace)
  if (existing) {
    existing.maxEntries = Math.max(existing.maxEntries, Math.max(0, Number(maxEntries) || 0))
    return existing
  }

  const filePath = resolveStorePath(normalizedNamespace)
  let entries = {}

  try {
    if (fs.existsSync(filePath)) {
      const raw = fs.readFileSync(filePath, 'utf8')
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed === 'object' && parsed.entries && typeof parsed.entries === 'object') {
        entries = parsed.entries
      }
    }
  } catch {
    entries = {}
  }

  const store = {
    namespace: normalizedNamespace,
    filePath,
    maxEntries: Math.max(0, Number(maxEntries) || 0),
    entries: pruneEntries(entries, Math.max(0, Number(maxEntries) || 0)),
  }
  STORE_REGISTRY.set(normalizedNamespace, store)
  return store
}

function normalizeEntry(entry) {
  if (!entry || typeof entry !== 'object') {
    return null
  }
  const expiresAt = Number(entry.expiresAt)
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
    return null
  }
  return {
    value: entry.value,
    expiresAt,
    updatedAt: Number(entry.updatedAt) || Date.now(),
  }
}

export function readPersistentCacheEntry(namespace, key, options = {}) {
  const store = loadStore(namespace, options.maxEntries)
  const cacheKey = String(key || '')
  const normalized = normalizeEntry(store.entries[cacheKey])
  if (!normalized) {
    if (store.entries[cacheKey]) {
      delete store.entries[cacheKey]
      try {
        persistStore(store)
      } catch {
        // Best-effort cache cleanup only.
      }
    }
    return null
  }
  return normalized
}

export function writePersistentCache(namespace, key, value, ttlMs, options = {}) {
  const safeTtlMs = Math.max(0, Number(ttlMs) || 0)
  if (safeTtlMs <= 0) {
    return
  }

  const store = loadStore(namespace, options.maxEntries)
  const cacheKey = String(key || '')
  store.entries[cacheKey] = {
    value,
    expiresAt: Date.now() + safeTtlMs,
    updatedAt: Date.now(),
  }
  store.entries = pruneEntries(store.entries, store.maxEntries)

  try {
    persistStore(store)
  } catch {
    // Best-effort cache persistence only.
  }
}
