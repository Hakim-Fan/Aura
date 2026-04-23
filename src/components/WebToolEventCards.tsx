import { useState } from 'react'
import type { MessageEvent } from '../types'

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function asText(value: unknown) {
  return typeof value === 'string' ? value.trim() : ''
}

function asTextArray(value: unknown) {
  return Array.isArray(value)
    ? value.map(entry => (typeof entry === 'string' ? entry.trim() : '')).filter(Boolean)
    : []
}

function asBoolean(value: unknown) {
  return value === true
}

function asNumber(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function readRetrievalMeta(output: Record<string, unknown>) {
  return isRecord(output.retrieval) ? output.retrieval : null
}

function formatRetrievalOperation(value: string) {
  switch (value) {
    case 'web_search':
      return 'search'
    case 'web_fetch':
      return 'fetch'
    case 'web_research':
      return 'research'
    default:
      return value
  }
}

function summarizeUrl(value: string) {
  try {
    const parsed = new URL(value)
    return `${parsed.hostname.replace(/^www\./, '')}${parsed.pathname === '/' ? '' : parsed.pathname}`
  } catch {
    return value
  }
}

function MetaPill({ label, value }: { label: string; value?: string | number }) {
  if (value === undefined || value === null || value === '') {
    return null
  }

  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-white/85 px-2 py-1 text-[10px] font-700 uppercase tracking-[0.12em] text-[var(--accent-soft-strong)]">
      {label}
      <span className="normal-case tracking-normal text-[var(--text-primary)]">{value}</span>
    </span>
  )
}

