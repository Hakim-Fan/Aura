import { createStructuredError } from '../../runtimeErrors.mjs'
import {
  getLightpandaProviderId,
  isLightpandaEnabled,
  runLightpandaFetch,
} from '../../lightpandaRuntime.mjs'
import { guardedFetch, readResponseText } from '../net/guardedFetch.mjs'
import { normalizeCacheKey, readCache, writeCache } from '../shared/cache.mjs'
import {
  readPersistentCacheEntry,
  writePersistentCache,
} from '../shared/persistentCache.mjs'
import {
  clipText,
  collapseWhitespace,
  detectJsDependentPage,
  extractAuthor,
  extractBasicHtmlContent,
  extractMetaContent,
  extractTime,
  extractTitle,
  looksLikeBrowserOnlyPage,
  stripTags,
} from './extraction/basicHtml.mjs'
import { buildCloudFetchCacheHint } from './providers/cloudAccess.mjs'
import {
  createJinaFetchProvider,
  getJinaProviderAvailability,
  rememberJinaFailure,
  resolveJinaProviderAccess,
} from './providers/jina.mjs'
import { extractReadableContent } from './extraction/readability.mjs'
import {
  getWebFetchProviderAvailability,
  rememberWebFetchProviderFailure,
  rememberWebFetchProviderSuccess,
  resolveWebFetchProviderHealthScore,
} from './providerRegistry.mjs'

const DEFAULT_FETCH_TIMEOUT_MS = 15_000
const DEFAULT_FETCH_MAX_CHARS = 20_000
const DEFAULT_FETCH_MAX_RESPONSE_BYTES = 750_000
const DEFAULT_FETCH_MAX_REDIRECTS = 3
const FETCH_CACHE = new Map()
const FETCH_CACHE_NAMESPACE = 'fetch'
const FETCH_CACHE_MAX_ENTRIES = 384
const JINA_FETCH_PROVIDER = createJinaFetchProvider()

function unique(values) {
  return Array.from(new Set((values || []).filter(Boolean)))
}

function normalizeDomain(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/.*$/, '')
    .replace(/^\.+|\.+$/g, '')
}

