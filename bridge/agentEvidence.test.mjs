import test from 'node:test'
import assert from 'node:assert/strict'
import {
  collectEvidenceFromToolEvents,
  deriveCompletionState,
} from './agentEvidence.mjs'

test('recovered patch failures do not keep the task in failed_after_execution', () => {
  const evidence = collectEvidenceFromToolEvents([
    {
      name: 'apply_patch',
      source: 'builtin',
      status: 'error',
      errorInfo: {
        category: 'patch_context_mismatch',
      },
    },
    {
      name: 'read_file',
      source: 'builtin',
      status: 'success',
    },
    {
      name: 'apply_patch',
      source: 'builtin',
      status: 'success',
      output: JSON.stringify({
        verification: {
          path: 'attachments/NewHomePageScreen.redesigned.tsx',
          verified: true,
        },
      }),
    },
  ])

  assert.equal(evidence.hasExecutionFailure, false)
  assert.equal(
    deriveCompletionState({ answerMode: 'execute' }, evidence),
    'executed_verified',
  )
})

test('read-only inspection does not clear an unresolved patch failure', () => {
  const evidence = collectEvidenceFromToolEvents([
    {
      name: 'apply_patch',
      source: 'builtin',
      status: 'error',
      errorInfo: {
        category: 'patch_context_mismatch',
      },
    },
    {
      name: 'read_file',
      source: 'builtin',
      status: 'success',
    },
  ])

  assert.equal(evidence.hasExecutionFailure, true)
  assert.equal(
    deriveCompletionState({ answerMode: 'execute' }, evidence),
    'failed_after_execution',
  )
})

test('artifact verification can verify shell-produced office outputs', () => {
  const evidence = collectEvidenceFromToolEvents([
    {
      name: 'run_shell',
      source: 'builtin',
      status: 'success',
      input: '$ create deck',
      output: JSON.stringify({
        running: false,
        exitCode: 0,
      }),
    },
    {
      name: 'verify_artifact',
      source: 'builtin',
      status: 'success',
      output: JSON.stringify({
        path: 'out/deck.pptx',
        exists: true,
        verified: true,
        readBackOk: true,
        sha256: 'a'.repeat(64),
      }),
    },
  ])

  assert.equal(evidence.hasVerifiedEvidence, true)
  assert.equal(evidence.hasFileVerification, true)
  assert.deepEqual(evidence.artifactPaths, ['out/deck.pptx'])
  assert.equal(
    deriveCompletionState({ answerMode: 'execute' }, evidence),
    'executed_verified',
  )
})

test('spawn_agent verification pass counts as independent verified evidence', () => {
  const evidence = collectEvidenceFromToolEvents([
    {
      name: 'spawn_agent',
      source: 'subagent',
      status: 'success',
      structuredOutput: {
        agent_type: 'verification',
        agent_status: 'completed',
        response: 'pnpm typecheck passed and changed files were inspected.\n\nVERDICT: PASS',
      },
    },
  ])

  assert.equal(evidence.hasVerifiedEvidence, true)
  assert.equal(evidence.hasExecutionFailure, false)
})

test('spawn_agent verification failure is treated as unresolved execution failure', () => {
  const evidence = collectEvidenceFromToolEvents([
    {
      name: 'spawn_agent',
      source: 'subagent',
      status: 'success',
      structuredOutput: {
        agent_type: 'verification',
        agent_status: 'completed',
        response: 'relevant behavior was not verified.\n\nVERDICT: FAIL',
      },
    },
  ])

  assert.equal(evidence.hasExecutionFailure, true)
  assert.equal(
    deriveCompletionState({ answerMode: 'execute' }, evidence),
    'failed_after_execution',
  )
})

