function compactString(value, maxLength = 500) {
  const normalized = String(value || '').replace(/\s+/g, ' ').trim()
  if (!normalized) return ''
  return normalized.length > maxLength
    ? `${normalized.slice(0, maxLength)}...`
    : normalized
}

function safeToolEvents(result = {}) {
  return Array.isArray(result?.toolEvents) ? result.toolEvents : []
}

function collectArtifacts(result = {}) {
  const paths = Array.isArray(result?.evidenceSummary?.artifactPaths)
    ? result.evidenceSummary.artifactPaths
    : []
  return Array.from(new Set(paths.filter(Boolean))).map(path => ({ path }))
}

function collectEvidenceRefs(toolEvents = [], result = {}) {
  const refs = []
  for (const event of toolEvents) {
    if (event?.id) {
      refs.push(`tool:${event.id}`)
    } else if (event?.name) {
      refs.push(`tool:${event.name}`)
    }
  }
  for (const artifact of collectArtifacts(result)) {
    refs.push(`file:${artifact.path}`)
  }
  return Array.from(new Set(refs))
}

function collectErrors(toolEvents = [], result = {}) {
  const errors = toolEvents
    .filter(event => event?.status === 'error')
    .map(event => ({
      toolEventId: event?.id,
      toolName: event?.name,
      code: event?.errorInfo?.code,
      category: event?.errorInfo?.category,
      message: compactString(event?.error || event?.summary, 300),
    }))

  if (result?.completionState === 'failed_after_execution') {
    errors.push({
      code: 'FAILED_AFTER_EXECUTION',
      category: 'completion',
      message: compactString(result?.message, 300),
    })
  }

  return errors
}

function deriveStepStatus(result = {}, errors = []) {
  if (
    result?.completionState === 'blocked_by_approval' ||
    result?.completionState === 'blocked_by_capability' ||
    result?.status === 'blocked'
  ) {
    return 'blocked'
  }
  if (result?.completionState === 'failed_after_execution') {
    return 'failed'
  }
  if (errors.length > 0 && result?.status === 'failed') {
    return 'failed'
  }
  return 'completed'
}

function isolateGraphStepTaskTree(request = {}) {
  if (typeof request?.hooks?.onTaskTree !== 'function') {
    return request
  }

  return {
    ...request,
    hooks: {
      ...request.hooks,
      onTaskTree() {
        // The graph plan owns the user-visible task tree. Nested route-first
        // task trackers still run, but must not replace the active plan steps.
      },
    },
  }
}

export async function executeGraphStep({
  request,
  plan,
  subtask,
  executeRouteFirst,
  logger,
  now = Date.now,
} = {}) {
  if (typeof executeRouteFirst !== 'function') {
    throw new Error('executeGraphStep requires executeRouteFirst')
  }
  if (!subtask?.id) {
    throw new Error('executeGraphStep requires a plan subtask')
  }

  const startedAt = now()
  logger?.emit?.('agent.step.started', {
    stepId: subtask.id,
    subtaskId: subtask.id,
    planId: plan?.id,
    capabilityTier: subtask.requiredCapability || 'auto',
    toolsAvailable: 'route-first-runtime',
  })

  try {
    const routeResult = await executeRouteFirst(isolateGraphStepTaskTree(request))
    const toolEvents = safeToolEvents(routeResult)
    const evidence = collectEvidenceRefs(toolEvents, routeResult)
    const artifacts = collectArtifacts(routeResult)
    const errors = collectErrors(toolEvents, routeResult)
    const status = deriveStepStatus(routeResult, errors)
    const durationMs = Math.max(0, now() - startedAt)

    logger?.emit?.(
      'agent.step.finished',
      {
        stepId: subtask.id,
        subtaskId: subtask.id,
        planId: plan?.id,
        status,
        durationMs,
        toolCount: toolEvents.length,
        evidenceCount: evidence.length,
        errorCount: errors.length,
      },
      { level: status === 'failed' ? 'error' : 'info' },
    )

    return {
      subtaskId: subtask.id,
      status,
      evidence,
      artifacts,
      errors,
      durationMs,
      toolEvents,
      routeResult,
      nextRecommendation: status === 'completed'
        ? 'verify_completion'
        : 'review_blocker_or_recover',
    }
  } catch (error) {
    const durationMs = Math.max(0, now() - startedAt)
    logger?.emit?.(
      'agent.step.finished',
      {
        stepId: subtask.id,
        subtaskId: subtask.id,
        planId: plan?.id,
        status: 'failed',
        durationMs,
        errorCode: error?.code,
      },
      { level: 'error' },
    )
    throw error
  }
}
