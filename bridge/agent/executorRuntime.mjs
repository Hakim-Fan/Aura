import { collectEvidenceFromToolEvents } from '../agentEvidence.mjs'

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

function collectActualEvidence(toolEvents = [], result = {}) {
  const summary = collectEvidenceFromToolEvents(toolEvents)
  const evidence = new Set()

  if (summary.hasContextEvidence) evidence.add('context_collected')
  if (summary.hasAnyExecution) evidence.add('execution_performed')
  if (summary.hasSuccessfulCommand) evidence.add('command_output')
  if (summary.hasWriteEffect) evidence.add('file_mutation')
  if (summary.hasFileVerification) evidence.add('file_verified')
  if (summary.hasArtifactEvidence) evidence.add('artifact_present')
  if (summary.hasVerifiedEvidence) evidence.add('verification_passed')

  for (const record of summary.records || []) {
    for (const item of record.producedEvidence || []) {
      evidence.add(item)
    }
  }

  if (result?.completionState === 'executed_verified') {
    evidence.add('verification_passed')
  }
  if (typeof result?.message === 'string' && result.message.trim()) {
    evidence.add('final_answer')
  }

  return Array.from(evidence)
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
        // The graph plan owns the user-visible task tree. Nested default-agent
        // task trackers still run, but must not replace the active plan steps.
      },
    },
  }
}

function withGraphStepRuntime(request = {}, plan = {}, subtask = {}, logger) {
  const activePlanStep = {
    planId: typeof plan?.id === 'string' ? plan.id : undefined,
    subtaskId: typeof subtask?.id === 'string' ? subtask.id : undefined,
    subtaskTitle: typeof subtask?.title === 'string' ? subtask.title : undefined,
  }

  const hooks = request?.hooks || {}
  return {
    ...request,
    hooks: {
      ...hooks,
      activePlanStep,
      graphStep: activePlanStep,
      onToolEvent(event) {
        hooks.onToolEvent?.(event)
        logger?.emit?.('agent.step.tool_event', {
          planId: activePlanStep.planId,
          subtaskId: activePlanStep.subtaskId,
          subtaskTitle: activePlanStep.subtaskTitle,
          toolEventId: event?.id,
          toolName: event?.name,
          status: event?.status,
        })
      },
    },
  }
}

export async function executeGraphStep({
  request,
  plan,
  subtask,
  executeDefaultAgent,
  logger,
  now = Date.now,
} = {}) {
  if (typeof executeDefaultAgent !== 'function') {
    throw new Error('executeGraphStep requires executeDefaultAgent')
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
    toolsAvailable: 'default-agent-runtime',
  })

  try {
    const routeResult = await executeDefaultAgent(
      isolateGraphStepTaskTree(withGraphStepRuntime(request, plan, subtask, logger)),
    )
    const toolEvents = safeToolEvents(routeResult)
    const evidence = collectEvidenceRefs(toolEvents, routeResult)
    const actualEvidence = collectActualEvidence(toolEvents, routeResult)
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
        actualEvidence,
        errorCount: errors.length,
      },
      { level: status === 'failed' ? 'error' : 'info' },
    )

    return {
      subtaskId: subtask.id,
      status,
      evidence,
      actualEvidence,
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
