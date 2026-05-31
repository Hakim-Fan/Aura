import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildStopVerifierContinuationMessages,
  runStopVerifier,
} from './stopVerifier.mjs'

test('stop verifier blocks execute finalization without verified evidence', () => {
  const result = runStopVerifier({
    routeState: { answerMode: 'execute' },
    result: {
      completionState: 'executed_unverified',
      evidenceSummary: {
        records: [
          {
            toolName: 'read_file',
            status: 'success',
            effectTypes: ['read'],
            producedEvidence: ['file_read'],
            verificationLevel: 'none',
          },
        ],
      },
    },
  })

  assert.equal(result.ok, false)
  assert.equal(result.reason, 'final_answer_without_verified_evidence')
  assert.match(result.feedback, /Stop verifier blocked/)
})

test('stop verifier allows verified and terminal blocker states', () => {
  assert.equal(
    runStopVerifier({
      routeState: { answerMode: 'execute' },
      result: { completionState: 'executed_verified' },
    }).ok,
    true,
  )
  assert.equal(
    runStopVerifier({
      routeState: { answerMode: 'execute' },
      result: { completionState: 'blocked_by_capability' },
    }).ok,
    true,
  )
})

test('stop verifier requires verification agent for multi-subagent execute work', () => {
  const result = runStopVerifier({
    routeState: { answerMode: 'execute' },
    result: {
      completionState: 'executed_verified',
      evidenceSummary: {
        records: [
          {
            toolName: 'spawn_agent',
            status: 'success',
            effectTypes: ['execute'],
            producedEvidence: ['structured_output'],
            verificationLevel: 'none',
          },
          {
            toolName: 'spawn_agent',
            status: 'success',
            effectTypes: ['execute'],
            producedEvidence: ['structured_output'],
            verificationLevel: 'none',
          },
          {
            toolName: 'run_shell',
            status: 'success',
            effectTypes: ['execute'],
            producedEvidence: ['command_exit_0'],
            verificationLevel: 'verified',
          },
        ],
      },
    },
  })

  assert.equal(result.ok, false)
  assert.equal(result.reason, 'verification_agent_required')
  assert.match(result.feedback, /agent_type="verification"/)
  assert.match(result.feedback, /VERDICT: PASS/)
})

test('stop verifier requires verification agent for multi-subagent model-directed work', () => {
  const result = runStopVerifier({
    routeState: { answerMode: 'advise', capabilityTier: 'default-agent' },
    result: {
      completionState: 'executed_verified',
      evidenceSummary: {
        records: [
          {
            toolName: 'spawn_agent',
            status: 'success',
            effectTypes: ['execute'],
            producedEvidence: ['structured_output'],
            verificationLevel: 'none',
          },
          {
            toolName: 'spawn_agent',
            status: 'success',
            effectTypes: ['execute'],
            producedEvidence: ['structured_output'],
            verificationLevel: 'none',
          },
        ],
      },
    },
  })

  assert.equal(result.ok, false)
  assert.equal(result.reason, 'verification_agent_required')
})

test('stop verifier allows multi-subagent work after verification verdict', () => {
  const result = runStopVerifier({
    routeState: { answerMode: 'execute' },
    result: {
      completionState: 'executed_verified',
      evidenceSummary: {
        records: [
          {
            toolName: 'spawn_agent',
            status: 'success',
            effectTypes: ['execute'],
            producedEvidence: ['structured_output'],
            verificationLevel: 'none',
          },
          {
            toolName: 'spawn_agent',
            status: 'success',
            effectTypes: ['execute'],
            producedEvidence: ['structured_output'],
            verificationLevel: 'none',
          },
          {
            toolName: 'spawn_agent',
            status: 'success',
            effectTypes: ['execute'],
            producedEvidence: ['independent_verification'],
            verificationLevel: 'verified',
          },
        ],
      },
    },
  })

  assert.equal(result.ok, true)
  assert.equal(result.reason, 'verified_evidence_present')
})

test('stop verifier continuation preserves draft and adds blocking feedback', () => {
  const messages = buildStopVerifierContinuationMessages({
    messages: [{ role: 'user', content: 'create a file' }],
    result: { message: 'done' },
    verifierResult: { feedback: 'Need real write evidence.' },
  })

  assert.deepEqual(messages, [
    { role: 'user', content: 'create a file' },
    { role: 'assistant', content: 'done' },
    { role: 'user', content: 'Need real write evidence.' },
  ])
})
