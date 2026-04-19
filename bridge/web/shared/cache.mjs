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

export function writeCache(cache, key, value, ttlMs) {
  cache.set(key, {
    value,
    expiresAt: Date.now() + Math.max(0, Number(ttlMs) || 0),
  })
}
