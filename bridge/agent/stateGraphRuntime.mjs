import {
  appendPlanSubtask,
  createHybridPlan as createPlannerHybridPlan,
  findPlanSubtask,
  planToTaskTree,
  updatePlanSubtask,
} from './plannerRuntime.mjs'
import { buildLanguagePolicyInstruction, getRuntimeTaskLabels } from '../runtimeLanguage.mjs'
import { executeGraphStep } from './executorRuntime.mjs'
import {
  createGraphCheckpointRuntime,
  restoreGraphCheckpoint,
} from './checkpointRuntime.mjs'
import {
  decideGraphCompletion,
  mergeGraphResult,
} from './resultMerger.mjs'
import { createExecutionStepIdFactory } from '../executionIds.mjs'

export const AgentGraphState = {
  INIT: 'INIT',
  CLASSIFY: 'CLASSIFY',
  PLAN: 'PLAN',
  SELECT_CAPABILITY: 'SELECT_CAPABILITY',
  CHECKPOINT: 'CHECKPOINT',
  EXECUTE_STEP: 'EXECUTE_STEP',
  OBSERVE: 'OBSERVE',
  VERIFY: 'VERIFY',
  DECIDE_NEXT: 'DECIDE_NEXT',
  ESCALATE: 'ESCALATE',
  FINALIZE: 'FINALIZE',
  RECOVER: 'RECOVER',
  BLOCKED: 'BLOCKED',
  COMPLETED: 'COMPLETED',
}

export function createHybridPlan({ request = {}, classification = {}, now = Date.now, random = Math.random } = {}) {
  return createPlannerHybridPlan({ request, classification, now, random })
}

function safeArray(value) {
  return Array.isArray(value) ? value : []
}

function compactString(value, maxLength = 900) {
  const normalized = String(value || '').replace(/\s+/g, ' ').trim()
  if (!normalized) return ''
  return normalized.length > maxLength
    ? `${normalized.slice(0, maxLength)}...`
    : normalized
}

function buildContinuationPrompt({
  plan,
  decision,
  executionResult,
  result,
  subtask,
  locale = 'zh-CN',
} = {}) {
  const labels = getRuntimeTaskLabels(locale)
  const evidence = safeArray(executionResult?.evidence).slice(-8)
  const errors = safeArray(executionResult?.errors)
    .slice(-4)
    .map(error => [error?.toolName, error?.code, error?.message].filter(Boolean).join(': '))
    .filter(Boolean)
  const lines = [
    `${labels.continueExecution}。`,
    `原始目标：${plan?.goal || labels.planTitle}`,
    `当前子任务：${subtask?.title || labels.continueExecution}`,
    `上一次完成态：${result?.completionState || 'unknown'}`,
    `图决策：${decision?.reason || 'continue'} / ${decision?.nextAction || 'continue'}`,
  ]

  if (evidence.length > 0) {
    lines.push(`最近证据：${evidence.join(', ')}`)
  }
  if (errors.length > 0) {
    lines.push(`最近错误：${errors.join(' | ')}`)
  }

  if (decision?.nextAction === 'run_verification') {
    lines.push(
      '请使用当前最安全的读取、测试或构建检查来验证上一步工作。',
      '除非验证明确暴露问题，否则不要重复应用同一批修改。',
      '只有在拿到验证证据后才返回最终答案，否则要明确说明具体阻塞点。',
    )
  } else if (decision?.nextAction === 'attempt_recovery') {
    lines.push(
      '请根据前一步的失败证据进行恢复。',
      '优先采用定点修复或窄范围验证命令，不要重启无关工作。',
      '如果无法恢复，请带着失败证据直接报告阻塞原因。',
    )
  } else {
    lines.push('只有当前一步确实有必要继续满足原始目标时，才继续推进。')
  }

  const previousMessage = compactString(result?.message, 700)
  if (previousMessage) {
    lines.push(`上一次助手摘要：${previousMessage}`)
  }

  lines.push(buildLanguagePolicyInstruction({ locale }))

  return lines.join('\n')
}

function buildContinuationRequest(request, context = {}) {
  const prompt = buildContinuationPrompt({
    ...context,
    locale: request?.settings?.locale,
  })
  const carryover = [
    'Hybrid graph continuation context:',
    `Plan: ${context.plan?.id}`,
    `Decision: ${context.decision?.reason}`,
    `Next action: ${context.decision?.nextAction}`,
    `Evidence count: ${safeArray(context.executionResult?.evidence).length}`,
  ].join('\n')

  return {
    ...request,
    messages: [
      ...safeArray(request?.messages),
      {
        role: 'user',
        content: prompt,
      },
    ],
    carryoverContext: [request?.carryoverContext, carryover]
      .map(value => String(value || '').trim())
      .filter(Boolean)
      .join('\n\n'),
  }
}

