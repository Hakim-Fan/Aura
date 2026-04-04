import readline from 'node:readline'
import { runAgent } from './agent.mjs'

function sanitizeUtf16(value) {
  if (typeof value !== 'string' || value.length === 0) {
    return value
  }

  let result = ''
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (next >= 0xdc00 && next <= 0xdfff) {
        result += value[index] + value[index + 1]
        index += 1
      } else {
        result += '�'
      }
      continue
    }

    if (code >= 0xdc00 && code <= 0xdfff) {
      result += '�'
      continue
    }

    result += value[index]
  }

  return result
}

function sanitizePayload(value) {
  if (typeof value === 'string') {
    return sanitizeUtf16(value)
  }
  if (Array.isArray(value)) {
    return value.map(entry => sanitizePayload(entry))
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, sanitizePayload(entry)]),
    )
  }
  return value
}

function createDeltaEmitter(type) {
  let pendingHighSurrogate = ''

  return (rawDelta, meta = {}) => {
    if (!rawDelta) {
      return
    }

    let delta = `${pendingHighSurrogate}${rawDelta}`
    pendingHighSurrogate = ''

    const lastCode = delta.charCodeAt(delta.length - 1)
    if (lastCode >= 0xd800 && lastCode <= 0xdbff) {
      pendingHighSurrogate = delta.slice(-1)
      delta = delta.slice(0, -1)
    }

    delta = sanitizeUtf16(delta)
    if (!delta) {
      return
    }

    process.stdout.write(
      `${JSON.stringify(
        sanitizePayload({
          type,
          delta,
          ...meta,
        }),
      )}\n`,
    )
  }
}

function emit(event) {
  process.stdout.write(`${JSON.stringify(sanitizePayload(event))}\n`)
}

let pendingApprovalResolve = null
let started = false

const rl = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
})

rl.on('line', line => {
  let message
  try {
    message = JSON.parse(line)
  } catch (error) {
    emit({
      type: 'failed',
      message: `Invalid IPC message: ${error instanceof Error ? error.message : String(error)}`,
    })
    return
  }

  if (message.type === 'approval') {
    if (pendingApprovalResolve) {
      pendingApprovalResolve(message.decision === 'approve' ? 'approve' : 'deny')
      pendingApprovalResolve = null
    }
    return
  }

  if (message.type !== 'start' || started) {
    return
  }

  started = true
  emit({ type: 'started' })
  const emitTextDelta = createDeltaEmitter('text_delta')
  const emitReasoningDelta = createDeltaEmitter('reasoning_delta')

  const hooks = {
    onTextDelta(delta) {
      emitTextDelta(delta)
    },
    onReasoningDelta(delta, meta = {}) {
      emitReasoningDelta(delta, {
        blockId: meta.blockId,
        kind: meta.kind,
      })
    },
    onUsage(usage) {
      emit({ type: 'usage', usage })
    },
    onToolEvent(event) {
      emit({ type: 'tool_event', event })
    },
    onTaskTree(tree) {
      emit({ type: 'task_tree', tree })
    },
    requestApproval(request) {
      emit({ type: 'approval_required', request })
      return new Promise(resolve => {
        pendingApprovalResolve = resolve
      })
    },
  }

  runAgent({
    ...message.payload,
    hooks,
  })
    .then(result => {
      emit({
        type: 'completed',
        result,
      })
    })
    .catch(error => {
      emit({
        type: 'failed',
        message: error instanceof Error ? error.message : String(error),
      })
      process.exitCode = 1
    })
})
