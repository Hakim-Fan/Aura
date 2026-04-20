import { createStructuredError } from '../../runtimeErrors.mjs'
import { runWebFetch } from '../fetch/runtime.mjs'
import { normalizeCacheKey, readCache, writeCache } from '../shared/cache.mjs'
import {
  readPersistentCacheEntry,
  writePersistentCache,
} from '../shared/persistentCache.mjs'
import { resolveWebSearchProviderOrder } from './providerRegistry.mjs'

const SEARCH_CACHE = new Map()
const SEARCH_CACHE_NAMESPACE = 'search'
const SEARCH_CACHE_MAX_ENTRIES = 256
const SEARCH_PREFETCH_LIMIT = 3
const SEARCH_PREFETCH_IN_FLIGHT = new Map()
const DEFAULT_SEARCH_LIMIT = 5
const DEFAULT_SEARCH_TIMEOUT_MS = 12_000

function collapseWhitespace(value) {
  return String(value || '')
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
}

function unique(values) {
  return Array.from(new Set((values || []).filter(Boolean)))
}

function normalizeDomain(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//u, '')
    .replace(/^www\./u, '')
    .replace(/\/.*$/u, '')
    .replace(/^\.+|\.+$/gu, '')
}

function parseQueryDomains(value) {
  const domains = []
  const normalized = String(value || '')
  const pattern = /\bsite:([^\s"']+)/giu
  let match
  while ((match = pattern.exec(normalized))) {
    const domain = normalizeDomain(match[1])
    if (domain) {
      domains.push(domain)
    }
  }
  return unique(domains)
}

function normalizeWebSearchQuery(value) {
  const original = collapseWhitespace(value)
  if (!original) {
    return { query: '', domains: [], providerQuery: '' }
  }

  const parsedDomains = parseQueryDomains(original)
  const normalizedQuery = collapseWhitespace(
    original
      .replace(/\b(?:site|filetype|before|after|intitle|inurl):([^\s]+)/giu, ' ')
      .replace(/\b(?:AND|OR|NOT)\b/giu, ' ')
      .replace(/["'`]+/g, ' '),
  )
  const providerQuery = collapseWhitespace(
    [normalizedQuery, ...parsedDomains.filter(domain => !normalizedQuery.includes(domain))].join(
      ' ',
    ),
  )

  return {
    query: normalizedQuery || original,
    domains: parsedDomains,
    providerQuery: providerQuery || normalizedQuery || original,
  }
}

function matchesDomain(hostname, domains) {
  const normalizedHostname = normalizeDomain(hostname)
  if (!normalizedHostname || !Array.isArray(domains) || domains.length === 0) {
    return true
  }

  return domains.some(domain => {
    const normalizedDomain = normalizeDomain(domain)
    return (
      normalizedHostname === normalizedDomain ||
      normalizedHostname.endsWith(`.${normalizedDomain}`)
    )
  })
}

function generateSearchQueryCandidates(query) {
  const normalized = collapseWhitespace(query)
  if (!normalized) {
    return []
  }

  const candidates = [normalized]
  const stripped = collapseWhitespace(
    normalized
      .replace(
        /\b(?:is there (?:an )?(?:app|tool|website) (?:that|which)?(?: does| can| for)?|looking for|find me|i need|i want|help me find|有没有|有没有一个|有没有什么|我想找|帮我找|有没有工具)\b/giu,
        ' ',
      )
      .replace(/\b(?:simple|basic|small|easy)\b/giu, ' '),
  )
  if (stripped && stripped !== normalized) {
    candidates.push(stripped)
  }

  return unique(candidates)
}

function extractHostname(value) {
  try {
    return String(new URL(value || '').hostname).toLowerCase().replace(/^www\./u, '')
  } catch {
    return ''
  }
}

function tokenizeSearchTerms(value) {
  const normalized = collapseWhitespace(String(value || '').toLowerCase())
  if (!normalized) {
    return []
  }

  return unique(
    normalized.match(/[a-z0-9]{2,}|[\u4e00-\u9fff]{2,}/gu) || [],
  ).filter(
    token =>
      token.length >= 2 &&
      ![
        'what',
        'when',
        'where',
        'which',
        'with',
        'that',
        'this',
        'from',
        'into',
        'about',
        'latest',
        'current',
        'today',
        'news',
        'info',
        'information',
        'recent',
        'update',
        'updates',
        '官网',
        '官方',
        '最新',
        '今天',
        '最近',
        '资料',
        '信息',
      ].includes(token),
  )
}

function buildSearchResultText(result) {
  return collapseWhitespace([result?.title, result?.snippet, result?.site].filter(Boolean).join(' '))
}

function clampScore(value) {
  if (!Number.isFinite(value)) {
    return 0
  }
  return Math.max(0, Math.min(1, value))
}

function computeTokenJaccard(leftTokens, rightTokens) {
  const left = new Set(leftTokens || [])
  const right = new Set(rightTokens || [])
  if (left.size === 0 || right.size === 0) {
    return 0
  }

  let intersection = 0
  for (const token of left) {
    if (right.has(token)) {
      intersection += 1
    }
  }
  const union = new Set([...left, ...right]).size
  return union > 0 ? intersection / union : 0
}

function classifySearchResultDomain(hostname, url = '') {
  const normalizedHostname = normalizeDomain(hostname)
  const normalizedUrl = String(url || '').toLowerCase()
  const isDocsHost =
    /^docs\./u.test(normalizedHostname) ||
    /^developer\./u.test(normalizedHostname) ||
    /\/(?:docs?|documentation|reference|api)(?:\/|$)/u.test(normalizedUrl)
  const isPublicSector = /\.gov$/u.test(normalizedHostname) || /\.edu$/u.test(normalizedHostname)

  const majorNewsHosts = [
    'reuters.com',
    'apnews.com',
    'bloomberg.com',
    'wsj.com',
    'ft.com',
    'nytimes.com',
    'bbc.com',
    'bbc.co.uk',
    'theverge.com',
    'techcrunch.com',
    'arstechnica.com',
    'cnbc.com',
    'marketwatch.com',
    'finance.yahoo.com',
    'sec.gov',
    'nasdaq.com',
  ]

  if (isPublicSector) {
    return { category: 'public-sector', quality: 0.92, signals: ['public-trust-domain'] }
  }
  if (isDocsHost) {
    return { category: 'docs', quality: 0.9, signals: ['docs-domain-or-path'] }
  }
  if (majorNewsHosts.some(domain => matchesDomain(normalizedHostname, [domain]))) {
    return { category: 'major-news', quality: 0.82, signals: ['major-news-domain'] }
  }
  return { category: 'general-web', quality: 0.58, signals: ['general-web-domain'] }
}

function scoreSearchFreshness(result, args = {}) {
  const combinedText = [result?.title, result?.snippet, result?.url].filter(Boolean).join(' ')
  const normalizedText = combinedText.toLowerCase()
  const currentYear = new Date().getFullYear()
  const yearMatches = Array.from(
    normalizedText.matchAll(/\b(20\d{2})\b/gu),
    match => Number(match[1]),
  ).filter(year => Number.isFinite(year))
  const latestYear = yearMatches.length > 0 ? Math.max(...yearMatches) : 0
  const freshnessRequested = Boolean(args.requireFresh) || Boolean(args.freshness)

  let score = freshnessRequested ? 0.45 : 0.55
  const freshnessSignals = []

  if (/\b(?:latest|current|today|breaking|updated|new)\b|最新|今日|今天|更新/u.test(normalizedText)) {
    score += 0.12
    freshnessSignals.push('freshness-keyword')
  }

  if (latestYear >= currentYear) {
    score += 0.22
    freshnessSignals.push('current-year-signal')
  } else if (latestYear === currentYear - 1) {
    score += 0.12
    freshnessSignals.push('recent-year-signal')
  } else if (latestYear > 0 && latestYear <= currentYear - 3) {
    score -= freshnessRequested ? 0.16 : 0.06
    freshnessSignals.push('older-year-signal')
  }

  return { score: clampScore(score), signals: freshnessSignals }
}

function scoreSearchQueryCoverage(queryTerms, result) {
  if (!Array.isArray(queryTerms) || queryTerms.length === 0) {
    return { score: 0.55, matchedTerms: [] }
  }
  const searchableText = buildSearchResultText(result).toLowerCase()
  const matchedTerms = queryTerms.filter(term => searchableText.includes(term))
  return {
    score: clampScore(0.25 + (matchedTerms.length / queryTerms.length) * 0.75),
    matchedTerms,
  }
}

function scoreSearchNovelty(result, index, allResults) {
  const hostname = extractHostname(result?.url || '')
  const currentTokens = tokenizeSearchTerms(buildSearchResultText(result))
  const sameDomainCount = allResults.filter(entry => extractHostname(entry?.url || '') === hostname).length
  const maxSimilarity = allResults.reduce((highest, entry, entryIndex) => {
    if (entryIndex === index) {
      return highest
    }
    return Math.max(
      highest,
      computeTokenJaccard(currentTokens, tokenizeSearchTerms(buildSearchResultText(entry))),
    )
  }, 0)

  const domainDiversityScore = sameDomainCount <= 1 ? 1 : sameDomainCount === 2 ? 0.72 : 0.45
  const noveltyScore = clampScore(domainDiversityScore * 0.6 + (1 - maxSimilarity) * 0.4)
  return {
    score: noveltyScore,
    signals: [
      sameDomainCount <= 1 ? 'new-domain' : 'repeated-domain',
      maxSimilarity <= 0.35 ? 'distinct-snippet' : maxSimilarity >= 0.65 ? 'overlapping-snippet' : '',
    ].filter(Boolean),
  }
}

function getDynamicRankingWeights(query, context = {}) {
  const normalizedQuery = collapseWhitespace(String(query || '').toLowerCase())
  const freshnessRequested =
    Boolean(context?.requireFresh) ||
    Boolean(context?.freshness) ||
    /\b(?:latest|current|today|news|breaking|price|quote|earnings|stock)\b|最新|今天|当前|新闻|股价|行情|财报/u.test(
      normalizedQuery,
    )

  return freshnessRequested
    ? { quality: 0.3, coverage: 0.2, novelty: 0.15, freshness: 0.35 }
    : { quality: 0.42, coverage: 0.28, novelty: 0.2, freshness: 0.1 }
}

function rankSearchResults(results, context = {}) {
  const queryTerms = tokenizeSearchTerms(context.query)
  const preferredDomains = Array.isArray(context.domains) ? context.domains : []
  const weights = getDynamicRankingWeights(context.query, context)

  return (Array.isArray(results) ? results : [])
    .map((result, index, allResults) => {
      const hostname = extractHostname(result?.url || '')
      const domainMeta = classifySearchResultDomain(hostname, result?.url || '')
      const freshness = scoreSearchFreshness(result, context)
      const coverage = scoreSearchQueryCoverage(queryTerms, result)
      const novelty = scoreSearchNovelty(result, index, allResults)
      const preferredDomainMatch =
        preferredDomains.length > 0 && matchesDomain(hostname, preferredDomains)
      const sourceQualityScore = clampScore(domainMeta.quality + (preferredDomainMatch ? 0.05 : 0))
      const rankScore = clampScore(
        sourceQualityScore * weights.quality +
          coverage.score * weights.coverage +
          novelty.score * weights.novelty +
          freshness.score * weights.freshness,
      )
      const rankingSignals = unique([
        ...domainMeta.signals,
        ...freshness.signals,
        ...novelty.signals,
        coverage.matchedTerms.length > 0 ? 'query-match' : 'weak-query-match',
        preferredDomainMatch ? 'preferred-domain-match' : '',
      ])
      return {
        ...result,
        domainCategory: domainMeta.category,
        sourceQualityScore: Math.round(sourceQualityScore * 100),
        queryCoverageScore: Math.round(coverage.score * 100),
        noveltyScore: Math.round(novelty.score * 100),
        freshnessScore: Math.round(freshness.score * 100),
        rankScore: Math.round(rankScore * 100),
        matchedQueryTerms: coverage.matchedTerms.slice(0, 6),
        rankingSignals: rankingSignals.slice(0, 6),
        _sortScore: rankScore,
        _sourceIndex: index,
      }
    })
    .sort((left, right) => right._sortScore - left._sortScore || left._sourceIndex - right._sourceIndex)
    .map((result, index) => {
      const { _sortScore, _sourceIndex, ...publicResult } = result
      return { ...publicResult, rank: index + 1 }
    })
}

function resolveSearchTimeoutMs(settings, args) {
  const configuredSeconds = Number(settings?.web?.search?.timeoutSeconds)
  const configuredMs =
    Number.isFinite(configuredSeconds) && configuredSeconds > 0
      ? Math.round(configuredSeconds * 1000)
      : DEFAULT_SEARCH_TIMEOUT_MS
  return Math.max(1000, Number(args?.timeoutMs) || configuredMs)
}

function resolveCacheTtlMs(settings) {
  const minutes = Number(settings?.web?.search?.cacheTtlMinutes)
  return Math.max(0, Number.isFinite(minutes) ? Math.round(minutes * 60_000) : 30 * 60_000)
}

function resolveSearchPrefetchMaxChars(settings) {
  const configured = Number(settings?.web?.research?.defaultMaxChars)
  const fetchCap = Number(settings?.web?.fetch?.maxCharsCap)
  const fallback = Number.isFinite(configured) && configured > 0 ? configured : 3_200
  const cap = Number.isFinite(fetchCap) && fetchCap > 0 ? fetchCap : 20_000
  return Math.max(800, Math.min(cap, fallback))
}

function prefetchTopSearchResults(results, runtime = {}) {
  const targets = (Array.isArray(results) ? results : [])
    .filter(result => typeof result?.url === 'string' && result.url.trim())
    .slice(0, SEARCH_PREFETCH_LIMIT)
  if (targets.length === 0) {
    return
  }

  const maxChars = resolveSearchPrefetchMaxChars(runtime.settings || {})
  for (const entry of targets) {
    const url = entry.url.trim()
    if (!url || SEARCH_PREFETCH_IN_FLIGHT.has(url)) {
      continue
    }

    const prefetchPromise = runWebFetch(
      {
        url,
        mode: 'article',
        maxChars,
      },
      {
        ...runtime,
        onUpdate: undefined,
      },
    )
      .catch(() => null)
      .finally(() => {
        SEARCH_PREFETCH_IN_FLIGHT.delete(url)
      })

    SEARCH_PREFETCH_IN_FLIGHT.set(url, prefetchPromise)
  }
}

function readSearchCacheEntry(cacheKey) {
  const inMemory = readCache(SEARCH_CACHE, cacheKey)
  if (inMemory) {
    return {
      value: inMemory,
      layer: 'memory',
    }
  }

  const persisted = readPersistentCacheEntry(SEARCH_CACHE_NAMESPACE, cacheKey, {
    maxEntries: SEARCH_CACHE_MAX_ENTRIES,
  })
  if (!persisted) {
    return null
  }

  writeCache(
    SEARCH_CACHE,
    cacheKey,
    persisted.value,
    Math.max(1, persisted.expiresAt - Date.now()),
  )
  return {
    value: persisted.value,
    layer: 'persistent',
  }
}

function writeSearchCacheEntry(cacheKey, value, ttlMs) {
  writeCache(SEARCH_CACHE, cacheKey, value, ttlMs)
  writePersistentCache(SEARCH_CACHE_NAMESPACE, cacheKey, value, ttlMs, {
    maxEntries: SEARCH_CACHE_MAX_ENTRIES,
  })
}

export async function runWebSearch(args, runtime = {}) {
  runtime.throwIfAborted?.()

  const settings = runtime.settings || {}
  if (settings?.web?.search?.enabled === false) {
    throw createStructuredError('网页搜索当前已在设置中关闭。', {
      source: 'tool',
      category: 'unsupported',
      code: 'WEB_SEARCH_DISABLED',
      suggestedAction: '请在设置中重新启用 Web Research 搜索，或改用其他工具。',
    })
  }

  const rawQuery = typeof args.query === 'string' ? args.query.trim() : ''
  const normalizedQuery = normalizeWebSearchQuery(rawQuery)
  const explicitDomains = Array.isArray(args?.domains)
    ? args.domains.map(entry => normalizeDomain(entry)).filter(Boolean)
    : []
  const domains = unique([...normalizedQuery.domains, ...explicitDomains])
  const query = normalizedQuery.query
  const providerQuery = collapseWhitespace(
    [normalizedQuery.providerQuery, ...domains.filter(domain => !normalizedQuery.providerQuery.includes(domain))].join(' '),
  )

  if (!query) {
    throw createStructuredError('网页搜索失败，请先提供 query。', {
      source: 'tool',
      category: 'invalid_input',
      code: 'WEB_SEARCH_INVALID_QUERY',
      detail: 'web_search requires a non-empty query.',
      suggestedAction: '请补充更明确的搜索关键词后再试。',
    })
  }

  const configuredMaxResults = Number(settings?.web?.search?.maxResults)
  const limit = Math.max(
    1,
    Math.min(10, Number(args.limit) || (Number.isFinite(configuredMaxResults) ? configuredMaxResults : DEFAULT_SEARCH_LIMIT)),
  )
  const requestedProvider =
    typeof args?.provider === 'string' ? args.provider.trim().toLowerCase() : ''
  if (
    requestedProvider &&
    !['auto', 'tavily', 'brave', 'duckduckgo'].includes(requestedProvider)
  ) {
    throw createStructuredError('网页搜索失败，当前 provider 暂不支持。', {
      source: 'tool',
      category: 'unsupported',
      code: 'WEB_SEARCH_PROVIDER_NOT_CONFIGURED',
      detail: `Unsupported web_search provider: ${requestedProvider}`,
      suggestedAction: '请改用 provider "auto"、"tavily"、"brave" 或 "duckduckgo"。',
    })
  }
  const providerOrder = resolveWebSearchProviderOrder(settings, args.provider)
  if (providerOrder.length === 0) {
    throw createStructuredError('网页搜索失败，没有可用的搜索 provider。', {
      source: 'tool',
      category: 'unsupported',
      code: 'WEB_SEARCH_PROVIDER_NOT_CONFIGURED',
      suggestedAction: '请在设置中配置 Tavily 或 Brave，或切换到 DuckDuckGo fallback。',
    })
  }

  const startedAt = Date.now()
  runtime.onUpdate?.({
    query,
    originalQuery: rawQuery !== query ? rawQuery : undefined,
    providerQuery,
    domains,
    provider: providerOrder[0].id,
    tookMs: 0,
    total: 0,
    results: [],
  })

  const queryCandidates = generateSearchQueryCandidates(providerQuery)
  const timeoutMs = resolveSearchTimeoutMs(settings, args)
  const cacheTtlMs = resolveCacheTtlMs(settings)
  const providerAttempts = []
  let parsedResults = []
  let activeProvider = providerOrder[0].id
  let activeQuery = providerQuery
  let activeCacheLayer = 'none'
  let answer = ''
  let anyGeneralResults = false
  let generalResultDomains = []

  outer: for (const candidateQuery of queryCandidates) {
    for (const provider of providerOrder) {
      const cacheKey = normalizeCacheKey(
        JSON.stringify({
          provider: provider.id,
          query: candidateQuery,
          domains,
          freshness: args.freshness || '',
          locale: args.locale || '',
          limit,
        }),
      )
      const cached = readSearchCacheEntry(cacheKey)
      let attempt
      let cacheLayer = 'none'
      if (cached) {
        attempt = cached.value
        cacheLayer = cached.layer
      } else {
        try {
          attempt = await provider.search(
            {
              query: candidateQuery,
              domains,
              freshness: args.freshness,
              locale: args.locale,
              limit,
              timeoutMs,
            },
            runtime,
          )
          writeSearchCacheEntry(cacheKey, attempt, cacheTtlMs)
        } catch (error) {
          providerAttempts.push({
            provider: provider.id,
            providerQuery: candidateQuery,
            error: error instanceof Error ? error.message : String(error),
            rawTotal: 0,
            filteredTotal: 0,
          })
          continue
        }
      }

      const rawResults = Array.isArray(attempt?.rawResults) ? attempt.rawResults : []
      const filteredResults =
        domains.length > 0
          ? rawResults.filter(result => matchesDomain(extractHostname(result.url), domains))
          : rawResults
      const resultDomains = unique(rawResults.map(result => extractHostname(result.url)).filter(Boolean))
      providerAttempts.push({
        provider: provider.id,
        providerQuery: candidateQuery,
        rawTotal: rawResults.length,
        filteredTotal: filteredResults.length,
      })

      if (rawResults.length > 0) {
        anyGeneralResults = true
        generalResultDomains = unique([...generalResultDomains, ...resultDomains]).slice(0, 8)
      }

      if (typeof attempt?.answer === 'string' && attempt.answer.trim()) {
        answer = attempt.answer.trim()
      }

      if (filteredResults.length > 0) {
        parsedResults = filteredResults
        activeProvider = provider.id
        activeQuery = candidateQuery
        activeCacheLayer = cacheLayer
        break outer
      }

      if (rawResults.length > 0 && parsedResults.length === 0) {
        activeProvider = provider.id
        activeQuery = candidateQuery
        activeCacheLayer = cacheLayer
      }
    }
  }

  const results = rankSearchResults(parsedResults, {
    query,
    domains,
    freshness: args.freshness,
    requireFresh: args.requireFresh,
  }).slice(0, limit)

  if (results.length === 0) {
    return {
      query,
      originalQuery: rawQuery !== query ? rawQuery : undefined,
      providerQuery: activeQuery,
      domains,
      provider: activeProvider,
      attemptedProviders: providerAttempts,
      tookMs: Date.now() - startedAt,
      total: 0,
      results: [],
      noResults: true,
      code: 'WEB_SEARCH_NO_RESULTS',
      summary:
        domains.length > 0
          ? '这次搜索没有找到满足指定站点范围的结果。'
          : '这次搜索没有找到可解析的结果。',
      suggestedAction:
        domains.length > 0
          ? '可以放宽站点范围，或保留主题词后改用更自然的查询再试一次。'
          : '可以换一个更自然、更宽松的查询再试一次。',
      generalResultsAvailable: domains.length > 0 && anyGeneralResults,
      generalResultDomains: domains.length > 0 ? generalResultDomains : [],
      cache: {
        hit: activeCacheLayer !== 'none',
        layer: activeCacheLayer,
      },
    }
  }

  prefetchTopSearchResults(results, runtime)

  return {
    query,
    originalQuery: rawQuery !== query ? rawQuery : undefined,
    providerQuery: activeQuery,
    domains,
    provider: activeProvider,
    attemptedProviders: providerAttempts,
    ...(answer ? { answer } : {}),
    tookMs: Date.now() - startedAt,
    total: results.length,
    results,
    cache: {
      hit: activeCacheLayer !== 'none',
      layer: activeCacheLayer,
    },
  }
}