function createContinuationSubtask(plan, decision, previousSubtask) {
  const labels = getRuntimeTaskLabels(plan?.locale || 'zh-CN')
  if (decision?.nextAction === 'run_verification') {
    return appendPlanSubtask(plan, {
      title: labels.verifyPrevious,
      kind: 'verification_step',
      requiredCapability: 'auto',
      afterSubtaskId: previousSubtask?.id,
      dependencies: previousSubtask?.id ? [previousSubtask.id] : undefined,
      successCriteria: [
        'Run or inspect enough evidence to confirm the previous execution',
        'Do not repeat completed mutations without a concrete failed verification',
      ],
      metadata: {
        reason: decision.reason,
        nextAction: decision.nextAction,
        previousSubtaskId: previousSubtask?.id,
        hiddenFromTaskTree: true,
        internal: true,
      },
      locale: plan?.locale || 'zh-CN',
    })
  }

  if (decision?.nextAction === 'attempt_recovery') {
    return appendPlanSubtask(plan, {
      title: labels.recoverFailed,
      kind: 'recovery_step',
      requiredCapability: 'auto',
      afterSubtaskId: previousSubtask?.id,
      dependencies: previousSubtask?.id ? [previousSubtask.id] : undefined,
      successCriteria: [
        'Use the previous failure evidence to recover or identify a hard blocker',
        'Preserve successful evidence from earlier graph steps',
      ],
      metadata: {
        reason: decision.reason,
        nextAction: decision.nextAction,
        previousSubtaskId: previousSubtask?.id,
      },
      locale: plan?.locale || 'zh-CN',
    })
  }

  return null
}

const EXECUTABLE_SUBTASK_KINDS = new Set([
  'execute',
  'inspect_step',
  'research_step',
  'verification_step',
  'recovery_step',
])

function isSubtaskCompleted(plan, subtaskId) {
  const subtask = findPlanSubtask(plan, subtaskId)
  return subtask?.status === 'completed'
}

function isRunnableSubtask(plan, subtask) {
  if (!subtask || !EXECUTABLE_SUBTASK_KINDS.has(subtask.kind)) return false
  if (subtask.status === 'completed' || subtask.status === 'blocked' || subtask.status === 'failed') {
    return false
  }
  const dependencies = safeArray(subtask.dependencies)
  return dependencies.every(dependencyId => isSubtaskCompleted(plan, dependencyId))
}

function findNextExecutableSubtask(plan, previousSubtask = null) {
  if (!plan || !Array.isArray(plan.subtasks)) return null
  const startIndex = previousSubtask
    ? Math.max(0, plan.subtasks.findIndex(subtask => subtask.id === previousSubtask.id) + 1)
    : 0
  return plan.subtasks
    .slice(startIndex)
    .find(subtask => isRunnableSubtask(plan, subtask)) || null
}

function countExecutableSubtasks(plan) {
  return safeArray(plan?.subtasks)
    .filter(subtask => EXECUTABLE_SUBTASK_KINDS.has(subtask?.kind))
    .length
}

function findRestoredActiveSubtask(plan, restoredContext = {}) {
  const metadataSubtaskId =
    restoredContext?.metadata?.subtaskId ||
    restoredContext?.graphContext?.metadata?.subtaskId
  const restoredSubtask = metadataSubtaskId ? findPlanSubtask(plan, metadataSubtaskId) : null
  if (restoredSubtask && restoredSubtask.status !== 'completed') {
    return restoredSubtask
  }
  return findNextExecutableSubtask(plan, restoredSubtask)
    || findNextExecutableSubtask(plan)
}

function shouldFocusPlannedSubtask(subtask = {}) {
  return ['inspect_step', 'research_step'].includes(subtask.kind)
}

function isInternalVerificationSubtask(subtask = {}) {
  return subtask?.kind === 'verification_step' && subtask?.metadata?.internal === true
}

function shouldAcceptVerificationAttempt({ decision, subtask, executionResult } = {}) {
  return (
    decision?.nextAction === 'run_verification' &&
    isInternalVerificationSubtask(subtask) &&
    executionResult?.status === 'completed' &&
    safeArray(executionResult?.evidence).length > 0
  )
}

function markGraphResultVerified(result = {}, reason = 'verification_attempt_completed') {
  return {
    ...result,
    completionState: 'executed_verified',
    terminationReason: result?.terminationReason || reason,
  }
}