export function WebSearchEventCard({
  event,
  output,
}: {
  event: MessageEvent
  output: Record<string, unknown>
}) {
  const query = asText(output.query)
  const provider = asText(output.provider)
  const total = typeof output.total === 'number' ? output.total : 0
  const tookMs = typeof output.tookMs === 'number' ? output.tookMs : 0
  const searchStopped = output.searchStopped === true
  const budgetExhausted = output.budgetExhausted === true
  const basedOnPreviousEvidence = output.basedOnPreviousEvidence === true
  const stopSummary = asText(output.summary)
  const stopAction = asText(output.suggestedAction)
  const retrieval = readRetrievalMeta(output)
  const cacheRecord = isRecord(output.cache) ? output.cache : null
  const cacheLayer = asText(cacheRecord?.layer) || asText(retrieval?.cacheLayer)
  const cacheHit = asBoolean(cacheRecord?.hit) || asBoolean(retrieval?.cacheHit)
  const recommendedResults = Array.isArray(output.recommendedResults)
    ? output.recommendedResults.filter(isRecord).slice(0, 3)
    : []
  const results = Array.isArray(output.results)
    ? output.results.filter(isRecord).slice(0, 8)
    : []
  const advisorySummary =
    (searchStopped || budgetExhausted) &&
      total === 0 &&
      recommendedResults.length > 0 &&
      basedOnPreviousEvidence
      ? '这个 query 没有继续展开；更合适的下一步是先阅读前面已经找到的高质量来源。'
      : stopSummary

  return (
    <div className="mt-2 flex flex-col gap-2 rounded-xl border border-[rgba(79,123,116,0.12)] bg-[rgba(79,123,116,0.05)] p-3">
      <div className="flex flex-wrap items-center gap-2">
        <MetaPill label="Query" value={query || 'Searching'} />
        <MetaPill
          label="Provider"
          value={
            provider &&
            provider !== 'route-budget' &&
            provider !== 'route-search-controller'
              ? provider
              : undefined
          }
        />
        <MetaPill
          label={searchStopped && total === 0 && recommendedResults.length > 0 ? 'Suggested' : 'Results'}
          value={searchStopped && total === 0 && recommendedResults.length > 0 ? recommendedResults.length : total}
        />
        {cacheHit ? <MetaPill label="Cache" value={cacheLayer || 'hit'} /> : null}
        {tookMs > 0 ? <MetaPill label="Time" value={`${tookMs}ms`} /> : null}
      </div>

      {budgetExhausted || searchStopped ? (
        <div className="rounded-lg border border-amber-200 bg-[rgba(255,248,235,0.88)] px-3 py-2 text-[12px] leading-relaxed text-amber-800">
          <div>{advisorySummary || '当前搜索阶段已经收束，建议转入阅读和整理。'}</div>
          {stopAction ? (
            <div className="mt-1 text-[11px] text-amber-700/85">{stopAction}</div>
          ) : null}
          {recommendedResults.length > 0 ? (
            <div className="mt-2 flex flex-col gap-2">
              {recommendedResults.map((entry, index) => {
                const title = asText(entry.title) || `Recommended ${index + 1}`
                const url = asText(entry.url)
                const site = asText(entry.site)
                const rankScore =
                  typeof entry.rankScore === 'number' ? Math.round(entry.rankScore) : undefined

                return (
                  <div
                    key={`${url || title}-${index}`}
                    className="rounded-lg border border-amber-100 bg-white/75 px-2.5 py-2"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0 text-[11px] font-600 text-[var(--text-primary)]">
                        {title}
                      </div>
                      <MetaPill
                        label="Score"
                        value={rankScore !== undefined ? `${rankScore}` : undefined}
                      />
                    </div>
                    <div className="mt-1 text-[10px] text-[var(--text-secondary)]">
                      {site || summarizeUrl(url)}
                    </div>
                  </div>
                )
              })}
            </div>
          ) : null}
        </div>
      ) : results.length > 0 ? (
        <div className="flex flex-col gap-2">
          {results.map((entry, index) => {
            const title = asText(entry.title) || `Result ${index + 1}`
            const url = asText(entry.url)
            const site = asText(entry.site)
            const snippet = asText(entry.snippet)
            const rankScore =
              typeof entry.rankScore === 'number' ? Math.round(entry.rankScore) : undefined
            const sourceQualityScore =
              typeof entry.sourceQualityScore === 'number'
                ? Math.round(entry.sourceQualityScore)
                : undefined
            const noveltyScore =
              typeof entry.noveltyScore === 'number' ? Math.round(entry.noveltyScore) : undefined
            const domainCategory = asText(entry.domainCategory)

            return (
              <article
                key={`${url || title}-${index}`}
                className="rounded-lg border border-white/80 bg-white/85 px-3 py-2.5"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-[12px] font-600 leading-relaxed text-[var(--text-primary)]">
                      {title}
                    </div>
                    <div className="mt-1 text-[11px] text-[var(--text-secondary)]">
                      {site || summarizeUrl(url)}
                    </div>
                  </div>
                  <span className="shrink-0 rounded-full bg-[rgba(79,123,116,0.08)] px-1.5 py-0.5 text-[10px] uppercase text-[var(--accent-soft-strong)]">
                    {index + 1}
                  </span>
                </div>
                {url ? (
                  <a
                    className="mt-1 block truncate text-[11px] text-[var(--accent-soft-strong)] underline-offset-2 hover:underline"
                    href={url}
                    rel="noreferrer"
                    target="_blank"
                  >
                    {url}
                  </a>
                ) : null}
                {snippet ? (
                  <div className="mt-2 text-[11px] leading-relaxed text-[var(--text-secondary)]">
                    {snippet}
                  </div>
                ) : null}
                {rankScore !== undefined || sourceQualityScore !== undefined || noveltyScore !== undefined ? (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    <MetaPill label="Score" value={rankScore !== undefined ? `${rankScore}` : undefined} />
                    <MetaPill
                      label="Quality"
                      value={sourceQualityScore !== undefined ? `${sourceQualityScore}` : undefined}
                    />
                    <MetaPill
                      label="Novelty"
                      value={noveltyScore !== undefined ? `${noveltyScore}` : undefined}
                    />
                    <MetaPill label="Type" value={domainCategory || undefined} />
                  </div>
                ) : null}
              </article>
            )
          })}
        </div>
      ) : (
        <div className="rounded-lg border border-dashed border-white/90 bg-white/55 px-3 py-2 text-[12px] text-[var(--text-secondary)]">
          {event.status === 'running' ? '正在检索网页结果...' : '没有可展示的搜索结果。'}
        </div>
      )}
    </div>
  )
}

