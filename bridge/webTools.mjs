import { createStructuredError } from './runtimeErrors.mjs'

const DEFAULT_SEARCH_PROVIDER = 'duckduckgo-html'
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

async function runWebSearch(args, runtime = {}) {
  runtime.throwIfAborted?.()

  const query = typeof args.query === 'string' ? args.query.trim() : ''
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
  if (provider !== DEFAULT_SEARCH_PROVIDER) {
    throw createStructuredError('网页搜索失败，当前 provider 暂不支持。', {
      source: 'tool',
      category: 'unsupported',
      code: 'WEB_SEARCH_PROVIDER_NOT_CONFIGURED',
      detail: `Unsupported web_search provider: ${provider}`,
      suggestedAction: `请改用默认 provider "${DEFAULT_SEARCH_PROVIDER}"，或后续再扩展新的 provider。`,
    })
  }

  const limit = Math.max(1, Math.min(10, Number(args.limit) || DEFAULT_SEARCH_LIMIT))
  const startedAt = Date.now()
  runtime.onUpdate?.({
    query,
    provider,
    tookMs: 0,
    total: 0,
    results: [],
  })

  const { response, text } = await fetchText(
    buildDuckDuckGoUrl({
      query,
      freshness: args.freshness,
      locale: args.locale,
    }),
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

  const results = parseDuckDuckGoResults(text, limit)
  if (results.length === 0) {
    throw createStructuredError('网页搜索没有找到结果。', {
      source: 'tool',
      category: 'not_found',
      code: 'WEB_SEARCH_NO_RESULTS',
      detail: `No search results parsed for query: ${query}`,
      suggestedAction: '请尝试换一个更具体、带英文关键词或带站点名的查询词。',
    })
  }

  return {
    query,
    provider,
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
      tookMs: 0,
    }
  }

  const contentLimit = Math.max(400, Math.min(20_000, Number(maxChars) || DEFAULT_FETCH_MAX_CHARS))
  const content =
    mode === 'summary'
      ? clipText(excerptSource, Math.min(contentLimit, 1_200))
      : clipText(textContent, contentLimit)

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
    wordCount: countWords(content),
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

export function createWebTools() {
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
            description: 'Search query.',
          },
          limit: {
            type: 'number',
            description: 'Maximum number of results to return. Defaults to 5.',
          },
          provider: {
            type: 'string',
            description: 'Optional search provider override. Defaults to duckduckgo-html.',
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
        return query ? `Searching the web for "${query}"` : 'Searching the web'
      },
      async run(args, runtime = {}) {
        return runWebSearch(args, runtime)
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
        return runWebFetch(args, runtime)
      },
    },
  ]
}
