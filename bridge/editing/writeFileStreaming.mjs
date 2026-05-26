const WRITE_FILE_ARGUMENT_KEYS = {
  path: ['path', 'file_path'],
  content: ['content'],
}

function decodeJsonStringPrefix(value) {
  let output = ''
  let escaped = false
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]

    if (escaped) {
      switch (char) {
        case 'n':
          output += '\n'
          break
        case 'r':
          output += '\r'
          break
        case 't':
          output += '\t'
          break
        case '"':
        case '\\':
        case '/':
          output += char
          break
        default:
          output += char
          break
      }
      escaped = false
      continue
    }

    if (char === '\\') {
      escaped = true
      continue
    }

    if (char === '"') {
      break
    }

    output += char
  }

  return output
}

function extractJsonStringArgumentPrefix(rawArgs, key) {
  const pattern = new RegExp(`"${key}"\\s*:\\s*"`, 'u')
  const match = pattern.exec(rawArgs)
  if (!match) {
    return ''
  }
  return decodeJsonStringPrefix(rawArgs.slice(match.index + match[0].length))
}

function firstStringArgument(parsed, keys) {
  for (const key of keys) {
    if (typeof parsed?.[key] === 'string') {
      return parsed[key]
    }
  }
  return ''
}

function firstStringArgumentPrefix(rawArgs, keys) {
  for (const key of keys) {
    const value = extractJsonStringArgumentPrefix(rawArgs, key)
    if (value) {
      return value
    }
  }
  return ''
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return '0 B'
  }
  if (bytes < 1024) {
    return `${Math.round(bytes)} B`
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function summarizeWriteFileProgress(rawArgs) {
  const rawText = String(rawArgs || '')
  const trimmed = rawText.trim()
  if (!trimmed) {
    return null
  }

  let pathLabel = ''
  let content = ''
  let complete = false

  try {
    const parsed = JSON.parse(trimmed)
    pathLabel = firstStringArgument(parsed, WRITE_FILE_ARGUMENT_KEYS.path)
    content = firstStringArgument(parsed, WRITE_FILE_ARGUMENT_KEYS.content)
    complete = true
  } catch {
    pathLabel = firstStringArgumentPrefix(rawText, WRITE_FILE_ARGUMENT_KEYS.path)
    content = firstStringArgumentPrefix(rawText, WRITE_FILE_ARGUMENT_KEYS.content)
  }

  const contentBytes = Buffer.byteLength(content, 'utf8')
  const hasObservableProgress = Boolean(pathLabel) || contentBytes > 0
  if (!hasObservableProgress) {
    return null
  }

  const affectedPaths = pathLabel ? [pathLabel] : []
  const operations = pathLabel
    ? [
        {
          kind: 'write',
          path: pathLabel,
        },
      ]
    : []
  const sizeLabel = formatBytes(contentBytes)
  const targetLabel = pathLabel || 'file content'

  return {
    stage: 'edit_transaction_preview',
    phase: complete ? 'streaming_complete' : 'streaming_preview',
    operation: 'write_file_streaming',
    affectedPaths,
    operations,
    filePath: pathLabel || undefined,
    contentBytes,
    contentChars: content.length,
    complete,
    summary: complete
      ? `Generated write_file content for ${targetLabel} (${sizeLabel}).`
      : `Generating write_file content for ${targetLabel} (${sizeLabel}).`,
  }
}

export function createWriteFileStreamingReporter({ hooks = {}, order } = {}) {
  const eventsByToolCall = new Map()

  function emptyProgress() {
    return {
      stage: 'edit_transaction_preview',
      phase: 'streaming_preview',
      operation: 'write_file_streaming',
      affectedPaths: [],
      operations: [],
      contentBytes: 0,
      contentChars: 0,
      complete: false,
      summary: 'Generating write_file content...',
    }
  }

  function emit(toolCall, progress) {
    const toolCallId =
      typeof toolCall?.id === 'string' && toolCall.id.trim()
        ? toolCall.id.trim()
        : `index-${toolCall?.index ?? 0}`
    const existing = eventsByToolCall.get(toolCallId)
    const contentByteBucket = Math.floor((progress.contentBytes || 0) / 4096)
    const fingerprint = JSON.stringify({
      phase: progress.phase,
      filePath: progress.filePath || '',
      contentByteBucket,
      complete: progress.complete,
    })

    if (existing?.fingerprint === fingerprint) {
      return
    }

    const eventId =
      existing?.eventId ||
      (typeof hooks.createExecutionStepId === 'function'
        ? hooks.createExecutionStepId('tool', 'write-file-stream')
        : `write-file-stream-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
    eventsByToolCall.set(toolCallId, {
      eventId,
      fingerprint,
    })

    hooks.onToolEvent?.({
      id: eventId,
      source: 'builtin',
      name: 'write_file',
      summary: progress.summary,
      order,
      status: 'running',
      input: 'Streaming write_file arguments',
      output: JSON.stringify(progress, null, 2),
    })
  }

  return {
    inspect(toolCalls = []) {
      for (const toolCall of Array.isArray(toolCalls) ? toolCalls : []) {
        if (toolCall?.function?.name !== 'write_file') {
          continue
        }
        const progress = summarizeWriteFileProgress(toolCall.function.arguments || '')
        emit(toolCall, progress || emptyProgress())
      }
    },
  }
}