function researchStatusMeta(status: string) {
  switch (status) {
    case 'success':
      return {
        label: 'fetched',
        className: 'bg-emerald-50 text-emerald-700',
      }
    case 'provider_content':
      return {
        label: 'provider',
        className: 'bg-sky-50 text-sky-700',
      }
    case 'provider_content_fallback':
      return {
        label: 'provider fallback',
        className: 'bg-cyan-50 text-cyan-700',
      }
    case 'error':
      return {
        label: 'blocked',
        className: 'bg-red-50 text-red-600',
      }
    case 'not_fetched':
    default:
      return {
        label: 'candidate',
        className: 'bg-gray-100 text-gray-600',
      }
  }
}

function fetchAttemptStatusMeta(status: string) {
  switch (status) {
    case 'success':
      return {
        label: 'success',
        className: 'bg-emerald-50 text-emerald-700',
      }
    case 'cached':
      return {
        label: 'cache',
        className: 'bg-sky-50 text-sky-700',
      }
    case 'blocked':
      return {
        label: 'blocked',
        className: 'bg-red-50 text-red-600',
      }
    case 'disabled':
      return {
        label: 'disabled',
        className: 'bg-slate-100 text-slate-600',
      }
    case 'error':
      return {
        label: 'error',
        className: 'bg-amber-50 text-amber-700',
      }
    default:
      return {
        label: status || 'attempt',
        className: 'bg-gray-100 text-gray-600',
      }
  }
}

