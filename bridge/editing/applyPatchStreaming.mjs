const PATCH_ARGUMENT_KEYS = ['patch', 'input', 'command', 'content']

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

export function extractApplyPatchArgumentText(rawArgs) {
  const rawText = String(rawArgs || '')
  const trimmed = rawText.trim()
  if (!trimmed) {
    return ''
  }

  if (trimmed.startsWith('*** Begin Patch')) {
    return trimmed
  }

  try {
    const parsed = JSON.parse(trimmed)
    for (const key of PATCH_ARGUMENT_KEYS) {
      if (typeof parsed?.[key] === 'string' && parsed[key].trim()) {
        return parsed[key]
      }
    }
  } catch {
    // Streaming JSON is often incomplete; fall through to prefix extraction.
  }

  for (const key of PATCH_ARGUMENT_KEYS) {
    const value = extractJsonStringArgumentPrefix(rawText, key)
    if (value.trim()) {
      return value
    }
  }

  if (trimmed.includes('*** Begin Patch')) {
    return trimmed
  }

  return ''
}

function normalizePatchPath(value) {
  return String(value || '').trim()
}

export function summarizeApplyPatchProgress(rawArgs) {
  const patchText = extractApplyPatchArgumentText(rawArgs)
  if (!patchText.includes('*** Begin Patch')) {
    return null
  }

  const operations = []
  const affectedPaths = []
  const lines = patchText.replace(/\r\n/g, '\n').split('\n')
  let complete = false

  for (const line of lines) {
    if (line === '*** End Patch') {
      complete = true
      break
    }

    const addMatch = /^\*\*\* Add File:\s+(.+)$/u.exec(line)
    if (addMatch) {
      const nextPath = normalizePatchPath(addMatch[1])
      operations.push({ kind: 'add', path: nextPath })
      affectedPaths.push(nextPath)
      continue
    }

    const updateMatch = /^\*\*\* Update File:\s+(.+)$/u.exec(line)
    if (updateMatch) {
      const nextPath = normalizePatchPath(updateMatch[1])
      operations.push({ kind: 'update', path: nextPath })
      affectedPaths.push(nextPath)
      continue
    }

    const deleteMatch = /^\*\*\* Delete File:\s+(.+)$/u.exec(line)
    if (deleteMatch) {
      const nextPath = normalizePatchPath(deleteMatch[1])
      operations.push({ kind: 'delete', path: nextPath })
      affectedPaths.push(nextPath)
      continue
    }

    const moveMatch = /^\*\*\* Move to:\s+(.+)$/u.exec(line)
    if (moveMatch) {
      const nextPath = normalizePatchPath(moveMatch[1])
      const previousOperation = operations.at(-1)
      if (previousOperation?.kind === 'update') {
        previousOperation.moveTo = nextPath
      }
      affectedPaths.push(nextPath)
    }
  }

  const uniqueAffectedPaths = Array.from(new Set(affectedPaths.filter(Boolean)))
  if (uniqueAffectedPaths.length === 0) {
    return null
  }

  return {
    stage: 'patch_progress',
    phase: complete ? 'streaming_complete' : 'streaming_preview',
    operationCount: operations.length,
    affectedPaths: uniqueAffectedPaths,
    operations,
    complete,
    summary: complete
      ? `Generated patch for ${uniqueAffectedPaths.length} file(s).`
      : `Generating patch for ${uniqueAffectedPaths.length} file(s).`,
  }
}

export function createApplyPatchStreamingReporter({ hooks = {}, order } = {}) {
  const eventsByToolCall = new Map()

  function emit(toolCall, progress) {
    const toolCallId =
      typeof toolCall?.id === 'string' && toolCall.id.trim()
        ? toolCall.id.trim()
        : `index-${toolCall?.index ?? 0}`
    const existing = eventsByToolCall.get(toolCallId)
    const fingerprint = JSON.stringify({
      phase: progress.phase,
      operationCount: progress.operationCount,
      affectedPaths: progress.affectedPaths,
      complete: progress.complete,
    })

    if (existing?.fingerprint === fingerprint) {
      return
    }

    const eventId =
      existing?.eventId ||
      `apply-patch-stream-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    eventsByToolCall.set(toolCallId, {
      eventId,
      fingerprint,
    })

    hooks.onToolEvent?.({
      id: eventId,
      source: 'builtin',
      name: 'apply_patch',
      summary: progress.summary,
      order,
      status: 'running',
      input: 'Streaming apply_patch arguments',
      output: JSON.stringify(progress, null, 2),
    })
  }

  return {
    inspect(toolCalls = []) {
      for (const toolCall of Array.isArray(toolCalls) ? toolCalls : []) {
        if (toolCall?.function?.name !== 'apply_patch') {
          continue
        }
        const progress = summarizeApplyPatchProgress(toolCall.function.arguments || '')
        if (!progress) {
          continue
        }
        emit(toolCall, progress)
      }
    },
  }
}
