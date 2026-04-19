import { createStructuredError, normalizeRuntimeError } from '../../runtimeErrors.mjs'
import { runWebFetch } from '../fetch/runtime.mjs'
import { runWebSearch } from '../search/runtime.mjs'

const DEFAULT_RESEARCH_SEARCH_LIMIT = 5
const DEFAULT_RESEARCH_FETCH_LIMIT = 3
const DEFAULT_RESEARCH_MAX_CHARS = 3_200
const DEFAULT_DEEP_RESEARCH_SEARCH_LIMIT = 8
const DEFAULT_DEEP_RESEARCH_FETCH_LIMIT = 5
const DEFAULT_DEEP_RESEARCH_MAX_CHARS = 5_200
const DEFAULT_SEARCH_CONTENT_MIN_CHARS = 1_200

function unique(values) {
  return Array.from(new Set((values || []).filter(Boolean)))
}

function collapseWhitespace(value) {
  return String(value || '')
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
}

function clipText(value, limit = 0) {
  const normalized = collapseWhitespace(value)
  if (!normalized) {
    return ''
  }
  const safeLimit = Math.max(0, Number(limit) || 0)
  if (safeLimit <= 0 || normalized.length <= safeLimit) {
    return normalized
  }
  return normalized.slice(0, safeLimit).trim()
}

function countWords(value) {
  const text = collapseWhitespace(value)
  if (!text) {
    return 0
  }
  const latinWords = text.match(/[A-Za-z0-9_]+/g) || []
  const cjkChars = text.match(/[\u3400-\u9fff]/g) || []
  return latinWords.length + cjkChars.length
}

function splitIntoSentences(value) {
  const normalized = String(value || '').replace(/\r/g, '\n').replace(/\u00a0/g, ' ')
  const matches = normalized.match(/[^。！？.!?\n]+[。！？.!?]?/gu) || []
  return matches.map(entry => collapseWhitespace(entry)).filter(Boolean)
}

function extractHostname(value) {
  try {
    return new URL(value || '').hostname.replace(/^www\./u, '').toLowerCase()
  } catch {
    return ''
  }
}

function clampInteger(value, fallback, min, max) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) {
    return fallback
  }
  return Math.max(min, Math.min(max, Math.round(numeric)))
}

function recommendedUseForCategory(category = '') {
  if (category === 'docs' || category === 'public-sector') {
    return 'primary-reference'
  }
  if (category === 'major-news') {
    return 'current-reporting'
  }
  if (category === 'community') {
    return 'secondary-context'
  }
  return 'supporting-reference'
}

function inferFreshnessLabel(publishedAt, freshnessScore = 0) {
  if (typeof publishedAt === 'string' && publishedAt.trim()) {
    const parsed = new Date(publishedAt)
    if (Number.isFinite(parsed.getTime())) {
      const ageDays = Math.max(0, Math.round((Date.now() - parsed.getTime()) / 86_400_000))
      if (ageDays <= 30) {
        return 'fresh'
      }
      if (ageDays <= 180) {
        return 'recent'
      }
      if (ageDays <= 730) {
        return 'aging'
      }
      return 'old'
    }
  }

  if (freshnessScore >= 78) {
    return 'fresh'
  }
  if (freshnessScore >= 62) {
    return 'recent'
  }
  if (freshnessScore > 0) {
    return 'undated'
  }
  return 'undated'
}

function buildSearchContentKeyPoints(content) {
  return splitIntoSentences(content).slice(0, 3)
}

function buildSearchSourceAssessment(item, content) {
  return {
    category: typeof item?.domainCategory === 'string' ? item.domainCategory : 'general-web',
    freshness: inferFreshnessLabel(item?.publishedAt, Number(item?.freshnessScore) || 0),
    recommendedUse: recommendedUseForCategory(
      typeof item?.domainCategory === 'string' ? item.domainCategory : '',
    ),
    qualityScore:
      typeof item?.sourceQualityScore === 'number'
        ? Math.round(item.sourceQualityScore)
        : undefined,
    hasAuthor: false,
    hasPublishedAt: Boolean(item?.publishedAt),
    wordCount: countWords(content),
  }
}

