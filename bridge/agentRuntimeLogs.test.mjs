import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildErrorDetails,
  buildMetricsSummaryDetails,
  buildRunFinishedDetails,
  createAgentRuntimeLogger,
  normalizeAgentArchitectureMode,
  resolveAgentExecutionMode,
  wrapAgentRuntimeHooks,
} from './agentRuntimeLogs.mjs'

test('normalizeAgentArchitectureMode keeps route-first as the legacy stable path', () => {
  assert.equal(normalizeAgentArchitectureMode(undefined), 'legacy')
  assert.equal(normalizeAgentArchitectureMode('route-first'), 'legacy')
  assert.equal(normalizeAgentArchitectureMode('legacy'), 'legacy')
  assert.equal(normalizeAgentArchitectureMode('hybrid'), 'hybrid')
  assert.equal(normalizeAgentArchitectureMode('graph'), 'graph')
  assert.equal(normalizeAgentArchitectureMode('state-machine'), 'graph')
  assert.equal(normalizeAgentArchitectureMode('unexpected'), 'legacy')
})

test('resolveAgentExecutionMode keeps staged graph modes on route-first execution core', () => {
  assert.deepEqual(resolveAgentExecutionMode({ agentArchitectureMode: 'route-first' }), {
    requestedArchitectureMode: 'route-first',
    architectureMode: 'legacy',
    effectiveAgentMode: 'route-first',
    pathMode: 'standard',
    fallbackToLegacy: false,
  })
  assert.deepEqual(resolveAgentExecutionMode({ agentArchitectureMode: 'hybrid' }), {
    requestedArchitectureMode: 'hybrid',
    architectureMode: 'hybrid',
    effectiveAgentMode: 'route-first',
    pathMode: 'standard',
    fallbackToLegacy: false,
  })
  assert.deepEqual(resolveAgentExecutionMode({ agentArchitectureMode: 'graph' }), {
    requestedArchitectureMode: 'graph',
    architectureMode: 'graph',
    effectiveAgentMode: 'route-first',
    pathMode: 'long',
    fallbackToLegacy: false,
  })
})

test('createAgentRuntimeLogger emits stable base fields and never throws through hooks', () => {
  const events = []
  const logger = createAgentRuntimeLogger({
    hooks: {
      onRuntimeLog(event) {
        events.push(event)
      },
    },
    settings: {
      agentArchitectureMode: 'route-first',
    },
    logContext: {
      sessionId: 'session-1',
      taskId: 'task-1',
      assistantMessageId: 'assistant-1',
    },
    now: () => 1_700_000_000_000,
    random: () => 0.123456,
  })

  logger.emit('agent.run.started', { provider: 'openai', model: 'test-model' })

  assert.equal(events.length, 1)
  assert.equal(events[0].event, 'agent.run.started')
  assert.equal(events[0].level, 'info')
  assert.equal(events[0].details.runId, logger.runId)
  assert.equal(events[0].details.sessionId, 'session-1')
  assert.equal(events[0].details.taskId, 'task-1')
  assert.equal(events[0].details.assistantMessageId, 'assistant-1')
  assert.equal(events[0].details.architectureMode, 'legacy')
  assert.equal(events[0].details.requestedArchitectureMode, 'route-first')
  assert.equal(events[0].details.pathMode, 'standard')
  assert.equal(events[0].details.eventVersion, 1)
  assert.equal(events[0].details.provider, 'openai')

  const throwingLogger = createAgentRuntimeLogger({
    hooks: {
      onRuntimeLog() {
        throw new Error('log sink failed')
      },
    },
  })
  assert.doesNotThrow(() => {
    throwingLogger.emit('agent.run.started')
  })
})

