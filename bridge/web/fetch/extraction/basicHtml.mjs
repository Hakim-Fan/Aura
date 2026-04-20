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
        case 'ndash':
          return '-'
        case 'hellip':
          return '...'
        default:
          return match
      }
    },
  )
}

export function stripTags(value) {
  return decodeHtmlEntities(String(value || '').replace(/<[^>]+>/g, ' '))
}

export function collapseWhitespace(value) {
  return String(value || '')
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
}

export function clipText(value, maxChars) {
  const text = collapseWhitespace(value)
  if (!text) {
    return ''
  }
  if (!Number.isFinite(maxChars) || maxChars <= 0 || text.length <= maxChars) {
    return text
  }
  return `${text.slice(0, maxChars).trimEnd()}...`
}

export function extractMetaContent(html, matchers) {
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

export function extractTitle(html) {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/iu)
  return match?.[1] ? collapseWhitespace(stripTags(match[1])) : ''
}

export function extractTime(html) {
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

export function extractAuthor(html) {
  return extractMetaContent(html, ['author', 'article:author', 'parsely-author']) || ''
}

function sanitizeHtmlForExtraction(html) {
  return String(html || '')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|svg|canvas|template|iframe|noscript)[^>]*>[\s\S]*?<\/\1>/giu, ' ')
    .replace(/<(nav|footer|header|aside|form)[^>]*>[\s\S]*?<\/\1>/giu, ' ')
}

export function pickHtmlContentCandidate(html) {
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

export function htmlToMarkdownish(html) {
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
        .replace(/<a[^>]*href=["'][^"']+["'][^>]*>([\s\S]*?)<\/a>/giu, '$1')
        .replace(/<[^>]+>/g, ' '),
    ),
  )
}

export function looksLikeBrowserOnlyPage(html, finalUrl = '') {
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

export function detectJsDependentPage(html, finalUrl = '') {
  const normalizedHtml = String(html || '')
  if (!normalizedHtml.trim()) {
    return false
  }

  const text = collapseWhitespace(stripTags(normalizedHtml))
  const thinText = text.length > 0 && text.length < 700
  const rootOnly =
    /<div[^>]+id=["'](?:__next|__nuxt|root|app)["'][^>]*>\s*<\/div>/iu.test(normalizedHtml) ||
    /<main[^>]+id=["'](?:__next|__nuxt|root|app)["'][^>]*>\s*<\/main>/iu.test(normalizedHtml)
  const hydrationSignals =
    /__NEXT_DATA__|__NUXT__|window\.__INITIAL_STATE__|window\.__PRELOADED_STATE__|window\.__APOLLO_STATE__/u.test(
      normalizedHtml,
    )
  const loadingSignals =
    /class=["'][^"']*(?:skeleton|loading|spinner|placeholder|shimmer)[^"']*["']/iu.test(
      normalizedHtml,
    ) ||
    /\b(?:loading|spinner|skeleton)\b/iu.test(text)
  const scriptHeavy =
    (normalizedHtml.match(/<script\b/giu) || []).length >= 8 &&
    text.length < 1_200
  const appShellUrl = /\/app(?:\/|$)|\/dashboard(?:\/|$)|\/portal(?:\/|$)/iu.test(finalUrl)

  return (
    hydrationSignals ||
    loadingSignals ||
    (rootOnly && thinText) ||
    scriptHeavy ||
    (appShellUrl && thinText)
  )
}

export function extractBasicHtmlContent(html) {
  const candidate = pickHtmlContentCandidate(html)
  return htmlToMarkdownish(candidate)
}