function buildSearchRiskFlags(item, content) {
  const category = typeof item?.domainCategory === 'string' ? item.domainCategory : ''
  const flags = []
  if (category === 'community') {
    flags.push('community-source')
  }
  if (category === 'low-signal') {
    flags.push('low-signal-source')
  }
  if (!item?.publishedAt) {
    flags.push('undated-source')
  }
  if (inferFreshnessLabel(item?.publishedAt, Number(item?.freshnessScore) || 0) === 'old') {
    flags.push('older-source')
  }
  if (collapseWhitespace(content).length < 280) {
    flags.push('thin-content')
  }
  return unique(flags)
}

function resolveResearchSettings(settings = {}, runtime = {}, args = {}) {
  const researchSettings = settings?.web?.research || {}
  const fetchCap = clampInteger(
    settings?.web?.fetch?.maxCharsCap,
    20_000,
    500,
    20_000,
  )
  const runtimeDepth =
    runtime?.researchMode === 'deep' || args?.depth === 'deep' ? 'deep' : 'auto'
  const deep = runtimeDepth === 'deep'

  const defaultSearchLimit = clampInteger(
    researchSettings.defaultSearchLimit,
    DEFAULT_RESEARCH_SEARCH_LIMIT,
    1,
    10,
  )
  const defaultFetchLimit = clampInteger(
    researchSettings.defaultFetchLimit,
    DEFAULT_RESEARCH_FETCH_LIMIT,
    1,
    6,
  )
  const defaultMaxChars = clampInteger(
    researchSettings.defaultMaxChars,
    DEFAULT_RESEARCH_MAX_CHARS,
    500,
    fetchCap,
  )
  const deepSearchLimit = clampInteger(
    researchSettings.deepSearchLimit,
    DEFAULT_DEEP_RESEARCH_SEARCH_LIMIT,
    2,
    10,
  )
  const deepFetchLimit = clampInteger(
    researchSettings.deepFetchLimit,
    DEFAULT_DEEP_RESEARCH_FETCH_LIMIT,
    1,
    6,
  )
  const deepMaxChars = clampInteger(
    researchSettings.deepMaxChars,
    DEFAULT_DEEP_RESEARCH_MAX_CHARS,
    800,
    fetchCap,
  )

  return {
    enabled: researchSettings.enabled !== false,
    depth: runtimeDepth,
    searchLimit: clampInteger(
      args.searchLimit,
      deep ? deepSearchLimit : defaultSearchLimit,
      1,
      10,
    ),
    fetchLimit: clampInteger(
      args.fetchLimit,
      deep ? deepFetchLimit : defaultFetchLimit,
      1,
      6,
    ),
    maxChars: clampInteger(
      args.maxChars,
      deep ? deepMaxChars : defaultMaxChars,
      500,
      fetchCap,
    ),
    preferSearchContent:
      typeof args.preferSearchContent === 'boolean'
        ? args.preferSearchContent
        : researchSettings.preferSearchContent !== false,
    searchContentMinChars: clampInteger(
      researchSettings.searchContentMinChars,
      DEFAULT_SEARCH_CONTENT_MIN_CHARS,
      200,
      8_000,
    ),
    allowBrowserFallback:
      (typeof args.allowBrowserFallback === 'boolean'
        ? args.allowBrowserFallback
        : researchSettings.allowBrowserFallback === true) &&
      settings?.browser?.enabled !== false,
  }
}

function selectResearchCandidates(results, fetchLimit, depth = 'auto') {
  const source = Array.isArray(results) ? results : []
  if (source.length <= fetchLimit) {
    return source.slice()
  }

  const selected = []
  const seenDomains = new Set()
  const preferDiversity = depth === 'deep'

  for (const result of source) {
    const hostname = extractHostname(result?.url || '')
    if (!preferDiversity || !hostname || seenDomains.has(hostname)) {
      continue
    }
    selected.push(result)
    seenDomains.add(hostname)
    if (selected.length >= fetchLimit) {
      return selected
    }
  }

  for (const result of source) {
    if (selected.includes(result)) {
      continue
    }
    const hostname = extractHostname(result?.url || '')
    if (hostname) {
      seenDomains.add(hostname)
    }
    selected.push(result)
    if (selected.length >= fetchLimit) {
      break
    }
  }

  return selected
}