test('spawn_agent verification without explicit verdict is not treated as pass or fail', () => {
  const evidence = collectEvidenceFromToolEvents([
    {
      name: 'spawn_agent',
      source: 'subagent',
      status: 'success',
      structuredOutput: {
        agent_type: 'verification',
        agent_status: 'completed',
        response: 'NOT OK: expected file was not present.',
      },
    },
  ])

  assert.equal(evidence.hasVerifiedEvidence, false)
  assert.equal(evidence.hasExecutionFailure, false)
})

test('spawn_agent verification partial verdict is partial evidence, not pass or failure', () => {
  const evidence = collectEvidenceFromToolEvents([
    {
      name: 'spawn_agent',
      source: 'subagent',
      status: 'success',
      structuredOutput: {
        agent_type: 'verification',
        agent_status: 'completed',
        response: 'Could not start the browser in this environment.\n\nVERDICT: PARTIAL',
      },
    },
  ])

  assert.equal(evidence.hasVerifiedEvidence, false)
  assert.equal(evidence.hasExecutionFailure, false)
  assert.equal(evidence.records[0].verificationLevel, 'partial')
})

test('failed spawn_agent status is treated as unresolved execution failure', () => {
  const evidence = collectEvidenceFromToolEvents([
    {
      name: 'spawn_agent',
      source: 'subagent',
      status: 'success',
      structuredOutput: {
        agent_type: 'worker',
        agent_status: 'failed',
        response: 'Could not complete the implementation.',
      },
    },
  ])

  assert.equal(evidence.hasExecutionFailure, true)
  assert.equal(
    deriveCompletionState({ answerMode: 'execute' }, evidence),
    'failed_after_execution',
  )
})

test('successful read-only shell command is verified by exit code', () => {
  const evidence = collectEvidenceFromToolEvents([
    {
      name: 'run_shell',
      source: 'builtin',
      status: 'success',
      input: '$ node --version',
      output: JSON.stringify({
        status: 'exited',
        running: false,
        exitCode: 0,
        output: 'v24.14.0',
      }),
    },
  ])

  assert.equal(evidence.hasSuccessfulCommand, true)
  assert.equal(evidence.hasWriteEffect, false)
  assert.equal(
    deriveCompletionState({ answerMode: 'execute' }, evidence),
    'executed_verified',
  )
})

test('shell command file mutations count as write and artifact evidence', () => {
  const evidence = collectEvidenceFromToolEvents([
    {
      name: 'run_shell',
      source: 'builtin',
      status: 'success',
      input: '$ pandoc input.docx -o output.md',
      structuredOutput: {
        status: 'exited',
        running: false,
        exitCode: 0,
        operation: 'shell_file_mutation',
        affectedPaths: ['output.md'],
        fileChanges: [
          {
            path: 'output.md',
            exists: true,
            kind: 'create',
          },
        ],
      },
    },
  ])

  assert.equal(evidence.hasSuccessfulCommand, true)
  assert.equal(evidence.hasWriteEffect, true)
  assert.equal(evidence.hasArtifactEvidence, true)
  assert.deepEqual(evidence.artifactPaths, ['output.md'])
  assert.equal(
    deriveCompletionState(
      { answerMode: 'execute', executionMode: 'long-task' },
      evidence,
    ),
    'executed_verified',
  )
})

test('nonzero command exit is always an execution failure', () => {
  const evidence = collectEvidenceFromToolEvents([
    {
      name: 'run_shell',
      source: 'builtin',
      status: 'error',
      input: '$ npm test',
      output: JSON.stringify({
        status: 'exited',
        running: false,
        exitCode: 1,
        output: 'tests failed',
      }),
    },
  ])

  assert.equal(evidence.hasExecutionFailure, true)
  assert.equal(
    deriveCompletionState({ answerMode: 'execute' }, evidence),
    'failed_after_execution',
  )
})