export function WebResearchEventCard({
  event,
  output,
}: {
  event: MessageEvent
  output: Record<string, unknown>
}) {
  const [expandedKeys, setExpandedKeys] = useState<Record<string, boolean>>({})
  const query = asText(output.query)
  const provider = asText(output.provider)
  const depth = asText(output.depth)
  const total = typeof output.total === 'number' ? output.total : 0
  const fetchedTotal = typeof output.fetchedTotal === 'number' ? output.fetchedTotal : 0
  const usedSearchContentTotal =
    typeof output.usedSearchContentTotal === 'number' ? output.usedSearchContentTotal : 0
  const sourceDiversity = typeof output.sourceDiversity === 'number' ? output.sourceDiversity : 0
  const tookMs = typeof output.tookMs === 'number' ? output.tookMs : 0
  const crossSourceInsights = isRecord(output.crossSourceInsights)
    ? output.crossSourceInsights
    : null
  const retrieval = readRetrievalMeta(output)
  const childOperations = Array.isArray(retrieval?.childOperations)
    ? retrieval.childOperations.filter(isRecord).slice(0, 6)
    : []
  const results = Array.isArray(output.results)
    ? output.results.filter(isRecord).slice(0, 6)
    : []

  return (
    <div className="mt-2 flex flex-col gap-2 rounded-xl border border-[rgba(79,123,116,0.12)] bg-[rgba(79,123,116,0.05)] p-3">
      <div className="flex flex-wrap items-center gap-2">
        <MetaPill label="Query" value={query || 'Research'} />
        <MetaPill label="Provider" value={provider || undefined} />
        <MetaPill label="Depth" value={depth || 'auto'} />
        <MetaPill label="Results" value={total} />
        <MetaPill label="Fetched" value={fetchedTotal} />
        <MetaPill label="Provider content" value={usedSearchContentTotal} />
        <MetaPill label="Domains" value={sourceDiversity || undefined} />
        <MetaPill label="Trace" value={childOperations.length > 0 ? childOperations.length : undefined} />
        {tookMs > 0 ? <MetaPill label="Time" value={`${tookMs}ms`} /> : null}
      </div>

      {childOperations.length > 0 ? (
        <div className="rounded-lg border border-[rgba(15,23,42,0.05)] bg-white/70 px-3 py-2">
          <div className="mb-2 text-[10px] font-700 uppercase tracking-[0.12em] text-[var(--accent-soft-strong)]">
            Retrieval Trace
          </div>
          <div className="flex flex-col gap-2">
            {childOperations.map((entry, index) => {
              const operation = formatRetrievalOperation(asText(entry.operation))
              const backend = asText(entry.backend)
              const cacheHit = asBoolean(entry.cacheHit)
              const cacheLayer = asText(entry.cacheLayer)
              const sourceCount = asNumber(entry.sourceCount)
              const traceTookMs = asNumber(entry.tookMs)
              const domains = asTextArray(entry.domains)

              return (
                <div
                  key={`trace-${operation}-${backend}-${index}`}
                  className="rounded-lg border border-white/80 bg-white/85 px-2.5 py-2"
                >
                  <div className="flex flex-wrap gap-1.5">
                    <MetaPill label="Op" value={operation || undefined} />
                    <MetaPill label="Backend" value={backend || undefined} />
                    <MetaPill label="Cache" value={cacheHit ? cacheLayer || 'hit' : undefined} />
                    <MetaPill
                      label="Sources"
                      value={sourceCount !== undefined ? `${sourceCount}` : undefined}
                    />
                    <MetaPill
                      label="Time"
                      value={
                        traceTookMs !== undefined && traceTookMs > 0
                          ? `${traceTookMs}ms`
                          : undefined
                      }
                    />
                  </div>
                  {domains.length > 0 ? (
                    <div className="mt-2 text-[11px] text-[var(--text-secondary)]">
                      {domains.join(' / ')}
                    </div>
                  ) : null}
                </div>
              )
            })}
          </div>
        </div>
      ) : null}

      {crossSourceInsights ? (
        <div className="rounded-lg border border-[rgba(15,23,42,0.05)] bg-white/70 px-3 py-2">
          <div className="mb-2 text-[10px] font-700 uppercase tracking-[0.12em] text-[var(--accent-soft-strong)]">
            Cross-Source Check
          </div>
          <div className="flex flex-wrap gap-1.5">
            <MetaPill label="Signal" value={asText(crossSourceInsights.overallSignal) || undefined} />
            <MetaPill
              label="Sources"
              value={
                typeof crossSourceInsights.comparedSources === 'number'
                  ? `${Math.round(crossSourceInsights.comparedSources)}`
                  : undefined
              }
            />
            <MetaPill
              label="Domains"
              value={
                typeof crossSourceInsights.uniqueDomains === 'number'
                  ? `${Math.round(crossSourceInsights.uniqueDomains)}`
                  : undefined
              }
            />
          </div>
        </div>
      ) : null}

      {results.length > 0 ? (
        <div className="flex flex-col gap-2">
          {results.map((entry, index) => {
            const title = asText(entry.title) || `Research Result ${index + 1}`
            const url = asText(entry.url)
            const site = asText(entry.site)
            const summary =
              asText(entry.summary) || asText(entry.excerpt) || asText(entry.snippet)
            const content = asText(entry.fullContent) || asText(entry.content)
            const keyPoints = asTextArray(entry.keyPoints)
            const riskFlags = asTextArray(entry.riskFlags)
            const status = asText(entry.status)
            const citationIndex =
              typeof entry.citationIndex === 'number' ? Math.round(entry.citationIndex) : index + 1
            const rankScore =
              typeof entry.rankScore === 'number' ? Math.round(entry.rankScore) : undefined
            const contentOrigin = asText(entry.contentOrigin)
            const error = asText(entry.error)
            const previewKey = `${url || title}-${index}`
            const expanded = expandedKeys[previewKey] === true
            const preview = expanded ? content : content.slice(0, 700).trim()
            const canExpand = content.length > 700
            const statusMeta = researchStatusMeta(status)

            return (
              <article
                key={previewKey}
                className="rounded-lg border border-white/80 bg-white/85 px-3 py-2.5"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-[12px] font-600 leading-relaxed text-[var(--text-primary)]">
                      [{citationIndex}] {title}
                    </div>
                    <div className="mt-1 text-[11px] text-[var(--text-secondary)]">
                      {site || summarizeUrl(url)}
                    </div>
                  </div>
                  <span className={`shrink-0 rounded-full px-1.5 py-0.5 text-[10px] uppercase ${statusMeta.className}`}>
                    {statusMeta.label}
                  </span>
                </div>
                {url ? (
                  <a
                    className="mt-1 block truncate text-[11px] text-[var(--accent-soft-strong)] underline-offset-2 hover:underline"
                    href={url}
                    rel="noreferrer"
                    target="_blank"
                  >
                    {url}
                  </a>
                ) : null}
                <div className="mt-2 flex flex-wrap gap-1.5">
                  <MetaPill label="Rank" value={rankScore !== undefined ? `${rankScore}` : undefined} />
                  <MetaPill label="Origin" value={contentOrigin || undefined} />
                </div>
                {summary ? (
                  <div className="mt-2 text-[11px] leading-relaxed text-[var(--text-secondary)]">
                    {summary}
                  </div>
                ) : null}
                {error ? (
                  <div className="mt-2 rounded-lg border border-red-100 bg-red-50/70 px-2.5 py-2 text-[11px] leading-relaxed text-red-700">
                    {error}
                  </div>
                ) : null}
                {riskFlags.length > 0 ? (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {riskFlags.map(flag => (
                      <MetaPill key={`${previewKey}-${flag}`} label="Risk" value={flag} />
                    ))}
                  </div>
                ) : null}
                {keyPoints.length > 0 ? (
                  <div className="mt-2 flex flex-col gap-1 text-[11px] leading-relaxed text-[var(--text-primary)]">
                    {keyPoints.map((point, pointIndex) => (
                      <div key={`${previewKey}-point-${pointIndex}`}>{point}</div>
                    ))}
                  </div>
                ) : null}
                {preview ? (
                  <div className="mt-2 rounded-lg border border-[rgba(15,23,42,0.05)] bg-[rgba(15,23,42,0.03)] px-2.5 py-2">
                    <div className="whitespace-pre-wrap text-[11px] leading-relaxed text-[var(--text-primary)]">
                      {preview}
                      {!expanded && canExpand ? '...' : ''}
                    </div>
                    {canExpand ? (
                      <button
                        className="mt-2 text-[11px] font-600 text-[var(--accent-soft-strong)]"
                        onClick={() =>
                          setExpandedKeys(current => ({
                            ...current,
                            [previewKey]: !current[previewKey],
                          }))
                        }
                        type="button"
                      >
                        {expanded ? '收起正文' : '展开正文'}
                      </button>
                    ) : null}
                  </div>
                ) : null}
              </article>
            )
          })}
        </div>
      ) : (
        <div className="rounded-lg border border-dashed border-white/90 bg-white/55 px-3 py-2 text-[12px] text-[var(--text-secondary)]">
          {event.status === 'running' ? '正在进行网页深度调研...' : '没有可展示的调研结果。'}
        </div>
      )}
    </div>
  )
}