function extractHostname(targetUrl) {
  try {
    return new URL(targetUrl).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}

function tokenizeSearchTerms(value) {
  const normalized = collapseWhitespace(String(value || '').toLowerCase())
  if (!normalized) {
    return []
  }
  return unique(normalized.match(/[a-z0-9]{2,}|[\u4e00-\u9fff]{2,}/gu) || [])
}

function normalizeComparableSentence(value) {
  return collapseWhitespace(String(value || '').toLowerCase())
    .replace(/[`"'“”‘’()[\]{}]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function splitIntoSentences(value) {
  const normalized = String(value || '').replace(/\r/g, '\n').replace(/\u00a0/g, ' ')
  const matches = normalized.match(/[^。！？.!?\n]+[。！？.!?]?/gu) || []
  return matches.map(entry => collapseWhitespace(entry)).filter(Boolean)
}

function looksLikeLowValueSentence(value) {
  const normalized = normalizeComparableSentence(value)
  if (!normalized || normalized.length < 24) {
    return true
  }
  return [
    'cookie',
    'privacy',
    'subscribe',
    'sign in',
    'log in',
    'javascript',
    '版权所有',
    '隐私',
    '登录',
    '注册',
    '订阅',
    '返回顶部',
  ].some(pattern => normalized.includes(pattern))
}

function clampScore(value) {
  if (!Number.isFinite(value)) {
    return 0
  }
  return Math.max(0, Math.min(1, value))
}

function scoreEvidenceSentence(sentence, keywords = []) {
  const normalized = collapseWhitespace(sentence)
  const comparable = normalizeComparableSentence(normalized)
  const matchedKeywords = (keywords || []).filter(keyword => comparable.includes(keyword))
  const keywordCoverage = keywords.length > 0 ? matchedKeywords.length / keywords.length : 0.45
  const hasNumber = /\b\d[\d,.:%-]*\b|(?:20\d{2}|19\d{2})|[一二三四五六七八九十百千万亿]+/u.test(normalized)
  const hasAttribution = /\b(?:said|announced|reported|according to)\b|表示|称|宣布|根据/u.test(normalized)
  const lengthScore =
    normalized.length >= 60 && normalized.length <= 220
      ? 1
      : normalized.length >= 36 && normalized.length <= 280
        ? 0.78
        : 0.46

  return {
    score: clampScore(keywordCoverage * 0.45 + lengthScore * 0.3 + (hasNumber ? 0.15 : 0) + (hasAttribution ? 0.1 : 0)),
    matchedKeywords,
  }
}

function inferEvidenceKind(sentence) {
  const normalized = collapseWhitespace(sentence)
  if (/\b\d[\d,.:%-]*\b|(?:20\d{2}|19\d{2})|增长|下降|同比|环比|million|billion|percent|%/u.test(normalized)) {
    return 'quantitative'
  }
  if (/\b(?:said|announced|reported|confirmed|according to)\b|表示|称|宣布|指出|根据/u.test(normalized)) {
    return 'attributed'
  }
  if (/\b(?:will|plans to|expected to|guidance|forecast)\b|将|计划|预计|目标|指引/u.test(normalized)) {
    return 'forward-looking'
  }
  return 'descriptive'
}

function buildEvidenceBlocks({ title, excerpt, content }) {
  const keywords = tokenizeSearchTerms([title, excerpt].filter(Boolean).join(' '))
  const seen = new Set()
  const candidates = splitIntoSentences(content)
    .filter(sentence => !looksLikeLowValueSentence(sentence))
    .map(sentence => {
      const comparable = normalizeComparableSentence(sentence)
      if (!comparable || seen.has(comparable)) {
        return null
      }
      seen.add(comparable)
      const evidenceScore = scoreEvidenceSentence(sentence, keywords)
      return {
        sentence: clipText(sentence, 280),
        kind: inferEvidenceKind(sentence),
        evidenceScore: Math.round(evidenceScore.score * 100),
        matchedKeywords: evidenceScore.matchedKeywords.slice(0, 5),
      }
    })
    .filter(Boolean)
    .sort((left, right) => right.evidenceScore - left.evidenceScore)

  return candidates.slice(0, 4).map((entry, index) => ({
    id: `evidence-${index + 1}`,
    claim: entry.sentence,
    supportingQuote: entry.sentence,
    kind: entry.kind,
    evidenceScore: entry.evidenceScore,
    matchedKeywords: entry.matchedKeywords,
  }))
}

function classifySearchResultDomain(hostname, url = '') {
  const normalizedHostname = normalizeDomain(hostname)
  const normalizedUrl = String(url || '').toLowerCase()
  const isDocsHost =
    /^docs\./.test(normalizedHostname) ||
    /^developer\./.test(normalizedHostname) ||
    /\/(?:docs?|documentation|reference|api)(?:\/|$)/u.test(normalizedUrl)
  const isPublicSector = /\.gov$/.test(normalizedHostname) || /\.edu$/.test(normalizedHostname)
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
  const communityHosts = [
    'reddit.com',
    'news.ycombinator.com',
    'stackoverflow.com',
    'stackexchange.com',
    'medium.com',
    'dev.to',
    'zhihu.com',
    'juejin.cn',
  ]
  const lowSignalHosts = ['pinterest.com', 'facebook.com', 'instagram.com', 'tiktok.com', 'quora.com']

  if (isPublicSector) {
    return { category: 'public-sector', quality: 0.92 }
  }
  if (isDocsHost) {
    return { category: 'docs', quality: 0.9 }
  }
  if (majorNewsHosts.some(domain => normalizedHostname === domain || normalizedHostname.endsWith(`.${domain}`))) {
    return { category: 'major-news', quality: 0.82 }
  }
  if (communityHosts.some(domain => normalizedHostname === domain || normalizedHostname.endsWith(`.${domain}`))) {
    return { category: 'community', quality: 0.64 }
  }
  if (lowSignalHosts.some(domain => normalizedHostname === domain || normalizedHostname.endsWith(`.${domain}`))) {
    return { category: 'low-signal', quality: 0.34 }
  }
  return { category: 'general-web', quality: 0.58 }
}

function buildSourceAssessment({ site, url, author, publishedAt, wordCount }) {
  const domainMeta = classifySearchResultDomain(site || extractHostname(url || ''), url || '')
  const parsedDate = publishedAt ? new Date(publishedAt) : null
  const validDate = parsedDate instanceof Date && Number.isFinite(parsedDate.getTime()) ? parsedDate : null
  const ageDays = validDate ? Math.max(0, Math.round((Date.now() - validDate.getTime()) / 86_400_000)) : null
  const freshnessLabel =
    ageDays === null ? 'undated' : ageDays <= 30 ? 'fresh' : ageDays <= 180 ? 'recent' : ageDays <= 730 ? 'aging' : 'old'
  const recommendedUse =
    domainMeta.category === 'docs' || domainMeta.category === 'public-sector'
      ? 'primary-reference'
      : domainMeta.category === 'major-news'
        ? 'current-reporting'
        : domainMeta.category === 'community'
          ? 'secondary-context'
          : 'supporting-reference'

  return {
    category: domainMeta.category,
    freshness: freshnessLabel,
    recommendedUse,
    qualityScore: Math.round(domainMeta.quality * 100),
    hasAuthor: Boolean(author),
    hasPublishedAt: Boolean(publishedAt),
    wordCount: Number.isFinite(wordCount) ? wordCount : 0,
  }
}

function buildRiskFlags({ sourceAssessment, publishedAt, evidenceBlocks, content, excerpt }) {
  const flags = []
  if (sourceAssessment?.category === 'community') {
    flags.push('community-source')
  }
  if (sourceAssessment?.category === 'low-signal') {
    flags.push('low-signal-source')
  }
  if (!publishedAt) {
    flags.push('undated-source')
  }
  if (sourceAssessment?.freshness === 'old') {
    flags.push('older-source')
  }
  if ((Array.isArray(evidenceBlocks) ? evidenceBlocks.length : 0) === 0) {
    flags.push('weak-extractable-evidence')
  }
  const effectiveText = collapseWhitespace(content || excerpt)
  if (effectiveText && effectiveText.length < 280) {
    flags.push('thin-content')
  }
  return unique(flags)
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

function isSupportedFetchContentType(contentType) {
  const normalized = String(contentType || '').toLowerCase()
  return (
    normalized.includes('text/html') ||
    normalized.includes('application/xhtml+xml') ||
    normalized.includes('text/plain') ||
    normalized.includes('text/markdown')
  )
}

function ensureSupportedFetchContentType(contentType) {
  if (isSupportedFetchContentType(contentType)) {
    return
  }
  throw createStructuredError('网页抓取失败，当前内容类型不适合直接读取正文。', {
    source: 'tool',
    category: 'unsupported',
    code: 'WEB_FETCH_UNSUPPORTED_CONTENT',
    detail: `Unsupported content-type: ${contentType || 'unknown'}`,
    suggestedAction: '请改抓取 HTML / 文本页面；如果目标资源必须人工处理，请显式要求打开系统浏览器。',
  })
}

function buildFetchPayload({ url, finalUrl, provider, html, textContent, mode, maxChars, readabilityResult }) {
  const site = extractHostname(finalUrl || url) || undefined
  const title = readabilityResult?.title || extractTitle(html) || site || url
  const description =
    readabilityResult?.excerpt ||
    extractMetaContent(html, ['description', 'og:description', 'twitter:description']) ||
    ''
  const publishedAt = extractTime(html) || undefined
  const author = readabilityResult?.byline || extractAuthor(html) || undefined
  const excerptSource = description || textContent
  const excerpt = clipText(excerptSource, 320) || undefined

  if (mode === 'metadata') {
    const sourceAssessment = buildSourceAssessment({
      site,
      url: finalUrl || url,
      author,
      publishedAt,
      wordCount: 0,
    })
    return {
      url,
      finalUrl,
      provider,
      title,
      site,
      excerpt,
      contentFormat: 'metadata',
      publishedAt,
      author,
      sourceAssessment,
      riskFlags: buildRiskFlags({
        sourceAssessment,
        publishedAt,
        evidenceBlocks: [],
        content: '',
        excerpt,
      }),
      evidenceBlocks: [],
      tookMs: 0,
    }
  }

  const contentLimit = Math.max(400, Math.min(20_000, Number(maxChars) || DEFAULT_FETCH_MAX_CHARS))
  const content =
    mode === 'summary'
      ? clipText(excerptSource, Math.min(contentLimit, 1_200))
      : clipText(textContent, contentLimit)
  const wordCount = countWords(content)
  const evidenceBlocks = buildEvidenceBlocks({ title, excerpt, content })
  const sourceAssessment = buildSourceAssessment({
    site,
    url: finalUrl || url,
    author,
    publishedAt,
    wordCount,
  })
  const riskFlags = buildRiskFlags({
    sourceAssessment,
    publishedAt,
    evidenceBlocks,
    content,
    excerpt,
  })

  return {
    url,
    finalUrl,
    provider,
    title,
    site,
    excerpt,
    content,
    contentFormat: mode === 'summary' ? 'text' : 'markdown',
    publishedAt,
    author,
    wordCount,
    sourceAssessment,
    riskFlags,
    keyPoints: evidenceBlocks.map(entry => entry.claim).slice(0, 3),
    evidenceBlocks,
    tookMs: 0,
  }
}

function buildJinaFetchPayload({ url, finalUrl, mode, maxChars, markdown, plain, title }) {
  const site = extractHostname(finalUrl || url) || undefined
  const effectiveTitle = title || site || url
  const excerptSource = collapseWhitespace(plain || markdown)
  const excerpt = clipText(excerptSource, 320) || undefined

  if (mode === 'metadata') {
    const sourceAssessment = buildSourceAssessment({
      site,
      url: finalUrl || url,
      author: undefined,
      publishedAt: undefined,
      wordCount: 0,
    })
    return {
      url,
      finalUrl,
      provider: JINA_FETCH_PROVIDER.id,
      title: effectiveTitle,
      site,
      excerpt,
      contentFormat: 'metadata',
      publishedAt: undefined,
      author: undefined,
      sourceAssessment,
      riskFlags: buildRiskFlags({
        sourceAssessment,
        publishedAt: undefined,
        evidenceBlocks: [],
        content: '',
        excerpt,
      }),
      evidenceBlocks: [],
      tookMs: 0,
    }
  }

  const contentLimit = Math.max(400, Math.min(20_000, Number(maxChars) || DEFAULT_FETCH_MAX_CHARS))
  const content =
    mode === 'summary'
      ? clipText(excerptSource, Math.min(contentLimit, 1_200))
      : clipText(markdown || plain, contentLimit)
  const wordCount = countWords(content)
  const evidenceBlocks = buildEvidenceBlocks({
    title: effectiveTitle,
    excerpt,
    content: plain || content,
  })
  const sourceAssessment = buildSourceAssessment({
    site,
    url: finalUrl || url,
    author: undefined,
    publishedAt: undefined,
    wordCount,
  })
  const riskFlags = buildRiskFlags({
    sourceAssessment,
    publishedAt: undefined,
    evidenceBlocks,
    content: plain || content,
    excerpt,
  })

  return {
    url,
    finalUrl,
    provider: JINA_FETCH_PROVIDER.id,
    title: effectiveTitle,
    site,
    excerpt,
    content,
    contentFormat: mode === 'summary' ? 'text' : 'markdown',
    publishedAt: undefined,
    author: undefined,
    wordCount,
    sourceAssessment,
    riskFlags,
    keyPoints: evidenceBlocks.map(entry => entry.claim).slice(0, 3),
    evidenceBlocks,
    tookMs: 0,
  }
}

function buildLightpandaFetchPayload({ url, finalUrl, mode, maxChars, markdown, plain, title }) {
  const site = extractHostname(finalUrl || url) || undefined
  const effectiveTitle = title || site || url
  const excerptSource = collapseWhitespace(plain || markdown)
  const excerpt = clipText(excerptSource, 320) || undefined
  const providerId = getLightpandaProviderId()

  if (mode === 'metadata') {
    const sourceAssessment = buildSourceAssessment({
      site,
      url: finalUrl || url,
      author: undefined,
      publishedAt: undefined,
      wordCount: 0,
    })
    return {
      url,
      finalUrl,
      provider: providerId,
      title: effectiveTitle,
      site,
      excerpt,
      contentFormat: 'metadata',
      publishedAt: undefined,
      author: undefined,
      sourceAssessment,
      riskFlags: buildRiskFlags({
        sourceAssessment,
        publishedAt: undefined,
        evidenceBlocks: [],
        content: '',
        excerpt,
      }),
      evidenceBlocks: [],
      tookMs: 0,
    }
  }

  const contentLimit = Math.max(400, Math.min(20_000, Number(maxChars) || DEFAULT_FETCH_MAX_CHARS))
  const content =
    mode === 'summary'
      ? clipText(excerptSource, Math.min(contentLimit, 1_200))
      : clipText(markdown || plain, contentLimit)
  const wordCount = countWords(content)
  const evidenceBlocks = buildEvidenceBlocks({
    title: effectiveTitle,
    excerpt,
    content: plain || content,
  })
  const sourceAssessment = buildSourceAssessment({
    site,
    url: finalUrl || url,
    author: undefined,
    publishedAt: undefined,
    wordCount,
  })
  const riskFlags = buildRiskFlags({
    sourceAssessment,
    publishedAt: undefined,
    evidenceBlocks,
    content: plain || content,
    excerpt,
  })

  return {
    url,
    finalUrl,
    provider: providerId,
    title: effectiveTitle,
    site,
    excerpt,
    content,
    contentFormat: mode === 'summary' ? 'text' : 'markdown',
    publishedAt: undefined,
    author: undefined,
    wordCount,
    sourceAssessment,
    riskFlags,
    keyPoints: evidenceBlocks.map(entry => entry.claim).slice(0, 3),
    evidenceBlocks,
    tookMs: 0,
  }
}

function resolveFetchSettings(settings) {
  const fetchSettings = settings?.web?.fetch || {}
  return {
    enabled: fetchSettings.enabled !== false,
    provider: fetchSettings.provider || 'auto',
    timeoutMs: Math.max(1000, Math.round((Number(fetchSettings.timeoutSeconds) || 15) * 1000)),
    maxCharsCap: Math.max(400, Number(fetchSettings.maxCharsCap) || DEFAULT_FETCH_MAX_CHARS),
    maxResponseBytes: Math.max(32_000, Number(fetchSettings.maxResponseBytes) || DEFAULT_FETCH_MAX_RESPONSE_BYTES),
    maxRedirects: Math.max(0, Number(fetchSettings.maxRedirects) || DEFAULT_FETCH_MAX_REDIRECTS),
    readability: fetchSettings.readability !== false,
  }
}

function resolveFetchCacheTtlMs(settings) {
  const minutes = Number(settings?.web?.search?.cacheTtlMinutes)
  return Math.max(0, Number.isFinite(minutes) ? Math.round(minutes * 60_000) : 30 * 60_000)
}

function readFetchCacheEntry(cacheKey) {
  const inMemory = readCache(FETCH_CACHE, cacheKey)
  if (inMemory) {
    return {
      value: inMemory,
      layer: 'memory',
    }
  }

  const persisted = readPersistentCacheEntry(FETCH_CACHE_NAMESPACE, cacheKey, {
    maxEntries: FETCH_CACHE_MAX_ENTRIES,
  })
  if (!persisted) {
    return null
  }

  writeCache(
    FETCH_CACHE,
    cacheKey,
    persisted.value,
    Math.max(1, persisted.expiresAt - Date.now()),
  )
  return {
    value: persisted.value,
    layer: 'persistent',
  }
}

function writeFetchCacheEntry(cacheKey, value, ttlMs) {
  writeCache(FETCH_CACHE, cacheKey, value, ttlMs)
  writePersistentCache(FETCH_CACHE_NAMESPACE, cacheKey, value, ttlMs, {
    maxEntries: FETCH_CACHE_MAX_ENTRIES,
  })
}

function recordFetchProviderAttempt(attemptedProviders, entry = {}) {
  if (!Array.isArray(attemptedProviders)) {
    return
  }

  attemptedProviders.push({
    provider:
      typeof entry.provider === 'string' && entry.provider.trim()
        ? entry.provider.trim()
        : 'unknown',
    reason: typeof entry.reason === 'string' ? entry.reason : '',
    status: typeof entry.status === 'string' ? entry.status : 'attempted',
    blocked: entry.blocked === true,
    cacheHit: entry.cacheHit === true,
    source: typeof entry.source === 'string' ? entry.source : '',
    error: typeof entry.error === 'string' ? entry.error : '',
  })
}

function attachFetchResultMeta(result, attemptedProviders, cache = null) {
  return {
    ...result,
    attemptedProviders:
      Array.isArray(attemptedProviders) && attemptedProviders.length > 0
        ? attemptedProviders.map(entry => ({ ...entry }))
        : undefined,
    ...(cache ? { cache } : {}),
  }
}

function resolveFetchFallbackCandidates(runtime = {}, settings = {}, reason = '') {
  const lightpandaId = getLightpandaProviderId()
  const lightpandaAvailability = getWebFetchProviderAvailability(runtime, lightpandaId, {
    enabled: isLightpandaEnabled(settings),
  })
  const jinaAvailability = getJinaProviderAvailability(runtime, settings)
  const preferredOrder =
    reason === 'unsupported-content'
      ? {
        [JINA_FETCH_PROVIDER.id]: 0,
        [lightpandaId]: 1,
      }
      : {
        [lightpandaId]: 0,
        [JINA_FETCH_PROVIDER.id]: 1,
      }

  return [
    {
      id: lightpandaId,
      kind: 'lightpanda',
      label: 'Lightpanda',
      availability: lightpandaAvailability,
    },
    {
      id: JINA_FETCH_PROVIDER.id,
      kind: 'jina',
      label: JINA_FETCH_PROVIDER.name,
      availability: jinaAvailability,
    },
  ].sort((left, right) => {
    if (left.availability.usable !== right.availability.usable) {
      return left.availability.usable ? -1 : 1
    }
    const now = Date.now()
    const scoreDelta =
      resolveWebFetchProviderHealthScore(right.availability, now) -
      resolveWebFetchProviderHealthScore(left.availability, now)
    if (scoreDelta !== 0) {
      return scoreDelta
    }
    return (preferredOrder[left.id] ?? 99) - (preferredOrder[right.id] ?? 99)
  })
}

async function tryLightpandaFallback({
  normalizedUrl,
  finalUrl,
  mode,
  maxChars,
  startedAt,
  cacheKey,
  cacheTtlMs,
  runtime,
  reason = '',
  attemptedProviders,
  availability = null,
}) {
  const providerId = getLightpandaProviderId()
  const resolvedAvailability =
    availability ||
    getWebFetchProviderAvailability(runtime, providerId, {
      enabled: isLightpandaEnabled(runtime.settings || {}),
    })
  if (!resolvedAvailability.usable) {
    recordFetchProviderAttempt(attemptedProviders, {
      provider: providerId,
      reason,
      status: resolvedAvailability.blocked ? 'blocked' : 'disabled',
      blocked: resolvedAvailability.blocked,
      source: resolvedAvailability.source || '',
      error:
        resolvedAvailability.entry?.code ||
        (resolvedAvailability.blocked
          ? 'WEB_FETCH_PROVIDER_BLOCKED'
          : 'WEB_FETCH_PROVIDER_NOT_CONFIGURED'),
    })
    return {
      result: null,
      error: null,
      skipped: true,
      blocked: resolvedAvailability.blocked,
    }
  }

  try {
    const lightpandaResult = await runLightpandaFetch(
      {
        url: finalUrl,
        mode,
      },
      runtime,
    )
    const result = {
      ...buildLightpandaFetchPayload({
        url: normalizedUrl,
        finalUrl,
        mode,
        maxChars,
        markdown: lightpandaResult.markdown,
        plain: lightpandaResult.plain,
        title: lightpandaResult.title,
      }),
      tookMs: Date.now() - startedAt,
    }
    writeFetchCacheEntry(cacheKey, result, cacheTtlMs)
    rememberWebFetchProviderSuccess(runtime, providerId)
    recordFetchProviderAttempt(attemptedProviders, {
      provider: providerId,
      reason,
      status: 'success',
    })
    return {
      result: attachFetchResultMeta(result, attemptedProviders, {
        hit: false,
        layer: 'miss',
      }),
      error: null,
    }
  } catch (error) {
    rememberWebFetchProviderFailure(runtime, providerId, error)
    recordFetchProviderAttempt(attemptedProviders, {
      provider: providerId,
      reason,
      status: 'error',
      error: summarizeFetchFallbackError(error, 'Lightpanda 未能返回可用内容。'),
    })
    return {
      result: null,
      error,
    }
  }
}

async function tryJinaFallback({
  normalizedUrl,
  finalUrl,
  mode,
  maxChars,
  title,
  startedAt,
  cacheKey,
  cacheTtlMs,
  runtime,
  fetchSettings,
  reason = '',
  attemptedProviders,
  availability = null,
}) {
  const resolvedAvailability =
    availability || getJinaProviderAvailability(runtime, runtime.settings || {})
  if (!resolvedAvailability.usable) {
    recordFetchProviderAttempt(attemptedProviders, {
      provider: JINA_FETCH_PROVIDER.id,
      reason,
      status: resolvedAvailability.blocked ? 'blocked' : 'disabled',
      blocked: resolvedAvailability.blocked,
      source: resolvedAvailability.source || '',
      error:
        resolvedAvailability.entry?.code ||
        (resolvedAvailability.blocked
          ? 'WEB_FETCH_PROVIDER_BLOCKED'
          : 'JINA_FETCH_NOT_ENABLED'),
    })
    return {
      result: null,
      error: null,
      skipped: true,
      blocked: resolvedAvailability.blocked,
    }
  }

  try {
    const jinaResult = await JINA_FETCH_PROVIDER.fetch(finalUrl, runtime, {
      timeoutMs: Math.min(fetchSettings.timeoutMs, 8_000),
    })
    const result = {
      ...buildJinaFetchPayload({
        url: normalizedUrl,
        finalUrl,
        mode,
        maxChars,
        markdown: jinaResult.markdown,
        plain: jinaResult.plain,
        title: jinaResult.title || title,
      }),
      tookMs: Date.now() - startedAt,
    }
    writeFetchCacheEntry(cacheKey, result, cacheTtlMs)
    rememberWebFetchProviderSuccess(runtime, JINA_FETCH_PROVIDER.id)
    recordFetchProviderAttempt(attemptedProviders, {
      provider: JINA_FETCH_PROVIDER.id,
      reason,
      status: 'success',
    })
    return {
      result: attachFetchResultMeta(result, attemptedProviders, {
        hit: false,
        layer: 'miss',
      }),
      error: null,
    }
  } catch (error) {
    rememberJinaFailure(runtime, error)
    recordFetchProviderAttempt(attemptedProviders, {
      provider: JINA_FETCH_PROVIDER.id,
      reason,
      status: 'error',
      error: summarizeFetchFallbackError(error, 'Jina Reader 未能返回可用内容。'),
    })
    return {
      result: null,
      error,
    }
  }
}

function summarizeFetchFallbackError(error, fallbackLabel) {
  if (error?.errorInfo?.summary) {
    return error.errorInfo.summary
  }
  if (error instanceof Error && error.message.trim()) {
    return error.message.trim()
  }
  return fallbackLabel
}

function buildFetchConnectivityError({
  normalizedUrl,
  directError,
  lightpandaFallback,
  jinaFallback,
  runtime,
  settings,
}) {
  const availability = getJinaProviderAvailability(runtime, settings)
  const details = [
    `URL: ${normalizedUrl}`,
    `Direct fetch: ${summarizeFetchFallbackError(directError, '连接目标页面失败。')}`,
  ]

  if (lightpandaFallback?.error) {
    details.push(
      `Lightpanda fallback: ${summarizeFetchFallbackError(
        lightpandaFallback.error,
        'Lightpanda 未能返回可用内容。',
      )}`,
    )
  } else if (lightpandaFallback?.blocked) {
    details.push('Lightpanda fallback: 当前任务中已暂时停用。')
  } else if (!isLightpandaEnabled(settings)) {
    details.push('Lightpanda fallback: 当前未启用。')
  }

  if (jinaFallback?.error) {
    details.push(
      `Jina Reader fallback: ${summarizeFetchFallbackError(
        jinaFallback.error,
        'Jina Reader 未能返回可用内容。',
      )}`,
    )
  } else if (jinaFallback?.blocked) {
    details.push('Jina Reader fallback: 当前任务中已暂时停用。')
  } else if (!availability.usable && !availability.blocked) {
    details.push('Jina Reader fallback: 当前未启用或没有可用鉴权方式。')
  }

  return createStructuredError('网页抓取无法连接到目标页面，本地抓取链路没有建立成功。', {
    source: 'tool',
    category: 'network',
    code: 'WEB_FETCH_CONNECTION_FAILED',
    detail: details.join('\n'),
    suggestedAction:
      '请检查当前网络和代理是否可用；如果目标站点更依赖浏览器环境，建议启用 Lightpanda / Jina Reader，或显式要求打开系统浏览器。',
    retryable: true,
  })
}

async function tryFetchFallbacks({
  normalizedUrl,
  finalUrl,
  mode,
  maxChars,
  title,
  startedAt,
  cacheKey,
  cacheTtlMs,
  runtime,
  fetchSettings,
  attemptedProviders,
  reason = '',
  allowLightpanda = true,
  allowJina = true,
}) {
  const settings = runtime.settings || {}
  const candidates = resolveFetchFallbackCandidates(runtime, settings, reason).filter(
    candidate =>
      (candidate.kind !== 'lightpanda' || allowLightpanda) &&
      (candidate.kind !== 'jina' || allowJina),
  )
  const outcomes = {
    lightpandaFallback: null,
    jinaFallback: null,
  }

  for (const candidate of candidates) {
    if (candidate.kind === 'lightpanda') {
      const outcome = await tryLightpandaFallback({
        normalizedUrl,
        finalUrl,
        mode,
        maxChars,
        startedAt,
        cacheKey,
        cacheTtlMs,
        runtime,
        reason,
        attemptedProviders,
        availability: candidate.availability,
      })
      outcomes.lightpandaFallback = outcome
      if (outcome?.result) {
        return {
          result: outcome.result,
          ...outcomes,
        }
      }
      continue
    }

    if (candidate.kind === 'jina') {
      const outcome = await tryJinaFallback({
        normalizedUrl,
        finalUrl,
        mode,
        maxChars,
        title,
        startedAt,
        cacheKey,
        cacheTtlMs,
        runtime,
        fetchSettings,
        reason,
        attemptedProviders,
        availability: candidate.availability,
      })
      outcomes.jinaFallback = outcome
      if (outcome?.result) {
        return {
          result: outcome.result,
          ...outcomes,
        }
      }
    }
  }

  return {
    result: null,
    ...outcomes,
  }
}

export async function runWebFetch(args, runtime = {}) {
  runtime.throwIfAborted?.()
  const settings = runtime.settings || {}
  const fetchSettings = resolveFetchSettings(settings)
  const jinaAccess = resolveJinaProviderAccess(settings)

  if (fetchSettings.enabled === false) {
    throw createStructuredError('网页抓取当前已在设置中关闭。', {
      source: 'tool',
      category: 'unsupported',
      code: 'WEB_FETCH_DISABLED',
      suggestedAction: '请在设置中重新启用 Web Fetch，或改为显式网页操作任务。',
    })
  }

  const url = typeof args.url === 'string' ? args.url.trim() : ''
  if (!url) {
    throw createStructuredError('网页抓取失败，请先提供 url。', {
      source: 'tool',
      category: 'invalid_input',
      code: 'WEB_FETCH_INVALID_URL',
      detail: 'web_fetch requires a non-empty url.',
      suggestedAction: '请补充要抓取的网页地址后再试。',
    })
  }

  let normalizedUrl
  try {
    normalizedUrl = new URL(url).toString()
  } catch {
    throw createStructuredError('网页抓取失败，url 格式无效。', {
      source: 'tool',
      category: 'invalid_input',
      code: 'WEB_FETCH_INVALID_URL',
      detail: `Invalid URL: ${url}`,
      suggestedAction: '请提供包含协议头的完整网址，例如 https://example.com。',
    })
  }

  const requestedProvider =
    typeof args?.provider === 'string' ? args.provider.trim().toLowerCase() : ''
  if (requestedProvider && !['auto', 'http-readability'].includes(requestedProvider)) {
    throw createStructuredError('网页抓取失败，当前 provider 暂不支持。', {
      source: 'tool',
      category: 'unsupported',
      code: 'WEB_FETCH_PROVIDER_NOT_CONFIGURED',
      detail: `Unsupported web_fetch provider: ${requestedProvider}`,
      suggestedAction: '请改用 provider "auto" 或 "http-readability"。',
    })
  }

  const provider = requestedProvider && requestedProvider !== 'auto' ? requestedProvider : 'http-readability'
  const mode =
    args.mode === 'article' || args.mode === 'markdown' || args.mode === 'summary' || args.mode === 'metadata'
      ? args.mode
      : 'article'
  const maxChars = Math.max(400, Math.min(fetchSettings.maxCharsCap, Number(args.maxChars) || fetchSettings.maxCharsCap))
  const cacheTtlMs = resolveFetchCacheTtlMs(settings)
  const startedAt = Date.now()
  const attemptedProviders = []
  const cacheKey = normalizeCacheKey(
    JSON.stringify({
      url: normalizedUrl,
      provider,
      mode,
      maxChars,
      readability: fetchSettings.readability,
      jina: buildCloudFetchCacheHint(jinaAccess),
      lightpanda: isLightpandaEnabled(settings),
    }),
  )

  runtime.onUpdate?.({
    url: normalizedUrl,
    provider,
    title: '',
    contentFormat: mode === 'metadata' ? 'metadata' : mode === 'summary' ? 'text' : 'markdown',
    excerpt: '',
    content: '',
  })

  const cached = readFetchCacheEntry(cacheKey)
  if (cached) {
    const cachedProvider =
      typeof cached.value?.provider === 'string' && cached.value.provider.trim()
        ? cached.value.provider.trim()
        : provider
    rememberWebFetchProviderSuccess(runtime, cachedProvider)
    recordFetchProviderAttempt(attemptedProviders, {
      provider: cachedProvider,
      reason: 'cache-hit',
      status: 'cached',
      cacheHit: true,
    })
    return attachFetchResultMeta({
      ...cached.value,
      tookMs: Date.now() - startedAt,
    }, attemptedProviders, {
      hit: true,
      layer: cached.layer,
    })
  }

  let response
  try {
    response = await guardedFetch(
      normalizedUrl,
      {
        method: 'GET',
        redirect: 'follow',
      },
      {
        signal: runtime.signal,
        timeoutMs: fetchSettings.timeoutMs,
        maxRedirects: fetchSettings.maxRedirects,
        settings: runtime.settings,
        proxyMode: 'web-auto',
      },
    )
  } catch (directError) {
    recordFetchProviderAttempt(attemptedProviders, {
      provider,
      reason: 'connectivity',
      status: 'error',
      error: summarizeFetchFallbackError(directError, '连接目标页面失败。'),
    })
    rememberWebFetchProviderFailure(runtime, provider, directError)
    const fallbackOutcome = await tryFetchFallbacks({
      normalizedUrl,
      finalUrl: normalizedUrl,
      mode,
      maxChars,
      title: '',
      startedAt,
      cacheKey,
      cacheTtlMs,
      runtime,
      fetchSettings,
      attemptedProviders,
      reason: 'connectivity',
    })
    if (fallbackOutcome.result) {
      return fallbackOutcome.result
    }

    throw buildFetchConnectivityError({
      normalizedUrl,
      directError,
      lightpandaFallback: fallbackOutcome.lightpandaFallback,
      jinaFallback: fallbackOutcome.jinaFallback,
      runtime,
      settings,
    })
  }

  if ([401, 403, 429].includes(response.status)) {
    recordFetchProviderAttempt(attemptedProviders, {
      provider,
      reason: 'auth-wall',
      status: 'error',
      error: `HTTP ${response.status}`,
    })
    const fallbackOutcome = await tryFetchFallbacks({
      normalizedUrl,
      finalUrl: response.url || normalizedUrl,
      mode,
      maxChars,
      title: '',
      startedAt,
      cacheKey,
      cacheTtlMs,
      runtime,
      fetchSettings,
      attemptedProviders,
      reason: 'auth-wall',
    })
    if (fallbackOutcome.result) {
      return fallbackOutcome.result
    }

    throw createStructuredError('网页抓取被目标站点拦截，可能需要登录、验证或浏览器环境。', {
      source: 'tool',
      category: 'unsupported',
      code: 'WEB_FETCH_PAGE_REQUIRES_BROWSER',
      status: response.status,
      detail: `HTTP ${response.status} while fetching ${normalizedUrl}`,
      suggestedAction: '如果这是需要登录、验证码或人工处理的页面，请显式要求打开系统浏览器。',
    })
  }
  if (!response.ok) {
    recordFetchProviderAttempt(attemptedProviders, {
      provider,
      reason: 'http-response',
      status: 'error',
      error: `HTTP ${response.status}`,
    })
    throw createStructuredError('网页抓取失败，目标页面返回了错误状态。', {
      source: 'tool',
      category: 'network',
      code: 'WEB_FETCH_PROVIDER_FAILED',
      status: response.status,
      detail: `HTTP ${response.status} while fetching ${normalizedUrl}`,
      suggestedAction: '请稍后重试，或确认该页面当前可以直接访问。',
      retryable: response.status >= 500,
    })
  }

  const contentType = response.headers.get('content-type') || ''
  const finalUrl = response.url || normalizedUrl
  const unsupportedContentType = !isSupportedFetchContentType(contentType)

  if (
    unsupportedContentType &&
    JINA_FETCH_PROVIDER.shouldUse({ unsupportedContentType: true })
  ) {
    recordFetchProviderAttempt(attemptedProviders, {
      provider,
      reason: 'unsupported-content',
      status: 'error',
      error: contentType || 'unsupported-content-type',
    })
    const fallbackOutcome = await tryFetchFallbacks({
      normalizedUrl,
      finalUrl,
      mode,
      maxChars,
      title: '',
      startedAt,
      cacheKey,
      cacheTtlMs,
      runtime,
      fetchSettings,
      attemptedProviders,
      reason: 'unsupported-content',
      allowLightpanda: false,
    })
    if (fallbackOutcome.result) {
      return fallbackOutcome.result
    }
    if (fallbackOutcome.jinaFallback?.error) {
      throw fallbackOutcome.jinaFallback.error
    }
  }
  ensureSupportedFetchContentType(contentType)

  const text = await readResponseText(response, fetchSettings.maxResponseBytes)
  const isHtml =
    contentType.toLowerCase().includes('text/html') ||
    contentType.toLowerCase().includes('application/xhtml+xml')
  const html = isHtml ? text : ''

  const browserOnly = isHtml && looksLikeBrowserOnlyPage(text, finalUrl)
  if (browserOnly) {
    recordFetchProviderAttempt(attemptedProviders, {
      provider,
      reason: 'browser-required',
      status: 'error',
      error: 'WEB_FETCH_PAGE_REQUIRES_BROWSER',
    })
    const fallbackOutcome = await tryFetchFallbacks({
      normalizedUrl,
      finalUrl,
      mode,
      maxChars,
      title: extractTitle(html),
      startedAt,
      cacheKey,
      cacheTtlMs,
      runtime,
      fetchSettings,
      attemptedProviders,
      reason: 'browser-required',
    })
    if (fallbackOutcome.result) {
      return fallbackOutcome.result
    }

    throw createStructuredError('网页抓取检测到该页面需要浏览器交互后才能继续。', {
      source: 'tool',
      category: 'unsupported',
      code: 'WEB_FETCH_PAGE_REQUIRES_BROWSER',
      detail: `Page appears to require interactive browser access: ${finalUrl}`,
      suggestedAction: '如果这是需要人工处理的页面，请明确要求打开系统浏览器继续。',
    })
  }

  const extractionMode = mode === 'summary' ? 'text' : 'markdown'
  const readabilityResult =
    isHtml && fetchSettings.readability
      ? await extractReadableContent(html, extractionMode)
      : null
  const textContent = isHtml
    ? readabilityResult?.content || extractBasicHtmlContent(text)
    : collapseWhitespace(stripTags(text))
  const jsDependent = isHtml && detectJsDependentPage(text, finalUrl)
  const localContentThin = collapseWhitespace(textContent).length < 320

  if (
    JINA_FETCH_PROVIDER.shouldUse({
      readabilityFailed: !readabilityResult?.content,
      jsDependent,
      localContentThin,
    })
  ) {
    const fallbackOutcome = await tryFetchFallbacks({
      normalizedUrl,
      finalUrl,
      mode,
      maxChars,
      title: readabilityResult?.title || extractTitle(html),
      startedAt,
      cacheKey,
      cacheTtlMs,
      runtime,
      fetchSettings,
      attemptedProviders,
      reason: 'local-content-thin',
    })
    if (fallbackOutcome.result) {
      return fallbackOutcome.result
    }
  }

  const payload = buildFetchPayload({
    url: normalizedUrl,
    finalUrl,
    provider,
    html,
    textContent,
    mode,
    maxChars,
    readabilityResult,
  })

  const result = {
    ...payload,
    tookMs: Date.now() - startedAt,
  }
  writeFetchCacheEntry(cacheKey, result, cacheTtlMs)
  rememberWebFetchProviderSuccess(runtime, provider)
  recordFetchProviderAttempt(attemptedProviders, {
    provider,
    reason: 'direct-fetch',
    status: 'success',
  })
  return attachFetchResultMeta(result, attemptedProviders, {
    hit: false,
    layer: 'miss',
  })
}
