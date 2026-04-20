function readBooleanSetting(value, fallback = false) {
  return typeof value === 'boolean' ? value : fallback
}

export function resolveCloudFetchProviderAccess(settings, descriptor = {}) {
  const providerSettings = settings?.web?.fetch?.providers || {}
  const enabled = readBooleanSetting(
    providerSettings?.[descriptor.enabledKey],
    descriptor.defaultEnabled === true,
  )
  const apiKey = String(providerSettings?.[descriptor.apiKeyKey] || '').trim()
  const allowAnonymous = readBooleanSetting(
    providerSettings?.[descriptor.allowAnonymousKey],
    descriptor.defaultAllowAnonymous === true,
  )
  const authMode = apiKey ? 'api-key' : allowAnonymous ? 'anonymous' : 'none'

  return {
    providerId: descriptor.id || 'cloud-fetch-provider',
    providerName: descriptor.name || descriptor.id || 'Cloud Fetch Provider',
    enabled,
    apiKey,
    allowAnonymous,
    authMode,
    usable: enabled && authMode !== 'none',
  }
}

export function buildCloudFetchHeaders(access, baseHeaders = {}) {
  const headers = {
    ...baseHeaders,
  }
  if (access?.apiKey) {
    headers.authorization = `Bearer ${access.apiKey}`
  }
  return headers
}

export function getCloudFetchRuntimeState(runtime = {}) {
  if (!runtime.__cloudFetchState || typeof runtime.__cloudFetchState !== 'object') {
    runtime.__cloudFetchState = {
      blockedProviders: {},
    }
  }

  if (
    !runtime.__cloudFetchState.blockedProviders ||
    typeof runtime.__cloudFetchState.blockedProviders !== 'object'
  ) {
    runtime.__cloudFetchState.blockedProviders = {}
  }

  return runtime.__cloudFetchState
}

export function getCloudFetchProviderAvailability(runtime = {}, access = {}) {
  const state = getCloudFetchRuntimeState(runtime)
  const blocked =
    access?.providerId && state.blockedProviders?.[access.providerId]
      ? state.blockedProviders[access.providerId]
      : null

  return {
    blocked,
    usable: access?.usable === true && !blocked,
  }
}

export function markCloudFetchProviderBlocked(runtime = {}, access = {}, failure = {}) {
  if (!access?.providerId) {
    return null
  }

  const state = getCloudFetchRuntimeState(runtime)
  state.blockedProviders[access.providerId] = {
    code: typeof failure?.code === 'string' ? failure.code : 'CLOUD_FETCH_PROVIDER_BLOCKED',
    summary:
      typeof failure?.summary === 'string' && failure.summary.trim()
        ? failure.summary.trim()
        : `${access.providerName || access.providerId} 当前不可用`,
    detail:
      typeof failure?.detail === 'string' && failure.detail.trim()
        ? failure.detail.trim()
        : '',
    blockedAt: Date.now(),
  }
  return state.blockedProviders[access.providerId]
}

export function buildCloudFetchCacheHint(runtime = {}, access = {}) {
  const availability = getCloudFetchProviderAvailability(runtime, access)
  return {
    enabled: access?.enabled === true,
    authMode: access?.authMode || 'none',
    blockedCode: availability.blocked?.code || '',
  }
}
