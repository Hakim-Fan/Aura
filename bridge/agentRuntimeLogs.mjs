const DEFAULT_EVENT_VERSION = 1

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
  safeString(value)
  return 'default-agent'
}

export function resolveAgentExecutionMode(settings = {}) {
  const requestedArchitectureMode = safeString(settings?.agentArchitectureMode) || 'default-agent'
  const architectureMode = 'default-agent'
  const effectiveAgentMode = 'default-agent'
  const pathMode = 'default'
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

export function buildMetricsSummaryDetails(result = {}, logger, status = 'completed') {
  const finished = buildRunFinishedDetails(result, logger, status)
  const graphExecutions = Array.isArray(result?.graphExecutions) ? result.graphExecutions : []
  const graphCheckpoints = Array.isArray(result?.graphCheckpoints) ? result.graphCheckpoints : []
  const resultCheckpointCount = safeNumber(result?.checkpointCount)
  const resultRecoveryCount = safeNumber(result?.recoveryCount)
  const recovered =
    finished.recovered ||
    graphExecutions.some(execution =>
      execution?.status === 'recovered' ||
      String(execution?.nextRecommendation || '').toLowerCase().includes('recover'),
    )
  const recoveryCount =
    (finished.recovered ? 1 : 0) +
    graphExecutions.filter(execution =>
      execution?.status === 'recovered' ||
      String(execution?.nextRecommendation || '').toLowerCase().includes('recover'),
    ).length

  return {
    ...finished,
    architectureMode: logger?.baseDetails?.architectureMode,
    requestedArchitectureMode: logger?.baseDetails?.requestedArchitectureMode,
    pathMode: result?.pathMode || logger?.baseDetails?.pathMode,
    checkpointCount: resultCheckpointCount ?? graphCheckpoints.length,
    recoveryCount: resultRecoveryCount ?? recoveryCount,
    recovered,
    graphState: result?.graphState,
    graphExecutionCount: graphExecutions.length,
    graphCompletionReason: result?.graphCompletion?.reason,
    graphNextAction: result?.graphCompletion?.nextAction,
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
  let lastRouteTier = null
  let lastEscalationCount = 0

  return {
    ...hooks,
    onRuntimeLog(event) {
      hooks?.onRuntimeLog?.(event)
    },
    onRouteDecision(routeDecision) {
      const escalationCount = safeNumber(routeDecision?.escalationCount) || 0
      logger.emit('agent.route.decision', {
        capabilityTier: routeDecision?.capabilityTier,
        answerMode: routeDecision?.answerMode,
        availableEscalations: compactArray(routeDecision?.availableEscalations),
        mountedTools: compactArray(routeDecision?.mountedCapabilities?.tools),
        budgets: routeDecision?.budgets,
        stopReason: routeDecision?.stopReason,
        escalationCount,
      })
      if (escalationCount > lastEscalationCount) {
        const tierHistory = compactArray(routeDecision?.tierHistory)
        const fromTier =
          tierHistory.length > 1 ? tierHistory[tierHistory.length - 2] : lastRouteTier
        logger.emit('agent.escalation.event', {
          fromTier,
          toTier: routeDecision?.capabilityTier,
          reason: routeDecision?.stopReason || 'route capability escalation',
          budgetAfter: routeDecision?.budgets,
          escalationCount,
        })
      }
      lastRouteTier = routeDecision?.capabilityTier || lastRouteTier
      lastEscalationCount = escalationCount
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
          riskLevel: event?.riskLevel,
          permissionScope: event?.permissionScope,
          approvalCategory: event?.approvalCategory,
          summary: compactString(event?.summary || event?.error, 500),
          errorCode: event?.errorInfo?.code,
          errorCategory: event?.errorInfo?.category,
          order: safeNumber(event?.order),
        },
        { level: event?.status === 'error' ? 'error' : 'info' },
      )
      hooks?.onToolEvent?.(event)
    },
    onAgentHookEvent(event) {
      const blocked = event?.status === 'blocked'
      logger.emit(
        blocked ? 'agent.hook.blocked' : 'agent.hook.invoked',
        {
          hookName: event?.eventName,
          status: event?.status,
          toolName: event?.toolName,
          toolEventId: event?.toolEventId,
          durationMs: safeNumber(event?.durationMs),
          reason: compactString(event?.reason, 500),
          code: event?.code,
        },
        { level: blocked || event?.status === 'error' ? 'warn' : 'info' },
      )
      hooks?.onAgentHookEvent?.(event)
    },
    onToolPermissionEvent(event) {
      const runtimeEvent =
        event?.status === 'requested'
          ? 'agent.tool.permission.requested'
          : 'agent.tool.permission.resolved'
      logger.emit(
        runtimeEvent,
        {
          toolEventId: event?.toolEventId,
          toolName: event?.toolName,
          source: event?.source,
          approvalCategory: event?.approvalCategory,
          permissionScope: event?.permissionScope,
          riskLevel: event?.riskLevel,
          decision: event?.decision,
          reason: compactString(event?.reason, 500),
          code: event?.code,
        },
        {
          level:
            event?.decision === 'denied' || event?.status === 'denied'
              ? 'warn'
              : 'info',
        },
      )
      hooks?.onToolPermissionEvent?.(event)
    },
    onToolAuditEvent(event) {
      logger.emit(
        'agent.tool.audit',
        {
          toolEventId: event?.toolEventId,
          toolName: event?.toolName,
          source: event?.source,
          status: event?.status,
          approvalCategory: event?.approvalCategory,
          permissionScope: event?.permissionScope,
          riskLevel: event?.riskLevel,
          errorCode: event?.errorCode,
          errorCategory: event?.errorCategory,
        },
        { level: event?.status === 'success' ? 'info' : 'warn' },
      )
      hooks?.onToolAuditEvent?.(event)
    },
    onToolCatalogEvent(event) {
      logger.emit('agent.tool.catalog.loaded', {
        totalToolCount: safeNumber(event?.totalToolCount),
        directToolCount: safeNumber(event?.directToolCount),
        deferredToolCount: safeNumber(event?.deferredToolCount),
        discoverableToolCount: safeNumber(event?.discoverableToolCount),
        highRiskToolCount: safeNumber(event?.highRiskToolCount),
      })
      hooks?.onToolCatalogEvent?.(event)
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
    onReasoningDiscard(event = {}) {
      logger.emit(
        'agent.reasoning.discarded',
        {
          blockId: event?.blockId,
          reason: compactString(event?.reason, 500),
          attemptNumber: safeNumber(event?.attemptNumber),
          nextAttemptNumber: safeNumber(event?.nextAttemptNumber),
        },
        { level: 'warn' },
      )
      hooks?.onReasoningDiscard?.(event)
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
    onProgress(event = {}) {
      if (event?.type === 'checkpoint_created') {
        logger.emit('agent.checkpoint.created', {
          checkpointId: event?.checkpointId,
          checkpointCount: safeNumber(event?.checkpointCount),
          reason: compactString(event?.reason, 240),
          state: compactString(event?.state || event?.graphState, 120),
          planId: compactString(event?.planId, 240),
          subtaskId: compactString(event?.subtaskId || event?.stepId, 240),
          checkpointKind: compactString(event?.checkpointKind, 160),
          triggerCount: safeNumber(event?.triggerCount),
          phaseHandoffId: compactString(event?.phaseHandoffId, 240),
        })
      } else if (event?.type === 'checkpoint_restored') {
        logger.emit('agent.checkpoint.restored', {
          checkpointId: event?.checkpointId,
          reason: compactString(event?.reason, 240),
          state: compactString(event?.state || event?.graphState, 120),
          planId: compactString(event?.planId, 240),
          subtaskId: compactString(event?.subtaskId || event?.stepId, 240),
        })
      }
      hooks?.onProgress?.(event)
    },
    onPhaseChange(phase, meta = {}) {
      if (phase === 'recovering') {
        logger.emit(
          'agent.recovery.event',
          {
            stage: 'recovering',
            recovered: false,
            fallbackUsed: false,
            reason: compactString(meta?.reason, 500),
            code: compactString(meta?.code, 120),
            originalStage: compactString(meta?.stage, 120),
            lastErrorSummary: compactString(meta?.lastErrorSummary, 500),
            providerStatus: safeNumber(meta?.providerStatus),
            providerErrorDetail: compactString(meta?.providerErrorDetail, 1_200),
            providerRawError: compactString(meta?.providerRawError, 4_000),
          },
          { level: 'warn' },
        )
      }
      hooks?.onPhaseChange?.(phase, meta)
    },
  }
}
