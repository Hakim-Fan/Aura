const DEFAULT_EVENT_VERSION = 1

const ARCHITECTURE_MODE_ALIASES = new Map([
  ['route-first', 'legacy'],
  ['legacy', 'legacy'],
  ['hybrid', 'hybrid'],
  ['graph', 'graph'],
  ['state-machine', 'graph'],
  ['orchestrated', 'orchestrated'],
])

function safeString(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function randomIdPart(random = Math.random) {
  return random().toString(36).slice(2, 8)
}

function createRunId(now = Date.now, random = Math.random) {
  return `run-${now().toString(36)}-${randomIdPart(random)}`
}

function compactArray(value, maxItems = 20) {
  return Array.isArray(value) ? value.slice(0, maxItems) : []
}

function compactString(value, maxLength = 1200) {
  const normalized = String(value || '').replace(/\s+/g, ' ').trim()
  if (!normalized) {
    return ''
  }
  return normalized.length > maxLength
    ? `${normalized.slice(0, maxLength)}...`
    : normalized
}

function safeNumber(value) {
  const number = Number(value)
  return Number.isFinite(number) ? number : undefined
}

export function normalizeAgentArchitectureMode(value) {
  const normalized = safeString(value).toLowerCase()
  return ARCHITECTURE_MODE_ALIASES.get(normalized) || 'legacy'
}

export function resolveAgentExecutionMode(settings = {}) {
  const requestedArchitectureMode = safeString(settings?.agentArchitectureMode) || 'route-first'
  const architectureMode = normalizeAgentArchitectureMode(requestedArchitectureMode)
  const effectiveAgentMode = architectureMode === 'orchestrated'
    ? 'orchestrated'
    : 'route-first'
  const pathMode =
    architectureMode === 'legacy'
      ? 'standard'
      : architectureMode === 'hybrid'
        ? 'standard'
        : architectureMode === 'graph' || architectureMode === 'orchestrated'
          ? 'long'
          : 'standard'
  const fallbackToLegacy =
    false

  return {
    requestedArchitectureMode,
    architectureMode,
    effectiveAgentMode,
    pathMode,
    fallbackToLegacy,
  }
}

export function createAgentRuntimeLogger(options = {}) {
  const hooks = options.hooks || {}
  const logContext = options.logContext || {}
  const settings = options.settings || {}
  const mode = options.mode || resolveAgentExecutionMode(settings)
  const now = typeof options.now === 'function' ? options.now : Date.now
  const random = typeof options.random === 'function' ? options.random : Math.random
  const runId = options.runId || createRunId(now, random)
  const startedAt = now()

  const baseDetails = {
    runId,
    sessionId: safeString(logContext.sessionId) || undefined,
    taskId: safeString(logContext.taskId) || undefined,
    assistantMessageId: safeString(logContext.assistantMessageId) || undefined,
    userMessageId: safeString(logContext.userMessageId) || undefined,
    architectureMode: mode.architectureMode,
    requestedArchitectureMode: mode.requestedArchitectureMode,
    pathMode: mode.pathMode,
    eventVersion: DEFAULT_EVENT_VERSION,
  }

  function emit(event, details = {}, options = {}) {
    if (!event || typeof hooks?.onRuntimeLog !== 'function') {
      return
    }
    try {
      hooks.onRuntimeLog({
        event,
        level: options.level || 'info',
        details: {
          ...baseDetails,
          ...details,
        },
      })
    } catch {
      // Runtime logging must never alter the agent execution path.
    }
  }

  function elapsedMs() {
    return Math.max(0, now() - startedAt)
  }

  function setPathMode(pathMode) {
    const normalized = safeString(pathMode)
    if (normalized) {
      baseDetails.pathMode = normalized
    }
  }

  return {
    runId,
    mode,
    startedAt,
    emit,
    elapsedMs,
    setPathMode,
    baseDetails,
  }
}

export function buildRunFinishedDetails(result = {}, logger, status = 'completed') {
  const usage = result?.usage || {}
  const routeDecision = result?.routeDecision || {}
  const toolEvents = Array.isArray(result?.toolEvents) ? result.toolEvents : []
  return {
    status,
    terminationReason:
      result?.terminationReason ||
      routeDecision?.stopReason ||
      result?.completionState ||
      status,
    agentMode: result?.agentMode,
    completionState: result?.completionState,
    recovered: result?.recovered === true || result?.retryInfo?.recovered === true,
    totalPasses: safeNumber(result?.totalPasses),
    toolCount: toolEvents.length,
    inputTokens: safeNumber(usage?.inputTokens),
    outputTokens: safeNumber(usage?.outputTokens),
    durationMs: logger?.elapsedMs?.(),
  }
}

export function buildErrorDetails(error = {}) {
  const errorInfo = error?.errorInfo || {}
  return {
    source: error?.source || errorInfo?.source,
    category: errorInfo?.category,
    code: error?.code || errorInfo?.code,
    retryable: errorInfo?.retryable,
    suggestedAction: errorInfo?.suggestedAction,
    message: compactString(error?.message || errorInfo?.summary, 800),
  }
}

export function wrapAgentRuntimeHooks(hooks = {}, logger) {
  if (!logger) {
    return hooks
  }

  return {
    ...hooks,
    onRuntimeLog(event) {
      hooks?.onRuntimeLog?.(event)
    },
    onRouteDecision(routeDecision) {
      logger.emit('agent.route.decision', {
        capabilityTier: routeDecision?.capabilityTier,
        answerMode: routeDecision?.answerMode,
        availableEscalations: compactArray(routeDecision?.availableEscalations),
        mountedTools: compactArray(routeDecision?.mountedCapabilities?.tools),
        budgets: routeDecision?.budgets,
        stopReason: routeDecision?.stopReason,
        escalationCount: routeDecision?.escalationCount,
      })
      hooks?.onRouteDecision?.(routeDecision)
    },
    onToolEvent(event) {
      logger.emit(
        'agent.tool.event',
        {
          toolEventId: event?.id,
          toolName: event?.name,
          source: event?.source,
          status: event?.status,
          summary: compactString(event?.summary || event?.error, 500),
          errorCode: event?.errorInfo?.code,
          errorCategory: event?.errorInfo?.category,
          order: safeNumber(event?.order),
        },
        { level: event?.status === 'error' ? 'error' : 'info' },
      )
      hooks?.onToolEvent?.(event)
    },
    onContextCompression(contextCompression) {
      logger.emit('agent.context.compression', {
        compressionId: contextCompression?.id,
        trigger: contextCompression?.trigger,
        originalTokenEstimate: safeNumber(contextCompression?.originalTokenEstimate),
        compressedTokenEstimate: safeNumber(contextCompression?.compressedTokenEstimate),
        compressedThroughMessageId: contextCompression?.compressedThroughMessageId,
      })
      hooks?.onContextCompression?.(contextCompression)
    },
    onRetryProgress(retryInfo) {
      logger.emit(
        'agent.retry.progress',
        {
          attemptedRetries: safeNumber(retryInfo?.attemptedRetries),
          configuredMaxAttempts: safeNumber(retryInfo?.configuredMaxAttempts),
          stage: retryInfo?.stage,
          nextRetryDelayMs: safeNumber(retryInfo?.nextRetryDelayMs),
          lastErrorSummary: compactString(retryInfo?.lastErrorSummary, 500),
        },
        { level: 'warn' },
      )
      hooks?.onRetryProgress?.(retryInfo)
    },
    onWorkMemory(memory) {
      logger.emit('agent.memory.updated', {
        memoryId: memory?.id,
        kind: memory?.kind,
        title: compactString(memory?.title, 240),
        status: memory?.status,
      })
      hooks?.onWorkMemory?.(memory)
    },
    onPhaseChange(phase, meta = {}) {
      if (phase === 'recovering') {
        logger.emit(
          'agent.recovery.event',
          {
            stage: 'recovering',
            recovered: false,
            fallbackUsed: false,
          },
          { level: 'warn' },
        )
      }
      hooks?.onPhaseChange?.(phase, meta)
    },
  }
}