function buildPlannedSubtaskRequest(request, {
  plan,
  subtask,
  previousResult,
  previousExecutionResult,
} = {}) {
  const labels = getRuntimeTaskLabels(plan?.locale || request?.settings?.locale || 'zh-CN')
  if (!shouldFocusPlannedSubtask(subtask)) {
    return request
  }
  const lines = [
    `${labels.continueExecution}。`,
    `原始目标：${plan?.goal || labels.planTitle}`,
    `当前子任务：${subtask?.title || labels.continueExecution}`,
    '只聚焦当前子任务，并保留后续图步骤需要的证据。',
  ]
  if (subtask.kind === 'inspect_step') {
    lines.push('请检查相关文件与行为，但这一子任务不要修改文件。')
  }
  if (subtask.kind === 'research_step') {
    lines.push('请收集后续执行或最终回答所需的当前外部证据。')
  }
  const previousMessage = compactString(previousResult?.message, 500)
  if (previousMessage) {
    lines.push(`上一步图摘要：${previousMessage}`)
  }
  const evidence = safeArray(previousExecutionResult?.evidence).slice(-8)
  if (evidence.length > 0) {
    lines.push(`上一步证据：${evidence.join(', ')}`)
  }
  lines.push(buildLanguagePolicyInstruction({ locale: plan?.locale || request?.settings?.locale }))

  return {
    ...request,
    messages: [
      ...safeArray(request?.messages),
      {
        role: 'user',
        content: lines.join('\n'),
      },
    ],
    carryoverContext: [
      request?.carryoverContext,
      `Hybrid graph planned subtask: ${subtask?.id || ''} ${subtask?.title || ''}`.trim(),
    ]
      .map(value => String(value || '').trim())
      .filter(Boolean)
      .join('\n\n'),
  }
}

