import { createStructuredError, normalizeRuntimeError } from './runtimeErrors.mjs'
import { runWebFetch as runFetchRuntime } from './web/fetch/runtime.mjs'
import { runWebResearch as runResearchRuntime } from './web/research/runtime.mjs'
import { runWebSearch as runSearchRuntime } from './web/search/runtime.mjs'
import { normalizeCacheKey, readCache, writeCache } from './web/shared/cache.mjs'

const DOMAIN_FAILURE_MEMORY = new Map()
const RETRIEVAL_RESULT_CACHE = new Map()
const MAX_FAILURE_MEMORY_ENTRIES = 256
const RETRIEVAL_RESULT_TTL_MS = {
  web_search: 90_000,
  web_fetch: 120_000,
  web_research: 120_000,
}

const FAILURE_COOLDOWN_MS_BY_CATEGORY = {
  network: 60_000,
  timeout: 60_000,
  rate_limit: 120_000,
  unavailable: 90_000,
  unsupported: 180_000,
}

function unique(values) {
  return Array.from(new Set((values || []).filter(Boolean)))
}

function normalizeDomain(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//u, '')
    .replace(/^www\./u, '')
    .replace(/\/.*$/u, '')
    .replace(/^\.+|\.+$/gu, '')
}

function extractHostname(value) {
  try {
    return normalizeDomain(new URL(String(value || '')).hostname)
  } catch {
    return normalizeDomain(value)
  }
}

