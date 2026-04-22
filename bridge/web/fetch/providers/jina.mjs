import { createStructuredError } from '../../../runtimeErrors.mjs'
import { guardedFetch, readResponseText } from '../../net/guardedFetch.mjs'
import { collapseWhitespace } from '../extraction/basicHtml.mjs'
import {
  buildCloudFetchHeaders,
  getCloudFetchProviderAvailability,
  markCloudFetchProviderBlocked,
  resolveCloudFetchProviderAccess,
} from './cloudAccess.mjs'

const JINA_READER_PREFIX = 'https://r.jina.ai/'
const JINA_MIN_INTERVAL_MS = 1_500
const JINA_RUNTIME_BLOCK_CODES = new Set([
  'JINA_FETCH_RATE_LIMITED',
  'JINA_FETCH_QUOTA_EXCEEDED',
  'JINA_FETCH_ANONYMOUS_FORBIDDEN',
  'JINA_FETCH_AUTH_FAILED',
  'JINA_FETCH_UNAVAILABLE',
])

export const JINA_FETCH_PROVIDER_DESCRIPTOR = {
  id: 'jina-reader',
  name: 'Jina AI Reader',
  enabledKey: 'jinaEnabled',
  apiKeyKey: 'jinaApiKey',
  allowAnonymousKey: 'jinaAllowAnonymous',
  defaultEnabled: true,
  defaultAllowAnonymous: true,
}

let lastJinaFetchAt = 0

