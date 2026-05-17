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
    '- Web Research (id: web-research): Find and compare public sources.; if this matches the user request, call aura_read_skill with skillId "web-research" before applying it.',
    '',
    {
      answerMode: 'advise',
      needsExternalFacts: false,
      researchMode: 'auto',
      responseStyle: 'adaptive-default',
    },
  )

  assert.match(prompt, /Enabled skill summaries:/)
  assert.match(prompt, /live routing hints/i)
  assert.match(prompt, /even if the user does not mention a skill/i)
  assert.match(prompt, /aura_read_skill with the exact skill id/i)
})

test('route-first prompt separates scratchpad reasoning from reusable work memory', () => {
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

  assert.match(prompt, /reasoning and scratchpad text are temporary process/i)
  assert.match(prompt, /record_work_memory/i)
  assert.match(prompt, /draft, and mark unverified assumptions as assumption/i)
})

test('route-first prompt carries the configured locale policy', () => {
  const prompt = buildRouteFirstSystemPrompt(
    {
      cwd: '/tmp/workspace',
      locale: 'zh-CN',
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

  assert.match(prompt, /简体中文/)
  assert.match(prompt, /all user-facing answers, visible reasoning notes, plan previews, step titles/i)
})
