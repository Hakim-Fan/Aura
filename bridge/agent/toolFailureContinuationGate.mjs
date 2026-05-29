function compactString(value, maxLength = 700) {
  const normalized = String(value || '').replace(/\s+/g, ' ').trim()
  if (!normalized) return ''
  return normalized.length > maxLength
    ? `${normalized.slice(0, maxLength)}...`
    : normalized
}

function safeArray(value) {
  return Array.isArray(value) ? value : []
}

function isExecutionEffectRecord(record = {}) {
  return safeArray(record.effectTypes).some(effectType =>
    effectType === 'write' ||
    effectType === 'execute' ||
    effectType === 'browser',
  )
}

function summarizeFailedRecords(evidenceSummary = {}) {
  return safeArray(evidenceSummary.records)
    .filter(record => record?.status === 'error' && isExecutionEffectRecord(record))
    .slice(-3)
    .map(record => ({
      toolName: record.toolName,
      category: record.detail ? undefined : record.category,
      detail: compactString(record.detail || record.category || 'execution failed', 240),
      effectTypes: safeArray(record.effectTypes),
    }))
}

function summarizeRecentFailedEvents(toolEvents = []) {
  return safeArray(toolEvents)
    .filter(event => event?.status === 'error')
    .slice(-3)
    .map(event => ({
      toolName: event?.name,
      category: event?.errorInfo?.category,
      code: event?.errorInfo?.code,
      detail: compactString(
        event?.errorInfo?.detail ||
          event?.errorInfo?.message ||
          event?.errorInfo?.summary ||
          event?.error ||
          event?.summary,
        360,
      ),
      suggestedAction: compactString(event?.errorInfo?.suggestedAction, 300),
      repairHint: event?.errorInfo?.repairHint,
    }))
}

function summarizeRecentSuccessfulEvents(toolEvents = []) {
  return safeArray(toolEvents)
    .filter(event => event?.status === 'success')
    .slice(-5)
    .map(event => ({
      toolName: event?.name,
      input: compactString(event?.input, 240),
      output: compactString(
        event?.structuredOutput
          ? JSON.stringify(event.structuredOutput)
          : event?.output,
        360,
      ),
      summary: compactString(event?.summary, 240),
    }))
}

function summarizeAvailableTools(tools = [], maxTools = 18) {
  return safeArray(tools)
    .map(tool => tool?.name)
    .filter(Boolean)
    .slice(0, maxTools)
}

export function shouldContinueAfterToolFailure({
  result = {},
  toolEvents = [],
  routeState = {},
  continuationAttempts = 0,
  maxContinuationAttempts = 2,
} = {}) {
  const evidenceSummary = result?.evidenceSummary || {}
  if (routeState?.answerMode !== 'execute') {
    return {
      shouldContinue: false,
      reason: 'non_execute_route',
    }
  }
  if (result?.completionState !== 'failed_after_execution') {
    return {
      shouldContinue: false,
      reason: 'completion_state_allows_finish',
    }
  }
  if (evidenceSummary.hasApprovalBlock || result?.completionState === 'blocked_by_approval') {
    return {
      shouldContinue: false,
      reason: 'approval_blocked',
    }
  }
  if (evidenceSummary.hasCapabilityBlock || result?.completionState === 'blocked_by_capability') {
    return {
      shouldContinue: false,
      reason: 'capability_blocked',
    }
  }
  if (!evidenceSummary.hasExecutionFailure) {
    return {
      shouldContinue: false,
      reason: 'no_unresolved_execution_failure',
    }
  }
  if (continuationAttempts >= maxContinuationAttempts) {
    return {
      shouldContinue: false,
      reason: 'continuation_budget_exhausted',
      failedRecords: summarizeFailedRecords(evidenceSummary),
      failedEvents: summarizeRecentFailedEvents(toolEvents),
      successfulEvents: summarizeRecentSuccessfulEvents(toolEvents),
    }
  }

  return {
    shouldContinue: true,
    reason: 'unresolved_execution_failure',
    nextAction: 'repair_with_available_tools',
    failedRecords: summarizeFailedRecords(evidenceSummary),
    failedEvents: summarizeRecentFailedEvents(toolEvents),
    successfulEvents: summarizeRecentSuccessfulEvents(toolEvents),
    continuationAttempt: continuationAttempts + 1,
    maxContinuationAttempts,
  }
}

export function buildToolFailureContinuationNote({
  decision,
  tools = [],
} = {}) {
  const failedEvents = safeArray(decision?.failedEvents)
  const successfulEvents = safeArray(decision?.successfulEvents)
  const availableTools = summarizeAvailableTools(tools)
  const failureLines = failedEvents.length > 0
    ? failedEvents.map((event, index) => {
        const bits = [
          `${index + 1}. ${event.toolName || 'unknown_tool'}`,
          event.code ? `code=${event.code}` : null,
          event.category ? `category=${event.category}` : null,
          event.detail ? `detail=${event.detail}` : null,
          event.suggestedAction ? `suggested=${event.suggestedAction}` : null,
        ].filter(Boolean)
        return bits.join(' | ')
      })
    : ['1. An execution tool failed and the failure is still unresolved.']
  const successLines = successfulEvents.length > 0
    ? successfulEvents.map((event, index) => {
        const bits = [
          `${index + 1}. ${event.toolName || 'unknown_tool'}`,
          event.summary ? `summary=${event.summary}` : null,
          event.input ? `input=${event.input}` : null,
          event.output ? `output=${event.output}` : null,
        ].filter(Boolean)
        return bits.join(' | ')
      })
    : []

  return [
    'Runtime continuation gate: an execution tool failed and the task is not complete.',
    `Repair attempt ${decision?.continuationAttempt || 1}/${decision?.maxContinuationAttempts || 1}.`,
    'This is a continuation, not a fresh task. Preserve completed work and continue from the latest unresolved blocker.',
    successLines.length > 0 ? 'Reusable successful tool results:' : null,
    ...successLines,
    'Recent unresolved failures:',
    ...failureLines,
    availableTools.length > 0
      ? `Currently available tool names include: ${availableTools.join(', ')}.`
      : null,
    'Do not repeat successful environment discovery, dependency installation, file generation, or verification steps unless a later tool result proves they are invalid.',
    'Continue by using the available tools to repair, retry with a safer method, or verify an alternate path.',
    'Do not provide a final success answer until a later tool result resolves the failed execution evidence.',
    'If no safe repair is possible, return a clear blocker summary instead of claiming completion.',
  ]
    .filter(Boolean)
    .join('\n')
}
