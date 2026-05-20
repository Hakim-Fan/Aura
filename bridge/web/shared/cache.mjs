import crypto from 'node:crypto'

export function normalizeCacheKey(value) {
  return crypto.createHash('sha1').update(String(value || '')).digest('hex')
}

export function readCache(cache, key) {
  const entry = cache.get(key)
  if (!entry) {
    return null
  }
  if (typeof entry.expiresAt === 'number' && entry.expiresAt <= Date.now()) {
    cache.delete(key)
    return null
  }
  return entry.value
}

function pruneCache(cache, maxEntries = 0) {
  const limit = Math.max(0, Number(maxEntries) || 0)
  if (limit <= 0 && cache.size === 0) {
    return
  }

  const now = Date.now()
  for (const [entryKey, entry] of cache.entries()) {
    if (typeof entry?.expiresAt === 'number' && entry.expiresAt <= now) {
      cache.delete(entryKey)
    }
  }

  if (limit <= 0 || cache.size <= limit) {
    return
  }

  const overflow = cache.size - limit
  const oldestKeys = [...cache.entries()]
    .sort(
      ([, left], [, right]) =>
        (Number(left?.updatedAt) || 0) - (Number(right?.updatedAt) || 0),
    )
    .slice(0, overflow)
    .map(([entryKey]) => entryKey)

  for (const entryKey of oldestKeys) {
    cache.delete(entryKey)
  }
}

export function writeCache(cache, key, value, ttlMs, options = {}) {
  cache.set(key, {
    value,
    expiresAt: Date.now() + Math.max(0, Number(ttlMs) || 0),
    updatedAt: Date.now(),
  })
  pruneCache(cache, options.maxEntries)
}
