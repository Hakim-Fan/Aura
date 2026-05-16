export const AgentHookEvent = Object.freeze({
  PreRun: 'PreRun',
  PostRun: 'PostRun',
  PreToolUse: 'PreToolUse',
  PostToolUse: 'PostToolUse',
  PostToolUseFailure: 'PostToolUseFailure',
  PreCompact: 'PreCompact',
  PostCompact: 'PostCompact',
  PermissionRequest: 'PermissionRequest',
  PermissionDenied: 'PermissionDenied',
  PlanCreated: 'PlanCreated',
  PlanApproved: 'PlanApproved',
  PlanRejected: 'PlanRejected',
  CheckpointCreated: 'CheckpointCreated',
  CheckpointRestored: 'CheckpointRestored',
  SessionStart: 'SessionStart',
  SessionEnd: 'SessionEnd',
})

function normalizeHookResult(value) {
  if (!value || typeof value !== 'object') {
    return {
      blocked: false,
    }
  }

  return {
    blocked: value.blocked === true,
    reason: typeof value.reason === 'string' ? value.reason : '',
    code: typeof value.code === 'string' ? value.code : '',
    suggestedAction:
      typeof value.suggestedAction === 'string' ? value.suggestedAction : '',
    details:
      value.details && typeof value.details === 'object' && !Array.isArray(value.details)
        ? value.details
        : undefined,
  }
}

function matchesHookEvent(handler, eventName) {
  if (!handler || typeof handler !== 'object') {
    return false
  }
  if (!handler.event && !handler.events) {
    return true
  }
  if (Array.isArray(handler.events)) {
    return handler.events.includes(eventName)
  }
  return handler.event === eventName
}

function normalizeHookHandler(handler) {
  if (typeof handler === 'function') {
    return {
      handle: handler,
    }
  }
  if (handler && typeof handler.handle === 'function') {
    return handler
  }
  return null
}

export function createAgentHookBus({ handlers = [] } = {}) {
  const normalizedHandlers = handlers
    .map(normalizeHookHandler)
    .filter(Boolean)

  return {
    async invoke(eventName, payload = {}, options = {}) {
      for (const handler of normalizedHandlers) {
        if (!matchesHookEvent(handler, eventName)) {
          continue
        }
        const result = normalizeHookResult(
          await handler.handle({
            event: eventName,
            payload,
            options,
          }),
        )
        if (result.blocked) {
          return result
        }
      }

      return {
        blocked: false,
      }
    },
  }
}

export async function invokeAgentHook(hooks = {}, eventName, payload = {}, options = {}) {
  const startedAt = Date.now()

  function emitHookEvent(status, extra = {}) {
    try {
      hooks.onAgentHookEvent?.({
        eventName,
        status,
        durationMs: Math.max(0, Date.now() - startedAt),
        toolName: payload?.tool?.name || payload?.toolName,
        toolEventId: payload?.toolEventId,
        reason: extra.reason,
        code: extra.code,
      })
    } catch {
      // Hook diagnostics must never alter the execution path.
    }
  }

  emitHookEvent('started')

  try {
    const result = normalizeHookResult(
      typeof hooks.hookBus?.invoke === 'function'
        ? await hooks.hookBus.invoke(eventName, payload, options)
        : typeof hooks.onAgentHook === 'function'
          ? await hooks.onAgentHook({
            event: eventName,
            payload,
            options,
          })
          : null,
    )

    emitHookEvent(result.blocked ? 'blocked' : 'completed', result)
    return result
  } catch (error) {
    emitHookEvent('error', {
      reason: error instanceof Error ? error.message : String(error),
    })
    return {
      blocked: false,
      hookError: error,
    }
  }
}
