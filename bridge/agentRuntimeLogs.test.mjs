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

test('normalizeAgentArchitectureMode only exposes default-agent', () => {
  assert.equal(normalizeAgentArchitectureMode(undefined), 'default-agent')
  assert.equal(normalizeAgentArchitectureMode('default-agent'), 'default-agent')
  assert.equal(normalizeAgentArchitectureMode('orchestrated'), 'default-agent')
  assert.equal(normalizeAgentArchitectureMode('unexpected'), 'default-agent')
})

test('resolveAgentExecutionMode uses default-agent as the main execution core', () => {
  assert.deepEqual(resolveAgentExecutionMode({ agentArchitectureMode: 'default-agent' }), {
    requestedArchitectureMode: 'default-agent',
    architectureMode: 'default-agent',
    effectiveAgentMode: 'default-agent',
    pathMode: 'default',
    fallbackToLegacy: false,
  })
  assert.deepEqual(resolveAgentExecutionMode({ agentArchitectureMode: 'orchestrated' }), {
    requestedArchitectureMode: 'orchestrated',
    architectureMode: 'default-agent',
    effectiveAgentMode: 'default-agent',
    pathMode: 'default',
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
      agentArchitectureMode: 'default-agent',
    },
    logContext: {
      sessionId: 'session-1',
      taskId: 'task-1',
      messageGroupId: 'group-1',
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
  assert.equal(events[0].details.messageGroupId, 'group-1')
  assert.equal(events[0].details.assistantMessageId, 'assistant-1')
  assert.equal(events[0].details.architectureMode, 'default-agent')
  assert.equal(events[0].details.requestedArchitectureMode, 'default-agent')
  assert.equal(events[0].details.pathMode, 'default')
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
    onAgentHookEvent(event) {
      forwarded.push(['hook', event.eventName])
    },
    onToolPermissionEvent(event) {
      forwarded.push(['permission', event.status])
    },
    onToolAuditEvent(event) {
      forwarded.push(['audit', event.status])
    },
    onToolCatalogEvent(event) {
      forwarded.push(['catalog', event.totalToolCount])
    },
    onContextCompression(contextCompression) {
      forwarded.push(['compression', contextCompression.id])
    },
    onProgress(event) {
      forwarded.push(['progress', event.type])
    },
    onPhaseChange(phase) {
      forwarded.push(['phase', phase])
    },
  }, logger)

  hooks.onRouteDecision({
    capabilityTier: 'local-write',
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
    riskLevel: 'medium',
    permissionScope: 'workspace_write',
    approvalCategory: 'file_write',
  })
  hooks.onAgentHookEvent({
    eventName: 'PreToolUse',
    status: 'completed',
    toolName: 'apply_patch',
    toolEventId: 'tool-1',
    durationMs: 3,
  })
  hooks.onToolPermissionEvent({
    toolEventId: 'tool-1',
    toolName: 'apply_patch',
    source: 'builtin',
    status: 'requested',
    approvalCategory: 'file_write',
    permissionScope: 'workspace_write',
    riskLevel: 'medium',
  })
  hooks.onToolAuditEvent({
    toolEventId: 'tool-1',
    toolName: 'apply_patch',
    source: 'builtin',
    status: 'success',
    approvalCategory: 'file_write',
    permissionScope: 'workspace_write',
    riskLevel: 'medium',
  })
  hooks.onToolCatalogEvent({
    totalToolCount: 10,
    directToolCount: 7,
    deferredToolCount: 2,
    discoverableToolCount: 3,
    highRiskToolCount: 4,
  })
  hooks.onContextCompression({
    id: 'compression-1',
    trigger: 'local_estimate',
    originalTokenEstimate: 1000,
    compressedTokenEstimate: 400,
  })
  hooks.onProgress({
    type: 'checkpoint_created',
    checkpointId: 'checkpoint-1',
    checkpointCount: 2,
    reason: 'step_completed',
    planId: 'plan-1',
    subtaskId: 'step-1',
    checkpointKind: 'default_agent_progress',
    triggerCount: 1,
  })
  hooks.onPhaseChange('recovering', {
    reason: '模型服务请求失败。',
    code: 'HTTP_400',
    providerStatus: 400,
    providerErrorDetail: 'Missing reasoning_content.',
    providerRawError: '{"message":"Missing reasoning_content","type":"invalid_request_error"}',
  })

  assert.deepEqual(forwarded, [
    ['route', 'local-write'],
    ['tool', 'apply_patch'],
    ['hook', 'PreToolUse'],
    ['permission', 'requested'],
    ['audit', 'success'],
    ['catalog', 10],
    ['compression', 'compression-1'],
    ['progress', 'checkpoint_created'],
    ['phase', 'recovering'],
  ])
  assert.deepEqual(runtimeEvents.map(event => event.event), [
    'agent.route.decision',
    'agent.tool.event',
    'agent.hook.invoked',
    'agent.tool.permission.requested',
    'agent.tool.audit',
    'agent.tool.catalog.loaded',
    'agent.context.compression',
    'agent.checkpoint.created',
    'agent.recovery.event',
  ])
  const toolRuntimeEvent = runtimeEvents.find(event => event.event === 'agent.tool.event')
  assert.equal(toolRuntimeEvent.details.riskLevel, 'medium')
  assert.equal(toolRuntimeEvent.details.permissionScope, 'workspace_write')
  const catalogRuntimeEvent = runtimeEvents.find(event => event.event === 'agent.tool.catalog.loaded')
  assert.equal(catalogRuntimeEvent.details.highRiskToolCount, 4)
  const checkpointRuntimeEvent = runtimeEvents.find(event => event.event === 'agent.checkpoint.created')
  assert.equal(checkpointRuntimeEvent.details.checkpointId, 'checkpoint-1')
  assert.equal(checkpointRuntimeEvent.details.checkpointCount, 2)
  const recoveryRuntimeEvent = runtimeEvents.find(event => event.event === 'agent.recovery.event')
  assert.equal(recoveryRuntimeEvent.details.code, 'HTTP_400')
  assert.equal(recoveryRuntimeEvent.details.providerStatus, 400)
  assert.match(recoveryRuntimeEvent.details.providerRawError, /Missing reasoning_content/)
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

  const defaultAgentMetrics = buildMetricsSummaryDetails({
    status: 'completed',
    checkpointCount: 3,
    usage: { inputTokens: 5, outputTokens: 2 },
  }, logger)
  assert.equal(defaultAgentMetrics.checkpointCount, 3)
  assert.equal(defaultAgentMetrics.graphState, undefined)

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