export function WebFetchEventCard({
  event,
  output,
}: {
  event: MessageEvent
  output: Record<string, unknown>
}) {
  const [expanded, setExpanded] = useState(false)
  const url = asText(output.finalUrl) || asText(output.url)
  const provider = asText(output.provider)
  const site = asText(output.site)
  const title = asText(output.title)
  const excerpt = asText(output.excerpt)
  const content = asText(output.content)
  const contentFormat = asText(output.contentFormat)
  const author = asText(output.author)
  const publishedAt = asText(output.publishedAt)
  const riskFlags = asTextArray(output.riskFlags)
  const keyPoints = asTextArray(output.keyPoints)
  const sourceAssessment = isRecord(output.sourceAssessment) ? output.sourceAssessment : null
  const crossSourceInsights = isRecord(output.crossSourceInsights)
    ? output.crossSourceInsights
    : null
  const retrieval = readRetrievalMeta(output)
  const cacheRecord = isRecord(output.cache) ? output.cache : null
  const cacheHit = asBoolean(cacheRecord?.hit) || asBoolean(retrieval?.cacheHit)
  const cacheLayer = asText(cacheRecord?.layer) || asText(retrieval?.cacheLayer)
  const attemptedProviders = Array.isArray(output.attemptedProviders)
    ? output.attemptedProviders.filter(isRecord).slice(0, 6)
    : []
  const evidenceBlocks = Array.isArray(output.evidenceBlocks)
    ? output.evidenceBlocks.filter(isRecord).slice(0, 4)
    : []
  const tookMs = typeof output.tookMs === 'number' ? output.tookMs : 0
  const preview = expanded ? content : content.slice(0, 900).trim()
  const canExpand = content.length > 900

  return (
    <div className="mt-2 flex flex-col gap-2 rounded-xl border border-[rgba(79,123,116,0.12)] bg-[rgba(79,123,116,0.05)] p-3">
      <div className="flex flex-wrap items-center gap-2">
        <MetaPill label="Site" value={site || summarizeUrl(url)} />
        <MetaPill label="Provider" value={provider || 'web'} />
        <MetaPill label="Format" value={contentFormat || 'article'} />
        <MetaPill label="Attempts" value={attemptedProviders.length || undefined} />
        {cacheHit ? <MetaPill label="Cache" value={cacheLayer || 'hit'} /> : null}
        {tookMs > 0 ? <MetaPill label="Time" value={`${tookMs}ms`} /> : null}
      </div>

      <div className="rounded-lg border border-white/80 bg-white/85 px-3 py-2.5">
        <div className="text-[12px] font-600 leading-relaxed text-[var(--text-primary)]">
          {title || summarizeUrl(url) || 'Fetched page'}
        </div>
        {url ? (
          <a
            className="mt-1 block truncate text-[11px] text-[var(--accent-soft-strong)] underline-offset-2 hover:underline"
            href={url}
            rel="noreferrer"
            target="_blank"
          >
            {url}
          </a>
        ) : null}
        {author || publishedAt ? (
          <div className="mt-2 text-[11px] text-[var(--text-secondary)]">
            {[author, publishedAt].filter(Boolean).join(' · ')}
          </div>
        ) : null}
        {sourceAssessment ? (
          <div className="mt-2 flex flex-wrap gap-1.5">
            <MetaPill label="Source" value={asText(sourceAssessment.category) || undefined} />
            <MetaPill label="Freshness" value={asText(sourceAssessment.freshness) || undefined} />
            <MetaPill label="Use" value={asText(sourceAssessment.recommendedUse) || undefined} />
            <MetaPill
              label="Quality"
              value={
                typeof sourceAssessment.qualityScore === 'number'
                  ? `${Math.round(sourceAssessment.qualityScore)}`
                  : undefined
              }
            />
          </div>
        ) : null}
        {excerpt ? (
          <div className="mt-2 text-[11px] leading-relaxed text-[var(--text-secondary)]">
            {excerpt}
          </div>
        ) : null}
        {riskFlags.length > 0 ? (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {riskFlags.map(flag => (
              <MetaPill key={flag} label="Risk" value={flag} />
            ))}
          </div>
        ) : null}
        {attemptedProviders.length > 0 ? (
          <div className="mt-3 rounded-lg border border-[rgba(15,23,42,0.05)] bg-[rgba(15,23,42,0.03)] px-3 py-2">
            <div className="mb-2 text-[10px] font-700 uppercase tracking-[0.12em] text-[var(--accent-soft-strong)]">
              Fetch Path
            </div>
            <div className="flex flex-col gap-2">
              {attemptedProviders.map((entry, index) => {
                const attemptProvider = asText(entry.provider)
                const attemptReason = asText(entry.reason)
                const attemptSource = asText(entry.source)
                const attemptError = asText(entry.error)
                const attemptStatus = fetchAttemptStatusMeta(asText(entry.status))
                const attemptCacheHit = asBoolean(entry.cacheHit)

                return (
                  <div
                    key={`fetch-attempt-${attemptProvider}-${attemptReason}-${index}`}
                    className="rounded-lg border border-white/80 bg-white/85 px-2.5 py-2"
                  >
                    <div className="flex flex-wrap items-center gap-1.5">
                      <MetaPill label="Provider" value={attemptProvider || undefined} />
                      <MetaPill label="Reason" value={attemptReason || undefined} />
                      <MetaPill label="State" value={attemptSource || undefined} />
                      {attemptCacheHit ? <MetaPill label="Cache" value="hit" /> : null}
                      <span
                        className={`inline-flex items-center rounded-full px-2 py-1 text-[10px] font-700 uppercase tracking-[0.12em] ${attemptStatus.className}`}
                      >
                        {attemptStatus.label}
                      </span>
                    </div>
                    {attemptError ? (
                      <div className="mt-2 text-[11px] leading-relaxed text-[var(--text-secondary)]">
                        {attemptError}
                      </div>
                    ) : null}
                  </div>
                )
              })}
            </div>
          </div>
        ) : null}
        {crossSourceInsights ? (
          <div className="mt-3 rounded-lg border border-[rgba(15,23,42,0.05)] bg-[rgba(15,23,42,0.03)] px-3 py-2">
            <div className="mb-2 text-[10px] font-700 uppercase tracking-[0.12em] text-[var(--accent-soft-strong)]">
              Cross-Source Check
            </div>
            <div className="flex flex-wrap gap-1.5">
              <MetaPill
                label="Signal"
                value={asText(crossSourceInsights.overallSignal) || undefined}
              />
              <MetaPill
                label="Sources"
                value={
                  typeof crossSourceInsights.comparedSources === 'number'
                    ? `${Math.round(crossSourceInsights.comparedSources)}`
                    : undefined
                }
              />
              <MetaPill
                label="Domains"
                value={
                  typeof crossSourceInsights.uniqueDomains === 'number'
                    ? `${Math.round(crossSourceInsights.uniqueDomains)}`
                    : undefined
                }
              />
            </div>
            {Array.isArray(crossSourceInsights.corroboratingClaims) &&
            crossSourceInsights.corroboratingClaims.length > 0 ? (
              <div className="mt-2 flex flex-col gap-2">
                {crossSourceInsights.corroboratingClaims
                  .filter(isRecord)
                  .slice(0, 3)
                  .map((entry, index) => (
                    <div
                      key={`corroboration-${index}`}
                      className="rounded-lg border border-emerald-100 bg-emerald-50/60 px-2.5 py-2"
                    >
                      <div className="flex flex-wrap gap-1.5">
                        <MetaPill label="Check" value="corroborated" />
                        <MetaPill
                          label="Score"
                          value={
                            typeof entry.confidenceScore === 'number'
                              ? `${Math.round(entry.confidenceScore)}`
                              : undefined
                          }
                        />
                        <MetaPill
                          label="Sources"
                          value={asTextArray(entry.sources).join(' / ') || undefined}
                        />
                      </div>
                      <div className="mt-2 text-[11px] leading-relaxed text-[var(--text-primary)]">
                        {asText(entry.summary)}
                      </div>
                    </div>
                  ))}
              </div>
            ) : null}
            {Array.isArray(crossSourceInsights.conflictingSignals) &&
            crossSourceInsights.conflictingSignals.length > 0 ? (
              <div className="mt-2 flex flex-col gap-2">
                {crossSourceInsights.conflictingSignals
                  .filter(isRecord)
                  .slice(0, 3)
                  .map((entry, index) => (
                    <div
                      key={`conflict-${index}`}
                      className="rounded-lg border border-amber-100 bg-amber-50/60 px-2.5 py-2"
                    >
                      <div className="flex flex-wrap gap-1.5">
                        <MetaPill label="Check" value="conflict" />
                        <MetaPill
                          label="Sources"
                          value={asTextArray(entry.sources).join(' / ') || undefined}
                        />
                      </div>
                      <div className="mt-2 text-[11px] leading-relaxed text-[var(--text-primary)]">
                        {asText(entry.summary)}
                      </div>
                    </div>
                  ))}
              </div>
            ) : null}
            {asTextArray(crossSourceInsights.weakerSources).length > 0 ? (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {asTextArray(crossSourceInsights.weakerSources).map(source => (
                  <MetaPill key={source} label="Weaker" value={source} />
                ))}
              </div>
            ) : null}
          </div>
        ) : null}
        {keyPoints.length > 0 ? (
          <div className="mt-3 rounded-lg border border-[rgba(15,23,42,0.05)] bg-[rgba(15,23,42,0.03)] px-3 py-2">
            <div className="mb-1 text-[10px] font-700 uppercase tracking-[0.12em] text-[var(--accent-soft-strong)]">
              Key Points
            </div>
            <div className="flex flex-col gap-1.5 text-[11px] leading-relaxed text-[var(--text-primary)]">
              {keyPoints.map((point, index) => (
                <div key={`${point}-${index}`}>{point}</div>
              ))}
            </div>
          </div>
        ) : null}
        {evidenceBlocks.length > 0 ? (
          <div className="mt-3 rounded-lg border border-[rgba(15,23,42,0.05)] bg-[rgba(15,23,42,0.03)] px-3 py-2">
            <div className="mb-2 text-[10px] font-700 uppercase tracking-[0.12em] text-[var(--accent-soft-strong)]">
              Evidence
            </div>
            <div className="flex flex-col gap-2">
              {evidenceBlocks.map((entry, index) => {
                const claim = asText(entry.claim) || asText(entry.supportingQuote)
                const kind = asText(entry.kind)
                const matchedKeywords = asTextArray(entry.matchedKeywords)
                const evidenceScore =
                  typeof entry.evidenceScore === 'number'
                    ? Math.round(entry.evidenceScore)
                    : undefined

                if (!claim) {
                  return null
                }

                return (
                  <div
                    key={`${claim}-${index}`}
                    className="rounded-lg border border-white/80 bg-white/85 px-2.5 py-2"
                  >
                    <div className="flex flex-wrap items-center gap-1.5">
                      <MetaPill label="Type" value={kind || undefined} />
                      <MetaPill
                        label="Score"
                        value={evidenceScore !== undefined ? `${evidenceScore}` : undefined}
                      />
                      {matchedKeywords.length > 0 ? (
                        <MetaPill label="Match" value={matchedKeywords.join(', ')} />
                      ) : null}
                    </div>
                    <div className="mt-2 text-[11px] leading-relaxed text-[var(--text-primary)]">
                      {claim}
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        ) : null}
        {preview ? (
          <div className="mt-3 rounded-lg border border-[rgba(15,23,42,0.05)] bg-[rgba(15,23,42,0.03)] px-3 py-2">
            <div className="mb-1 text-[10px] font-700 uppercase tracking-[0.12em] text-[var(--accent-soft-strong)]">
              Content
            </div>
            <div className="whitespace-pre-wrap text-[11px] leading-relaxed text-[var(--text-primary)]">
              {preview}
              {!expanded && canExpand ? '...' : ''}
            </div>
            {canExpand ? (
              <button
                className="mt-2 text-[11px] font-600 text-[var(--accent-soft-strong)]"
                onClick={() => setExpanded(current => !current)}
                type="button"
              >
                {expanded ? '收起正文' : '展开正文'}
              </button>
            ) : null}
          </div>
        ) : event.status === 'running' ? (
          <div className="mt-2 text-[12px] text-[var(--text-secondary)]">正在抓取并提取页面正文...</div>
        ) : null}
      </div>
    </div>
  )
}