function hasUsableProviderContent(item, minimumChars = 0) {
  const content = collapseWhitespace(item?.content)
  return content.length >= Math.max(1, minimumChars)
}

function buildProviderContentResult(item, citationIndex, maxChars, status = 'provider_content') {
  const providerContent = clipText(item?.content || item?.snippet, maxChars)
  const sourceAssessment = buildSearchSourceAssessment(item, providerContent)
  return {
    ...item,
    excerpt: clipText(item?.snippet || providerContent, 320) || undefined,
    summary: providerContent || item?.snippet || '',
    content: providerContent,
    fullContent: providerContent,
    contentFormat: 'text',
    publishedAt: item?.publishedAt,
    author: undefined,
    wordCount: countWords(providerContent),
    sourceAssessment,
    riskFlags: buildSearchRiskFlags(item, providerContent),
    keyPoints: buildSearchContentKeyPoints(providerContent),
    evidenceBlocks: [],
    fetchedAt: new Date().toISOString(),
    citationIndex,
    contentOrigin: 'search-provider',
    providerContentUsed: true,
    status,
  }
}

async function buildFetchedResult(item, citationIndex, maxChars, runtime, args) {
  const fetchResult = await runWebFetch(
    {
      url: item.url,
      mode: args.fetchMode || 'article',
      maxChars,
    },
    runtime,
  )

  return {
    ...item,
    ...fetchResult,
    summary: fetchResult.content || item.snippet || '',
    fullContent: fetchResult.content,
    fetchedAt: new Date().toISOString(),
    citationIndex,
    contentOrigin: 'web_fetch',
    providerContentUsed: false,
    status: 'success',
  }
}

function buildFetchErrorResult(item, citationIndex, error) {
  const normalized = normalizeRuntimeError(error, {
    source: 'tool',
    operationLabel: '网页抓取',
  })

  return {
    ...item,
    excerpt: clipText(item?.snippet || '', 320) || undefined,
    summary: item?.snippet || '',
    citationIndex,
    status: 'error',
    error: normalized.message,
    errorInfo: normalized.errorInfo,
    browserFallbackSuggested:
      normalized.errorInfo?.code === 'WEB_FETCH_PAGE_REQUIRES_BROWSER',
  }
}

function buildBrowserFallbackPayload({
  allowBrowserFallback,
  query,
  successfulResults,
  blockedResults,
  noResults,
}) {
  if (!allowBrowserFallback) {
    return {}
  }

  if (noResults) {
    return {
      browserFallbackSuggested: true,
      requireBrowserInteraction: true,
      browserFallbackStrategy: 'browser_search',
      browserFallbackReason: 'web-search-no-results',
      browserFallbackQuery: query,
    }
  }

  if (blockedResults.length > 0 && successfulResults.length === 0) {
    return {
      browserFallbackSuggested: true,
      requireBrowserInteraction: true,
      browserFallbackStrategy: 'browser_open',
      browserFallbackReason: 'page-requires-browser',
      browserFallbackTargets: blockedResults
        .map(result => result?.url)
        .filter(Boolean)
        .slice(0, 3),
    }
  }

  return {}
}

