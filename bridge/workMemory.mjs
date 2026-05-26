const VALID_WORK_MEMORY_STATUSES = new Set(['draft', 'confirmed', 'assumption'])

const MAX_KIND_CHARS = 80
const MAX_TITLE_CHARS = 160
const MAX_SUMMARY_CHARS = 1_200
const MAX_NEXT_USE_CHARS = 600
const MAX_CONTENT_JSON_CHARS = 8_000
const MAX_SOURCE_REFS = 12

function collapseWhitespace(value) {
  return String(value || '').replace(/\s+/g, ' ').trim()
}

function clipText(value, maxChars) {
  const normalized = collapseWhitespace(value)
  if (!normalized || normalized.length <= maxChars) {
    return normalized
  }
  return `${normalized.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`
}

function normalizeStatus(value) {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : ''
  return VALID_WORK_MEMORY_STATUSES.has(normalized) ? normalized : 'draft'
}

function normalizeToolEvidenceInput(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return {}
  }
  return Object.fromEntries(
    Object.entries(input)
      .filter(([key, entry]) =>
        [
          'path',
          'filePath',
          'startLine',
          'endLine',
          'mode',
          'query',
          'pattern',
          'command',
          'cwd',
          'skillId',
        ].includes(key) &&
        (typeof entry === 'string' || typeof entry === 'number' || typeof entry === 'boolean'),
      )
      .map(([key, entry]) => [
        key,
        typeof entry === 'string' ? clipText(entry, 360) : entry,
      ])
      .filter(([, entry]) => entry !== '' && entry !== undefined && entry !== null),
  )
}

function normalizeToolEvidenceFile(file = {}) {
  if (!file || typeof file !== 'object' || Array.isArray(file)) {
    return undefined
  }
  const normalized = Object.fromEntries(
    Object.entries(file)
      .filter(([key, entry]) =>
        [
          'path',
          'size',
          'mtimeMs',
          'outputSha256',
          'lineCount',
          'byteCount',
        ].includes(key) &&
        (typeof entry === 'string' || typeof entry === 'number'),
      )
      .map(([key, entry]) => [
        key,
        typeof entry === 'string' ? clipText(entry, 360) : entry,
      ])
      .filter(([, entry]) => entry !== '' && entry !== undefined && entry !== null),
  )
  return Object.keys(normalized).length > 0 ? normalized : undefined
}

function normalizeToolEvidenceEntry(entry = {}) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    return null
  }
  const normalized = {
    tool: clipText(entry.tool, 120),
    input: normalizeToolEvidenceInput(entry.input),
    file: normalizeToolEvidenceFile(entry.file),
    recordedAt: typeof entry.recordedAt === 'number' ? entry.recordedAt : undefined,
    restoredFromWorkMemory: entry.restoredFromWorkMemory === true || undefined,
    workMemoryId: clipText(entry.workMemoryId, 160) || undefined,
  }
  return normalized.tool ? normalized : null
}

function normalizeToolEvidenceContent(content, serialized) {
  const recentSuccesses = Array.isArray(content?.recentSuccesses)
    ? content.recentSuccesses
      .map(normalizeToolEvidenceEntry)
      .filter(Boolean)
      .slice(-12)
    : []
  return {
    truncated: true,
    preview: clipText(serialized, MAX_CONTENT_JSON_CHARS),
    recentSuccesses,
  }
}

function normalizeContent(value, options = {}) {
  const content =
    value && typeof value === 'object' && !Array.isArray(value)
      ? value
      : value === undefined || value === null || value === ''
        ? {}
        : { value }

  const serialized = JSON.stringify(content)
  if (serialized.length <= MAX_CONTENT_JSON_CHARS) {
    return content
  }

  if (options.kind === 'tool_evidence' && Array.isArray(content.recentSuccesses)) {
    return normalizeToolEvidenceContent(content, serialized)
  }

  return {
    truncated: true,
    preview: clipText(serialized, MAX_CONTENT_JSON_CHARS),
  }
}

function normalizeSourceRef(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }

  const normalized = Object.fromEntries(
    Object.entries(value)
      .filter(([, entry]) => typeof entry === 'string' || typeof entry === 'number')
      .map(([key, entry]) => [key, clipText(String(entry), 240)])
      .filter(([, entry]) => Boolean(entry)),
  )

  return Object.keys(normalized).length > 0 ? normalized : null
}

function normalizeSourceRefs(value) {
  if (!Array.isArray(value)) {
    return []
  }

  return value
    .map(normalizeSourceRef)
    .filter(Boolean)
    .slice(0, MAX_SOURCE_REFS)
}

export function normalizeWorkMemoryInput(args = {}, defaults = {}) {
  const sessionId = clipText(args.sessionId || defaults.sessionId, 120)
  const taskId = clipText(args.taskId || defaults.taskId, 120)
  const assistantMessageId = clipText(
    args.assistantMessageId || defaults.assistantMessageId,
    120,
  )
  const kind = clipText(args.kind || 'phase_artifact', MAX_KIND_CHARS) || 'phase_artifact'
  const title = clipText(args.title || kind, MAX_TITLE_CHARS)
  const summary = clipText(args.summary, MAX_SUMMARY_CHARS)

  if (!summary) {
    throw new Error('record_work_memory requires a concise summary.')
  }

  return {
    id: clipText(args.id, 160) || undefined,
    sessionId: sessionId || undefined,
    taskId: taskId || undefined,
    assistantMessageId: assistantMessageId || undefined,
    kind,
    title: title || kind,
    summary,
    status: normalizeStatus(args.status),
    content: normalizeContent(args.content, { kind }),
    sourceRefs: normalizeSourceRefs(args.sourceRefs || args.sources),
    nextUse: clipText(args.nextUse, MAX_NEXT_USE_CHARS) || undefined,
  }
}

export function upsertWorkMemory(memoryList = [], memory) {
  if (!memory || typeof memory !== 'object') {
    return memoryList
  }

  const id = typeof memory.id === 'string' ? memory.id : ''
  if (!id) {
    return [...memoryList, memory]
  }

  const next = [...memoryList]
  const existingIndex = next.findIndex(entry => entry?.id === id)
  if (existingIndex >= 0) {
    next[existingIndex] = memory
  } else {
    next.push(memory)
  }
  return next
}
