import test from 'node:test'
import assert from 'node:assert/strict'
import { __testInternals } from './agent.mjs'

const {
  buildCheckpointContinuationMessages,
  buildDefaultStepIncompleteMessage,
  evaluateStepOutcome,
  isDefaultStepComplete,
  normalizeDefaultStepPlan,
} = __testInternals

test('default step normalization requires durable evidence for unobservable execute steps', () => {
  const runtime = normalizeDefaultStepPlan({
    goal: '交付一份文档',
    steps: [
      {
        id: '1',
        description: '编写完整内容',
        kind: 'execute',
        acceptance: '内容已经可检查',
      },
    ],
  })

  assert.equal(runtime.steps[0].expectedOutcome, 'durable_artifact')
  assert.deepEqual(runtime.steps[0].requiredEvidence, ['file_mutation'])
})

test('default step completion does not accept todo/read-only progress for durable steps', () => {
  const step = {
    id: '1',
    title: '写入交付内容',
    kind: 'execute',
    expectedOutcome: 'durable_artifact',
    requiredEvidence: ['file_mutation'],
  }
  const toolEvents = [
    { name: 'todo_write', status: 'success', source: 'builtin' },
    { name: 'read_file', status: 'success', source: 'builtin' },
  ]

  assert.equal(
    isDefaultStepComplete({
      step,
      result: { message: '我已经整理好内容。' },
      toolEvents,
      startIndex: 0,
    }),
    false,
  )

  const message = buildDefaultStepIncompleteMessage(step, toolEvents, 0)
  assert.match(message.content, /Durable-progress recovery/)
  assert.match(message.content, /Do not repeat the same plan/)
})

test('default step completion accepts shell-generated file mutation evidence', () => {
  const step = {
    id: '1',
    title: '生成交付文件',
    kind: 'execute',
    expectedOutcome: 'durable_artifact',
    requiredEvidence: ['file_mutation'],
  }
  const toolEvents = [
    {
      name: 'exec_command',
      status: 'success',
      source: 'builtin',
      structuredOutput: {
        operation: 'shell_file_mutation',
        fileChanges: [{ path: 'out.md', exists: true, kind: 'create' }],
      },
    },
  ]

  assert.equal(
    isDefaultStepComplete({
      step,
      result: { message: '' },
      toolEvents,
      startIndex: 0,
    }),
    true,
  )
})

test('default step completion accepts artifact creation as durable evidence', () => {
  const step = {
    id: '1',
    title: '创建阶段性产物',
    kind: 'execute',
    expectedOutcome: 'durable_artifact',
    requiredEvidence: ['artifact_present'],
  }
  const toolEvents = [
    {
      name: 'create_artifact',
      status: 'success',
      source: 'builtin',
      output: JSON.stringify({
        path: 'draft.md',
        exists: true,
      }),
    },
  ]

  assert.equal(
    isDefaultStepComplete({
      step,
      result: { message: '' },
      toolEvents,
      startIndex: 0,
    }),
    true,
  )
})

test('step outcome policy treats todo-only progress as missing execution evidence', () => {
  const step = {
    id: '1',
    title: '执行一个可观察动作',
    kind: 'execute',
    requiredEvidence: ['execution_performed'],
  }

  const outcome = evaluateStepOutcome({
    step,
    result: { message: '更新了计划。' },
    toolEvents: [
      { name: 'todo_write', status: 'success', source: 'builtin' },
    ],
    startIndex: 0,
  })

  assert.equal(outcome.complete, false)
  assert.deepEqual(outcome.missing, ['execution_performed'])
  assert.deepEqual(outcome.observed.evidence, [])
})

test('checkpoint resume prompt preserves durable step contract', () => {
  const messages = buildCheckpointContinuationMessages({
    messages: [{ role: 'user', content: '继续生成 PRD' }],
    toolEvents: [
      { name: 'read_file', status: 'success', source: 'builtin', output: 'source' },
      { name: 'todo_write', status: 'success', source: 'builtin', output: 'todo' },
    ],
    stepRuntime: {
      enabled: true,
      state: 'EXECUTE_STEP',
      currentIndex: 0,
      steps: [
        {
          id: '2',
          title: '写入 PRD 文件',
          kind: 'execute',
          expectedOutcome: 'durable_artifact',
          requiredEvidence: ['file_mutation'],
          durableStallCount: 1,
        },
      ],
    },
    partialMessage: '现在开始编写完整 PRD。',
    error: new Error('Streaming response stalled while waiting for the next chunk.'),
  })

  const prompt = messages.at(-1).content
  assert.match(prompt, /当前选中步骤恢复合约/)
  assert.match(prompt, /durable file\/artifact evidence/)
  assert.match(prompt, /优先调用写入、编辑、artifact 或验证工具/)
})