test('wrapAgentRuntimeHooks logs route, tool, compression, recovery, and still forwards hooks', () => {
  const runtimeEvents = []
  const forwarded = []
  const logger = createAgentRuntimeLogger({
    hooks: {
      onRuntimeLog(event) {
        runtimeEvents.push(event)
      },
    },
  })
  const hooks = wrapAgentRuntimeHooks({
    onRouteDecision(routeDecision) {
      forwarded.push(['route', routeDecision.capabilityTier])
    },
    onToolEvent(event) {
      forwarded.push(['tool', event.name])
    },
    onContextCompression(contextCompression) {
      forwarded.push(['compression', contextCompression.id])
    },
    onPhaseChange(phase) {
      forwarded.push(['phase', phase])
    },
  }, logger)

  hooks.onRouteDecision({
    capabilityTier: 'local-write',
    answerMode: 'execute',
    availableEscalations: ['browser-interactive'],
    mountedCapabilities: { tools: ['read_file', 'apply_patch'] },
    budgets: { writeEscalationsRemaining: 1 },
  })
  hooks.onToolEvent({
    id: 'tool-1',
    name: 'apply_patch',
    source: 'builtin',
    status: 'success',
    summary: 'patched file',
  })
  hooks.onContextCompression({
    id: 'compression-1',
    trigger: 'local_estimate',
    originalTokenEstimate: 1000,
    compressedTokenEstimate: 400,
  })
  hooks.onPhaseChange('recovering')

  assert.deepEqual(forwarded, [
    ['route', 'local-write'],
    ['tool', 'apply_patch'],
    ['compression', 'compression-1'],
    ['phase', 'recovering'],
  ])
  assert.deepEqual(runtimeEvents.map(event => event.event), [
    'agent.route.decision',
    'agent.tool.event',
    'agent.context.compression',
    'agent.recovery.event',
  ])
})

test('run finished and error detail helpers expose validation-friendly summaries', () => {
  const logger = {
    elapsedMs: () => 42,
    baseDetails: {
      architectureMode: 'graph',
      requestedArchitectureMode: 'graph',
      pathMode: 'long',
    },
  }
  const finished = buildRunFinishedDetails({
    status: 'completed',
    completionState: 'executed_verified',
    routeDecision: { stopReason: 'completed_with_evidence' },
    usage: { inputTokens: 11, outputTokens: 7 },
    toolEvents: [{ id: 'tool-1' }, { id: 'tool-2' }],
  }, logger)

  assert.equal(finished.status, 'completed')
  assert.equal(finished.terminationReason, 'completed_with_evidence')
  assert.equal(finished.toolCount, 2)
  assert.equal(finished.inputTokens, 11)
  assert.equal(finished.outputTokens, 7)
  assert.equal(finished.durationMs, 42)

  const metrics = buildMetricsSummaryDetails({
    status: 'blocked',
    pathMode: 'long',
    completionState: 'executed_unverified',
    graphState: 'BLOCKED',
    graphCompletion: {
      reason: 'verification_required',
      nextAction: 'run_verification',
    },
    graphExecutions: [
      { status: 'completed' },
      { status: 'failed', nextRecommendation: 'recover using recent evidence' },
    ],
    graphCheckpoints: [{ id: 'checkpoint-1' }, { id: 'checkpoint-2' }],
    usage: { inputTokens: 17, outputTokens: 9 },
    toolEvents: [{ id: 'tool-1' }],
  }, logger, 'blocked')

  assert.equal(metrics.status, 'blocked')
  assert.equal(metrics.architectureMode, 'graph')
  assert.equal(metrics.pathMode, 'long')
  assert.equal(metrics.checkpointCount, 2)
  assert.equal(metrics.graphExecutionCount, 2)
  assert.equal(metrics.recovered, true)
  assert.equal(metrics.recoveryCount, 1)
  assert.equal(metrics.graphState, 'BLOCKED')
  assert.equal(metrics.graphCompletionReason, 'verification_required')
  assert.equal(metrics.graphNextAction, 'run_verification')
  assert.equal(metrics.inputTokens, 17)
  assert.equal(metrics.outputTokens, 9)

  const error = new Error('Provider failed with a long message')
  error.code = 'PROVIDER_FAILED'
  error.source = 'provider'
  error.errorInfo = {
    category: 'unavailable',
    retryable: true,
    suggestedAction: 'Try again later.',
  }
  const details = buildErrorDetails(error)
  assert.equal(details.source, 'provider')
  assert.equal(details.category, 'unavailable')
  assert.equal(details.code, 'PROVIDER_FAILED')
  assert.equal(details.retryable, true)
  assert.equal(details.suggestedAction, 'Try again later.')
})