export async function runWebResearch(args, runtime = {}) {
  runtime.throwIfAborted?.()

  const settings = runtime.settings || {}
  const resolved = resolveResearchSettings(settings, runtime, args)
  if (resolved.enabled === false) {
    throw createStructuredError('网页深度调研当前已在设置中关闭。', {
      source: 'tool',
      category: 'unsupported',
      code: 'WEB_RESEARCH_DISABLED',
      suggestedAction: '请在设置中重新启用 Web Research，或改用 web_search / web_fetch。',
    })
  }

  const startedAt = Date.now()
  const searchResult = await runWebSearch(
    {
      ...args,
      limit: resolved.searchLimit,
    },
    runtime,
  )

  if (!Array.isArray(searchResult.results) || searchResult.results.length === 0) {
    return {
      ...searchResult,
      depth: resolved.depth,
      searchLimit: resolved.searchLimit,
      fetchLimit: resolved.fetchLimit,
      maxChars: resolved.maxChars,
      fetchedTotal: 0,
      usedSearchContentTotal: 0,
      successfulTotal: 0,
      errorTotal: 0,
      sourceDiversity: 0,
      tookMs: Date.now() - startedAt,
      ...buildBrowserFallbackPayload({
        allowBrowserFallback: resolved.allowBrowserFallback,
        query: searchResult.query,
        successfulResults: [],
        blockedResults: [],
        noResults: true,
      }),
    }
  }

  const selectedCandidates = selectResearchCandidates(
    searchResult.results,
    resolved.fetchLimit,
    resolved.depth,
  )
  const selectedUrls = new Set(selectedCandidates.map(item => item.url))
  const remainingItems = searchResult.results.filter(item => !selectedUrls.has(item.url))

  const researchedResults = await Promise.all(
    selectedCandidates.map(async (item, index) => {
      if (
        resolved.preferSearchContent &&
        hasUsableProviderContent(item, resolved.searchContentMinChars)
      ) {
        return buildProviderContentResult(item, index + 1, resolved.maxChars)
      }

      try {
        return await buildFetchedResult(item, index + 1, resolved.maxChars, runtime, args)
      } catch (error) {
        if (resolved.preferSearchContent && hasUsableProviderContent(item, 400)) {
          const fallback = buildProviderContentResult(
            item,
            index + 1,
            resolved.maxChars,
            'provider_content_fallback',
          )
          const normalized = normalizeRuntimeError(error, {
            source: 'tool',
            operationLabel: '网页抓取',
          })
          return {
            ...fallback,
            fetchError: normalized.message,
            fetchErrorInfo: normalized.errorInfo,
            providerContentUsed: true,
          }
        }

        return buildFetchErrorResult(item, index + 1, error)
      }
    }),
  )

  const results = [
    ...researchedResults,
    ...remainingItems.map((item, index) => ({
      ...item,
      citationIndex: researchedResults.length + index + 1,
      status: 'not_fetched',
    })),
  ]

  const successfulResults = researchedResults.filter(result => {
    const status = typeof result?.status === 'string' ? result.status : ''
    return status === 'success' || status.startsWith('provider_content')
  })
  const blockedResults = researchedResults.filter(
    result => result?.errorInfo?.code === 'WEB_FETCH_PAGE_REQUIRES_BROWSER',
  )
  const usedSearchContentTotal = researchedResults.filter(result => result?.providerContentUsed === true).length
  const sourceDiversity = unique(results.map(result => extractHostname(result?.url || ''))).length

  return {
    query: searchResult.query,
    originalQuery: searchResult.originalQuery,
    providerQuery: searchResult.providerQuery,
    domains: searchResult.domains,
    provider: searchResult.provider,
    attemptedProviders: searchResult.attemptedProviders,
    ...(searchResult.answer ? { answer: searchResult.answer } : {}),
    depth: resolved.depth,
    searchLimit: resolved.searchLimit,
    fetchLimit: resolved.fetchLimit,
    maxChars: resolved.maxChars,
    fetchedTotal: researchedResults.filter(result => result?.status === 'success').length,
    usedSearchContentTotal,
    successfulTotal: successfulResults.length,
    errorTotal: researchedResults.filter(result => result?.status === 'error').length,
    sourceDiversity,
    results,
    total: results.length,
    tookMs: Date.now() - startedAt,
    ...buildBrowserFallbackPayload({
      allowBrowserFallback: resolved.allowBrowserFallback,
      query: searchResult.query,
      successfulResults,
      blockedResults,
      noResults: false,
    }),
  }
}