test('later successful command clears an earlier command failure of the same effect type', () => {
  const evidence = collectEvidenceFromToolEvents([
    {
      name: 'exec_command',
      source: 'builtin',
      status: 'error',
      input: '$ find / -name python3.9',
      output: JSON.stringify({
        status: 'exited',
        running: false,
        exitCode: 1,
        output: 'zsh: no matches found',
      }),
    },
    {
      name: 'exec_command',
      source: 'builtin',
      status: 'success',
      input: '$ /usr/bin/python3 --version',
      output: JSON.stringify({
        status: 'exited',
        running: false,
        exitCode: 0,
        output: 'Python 3.9.6',
      }),
    },
  ])

  assert.equal(evidence.hasExecutionFailure, false)
  assert.equal(
    deriveCompletionState({ answerMode: 'execute' }, evidence),
    'executed_verified',
  )
})

test('failed command execution is not hidden by advise route mode', () => {
  const evidence = collectEvidenceFromToolEvents([
    {
      name: 'exec_command',
      source: 'builtin',
      status: 'error',
      input: '$ node missing-file.js',
      output: JSON.stringify({
        status: 'exited',
        running: false,
        exitCode: 1,
        output: 'module not found',
      }),
    },
  ])

  assert.equal(evidence.hasExecutionFailure, true)
  assert.equal(
    deriveCompletionState({ answerMode: 'advise' }, evidence),
    'failed_after_execution',
  )
})

test('failed Aura skill installation is treated as unresolved execution failure', () => {
  const evidence = collectEvidenceFromToolEvents([
    {
      name: 'aura_install_skill',
      source: 'builtin',
      status: 'error',
      errorInfo: {
        category: 'execution_failed',
        summary: 'GitHub API returned HTTP 403',
      },
    },
  ])

  assert.equal(evidence.hasAnyExecution, true)
  assert.equal(evidence.hasWriteEffect, true)
  assert.equal(evidence.hasExecutionFailure, true)
  assert.equal(
    deriveCompletionState({ answerMode: 'execute' }, evidence),
    'failed_after_execution',
  )
})

test('execute route with only read tool progress is executed_unverified', () => {
  const evidence = collectEvidenceFromToolEvents([
    {
      name: 'glob_files',
      source: 'builtin',
      status: 'success',
      input: '{"pattern":"**/*.docx"}',
      output: 'No matches found',
    },
    {
      name: 'aura_read_skill',
      source: 'builtin',
      status: 'success',
      input: '{"skillId":"docx"}',
      output: '{"name":"docx"}',
    },
  ])

  assert.equal(evidence.hasAnyExecution, false)
  assert.equal(
    deriveCompletionState({ answerMode: 'execute' }, evidence),
    'executed_unverified',
  )
})

test('long task execution without artifact or verification stays unverified', () => {
  const evidence = collectEvidenceFromToolEvents([
    {
      name: 'run_shell',
      source: 'builtin',
      status: 'success',
      input: '$ node script.js',
      output: JSON.stringify({
        status: 'exited',
        running: false,
        exitCode: 0,
        output: 'ok',
      }),
    },
  ])

  assert.equal(evidence.hasArtifactEvidence, false)
  assert.equal(
    deriveCompletionState(
      { answerMode: 'execute', executionMode: 'long-task' },
      evidence,
    ),
    'executed_unverified',
  )
})

test('structured tool output provides verification even when display output is truncated', () => {
  const evidence = collectEvidenceFromToolEvents([
    {
      name: 'apply_patch',
      source: 'builtin',
      status: 'success',
      output: '{"verified":true,\n...<truncated>',
      structuredOutput: {
        verified: true,
        files: [
          {
            path: 'src/App.tsx',
            exists: true,
            verified: true,
            readBackOk: true,
            sha256: 'b'.repeat(64),
          },
        ],
      },
    },
  ])

  assert.equal(evidence.hasVerifiedEvidence, true)
  assert.equal(evidence.hasFileVerification, true)
  assert.equal(
    deriveCompletionState({ answerMode: 'execute' }, evidence),
    'executed_verified',
  )
})
