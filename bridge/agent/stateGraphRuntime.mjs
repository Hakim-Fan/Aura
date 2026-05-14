export const AgentGraphState = {
  INIT: 'INIT',
  CLASSIFY: 'CLASSIFY',
  PLAN: 'PLAN',
  SELECT_CAPABILITY: 'SELECT_CAPABILITY',
  EXECUTE_STEP: 'EXECUTE_STEP',
  OBSERVE: 'OBSERVE',
  VERIFY: 'VERIFY',
  DECIDE_NEXT: 'DECIDE_NEXT',
  FINALIZE: 'FINALIZE',
  RECOVER: 'RECOVER',
  BLOCKED: 'BLOCKED',
}

function createId(prefix, now = Date.now, random = Math.random) {
  return `${prefix}-${now().toString(36)}-${random().toString(36).slice(2, 8)}`
}

function latestUserText(messages = []) {
  const latest = [...(Array.isArray(messages) ? messages : [])]
    .reverse()
    .find(message => message?.role === 'user')
  return String(latest?.content || '').trim()
}

function truncateText(value, maxLength = 180) {
  const normalized = String(value || '').replace(/\s+/g, ' ').trim()
  if (!normalized) return ''
  return normalized.length > maxLength
    ? `${normalized.slice(0, maxLength)}...`
    : normalized
}

function deriveGoal(messages = []) {
  const text = latestUserText(messages)
  if (!text) return 'Complete the user request'
  return truncateText(text.split('\n').find(Boolean) || text, 180)
}

export function createHybridPlan({ request = {}, classification = {}, now = Date.now, random = Math.random } = {}) {
  const planId = createId('plan', now, random)
  const goal = deriveGoal(request.messages)
  const subtasks = [
    {
      id: `${planId}-subtask-1`,
      title: 'Understand goal and execution constraints',
      requiredCapability: 'read-only',
      successCriteria: [
        'Goal is available to the runtime',
        'Risk and path classification are recorded',
      ],
      dependencies: [],
      status: 'completed',
    },
    {
      id: `${planId}-subtask-2`,
      title: 'Execute through route-first runtime',
      requiredCapability: classification?.requiresWrite ? 'local-write' : 'auto',
      successCriteria: [
        'Existing route-first capability selection is preserved',
        'Tool routing, provider recovery, and evidence policy remain active',
      ],
      dependencies: [`${planId}-subtask-1`],
      status: 'pending',
    },
    {
      id: `${planId}-subtask-3`,
      title: 'Verify and merge final result',
      requiredCapability: 'auto',
      successCriteria: [
        'Completion state and route decision are captured',
        'Final answer is returned with graph metadata',
      ],
      dependencies: [`${planId}-subtask-2`],
      status: 'pending',
    },
  ]

  return {
    id: planId,
    goal,
    pathMode: 'long',
    risk: classification?.risk || 'medium',
    complexity: classification?.complexity || 'complex',
    estimatedSteps: subtasks.length,
    subtasks,
  }
}

export async function runHybridStateGraph({
  request,
  classification,
  logger,
  executeRouteFirst,
  now = Date.now,
  random = Math.random,
} = {}) {
  if (typeof executeRouteFirst !== 'function') {
    throw new Error('runHybridStateGraph requires executeRouteFirst')
  }

  let currentState = AgentGraphState.INIT
  let passIndex = 0
  const plan = createHybridPlan({ request, classification, now, random })

  function emitTransition(to, reason, extra = {}) {
    const from = currentState
    currentState = to
    logger?.emit?.('agent.graph.transition', {
      from,
      to,
      reason,
      passIndex,
      planId: plan.id,
      ...extra,
    })
  }

  function updateSubtask(subtaskId, newStatus, evidenceCount = 0) {
    const subtask = plan.subtasks.find(entry => entry.id === subtaskId)
    if (!subtask) return
    const oldStatus = subtask.status
    subtask.status = newStatus
    logger?.emit?.('agent.plan.updated', {
      planId: plan.id,
      subtaskId,
      oldStatus,
      newStatus,
      evidenceCount,
    })
  }

  logger?.emit?.('agent.plan.created', {
    planId: plan.id,
    subtaskCount: plan.subtasks.length,
    risk: plan.risk,
    estimatedSteps: plan.estimatedSteps,
    goal: plan.goal,
  })

  emitTransition(AgentGraphState.CLASSIFY, 'task classification is available')
  emitTransition(AgentGraphState.PLAN, 'hybrid plan created')
  emitTransition(AgentGraphState.SELECT_CAPABILITY, 'delegate capability selection to route-first runtime')
  emitTransition(AgentGraphState.EXECUTE_STEP, 'execute the current plan through route-first runtime', {
    stepId: plan.subtasks[1].id,
  })

  logger?.emit?.('agent.step.started', {
    stepId: plan.subtasks[1].id,
    subtaskId: plan.subtasks[1].id,
    capabilityTier: plan.subtasks[1].requiredCapability,
    toolsAvailable: 'route-first-runtime',
  })
  logger?.emit?.('agent.checkpoint.created', {
    checkpointId: createId('graph-checkpoint', now, random),
    state: currentState,
    subtaskId: plan.subtasks[1].id,
    toolEventCount: 0,
    memoryEntryCount: 0,
  })

  try {
    const result = await executeRouteFirst(request)
    const evidenceCount = Array.isArray(result?.toolEvents) ? result.toolEvents.length : 0
    updateSubtask(plan.subtasks[1].id, 'completed', evidenceCount)
    logger?.emit?.('agent.step.finished', {
      stepId: plan.subtasks[1].id,
      subtaskId: plan.subtasks[1].id,
      status: 'completed',
      toolCount: evidenceCount,
      evidenceCount,
    })

    emitTransition(AgentGraphState.OBSERVE, 'route-first execution returned a result')
    emitTransition(AgentGraphState.VERIFY, 'capture completion state and evidence summary')
    updateSubtask(
      plan.subtasks[2].id,
      result?.completionState === 'failed_after_execution' ? 'failed' : 'completed',
      evidenceCount,
    )
    emitTransition(AgentGraphState.DECIDE_NEXT, 'single delegated route-first step completed')
    emitTransition(AgentGraphState.FINALIZE, 'return merged result to caller')

    return {
      ...result,
      pathMode: 'long',
      graphPlan: plan,
      graphState: AgentGraphState.FINALIZE,
    }
  } catch (error) {
    updateSubtask(plan.subtasks[1].id, 'failed', 0)
    emitTransition(AgentGraphState.RECOVER, 'route-first execution raised an error', {
      stepId: plan.subtasks[1].id,
      errorCode: error?.code,
    })
    logger?.emit?.('agent.step.finished', {
      stepId: plan.subtasks[1].id,
      subtaskId: plan.subtasks[1].id,
      status: 'failed',
      errorCode: error?.code,
    }, { level: 'error' })
    error.graphPlan = plan
    error.graphState = AgentGraphState.RECOVER
    throw error
  } finally {
    passIndex += 1
  }
}