export async function runHybridStateGraph({
  request,
  classification,
  logger,
  executeRouteFirst,
  maxGraphPasses,
  restoreCheckpoint,
  initialPlan,
  now = Date.now,
  random = Math.random,
} = {}) {
  if (typeof executeRouteFirst !== 'function') {
    throw new Error('runHybridStateGraph requires executeRouteFirst')
  }

  let currentState = AgentGraphState.INIT
  let passIndex = 0
  let plan = initialPlan || createHybridPlan({ request, classification, now, random })
  const checkpointRuntime = createGraphCheckpointRuntime({
    logger,
    taskId: request?.logContext?.taskId || plan.id,
  })
  let restoredContext = null
  if (restoreCheckpoint) {
    restoredContext = await restoreGraphCheckpoint(restoreCheckpoint, {
      logger,
      reason: 'run_agent_resume',
    })
    if (restoredContext?.success && restoredContext?.graphContext?.plan) {
      plan = restoredContext.graphContext.plan
      currentState = restoredContext.graphState || AgentGraphState.INIT
    }
  }
  let effectiveMaxGraphPasses =
    typeof maxGraphPasses === 'number' && Number.isFinite(maxGraphPasses)
      ? Math.max(1, Math.round(maxGraphPasses))
      : Math.max(1, countExecutableSubtasks(plan) + 2)
  const verifySubtask = findPlanSubtask(plan, 'verify')
  const executionHistory = []
  const sharedExecutionStepIds =
    request?.runtime?.executionStepIds ||
    createExecutionStepIdFactory(request?.logContext || {})
  const withSharedRuntime = value => ({
    ...value,
    runtime: {
      ...(value?.runtime || {}),
      executionStepIds: sharedExecutionStepIds,
    },
  })
  let activeRequest =
    restoredContext?.success && restoredContext?.graphContext?.request
      ? withSharedRuntime({
          ...request,
          messages: safeArray(restoredContext.graphContext.request.messages).length > 0
            ? restoredContext.graphContext.request.messages
            : request?.messages,
          logContext: {
            ...(request?.logContext || {}),
            ...(restoredContext.graphContext.request.logContext || {}),
          },
        })
      : withSharedRuntime(request)
  let activeSubtask = restoredContext?.success
    ? findRestoredActiveSubtask(plan, restoredContext)
    : findNextExecutableSubtask(plan)

  function emitPlanTaskTree() {
    request?.hooks?.onTaskTree?.(planToTaskTree(plan))
  }

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
    const updated = updatePlanSubtask(plan, subtaskId, {
      status: newStatus,
      evidenceCount,
    })
    if (!updated) return
    logger?.emit?.('agent.plan.updated', {
      planId: plan.id,
      subtaskId,
      oldStatus: updated.oldStatus,
      newStatus: updated.newStatus,
      evidenceCount,
    })
    emitPlanTaskTree()
  }

  logger?.emit?.(restoredContext?.success ? 'agent.plan.restored' : 'agent.plan.created', {
    planId: plan.id,
    subtaskCount: plan.subtasks.length,
    risk: plan.risk,
    estimatedSteps: plan.estimatedSteps,
    goal: plan.goal,
    successCriteria: plan.successCriteria,
  })
  emitPlanTaskTree()

  if (!restoredContext?.success) {
    emitTransition(AgentGraphState.CLASSIFY, 'task classification is available')
    emitTransition(AgentGraphState.PLAN, 'hybrid plan created')
    emitTransition(AgentGraphState.SELECT_CAPABILITY, 'delegate capability selection to route-first runtime')
  } else {
    emitTransition(AgentGraphState.PLAN, 'hybrid plan restored from checkpoint', {
      checkpointId: restoredContext.checkpointId,
    })
    emitTransition(AgentGraphState.SELECT_CAPABILITY, 'resume through route-first runtime')
  }

  try {
    let latestResult = null
    let latestExecutionResult = null
    let latestDecision = null

    for (let pass = 0; pass < effectiveMaxGraphPasses; pass += 1) {
      passIndex = pass
      if (!activeSubtask) {
        updateSubtask(verifySubtask.id, 'blocked', 0)
        emitTransition(AgentGraphState.BLOCKED, 'no runnable graph subtask remains')
        return mergeGraphResult({
          result: latestResult || { message: 'No runnable graph subtask remains.' },
          plan,
          executionResult: latestExecutionResult,
          executionHistory,
          decision: {
            graphState: AgentGraphState.BLOCKED,
            status: 'blocked',
            isComplete: false,
            reason: 'no_runnable_subtask',
            nextAction: 'report_graph_blocker',
          },
          checkpoints: checkpointRuntime.records,
        })
      }
      updateSubtask(activeSubtask.id, 'running', 0)
      emitTransition(AgentGraphState.CHECKPOINT, 'create checkpoint before delegated execution', {
        stepId: activeSubtask?.id,
      })
      checkpointRuntime.createCheckpoint({
        state: currentState,
        plan,
        subtask: activeSubtask,
        request: activeRequest,
        classification,
        reason: 'before_execute_step',
      })

      emitTransition(AgentGraphState.EXECUTE_STEP, 'execute the current plan through route-first runtime', {
        stepId: activeSubtask?.id,
      })
      const stepRequest = buildPlannedSubtaskRequest(activeRequest, {
        plan,
        subtask: activeSubtask,
        previousResult: latestResult,
        previousExecutionResult: latestExecutionResult,
      })
      const executionResult = await executeGraphStep({
        request: stepRequest,
        plan,
        subtask: activeSubtask,
        executeRouteFirst,
        logger,
        now,
      })
      const result = executionResult.routeResult
      const evidenceCount = executionResult.evidence.length
      executionHistory.push(executionResult)
      latestResult = result
      latestExecutionResult = executionResult
      updateSubtask(activeSubtask.id, executionResult.status, evidenceCount)

      emitTransition(AgentGraphState.OBSERVE, 'route-first execution returned a result', {
        stepId: activeSubtask?.id,
        toolEventCount: executionResult.toolEvents.length,
        executionStatus: executionResult.status,
      })
      checkpointRuntime.createCheckpoint({
        state: currentState,
        plan,
        subtask: activeSubtask,
        request: stepRequest,
        classification,
        executionResult,
        toolEvents: executionResult.toolEvents,
        reason: 'after_observe_step',
      })

      emitTransition(AgentGraphState.VERIFY, 'capture completion state and evidence summary')
      const decision = decideGraphCompletion({
        result,
        executionResult,
        classification,
        plan,
        passIndex: pass,
        maxPasses: effectiveMaxGraphPasses,
      })
      latestDecision = decision
      emitTransition(AgentGraphState.DECIDE_NEXT, decision.reason, {
        completionState: result?.completionState,
        executionStatus: executionResult.status,
        isComplete: decision.isComplete,
        nextAction: decision.nextAction,
      })

      const acceptedVerificationAttempt = shouldAcceptVerificationAttempt({
        decision,
        subtask: activeSubtask,
        executionResult,
      })
      const effectiveDecision = acceptedVerificationAttempt
        ? {
            ...decision,
            isComplete: true,
            status: 'completed',
            reason: 'verification_attempt_completed',
            nextAction: 'finalize',
            graphState: AgentGraphState.COMPLETED,
          }
        : decision
      if (acceptedVerificationAttempt) {
        latestResult = markGraphResultVerified(result)
        latestDecision = effectiveDecision
        logger?.emit?.('agent.graph.verification.accepted', {
          planId: plan.id,
          subtaskId: activeSubtask?.id,
          evidenceCount,
          reason: effectiveDecision.reason,
        })
      }

      if (effectiveDecision.isComplete) {
        if (activeSubtask.kind === 'recovery_step' && activeSubtask.metadata?.previousSubtaskId) {
          updateSubtask(activeSubtask.metadata.previousSubtaskId, 'completed', evidenceCount)
        }
        const nextPlannedSubtask = findNextExecutableSubtask(plan, activeSubtask)
        if (nextPlannedSubtask) {
          activeRequest = buildContinuationRequest(stepRequest, {
            plan,
            decision: {
              ...effectiveDecision,
              reason: 'continue_planned_subtasks',
              nextAction: 'execute_next_planned_subtask',
            },
            executionResult,
            result: latestResult || result,
            subtask: nextPlannedSubtask,
          })
          activeSubtask = nextPlannedSubtask
          continue
        }
        updateSubtask(verifySubtask.id, 'completed', evidenceCount)
        emitTransition(AgentGraphState.FINALIZE, 'return merged result to caller')
        emitTransition(AgentGraphState.COMPLETED, 'structured completion gate accepted result')

        return mergeGraphResult({
          result: latestResult || result,
          plan,
          executionResult,
          executionHistory,
          decision: {
            ...effectiveDecision,
            graphState: AgentGraphState.COMPLETED,
          },
          checkpoints: checkpointRuntime.records,
        })
      }

      if (decision.nextAction === 'escalate_or_explain_limit') {
        emitTransition(AgentGraphState.ESCALATE, decision.reason, {
          completionState: result?.completionState,
          nextAction: decision.nextAction,
        })
      }

      if (!decision.canContinue) {
        updateSubtask(verifySubtask.id, 'blocked', evidenceCount)
        emitTransition(AgentGraphState.BLOCKED, decision.reason, {
          completionState: result?.completionState,
          nextAction: decision.nextAction,
        })
        return mergeGraphResult({
          result,
          plan,
          executionResult,
          executionHistory,
          decision: {
            ...decision,
            graphState: AgentGraphState.BLOCKED,
          },
          checkpoints: checkpointRuntime.records,
        })
      }

      const continuationSubtask = createContinuationSubtask(plan, decision, activeSubtask)
      if (!continuationSubtask) {
        updateSubtask(verifySubtask.id, 'blocked', evidenceCount)
        emitTransition(AgentGraphState.BLOCKED, decision.reason, {
          completionState: result?.completionState,
          nextAction: decision.nextAction,
        })
        return mergeGraphResult({
          result,
          plan,
          executionResult,
          executionHistory,
          decision: {
            ...decision,
            graphState: AgentGraphState.BLOCKED,
          },
          checkpoints: checkpointRuntime.records,
        })
      }
      logger?.emit?.('agent.plan.updated', {
        planId: plan.id,
        subtaskId: continuationSubtask.id,
        oldStatus: 'absent',
        newStatus: continuationSubtask.status,
        evidenceCount: 0,
      })
      if (!(typeof maxGraphPasses === 'number' && Number.isFinite(maxGraphPasses))) {
        effectiveMaxGraphPasses += 1
      }
      activeRequest = buildContinuationRequest(stepRequest, {
        plan,
        decision,
        executionResult,
        result,
        subtask: continuationSubtask,
      })
      activeSubtask = continuationSubtask
    }

    return mergeGraphResult({
      result: latestResult,
      plan,
      executionResult: latestExecutionResult,
      executionHistory,
      decision: {
        ...(latestDecision || {}),
        graphState: AgentGraphState.BLOCKED,
        status: 'blocked',
        isComplete: false,
        reason: latestDecision?.reason || 'graph_pass_limit',
        nextAction: latestDecision?.nextAction || 'report_graph_pass_limit',
      },
      checkpoints: checkpointRuntime.records,
    })
  } catch (error) {
    if (activeSubtask?.id) {
      updateSubtask(activeSubtask.id, 'failed', 0)
    }
    emitTransition(AgentGraphState.RECOVER, 'route-first execution raised an error', {
      stepId: activeSubtask?.id,
      errorCode: error?.code,
    })
    checkpointRuntime.createCheckpoint({
      state: currentState,
      plan,
      subtask: activeSubtask,
      request: activeRequest,
      classification,
      reason: 'recover_after_error',
    })
    error.graphPlan = plan
    error.graphState = AgentGraphState.RECOVER
    error.graphCheckpoints = checkpointRuntime.records
    throw error
  } finally {
    passIndex += 1
  }
}
