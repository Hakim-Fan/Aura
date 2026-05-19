import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildCapabilityExposureNote,
  buildDefaultAgentSystemPrompt,
} from './agentPrompting.mjs'

const baseSettings = {
  cwd: '/tmp/workspace',
  autoApproveShell: false,
  autoApproveFileWrite: false,
  autoApproveComputerUse: false,
  reasoningEffort: 'medium',
}

const modelDirectedState = {
  modelDirected: true,
  answerMode: 'advise',
  needsExternalFacts: false,
  researchMode: 'auto',
  responseStyle: 'adaptive-default',
}

test('default-agent prompt lets the main model choose answer, tools, or plan', () => {
  const prompt = buildDefaultAgentSystemPrompt(
    baseSettings,
    '',
    '',
    modelDirectedState,
  )

  assert.match(prompt, /default-agent mode/i)
  assert.match(prompt, /main model decides/i)
  assert.match(prompt, /For simple questions, answer directly/i)
  assert.match(prompt, /todo_write with a short checklist/i)
  assert.match(prompt, /successCriteria/i)
  assert.match(prompt, /verification\.status as completed/i)
  assert.match(prompt, /single default-agent pass/i)
  assert.match(prompt, /Workspace scratch directory: \/tmp\/workspace\/\.aura\/tmp\//i)
  assert.match(prompt, /temporary unzip\/extraction output/i)
})

test('default-agent prompt keeps mounted write tools available', () => {
  const prompt = buildDefaultAgentSystemPrompt(
    baseSettings,
    '',
    '',
    modelDirectedState,
    {
      hasWorkspaceWriteTools: true,
    },
  )

  assert.match(prompt, /prefer apply_patch/i)
  assert.match(prompt, /targeted verification/i)
  assert.match(prompt, /exec_command/i)
})

test('capability exposure note describes default-agent capabilities', () => {
  const note = buildCapabilityExposureNote(
    {
      skills: [],
      plugins: [],
      mcpServers: [],
    },
    modelDirectedState,
  )

  assert.match(note, /default-agent capability profile/i)
  assert.match(note, /optional tools/i)
})

test('default-agent prompt frames skills as enabled options', () => {
  const prompt = buildDefaultAgentSystemPrompt(
    baseSettings,
    '- Web Research (id: web-research): Find and compare public sources.',
    '',
    modelDirectedState,
  )

  assert.match(prompt, /Enabled skill summaries:/)
  assert.match(prompt, /scan the skill names, ids, and descriptions/i)
  assert.match(prompt, /aura_read_skill with the exact skill id/i)
})

test('default-agent prompt carries the configured locale policy', () => {
  const prompt = buildDefaultAgentSystemPrompt(
    {
      ...baseSettings,
      locale: 'zh-CN',
    },
    '',
    '',
    modelDirectedState,
  )

  assert.match(prompt, /简体中文/)
  assert.match(prompt, /all user-facing answers, visible reasoning notes, plan previews, step titles/i)
})
