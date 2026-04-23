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

export function buildCloudFetchCacheHint(access = {}) {
  return {
    enabled: access?.enabled === true,
    authMode: access?.authMode || 'none',
  }
}
