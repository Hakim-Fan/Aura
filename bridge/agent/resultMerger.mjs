import { shouldContinueAfterToolFailure } from './toolFailureContinuationGate.mjs'

const INCOMPLETE_COMPLETION_STATES = new Set([
  'executed_unverified',
  'failed_after_execution',
  'blocked_by_approval',
  'blocked_by_capability',
])

function normalizeStatus(value, fallback = 'completed') {
  const normalized = String(value || '').trim()
  return normalized || fallback
}

function normalizeCompletedResultStatus(value) {
  const normalized = normalizeStatus(value)
  if (normalized === 'failed' || normalized === 'cancelled') {
    return normalized
  }
  return 'completed'
}

export function decideGraphCompletion({
  result = {},
  executionResult = {},
  passIndex = 0,
  maxPasses = 1,
} = {}) {
  const completionState = result?.completionState
  const executionStatus = executionResult?.status
  const canContinue = passIndex + 1 < maxPasses

  if (completionState === 'blocked_by_approval') {
    return {
      isComplete: false,
      graphState: 'BLOCKED',
      status: 'blocked',
      reason: 'blocked_by_approval',
      nextAction: 'wait_for_approval',
    }
  }

  if (completionState === 'blocked_by_capability') {
    return {
      isComplete: false,
      graphState: 'ESCALATE',
      status: 'blocked',
      reason: 'blocked_by_capability',
      nextAction: 'escalate_or_explain_limit',
      canContinue: false,
    }
  }

  if (completionState === 'failed_after_execution' || executionStatus === 'failed') {
    const failureContinuation = shouldContinueAfterToolFailure({
      result,
      toolEvents: executionResult?.toolEvents,
      routeState: { answerMode: 'execute' },
      continuationAttempts: passIndex,
      maxContinuationAttempts: maxPasses,
    })
    const shouldContinue =
      failureContinuation.shouldContinue ||
      (executionStatus === 'failed' && canContinue)
    return {
      isComplete: false,
      graphState: 'BLOCKED',
      status: shouldContinue ? 'running' : 'blocked',
      reason: 'failed_after_execution',
      nextAction: shouldContinue ? 'attempt_recovery' : 'recover_or_report_failure',
      canContinue: shouldContinue,
      continuationGate: failureContinuation,
    }
  }

  if (completionState === 'executed_unverified') {
    return {
      isComplete: false,
      graphState: 'BLOCKED',
      status: canContinue ? 'running' : 'blocked',
      reason: 'verification_required',
      nextAction: canContinue ? 'run_verification' : 'run_verification_or_explain_blocker',
      canContinue,
    }
  }

  if (INCOMPLETE_COMPLETION_STATES.has(completionState)) {
    return {
      isComplete: false,
      graphState: 'BLOCKED',
      status: 'blocked',
      reason: completionState,
      nextAction: 'resolve_incomplete_completion_state',
      canContinue: false,
    }
  }

  return {
    isComplete: true,
    graphState: 'COMPLETED',
    status: normalizeCompletedResultStatus(result?.status),
    reason: completionState || result?.terminationReason || 'completed',
    nextAction: 'finalize',
    canContinue: false,
  }
}

export function mergeGraphResult({
  result = {},
  plan,
  executionResult = {},
  executionHistory = [],
  decision,
  checkpoints = [],
} = {}) {
  const mergedDecision = decision || decideGraphCompletion({ result, executionResult })
  const graphExecutions = (Array.isArray(executionHistory) && executionHistory.length > 0
    ? executionHistory
    : [executionResult]
  )
    .filter(Boolean)
    .map(entry => ({
      subtaskId: entry?.subtaskId,
      status: entry?.status,
      durationMs: entry?.durationMs,
      evidence: entry?.evidence || [],
      artifacts: entry?.artifacts || [],
      errors: entry?.errors || [],
      nextRecommendation: entry?.nextRecommendation,
    }))
  const latestGraphExecution = graphExecutions.at(-1) || {}
  return {
    ...result,
    status: mergedDecision.status,
    pathMode: 'long',
    graphPlan: plan,
    graphState: mergedDecision.graphState,
    graphCompletion: {
      isComplete: mergedDecision.isComplete,
      reason: mergedDecision.reason,
      nextAction: mergedDecision.nextAction,
      completionState: result?.completionState,
    },
    graphExecution: {
      subtaskId: latestGraphExecution?.subtaskId,
      status: latestGraphExecution?.status,
      durationMs: latestGraphExecution?.durationMs,
      evidence: latestGraphExecution?.evidence || [],
      artifacts: latestGraphExecution?.artifacts || [],
      errors: latestGraphExecution?.errors || [],
      nextRecommendation: latestGraphExecution?.nextRecommendation,
    },
    graphExecutions,
    graphCheckpoints: checkpoints,
    terminationReason: result?.terminationReason || mergedDecision.reason,
  }
}
