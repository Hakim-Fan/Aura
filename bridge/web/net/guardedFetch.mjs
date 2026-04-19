const DEFAULT_TIMEOUT_MS = 15_000
const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36 AuraWebTools/2.0'

function isLocalHostname(hostname) {
  const normalized = String(hostname || '').trim().toLowerCase()
  if (!normalized) {
    return true
  }
  if (
    normalized === 'localhost' ||
    normalized === '0.0.0.0' ||
    normalized === '127.0.0.1' ||
    normalized === '::1'
  ) {
    return true
  }
  if (/^127\./u.test(normalized) || /^10\./u.test(normalized) || /^192\.168\./u.test(normalized)) {
    return true
  }
  const match = normalized.match(/^172\.(\d{1,3})\./u)
  if (match) {
    const segment = Number(match[1])
    if (segment >= 16 && segment <= 31) {
      return true
    }
  }
  return false
}

function createLinkedAbortSignal(parentSignal, timeoutMs) {
  const controller = new AbortController()
  const timer = setTimeout(() => {
    controller.abort(new Error(`Request timed out after ${timeoutMs}ms`))
  }, timeoutMs)

  const abortFromParent = () => controller.abort(parentSignal?.reason || new Error('Request aborted'))
  parentSignal?.addEventListener('abort', abortFromParent, { once: true })

  return {
    signal: controller.signal,
    cleanup() {
      clearTimeout(timer)
      parentSignal?.removeEventListener('abort', abortFromParent)
    },
  }
}

export async function guardedFetch(url, init = {}, options = {}) {
  const linked = createLinkedAbortSignal(
    options.signal,
    Math.max(1000, Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS),
  )
  try {
    const maxRedirects = Math.max(0, Number(options.maxRedirects) || 0)
    let currentUrl = new URL(url)
    let redirects = 0

    // Extract proxy from options or settings
    const proxy = options.networkProxy || options.settings?.networkProxy || options.settings?.web?.networkProxy
    let agent = undefined

    if (proxy) {
      try {
        // Try to dynamic import https-proxy-agent
        // Using a dynamic import so we don't crash if the dependency is missing
        const { HttpsProxyAgent } = await import('https-proxy-agent')
        agent = new HttpsProxyAgent(proxy)
      } catch (err) {
        console.warn('Proxy configured but https-proxy-agent not found or failed to load. Falling back to direct connection.')
      }
    }

    while (true) {
      if (!['http:', 'https:'].includes(currentUrl.protocol)) {
        throw new Error(`Unsupported URL protocol: ${currentUrl.protocol}`)
      }
      if (options.allowLocal !== true && isLocalHostname(currentUrl.hostname)) {
        throw new Error(`Blocked local or private URL: ${currentUrl.hostname}`)
      }

      const fetchInit = {
        ...init,
        signal: linked.signal,
        redirect: 'manual',
        headers: {
          'user-agent': DEFAULT_USER_AGENT,
          accept: 'application/json,text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5',
          'accept-encoding': 'gzip, deflate, br',
          ...(init.headers || {}),
        },
      }

      // In Node.js environment, the dispatcher/agent is set differently for native fetch
      // If we are using undici (Node 18+ native fetch), it uses 'dispatcher'
      // If we are using node-fetch, it uses 'agent'
      if (agent) {
        // We'll set both to be safe, though native fetch needs Dispatcher for undici
        // HttpsProxyAgent is usually for the 'agent' field.
        fetchInit.agent = agent
        fetchInit.dispatcher = agent // undici supports some agent-like objects as dispatchers
      }

      const response = await fetch(currentUrl, fetchInit)

      if (![301, 302, 303, 307, 308].includes(response.status)) {
        return response
      }

      if (redirects >= maxRedirects) {
        throw new Error(`Too many redirects while fetching ${currentUrl.toString()}`)
      }

      const location = response.headers.get('location')
      if (!location) {
        return response
      }
      response.body?.cancel?.().catch?.(() => {})
      currentUrl = new URL(location, currentUrl)
      redirects += 1
    }
  } finally {
    linked.cleanup()
  }
}

export async function fetchJson(url, init = {}, options = {}) {
  const response = await guardedFetch(
    url,
    {
      ...init,
      headers: {
        accept: 'application/json',
        ...(init.headers || {}),
      },
    },
    options,
  )
  return {
    response,
    data: await response.json(),
  }
}

import { gunzipSync, inflateSync, brotliDecompressSync } from 'node:zlib'

export async function fetchText(url, init = {}, options = {}) {
  const response = await guardedFetch(url, init, options)
  const text = await readResponseText(response, options.maxBytes || options.maxCharsCap)
  return {
    response,
    text,
  }
}

export async function readResponseText(response, maxBytes = 750_000) {
  const safeMaxBytes = Math.max(1_024, Number(maxBytes) || 750_000)
  const buffer = await response.arrayBuffer()
  
  if (buffer.byteLength > safeMaxBytes) {
    throw new Error(`Response too large: ${buffer.byteLength} bytes exceeds limit ${safeMaxBytes}`)
  }

  const encoding = (response.headers.get('content-encoding') || '').toLowerCase()
  let decompressed = Buffer.from(buffer)
  
  try {
    if (encoding === 'gzip') {
      decompressed = gunzipSync(decompressed)
    } else if (encoding === 'deflate') {
      decompressed = inflateSync(decompressed)
    } else if (encoding === 'br') {
      decompressed = brotliDecompressSync(decompressed)
    }
  } catch (err) {
    console.error(`Decompression failed (${encoding}):`, err.message)
    // Fallback to original buffer if decompression fails
  }

  const contentType = response.headers.get('content-type') || ''
  const charsetMatch = contentType.match(/charset=([^;]+)/iu)
  const charset = charsetMatch?.[1]?.trim() || 'utf-8'
  try {
    return new TextDecoder(charset).decode(decompressed)
  } catch {
    return new TextDecoder('utf-8').decode(decompressed)
  }
}
