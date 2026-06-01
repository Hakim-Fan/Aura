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

const recoveredEnvironmentEvents = [
  {
    name: 'exec_command',
    status: 'error',
    input: '$ find / -name python3.9',
    error: 'Command timed out',
    errorInfo: {
      code: 'COMMAND_TIMEOUT',
      category: 'execution_failed',
      detail: 'find / -name python3.9 timed out',
    },
  },
  {
    name: 'exec_command',
    status: 'success',
    input: '$ /usr/bin/python3 --version',
    output: JSON.stringify({
      status: 'exited',
      running: false,
      exitCode: 0,
      output: 'Python 3.9.6',
    }),
    summary: 'Python version checked',
  },
  {
    name: 'write_file',
    status: 'error',
    input: '{"path":"report.md"}',
    error: 'Permission denied',
    errorInfo: {
      code: 'WRITE_FAILED',
      category: 'execution_failed',
      detail: 'Could not write report.md',
    },
  },
]

test('tool failure continuation gate continues unresolved execute failures', () => {
  const decision = shouldContinueAfterToolFailure({
    result: failedInstallResult,
    toolEvents: failedToolEvents,
    routeState: {},
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

test('tool failure continuation note carries reusable successful results', () => {
  const decision = shouldContinueAfterToolFailure({
    result: {
      completionState: 'failed_after_execution',
      evidenceSummary: {
        hasExecutionFailure: true,
        records: [
          {
            toolName: 'write_file',
            status: 'error',
            effectTypes: ['write'],
            detail: 'Could not write report.md',
          },
        ],
      },
    },
    toolEvents: recoveredEnvironmentEvents,
    routeState: {},
    continuationAttempts: 0,
    maxContinuationAttempts: 2,
  })

  const note = buildToolFailureContinuationNote({
    decision,
    tools: [{ name: 'exec_command' }, { name: 'write_file' }],
  })

  assert.match(note, /This is a continuation, not a fresh task/)
  assert.match(note, /Reusable successful tool results/)
  assert.match(note, /Python 3\.9\.6/)
  assert.match(note, /Do not repeat successful environment discovery/)
})

test('tool failure continuation gate respects attempt budget', () => {
  assert.equal(
    shouldContinueAfterToolFailure({
      result: failedInstallResult,
      toolEvents: failedToolEvents,
      routeState: {},
      continuationAttempts: 2,
      maxContinuationAttempts: 2,
    }).shouldContinue,
    false,
  )
  assert.equal(
    shouldContinueAfterToolFailure({
      result: failedInstallResult,
      toolEvents: failedToolEvents,
      routeState: {},
    }).reason,
    'unresolved_execution_failure',
  )
})
