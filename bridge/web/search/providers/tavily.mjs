import { fetchJson } from '../../net/guardedFetch.mjs'

function resolveSnippet(entry) {
  const candidates = [entry?.content, entry?.snippet, entry?.raw_content]
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate.trim()
    }
  }
  return ''
}

export function createTavilySearchProvider() {
  return {
    id: 'tavily',
    label: 'Tavily',
    requiresCredential: true,
    isConfigured(settings) {
      return Boolean(settings?.web?.search?.providers?.tavilyApiKey?.trim())
    },
    async search(args, runtime = {}) {
      const apiKey = runtime.settings?.web?.search?.providers?.tavilyApiKey?.trim()
      if (!apiKey) {
        throw new Error('Tavily API key is not configured')
      }

      const body = {
        api_key: apiKey,
        query: args.query,
        max_results: args.limit,
        search_depth: 'basic',
        include_answer: 'basic',
        include_raw_content: 'text',
        ...(Array.isArray(args.domains) && args.domains.length > 0
          ? { include_domains: args.domains }
          : {}),
        ...(args.freshness ? { time_range: args.freshness } : {}),
      }

      const { response, data } = await fetchJson(
        'https://api.tavily.com/search',
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
          },
          body: JSON.stringify(body),
        },
        {
          signal: runtime.signal,
          timeoutMs: args.timeoutMs,
        },
      )

      if (!response.ok) {
        throw new Error(`Tavily search failed with HTTP ${response.status}`)
      }

      return {
        provider: 'tavily',
        answer: typeof data?.answer === 'string' ? data.answer : '',
        rawResults: Array.isArray(data?.results)
          ? data.results
              .map(entry => ({
                title: typeof entry?.title === 'string' ? entry.title.trim() : '',
                url: typeof entry?.url === 'string' ? entry.url : '',
                snippet: resolveSnippet(entry),
                site:
                  typeof entry?.url === 'string'
                    ? (() => {
                        try {
                          return new URL(entry.url).hostname.replace(/^www\./u, '')
                        } catch {
                          return undefined
                        }
                      })()
                    : undefined,
                publishedAt:
                  typeof entry?.published_date === 'string' ? entry.published_date : undefined,
                content: typeof entry?.raw_content === 'string' ? entry.raw_content : undefined,
              }))
              .filter(entry => entry.title && entry.url)
          : [],
      }
    },
  }
}
