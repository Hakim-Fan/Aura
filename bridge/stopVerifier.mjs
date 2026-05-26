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

export function runStopVerifier({
  result = {},
  routeState = {},
  attempt = 0,
  maxAttempts = 2,
} = {}) {
  const completionState = result?.completionState || 'not_executed'
  if (routeState?.answerMode !== 'execute') {
    return { ok: true, reason: 'non_execute_route' }
  }
  if (completionState === 'executed_verified') {
    return { ok: true, reason: 'verified_evidence_present' }
  }
  if (TERMINAL_BLOCK_STATES.has(completionState)) {
    return { ok: true, reason: completionState }
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

  const evidenceSummary = result?.evidenceSummary || {}
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
