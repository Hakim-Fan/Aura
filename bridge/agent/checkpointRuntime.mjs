import {
  buildCheckpointContext,
  createCheckpointManager,
  ExecutionCheckpoint,
  restoreFromCheckpoint,
} from '../checkpoint.mjs'

function safeArray(value) {
  return Array.isArray(value) ? value : []
}

function sanitizeSettings(settings = {}) {
  return {
    provider: settings?.provider,
    model: settings?.model,
    cwd: settings?.cwd,
    agentArchitectureMode: settings?.agentArchitectureMode,
    executionMode: settings?.executionMode,
  }
}

function compactString(value, maxLength = 500) {
  const normalized = String(value || '').replace(/\s+/g, ' ').trim()
  if (!normalized) return ''
  return normalized.length > maxLength
    ? `${normalized.slice(0, maxLength)}...`
    : normalized
}

function summarizeToolEvent(event = {}) {
  return {
    id: event?.id,
    name: event?.name,
    source: event?.source,
    status: event?.status,
    summary: compactString(event?.summary || event?.error, 500),
    errorInfo: event?.errorInfo
      ? {
          code: event.errorInfo.code,
          category: event.errorInfo.category,
        }
      : undefined,
  }
}

function summarizeExecutionResult(executionResult = {}) {
  const routeResult = executionResult?.routeResult || executionResult
  return {
    status: executionResult?.status || routeResult?.status,
    completionState: routeResult?.completionState,
    toolEventCount: safeArray(routeResult?.toolEvents || executionResult?.toolEvents).length,
    evidenceCount: safeArray(executionResult?.evidence).length,
    errorCount: safeArray(executionResult?.errors).length,
  }
}

function buildGraphSnapshot({
  state,
  plan,
  request,
  classification,
  executionResult,
  toolEvents = [],
  memoryEntries = [],
} = {}) {
  return {
    graphState: state,
    plan,
    classification,
    request: {
      messages: safeArray(request?.messages),
      settings: sanitizeSettings(request?.settings),
      logContext: request?.logContext || {},
    },
    executionResult: executionResult
      ? summarizeExecutionResult(executionResult)
      : null,
    toolEvents: safeArray(toolEvents).map(summarizeToolEvent),
    memoryEntries: safeArray(memoryEntries),
  }
}

export function createGraphCheckpointRuntime({
  logger,
  taskId,
  maxCheckpoints = 20,
} = {}) {
  const manager = createCheckpointManager({ maxCheckpoints })
  const records = []

  function createCheckpoint({
    state,
    plan,
    subtask,
    request,
    classification,
    executionResult,
    toolEvents = [],
    memoryEntries = [],
    reason = 'graph_state_checkpoint',
  } = {}) {
    const checkpoint = manager.createCheckpoint(
      taskId || request?.logContext?.taskId || plan?.id || 'graph-task',
      subtask?.id || state || 'graph',
      buildGraphSnapshot({
        state,
        plan,
        request,
        classification,
        executionResult,
        toolEvents,
        memoryEntries,
      }),
      {
        graphState: state,
        planId: plan?.id,
        subtaskId: subtask?.id,
        reason,
      },
    )
    const record = {
      checkpointId: checkpoint.id,
      state,
      planId: plan?.id,
      subtaskId: subtask?.id,
      toolEventCount: safeArray(toolEvents).length,
      memoryEntryCount: safeArray(memoryEntries).length,
      reason,
    }
    records.push(record)
    logger?.emit?.('agent.checkpoint.created', record)
    return checkpoint
  }

  async function restoreCheckpoint(checkpoint, {
    executorContext,
    reason = 'manual_restore',
  } = {}) {
    const restored = await restoreGraphCheckpoint(checkpoint, {
      logger,
      executorContext,
      reason,
    })
    return restored
  }

  return {
    manager,
    records,
    createCheckpoint,
    restoreCheckpoint,
    getCheckpoint: checkpointId => manager.getCheckpoint(checkpointId),
    getLatestCheckpointForTask: id => manager.getLatestCheckpointForTask(id),
  }
}

export async function restoreGraphCheckpoint(checkpoint, {
  logger,
  executorContext,
  reason = 'manual_restore',
} = {}) {
  const normalizedCheckpoint =
    checkpoint && typeof checkpoint.isActive === 'function'
      ? checkpoint
      : checkpoint && typeof checkpoint === 'object'
        ? ExecutionCheckpoint.fromJSON(checkpoint)
        : checkpoint
  const restored = await restoreFromCheckpoint(normalizedCheckpoint, executorContext)
  if (!restored?.success) {
    return restored
  }
  const context = buildCheckpointContext(normalizedCheckpoint)
  const graphState =
    context?.context?.graphState ||
    context?.metadata?.graphState ||
    normalizedCheckpoint?.metadata?.graphState

  logger?.emit?.('agent.checkpoint.restored', {
    checkpointId: normalizedCheckpoint.id,
    restoredState: graphState,
    reason,
  })

  return {
    ...restored,
    graphState,
    graphContext: context?.context,
  }
}