function resolveOperationLabel(operation) {
  switch (operation) {
    case 'web_search':
      return '网页搜索'
    case 'web_fetch':
      return '网页抓取'
    case 'web_research':
      return '网页深度调研'
    default:
      return '检索'
  }
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function cloneJsonValue(value) {
  if (value === undefined) {
    return undefined
  }
  return JSON.parse(JSON.stringify(value))
}

function buildRetrievalResultCacheKey(operation, args) {
  return normalizeCacheKey(
    JSON.stringify({
      operation,
      args: isRecord(args) || Array.isArray(args) ? args : String(args || ''),
    }),
  )
}

function readRetrievalResultCache(operation, args) {
  return readCache(RETRIEVAL_RESULT_CACHE, buildRetrievalResultCacheKey(operation, args))
}

function writeRetrievalResultCache(operation, args, result) {
  const ttlMs = RETRIEVAL_RESULT_TTL_MS[operation] || 60_000
  writeCache(
    RETRIEVAL_RESULT_CACHE,
    buildRetrievalResultCacheKey(operation, args),
    cloneJsonValue(result),
    ttlMs,
  )
}

function resolveNestedRetrievalParent(runtime = {}) {
  return typeof runtime?.nestedRetrievalParent === 'string'
    ? runtime.nestedRetrievalParent
    : ''
}

function resolveNestedRetrievalDepth(runtime = {}) {
  const depth = Number(runtime?.nestedRetrievalDepth)
  if (!Number.isFinite(depth)) {
    return 0
  }
  return Math.max(0, Math.round(depth))
}

function normalizeChildOperationTraceEntry(entry) {
  if (!isRecord(entry)) {
    return null
  }

  const operation =
    entry.operation === 'web_search' ||
    entry.operation === 'web_fetch' ||
    entry.operation === 'web_research'
      ? entry.operation
      : ''
  if (!operation) {
    return null
  }

  return {
    operation,
    parentOperation:
      typeof entry.parentOperation === 'string' ? entry.parentOperation : undefined,
    nestedDepth: Math.max(0, Math.round(Number(entry.nestedDepth) || 0)),
    backend: typeof entry.backend === 'string' ? entry.backend : '',
    cacheHit: entry.cacheHit === true,
    cacheLayer: typeof entry.cacheLayer === 'string' ? entry.cacheLayer : '',
    sourceCount: Math.max(0, Math.round(Number(entry.sourceCount) || 0)),
    tookMs: Math.max(0, Math.round(Number(entry.tookMs) || 0)),
    domains: Array.isArray(entry.domains)
      ? entry.domains
          .map(domain => normalizeDomain(domain))
          .filter(Boolean)
          .slice(0, 4)
      : [],
  }
}

function createNestedRetrievalRunner(parentOperation, runtime = {}) {
  return async function runNestedRetrievalOperation(operation, args) {
    return runRetrievalOperation(operation, args, {
      ...runtime,
      nestedRetrievalParent: parentOperation,
      nestedRetrievalDepth: resolveNestedRetrievalDepth(runtime) + 1,
    })
  }
}

function cleanupFailureMemory(now = Date.now()) {
  for (const [domain, entry] of DOMAIN_FAILURE_MEMORY.entries()) {
    if (!entry || (entry.cooldownUntil || 0) <= now - 10 * 60_000) {
      DOMAIN_FAILURE_MEMORY.delete(domain)
    }
  }

  if (DOMAIN_FAILURE_MEMORY.size <= MAX_FAILURE_MEMORY_ENTRIES) {
    return
  }

  const oldestEntries = [...DOMAIN_FAILURE_MEMORY.entries()]
    .sort(
      (left, right) =>
        (left[1]?.lastFailureAt || 0) - (right[1]?.lastFailureAt || 0),
    )
    .slice(0, DOMAIN_FAILURE_MEMORY.size - MAX_FAILURE_MEMORY_ENTRIES)

  for (const [domain] of oldestEntries) {
    DOMAIN_FAILURE_MEMORY.delete(domain)
  }
}

function resolveFailureCooldownMs(errorInfo = {}) {
  if (errorInfo?.code === 'WEB_FETCH_PAGE_REQUIRES_BROWSER') {
    return 3 * 60_000
  }

  return FAILURE_COOLDOWN_MS_BY_CATEGORY[errorInfo?.category] || 45_000
}

function extractDomainsFromResult(operation, result) {
  if (!result || typeof result !== 'object') {
    return []
  }

  if (operation === 'web_fetch') {
    return unique([
      extractHostname(result.finalUrl),
      extractHostname(result.url),
      normalizeDomain(result.site),
    ])
  }

  const resultEntries = Array.isArray(result.results) ? result.results : []
  return unique(
    resultEntries.flatMap(entry => [
      extractHostname(entry?.finalUrl),
      extractHostname(entry?.url),
      normalizeDomain(entry?.site),
      normalizeDomain(entry?.domain),
    ]),
  )
}

function extractDomainsFromArgs(operation, args = {}) {
  if (operation === 'web_fetch') {
    return unique([extractHostname(args.url)])
  }

  if (operation === 'web_search' || operation === 'web_research') {
    return unique(
      Array.isArray(args?.domains)
        ? args.domains.map(entry => normalizeDomain(entry))
        : [],
    )
  }

  return []
}

function readFailureSnapshots(domains, now = Date.now()) {
  return unique(domains)
    .map(domain => {
      const entry = DOMAIN_FAILURE_MEMORY.get(domain)
      if (!entry) {
        return null
      }
      return {
        domain,
        consecutiveFailures: entry.consecutiveFailures,
        lastFailureAt: entry.lastFailureAt,
        cooldownUntil: entry.cooldownUntil,
        cooldownRemainingMs: Math.max(0, (entry.cooldownUntil || 0) - now),
        lastCategory: entry.lastCategory,
        lastCode: entry.lastCode,
      }
    })
    .filter(Boolean)
}

function clearFailureMemory(domains) {
  for (const domain of unique(domains)) {
    DOMAIN_FAILURE_MEMORY.delete(domain)
  }
}

function rememberFailure(domains, normalizedError, now = Date.now()) {
  const uniqueDomains = unique(domains)
  if (uniqueDomains.length === 0) {
    return
  }

  const cooldownMs = resolveFailureCooldownMs(normalizedError?.errorInfo)

  for (const domain of uniqueDomains) {
    const previous = DOMAIN_FAILURE_MEMORY.get(domain)
    DOMAIN_FAILURE_MEMORY.set(domain, {
      consecutiveFailures: (previous?.consecutiveFailures || 0) + 1,
      cooldownUntil: now + cooldownMs,
      lastFailureAt: now,
      lastCategory: normalizedError?.errorInfo?.category || 'execution_failed',
      lastCode: normalizedError?.errorInfo?.code || normalizedError?.code || undefined,
    })
  }

  cleanupFailureMemory(now)
}

function findActiveCooldown(domains, now = Date.now()) {
  return readFailureSnapshots(domains, now).find(
    entry =>
      entry.cooldownRemainingMs > 0 && (entry.consecutiveFailures || 0) >= 2,
  )
}

function maybeShortCircuitFetchCooldown(operation, args, now = Date.now()) {
  if (operation !== 'web_fetch') {
    return
  }

  const domains = extractDomainsFromArgs(operation, args)
  const activeCooldown = findActiveCooldown(domains, now)
  if (!activeCooldown) {
    return
  }

  throw createStructuredError(
    `网页抓取暂时跳过了 ${activeCooldown.domain}，因为同一站点刚刚连续失败。`,
    {
      source: 'tool',
      category: 'network',
      code: 'RETRIEVAL_DOMAIN_COOLDOWN',
      detail: [
        `Domain: ${activeCooldown.domain}`,
        `Consecutive failures: ${activeCooldown.consecutiveFailures}`,
        `Cooldown remaining: ${activeCooldown.cooldownRemainingMs}ms`,
      ].join('\n'),
      suggestedAction:
        '请先换一个来源、改用 web_search / web_research，或等待冷却结束后再抓取同一站点。',
      retryable: true,
    },
  )
}

function resolveBackends(operation, result) {
  if (!result || typeof result !== 'object') {
    return []
  }

  if (operation === 'web_search') {
    return result.provider ? [`search:${result.provider}`] : []
  }

  if (operation === 'web_fetch') {
    return result.provider ? [`fetch:${result.provider}`] : []
  }

  if (operation === 'web_research') {
    const trail = []
    if (result.provider) {
      trail.push(`search:${result.provider}`)
    }

    for (const entry of Array.isArray(result.results) ? result.results : []) {
      if (entry?.provider) {
        trail.push(`fetch:${entry.provider}`)
      } else if (entry?.providerContentUsed === true) {
        trail.push('fetch:search-provider-content')
      }
    }

    return unique(trail)
  }

  return []
}

function resolveCacheMetadata(result, overrides = {}) {
  if (overrides?.cacheHit === true) {
    return {
      cacheHit: true,
      cacheLayer: typeof overrides.cacheLayer === 'string' ? overrides.cacheLayer : '',
    }
  }

  const cache = isRecord(result?.cache) ? result.cache : null
  const cacheHit = cache?.hit === true
  const cacheLayer = typeof cache?.layer === 'string' ? cache.layer : ''

  return {
    cacheHit,
    cacheLayer,
  }
}

function buildRetrievalTraceSummary(operation, result, metadata) {
  return normalizeChildOperationTraceEntry({
    operation,
    parentOperation: metadata?.parentOperation,
    nestedDepth: metadata?.nestedDepth,
    backend: metadata?.backend,
    cacheHit: metadata?.cacheHit,
    cacheLayer: metadata?.cacheLayer,
    sourceCount: metadata?.sourceCount,
    tookMs: result?.tookMs,
    domains: metadata?.domains,
  })
}

function resolveSourceCount(operation, result) {
  if (!result || typeof result !== 'object') {
    return 0
  }

  if (operation === 'web_fetch') {
    return result.content || result.title || result.excerpt ? 1 : 0
  }

  if (Array.isArray(result.results)) {
    return result.results.length
  }

  return typeof result.total === 'number' && Number.isFinite(result.total)
    ? Math.max(0, Math.round(result.total))
    : 0
}

function buildRetrievalMetadata(
  operation,
  args,
  result,
  runtime = {},
  childOperations = [],
  now = Date.now(),
  cacheOverrides = {},
) {
  const domains = unique([
    ...extractDomainsFromArgs(operation, args),
    ...extractDomainsFromResult(operation, result),
  ])
  const backends = resolveBackends(operation, result)
  const resultEntries = Array.isArray(result?.results) ? result.results : []
  const parentOperation = resolveNestedRetrievalParent(runtime)
  const nestedDepth = resolveNestedRetrievalDepth(runtime)
  const cacheMetadata = resolveCacheMetadata(result, cacheOverrides)
  const normalizedChildOperations = (Array.isArray(childOperations) ? childOperations : [])
    .map(normalizeChildOperationTraceEntry)
    .filter(Boolean)

  return {
    runtime: 'local-retrieval',
    operation,
    parentOperation: parentOperation || undefined,
    nestedDepth,
    backend: backends[0] || '',
    backendTrail: backends,
    cacheHit: cacheMetadata.cacheHit,
    cacheLayer: cacheMetadata.cacheLayer || undefined,
    domains,
    sourceCount: resolveSourceCount(operation, result),
    childOperations: normalizedChildOperations.length > 0 ? normalizedChildOperations : undefined,
    childOperationCount: normalizedChildOperations.length || undefined,
    topSourceDomains: unique(
      resultEntries.flatMap(entry => [
        extractHostname(entry?.url),
        extractHostname(entry?.finalUrl),
        normalizeDomain(entry?.site),
        normalizeDomain(entry?.domain),
      ]),
    ).slice(0, 6),
    failureMemory: readFailureSnapshots(domains, now),
    completedAt: new Date(now).toISOString(),
  }
}

function annotateRetrievalError(error, operation, args, runtime = {}, now = Date.now()) {
  const domains = extractDomainsFromArgs(operation, args)
  const failureMemory = readFailureSnapshots(domains, now)
  const parentOperation = resolveNestedRetrievalParent(runtime)
  const nestedDepth = resolveNestedRetrievalDepth(runtime)

  if (error && typeof error === 'object') {
    error.retrieval = {
      runtime: 'local-retrieval',
      operation,
      parentOperation: parentOperation || undefined,
      nestedDepth,
      domains,
      failureMemory,
      failedAt: new Date(now).toISOString(),
    }

    if (error.errorInfo && typeof error.errorInfo === 'object' && failureMemory.length > 0) {
      error.errorInfo.detail = [
        error.errorInfo.detail,
        `Recent domain failures: ${failureMemory
          .map(
            entry =>
              `${entry.domain} x${entry.consecutiveFailures} (${entry.lastCode || entry.lastCategory || 'failed'})`,
          )
          .join(', ')}`,
      ]
        .filter(Boolean)
        .join('\n')
    }
  }

  return error
}

async function dispatchRetrievalOperation(operation, args, runtime) {
  switch (operation) {
    case 'web_search':
      return runSearchRuntime(args, runtime)
    case 'web_fetch':
      return runFetchRuntime(args, runtime)
    case 'web_research':
      return runResearchRuntime(args, {
        ...runtime,
        runNestedRetrievalOperation:
          typeof runtime?.runNestedRetrievalOperation === 'function'
            ? runtime.runNestedRetrievalOperation
            : createNestedRetrievalRunner(operation, runtime),
      })
    default:
      throw createStructuredError(`未知检索操作: ${operation}`, {
        source: 'system',
        category: 'invalid_input',
        code: 'RETRIEVAL_UNKNOWN_OPERATION',
        detail: `Unknown retrieval operation: ${operation}`,
      })
  }
}

export async function runRetrievalOperation(operation, args, runtime = {}) {
  const retrievalTrace = Array.isArray(runtime?.retrievalTrace) ? runtime.retrievalTrace : []
  const runtimeWithTrace =
    Array.isArray(runtime?.retrievalTrace) ? runtime : { ...runtime, retrievalTrace }
  const traceStart = retrievalTrace.length
  runtimeWithTrace.throwIfAborted?.()
  const startedAt = Date.now()
  cleanupFailureMemory(startedAt)

  try {
    maybeShortCircuitFetchCooldown(operation, args, startedAt)
    const cachedResult =
      runtimeWithTrace?.disableRetrievalResultCache === true
        ? null
        : readRetrievalResultCache(operation, args)
    if (cachedResult) {
      const memoizedResult = cloneJsonValue(cachedResult)
      const retrieval = buildRetrievalMetadata(
        operation,
        args,
        memoizedResult,
        runtimeWithTrace,
        [],
        Date.now(),
        {
          cacheHit: true,
          cacheLayer: 'runtime-memory',
        },
      )
      const finalMemoizedResult = {
        ...memoizedResult,
        retrieval,
      }

      if (retrieval.parentOperation) {
        const summary = buildRetrievalTraceSummary(operation, finalMemoizedResult, retrieval)
        if (summary) {
          retrievalTrace.push(summary)
        }
      }

      return finalMemoizedResult
    }
    const result = await dispatchRetrievalOperation(operation, args, runtimeWithTrace)
    if (runtimeWithTrace?.disableRetrievalResultCache !== true) {
      writeRetrievalResultCache(operation, args, result)
    }
    const domains = unique([
      ...extractDomainsFromArgs(operation, args),
      ...extractDomainsFromResult(operation, result),
    ])
    clearFailureMemory(domains)
    const childOperations = retrievalTrace.slice(traceStart)
    const retrieval = buildRetrievalMetadata(
      operation,
      args,
      result,
      runtimeWithTrace,
      childOperations,
      Date.now(),
    )
    const finalResult = {
      ...result,
      retrieval,
    }

    if (retrieval.parentOperation) {
      const summary = buildRetrievalTraceSummary(operation, finalResult, retrieval)
      if (summary) {
        retrievalTrace.push(summary)
      }
    }

    return finalResult
  } catch (error) {
    const normalized = normalizeRuntimeError(error, {
      source: 'tool',
      operationLabel: resolveOperationLabel(operation),
    })
    if (normalized?.errorInfo?.code !== 'RETRIEVAL_DOMAIN_COOLDOWN') {
      rememberFailure(extractDomainsFromArgs(operation, args), normalized, Date.now())
    }
    throw annotateRetrievalError(error, operation, args, runtimeWithTrace, Date.now())
  }
}

export function getRetrievalFailureMemorySnapshot() {
  cleanupFailureMemory()
  return [...DOMAIN_FAILURE_MEMORY.entries()]
    .map(([domain, entry]) => ({
      domain,
      ...entry,
    }))
    .sort((left, right) => (right.lastFailureAt || 0) - (left.lastFailureAt || 0))
}

export async function runWebSearch(args, runtime = {}) {
  return runRetrievalOperation('web_search', args, runtime)
}

export async function runWebFetch(args, runtime = {}) {
  return runRetrievalOperation('web_fetch', args, runtime)
}

export async function runWebResearch(args, runtime = {}) {
  return runRetrievalOperation('web_research', args, runtime)
}
