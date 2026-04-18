function normalizeComparableText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[`#>*_[\](){}]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function truncateText(value, maxLength = 220) {
  const normalized = String(value || '').replace(/\s+/g, ' ').trim()
  if (!normalized) {
    return ''
  }
  return normalized.length > maxLength
    ? `${normalized.slice(0, maxLength)}...`
    : normalized
}

export function summarizeRouteTurn({
  routeState,
  resultMessage,
  toolEvents,
  eventStartIndex = 0,
}) {
  const nextEvents = Array.isArray(toolEvents) ? toolEvents.slice(eventStartIndex) : []
  const successfulToolEventCount = nextEvents.filter(event => event.status === 'success').length
  const errorToolEventCount = nextEvents.filter(event => event.status === 'error').length

  return {
    answerMode: routeState?.answerMode,
    capabilityTier: routeState?.capabilityTier,
    toolEventCount: nextEvents.length,
    successfulToolEventCount,
    errorToolEventCount,
    toolNames: Array.from(new Set(nextEvents.map(event => event.name).filter(Boolean))),
    messageSummary: truncateText(resultMessage, 260),
    messageFingerprint: normalizeComparableText(resultMessage),
  }
}

export function determineRouteStopReason({
  routeHistory,
  currentTurn,
  desiredEscalationTarget,
  availableEscalations,
}) {
  if (!desiredEscalationTarget) {
    return null
  }

  const previousTurn = Array.isArray(routeHistory) ? routeHistory.at(-1) : null
  if (
    previousTurn &&
    currentTurn &&
    currentTurn.toolEventCount === 0 &&
    currentTurn.successfulToolEventCount === 0 &&
    currentTurn.messageFingerprint &&
    currentTurn.messageFingerprint === previousTurn.messageFingerprint
  ) {
    return 'no_incremental_progress'
  }

  if (
    Array.isArray(availableEscalations) &&
    !availableEscalations.includes(desiredEscalationTarget)
  ) {
    return 'budget_exhausted'
  }

  return null
}

export function buildRouteStopMessage({
  stopReason,
  message,
  routeState,
  desiredEscalationTarget,
}) {
  const baseMessage = String(message || '').trim()
  const stopNote =
    stopReason === 'no_incremental_progress'
      ? '基于现有证据继续尝试也没有带来新的有效信息，所以我先在当前证据范围内收束回答，避免重复无效操作。'
      : stopReason === 'budget_exhausted'
        ? '继续沿当前方向扩展也很难带来明显增量，所以我先基于现有证据给出最稳妥的结论和下一步。'
        : ''

  if (!stopNote) {
    return baseMessage
  }
  if (!baseMessage) {
    return stopNote
  }
  if (baseMessage.includes(stopNote)) {
    return baseMessage
  }
  return `${baseMessage}\n\n${stopNote}`
}
