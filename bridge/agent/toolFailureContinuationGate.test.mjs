import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildToolFailureContinuationNote,
  shouldContinueAfterToolFailure,
} from './toolFailureContinuationGate.mjs'

const failedInstallResult = {
  completionState: 'failed_after_execution',
  evidenceSummary: {
    hasExecutionFailure: true,
    records: [
      {
        toolName: 'aura_install_skill',
        status: 'error',
        effectTypes: ['write'],
        detail: 'GitHub API returned HTTP 403',
      },
    ],
  },
}

const failedToolEvents = [
  {
    name: 'aura_install_skill',
    status: 'error',
    error: 'Failed to fetch GitHub contents: HTTP 403',
    errorInfo: {
      code: 'HTTP_403',
      category: 'execution_failed',
      detail: 'Failed to fetch GitHub contents: HTTP 403',
      suggestedAction: 'Try a safer alternate download path.',
    },
  },
]

test('tool failure continuation gate continues unresolved execute failures', () => {
  const decision = shouldContinueAfterToolFailure({
    result: failedInstallResult,
    toolEvents: failedToolEvents,
    routeState: { answerMode: 'execute' },
    continuationAttempts: 0,
    maxContinuationAttempts: 2,
  })

  assert.equal(decision.shouldContinue, true)
  assert.equal(decision.reason, 'unresolved_execution_failure')
  assert.equal(decision.continuationAttempt, 1)
  assert.equal(decision.failedEvents[0].toolName, 'aura_install_skill')

  const note = buildToolFailureContinuationNote({
    decision,
    tools: [
      { name: 'aura_install_skill' },
      { name: 'exec_command' },
    ],
  })
  assert.match(note, /Runtime continuation gate/)
  assert.match(note, /aura_install_skill/)
  assert.match(note, /exec_command/)
})

test('tool failure continuation gate respects attempt budget and route mode', () => {
  assert.equal(
    shouldContinueAfterToolFailure({
      result: failedInstallResult,
      toolEvents: failedToolEvents,
      routeState: { answerMode: 'execute' },
      continuationAttempts: 2,
      maxContinuationAttempts: 2,
    }).shouldContinue,
    false,
  )
  assert.equal(
    shouldContinueAfterToolFailure({
      result: failedInstallResult,
      toolEvents: failedToolEvents,
      routeState: { answerMode: 'advise' },
    }).reason,
    'non_execute_route',
  )
})
