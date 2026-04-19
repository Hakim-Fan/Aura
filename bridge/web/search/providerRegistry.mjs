import { createBraveSearchProvider } from './providers/brave.mjs'
import { createDuckDuckGoSearchProvider } from './providers/duckduckgo.mjs'
import { createTavilySearchProvider } from './providers/tavily.mjs'

const ALL_SEARCH_PROVIDERS = [
  createTavilySearchProvider(),
  createBraveSearchProvider(),
  createDuckDuckGoSearchProvider(),
]

export function listWebSearchProviders() {
  return ALL_SEARCH_PROVIDERS.slice()
}

export function resolveWebSearchProviderOrder(settings, explicitProvider = '') {
  const normalizedExplicit = String(explicitProvider || '').trim()
  const configuredProvider = String(settings?.web?.search?.provider || 'auto').trim()

  if (normalizedExplicit && normalizedExplicit !== 'auto') {
    return ALL_SEARCH_PROVIDERS.filter(provider => provider.id === normalizedExplicit)
  }

  if (configuredProvider && configuredProvider !== 'auto') {
    const configured = ALL_SEARCH_PROVIDERS.find(provider => provider.id === configuredProvider)
    return configured ? [configured] : []
  }

  const tavily = ALL_SEARCH_PROVIDERS.find(provider => provider.id === 'tavily')
  const brave = ALL_SEARCH_PROVIDERS.find(provider => provider.id === 'brave')
  const ddg = ALL_SEARCH_PROVIDERS.find(provider => provider.id === 'duckduckgo')
  const ordered = [tavily, brave, ddg].filter(Boolean)

  return [
    ...ordered.filter(provider => provider.isConfigured(settings)),
    ...ordered.filter(provider => !provider.isConfigured(settings)),
  ]
}
