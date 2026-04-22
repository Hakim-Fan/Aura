import { fetchText } from '../../net/guardedFetch.mjs'

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

function stripTags(value) {
  return decodeHtmlEntities(String(value || '').replace(/<[^>]+>/g, ' '))
}

function collapseWhitespace(value) {
  return String(value || '')
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
}

function extractHostname(value) {
  try {
    return new URL(value).hostname.replace(/^www\./u, '').toLowerCase()
  } catch {
    return ''
  }
}

function decodeDuckDuckGoUrl(rawUrl) {
  try {
    const normalized = rawUrl.startsWith('//') ? `https:${rawUrl}` : rawUrl
    const parsed = new URL(normalized)
    const uddg = parsed.searchParams.get('uddg')
    return uddg || rawUrl
  } catch {
    return rawUrl
  }
}

function buildDuckDuckGoUrl(args) {
  const url = new URL('https://html.duckduckgo.com/html/')
  url.searchParams.set('q', args.query)

  const freshnessMap = {
    day: 'd',
    week: 'w',
    month: 'm',
    year: 'y',
  }
  if (args.freshness && freshnessMap[args.freshness]) {
    url.searchParams.set('df', freshnessMap[args.freshness])
  }

  if (typeof args.locale === 'string' && args.locale.trim()) {
    url.searchParams.set('kl', args.locale.trim().toLowerCase())
  }

  return url.toString()
}

function isBotChallenge(html) {
  if (/class="[^"]*\bresult__a\b[^"]*"/iu.test(html)) {
    return false
  }
  return /g-recaptcha|are you a human|id="challenge-form"|name="challenge"|anomaly/iu.test(html)
}

function parseDuckDuckGoResults(html, limit) {
  const results = []
  const anchorPattern =
    /<a[^>]*class=["'][^"']*result__a[^"']*["'][^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/giu
  let match

  while ((match = anchorPattern.exec(html)) && results.length < limit) {
    const rawUrl = decodeDuckDuckGoUrl(match[1])
    const title = collapseWhitespace(stripTags(match[2]))
    const windowHtml = html.slice(match.index, Math.min(html.length, match.index + 2500))
    const snippetMatch =
      windowHtml.match(
        /class=["'][^"']*result__snippet[^"']*["'][^>]*>([\s\S]*?)<\/(?:a|div|span)>/iu,
      ) ||
      windowHtml.match(
        /class=["'][^"']*result__body[^"']*["'][^>]*>[\s\S]*?<a[\s\S]*?<\/a>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/iu,
      )
    const siteMatch =
      windowHtml.match(/class=["'][^"']*result__url[^"']*["'][^>]*>([\s\S]*?)<\/(?:a|span|div)>/iu)
    const snippet = collapseWhitespace(stripTags(snippetMatch?.[1] || ''))
    const site = collapseWhitespace(stripTags(siteMatch?.[1] || '')) || extractHostname(rawUrl)

    if (!title || !rawUrl) {
      continue
    }

    results.push({
      title,
      url: rawUrl,
      snippet,
      site: site || undefined,
    })
  }

  return results
}

export function createDuckDuckGoSearchProvider() {
  return {
    id: 'duckduckgo',
    label: 'DuckDuckGo',
    requiresCredential: false,
    isConfigured() {
      return true
    },
    async search(args, runtime = {}) {
      const { response, text } = await fetchText(
        buildDuckDuckGoUrl(args),
        {
          method: 'GET',
          headers: {
            accept: 'text/html,application/xhtml+xml',
          },
        },
        {
          signal: runtime.signal,
          timeoutMs: args.timeoutMs,
          maxRedirects: 3,
          settings: runtime.settings,
          proxyMode: 'web-auto',
        },
      )

      if (!response.ok) {
        throw new Error(`DuckDuckGo search failed with HTTP ${response.status}`)
      }
      if (isBotChallenge(text)) {
        throw new Error('DuckDuckGo returned a bot-detection challenge')
      }

      return {
        provider: 'duckduckgo',
        rawResults: parseDuckDuckGoResults(text, Math.max(args.limit * 3, args.limit)),
      }
    },
  }
}
