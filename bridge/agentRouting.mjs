import { createStructuredError } from './runtimeErrors.mjs'

function latestUserMessage(messages) {
  return [...messages].reverse().find(message => message.role === 'user') || null
}

function latestUserResearchMode(messages) {
  return latestUserMessage(messages)?.researchMode === 'deep'
    ? 'deep'
    : 'auto'
}

const SEARCH_BUDGET_BY_TIER = {
  // Keep a small opportunistic budget on local-first turns so mounted
  // retrieval tools stay usable even when external lookup was not preclassified.
  none: 2,
  'local-readonly': 2,
  'local-write': 2,
  'web-lookup': 5,
  'browser-interactive': 2,
}

const DEEP_RESEARCH_SEARCH_BUDGET_BY_TIER = {
  none: 3,
  'local-readonly': 3,
  'local-write': 3,
  'web-lookup': 8,
  'browser-interactive': 4,
}

function uniqueTargets(values) {
  return Array.from(new Set((values || []).filter(Boolean)))
}

function normalizeSearchRuntimeText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\b(?:site|filetype|before|after|intitle|inurl):([^\s]+)/giu, ' ')
    .replace(/\b(?:and|or|not)\b/giu, ' ')
    .replace(/["'`]+/g, ' ')
    .replace(/[^a-z0-9\u4e00-\u9fff.]+/giu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function normalizeSearchDomains(domains) {
  if (!Array.isArray(domains)) {
    return []
  }

  return Array.from(
    new Set(
      domains
        .map(entry =>
          String(entry || '')
            .trim()
            .toLowerCase()
            .replace(/^https?:\/\//, '')
            .replace(/^www\./, '')
            .replace(/\/.*$/, '')
            .replace(/^\.+|\.+$/g, ''),
        )
        .filter(Boolean),
    ),
  )
}

function extractSearchRuntimeHostname(value) {
  try {
    return String(new URL(value || '').hostname)
      .toLowerCase()
      .replace(/^www\./, '')
  } catch {
    return ''
  }
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
  return Array.from(
    new Set(
      (
        normalizeEvidenceComparableText(value).match(/[a-z0-9]{2,}|[\u4e00-\u9fff]{2,}/gu) || []
      ).filter(Boolean),
    ),
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

function clampCrossSourceScore(value) {
  if (!Number.isFinite(value)) {
    return 0
  }
  return Math.max(0, Math.min(1, value))
}

function normalizeFetchRuntimeRecord(output, fallbackUrl = '') {
  if (!output || typeof output !== 'object') {
    return null
  }

  const url =
    typeof output.finalUrl === 'string' && output.finalUrl.trim()
      ? output.finalUrl.trim()
      : typeof output.url === 'string' && output.url.trim()
        ? output.url.trim()
        : typeof fallbackUrl === 'string'
          ? fallbackUrl.trim()
          : ''
  if (!url) {
    return null
  }

  const title =
    typeof output.title === 'string' && output.title.trim()
      ? output.title.trim()
      : url
  const site =
    typeof output.site === 'string' && output.site.trim()
      ? output.site.trim()
      : extractSearchRuntimeHostname(url)
  const sourceAssessment =
    output.sourceAssessment && typeof output.sourceAssessment === 'object'
      ? output.sourceAssessment
      : {}
  const riskFlags = Array.isArray(output.riskFlags)
    ? output.riskFlags.filter(entry => typeof entry === 'string' && entry.trim())
    : []
  const evidenceBlocks = Array.isArray(output.evidenceBlocks)
    ? output.evidenceBlocks
        .filter(entry => entry && typeof entry === 'object')
        .map((entry, index) => {
          const claim =
            typeof entry.claim === 'string' && entry.claim.trim()
              ? entry.claim.trim()
              : typeof entry.supportingQuote === 'string' && entry.supportingQuote.trim()
                ? entry.supportingQuote.trim()
                : ''
          if (!claim) {
            return null
          }
          return {
            id:
              typeof entry.id === 'string' && entry.id.trim()
                ? entry.id.trim()
                : `claim-${index + 1}`,
            claim,
            kind: typeof entry.kind === 'string' ? entry.kind.trim() : '',
            evidenceScore:
              typeof entry.evidenceScore === 'number' && Number.isFinite(entry.evidenceScore)
                ? Math.round(entry.evidenceScore)
                : undefined,
            matchedKeywords: Array.isArray(entry.matchedKeywords)
              ? entry.matchedKeywords.filter(item => typeof item === 'string' && item.trim()).slice(0, 5)
              : [],
          }
        })
        .filter(Boolean)
    : []
  const keyPoints = Array.isArray(output.keyPoints)
    ? output.keyPoints.filter(entry => typeof entry === 'string' && entry.trim()).slice(0, 4)
    : []

  return {
    url,
    domain: extractSearchRuntimeHostname(url),
    title,
    site,
    publishedAt:
      typeof output.publishedAt === 'string' && output.publishedAt.trim()
        ? output.publishedAt.trim()
        : '',
    qualityScore:
      typeof sourceAssessment.qualityScore === 'number' && Number.isFinite(sourceAssessment.qualityScore)
        ? Math.round(sourceAssessment.qualityScore)
        : undefined,
    sourceCategory:
      typeof sourceAssessment.category === 'string' ? sourceAssessment.category.trim() : '',
    riskFlags,
    keyPoints,
    evidenceBlocks,
  }
}

function buildCrossSourceInsights(searchRuntime) {
  const fetches = Array.isArray(searchRuntime?.fetches) ? searchRuntime.fetches.slice(-6) : []
  const uniqueDomains = Array.from(new Set(fetches.map(entry => entry?.domain).filter(Boolean)))
  if (fetches.length < 2 || uniqueDomains.length < 2) {
    return null
  }

  const weakerSources = fetches
    .filter(entry =>
      entry?.sourceCategory === 'community' ||
      entry?.sourceCategory === 'low-signal' ||
      (Array.isArray(entry?.riskFlags) &&
        entry.riskFlags.some(flag => flag === 'community-source' || flag === 'low-signal-source')),
    )
    .map(entry => entry.site || entry.title || entry.url)
    .filter(Boolean)

  const corroboratingClaims = []
  const conflictDetails = []
  const conflictingSignals = []
  const seenCorroborations = new Set()
  const seenConflicts = new Set()

  for (let leftIndex = 0; leftIndex < fetches.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < fetches.length; rightIndex += 1) {
      const leftSource = fetches[leftIndex]
      const rightSource = fetches[rightIndex]
      if (!leftSource || !rightSource || leftSource.domain === rightSource.domain) {
        continue
      }

      const leftClaims = Array.isArray(leftSource.evidenceBlocks) ? leftSource.evidenceBlocks : []
      const rightClaims = Array.isArray(rightSource.evidenceBlocks) ? rightSource.evidenceBlocks : []

      for (const leftClaim of leftClaims) {
        for (const rightClaim of rightClaims) {
          const leftText = leftClaim?.claim || ''
          const rightText = rightClaim?.claim || ''
          if (!leftText || !rightText) {
            continue
          }

          const overlap = computeTokenOverlap(
            tokenizeEvidenceComparableText(leftText),
            tokenizeEvidenceComparableText(rightText),
          )
          const sharedKeywords = Array.from(
            new Set([
              ...(Array.isArray(leftClaim?.matchedKeywords) ? leftClaim.matchedKeywords : []),
              ...(Array.isArray(rightClaim?.matchedKeywords) ? rightClaim.matchedKeywords : []),
            ]),
          ).slice(0, 5)
          const sources = [leftSource.site || leftSource.title, rightSource.site || rightSource.title]
            .filter(Boolean)
            .slice(0, 2)
          const conflictType = classifyConflictType(leftText, rightText)

          if (
            (overlap.overlapCount >= 2 || overlap.jaccard >= 0.26) &&
            !detectDirectionalConflict(leftText, rightText)
          ) {
            const key = normalizeEvidenceComparableText(sharedKeywords.join(' ') || leftText.slice(0, 120))
            if (!seenCorroborations.has(key)) {
              seenCorroborations.add(key)
              corroboratingClaims.push({
                summary: leftText.length <= rightText.length ? leftText : rightText,
                sharedKeywords,
                sources,
                confidenceScore: Math.round(
                  Math.min(
                    100,
                    ((leftClaim?.evidenceScore || 60) +
                      (rightClaim?.evidenceScore || 60)) / 2 +
                      overlap.overlapCount * 4,
                  ),
                ),
              })
            }
          } else if (
            (overlap.overlapCount >= 1 || overlap.jaccard >= 0.16) &&
            conflictType !== 'mixed'
          ) {
            const key = `${normalizeEvidenceComparableText(leftText)}::${normalizeEvidenceComparableText(rightText)}`
            if (!seenConflicts.has(key)) {
              seenConflicts.add(key)
              conflictDetails.push({
                claim: leftText.length <= rightText.length ? leftText : rightText,
                sources,
                conflictType,
                notes:
                  conflictType === 'quantitative'
                    ? '不同来源给出的数值存在明显偏差。'
                    : '不同来源对同一主题的描述方向不一致。',
                leftClaim: leftText,
                rightClaim: rightText,
              })
              conflictingSignals.push({
                summary: `${sources[0] || '来源 A'} 与 ${sources[1] || '来源 B'} 对同一主题的描述方向不一致。`,
                sources,
                leftClaim: leftText,
                rightClaim: rightText,
              })
            }
          }
        }
      }
    }
  }

  const uniqueWeakerSources = Array.from(new Set(weakerSources)).slice(0, 3)
  const corroborationScore = clampCrossSourceScore(
    0.28 +
      Math.min(0.5, corroboratingClaims.length * 0.18) -
      Math.min(0.45, conflictDetails.length * 0.22) -
      (uniqueWeakerSources.length > 0 ? 0.08 : 0) +
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
    comparedSources: fetches.length,
    uniqueDomains: uniqueDomains.length,
    corroboratingClaims: corroboratingClaims.slice(0, 3),
    conflictingSignals: conflictingSignals.slice(0, 3),
    weakerSources: uniqueWeakerSources,
    hasConflict: conflictDetails.length > 0,
    conflictDetails: conflictDetails.slice(0, 3),
    corroborationScore: Number(corroborationScore.toFixed(2)),
    evidenceLevel,
    overallSignal:
      conflictDetails.length > 0
        ? 'mixed'
        : corroboratingClaims.length > 0
          ? 'corroborated'
          : 'limited',
  }
}

function mergeCrossSourceInsights(primary, secondary) {
  if (!primary && !secondary) {
    return null
  }
  if (!primary) {
    return secondary
  }
  if (!secondary) {
    return primary
  }

  return {
    ...secondary,
    ...primary,
    corroboratingClaims: Array.isArray(primary.corroboratingClaims)
      ? primary.corroboratingClaims
      : secondary.corroboratingClaims,
    conflictingSignals: Array.isArray(primary.conflictingSignals)
      ? primary.conflictingSignals
      : secondary.conflictingSignals,
    conflictDetails: Array.isArray(primary.conflictDetails)
      ? primary.conflictDetails
      : secondary.conflictDetails,
    weakerSources: Array.isArray(primary.weakerSources)
      ? primary.weakerSources
      : secondary.weakerSources,
  }
}

function getSearchRuntimeState(budgets) {
  if (!budgets || typeof budgets !== 'object') {
    return {
      attempts: [],
      fetches: [],
      lastResults: [],
    }
  }

  if (!budgets.searchRuntime || typeof budgets.searchRuntime !== 'object') {
    budgets.searchRuntime = {
      attempts: [],
      fetches: [],
      lastResults: [],
    }
  }

  if (!Array.isArray(budgets.searchRuntime.attempts)) {
    budgets.searchRuntime.attempts = []
  }

  if (!Array.isArray(budgets.searchRuntime.fetches)) {
    budgets.searchRuntime.fetches = []
  }

  if (!Array.isArray(budgets.searchRuntime.lastResults)) {
    budgets.searchRuntime.lastResults = []
  }

  return budgets.searchRuntime
}

function normalizeRecommendedSearchResult(result) {
  if (!result || typeof result !== 'object') {
    return null
  }

  const url = typeof result.url === 'string' ? result.url.trim() : ''
  if (!url) {
    return null
  }

  return {
    title:
      typeof result.title === 'string' && result.title.trim()
        ? result.title.trim()
        : url,
    url,
    site: typeof result.site === 'string' ? result.site.trim() : '',
    rankScore:
      typeof result.rankScore === 'number' && Number.isFinite(result.rankScore)
        ? Math.round(result.rankScore)
        : undefined,
    sourceQualityScore:
      typeof result.sourceQualityScore === 'number' && Number.isFinite(result.sourceQualityScore)
        ? Math.round(result.sourceQualityScore)
        : undefined,
    domainCategory:
      typeof result.domainCategory === 'string' ? result.domainCategory.trim() : '',
    rankingSignals: Array.isArray(result.rankingSignals)
      ? result.rankingSignals.filter(entry => typeof entry === 'string' && entry.trim()).slice(0, 4)
      : [],
    queryKey:
      typeof result.queryKey === 'string' && result.queryKey.trim()
        ? result.queryKey.trim()
        : '',
  }
}

function buildRecommendedFetchResults(searchRuntime, limit = 3, queryKey = '') {
  const fetchedUrls = new Set(
    (Array.isArray(searchRuntime?.fetches) ? searchRuntime.fetches : [])
      .map(entry => (typeof entry?.url === 'string' ? entry.url.trim() : ''))
      .filter(Boolean),
  )
  const usedDomains = new Set()
  const recommendations = []

  for (const entry of Array.isArray(searchRuntime?.lastResults) ? searchRuntime.lastResults : []) {
    const normalized = normalizeRecommendedSearchResult(entry)
    if (!normalized || fetchedUrls.has(normalized.url)) {
      continue
    }
    if (queryKey && normalized.queryKey && normalized.queryKey !== queryKey) {
      continue
    }

    const hostname = extractSearchRuntimeHostname(normalized.url)
    const strongEnough =
      typeof normalized.rankScore === 'number'
        ? normalized.rankScore >= 60
        : true

    if (!strongEnough) {
      continue
    }

    if (hostname && usedDomains.has(hostname) && recommendations.length < 2) {
      continue
    }

    if (hostname) {
      usedDomains.add(hostname)
    }
    recommendations.push(normalized)
    if (recommendations.length >= limit) {
      break
    }
  }

  return recommendations
}

function finalizeSearchRouteOutput(normalizedOutput, attemptSignature, searchRuntime) {
  const recommendedResults = Array.isArray(normalizedOutput?.results)
    ? normalizedOutput.results
        .map(result => {
          const normalizedResult = normalizeRecommendedSearchResult(result)
          if (!normalizedResult) {
            return null
          }
          return {
            ...normalizedResult,
            queryKey: attemptSignature.comparableKey,
          }
        })
        .filter(Boolean)
        .slice(0, 5)
    : []

  const nextAttempt = {
    comparableKey: attemptSignature.comparableKey,
    query: attemptSignature.query,
    domains: attemptSignature.domains,
    noResults:
      normalizedOutput?.noResults === true ||
      (typeof normalizedOutput?.total === 'number' && normalizedOutput.total <= 0),
    total:
      typeof normalizedOutput?.total === 'number' ? normalizedOutput.total : 0,
    resultDomains: Array.isArray(normalizedOutput?.results)
      ? Array.from(
          new Set(
            normalizedOutput.results
              .map(result => extractSearchRuntimeHostname(result?.url || ''))
              .filter(Boolean),
          ),
        )
      : [],
  }
  searchRuntime.attempts = [...(searchRuntime.attempts || []), nextAttempt].slice(-6)
  searchRuntime.lastResults = recommendedResults

  if (!normalizedOutput || typeof normalizedOutput !== 'object') {
    return normalizedOutput
  }

  return {
    ...normalizedOutput,
    recommendedResults,
    recommendedNextAction:
      typeof normalizedOutput.recommendedNextAction === 'string' && normalizedOutput.recommendedNextAction
        ? normalizedOutput.recommendedNextAction
        : recommendedResults.length > 0
          ? 'fetch_top_ranked_results'
          : undefined,
  }
}

function finalizeResearchRouteOutput(normalizedOutput, attemptSignature, searchRuntime) {
  const recommendedResults = Array.isArray(normalizedOutput?.results)
    ? normalizedOutput.results
        .map(result => {
          const normalizedResult = normalizeRecommendedSearchResult(result)
          if (!normalizedResult) {
            return null
          }
          return {
            ...normalizedResult,
            queryKey: attemptSignature.comparableKey,
          }
        })
        .filter(Boolean)
        .slice(0, 5)
    : []

  const nextAttempt = {
    comparableKey: attemptSignature.comparableKey,
    query: attemptSignature.query,
    domains: attemptSignature.domains,
    noResults:
      normalizedOutput?.noResults === true ||
      (typeof normalizedOutput?.total === 'number' && normalizedOutput.total <= 0),
    total:
      typeof normalizedOutput?.total === 'number' ? normalizedOutput.total : 0,
    resultDomains: Array.isArray(normalizedOutput?.results)
      ? Array.from(
          new Set(
            normalizedOutput.results
              .map(result => extractSearchRuntimeHostname(result?.url || ''))
              .filter(Boolean),
          ),
        )
      : [],
  }
  searchRuntime.attempts = [...(searchRuntime.attempts || []), nextAttempt].slice(-6)
  searchRuntime.lastResults = recommendedResults

  const researchFetches = Array.isArray(normalizedOutput?.results)
    ? normalizedOutput.results
        .map(result => {
          const status =
            typeof result?.status === 'string' ? result.status.trim().toLowerCase() : ''
          if (status === 'error' || status === 'not_fetched') {
            return null
          }
          if (
            typeof result?.fullContent !== 'string' &&
            typeof result?.content !== 'string' &&
            !Array.isArray(result?.evidenceBlocks)
          ) {
            return null
          }
          return normalizeFetchRuntimeRecord(
            {
              ...result,
              url:
                typeof result?.finalUrl === 'string' && result.finalUrl.trim()
                  ? result.finalUrl
                  : result?.url,
              content:
                typeof result?.fullContent === 'string'
                  ? result.fullContent
                  : result?.content,
            },
            result?.url || '',
          )
        })
        .filter(Boolean)
    : []

  if (researchFetches.length > 0) {
    const fetchesByUrl = new Map(
      (Array.isArray(searchRuntime.fetches) ? searchRuntime.fetches : [])
        .filter(entry => entry?.url)
        .map(entry => [entry.url, entry]),
    )
    for (const fetchRecord of researchFetches) {
      fetchesByUrl.set(fetchRecord.url, fetchRecord)
    }
    searchRuntime.fetches = Array.from(fetchesByUrl.values()).slice(-6)
  }

  const crossSourceInsights = mergeCrossSourceInsights(
    normalizedOutput?.crossSourceInsights,
    buildCrossSourceInsights(searchRuntime),
  )

  if (!normalizedOutput || typeof normalizedOutput !== 'object') {
    return normalizedOutput
  }

  return {
    ...normalizedOutput,
    recommendedResults,
    recommendedNextAction:
      recommendedResults.length > 0 ? 'synthesize_research_results' : undefined,
    crossSourceInsights,
    evidenceLevel:
      typeof normalizedOutput.evidenceLevel === 'string' && normalizedOutput.evidenceLevel
        ? normalizedOutput.evidenceLevel
        : crossSourceInsights?.evidenceLevel,
  }
}

function hasStrongReadCandidates(searchRuntime, queryKey = '') {
  const recommendations = buildRecommendedFetchResults(searchRuntime, 3, queryKey)
  if (recommendations.length === 0) {
    return false
  }

  const topScore = recommendations[0]?.rankScore || 0
  const multiSource = new Set(
    recommendations.map(entry => extractSearchRuntimeHostname(entry.url)).filter(Boolean),
  ).size >= 2

  return topScore >= 75 || (topScore >= 68 && multiSource)
}

function buildSearchAttemptSignature(args = {}) {
  const query = normalizeSearchRuntimeText(args.query)
  const domains = normalizeSearchDomains(args.domains)
  return {
    query,
    domains,
    comparableKey: `${query}::${domains.join(',')}`,
  }
}

function shouldStopSearchAttempts(searchRuntime, attemptSignature, routeState) {
  const attempts = Array.isArray(searchRuntime?.attempts)
    ? searchRuntime.attempts.slice(-4)
    : []
  const fetches = Array.isArray(searchRuntime?.fetches)
    ? searchRuntime.fetches.slice(-4)
    : []
  const deepResearch = routeState?.researchMode === 'deep'
  const enoughDiscoveryThreshold = deepResearch ? 4 : 3
  const enoughEvidenceFetchThreshold = deepResearch ? 3 : 2
  const preFetchSearchThreshold = deepResearch ? 3 : 2
  const sufficientDiscoveryAttemptThreshold = deepResearch ? 3 : 2
  const sufficientDiscoveryDomainThreshold = deepResearch ? 4 : 3

  if (attempts.length === 0) {
    return { shouldStop: false, reason: '' }
  }

  const successfulAttempts = attempts.filter(entry => entry?.noResults !== true && entry?.total > 0)
  const discoveredDomains = Array.from(
    new Set(successfulAttempts.flatMap(entry => entry.resultDomains || []).filter(Boolean)),
  )

  if (
    fetches.length === 0 &&
    successfulAttempts.length >= 1 &&
    hasStrongReadCandidates(searchRuntime, attemptSignature.comparableKey)
  ) {
    return {
      shouldStop: true,
      reason: 'read-recommended-results-first',
    }
  }

  if (successfulAttempts.length >= enoughDiscoveryThreshold) {
    return {
      shouldStop: true,
      reason: 'enough-discovery',
    }
  }

  if (fetches.length >= enoughEvidenceFetchThreshold && successfulAttempts.length >= 1) {
    return {
      shouldStop: true,
      reason: 'enough-evidence',
    }
  }

  if (successfulAttempts.length >= preFetchSearchThreshold && fetches.length === 0) {
    return {
      shouldStop: true,
      reason: 'fetch-before-more-search',
    }
  }

  if (
    successfulAttempts.length >= sufficientDiscoveryAttemptThreshold &&
    discoveredDomains.length >= sufficientDiscoveryDomainThreshold
  ) {
    return {
      shouldStop: true,
      reason: 'sufficient-discovery',
    }
  }

  const duplicateAttempt = attempts.find(
    entry => entry.comparableKey && entry.comparableKey === attemptSignature.comparableKey,
  )
  if (duplicateAttempt?.noResults) {
    return {
      shouldStop: true,
      reason: 'duplicate-no-results',
    }
  }

  const consecutiveNoResults = attempts
    .slice(-2)
    .every(entry => entry?.noResults === true)
  if (consecutiveNoResults) {
    return {
      shouldStop: true,
      reason: 'repeated-no-results',
    }
  }

  const duplicateSuccess = attempts.find(
    entry =>
      entry.comparableKey &&
      entry.comparableKey === attemptSignature.comparableKey &&
      entry.noResults !== true,
  )
  if (duplicateSuccess) {
    return {
      shouldStop: true,
      reason: 'duplicate-search-success',
    }
  }

  return { shouldStop: false, reason: '' }
}

function buildSearchStopPayload(reason, args, searchRuntime, attemptSignature = {}) {
  const query = typeof args?.query === 'string' ? args.query : ''
  const domains = normalizeSearchDomains(args?.domains)
  const recommendedResults = buildRecommendedFetchResults(
    searchRuntime,
    3,
    attemptSignature.comparableKey || '',
  )
  const hasPriorReadCandidates = recommendedResults.length > 0
  const summary =
    reason === 'read-recommended-results-first'
      ? hasPriorReadCandidates
        ? '这个 query 先不再继续扩展；前面已经找到一组质量较高的候选来源，下一步应该先阅读这些页面。'
        : '这个 query 先不再继续扩展；下一步应该优先阅读已找到的页面。'
      : reason === 'fetch-before-more-search'
      ? hasPriorReadCandidates
        ? '这个 query 没有必要继续改写；前面已经完成候选来源发现，下一步应该优先阅读已找到的页面。'
        : '这个 query 先收束；下一步应该优先阅读已找到的页面，而不是继续机械改写搜索词。'
      : reason === 'enough-evidence'
        ? hasPriorReadCandidates
          ? '这个 query 不再继续扩展；前面已经读过一批相关来源，继续搜索的增量很低，先基于现有证据收束回答更稳妥。'
          : '当前搜索阶段已经有足够证据，继续扩展搜索的增量很低。'
        : reason === 'enough-discovery'
          ? '这个 query 先收束；此前已经做过多轮来源发现，继续搜索的边际收益很低。'
      : reason === 'duplicate-no-results' || reason === 'repeated-no-results'
      ? '连续搜索都没有带来新结果，继续改写相似 query 的收益已经很低。'
      : reason === 'sufficient-discovery'
        ? hasPriorReadCandidates
          ? '这个 query 先不再继续；前面已经拿到足够的候选来源，继续广撒网搜索的增量很低。'
          : '已经拿到足够的候选来源，继续广撒网搜索的增量很低。'
      : reason === 'budget-exhausted'
        ? '当前搜索阶段先收束到这里，优先基于已经找到的线索继续整理和回答。'
        : '相同方向的网页搜索已经拿到候选来源，继续重复搜索的增量很低。'

  return {
    query,
    domains,
    provider: 'route-search-controller',
    tookMs: 0,
    total: 0,
    results: [],
    searchStopped: true,
    code: 'ROUTE_SEARCH_DIMINISHING_RETURNS',
    summary,
    recommendedResults,
    basedOnPreviousEvidence: hasPriorReadCandidates,
    suggestedAction:
      reason === 'read-recommended-results-first' ||
      reason === 'fetch-before-more-search' ||
      reason === 'enough-evidence' ||
      reason === 'duplicate-search-success' ||
      reason === 'sufficient-discovery' ||
      reason === 'enough-discovery' ||
      reason === 'budget-exhausted'
        ? recommendedResults.length > 0
          ? '优先改用 web_fetch 打开 recommendedResults 里的高分链接，再决定是否还需要补搜。'
          : '优先改用 web_fetch 打开 rankScore 更高、来源质量更好的链接，或直接基于已有来源收束回答。'
        : '不要继续机械地改写搜索词。可以放宽域名条件后再试一次；如果仍然没有结果，就直接说明没有找到足够公开信息。',
  }
}

function supportsWriteEscalation(capabilityTier) {
  return capabilityTier !== 'local-write' && capabilityTier !== 'browser-interactive'
}

function supportsBrowserEscalation(capabilityTier) {
  return capabilityTier !== 'browser-interactive'
}

function isWebCapableTier(capabilityTier) {
  return capabilityTier === 'web-lookup' || capabilityTier === 'browser-interactive'
}

function getSearchBudgetForRoute({
  capabilityTier,
  researchMode,
  needsExternalFacts,
  taskComplexity,
  planDepth,
}) {
  const baseBudget = SEARCH_BUDGET_BY_TIER[capabilityTier] || 0
  if (!isWebCapableTier(capabilityTier)) {
    return baseBudget
  }
  if (researchMode === 'deep') {
    return DEEP_RESEARCH_SEARCH_BUDGET_BY_TIER[capabilityTier] || baseBudget
  }
  if (
    needsExternalFacts === true &&
    (taskComplexity === 'high' || planDepth === 'long_horizon')
  ) {
    return baseBudget + 1
  }
  return baseBudget
}

function determineResponseStyle({
  researchMode,
  needsExternalFacts,
  webInteractionRequired,
  taskComplexity,
  planDepth,
}) {
  if (researchMode === 'deep') {
    return 'research-structured'
  }
  if (webInteractionRequired || needsExternalFacts !== true) {
    return 'adaptive-default'
  }
  if (taskComplexity === 'high' && planDepth !== 'single_step') {
    return 'research-structured'
  }
  if (planDepth === 'long_horizon') {
    return 'research-structured'
  }
  return 'adaptive-default'
}

function buildRouteStateFromSignals({
  needsExternalFacts,
  webInteractionRequired,
  workspaceRelated,
  isCapabilityAdminTask,
  explicitSystemBrowserRequest,
  researchMode = 'auto',
  taskComplexity = 'medium',
  planDepth = 'single_step',
  executionMode = 'bounded',
}) {
  let capabilityTier = 'none'

  if (webInteractionRequired) {
    capabilityTier = 'browser-interactive'
  } else if (needsExternalFacts) {
    capabilityTier = 'web-lookup'
  } else if (workspaceRelated) {
    capabilityTier = 'local-readonly'
  }

  const allowEscalationTo = []
  if (!isWebCapableTier(capabilityTier) && needsExternalFacts) {
    allowEscalationTo.push('web-lookup')
  }
  if (supportsBrowserEscalation(capabilityTier) && webInteractionRequired) {
    allowEscalationTo.push('browser-interactive')
  }

  const responseStyle = determineResponseStyle({
    researchMode,
    needsExternalFacts,
    webInteractionRequired,
    taskComplexity,
    planDepth,
  })

  return {
    capabilityTier,
    researchMode,
    webRetrievalAvailable: true,
    needsExternalFacts,
    webInteractionRequired,
    workspaceRelated,
    responseStyle,
    taskComplexity,
    planDepth,
    executionMode: executionMode === 'long-task' ? 'long-task' : 'bounded',
    allowEscalationTo: uniqueTargets(allowEscalationTo),
    budgets: {
      searchesRemaining: getSearchBudgetForRoute({
        capabilityTier,
        researchMode,
        needsExternalFacts,
        taskComplexity,
        planDepth,
      }),
      browserEscalationsRemaining:
        webInteractionRequired && supportsBrowserEscalation(capabilityTier)
          ? 1
          : 0,
      writeEscalationsRemaining: 0,
    },
    isCapabilityAdminTask,
    explicitSystemBrowserRequest,
  }
}

export function deriveHardSignals(messages) {
  return {
    explicitWebInteraction: false,
    explicitWebLookupRead: false,
    publicWebUrlReference: false,
    explicitSystemBrowserRequest: false,
    attachmentExecutionRequired: false,
    localFileExecutionRequired: false,
    forceOrchestrated: false,
  }
}

export function applyHardSignalIntentOverrides(classification, hardSignals = {}) {
  if (!classification || typeof classification !== 'object') {
    return classification
  }

  const explicitWebLookupRead = hardSignals.explicitWebLookupRead === true
  const explicitWebInteraction = hardSignals.explicitWebInteraction === true
  const explicitSystemBrowserRequest = hardSignals.explicitSystemBrowserRequest === true

  const webInteractionRequired =
    explicitWebInteraction ||
    (classification.webInteractionRequired === true && explicitWebLookupRead !== true)
  const needsExternalFacts =
    classification.needsExternalFacts === true || explicitWebLookupRead
  const attachmentExecutionRequired = hardSignals.attachmentExecutionRequired === true
  const localFileExecutionRequired = hardSignals.localFileExecutionRequired === true

  return {
    ...classification,
    needsExternalFacts,
    webInteractionRequired,
    workspaceRelated:
      classification.workspaceRelated === true ||
      attachmentExecutionRequired ||
      localFileExecutionRequired,
    systemBrowserRequested:
      classification.systemBrowserRequested === true || explicitSystemBrowserRequest,
  }
}

export function inferRouteStateFromClassification(classification, hardSignals = {}, settings = {}) {
  const normalizedClassification = applyHardSignalIntentOverrides(classification, hardSignals)

  if (!normalizedClassification || typeof normalizedClassification !== 'object') {
    throw createStructuredError('缺少有效的意图分类结果，无法基于分类推导路由状态。', {
      source: 'system',
      category: 'invalid_input',
      code: 'INVALID_INTENT_CLASSIFICATION',
      detail: 'inferRouteStateFromClassification received an invalid classification object.',
      suggestedAction: '请回退到关键字路由，或先完成意图分类。',
    })
  }

  const webInteractionRequired =
    normalizedClassification.webInteractionRequired === true ||
    hardSignals.explicitWebInteraction === true
  const attachmentExecutionRequired = hardSignals.attachmentExecutionRequired === true
  const localFileExecutionRequired = hardSignals.localFileExecutionRequired === true
  const workspaceRelated =
    normalizedClassification.workspaceRelated === true ||
    attachmentExecutionRequired ||
    localFileExecutionRequired

  return buildRouteStateFromSignals({
    needsExternalFacts:
      normalizedClassification.needsExternalFacts === true ||
      hardSignals.explicitWebLookupRead === true,
    webInteractionRequired,
    workspaceRelated,
    isCapabilityAdminTask: normalizedClassification.isCapabilityAdmin === true,
    explicitSystemBrowserRequest:
      normalizedClassification.systemBrowserRequested === true ||
      hardSignals.explicitSystemBrowserRequest === true,
    researchMode: hardSignals.researchMode || 'auto',
    taskComplexity: normalizedClassification.taskComplexity,
    planDepth: normalizedClassification.planDepth,
    executionMode: settings?.executionMode,
  })
}

export function inferRouteStateFromKeywords(messages, settings = {}) {
  return buildRouteStateFromSignals({
    needsExternalFacts: false,
    webInteractionRequired: false,
    workspaceRelated: false,
    isCapabilityAdminTask: false,
    explicitSystemBrowserRequest: false,
    researchMode: latestUserResearchMode(messages),
    executionMode: settings?.executionMode,
  })
}

export function inferRouteState(messages, options = {}) {
  if (options?.classification) {
    return inferRouteStateFromClassification(
      options.classification,
      {
        ...(options.hardSignals || deriveHardSignals(messages)),
        researchMode: latestUserResearchMode(messages),
      },
      options.settings,
    )
  }
  return inferRouteStateFromKeywords(messages, options.settings)
}

export function getRouteEscalationTargets(routeState, options = {}) {
  if (!routeState || !Array.isArray(routeState.allowEscalationTo)) {
    return []
  }

  const visitedTiers = options.visitedTiers instanceof Set ? options.visitedTiers : null

  return routeState.allowEscalationTo.filter(targetTier => {
    if (!targetTier || targetTier === routeState.capabilityTier) {
      return false
    }
    if (visitedTiers?.has(targetTier)) {
      return false
    }
    if (
      targetTier === 'local-write' &&
      (!supportsWriteEscalation(routeState.capabilityTier) ||
        (routeState.budgets?.writeEscalationsRemaining || 0) <= 0)
    ) {
      return false
    }
    if (
      targetTier === 'browser-interactive' &&
      (!supportsBrowserEscalation(routeState.capabilityTier) ||
        (routeState.budgets?.browserEscalationsRemaining || 0) <= 0)
    ) {
      return false
    }
    return true
  })
}

export function escalateRouteState(routeState, targetTier) {
  const allowedTargets = getRouteEscalationTargets(routeState)
  if (!allowedTargets.includes(targetTier)) {
    throw createStructuredError('当前路由策略不允许升级到所请求的能力层级。', {
      source: 'system',
      category: 'invalid_input',
      code: 'ROUTE_ESCALATION_NOT_ALLOWED',
      detail: `Route escalation to "${targetTier}" is not allowed from "${routeState?.capabilityTier}".`,
      suggestedAction: '请基于当前能力继续收束回答，或等待新的用户指令明确提升所需权限。',
    })
  }

  const nextState = {
    ...routeState,
    capabilityTier: targetTier,
    budgets: {
      ...(routeState?.budgets || {}),
    },
  }

  if (targetTier === 'local-write') {
    nextState.budgets.writeEscalationsRemaining = Math.max(
      0,
      (nextState.budgets.writeEscalationsRemaining || 0) - 1,
    )
  }

  if (targetTier === 'browser-interactive') {
    nextState.budgets.browserEscalationsRemaining = Math.max(
      0,
      (nextState.budgets.browserEscalationsRemaining || 0) - 1,
    )
  }

  if (
    isWebCapableTier(targetTier) &&
    !isWebCapableTier(routeState.capabilityTier)
  ) {
    nextState.budgets.searchesRemaining = Math.max(
      nextState.budgets.searchesRemaining || 0,
      getSearchBudgetForRoute({
        capabilityTier: targetTier,
        researchMode: nextState.researchMode,
        needsExternalFacts: true,
        taskComplexity: nextState.taskComplexity,
        planDepth: nextState.planDepth,
      }),
    )
  }

  return nextState
}

export function applyRouteToolBudgets(tools, routeState) {
  if (!Array.isArray(tools) || tools.length === 0) {
    return tools
  }
  if (routeState?.modelDirected === true) {
    return tools
  }

  const budgets = routeState?.budgets || {}
  const searchRuntime = getSearchRuntimeState(budgets)
  const mountedTools =
    (budgets.searchesRemaining || 0) <= 0
      ? tools.filter(
          tool =>
            tool?.name !== 'web_search' &&
            tool?.name !== 'web_research',
        )
      : tools
  return mountedTools.map(tool => {
    if (tool?.name === 'web_fetch') {
      return {
        ...tool,
        async run(args, runtime = {}) {
          const output = await tool.run(args, runtime)
          const searchRuntime = getSearchRuntimeState(budgets)
          const normalizedOutput = output && typeof output === 'object' ? output : {}
          const fetchedUrl =
            typeof normalizedOutput.finalUrl === 'string' && normalizedOutput.finalUrl.trim()
              ? normalizedOutput.finalUrl
              : typeof normalizedOutput.url === 'string' && normalizedOutput.url.trim()
                ? normalizedOutput.url
                : typeof args?.url === 'string'
                  ? args.url
                  : ''
          const domain = extractSearchRuntimeHostname(fetchedUrl)
          const fetchRecord = normalizeFetchRuntimeRecord(normalizedOutput, fetchedUrl)

          if (fetchRecord) {
            searchRuntime.fetches = [
              ...(searchRuntime.fetches || []).filter(entry => entry?.url !== fetchRecord.url),
              {
                ...fetchRecord,
                domain,
              },
            ].slice(-6)
          }

          const crossSourceInsights = buildCrossSourceInsights(searchRuntime)
          if (normalizedOutput && typeof normalizedOutput === 'object') {
            return {
              ...normalizedOutput,
              crossSourceInsights,
            }
          }

          return output
        },
      }
    }

    if (tool?.name === 'web_research') {
      return {
        ...tool,
        async run(args, runtime = {}) {
          const searchRuntime = getSearchRuntimeState(budgets)
          const attemptSignature = buildSearchAttemptSignature(args)
          const stopDecision = shouldStopSearchAttempts(
            searchRuntime,
            attemptSignature,
            routeState,
          )
          if (stopDecision.shouldStop) {
            return buildSearchStopPayload(
              stopDecision.reason,
              args,
              searchRuntime,
              attemptSignature,
            )
          }

          if ((budgets.searchesRemaining || 0) <= 0) {
            return buildSearchStopPayload(
              'budget-exhausted',
              args,
              searchRuntime,
              attemptSignature,
            )
          }

          budgets.searchesRemaining -= 1
          const output = await tool.run(args, runtime)
          const normalizedOutput = output && typeof output === 'object' ? output : output
          return finalizeResearchRouteOutput(
            normalizedOutput,
            attemptSignature,
            searchRuntime,
          )
        },
      }
    }

    if (tool?.name !== 'web_search') {
      return tool
    }

    return {
      ...tool,
      async run(args, runtime = {}) {
        const searchRuntime = getSearchRuntimeState(budgets)
        const attemptSignature = buildSearchAttemptSignature(args)
        const stopDecision = shouldStopSearchAttempts(
          searchRuntime,
          attemptSignature,
          routeState,
        )
        if (stopDecision.shouldStop) {
          return buildSearchStopPayload(
            stopDecision.reason,
            args,
            searchRuntime,
            attemptSignature,
          )
        }

        if ((budgets.searchesRemaining || 0) <= 0) {
          return buildSearchStopPayload(
            'budget-exhausted',
            args,
            searchRuntime,
            attemptSignature,
          )
        }

        budgets.searchesRemaining -= 1
        const output = await tool.run(args, runtime)
        const normalizedOutput = output && typeof output === 'object' ? output : output
        return finalizeSearchRouteOutput(
          normalizedOutput,
          attemptSignature,
          searchRuntime,
        )
      },
    }
  })
}
