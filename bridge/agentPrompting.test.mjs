import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildCapabilityExposureNote,
  buildDefaultAgentPromptBlocks,
  buildDefaultAgentSystemPrompt,
  buildRuntimeSystemPrompt,
  buildUserCustomInstructionsPrompt,
} from './agentPrompting.mjs'
import {
  diffPromptBlockSnapshots,
  promptBlockSnapshot,
} from './promptBlocks.mjs'

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

const executionState = {
  ...modelDirectedState,
  answerMode: 'execute',
  executionMode: 'long-task',
  completionPolicy: {
    requiresEvidenceForDone: true,
  },
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

test('default-agent prompt makes execution mode evidence-led', () => {
  const prompt = buildDefaultAgentSystemPrompt(
    baseSettings,
    '',
    '',
    executionState,
    {
      hasWorkspaceWriteTools: true,
    },
  )

  assert.match(prompt, /Execution-mode contract/i)
  assert.match(prompt, /todo_write, reading files, and explaining intent are coordination\/context only/i)
  assert.match(prompt, /smallest durable file first/i)
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

test('custom instructions prompt keeps work rules and answer preferences separate', () => {
  const prompt = buildUserCustomInstructionsPrompt({
    customInstructions: {
      workRules: '改代码前先读相关文件，改完运行 typecheck。',
      answerPreferences: '默认使用中文，先给结论。',
    },
  })

  assert.match(prompt, /User custom instructions/)
  assert.match(prompt, /<work_rules>/)
  assert.match(prompt, /改代码前先读相关文件/)
  assert.match(prompt, /<answer_preferences>/)
  assert.match(prompt, /默认使用中文/)
})

test('default-agent prompt includes configured custom instructions', () => {
  const prompt = buildDefaultAgentSystemPrompt(
    {
      ...baseSettings,
      customInstructions: {
        workRules: '改代码必须小范围修改。',
        answerPreferences: '回答先给结论。',
      },
    },
    '',
    '',
    modelDirectedState,
  )

  assert.match(prompt, /<work_rules>\n改代码必须小范围修改。/)
  assert.match(prompt, /<answer_preferences>\n回答先给结论。/)
})

test('default-agent prompt is assembled from ordered prompt blocks', () => {
  const blocks = buildDefaultAgentPromptBlocks(
    {
      ...baseSettings,
      customInstructions: {
        workRules: '改代码必须小范围修改。',
        answerPreferences: '回答先给结论。',
      },
    },
    '- Web Research (id: web-research): Find and compare public sources.',
    'default-agent capability profile',
    modelDirectedState,
    {
      hasWorkspaceWriteTools: true,
    },
  )

  assert.deepEqual(blocks.map(block => block.id), [
    'core-instructions',
    'developer-instructions',
    'system-safety-and-permissions',
    'user-custom-instructions',
    'environment-context',
    'capability-context',
  ])
  assert.equal(blocks[0].kind, 'core_instructions')
  assert.equal(blocks[3].kind, 'user_custom_instructions')
  assert.equal(blocks[5].kind, 'capability_context')
})

test('prompt block snapshots isolate changed custom instructions', () => {
  const previous = promptBlockSnapshot(buildDefaultAgentPromptBlocks(
    {
      ...baseSettings,
      customInstructions: {
        workRules: '旧规则',
        answerPreferences: '回答先给结论。',
      },
    },
    '',
    '',
    modelDirectedState,
  ))
  const next = promptBlockSnapshot(buildDefaultAgentPromptBlocks(
    {
      ...baseSettings,
      customInstructions: {
        workRules: '新规则',
        answerPreferences: '回答先给结论。',
      },
    },
    '',
    '',
    modelDirectedState,
  ))

  assert.deepEqual(diffPromptBlockSnapshots(previous, next), {
    added: [],
    changed: ['user-custom-instructions'],
    removed: [],
  })
})

test('runtime prompt constrains the turn to the newest user request', () => {
  const prompt = buildRuntimeSystemPrompt(
    {
      cwd: '/workspace',
      locale: 'zh-CN',
      reasoningEffort: 'medium',
      autoApproveShell: false,
      autoApproveFileWrite: false,
      autoApproveComputerUse: false,
      requireLongTaskPlanApproval: false,
    },
    '',
    '',
    null,
  )

  assert.match(prompt, /Latest user request boundary/)
  assert.match(prompt, /newest user message as the scope for this turn/)
  assert.match(prompt, /Do not expand a narrow latest request into an older larger task goal/)
})
