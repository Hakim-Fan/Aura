import { readCache, normalizeCacheKey, writeCache } from './web/shared/cache.mjs'
import {
  readPersistentCacheEntry,
  writePersistentCache,
} from './web/shared/persistentCache.mjs'

function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[`"'()[\]{}]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function splitQueryTerms(value) {
  const normalized = normalizeText(value)
  if (!normalized) {
    return []
  }

  return Array.from(
    new Set(
      normalized
        .split(/[^a-z0-9\u4e00-\u9fff]+/u)
        .map(entry => entry.trim())
        .filter(entry => entry.length >= 2),
    ),
  )
}

const DEFERRED_ENTRY_CACHE = new WeakMap()
const DEFERRED_INDEX_CACHE = new WeakMap()
const DEFERRED_SERIALIZED_INDEX_CACHE = new Map()
const DEFERRED_INDEX_NAMESPACE = 'deferred-tool-search'
const DEFERRED_INDEX_CACHE_MAX_ENTRIES = 32
const DEFERRED_INDEX_TTL_MS = 15 * 60_000

function getCachedEntrySearchData(entry) {
  const cached = DEFERRED_ENTRY_CACHE.get(entry)
  if (cached) {
    return cached
  }

  const corpus = normalizeText(
    [
      entry.name,
      entry.namespace,
      entry.source,
      entry.tool?.capabilityId,
      entry.tool?.capabilityName,
      entry.tool?.capabilityDescription,
      entry.tool?.description,
      ...(Array.isArray(entry.tool?.aliases) ? entry.tool.aliases : []),
    ]
      .filter(Boolean)
      .join(' '),
  )
  const data = {
    corpus,
    terms: splitQueryTerms(corpus),
    normalizedName: normalizeText(entry.name),
    normalizedCapabilityId: normalizeText(entry.tool?.capabilityId),
    normalizedCapabilityName: normalizeText(entry.tool?.capabilityName),
  }
  DEFERRED_ENTRY_CACHE.set(entry, data)
  return data
}

function buildDeferredEntryCacheKey(entry) {
  return normalizeCacheKey(
    JSON.stringify({
      name: entry?.name || '',
      namespace: entry?.namespace || '',
      source: entry?.source || '',
      capabilityId: entry?.tool?.capabilityId || '',
      capabilityName: entry?.tool?.capabilityName || '',
      capabilityDescription: entry?.tool?.capabilityDescription || '',
      description: entry?.tool?.description || '',
      aliases: Array.isArray(entry?.tool?.aliases)
        ? entry.tool.aliases.filter(Boolean).slice().sort()
        : [],
    }),
  )
}

function buildSerializedSearchRecord(entry, key) {
  const data = getCachedEntrySearchData(entry)
  return {
    key,
    corpus: data.corpus,
    terms: data.terms,
    normalizedName: data.normalizedName,
    normalizedCapabilityId: data.normalizedCapabilityId,
    normalizedCapabilityName: data.normalizedCapabilityName,
  }
}

function normalizeSerializedSearchRecord(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    return null
  }

  return {
    key: typeof record.key === 'string' ? record.key : '',
    corpus: typeof record.corpus === 'string' ? record.corpus : '',
    terms: Array.isArray(record.terms)
      ? record.terms.filter(term => typeof term === 'string' && term)
      : [],
    normalizedName:
      typeof record.normalizedName === 'string' ? record.normalizedName : '',
    normalizedCapabilityId:
      typeof record.normalizedCapabilityId === 'string'
        ? record.normalizedCapabilityId
        : '',
    normalizedCapabilityName:
      typeof record.normalizedCapabilityName === 'string'
        ? record.normalizedCapabilityName
        : '',
  }
}

function normalizeCachedDeferredIndex(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }

  const records = Array.isArray(value.records)
    ? value.records.map(normalizeSerializedSearchRecord).filter(record => record?.key)
    : []

  return {
    records,
  }
}

function buildDeferredIndexSignature(entryKeys) {
  return normalizeCacheKey(JSON.stringify([...entryKeys].sort()))
}

function readDeferredIndexCache(cacheKey) {
  const inMemory = readCache(DEFERRED_SERIALIZED_INDEX_CACHE, cacheKey)
  if (inMemory) {
    return {
      value: inMemory,
      layer: 'memory',
    }
  }

  const persisted = readPersistentCacheEntry(DEFERRED_INDEX_NAMESPACE, cacheKey, {
    maxEntries: DEFERRED_INDEX_CACHE_MAX_ENTRIES,
  })
  if (!persisted) {
    return null
  }

  const normalized = normalizeCachedDeferredIndex(persisted.value)
  if (!normalized) {
    return null
  }

  writeCache(
    DEFERRED_SERIALIZED_INDEX_CACHE,
    cacheKey,
    normalized,
    Math.max(1, persisted.expiresAt - Date.now()),
  )
  return {
    value: normalized,
    layer: 'persistent',
  }
}

function writeDeferredIndexCache(cacheKey, value, ttlMs = DEFERRED_INDEX_TTL_MS) {
  const normalized = normalizeCachedDeferredIndex(value)
  if (!normalized) {
    return
  }

  writeCache(DEFERRED_SERIALIZED_INDEX_CACHE, cacheKey, normalized, ttlMs)
  writePersistentCache(DEFERRED_INDEX_NAMESPACE, cacheKey, normalized, ttlMs, {
    maxEntries: DEFERRED_INDEX_CACHE_MAX_ENTRIES,
  })
}

function buildIndexFromSerializedRecords(entries, serializedRecords) {
  const recordsByKey = new Map(
    serializedRecords
      .map(normalizeSerializedSearchRecord)
      .filter(record => record?.key)
      .map(record => [record.key, record]),
  )
  const records = entries.map((entry, index) => {
    const key = buildDeferredEntryCacheKey(entry)
    const cachedRecord = recordsByKey.get(key) || buildSerializedSearchRecord(entry, key)
    return {
      entry,
      index,
      ...cachedRecord,
    }
  })
  const termIndex = new Map()

  for (const record of records) {
    for (const term of record.terms) {
      const bucket = termIndex.get(term) || []
      bucket.push(record)
      termIndex.set(term, bucket)
    }
  }

  return {
    records,
    termIndex,
  }
}

export function createDeferredToolIndex(entries) {
  if (!Array.isArray(entries)) {
    return {
      records: [],
      termIndex: new Map(),
    }
  }

  const cached = DEFERRED_INDEX_CACHE.get(entries)
  if (cached) {
    return cached
  }

  const entryKeys = entries.map(buildDeferredEntryCacheKey)
  const signature = buildDeferredIndexSignature(entryKeys)
  const cachedSerializedIndex = readDeferredIndexCache(signature)?.value
  const index = cachedSerializedIndex
    ? buildIndexFromSerializedRecords(entries, cachedSerializedIndex.records)
    : buildIndexFromSerializedRecords(
        entries,
        entries.map((entry, index) =>
          buildSerializedSearchRecord(entry, entryKeys[index]),
        ),
      )

  if (!cachedSerializedIndex) {
    writeDeferredIndexCache(signature, {
      records: index.records.map(record => ({
        key: record.key,
        corpus: record.corpus,
        terms: record.terms,
        normalizedName: record.normalizedName,
        normalizedCapabilityId: record.normalizedCapabilityId,
        normalizedCapabilityName: record.normalizedCapabilityName,
      })),
    })
  }

  DEFERRED_INDEX_CACHE.set(entries, index)
  return index
}

function resolveSearchIndex(entriesOrIndex) {
  if (
    entriesOrIndex &&
    typeof entriesOrIndex === 'object' &&
    Array.isArray(entriesOrIndex.records) &&
    entriesOrIndex.termIndex instanceof Map
  ) {
    return entriesOrIndex
  }

  return createDeferredToolIndex(entriesOrIndex)
}

function collectCandidateRecords(index, normalizedQuery, queryTerms) {
  if (!normalizedQuery) {
    return []
  }

  const candidates = new Map()

  for (const term of queryTerms) {
    for (const record of index.termIndex.get(term) || []) {
      candidates.set(record.entry.name, record)
    }
  }

  if (candidates.size === 0) {
    for (const record of index.records) {
      if (
        record.corpus.includes(normalizedQuery) ||
        record.normalizedName.includes(normalizedQuery) ||
        record.normalizedCapabilityId.includes(normalizedQuery) ||
        record.normalizedCapabilityName.includes(normalizedQuery)
      ) {
        candidates.set(record.entry.name, record)
      }
    }
  }

  return candidates.size > 0 ? [...candidates.values()] : index.records
}

function scoreRecord(record, normalizedQuery, queryTerms) {
  if (!normalizedQuery || !record?.corpus) {
    return 0
  }

  let score = 0

  if (record.corpus.includes(normalizedQuery)) {
    score += 12
  }

  for (const term of queryTerms) {
    if (record.corpus.includes(term)) {
      score += term.length >= 6 ? 4 : 2
    }
  }

  if (record.normalizedCapabilityName.includes(normalizedQuery)) {
    score += 8
  }

  if (record.normalizedCapabilityId.includes(normalizedQuery)) {
    score += 8
  }

  if (record.normalizedName.includes(normalizedQuery)) {
    score += 6
  }

  return score
}

export function searchDeferredToolEntries(entriesOrIndex, query, maxResults = 8, options = {}) {
  const normalizedQuery = normalizeText(query)
  const queryTerms = splitQueryTerms(query)
  const index = resolveSearchIndex(entriesOrIndex)

  return collectCandidateRecords(index, normalizedQuery, queryTerms)
    .map(record => ({
      entry: record.entry,
      index: record.index,
      score: scoreRecord(record, normalizedQuery, queryTerms),
    }))
    .filter(result => {
      if (result.score <= 0) {
        return false
      }
      if (typeof options.isSearchableEntry === 'function') {
        return options.isSearchableEntry(result.entry) === true
      }
      return true
    })
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, Math.max(1, Math.min(20, Math.round(maxResults) || 8)))
}

function summarizeMatch(result) {
  const entry = result.entry
  return {
    name: entry.name,
    source: entry.source,
    namespace: entry.namespace,
    capabilityId: entry.tool?.capabilityId || '',
    capabilityName: entry.tool?.capabilityName || '',
    description: entry.tool?.description || '',
    score: result.score,
  }
}

export function createToolSearchTool({
  searchEntries,
  isSearchableEntry,
  loadEntries,
}) {
  const searchIndex = createDeferredToolIndex(searchEntries)

  return {
    source: 'builtin',
    name: 'tool_search',
    description:
      'Search deferred plugin and MCP tools by capability name, description, or tool name. Matching tools can be loaded into the current turn so you can call them next.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            'What capability or tool you are looking for, for example "git helper", "browser automation", or "search docs".',
        },
        maxResults: {
          type: 'number',
          description: 'Optional maximum number of matches to inspect and load.',
        },
      },
      required: ['query'],
    },
    async run(args, runtime = {}) {
      runtime.throwIfAborted?.()
      const query = typeof args?.query === 'string' ? args.query.trim() : ''
      if (!query) {
        throw new Error('tool_search.query must not be empty.')
      }

      const matches = searchDeferredToolEntries(
        searchIndex,
        query,
        args?.maxResults,
        {
          isSearchableEntry,
        },
      )

      if (matches.length === 0) {
        return {
          query,
          loadedToolNames: [],
          noResults: true,
          results: [],
        }
      }

      const loadedTools = loadEntries(matches.map(match => match.entry))
      runtime.registerTools?.(loadedTools)

      return {
        query,
        noResults: false,
        loadedToolNames: loadedTools.map(tool => tool.name),
        results: matches.map(summarizeMatch),
      }
    },
  }
}
