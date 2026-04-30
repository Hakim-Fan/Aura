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
