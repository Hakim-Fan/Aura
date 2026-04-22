import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { Readable } from 'node:stream'
import { brotliDecompressSync, gunzipSync, inflateSync } from 'node:zlib'

const DEFAULT_TIMEOUT_MS = 15_000
const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36 AuraWebTools/2.0'
const WEB_AUTO_PROXY_RETRYABLE_STATUS = new Set([403, 408, 421, 425, 429, 451, 500, 502, 503, 504])

function readTrimmedString(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function proxyModeLabel(mode) {
  switch (mode) {
    case 'always':
      return 'proxy'
    case 'direct':
      return 'direct'
    case 'web-auto':
      return 'web-auto'
    default:
      return 'provider-explicit'
  }
}

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

function createLinkedAbortSignal(parentSignal, timeoutMs, timeoutMessage) {
  const controller = new AbortController()
  const timer = setTimeout(() => {
    controller.abort(new Error(timeoutMessage || `Request timed out after ${timeoutMs}ms`))
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

export function resolveProxyAddress(options = {}) {
  const explicitProxy = readTrimmedString(options.networkProxy)
  if (explicitProxy) {
    return explicitProxy
  }

  const settings = options.settings || {}
  return readTrimmedString(settings.networkProxy) || readTrimmedString(settings.web?.networkProxy)
}

export function isProviderProxyEnabled(settings = {}) {
  if (typeof settings.providerProxyEnabled === 'boolean') {
    return settings.providerProxyEnabled
  }
  if (typeof settings.networkProxyEnabled === 'boolean') {
    return settings.networkProxyEnabled
  }
  return resolveProxyAddress({ settings }).length > 0
}

export function resolveConfiguredProxy(options = {}) {
  const proxy = resolveProxyAddress(options)
  if (!proxy) {
    return ''
  }

  const mode = proxyModeLabel(options.proxyMode)
  if (mode === 'always') {
    return proxy
  }
  if (mode === 'direct' || mode === 'web-auto') {
    return ''
  }
  return isProviderProxyEnabled(options.settings || {}) ? proxy : ''
}

export function buildProxyEnvironment(options = {}, baseEnv = process.env) {
  const settings = options.settings || {}
  const explicitProxySupplied = typeof options.networkProxy === 'string'
  const explicitProxyToggle =
    typeof settings.providerProxyEnabled === 'boolean' ||
    typeof settings.networkProxyEnabled === 'boolean'
  const explicitProxyMode = typeof options.proxyMode === 'string'
  const shouldOverrideEnv = explicitProxySupplied || explicitProxyToggle || explicitProxyMode
  const nextEnv = { ...baseEnv }

  if (!shouldOverrideEnv) {
    return nextEnv
  }

  const proxy = resolveConfiguredProxy(options)
  const proxyKeys = [
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'ALL_PROXY',
    'http_proxy',
    'https_proxy',
    'all_proxy',
  ]

  if (!proxy) {
    for (const key of proxyKeys) {
      delete nextEnv[key]
    }
    return nextEnv
  }

  for (const key of proxyKeys) {
    nextEnv[key] = proxy
  }
  return nextEnv
}

function shouldRetryWebAutoWithProxy(error) {
  const detail = error instanceof Error ? error.message : String(error || '')
  const normalized = detail.toLowerCase()
  return [
    'fetch failed',
    'timeout',
    'timed out',
    'econnreset',
    'econnrefused',
    'enotfound',
    'eai_again',
    'socket hang up',
    'network',
    'client network socket disconnected',
    'ssl',
    'tls',
    'certificate',
  ].some(pattern => normalized.includes(pattern))
}

function shouldRetryWebAutoResponseWithProxy(response) {
  return WEB_AUTO_PROXY_RETRYABLE_STATUS.has(Number(response?.status) || 0)
}

function normalizeRequestBody(body) {
  if (body == null) {
    return null
  }
  if (typeof body === 'string' || Buffer.isBuffer(body)) {
    return body
  }
  if (body instanceof Uint8Array) {
    return Buffer.from(body)
  }
  if (body instanceof ArrayBuffer) {
    return Buffer.from(body)
  }
  throw new Error('Unsupported request body type for proxy-backed fetch.')
}

function createResponseFromIncomingMessage(message) {
  const headers = new Headers()
  for (const [key, value] of Object.entries(message.headers || {})) {
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item != null) {
          headers.append(key, String(item))
        }
      }
      continue
    }
    if (value != null) {
      headers.set(key, String(value))
    }
  }

  return new Response(Readable.toWeb(message), {
    status: message.statusCode || 500,
    statusText: message.statusMessage || '',
    headers,
  })
}

async function createProxyAgent(proxy) {
  try {
    const { HttpsProxyAgent } = await import('https-proxy-agent')
    return new HttpsProxyAgent(proxy)
  } catch (error) {
    throw new Error(
      `Failed to initialize proxy agent for ${proxy}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
  }
}

async function fetchThroughProxy(url, init, signal, proxyAgent) {
  const headers = new Headers(init.headers || {})
  if (!headers.has('accept-encoding')) {
    headers.set('accept-encoding', 'identity')
  }

  const body = normalizeRequestBody(init.body)
  if (body && !headers.has('content-length')) {
    headers.set('content-length', String(Buffer.byteLength(body)))
  }

  const requestImpl = url.protocol === 'https:' ? httpsRequest : httpRequest

  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason || new Error('Request aborted'))
      return
    }

    const request = requestImpl(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || undefined,
        path: `${url.pathname}${url.search}`,
        method: init.method || 'GET',
        headers: Object.fromEntries(headers.entries()),
        agent: proxyAgent,
      },
      response => {
        resolve(createResponseFromIncomingMessage(response))
      },
    )

    const abortRequest = () => {
      request.destroy(signal?.reason || new Error('Request aborted'))
    }

    signal?.addEventListener('abort', abortRequest, { once: true })
    request.on('error', reject)
    request.on('close', () => {
      signal?.removeEventListener('abort', abortRequest)
    })

    if (body) {
      request.write(body)
    }
    request.end()
  })
}

async function executeSingleFetch(url, init, signal, proxy) {
  if (proxy) {
    const proxyInit = {
      ...init,
      headers: {
        ...(init.headers || {}),
        'accept-encoding': 'identity',
      },
    }
    const proxyAgent = await createProxyAgent(proxy)
    return fetchThroughProxy(url, proxyInit, signal, proxyAgent)
  }

  try {
    return await fetch(url, {
      ...init,
      signal,
    })
  } catch (error) {
    if (signal?.aborted) {
      throw signal.reason || error
    }
    throw error
  }
}

export async function guardedFetch(url, init = {}, options = {}) {
  const linked = createLinkedAbortSignal(
    options.signal,
    Math.max(1000, Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS),
    options.timeoutMessage,
  )
  try {
    const maxRedirects = Math.max(0, Number(options.maxRedirects) || 0)
    let currentUrl = new URL(url)
    let redirects = 0
    const proxyMode = proxyModeLabel(options.proxyMode)
    const proxyAddress = resolveProxyAddress(options)
    const fixedProxy = resolveConfiguredProxy({ ...options, proxyMode })

    while (true) {
      if (!['http:', 'https:'].includes(currentUrl.protocol)) {
        throw new Error(`Unsupported URL protocol: ${currentUrl.protocol}`)
      }
      if (options.allowLocal !== true && isLocalHostname(currentUrl.hostname)) {
        throw new Error(`Blocked local or private URL: ${currentUrl.hostname}`)
      }

      const fetchInit = {
        ...init,
        redirect: 'manual',
        headers: {
          'user-agent': DEFAULT_USER_AGENT,
          accept: 'application/json,text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5',
          'accept-encoding':
            proxyMode === 'always' || fixedProxy ? 'identity' : 'gzip, deflate, br',
          ...(init.headers || {}),
        },
      }

      let response
      if (proxyMode === 'web-auto') {
        try {
          response = await executeSingleFetch(currentUrl, fetchInit, linked.signal, '')
        } catch (directError) {
          if (!proxyAddress || !shouldRetryWebAutoWithProxy(directError)) {
            throw directError
          }
          try {
            response = await executeSingleFetch(currentUrl, fetchInit, linked.signal, proxyAddress)
          } catch (proxyError) {
            const combined = new Error(
              `Direct request failed: ${
                directError instanceof Error ? directError.message : String(directError)
              }\nProxy retry failed: ${
                proxyError instanceof Error ? proxyError.message : String(proxyError)
              }`,
            )
            combined.cause = proxyError
            throw combined
          }
        }

        if (proxyAddress && shouldRetryWebAutoResponseWithProxy(response)) {
          const directResponse = response
          try {
            response = await executeSingleFetch(currentUrl, fetchInit, linked.signal, proxyAddress)
            directResponse.body?.cancel?.().catch?.(() => {})
          } catch {
            response = directResponse
          }
        }
      } else {
        response = await executeSingleFetch(currentUrl, fetchInit, linked.signal, fixedProxy)
      }

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
