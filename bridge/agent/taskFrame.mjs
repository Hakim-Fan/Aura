const INCOMPLETE_EXECUTION_STATES = new Set([
  'not_executed',
  'executed_unverified',
  'failed_after_execution',
  'blocked_by_approval',
  'blocked_by_capability',
])

function safeArray(value) {
  return Array.isArray(value) ? value : []
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function compactString(value, maxLength = 280) {
  const normalized = String(value || '').replace(/\s+/g, ' ').trim()
  if (!normalized) {
    return ''
  }
  return normalized.length > maxLength
    ? `${normalized.slice(0, maxLength)}...`
    : normalized
}

function latestUserIndex(messages = []) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === 'user') {
      return index
    }
  }
  return -1
}

function previousAssistantMessage(messages = [], beforeIndex = messages.length) {
  for (let index = Math.min(beforeIndex - 1, messages.length - 1); index >= 0; index -= 1) {
    if (messages[index]?.role === 'assistant') {
      return messages[index]
    }
  }
  return null
}

function normalizePendingAction(value, source = 'runtime') {
  if (!isRecord(value)) {
    return null
  }
  const id = compactString(value.id || value.pendingActionId || value.actionId, 120)
  const kind = compactString(value.kind || value.type || value.category, 80)
  const status = compactString(value.status || value.approvalState, 80)
  const summary = compactString(value.summary || value.title || value.description)
  const requiredCapabilities = safeArray(value.requiredCapabilities)
    .map(entry => compactString(entry, 80))
    .filter(Boolean)

  if (!id && !kind && !summary) {
    return null
  }

  return {
    id: id || `pending-${source}`,
    kind: kind || 'pending_action',
    status: status || 'awaiting_confirmation',
    summary,
    requiredCapabilities,
    source,
  }
}

function collectRuntimePendingActions(runtime = {}) {
  const taskFrame = isRecord(runtime?.taskFrame) ? runtime.taskFrame : null
  return [
    ...safeArray(runtime?.pendingActions),
    ...safeArray(taskFrame?.pendingActions),
    taskFrame?.pendingAction,
  ]
    .map(action => normalizePendingAction(action, 'runtime'))
    .filter(Boolean)
}

function collectMessagePendingActions(messages = []) {
  const actions = []
  for (const message of messages) {
    const taskFrame = isRecord(message?.taskFrame) ? message.taskFrame : null
    for (const action of [
      ...safeArray(message?.pendingActions),
      ...safeArray(taskFrame?.pendingActions),
      taskFrame?.pendingAction,
    ]) {
      const normalized = normalizePendingAction(action, 'message')
      if (normalized) {
        actions.push(normalized)
      }
    }

    for (const event of safeArray(message?.events)) {
      if (
        event?.kind === 'approval' &&
        (event?.status === 'awaiting_approval' || event?.status === 'awaiting_user_input')
      ) {
        const normalized = normalizePendingAction(
          {
            id: event.id,
            kind: event.toolName || event.kind,
            status: event.status,
            summary: event.summary || event.title,
          },
          'message_event',
        )
        if (normalized) {
          actions.push(normalized)
        }
      }
    }
  }
  return actions
}

function isExecutionRouteDecision(routeDecision) {
  return routeDecision?.answerMode === 'execute' ||
    routeDecision?.intentClassification?.answerMode === 'execute' ||
    routeDecision?.completionPolicy?.requiresEvidenceForDone === true
}

function resolvePriorExecutionState(previousAssistant) {
  const completionState = compactString(previousAssistant?.completionState, 120)
  if (!completionState || !INCOMPLETE_EXECUTION_STATES.has(completionState)) {
    return null
  }

  const routeDecision = isRecord(previousAssistant?.routeDecision)
    ? previousAssistant.routeDecision
    : null
  const evidenceSummary = isRecord(previousAssistant?.evidenceSummary)
    ? previousAssistant.evidenceSummary
    : null

  if (
    !isExecutionRouteDecision(routeDecision) &&
    evidenceSummary?.hasExecutableEvidence !== true &&
    evidenceSummary?.hasWriteEvidence !== true
  ) {
    return null
  }

  return {
    completionState,
    reason: 'previous_assistant_incomplete_execution',
    answerMode: routeDecision?.answerMode || routeDecision?.intentClassification?.answerMode,
    requiresEvidenceForDone:
      routeDecision?.completionPolicy?.requiresEvidenceForDone !== false,
    messageId: previousAssistant?.id,
  }
}

export function resolveTaskFrame({ messages = [], runtime = {}, settings = {} } = {}) {
  const normalizedMessages = safeArray(messages)
  const latestIndex = latestUserIndex(normalizedMessages)
  const latestUser = latestIndex >= 0 ? normalizedMessages[latestIndex] : null
  const previousAssistant = previousAssistantMessage(normalizedMessages, latestIndex)
  const pendingActions = [
    ...collectRuntimePendingActions(runtime),
    ...collectMessagePendingActions(normalizedMessages),
  ]
  const priorExecution = resolvePriorExecutionState(previousAssistant)
  const hasAttachments =
    safeArray(latestUser?.attachments).length > 0 ||
    safeArray(latestUser?.parts).some(part => part?.type && part.type !== 'text')
  const blocksFastPath = Boolean(
    pendingActions.length > 0 ||
    priorExecution ||
    hasAttachments ||
    settings?.executionMode === 'long-task',
  )
  const reasons = [
    pendingActions.length > 0 ? 'pending_action' : null,
    priorExecution ? priorExecution.reason : null,
    hasAttachments ? 'latest_user_has_attachments' : null,
    settings?.executionMode === 'long-task' ? 'long_task_mode' : null,
  ].filter(Boolean)

  return {
    id:
      compactString(runtime?.taskFrame?.id, 120) ||
      `frame-${latestUser?.id || previousAssistant?.id || 'current-turn'}`,
    source: pendingActions.length > 0 || priorExecution ? 'structured_context' : 'implicit_turn',
    latestUserMessageId: latestUser?.id,
    previousAssistantMessageId: previousAssistant?.id,
    pendingActions,
    priorExecution,
    requiresEvidenceForDone:
      pendingActions.length > 0 ||
      priorExecution?.requiresEvidenceForDone === true,
    blocksFastPath,
    recommendedPathMode: blocksFastPath ? 'standard' : undefined,
    reasons,
  }
}

export function applyTaskFrameToClassification(classification = {}, taskFrame = {}) {
  if (!taskFrame?.blocksFastPath || classification?.pathMode !== 'fast') {
    return classification
  }

  return {
    ...classification,
    pathMode: taskFrame.recommendedPathMode || 'standard',
    requiresTools: true,
    requiresWrite:
      classification.requiresWrite === true ||
      taskFrame.requiresEvidenceForDone === true,
    reason: [
      classification.reason,
      `task_frame_blocked_fast_path:${safeArray(taskFrame.reasons).join('|') || 'structured_context'}`,
    ]
      .filter(Boolean)
      .join(', '),
    reasons: [
      ...safeArray(classification.reasons),
      'task_frame_blocked_fast_path',
      ...safeArray(taskFrame.reasons),
    ],
    taskFrameBlockedFastPath: true,
  }
}
