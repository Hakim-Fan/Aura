import { createStructuredError } from '../../runtimeErrors.mjs'
import { guardedFetch, readResponseText } from '../net/guardedFetch.mjs'
import {
  clipText,
  collapseWhitespace,
  extractAuthor,
  extractBasicHtmlContent,
  extractMetaContent,
  extractTime,
  extractTitle,
  looksLikeBrowserOnlyPage,
  stripTags,
} from './extraction/basicHtml.mjs'
import { extractReadableContent } from './extraction/readability.mjs'

const DEFAULT_FETCH_TIMEOUT_MS = 15_000
const DEFAULT_FETCH_MAX_CHARS = 20_000
const DEFAULT_FETCH_MAX_RESPONSE_BYTES = 750_000
const DEFAULT_FETCH_MAX_REDIRECTS = 3

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

function ensureSupportedFetchContentType(contentType) {
  const normalized = String(contentType || '').toLowerCase()
  if (
    normalized.includes('text/html') ||
    normalized.includes('application/xhtml+xml') ||
    normalized.includes('text/plain') ||
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

export async function runWebFetch(args, runtime = {}) {
  runtime.throwIfAborted?.()
  const settings = runtime.settings || {}
  const fetchSettings = resolveFetchSettings(settings)

  if (fetchSettings.enabled === false) {
    throw createStructuredError('网页抓取当前已在设置中关闭。', {
      source: 'tool',
      category: 'unsupported',
      code: 'WEB_FETCH_DISABLED',
      suggestedAction: '请在设置中重新启用 Web Fetch，或改用浏览器工具。',
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
  const startedAt = Date.now()

  runtime.onUpdate?.({
    url: normalizedUrl,
    provider,
    title: '',
    contentFormat: mode === 'metadata' ? 'metadata' : mode === 'summary' ? 'text' : 'markdown',
    excerpt: '',
    content: '',
  })

  const response = await guardedFetch(
    normalizedUrl,
    {
      method: 'GET',
      redirect: 'follow',
    },
    {
      signal: runtime.signal,
      timeoutMs: fetchSettings.timeoutMs,
      maxRedirects: fetchSettings.maxRedirects,
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
  const text = await readResponseText(response, fetchSettings.maxResponseBytes)
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
  const extractionMode = mode === 'summary' ? 'text' : 'markdown'
  const readabilityResult =
    isHtml && fetchSettings.readability
      ? await extractReadableContent(html, extractionMode)
      : null
  const textContent = isHtml
    ? readabilityResult?.content || extractBasicHtmlContent(text)
    : collapseWhitespace(stripTags(text))

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

  return {
    ...payload,
    tookMs: Date.now() - startedAt,
  }
}
