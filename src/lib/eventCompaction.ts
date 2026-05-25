import type { MessageEvent, MessageEventDetailPayload, ToolEvent } from '../types'

const MAX_EVENT_INPUT_CHARS = 4_000
const MAX_EVENT_OUTPUT_CHARS = 12_000
const MAX_STRUCTURED_STRING_CHARS = 4_000
const MAX_STRUCTURED_DEPTH = 6

function truncateText(value: unknown, maxChars: number) {
  if (typeof value !== 'string') {
    return value
  }
  if (value.length <= maxChars) {
    return value
  }
  return `${value.slice(0, Math.max(0, maxChars - 80)).trimEnd()}\n\n... [truncated ${value.length - maxChars} chars]`
}

function arrayLimitForKey(key: string) {
  switch (key) {
    case 'preview':
    case 'files':
      return 12
    case 'lines':
      return 80
    case 'results':
      return 10
    case 'attemptedProviders':
    case 'evidenceBlocks':
    case 'corroboratingClaims':
    case 'conflictingSignals':
      return 6
    case 'keyPoints':
    case 'riskFlags':
      return 12
    default:
      return 50
  }
}

function compactStructuredValue(value: unknown, key = '', depth = 0): unknown {
  if (typeof value === 'string') {
    return truncateText(value, MAX_STRUCTURED_STRING_CHARS)
  }
  if (typeof value !== 'object' || value === null) {
    return value
  }
  if (depth >= MAX_STRUCTURED_DEPTH) {
    return undefined
  }
  if (Array.isArray(value)) {
    return value
      .slice(0, arrayLimitForKey(key))
      .map(entry => compactStructuredValue(entry, key, depth + 1))
      .filter(entry => entry !== undefined)
  }

  const compacted: Record<string, unknown> = {}
  for (const [entryKey, entryValue] of Object.entries(value)) {
    const nextValue = compactStructuredValue(entryValue, entryKey, depth + 1)
    if (nextValue !== undefined) {
      compacted[entryKey] = nextValue
    }
  }
  return compacted
}

function compactStructuredOutput(value: unknown): Record<string, unknown> | undefined {
  const compacted = compactStructuredValue(value)
  return compacted && typeof compacted === 'object' && !Array.isArray(compacted)
    ? compacted as Record<string, unknown>
    : undefined
}

function shouldKeepCompactStructuredOutput(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }
  const record = value as Record<string, unknown>
  return (
    Array.isArray(record.preview) ||
    Array.isArray(record.files) ||
    Array.isArray(record.fileChanges) ||
    record.operation === 'shell_file_mutation' ||
    record.stage === 'shell_file_mutation'
  )
}

export function compactMessageEvent(event: MessageEvent): MessageEvent {
  return {
    ...event,
    input: truncateText(event.input, MAX_EVENT_INPUT_CHARS) as string | undefined,
    output: truncateText(event.output, MAX_EVENT_OUTPUT_CHARS) as string | undefined,
    error: truncateText(event.error, MAX_EVENT_OUTPUT_CHARS) as string | undefined,
    structuredOutput: compactStructuredOutput(event.structuredOutput),
  }
}

export function readMessageEventDetailPayload(
  event: Pick<MessageEvent, 'input' | 'output' | 'structuredOutput' | 'error'>,
): MessageEventDetailPayload | null {
  const detail: MessageEventDetailPayload = {}
  if (event.input) {
    detail.input = event.input
  }
  if (event.output) {
    detail.output = event.output
  }
  if (event.structuredOutput) {
    detail.structuredOutput = event.structuredOutput
  }
  if (event.error) {
    detail.error = event.error
  }
  return Object.keys(detail).length > 0 ? detail : null
}

export function stripMessageEventDetail(event: MessageEvent): MessageEvent {
  const detail = readMessageEventDetailPayload(event)
  if (!detail) {
    return compactMessageEvent(event)
  }
  return {
    ...event,
    input: undefined,
    output: undefined,
    structuredOutput: shouldKeepCompactStructuredOutput(event.structuredOutput)
      ? compactStructuredOutput(event.structuredOutput)
      : undefined,
    error: undefined,
    detailAvailable: true,
    detailRef: event.detailRef || event.id,
  }
}

export function compactToolEventPayload(event: ToolEvent): Pick<
  ToolEvent,
  'input' | 'output' | 'structuredOutput' | 'error'
> {
  return {
    input: truncateText(event.input, MAX_EVENT_INPUT_CHARS) as string | undefined,
    output: truncateText(event.output, MAX_EVENT_OUTPUT_CHARS) as string | undefined,
    structuredOutput: compactStructuredOutput(event.structuredOutput),
    error: truncateText(event.error, MAX_EVENT_OUTPUT_CHARS) as string | undefined,
  }
}
