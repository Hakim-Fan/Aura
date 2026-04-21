import {
  runWebFetch as runStructuredWebFetch,
  runWebSearch as runStructuredWebSearch,
  runWebResearch as runStructuredWebResearch,
} from './web/index.mjs'

function normalizeDomain(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/.*$/, '')
    .replace(/^\.+|\.+$/g, '')
}

export function createWebTools(context = {}) {
  const settings = context.settings || {}
  const tools = []

  if (settings?.web?.research?.enabled !== false) {
    tools.push({
      source: 'builtin',
      name: 'web_research',
      description: 'Deeper multi-source web research that searches and automatically fetches/extracts top results in one step when quick search evidence is not enough.',
      inputSchema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Search query in plain natural language.',
          },
          domains: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional preferred domains.',
          },
          searchLimit: {
            type: 'number',
            description: 'Total search results to consider. Defaults to the configured web research depth.',
          },
          fetchLimit: {
            type: 'number',
            description: 'Number of top results to fully fetch and extract. Defaults to the configured web research depth.',
          },
          maxChars: {
            type: 'number',
            description: 'Maximum characters to extract per site. Defaults to the configured web research depth.',
          },
          depth: {
            type: 'string',
            description: 'Optional research depth. One of: auto, deep. Defaults to the current turn research mode.',
          },
          preferSearchContent: {
            type: 'boolean',
            description: 'Prefer provider-supplied page content when it is already strong enough, before issuing additional fetches.',
          },
        },
        required: ['query'],
      },
      getSummary(args) {
        const query = typeof args?.query === 'string' ? args.query.trim() : ''
        const depth =
          typeof args?.depth === 'string' && args.depth.trim().toLowerCase() === 'deep'
            ? 'deep'
            : 'standard'
        return query ? `Performing ${depth} web research for "${query}"` : 'Performing web research'
      },
      async run(args, runtime = {}) {
        return runStructuredWebResearch(args, {
          ...runtime,
          settings: runtime.settings || context.settings || {},
        })
      },
    })
  }

  if (settings?.web?.search?.enabled !== false) {
    tools.push({
      source: 'builtin',
      name: 'web_search',
      description: 'Fast first-pass web lookup for recent information, docs, and articles. It is best for lightweight discovery and can trigger deeper research when search evidence is too thin.',
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
    })
  }

  if (settings?.web?.fetch?.enabled !== false) {
    tools.push({
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
    })
  }

  return tools
}