function markdownToPlain(markdown) {
  return collapseWhitespace(
    String(markdown || '')
      .replace(/!\[[^\]]*]\([^)]+\)/g, ' ')
      .replace(/\[([^\]]+)]\([^)]+\)/g, '$1')
      .replace(/```[\s\S]*?```/g, block =>
        block.replace(/```[^\n]*\n?/g, '').replace(/```/g, ''),
      )
      .replace(/`([^`]+)`/g, '$1')
      .replace(/^#{1,6}\s+/gm, '')
      .replace(/^\s*[-*+]\s+/gm, '')
      .replace(/^\s*\d+\.\s+/gm, ''),
  )
}

function extractMarkdownTitle(markdown, fallback = '') {
  const headingMatch = String(markdown || '').match(/^\s*#\s+(.+)$/mu)
  if (headingMatch?.[1]) {
    return collapseWhitespace(headingMatch[1])
  }

  const firstLine = String(markdown || '')
    .split(/\r?\n/u)
    .map(line => collapseWhitespace(line))
    .find(Boolean)
  return firstLine || fallback
}

async function rateLimitJinaRequests() {
  const waitMs = Math.max(0, JINA_MIN_INTERVAL_MS - (Date.now() - lastJinaFetchAt))
  if (waitMs > 0) {
    await new Promise(resolve => setTimeout(resolve, waitMs))
  }
  lastJinaFetchAt = Date.now()
}

export function resolveJinaProviderAccess(settings) {
  return resolveCloudFetchProviderAccess(settings, JINA_FETCH_PROVIDER_DESCRIPTOR)
}

export function getJinaProviderAvailability(runtime = {}, settings = {}) {
  const access = resolveJinaProviderAccess(settings)
  return {
    access,
    ...getCloudFetchProviderAvailability(runtime, access),
  }
}

function buildJinaFailure(response, url, access) {
  const authMode = access?.authMode || 'none'

  if (response.status === 401) {
    return createStructuredError('Jina Reader 认证失败。', {
      source: 'tool',
      category: 'authentication',
      code: 'JINA_FETCH_AUTH_FAILED',
      status: response.status,
      detail: `HTTP 401 while fetching ${url} through Jina Reader.`,
      suggestedAction: '请检查配置的 Jina API Key 是否正确，或临时回退到匿名模式。',
      retryable: false,
    })
  }

  if (response.status === 402) {
    return createStructuredError('Jina Reader 配额已耗尽。', {
      source: 'tool',
      category: 'rate_limit',
      code: 'JINA_FETCH_QUOTA_EXCEEDED',
      status: response.status,
      detail: `HTTP 402 while fetching ${url} through Jina Reader.`,
      suggestedAction: '请补充 Jina 配额或稍后重试；当前任务会自动回退到其他可用抓取路径。',
      retryable: true,
    })
  }

  if (response.status === 403 && authMode === 'anonymous') {
    return createStructuredError('Jina Reader 匿名访问当前不可用。', {
      source: 'tool',
      category: 'rate_limit',
      code: 'JINA_FETCH_ANONYMOUS_FORBIDDEN',
      status: response.status,
      detail: `HTTP 403 while fetching ${url} through Jina Reader without API key.`,
      suggestedAction: '请配置 Jina API Key，或回退到本地抓取 / 搜索摘要结果。',
      retryable: true,
    })
  }

  if (response.status === 403) {
    return createStructuredError('Jina Reader 当前拒绝了这次请求。', {
      source: 'tool',
      category: 'authentication',
      code: 'JINA_FETCH_AUTH_FAILED',
      status: response.status,
      detail: `HTTP 403 while fetching ${url} through Jina Reader.`,
      suggestedAction: '请检查 Jina API Key 权限、账号状态，或临时回退到其他抓取路径。',
      retryable: false,
    })
  }

  if (response.status === 429) {
    return createStructuredError('Jina Reader 请求触发了限流。', {
      source: 'tool',
      category: 'rate_limit',
      code: 'JINA_FETCH_RATE_LIMITED',
      status: response.status,
      detail: `HTTP 429 while fetching ${url} through Jina Reader.`,
      suggestedAction:
        authMode === 'api-key'
          ? '请稍后重试，或降低并发和调用频率。当前任务会自动回退到其他抓取路径。'
          : '匿名模式下已触发 Jina 限流。建议配置 API Key，或回退到本地抓取 / 搜索摘要结果。',
      retryable: true,
    })
  }

  if (response.status === 502 || response.status === 503 || response.status === 504) {
    return createStructuredError('Jina Reader 当前暂时不可用。', {
      source: 'tool',
      category: 'unavailable',
      code: 'JINA_FETCH_UNAVAILABLE',
      status: response.status,
      detail: `HTTP ${response.status} while fetching ${url} through Jina Reader.`,
      suggestedAction: '请稍后重试；当前任务会自动回退到其他抓取路径。',
      retryable: true,
    })
  }

  return createStructuredError('Jina Reader 抓取失败。', {
    source: 'tool',
    category: response.status >= 500 ? 'network' : 'unsupported',
    code: 'JINA_FETCH_FAILED',
    status: response.status,
    detail: `HTTP ${response.status} while fetching ${url} through Jina Reader.`,
    suggestedAction: '请稍后重试，或改用浏览器工具处理需要复杂交互的页面。',
    retryable: response.status >= 500,
  })
}

export function rememberJinaFailure(runtime = {}, error, settings = {}) {
  const code = error?.errorInfo?.code || error?.code || ''
  if (!JINA_RUNTIME_BLOCK_CODES.has(code)) {
    return null
  }

  return markCloudFetchProviderBlocked(runtime, resolveJinaProviderAccess(settings), {
    code,
    summary: error?.errorInfo?.summary || error?.message || 'Jina Reader 当前不可用',
    detail: error?.errorInfo?.detail || error?.rawMessage || '',
  })
}

export function createJinaFetchProvider() {
  return {
    id: JINA_FETCH_PROVIDER_DESCRIPTOR.id,
    name: JINA_FETCH_PROVIDER_DESCRIPTOR.name,
    type: 'cloud-fetch',
    async fetch(url, runtime = {}, options = {}) {
      const availability = getJinaProviderAvailability(runtime, runtime.settings || {})
      if (!availability.usable) {
        if (availability.blocked) {
          const blockedCode = availability.blocked.code || 'JINA_FETCH_PROVIDER_BLOCKED'
          const blockedCategory =
            blockedCode === 'JINA_FETCH_AUTH_FAILED'
              ? 'authentication'
              : blockedCode === 'JINA_FETCH_UNAVAILABLE'
                ? 'unavailable'
                : 'rate_limit'
          throw createStructuredError('Jina Reader 在当前任务中已被停用。', {
            source: 'tool',
            category: blockedCategory,
            code: blockedCode,
            detail:
              availability.blocked.detail ||
              'Jina Reader previously failed in a way that indicates it should not be retried for this task.',
            suggestedAction: '请改用本地抓取、搜索摘要，或在后续任务中配置 API Key 后重试。',
            retryable: false,
          })
        }

        throw createStructuredError('Jina Reader 当前未启用。', {
          source: 'tool',
          category: 'unsupported',
          code: 'JINA_FETCH_NOT_ENABLED',
          detail: 'Jina Reader is not enabled or has no usable authentication mode.',
          suggestedAction: '请启用 Jina Reader，或配置 API Key / 允许匿名模式后再试。',
          retryable: false,
        })
      }

      await rateLimitJinaRequests()
      const timeoutMs = Math.max(2_000, Number(options.timeoutMs) || 8_000)
      const access = availability.access
      const fetchUrl = `${JINA_READER_PREFIX}${url}`
      const headers = buildCloudFetchHeaders(access, {
        'x-respond-with': 'markdown',
      })
      const response = await guardedFetch(
        fetchUrl,
        {
          method: 'GET',
          headers,
        },
        {
          signal: runtime.signal,
          timeoutMs,
          maxRedirects: 2,
          settings: runtime.settings,
          proxyMode: 'web-auto',
        },
      )

      if (!response.ok) {
        throw buildJinaFailure(response, url, access)
      }

      const markdown = String(await readResponseText(response, 900_000) || '')
        .replace(/\r/g, '')
        .trim()
      const plain = markdownToPlain(markdown)

      return {
        markdown,
        plain,
        title: extractMarkdownTitle(markdown),
      }
    },
    shouldUse(signals = {}) {
      return (
        signals.readabilityFailed === true ||
        signals.jsDependent === true ||
        signals.localContentThin === true ||
        signals.unsupportedContentType === true
      )
    },
  }
}
