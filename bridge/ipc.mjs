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
    return value.map((entry) => sanitizePayload(entry))
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        sanitizePayload(entry),
      ]),
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

const PHASE_STALL_TIMEOUTS_MS = {
  preparing: 20_000,
  model_connecting: 45_000,
  model_streaming: 90_000,
  tool_running: 120_000,
  finalizing: 60_000,
  recovering: 60_000,
  awaiting_approval: Number.POSITIVE_INFINITY,
}

function createExecutionMonitor() {
  let phase = 'preparing'
  let phaseStartedAt = Date.now()
  let lastProgressAt = phaseStartedAt
  let lastHeartbeatAt = phaseStartedAt
  let timer = null

  function emitStatus() {
    lastHeartbeatAt = Date.now()
    const timeoutMs = PHASE_STALL_TIMEOUTS_MS[phase] || 60_000
    const stalled =
      Number.isFinite(timeoutMs) && lastHeartbeatAt - lastProgressAt > timeoutMs

    emit({
      type: 'runtime_status',
      phase,
      phaseStartedAt,
      lastHeartbeatAt,
      lastProgressAt,
      stalled,
    })
  }

  return {
    start() {
      emitStatus()
      timer = setInterval(() => {
        emitStatus()
      }, 2_000)
      timer.unref?.()
    },
    stop() {
      if (timer) {
        clearInterval(timer)
        timer = null
      }
    },
    markProgress() {
      lastProgressAt = Date.now()
      emitStatus()
    },
    setPhase(nextPhase, { markProgress = true } = {}) {
      if (!nextPhase) {
        return
      }
      const now = Date.now()
      phase = nextPhase
      phaseStartedAt = now
      if (markProgress) {
        lastProgressAt = now
      }
      emitStatus()
    },
  }
}

let pendingApprovalResolve = null
const pendingAppActionRequests = new Map()
let started = false
const appendedInputs = []
let currentStepAbortController = null

function emitAppendedInputs() {
  emit({
    type: 'appended_inputs',
    inputs: appendedInputs,
  })
}

const rl = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
})

