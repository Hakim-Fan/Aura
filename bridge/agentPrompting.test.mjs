import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildCapabilityExposureNote,
  buildRouteFirstSystemPrompt,
} from './agentPrompting.mjs'

test('route-first prompt treats mounted web tools as optional instead of inactive', () => {
  const prompt = buildRouteFirstSystemPrompt(
    {
      cwd: '/tmp/workspace',
      autoApproveShell: false,
      autoApproveFileWrite: false,
      autoApproveComputerUse: false,
      reasoningEffort: 'medium',
    },
    '',
    '',
    {
      answerMode: 'advise',
      needsExternalFacts: false,
      researchMode: 'auto',
      responseStyle: 'adaptive-default',
    },
  )

  assert.match(prompt, /do not wait for classifier hints/i)
  assert.doesNotMatch(prompt, /inactive unless external facts are clearly needed/i)
})

test('route-first prompt keeps mounted write tools available beyond execute-only routing', () => {
  const prompt = buildRouteFirstSystemPrompt(
    {
      cwd: '/tmp/workspace',
      autoApproveShell: false,
      autoApproveFileWrite: false,
      autoApproveComputerUse: false,
      reasoningEffort: 'medium',
    },
    '',
    '',
    {
      answerMode: 'advise',
      needsExternalFacts: false,
      researchMode: 'auto',
      responseStyle: 'adaptive-default',
    },
    {
      hasWorkspaceWriteTools: true,
    },
  )

  assert.match(prompt, /route mode as planning guidance rather than a hard prohibition/i)
  assert.match(prompt, /request_user_input/i)
  assert.doesNotMatch(prompt, /Workspace write tools: inactive for this turn/i)
})

test('capability exposure note explains optional web retrieval without classifier gating', () => {
  const note = buildCapabilityExposureNote(
    {
      skills: [],
      plugins: [],
      mcpServers: [],
    },
    {
      answerMode: 'advise',
      needsExternalFacts: false,
    },
  )

  assert.match(note, /optional tools/i)
  assert.match(note, /assuming they are blocked by prior classification/i)
})

test('route-first prompt frames skills as enabled options rather than preselected instructions', () => {
  const prompt = buildRouteFirstSystemPrompt(
    {
      cwd: '/tmp/workspace',
      autoApproveShell: false,
      autoApproveFileWrite: false,
      autoApproveComputerUse: false,
      reasoningEffort: 'medium',
    },
    '- Web Research: Find and compare public sources.; read the full skill file only if you decide to use it.',
    '',
    {
      answerMode: 'advise',
      needsExternalFacts: false,
      researchMode: 'auto',
      responseStyle: 'adaptive-default',
    },
  )

  assert.match(prompt, /Enabled skill summaries:/)
  assert.match(prompt, /not preselected instructions/i)
})
