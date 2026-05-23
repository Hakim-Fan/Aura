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
          id: meta.id || meta.blockId,
          ...meta,
        }),
      )}\n`,
    )
  }
}

function emit(event) {
  return process.stdout.write(`${JSON.stringify(sanitizePayload(event))}\n`)
}

function waitForStdoutDrain() {
  return new Promise((resolve) => {
    process.stdout.once('drain', resolve)
  })
}

function flushStdout() {
  return new Promise((resolve) => {
    process.stdout.write('', resolve)
  })
}

async function emitAndFlush(event) {
  const accepted = emit(event)
  if (!accepted) {
    await waitForStdoutDrain()
  }
  await flushStdout()
}

const PHASE_STALL_TIMEOUTS_MS = {
  preparing: 20_000,
  planning: 60_000,
  compressing_context: 90_000,
  model_connecting: 45_000,
  model_streaming: 30_000,
  tool_running: 120_000,
  finalizing: 60_000,
  recovering: 60_000,
  awaiting_approval: Number.POSITIVE_INFINITY,
  awaiting_user_input: Number.POSITIVE_INFINITY,
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
let pendingApprovalRequest = null
let pendingUserInputResolve = null
const pendingAppActionRequests = new Map()
const taskApprovalGrants = new Set()
let started = false
const appendedInputs = []
let currentStepAbortController = null
let activeExecutionMonitor = null

function clearTaskScopedApprovals() {
  taskApprovalGrants.clear()
}

function stripInlineImageData(parts = []) {
  return parts.map((part) =>
    part && part.type === 'image'
      ? {
        ...part,
        dataUrl: undefined,
      }
      : part,
  )
}

function stripAttachmentPreviews(attachments = []) {
  return attachments.map((attachment) => ({
    ...attachment,
    preview: undefined,
  }))
}

function emitAppendedInputs() {
  emit({
    type: 'appended_inputs',
    inputs: appendedInputs.map((input) => ({
      ...input,
      parts: stripInlineImageData(Array.isArray(input.parts) ? input.parts : []),
      attachments: stripAttachmentPreviews(
        Array.isArray(input.attachments) ? input.attachments : [],
      ),
    })),
  })
}

const rl = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
})

async function finishProcess(exitCode = 0) {
  process.exitCode = exitCode
  rl.close()
  if (process.stdout.writableNeedDrain) {
    await waitForStdoutDrain()
  }
  await flushStdout()
  process.exit(exitCode)
}

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
      const decision =
        message.decision === 'approve' || message.decision === 'approve_for_task'
          ? message.decision
          : 'deny'
      if (decision === 'approve_for_task') {
        const category =
          typeof pendingApprovalRequest?.category === 'string'
            ? pendingApprovalRequest.category
            : ''
        if (category) {
          taskApprovalGrants.add(category)
        }
      }
      pendingApprovalResolve(decision === 'deny' ? 'deny' : 'approve')
      pendingApprovalResolve = null
      pendingApprovalRequest = null
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
      researchMode: input.researchMode === 'deep' ? 'deep' : 'auto',
    })
    if (pendingUserInputResolve) {
      activeExecutionMonitor?.setPhase('preparing')
      pendingUserInputResolve({
        status: 'received',
        content:
          typeof input.content === 'string' ? input.content : '',
        attachmentCount: Array.isArray(input.attachments)
          ? input.attachments.length
          : 0,
      })
      pendingUserInputResolve = null
    }
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
  activeExecutionMonitor = executionMonitor
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
        createdAt:
          typeof meta.createdAt === 'number' && Number.isFinite(meta.createdAt)
            ? meta.createdAt
            : Date.now(),
      })
    },
    onReasoningDiscard(event = {}) {
      executionMonitor.markProgress()
      emit({
        type: 'reasoning_discard',
        blockId: event.blockId,
        reason: event.reason,
        attemptNumber: event.attemptNumber,
        nextAttemptNumber: event.nextAttemptNumber,
      })
    },
    onUsage(usage) {
      executionMonitor.markProgress()
      emit({ type: 'usage', usage })
    },
    onContextCompression(contextCompression) {
      executionMonitor.setPhase('compressing_context')
      emit({ type: 'context_compression', contextCompression })
    },
    onRetryProgress(retryInfo) {
      executionMonitor.markProgress()
      emit({ type: 'retry_progress', retryInfo })
    },
    onToolEvent(event) {
      executionMonitor.markProgress()
      emit({ type: 'tool_event', event })
    },
    onTaskTree(tree) {
      executionMonitor.markProgress()
      emit({ type: 'task_tree', tree })
    },
    onRouteDecision(routeDecision) {
      executionMonitor.markProgress()
      emit({ type: 'route_decision', routeDecision })
    },
    onRuntimeLog(event) {
      executionMonitor.markProgress()
      emit({ type: 'runtime_log', event })
    },
    onWorkMemory(memory) {
      executionMonitor.markProgress()
      emit({ type: 'work_memory', memory })
    },
    onProgress() {
      executionMonitor.markProgress()
    },
    onPhaseChange(phase, meta = {}) {
      executionMonitor.setPhase(phase, meta)
    },
    requestApproval(request) {
      if (
        typeof request?.category === 'string' &&
        taskApprovalGrants.has(request.category)
      ) {
        return Promise.resolve('approve')
      }
      executionMonitor.setPhase('awaiting_approval', { markProgress: false })
      emit({ type: 'approval_required', request })
      return new Promise((resolve) => {
        pendingApprovalRequest = request
        pendingApprovalResolve = resolve
      })
    },
    isApprovalGranted(category) {
      return typeof category === 'string' && taskApprovalGrants.has(category)
    },
    requestUserInput(request) {
      executionMonitor.setPhase('awaiting_user_input', { markProgress: false })
      emit({ type: 'user_input_required', request })
      return new Promise((resolve) => {
        pendingUserInputResolve = resolve
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
        researchMode: input.researchMode === 'deep' ? 'deep' : 'auto',
      }))
    },
    hasQueuedAppendedInputs() {
      return appendedInputs.some((input) => input.status === 'queued')
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
    .then(async (result) => {
      executionMonitor.stop()
      activeExecutionMonitor = null
      clearTaskScopedApprovals()
      await emitAndFlush({
        type: 'completed',
        result,
      })
      await finishProcess(0)
    })
    .catch(async (error) => {
      executionMonitor.stop()
      activeExecutionMonitor = null
      clearTaskScopedApprovals()
      await emitAndFlush({
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
      await finishProcess(1)
    })
})
