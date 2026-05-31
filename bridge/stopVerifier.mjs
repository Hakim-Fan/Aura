const BLOCKING_COMPLETION_STATES = new Set([
  'not_executed',
  'executed_unverified',
])

const TERMINAL_BLOCK_STATES = new Set([
  'blocked_by_approval',
  'blocked_by_capability',
  'failed_after_execution',
])

function safeArray(value) {
  return Array.isArray(value) ? value : []
}

function summarizeEvidence(evidenceSummary = {}) {
  const records = safeArray(evidenceSummary.records)
    .filter(record => record?.status === 'success')
    .slice(-8)
    .map(record => {
      const effects = safeArray(record.effectTypes).join(',')
      const evidence = safeArray(record.producedEvidence).slice(0, 4).join(',')
      return `- ${record.toolName || 'tool'}: effects=${effects || 'none'} evidence=${evidence || 'none'} verification=${record.verificationLevel || 'none'}`
    })
  const artifacts = safeArray(evidenceSummary.artifactPaths)
    .filter(Boolean)
    .slice(0, 8)
    .map(path => `- ${path}`)
  return [
    records.length ? `Successful tool evidence:\n${records.join('\n')}` : 'Successful tool evidence: none',
    artifacts.length ? `Artifact paths:\n${artifacts.join('\n')}` : '',
  ].filter(Boolean).join('\n\n')
}

function hasProducedEvidence(record = {}, evidenceName = '') {
  return safeArray(record.producedEvidence).includes(evidenceName)
}

function analyzeClaudeStyleVerificationRequirement(evidenceSummary = {}, routeState = {}) {
  const records = safeArray(evidenceSummary.records)
  const hasIndependentVerification = records.some(record =>
    hasProducedEvidence(record, 'independent_verification'),
  )
  const hasPartialVerification = records.some(record =>
    hasProducedEvidence(record, 'independent_verification_partial'),
  )
  const nonVerificationSubagentCount = records.filter(record =>
    record?.toolName === 'spawn_agent' &&
    !hasProducedEvidence(record, 'independent_verification') &&
    !hasProducedEvidence(record, 'independent_verification_partial') &&
    !hasProducedEvidence(record, 'independent_verification_failed'),
  ).length
  const fileMutationCount = records.filter(record =>
    hasProducedEvidence(record, 'file_mutation'),
  ).length
  const longTaskImplementation =
    routeState?.executionMode === 'long-task' ||
    routeState?.taskKind === 'long-task' ||
    routeState?.complexity === 'long-task'

  const reasons = []
  if (nonVerificationSubagentCount >= 2) {
    reasons.push(`multiple_subagents:${nonVerificationSubagentCount}`)
  }
  if (fileMutationCount >= 3) {
    reasons.push(`multiple_file_mutations:${fileMutationCount}`)
  }
  if (longTaskImplementation) {
    reasons.push('long_task_implementation')
  }

  return {
    required: reasons.length > 0,
    reasons,
    hasIndependentVerification,
    hasPartialVerification,
  }
}

export function runStopVerifier({
  result = {},
  routeState = {},
  attempt = 0,
  maxAttempts = 2,
} = {}) {
  const completionState = result?.completionState || 'not_executed'
  const evidenceSummary = result?.evidenceSummary || {}
  const verificationRequirement = analyzeClaudeStyleVerificationRequirement(
    evidenceSummary,
    routeState,
  )
  if (
    routeState?.answerMode !== 'execute' &&
    !verificationRequirement.required
  ) {
    return { ok: true, reason: 'non_execute_route' }
  }
  if (TERMINAL_BLOCK_STATES.has(completionState)) {
    return { ok: true, reason: completionState }
  }

  if (
    verificationRequirement.required &&
    !verificationRequirement.hasIndependentVerification &&
    !verificationRequirement.hasPartialVerification
  ) {
    if (attempt >= maxAttempts) {
      return {
        ok: true,
        reason: 'max_stop_verifier_attempts_reached',
        exhausted: true,
      }
    }
    const reason = 'verification_agent_required'
    return {
      ok: false,
      reason,
      feedback: [
        'Stop verifier blocked the final answer.',
        `Reason: ${reason}.`,
        `Claude-style verification required because: ${verificationRequirement.reasons.join(', ')}.`,
        `Completion state: ${completionState}.`,
        summarizeEvidence(evidenceSummary),
        'Before finalizing, call spawn_agent with agent_type="verification". Pass a self-contained message containing the original user request, changed/generated files, commands already run, subagent findings, and known concerns. The verification agent must end with exactly one line: VERDICT: PASS, VERDICT: FAIL, or VERDICT: PARTIAL.',
      ].filter(Boolean).join('\n\n'),
    }
  }
  if (
    verificationRequirement.required &&
    verificationRequirement.hasPartialVerification
  ) {
    return { ok: true, reason: 'verification_agent_partial' }
  }
  if (completionState === 'executed_verified') {
    return { ok: true, reason: 'verified_evidence_present' }
  }
  if (!BLOCKING_COMPLETION_STATES.has(completionState)) {
    return { ok: true, reason: 'non_blocking_completion_state' }
  }
  if (attempt >= maxAttempts) {
    return {
      ok: true,
      reason: 'max_stop_verifier_attempts_reached',
      exhausted: true,
    }
  }

  const reason =
    completionState === 'not_executed'
      ? 'final_answer_without_execution_evidence'
      : 'final_answer_without_verified_evidence'
  return {
    ok: false,
    reason,
    feedback: [
      'Stop verifier blocked the final answer.',
      `Reason: ${reason}.`,
      `Completion state: ${completionState}.`,
      summarizeEvidence(evidenceSummary),
      'Continue the task instead of finalizing. If the user requested a concrete deliverable, call the mounted write/edit/shell/verification tools needed to create or verify it. If completion is genuinely blocked, produce a blocker explanation without claiming completion.',
    ].filter(Boolean).join('\n\n'),
  }
}

export function buildStopVerifierContinuationMessages({
  messages = [],
  result = {},
  verifierResult = {},
} = {}) {
  const nextMessages = [...safeArray(messages)]
  const finalDraft = String(result?.message || '').trim()
  if (finalDraft) {
    nextMessages.push({
      role: 'assistant',
      content: finalDraft,
    })
  }
  nextMessages.push({
    role: 'user',
    content: verifierResult.feedback || 'Stop verifier blocked finalization. Continue execution with tools or explain the blocker without claiming completion.',
  })
  return nextMessages
}
