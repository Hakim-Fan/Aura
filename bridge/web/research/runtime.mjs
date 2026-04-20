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
const CLOUD_FETCH_FALLBACK_ERROR_CODES = new Set([
  'JINA_FETCH_RATE_LIMITED',
  'JINA_FETCH_QUOTA_EXCEEDED',
  'JINA_FETCH_ANONYMOUS_FORBIDDEN',
  'JINA_FETCH_AUTH_FAILED',
  'JINA_FETCH_UNAVAILABLE',
  'JINA_FETCH_PROVIDER_BLOCKED',
])

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

function normalizeEvidenceComparableText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[`"'“”‘’()[\]{}]/g, ' ')
    .replace(/[^a-z0-9\u4e00-\u9fff\s.%:-]+/giu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function tokenizeEvidenceComparableText(value) {
  return unique(
    normalizeEvidenceComparableText(value).match(/[a-z0-9]{2,}|[\u4e00-\u9fff]{2,}/gu) || [],
  )
}

function computeTokenOverlap(leftTokens, rightTokens) {
  const left = new Set(leftTokens || [])
  const right = new Set(rightTokens || [])
  if (left.size === 0 || right.size === 0) {
    return { overlapCount: 0, jaccard: 0 }
  }

  let overlapCount = 0
  for (const token of left) {
    if (right.has(token)) {
      overlapCount += 1
    }
  }

  const union = new Set([...left, ...right]).size
  return {
    overlapCount,
    jaccard: union > 0 ? overlapCount / union : 0,
  }
}

function detectDirectionalConflict(leftText, rightText) {
  const left = normalizeEvidenceComparableText(leftText)
  const right = normalizeEvidenceComparableText(rightText)
  if (!left || !right) {
    return false
  }

  const contradictionPairs = [
    ['increase', 'decrease'],
    ['rose', 'fell'],
    ['up', 'down'],
    ['growth', 'decline'],
    ['profit', 'loss'],
    ['beat', 'miss'],
    ['launch', 'cancel'],
    ['support', 'oppose'],
    ['approved', 'rejected'],
    ['增长', '下降'],
    ['上升', '下滑'],
    ['上涨', '下跌'],
    ['盈利', '亏损'],
    ['支持', '反对'],
    ['发布', '取消'],
    ['获批', '被拒'],
  ]

  return contradictionPairs.some(([positive, negative]) => {
    const leftPositiveRightNegative = left.includes(positive) && right.includes(negative)
    const leftNegativeRightPositive = left.includes(negative) && right.includes(positive)
    return leftPositiveRightNegative || leftNegativeRightPositive
  })
}

function extractComparableNumbers(text) {
  return Array.from(
    String(text || '').matchAll(/\b\d+(?:\.\d+)?\b/g),
    match => Number(match[0]),
  ).filter(value => Number.isFinite(value))
}

function classifyConflictType(leftText, rightText) {
  const leftNumbers = extractComparableNumbers(leftText)
  const rightNumbers = extractComparableNumbers(rightText)
  if (leftNumbers.length > 0 && rightNumbers.length > 0) {
    const leftValue = leftNumbers[0]
    const rightValue = rightNumbers[0]
    const baseline = Math.max(1, Math.abs(leftValue), Math.abs(rightValue))
    if (Math.abs(leftValue - rightValue) / baseline >= 0.05) {
      return 'quantitative'
    }
  }
  return detectDirectionalConflict(leftText, rightText) ? 'directional' : 'mixed'
}

function clampScore(value) {
  if (!Number.isFinite(value)) {
    return 0
  }
  return Math.max(0, Math.min(1, value))
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

function buildProviderEvidenceBlocks({ title, excerpt, content }) {
  const keywords = tokenizeEvidenceComparableText([title, excerpt].filter(Boolean).join(' '))
  const seen = new Set()

  return splitIntoSentences(content)
    .filter(sentence => collapseWhitespace(sentence).length >= 24)
    .filter(sentence => !/\b(?:cookie|privacy|subscribe|javascript)\b|隐私|登录|注册|订阅/u.test(sentence))
    .map(sentence => {
      const normalized = normalizeEvidenceComparableText(sentence)
      if (!normalized || seen.has(normalized)) {
        return null
      }
      seen.add(normalized)

      const matchedKeywords = keywords.filter(keyword => normalized.includes(keyword)).slice(0, 5)
      const hasNumber = /\b\d[\d,.:%-]*\b|(?:20\d{2}|19\d{2})/u.test(sentence)
      const hasAttribution = /\b(?:said|announced|reported|according to)\b|表示|称|宣布|根据/u.test(sentence)
      const score = Math.round(
        Math.min(
          100,
          42 +
            matchedKeywords.length * 8 +
            (hasNumber ? 16 : 0) +
            (hasAttribution ? 10 : 0) +
            (sentence.length >= 60 && sentence.length <= 240 ? 12 : 0),
        ),
      )

      return {
        id: `provider-evidence-${seen.size}`,
        claim: clipText(sentence, 280),
        supportingQuote: clipText(sentence, 280),
        kind: inferEvidenceKind(sentence),
        evidenceScore: score,
        matchedKeywords,
      }
    })
    .filter(Boolean)
    .sort((left, right) => right.evidenceScore - left.evidenceScore)
    .slice(0, 4)
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

function normalizeResearchSourceRecord(result) {
  if (!result || typeof result !== 'object') {
    return null
  }

  const url =
    typeof result?.finalUrl === 'string' && result.finalUrl.trim()
      ? result.finalUrl.trim()
      : typeof result?.url === 'string' && result.url.trim()
        ? result.url.trim()
        : ''
  if (!url) {
    return null
  }

  const sourceAssessment =
    result?.sourceAssessment && typeof result.sourceAssessment === 'object'
      ? result.sourceAssessment
      : {}

  return {
    url,
    domain: extractHostname(url),
    title:
      typeof result?.title === 'string' && result.title.trim()
        ? result.title.trim()
        : url,
    site:
      typeof result?.site === 'string' && result.site.trim()
        ? result.site.trim()
        : extractHostname(url),
    sourceCategory:
      typeof sourceAssessment.category === 'string' ? sourceAssessment.category.trim() : '',
    riskFlags: Array.isArray(result?.riskFlags)
      ? result.riskFlags.filter(flag => typeof flag === 'string' && flag.trim())
      : [],
    evidenceBlocks: Array.isArray(result?.evidenceBlocks)
      ? result.evidenceBlocks.filter(entry => entry && typeof entry === 'object')
      : [],
  }
}

function buildCrossSourceInsights(results = []) {
  const sources = (Array.isArray(results) ? results : [])
    .map(normalizeResearchSourceRecord)
    .filter(Boolean)
  const uniqueDomains = unique(sources.map(entry => entry.domain).filter(Boolean))
  if (sources.length < 2 || uniqueDomains.length < 2) {
    return null
  }

  const weakerSources = unique(
    sources
      .filter(entry =>
        entry.sourceCategory === 'community' ||
        entry.sourceCategory === 'low-signal' ||
        entry.riskFlags.some(flag => flag === 'community-source' || flag === 'low-signal-source'),
      )
      .map(entry => entry.site || entry.title || entry.url),
  ).slice(0, 3)

  const corroboratingClaims = []
  const conflictDetails = []
  const conflictingSignals = []
  const seenCorroborations = new Set()
  const seenConflicts = new Set()

  for (let leftIndex = 0; leftIndex < sources.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < sources.length; rightIndex += 1) {
      const leftSource = sources[leftIndex]
      const rightSource = sources[rightIndex]
      if (!leftSource || !rightSource || leftSource.domain === rightSource.domain) {
        continue
      }

      for (const leftClaim of leftSource.evidenceBlocks) {
        for (const rightClaim of rightSource.evidenceBlocks) {
          const leftText = collapseWhitespace(leftClaim?.claim || leftClaim?.supportingQuote || '')
          const rightText = collapseWhitespace(rightClaim?.claim || rightClaim?.supportingQuote || '')
          if (!leftText || !rightText) {
            continue
          }

          const overlap = computeTokenOverlap(
            tokenizeEvidenceComparableText(leftText),
            tokenizeEvidenceComparableText(rightText),
          )
          const sharedKeywords = unique([
            ...(Array.isArray(leftClaim?.matchedKeywords) ? leftClaim.matchedKeywords : []),
            ...(Array.isArray(rightClaim?.matchedKeywords) ? rightClaim.matchedKeywords : []),
          ]).slice(0, 5)
          const sourceLabels = [leftSource.site || leftSource.title, rightSource.site || rightSource.title]
            .filter(Boolean)
            .slice(0, 2)
          const conflictType = classifyConflictType(leftText, rightText)
          const hasConflict =
            conflictType !== 'mixed' && (overlap.overlapCount >= 1 || overlap.jaccard >= 0.16)

          if (
            (overlap.overlapCount >= 2 || overlap.jaccard >= 0.26) &&
            !hasConflict &&
            !detectDirectionalConflict(leftText, rightText)
          ) {
            const key = normalizeEvidenceComparableText(sharedKeywords.join(' ') || leftText.slice(0, 120))
            if (!seenCorroborations.has(key)) {
              seenCorroborations.add(key)
              corroboratingClaims.push({
                summary: leftText.length <= rightText.length ? leftText : rightText,
                sharedKeywords,
                sources: sourceLabels,
                confidenceScore: Math.round(
                  Math.min(
                    100,
                    ((leftClaim?.evidenceScore || 60) + (rightClaim?.evidenceScore || 60)) / 2 +
                      overlap.overlapCount * 4,
                  ),
                ),
              })
            }
            continue
          }

          if (hasConflict) {
            const key = `${normalizeEvidenceComparableText(leftText)}::${normalizeEvidenceComparableText(rightText)}`
            if (!seenConflicts.has(key)) {
              seenConflicts.add(key)
              conflictDetails.push({
                claim: leftText.length <= rightText.length ? leftText : rightText,
                sources: sourceLabels,
                conflictType,
                notes:
                  conflictType === 'quantitative'
                    ? '不同来源给出的数值存在明显偏差。'
                    : '不同来源对同一主题的描述方向不一致。',
                leftClaim: leftText,
                rightClaim: rightText,
              })
              conflictingSignals.push({
                summary: `${sourceLabels[0] || '来源 A'} 与 ${sourceLabels[1] || '来源 B'} 对同一主题的描述不一致。`,
                sources: sourceLabels,
                leftClaim: leftText,
                rightClaim: rightText,
              })
            }
          }
        }
      }
    }
  }

  const corroborationScore = clampScore(
    0.28 +
      Math.min(0.5, corroboratingClaims.length * 0.18) -
      Math.min(0.45, conflictDetails.length * 0.22) -
      (weakerSources.length > 0 ? 0.08 : 0) +
      Math.min(0.12, uniqueDomains.length * 0.03),
  )
  const evidenceLevel =
    conflictDetails.length > 0
      ? 'conflict'
      : corroboratingClaims.length > 0 && corroborationScore >= 0.72
        ? 'strong'
        : corroboratingClaims.length > 0
          ? 'mixed'
          : 'limited'

  return {
    comparedSources: sources.length,
    uniqueDomains: uniqueDomains.length,
    corroboratingClaims: corroboratingClaims.slice(0, 3),
    conflictingSignals: conflictingSignals.slice(0, 3),
    weakerSources,
    overallSignal:
      conflictDetails.length > 0
        ? 'mixed'
        : corroboratingClaims.length > 0
          ? 'corroborated'
          : 'limited',
    hasConflict: conflictDetails.length > 0,
    conflictDetails: conflictDetails.slice(0, 3),
    corroborationScore: Number(corroborationScore.toFixed(2)),
    evidenceLevel,
  }
}

function hasUsableProviderContent(item, minimumChars = 0) {
  const content = collapseWhitespace(item?.content)
  return content.length >= Math.max(1, minimumChars)
}

function getProviderContentFallbackThreshold(errorInfo, resolved) {
  const code = typeof errorInfo?.code === 'string' ? errorInfo.code : ''
  if (CLOUD_FETCH_FALLBACK_ERROR_CODES.has(code)) {
    return Math.max(120, Math.min(400, Math.round((resolved?.searchContentMinChars || 400) * 0.1)))
  }
  return 400
}

function buildProviderContentResult(item, citationIndex, maxChars, status = 'provider_content') {
  const providerContent = clipText(item?.content || item?.snippet, maxChars)
  const sourceAssessment = buildSearchSourceAssessment(item, providerContent)
  const evidenceBlocks = buildProviderEvidenceBlocks({
    title: item?.title || '',
    excerpt: item?.snippet || '',
    content: providerContent,
  })
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
    keyPoints:
      evidenceBlocks.length > 0
        ? evidenceBlocks.map(entry => entry.claim).slice(0, 3)
        : buildSearchContentKeyPoints(providerContent),
    evidenceBlocks,
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
        const normalized = normalizeRuntimeError(error, {
          source: 'tool',
          operationLabel: '网页抓取',
        })
        const fallbackThreshold = getProviderContentFallbackThreshold(
          normalized.errorInfo,
          resolved,
        )

        if (resolved.preferSearchContent && hasUsableProviderContent(item, fallbackThreshold)) {
          const fallback = buildProviderContentResult(
            item,
            index + 1,
            resolved.maxChars,
            'provider_content_fallback',
          )
          return {
            ...fallback,
            fetchError: normalized.message,
            fetchErrorInfo: normalized.errorInfo,
            providerContentUsed: true,
          }
        }

        return buildFetchErrorResult(item, index + 1, normalized)
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
  const crossSourceInsights = buildCrossSourceInsights(successfulResults)

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
    ...(crossSourceInsights
      ? {
          crossSourceInsights,
          evidenceLevel: crossSourceInsights.evidenceLevel,
        }
      : {}),
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