rl.on('line', (line) => {
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
      pendingApprovalResolve(
        message.decision === 'approve' ? 'approve' : 'deny',
      )
      pendingApprovalResolve = null
    }
    return
  }

  if (message.type === 'app_action_result') {
    const requestId =
      typeof message.requestId === 'string' ? message.requestId : ''
    if (!requestId) {
      return
    }
    const pending = pendingAppActionRequests.get(requestId)
    if (!pending) {
      return
    }
    pendingAppActionRequests.delete(requestId)
    if (message.ok === false) {
      pending.reject(
        new Error(
          typeof message.error === 'string'
            ? message.error
            : 'App action failed',
        ),
      )
      return
    }
    pending.resolve(message.result)
    return
  }

  if (message.type === 'append_input') {
    const input = message.input
    if (!input || typeof input !== 'object') {
      return
    }

    appendedInputs.push({
      id:
        typeof input.id === 'string' && input.id.trim()
          ? input.id
          : `appended-${Date.now()}`,
      content: typeof input.content === 'string' ? input.content : '',
      parts: Array.isArray(input.parts) ? input.parts : [],
      attachments: Array.isArray(input.attachments) ? input.attachments : [],
      createdAt:
        typeof input.createdAt === 'number' && Number.isFinite(input.createdAt)
          ? input.createdAt
          : Date.now(),
      status: 'queued',
    })
    emitAppendedInputs()
    return
  }

  if (message.type === 'cancel_current_step') {
    if (
      currentStepAbortController &&
      !currentStepAbortController.signal.aborted
    ) {
      currentStepAbortController.abort(
        new Error('Current step cancelled by the user.'),
      )
    }
    return
  }

  if (message.type !== 'start' || started) {
    return
  }

  started = true
  emit({ type: 'started' })
  const executionMonitor = createExecutionMonitor()
  executionMonitor.start()
  const emitTextDelta = createDeltaEmitter('text_delta')
  const emitReasoningDelta = createDeltaEmitter('reasoning_delta')

  const hooks = {
    onTextDelta(delta, meta = {}) {
      executionMonitor.markProgress()
      emitTextDelta(delta, {
        blockId: meta.blockId,
        order: meta.order,
        target: meta.target,
      })
    },
    onReasoningDelta(delta, meta = {}) {
      executionMonitor.markProgress()
      emitReasoningDelta(delta, {
        blockId: meta.blockId,
        kind: meta.kind,
        order: meta.order,
      })
    },
    onUsage(usage) {
      executionMonitor.markProgress()
      emit({ type: 'usage', usage })
    },
    onToolEvent(event) {
      executionMonitor.markProgress()
      emit({ type: 'tool_event', event })
    },
    onTaskTree(tree) {
      executionMonitor.markProgress()
      emit({ type: 'task_tree', tree })
    },
    onProgress() {
      executionMonitor.markProgress()
    },
    onPhaseChange(phase, meta = {}) {
      executionMonitor.setPhase(phase, meta)
    },
    requestApproval(request) {
      executionMonitor.setPhase('awaiting_approval', { markProgress: false })
      emit({ type: 'approval_required', request })
      return new Promise((resolve) => {
        pendingApprovalResolve = resolve
      })
    },
    appControl(action, payload = {}) {
      const requestId = `app-action-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      emit({
        type: 'app_action_request',
        requestId,
        action,
        payload,
      })
      return new Promise((resolve, reject) => {
        pendingAppActionRequests.set(requestId, { resolve, reject })
      })
    },
    consumeAppendedInputs() {
      const queuedInputs = appendedInputs.filter(
        (input) => input.status === 'queued',
      )
      if (queuedInputs.length === 0) {
        return []
      }

      for (const input of queuedInputs) {
        input.status = 'consumed'
      }
      emitAppendedInputs()
      return queuedInputs.map((input) => ({
        id: input.id,
        role: 'user',
        content: input.content,
        parts: Array.isArray(input.parts) ? input.parts : [],
        attachments: Array.isArray(input.attachments) ? input.attachments : [],
        createdAt: input.createdAt,
      }))
    },
    createCurrentStepAbortController() {
      currentStepAbortController = new AbortController()
      return currentStepAbortController
    },
    releaseCurrentStepAbortController(controller) {
      if (currentStepAbortController === controller) {
        currentStepAbortController = null
      }
    },
  }

  runAgent({
    ...message.payload,
    hooks,
  })
    .then((result) => {
      executionMonitor.stop()
      emit({
        type: 'completed',
        result,
      })
    })
    .catch((error) => {
      executionMonitor.stop()
      emit({
        type: 'failed',
        message: error instanceof Error ? error.message : String(error),
        code:
          error &&
          typeof error === 'object' &&
          'code' in error &&
          typeof error.code === 'string'
            ? error.code
            : undefined,
        source:
          error &&
          typeof error === 'object' &&
          'source' in error &&
          typeof error.source === 'string'
            ? error.source
            : undefined,
        rawMessage:
          error &&
          typeof error === 'object' &&
          'rawMessage' in error &&
          typeof error.rawMessage === 'string'
            ? error.rawMessage
            : undefined,
        errorInfo:
          error &&
          typeof error === 'object' &&
          'errorInfo' in error &&
          error.errorInfo &&
          typeof error.errorInfo === 'object'
            ? error.errorInfo
            : undefined,
        retryInfo:
          error &&
          typeof error === 'object' &&
          'retryInfo' in error &&
          error.retryInfo &&
          typeof error.retryInfo === 'object'
            ? error.retryInfo
            : undefined,
        agentMode:
          error &&
          typeof error === 'object' &&
          'agentMode' in error &&
          typeof error.agentMode === 'string'
            ? error.agentMode
            : undefined,
        routeDecision:
          error &&
          typeof error === 'object' &&
          'routeDecision' in error &&
          error.routeDecision &&
          typeof error.routeDecision === 'object'
            ? error.routeDecision
            : undefined,
      })
      process.exitCode = 1
    })
})
