import { fetchJson } from '../../net/guardedFetch.mjs'

function normalizeLocale(locale) {
  const normalized = String(locale || '').trim().toLowerCase()
  if (!normalized) {
    return {}
  }
  const [language = '', country = ''] = normalized.split(/[-_]/u)
  return {
    search_lang: language || undefined,
    country: country || undefined,
  }
}

function buildFreshnessParam(freshness) {
  switch (freshness) {
    case 'day':
      return 'pd'
    case 'week':
      return 'pw'
    case 'month':
      return 'pm'
    case 'year':
      return 'py'
    default:
      return undefined
  }
}

function collectBraveResults(data) {
  const candidates = [
    data?.web?.results,
    data?.results,
    data?.web?.items,
  ]
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      return candidate
    }
  }
  return []
}

export function createBraveSearchProvider() {
  return {
    id: 'brave',
    label: 'Brave Search API',
    requiresCredential: true,
    isConfigured(settings) {
      return Boolean(settings?.web?.search?.providers?.braveApiKey?.trim())
    },
    async search(args, runtime = {}) {
      const apiKey = runtime.settings?.web?.search?.providers?.braveApiKey?.trim()
      if (!apiKey) {
        throw new Error('Brave Search API key is not configured')
      }

      const url = new URL('https://api.search.brave.com/res/v1/web/search')
      url.searchParams.set('q', args.query)
      url.searchParams.set('count', String(args.limit))
      url.searchParams.set('safesearch', 'moderate')
      const localeParams = normalizeLocale(args.locale)
      if (localeParams.search_lang) {
        url.searchParams.set('search_lang', localeParams.search_lang)
      }
      if (localeParams.country) {
        url.searchParams.set('country', localeParams.country)
      }
      const freshness = buildFreshnessParam(args.freshness)
      if (freshness) {
        url.searchParams.set('freshness', freshness)
      }

      const { response, data } = await fetchJson(
        url.toString(),
        {
          method: 'GET',
          headers: {
            Accept: 'application/json',
            'X-Subscription-Token': apiKey,
          },
        },
        {
          signal: runtime.signal,
          timeoutMs: args.timeoutMs,
        },
      )

      if (!response.ok) {
        throw new Error(`Brave search failed with HTTP ${response.status}`)
      }

      return {
        provider: 'brave',
        rawResults: collectBraveResults(data)
          .map(entry => ({
            title: typeof entry?.title === 'string' ? entry.title.trim() : '',
            url: typeof entry?.url === 'string' ? entry.url : '',
            snippet:
              typeof entry?.description === 'string'
                ? entry.description.trim()
                : typeof entry?.snippet === 'string'
                  ? entry.snippet.trim()
                  : '',
            site:
              typeof entry?.meta_url?.hostname === 'string'
                ? entry.meta_url.hostname
                : typeof entry?.url === 'string'
                  ? (() => {
                      try {
                        return new URL(entry.url).hostname.replace(/^www\./u, '')
                      } catch {
                        return undefined
                      }
                    })()
                  : undefined,
            publishedAt:
              typeof entry?.age === 'string'
                ? entry.age
                : typeof entry?.page_age === 'string'
                  ? entry.page_age
                  : undefined,
          }))
          .filter(entry => entry.title && entry.url),
      }
    },
  }
}
