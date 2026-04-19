import { createStructuredError } from './runtimeErrors.mjs'
import {
  runWebFetch as runStructuredWebFetch,
  runWebSearch as runStructuredWebSearch,
} from './web/index.mjs'

const DEFAULT_SEARCH_PROVIDER = 'auto'
const DEFAULT_FETCH_PROVIDER = 'http-readability'
const DEFAULT_SEARCH_LIMIT = 5
const DEFAULT_SEARCH_TIMEOUT_MS = 12_000
const DEFAULT_FETCH_TIMEOUT_MS = 15_000
const DEFAULT_FETCH_MAX_CHARS = 4_000
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36 AuraWebTools/1.0'

function decodeHtmlEntities(value) {
  return String(value || '').replace(
    /&(#x?[0-9a-f]+|[a-z]+);/giu,
    (match, entity) => {
      const normalized = String(entity || '').toLowerCase()
      if (normalized.startsWith('#x')) {
        const codePoint = Number.parseInt(normalized.slice(2), 16)
        return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : match
      }
      if (normalized.startsWith('#')) {
        const codePoint = Number.parseInt(normalized.slice(1), 10)
        return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : match
      }
      switch (normalized) {
        case 'amp':
          return '&'
        case 'lt':
          return '<'
        case 'gt':
          return '>'
        case 'quot':
          return '"'
        case 'apos':
        case '#39':
          return "'"
        case 'nbsp':
          return ' '
        case 'mdash':
          return '-'
        case 'ndash':
          return '-'
        case 'hellip':
          return '...'
        case 'middot':
          return '·'
        default:
          return match
      }
    },
  )
}

function stripTags(value) {
  return decodeHtmlEntities(String(value || '').replace(/<[^>]+>/g, ' '))
}

function collapseWhitespace(value) {
  return String(value || '').replace(/\r/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').replace(/[ \t]{2,}/g, ' ').trim()
}

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
    return {
      query: '',
      domains: [],
      providerQuery: '',
    }
  }

  const parsedDomains = parseQueryDomains(original)
  const normalizedQuery = collapseWhitespace(
    original
      .replace(/\b(?:site|filetype|before|after|intitle|inurl):([^\s]+)/giu, ' ')
      .replace(/\b(?:AND|OR|NOT)\b/giu, ' ')
      .replace(/["'`]+/g, ' '),
  )

  const providerQuery = collapseWhitespace(
    [normalizedQuery, ...parsedDomains.filter(domain => !normalizedQuery.includes(domain))].join(' '),
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

  const keywordOnly = collapseWhitespace(
    normalized
      .split(/\s+/u)
      .filter(token => {
        const lower = token.toLowerCase()
        return (
          token.length >= 3 &&
          ![
            'is',
            'there',
            'an',
            'app',
            'that',
            'does',
            'tool',
            'website',
            'which',
            'for',
            'can',
            'help',
            'find',
            'simple',
            'basic',
            'small',
            'easy',
          ].includes(lower)
        )
      })
      .slice(0, 6)
      .join(' '),
  )
  if (keywordOnly && keywordOnly !== normalized && keywordOnly !== stripped) {
    candidates.push(keywordOnly)
  }

  return unique(candidates)
}

function tokenizeSearchTerms(value) {
  const normalized = collapseWhitespace(String(value || '').toLowerCase())
  if (!normalized) {
    return []
  }

  return unique(
    normalized
      .match(/[a-z0-9]{2,}|[\u4e00-\u9fff]{2,}/gu) || [],
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
  const lowSignalHosts = [
    'pinterest.com',
    'facebook.com',
    'instagram.com',
    'tiktok.com',
    'quora.com',
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
  if (communityHosts.some(domain => matchesDomain(normalizedHostname, [domain]))) {
    return { category: 'community', quality: 0.64, signals: ['community-domain'] }
  }
  if (lowSignalHosts.some(domain => matchesDomain(normalizedHostname, [domain]))) {
    return { category: 'low-signal', quality: 0.34, signals: ['low-signal-domain'] }
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

  return {
    score: clampScore(score),
    signals: freshnessSignals,
  }
}

function scoreSearchQueryCoverage(queryTerms, result) {
  if (!Array.isArray(queryTerms) || queryTerms.length === 0) {
    return {
      score: 0.55,
      matchedTerms: [],
    }
  }

  const searchableText = buildSearchResultText(result).toLowerCase()
  const matchedTerms = queryTerms.filter(term => searchableText.includes(term))
  const coverageRatio = matchedTerms.length / queryTerms.length

  return {
    score: clampScore(0.25 + coverageRatio * 0.75),
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
      computeTokenJaccard(
        currentTokens,
        tokenizeSearchTerms(buildSearchResultText(entry)),
      ),
    )
  }, 0)

  const domainDiversityScore =
    sameDomainCount <= 1 ? 1 : sameDomainCount === 2 ? 0.72 : 0.45
  const noveltyScore = clampScore(domainDiversityScore * 0.6 + (1 - maxSimilarity) * 0.4)
  const signals = []

  if (sameDomainCount <= 1) {
    signals.push('new-domain')
  } else {
    signals.push('repeated-domain')
  }

  if (maxSimilarity <= 0.35) {
    signals.push('distinct-snippet')
  } else if (maxSimilarity >= 0.65) {
    signals.push('overlapping-snippet')
  }

  return {
    score: noveltyScore,
    signals,
  }
}

function rankSearchResults(results, context = {}) {
  const queryTerms = tokenizeSearchTerms(context.query)
  const preferredDomains = Array.isArray(context.domains) ? context.domains : []

  return (Array.isArray(results) ? results : [])
    .map((result, index, allResults) => {
      const hostname = extractHostname(result?.url || '')
      const domainMeta = classifySearchResultDomain(hostname, result?.url || '')
      const freshness = scoreSearchFreshness(result, context)
      const coverage = scoreSearchQueryCoverage(queryTerms, result)
      const novelty = scoreSearchNovelty(result, index, allResults)
      const preferredDomainMatch =
        preferredDomains.length > 0 && matchesDomain(hostname, preferredDomains)
      const previewComplete = Boolean(result?.title) && Boolean(result?.snippet)
      const sourceQualityScore = clampScore(
        domainMeta.quality +
          (previewComplete ? 0.04 : -0.04) +
          (preferredDomainMatch ? 0.05 : 0),
      )
      const rankScore = clampScore(
        sourceQualityScore * 0.42 +
          coverage.score * 0.28 +
          novelty.score * 0.2 +
          freshness.score * 0.1,
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
      return {
        ...publicResult,
        rank: index + 1,
      }
    })
}

function containsCjk(value) {
  return /[\u3400-\u9fff]/u.test(String(value || ''))
}

function resolveSearchProviderOrder(provider, args = {}) {
  if (provider !== 'auto') {
    return [provider]
  }

  const locale = String(args.locale || '').toLowerCase()
  const query = String(args.query || '')
  const prefersChinese = locale.startsWith('zh') || containsCjk(query)

  return prefersChinese
    ? ['baidu-html', 'bing-html', 'google-html', 'duckduckgo-html']
    : ['google-html', 'bing-html', 'duckduckgo-html', 'baidu-html']
}

function clipText(value, maxChars) {
  const text = collapseWhitespace(value)
  if (!text) {
    return ''
  }
  if (!Number.isFinite(maxChars) || maxChars <= 0 || text.length <= maxChars) {
    return text
  }
  return `${text.slice(0, maxChars).trimEnd()}...`
}

function normalizeComparableSentence(value) {
  return collapseWhitespace(String(value || '').toLowerCase())
    .replace(/[`"'“”‘’()[\]{}]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function splitIntoSentences(value) {
  const normalized = String(value || '')
    .replace(/\r/g, '\n')
    .replace(/\u00a0/g, ' ')
  const matches = normalized.match(/[^。！？.!?\n]+[。！？.!?]?/gu) || []
  return matches.map(entry => collapseWhitespace(entry)).filter(Boolean)
}

function looksLikeLowValueSentence(value) {
  const normalized = normalizeComparableSentence(value)
  if (!normalized) {
    return true
  }

  if (normalized.length < 24) {
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

function scoreEvidenceSentence(sentence, keywords = []) {
  const normalized = collapseWhitespace(sentence)
  const comparable = normalizeComparableSentence(normalized)
  const matchedKeywords = (keywords || []).filter(keyword => comparable.includes(keyword))
  const keywordCoverage =
    keywords.length > 0 ? matchedKeywords.length / keywords.length : 0.45
  const hasNumber = /\b\d[\d,.:%-]*\b|(?:20\d{2}|19\d{2})|[一二三四五六七八九十百千万亿]+/u.test(normalized)
  const hasAttribution = /\b(?:said|announced|reported|according to)\b|表示|称|宣布|根据/u.test(normalized)
  const lengthScore =
    normalized.length >= 60 && normalized.length <= 220
      ? 1
      : normalized.length >= 36 && normalized.length <= 280
        ? 0.78
        : 0.46

  const score =
    keywordCoverage * 0.45 +
    lengthScore * 0.3 +
    (hasNumber ? 0.15 : 0) +
    (hasAttribution ? 0.1 : 0)

  return {
    score: clampScore(score),
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

function buildSourceAssessment({ site, url, author, publishedAt, wordCount }) {
  const domainMeta = classifySearchResultDomain(site || extractHostname(url || ''), url || '')
  const parsedDate = publishedAt ? new Date(publishedAt) : null
  const validDate =
    parsedDate instanceof Date && Number.isFinite(parsedDate.getTime()) ? parsedDate : null
  const ageDays = validDate
    ? Math.max(0, Math.round((Date.now() - validDate.getTime()) / 86_400_000))
    : null
  const freshnessLabel =
    ageDays === null
      ? 'undated'
      : ageDays <= 30
        ? 'fresh'
        : ageDays <= 180
          ? 'recent'
          : ageDays <= 730
            ? 'aging'
            : 'old'
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

function extractHostname(targetUrl) {
  try {
    return new URL(targetUrl).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}

function decodeDuckDuckGoUrl(rawUrl) {
  const normalized = decodeHtmlEntities(String(rawUrl || '').trim())
  if (!normalized) {
    return ''
  }

  if (normalized.startsWith('//')) {
    return `https:${normalized}`
  }

  try {
    const parsed = new URL(normalized, 'https://duckduckgo.com')
    const redirected = parsed.searchParams.get('uddg')
    return redirected ? decodeURIComponent(redirected) : parsed.toString()
  } catch {
    return normalized
  }
}

function decodeBingUrl(rawUrl) {
  const normalized = decodeHtmlEntities(String(rawUrl || '').trim())
  if (!normalized) {
    return ''
  }

  try {
    const parsed = new URL(normalized, 'https://www.bing.com')
    const target = parsed.searchParams.get('u')
    if (target) {
      return decodeURIComponent(target)
    }
    return parsed.toString()
  } catch {
    return normalized
  }
}

function extractMetaContent(html, matchers) {
  for (const matcher of matchers) {
    const regex = new RegExp(
      `<meta[^>]+(?:name|property)=["']${matcher}["'][^>]+content=["']([^"']+)["'][^>]*>`,
      'iu',
    )
    const direct = html.match(regex)
    if (direct?.[1]) {
      return decodeHtmlEntities(direct[1]).trim()
    }

    const reverseRegex = new RegExp(
      `<meta[^>]+content=["']([^"']+)["'][^>]+(?:name|property)=["']${matcher}["'][^>]*>`,
      'iu',
    )
    const reverse = html.match(reverseRegex)
    if (reverse?.[1]) {
      return decodeHtmlEntities(reverse[1]).trim()
    }
  }
  return ''
}

function extractTitle(html) {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/iu)
  return match?.[1] ? collapseWhitespace(stripTags(match[1])) : ''
}

function extractTime(html) {
  const timeTag = html.match(/<time[^>]+datetime=["']([^"']+)["'][^>]*>/iu)
  if (timeTag?.[1]) {
    return timeTag[1]
  }
  return (
    extractMetaContent(html, [
      'article:published_time',
      'og:published_time',
      'pubdate',
      'date',
      'dc.date',
    ]) || ''
  )
}

function extractAuthor(html) {
  return extractMetaContent(html, ['author', 'article:author', 'parsely-author']) || ''
}

function sanitizeHtmlForExtraction(html) {
  return String(html || '')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|svg|canvas|template|iframe|noscript)[^>]*>[\s\S]*?<\/\1>/giu, ' ')
    .replace(/<(nav|footer|header|aside|form)[^>]*>[\s\S]*?<\/\1>/giu, ' ')
}

function pickHtmlContentCandidate(html) {
  const normalized = sanitizeHtmlForExtraction(html)
  const candidates = []
  const patterns = [
    /<article\b[^>]*>([\s\S]*?)<\/article>/giu,
    /<main\b[^>]*>([\s\S]*?)<\/main>/giu,
    /<section\b[^>]+(?:id|class)=["'][^"']*(?:content|article|post|main|story|entry|body)[^"']*["'][^>]*>([\s\S]*?)<\/section>/giu,
    /<div\b[^>]+(?:id|class)=["'][^"']*(?:content|article|post|main|story|entry|body)[^"']*["'][^>]*>([\s\S]*?)<\/div>/giu,
  ]

  for (const pattern of patterns) {
    let match
    while ((match = pattern.exec(normalized))) {
      if (match?.[1]) {
        candidates.push(match[1])
      }
    }
  }

  const bodyMatch = normalized.match(/<body[^>]*>([\s\S]*?)<\/body>/iu)
  if (bodyMatch?.[1]) {
    candidates.push(bodyMatch[1])
  }

  return candidates
    .map(candidate => ({ raw: candidate, length: stripTags(candidate).length }))
    .sort((left, right) => right.length - left.length)[0]?.raw || normalized
}

function htmlToMarkdownish(html) {
  return collapseWhitespace(
    decodeHtmlEntities(
      String(html || '')
        .replace(/<br\s*\/?>/giu, '\n')
        .replace(/<\/(p|div|section|article|main|blockquote|pre|tr)>/giu, '\n\n')
        .replace(/<h1[^>]*>([\s\S]*?)<\/h1>/giu, '\n# $1\n\n')
        .replace(/<h2[^>]*>([\s\S]*?)<\/h2>/giu, '\n## $1\n\n')
        .replace(/<h3[^>]*>([\s\S]*?)<\/h3>/giu, '\n### $1\n\n')
        .replace(/<h4[^>]*>([\s\S]*?)<\/h4>/giu, '\n#### $1\n\n')
        .replace(/<h5[^>]*>([\s\S]*?)<\/h5>/giu, '\n##### $1\n\n')
        .replace(/<h6[^>]*>([\s\S]*?)<\/h6>/giu, '\n###### $1\n\n')
        .replace(/<li[^>]*>([\s\S]*?)<\/li>/giu, '\n- $1')
        .replace(/<a[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/giu, '$2')
        .replace(/<[^>]+>/g, ' '),
    ),
  )
}

function looksLikeBrowserOnlyPage(html, finalUrl = '') {
  const text = collapseWhitespace(stripTags(html).toLowerCase())
  const signals = [
    'captcha',
    'verify you are human',
    'are you a robot',
    'access denied',
    'just a moment',
    'enable javascript',
    'press and hold',
    'sign in',
    'log in',
    '登录',
    '验证码',
    '人机验证',
  ]

  if (signals.some(signal => text.includes(signal))) {
    return true
  }

  if (/<input[^>]+type=["']password["']/iu.test(html)) {
    return true
  }

  return /\/login\b|\/signin\b|\/auth\b/iu.test(finalUrl)
}

function createLinkedAbortController(signal, timeoutMs, timeoutMessage, toolName) {
  const controller = new AbortController()
  const timer = setTimeout(() => {
    controller.abort(
      createStructuredError(timeoutMessage, {
        source: 'tool',
        category: 'timeout',
        code: `${toolName.toUpperCase()}_TIMEOUT`,
        detail: timeoutMessage,
        suggestedAction: '请稍后重试，或缩小本次抓取 / 搜索范围。',
      }),
    )
  }, timeoutMs)

  const abortFromParent = () => {
    controller.abort(
      createStructuredError('这一步已被用户主动停止。', {
        source: 'tool',
        category: 'cancelled',
        code: 'STEP_CANCELLED',
        detail: `Tool step cancelled: ${toolName}`,
      }),
    )
  }

  signal?.addEventListener('abort', abortFromParent, { once: true })

  return {
    signal: controller.signal,
    cleanup() {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abortFromParent)
    },
  }
}

async function fetchText(url, init, options) {
  const linked = createLinkedAbortController(
    options?.signal,
    options?.timeoutMs || DEFAULT_FETCH_TIMEOUT_MS,
    options?.timeoutMessage || '网页请求超时了。',
    options?.toolName || 'web_fetch',
  )

  try {
    const response = await fetch(url, {
      ...init,
      signal: linked.signal,
      headers: {
        'user-agent': USER_AGENT,
        accept:
          'text/html,application/xhtml+xml,text/plain,text/markdown;q=0.9,*/*;q=0.5',
        ...(init?.headers || {}),
      },
    })
    const text = await response.text()
    return { response, text }
  } catch (error) {
    if (linked.signal.aborted && linked.signal.reason) {
      throw linked.signal.reason
    }
    throw error
  } finally {
    linked.cleanup()
  }
}

function buildDuckDuckGoUrl(args) {
  const url = new URL('https://html.duckduckgo.com/html/')
  url.searchParams.set('q', args.query)

  const freshness =
    args.freshness === 'day' || args.freshness === 'week' || args.freshness === 'month' || args.freshness === 'year'
      ? args.freshness
      : ''
  const freshnessMap = {
    day: 'd',
    week: 'w',
    month: 'm',
    year: 'y',
  }
  if (freshness) {
    url.searchParams.set('df', freshnessMap[freshness])
  }

  if (typeof args.locale === 'string' && args.locale.trim()) {
    url.searchParams.set('kl', args.locale.trim().toLowerCase())
  }

  return url.toString()
}

function parseDuckDuckGoResults(html, limit) {
  const results = []
  const anchorPattern = /<a[^>]*class=["'][^"']*result__a[^"']*["'][^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/giu
  let match

  while ((match = anchorPattern.exec(html)) && results.length < limit) {
    const rawUrl = decodeDuckDuckGoUrl(match[1])
    const title = collapseWhitespace(stripTags(match[2]))
    const windowHtml = html.slice(match.index, Math.min(html.length, match.index + 2_500))
    const snippetMatch =
      windowHtml.match(/class=["'][^"']*result__snippet[^"']*["'][^>]*>([\s\S]*?)<\/(?:a|div|span)>/iu) ||
      windowHtml.match(/class=["'][^"']*result__body[^"']*["'][^>]*>[\s\S]*?<a[\s\S]*?<\/a>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/iu)
    const siteMatch = windowHtml.match(/class=["'][^"']*result__url[^"']*["'][^>]*>([\s\S]*?)<\/(?:a|span|div)>/iu)
    const snippet = collapseWhitespace(stripTags(snippetMatch?.[1] || ''))
    const siteLabel = collapseWhitespace(stripTags(siteMatch?.[1] || '')) || extractHostname(rawUrl)

    if (!title || !rawUrl) {
      continue
    }

    results.push({
      title,
      url: rawUrl,
      snippet,
      site: siteLabel || undefined,
    })
  }

  return results
}

function buildBingUrl(args) {
  const url = new URL('https://www.bing.com/search')
  url.searchParams.set('q', args.query)

  if (typeof args.locale === 'string' && args.locale.trim()) {
    url.searchParams.set('setlang', args.locale.trim().toLowerCase())
  }

  return url.toString()
}

function buildGoogleUrl(args) {
  const url = new URL('https://www.google.com/search')
  url.searchParams.set('q', args.query)

  if (typeof args.locale === 'string' && args.locale.trim()) {
    const locale = args.locale.trim().toLowerCase()
    const [language = '', region = ''] = locale.split(/[-_]/u)
    if (language) {
      url.searchParams.set('hl', language)
    }
    if (region) {
      url.searchParams.set('gl', region)
    }
  }

  if (args.freshness === 'day') {
    url.searchParams.set('tbs', 'qdr:d')
  } else if (args.freshness === 'week') {
    url.searchParams.set('tbs', 'qdr:w')
  } else if (args.freshness === 'month') {
    url.searchParams.set('tbs', 'qdr:m')
  } else if (args.freshness === 'year') {
    url.searchParams.set('tbs', 'qdr:y')
  }

  return url.toString()
}

function buildBaiduUrl(args) {
  const url = new URL('https://www.baidu.com/s')
  url.searchParams.set('wd', args.query)
  return url.toString()
}

function parseBingResults(html, limit) {
  const results = []
  const itemPattern = /<li\b[^>]*class=["'][^"']*b_algo[^"']*["'][^>]*>([\s\S]*?)<\/li>/giu
  let itemMatch

  while ((itemMatch = itemPattern.exec(html)) && results.length < limit) {
    const itemHtml = itemMatch[1]
    const anchorMatch =
      itemHtml.match(/<h2[^>]*>[\s\S]*?<a[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/iu) ||
      itemHtml.match(/<a[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/iu)
    if (!anchorMatch?.[1] || !anchorMatch?.[2]) {
      continue
    }

    const rawUrl = decodeBingUrl(anchorMatch[1])
    const title = collapseWhitespace(stripTags(anchorMatch[2]))
    const snippetMatch =
      itemHtml.match(/<p[^>]*>([\s\S]*?)<\/p>/iu) ||
      itemHtml.match(/<div[^>]*class=["'][^"']*b_caption[^"']*["'][^>]*>([\s\S]*?)<\/div>/iu)
    const snippet = collapseWhitespace(stripTags(snippetMatch?.[1] || ''))
    const siteLabel = extractHostname(rawUrl)

    if (!title || !rawUrl) {
      continue
    }

    results.push({
      title,
      url: rawUrl,
      snippet,
      site: siteLabel || undefined,
    })
  }

  return results
}

function parseGoogleResults(html, limit) {
  const results = []
  const blockPattern =
    /<div\b[^>]*class=["'][^"']*(?:g|MjjYud)[^"']*["'][^>]*>([\s\S]*?)<\/div>\s*(?=<div\b|$)/giu
  let blockMatch

  while ((blockMatch = blockPattern.exec(html)) && results.length < limit) {
    const blockHtml = blockMatch[1]
    const anchorMatch =
      blockHtml.match(/<a[^>]*href=["'](https?:\/\/[^"']+)["'][^>]*>([\s\S]*?)<\/a>/iu) ||
      blockHtml.match(/<a[^>]*href=["']\/url\?q=([^"&]+)[^"']*["'][^>]*>([\s\S]*?)<\/a>/iu)
    if (!anchorMatch?.[1] || !anchorMatch?.[2]) {
      continue
    }

    const rawUrl = decodeHtmlEntities(anchorMatch[1]).startsWith('http')
      ? decodeHtmlEntities(anchorMatch[1])
      : decodeURIComponent(anchorMatch[1])
    const title = collapseWhitespace(stripTags(anchorMatch[2]))
    const snippetMatch =
      blockHtml.match(/<div[^>]*class=["'][^"']*(?:VwiC3b|s3v9rd|yXK7lf)[^"']*["'][^>]*>([\s\S]*?)<\/div>/iu) ||
      blockHtml.match(/<span[^>]*class=["'][^"']*(?:aCOpRe|MUxGbd)[^"']*["'][^>]*>([\s\S]*?)<\/span>/iu)
    const snippet = collapseWhitespace(stripTags(snippetMatch?.[1] || ''))
    const siteLabel = extractHostname(rawUrl)

    if (!title || !rawUrl) {
      continue
    }

    results.push({
      title,
      url: rawUrl,
      snippet,
      site: siteLabel || undefined,
    })
  }

  return results
}

function parseBaiduResults(html, limit) {
  const results = []
  const itemPattern = /<div\b[^>]*class=["'][^"']*result[^"']*["'][^>]*>([\s\S]*?)<\/div>\s*(?=<div\b|$)/giu
  let itemMatch

  while ((itemMatch = itemPattern.exec(html)) && results.length < limit) {
    const itemHtml = itemMatch[1]
    const anchorMatch =
      itemHtml.match(/<h3[^>]*>[\s\S]*?<a[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/iu) ||
      itemHtml.match(/<a[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/iu)
    if (!anchorMatch?.[1] || !anchorMatch?.[2]) {
      continue
    }

    const rawUrl = decodeHtmlEntities(anchorMatch[1])
    const title = collapseWhitespace(stripTags(anchorMatch[2]))
    const snippetMatch =
      itemHtml.match(/<div[^>]*class=["'][^"']*(?:c-abstract|content-right_8Zs40|c-span-last)[^"']*["'][^>]*>([\s\S]*?)<\/div>/iu) ||
      itemHtml.match(/<span[^>]*class=["'][^"']*content-right[^"']*["'][^>]*>([\s\S]*?)<\/span>/iu)
    const snippet = collapseWhitespace(stripTags(snippetMatch?.[1] || ''))
    const siteLabel = extractHostname(rawUrl)

    if (!title || !rawUrl) {
      continue
    }

    results.push({
      title,
      url: rawUrl,
      snippet,
      site: siteLabel || undefined,
    })
  }

  return results
}

async function searchWithProvider(provider, args, runtime = {}) {
  const url =
    provider === 'bing-html'
      ? buildBingUrl(args)
      : provider === 'google-html'
        ? buildGoogleUrl(args)
        : provider === 'baidu-html'
          ? buildBaiduUrl(args)
          : buildDuckDuckGoUrl(args)
  const { response, text } = await fetchText(
    url,
    {
      method: 'GET',
      headers: {
        accept: 'text/html,application/xhtml+xml',
      },
    },
    {
      signal: runtime.signal,
      timeoutMs: DEFAULT_SEARCH_TIMEOUT_MS,
      timeoutMessage: '网页搜索超时了。',
      toolName: 'web_search',
    },
  )

  if (!response.ok) {
    throw createStructuredError('网页搜索失败，搜索 provider 没有正常返回结果。', {
      source: 'tool',
      category: response.status === 429 ? 'rate_limit' : 'network',
      code: 'WEB_SEARCH_PROVIDER_FAILED',
      status: response.status,
      detail: `web_search provider returned HTTP ${response.status}`,
      suggestedAction: '请稍后重试，或换一个更具体的查询词。',
      retryable: response.status >= 500 || response.status === 429,
    })
  }

  const rawResults =
    provider === 'bing-html'
      ? parseBingResults(text, Math.max(args.limit * 3, args.limit))
      : provider === 'google-html'
        ? parseGoogleResults(text, Math.max(args.limit * 3, args.limit))
        : provider === 'baidu-html'
          ? parseBaiduResults(text, Math.max(args.limit * 3, args.limit))
      : parseDuckDuckGoResults(text, Math.max(args.limit * 3, args.limit))

  return {
    provider,
    rawResults,
  }
}

async function runWebSearch(args, runtime = {}) {
  runtime.throwIfAborted?.()

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

  const provider =
    typeof args.provider === 'string' && args.provider.trim()
      ? args.provider.trim()
      : DEFAULT_SEARCH_PROVIDER
  if (!['auto', 'duckduckgo-html', 'bing-html', 'google-html', 'baidu-html'].includes(provider)) {
    throw createStructuredError('网页搜索失败，当前 provider 暂不支持。', {
      source: 'tool',
      category: 'unsupported',
      code: 'WEB_SEARCH_PROVIDER_NOT_CONFIGURED',
      detail: `Unsupported web_search provider: ${provider}`,
      suggestedAction:
        `请改用 provider "${DEFAULT_SEARCH_PROVIDER}"、"duckduckgo-html"、"bing-html"、"google-html" 或 "baidu-html"。`,
    })
  }

  const limit = Math.max(1, Math.min(10, Number(args.limit) || DEFAULT_SEARCH_LIMIT))
  const startedAt = Date.now()
  runtime.onUpdate?.({
    query,
    originalQuery: rawQuery !== query ? rawQuery : undefined,
    providerQuery,
    domains,
    provider,
    tookMs: 0,
    total: 0,
    results: [],
  })

  const providerOrder = resolveSearchProviderOrder(provider, {
    query: providerQuery,
    locale: args.locale,
  })
  const providerAttempts = []
  const queryCandidates = generateSearchQueryCandidates(providerQuery)
  let parsedResults = []
  let activeProvider = providerOrder[0]
  let activeQuery = providerQuery
  let anyGeneralResults = false
  let generalResultDomains = []

  outer: for (const candidateQuery of queryCandidates) {
    for (const providerName of providerOrder) {
      let attempt
      try {
        attempt = await searchWithProvider(
          providerName,
          {
            query: candidateQuery,
            freshness: args.freshness,
            locale: args.locale,
            limit,
          },
          runtime,
        )
      } catch (error) {
        providerAttempts.push({
          provider: providerName,
          providerQuery: candidateQuery,
          error:
            error?.errorInfo?.summary ||
            (error instanceof Error ? error.message : String(error)),
          rawTotal: 0,
          filteredTotal: 0,
        })
        continue
      }
      const filteredResults =
        domains.length > 0
          ? attempt.rawResults.filter(result => matchesDomain(extractHostname(result.url), domains))
          : attempt.rawResults
      const resultDomains = unique(
        attempt.rawResults.map(result => extractHostname(result.url)).filter(Boolean),
      )
      providerAttempts.push({
        provider: providerName,
        providerQuery: candidateQuery,
        rawTotal: attempt.rawResults.length,
        filteredTotal: filteredResults.length,
      })

      if (attempt.rawResults.length > 0) {
        anyGeneralResults = true
        generalResultDomains = unique([...generalResultDomains, ...resultDomains]).slice(0, 8)
      }

      if (filteredResults.length > 0) {
        parsedResults = filteredResults
        activeProvider = providerName
        activeQuery = candidateQuery
        break outer
      }

      if (attempt.rawResults.length > 0 && parsedResults.length === 0) {
        parsedResults = filteredResults
        activeProvider = providerName
        activeQuery = candidateQuery
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
          ? '可以放宽站点范围，或保留主题词后改用更自然的查询再试一次。若已经连续两次无结果，应停止继续搜索并直接说明没有找到足够公开信息。'
          : '可以换一个更自然、更宽松的查询再试一次。若已经连续两次无结果，应停止继续搜索并直接说明没有找到足够公开信息。',
      generalResultsAvailable: domains.length > 0 && anyGeneralResults,
      generalResultDomains: domains.length > 0 ? generalResultDomains : [],
    }
  }

  return {
    query,
    originalQuery: rawQuery !== query ? rawQuery : undefined,
    providerQuery: activeQuery,
    domains,
    provider: activeProvider,
    attemptedProviders: providerAttempts,
    tookMs: Date.now() - startedAt,
    total: results.length,
    results,
  }
}

function ensureSupportedFetchContentType(contentType) {
  const normalized = String(contentType || '').toLowerCase()
  if (
    normalized.includes('text/html') ||
    normalized.includes('application/xhtml+xml') ||
    normalized.includes('text/plain') ||
    normalized.includes('text/markdown') ||
    normalized.includes('text/markdown')
  ) {
    return
  }

  throw createStructuredError('网页抓取失败，当前内容类型不适合直接读取正文。', {
    source: 'tool',
    category: 'unsupported',
    code: 'WEB_FETCH_UNSUPPORTED_CONTENT',
    detail: `Unsupported content-type: ${contentType || 'unknown'}`,
    suggestedAction: '请改抓取 HTML / 文本页面，或改用浏览器工具处理需要交互的资源。',
  })
}

function buildFetchPayload({ url, finalUrl, provider, html, textContent, mode, maxChars }) {
  const site = extractHostname(finalUrl || url) || undefined
  const title = extractTitle(html) || site || url
  const description =
    extractMetaContent(html, ['description', 'og:description', 'twitter:description']) || ''
  const publishedAt = extractTime(html) || undefined
  const author = extractAuthor(html) || undefined
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
  const evidenceBlocks = buildEvidenceBlocks({
    title,
    excerpt,
    content,
  })
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

async function runWebFetch(args, runtime = {}) {
  runtime.throwIfAborted?.()

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

  const provider =
    typeof args.provider === 'string' && args.provider.trim()
      ? args.provider.trim()
      : DEFAULT_FETCH_PROVIDER
  if (provider !== DEFAULT_FETCH_PROVIDER) {
    throw createStructuredError('网页抓取失败，当前 provider 暂不支持。', {
      source: 'tool',
      category: 'unsupported',
      code: 'WEB_FETCH_PROVIDER_NOT_CONFIGURED',
      detail: `Unsupported web_fetch provider: ${provider}`,
      suggestedAction: `请改用默认 provider "${DEFAULT_FETCH_PROVIDER}"。`,
    })
  }

  const mode =
    args.mode === 'article' ||
    args.mode === 'markdown' ||
    args.mode === 'summary' ||
    args.mode === 'metadata'
      ? args.mode
      : 'article'
  const startedAt = Date.now()
  runtime.onUpdate?.({
    url: normalizedUrl,
    provider,
    title: '',
    contentFormat: mode === 'metadata' ? 'metadata' : mode === 'summary' ? 'text' : 'markdown',
    excerpt: '',
    content: '',
  })

  const { response, text } = await fetchText(
    normalizedUrl,
    {
      method: 'GET',
      redirect: 'follow',
    },
    {
      signal: runtime.signal,
      timeoutMs: DEFAULT_FETCH_TIMEOUT_MS,
      timeoutMessage: '网页抓取超时了。',
      toolName: 'web_fetch',
    },
  )

  if ([401, 403, 429].includes(response.status)) {
    throw createStructuredError('网页抓取被目标站点拦截，可能需要登录、验证或浏览器环境。', {
      source: 'tool',
      category: 'unsupported',
      code: 'WEB_FETCH_PAGE_REQUIRES_BROWSER',
      status: response.status,
      detail: `HTTP ${response.status} while fetching ${normalizedUrl}`,
      suggestedAction: '请切换到 browser_* 工具或显式要求用浏览器打开该页面。',
    })
  }

  if (!response.ok) {
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
  ensureSupportedFetchContentType(contentType)

  const finalUrl = response.url || normalizedUrl
  const isHtml =
    contentType.toLowerCase().includes('text/html') ||
    contentType.toLowerCase().includes('application/xhtml+xml')

  if (isHtml && looksLikeBrowserOnlyPage(text, finalUrl)) {
    throw createStructuredError('网页抓取检测到该页面需要浏览器交互后才能继续。', {
      source: 'tool',
      category: 'unsupported',
      code: 'WEB_FETCH_PAGE_REQUIRES_BROWSER',
      detail: `Page appears to require interactive browser access: ${finalUrl}`,
      suggestedAction: '请改用 browser_open / browser_* 工具继续，或明确要求用浏览器打开。',
    })
  }

  const html = isHtml ? text : ''
  const textContent = isHtml ? htmlToMarkdownish(pickHtmlContentCandidate(text)) : collapseWhitespace(text)
  const payload = buildFetchPayload({
    url: normalizedUrl,
    finalUrl,
    provider,
    html,
    textContent,
    mode,
    maxChars: args.maxChars,
  })

  return {
    ...payload,
    tookMs: Date.now() - startedAt,
  }
}

export function createWebTools(context = {}) {
  return [
    {
      source: 'builtin',
      name: 'web_search',
      description: 'Search the web for recent information, docs, and articles without opening a browser.',
      inputSchema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description:
              'Search query in plain natural language. Do not use search-engine operators like site:, OR, intitle:, before:, or quoted boolean syntax.',
          },
          domains: {
            type: 'array',
            items: {
              type: 'string',
            },
            description:
              'Optional preferred domains such as reddit.com or news.ycombinator.com. Prefer this instead of embedding site: operators into query.',
          },
          limit: {
            type: 'number',
            description: 'Maximum number of results to return. Defaults to 5.',
          },
          provider: {
            type: 'string',
            description:
              'Optional search provider override. One of: auto, tavily, brave, duckduckgo. Defaults to auto.',
          },
          freshness: {
            type: 'string',
            description: 'Optional freshness window: day, week, month, or year.',
          },
          locale: {
            type: 'string',
            description: 'Optional locale hint such as en-us or zh-cn.',
          },
          requireFresh: {
            type: 'boolean',
            description: 'Optional hint that fresher results are preferred.',
          },
        },
        required: ['query'],
      },
      getSummary(args) {
        const query = typeof args?.query === 'string' ? args.query.trim() : ''
        const domains = Array.isArray(args?.domains)
          ? args.domains.map(entry => normalizeDomain(entry)).filter(Boolean)
          : []
        return query
          ? `Searching the web for "${query}"${domains.length > 0 ? ` in ${domains.join(', ')}` : ''}`
          : 'Searching the web'
      },
      async run(args, runtime = {}) {
        return runStructuredWebSearch(args, {
          ...runtime,
          settings: runtime.settings || context.settings || {},
        })
      },
    },
    {
      source: 'builtin',
      name: 'web_fetch',
      description: 'Fetch a webpage over HTTP and extract its main content, summary, or metadata without opening a browser.',
      inputSchema: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: 'Page URL to fetch.',
          },
          mode: {
            type: 'string',
            description: 'One of: article, markdown, summary, metadata.',
          },
          maxChars: {
            type: 'number',
            description: 'Maximum returned content length.',
          },
          provider: {
            type: 'string',
            description: 'Optional fetch provider override. Defaults to http-readability.',
          },
          selectorHint: {
            type: 'string',
            description: 'Optional hint for future extractor improvements.',
          },
        },
        required: ['url'],
      },
      getSummary(args) {
        const url = typeof args?.url === 'string' ? args.url.trim() : ''
        return url ? `Fetching page ${url}` : 'Fetching page'
      },
      async run(args, runtime = {}) {
        return runStructuredWebFetch(args, {
          ...runtime,
          settings: runtime.settings || context.settings || {},
        })
      },
    },
  ]
}
