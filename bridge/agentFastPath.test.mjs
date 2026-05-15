import test from 'node:test'
import assert from 'node:assert/strict'
import { runAgent } from './agent.mjs'
import {
  AgentGraphState,
  createHybridPlan,
} from './agent/stateGraphRuntime.mjs'
import { createGraphCheckpointRuntime } from './agent/checkpointRuntime.mjs'

test('runAgent selects fast path before provider validation for simple no-tool tasks', async () => {
  const runtimeEvents = []

  await assert.rejects(
    () => runAgent({
      settings: {
        provider: 'openai',
        apiKey: '',
        model: 'test-model',
        agentArchitectureMode: 'route-first',
        executionMode: 'bounded',
      },
      messages: [
        {
          role: 'user',
          content: '解释一下什么是递归。',
        },
      ],
      hooks: {
        onRuntimeLog(event) {
          runtimeEvents.push(event)
        },
      },
      logContext: {
        sessionId: 'session-fast-path',
        taskId: 'task-fast-path',
        assistantMessageId: 'assistant-fast-path',
      },
    }),
    error => error?.code === 'MISSING_API_KEY',
  )

  const eventNames = runtimeEvents.map(event => event.event)
  assert.ok(eventNames.includes('agent.run.started'))
  assert.ok(eventNames.includes('agent.classifier.result'))
  assert.ok(eventNames.includes('agent.path.selected'))
  assert.ok(eventNames.includes('agent.fast_path.started'))
  assert.ok(eventNames.includes('agent.error.classified'))
  assert.ok(eventNames.includes('agent.run.finished'))

  const classifierEvent = runtimeEvents.find(event => event.event === 'agent.classifier.result')
  assert.equal(classifierEvent.details.pathMode, 'fast')
  assert.equal(classifierEvent.details.requiresTools, false)

  const pathEvent = runtimeEvents.find(event => event.event === 'agent.path.selected')
  assert.equal(pathEvent.details.pathMode, 'fast')
  assert.equal(pathEvent.details.architectureMode, 'legacy')
})

test('runAgent sends complex tasks through the hybrid graph wrapper', async () => {
  const runtimeEvents = []

  await assert.rejects(
    () => runAgent({
      settings: {
        provider: 'openai',
        apiKey: '',
        model: 'test-model',
        agentArchitectureMode: 'route-first',
        executionMode: 'bounded',
      },
      messages: [
        {
          role: 'user',
          content: '请做一个架构迁移方案，包含状态图、checkpoint 和验证逻辑。',
        },
      ],
      hooks: {
        onRuntimeLog(event) {
          runtimeEvents.push(event)
        },
      },
      logContext: {
        sessionId: 'session-graph-path',
        taskId: 'task-graph-path',
        assistantMessageId: 'assistant-graph-path',
      },
    }),
    error => error?.code === 'MISSING_API_KEY' && error?.graphState === 'RECOVER',
  )

  const eventNames = runtimeEvents.map(event => event.event)
  assert.ok(eventNames.includes('agent.classifier.result'))
  assert.ok(eventNames.includes('agent.plan.created'))
  assert.ok(eventNames.includes('agent.graph.transition'))
  assert.ok(eventNames.includes('agent.step.started'))
  assert.ok(eventNames.includes('agent.error.classified'))
  assert.ok(eventNames.includes('agent.run.finished'))

  const pathEvent = runtimeEvents.find(event => event.event === 'agent.path.selected')
  assert.equal(pathEvent.details.pathMode, 'long')
})

test('runAgent restores graph checkpoints through the hybrid graph path', async () => {
  const checkpointLogger = { emit() {} }
  const plan = createHybridPlan({
    request: {
      messages: [{ role: 'user', content: '恢复复杂任务' }],
    },
    classification: {
      risk: 'medium',
      complexity: 'complex',
    },
  })
  const checkpointRuntime = createGraphCheckpointRuntime({
    logger: checkpointLogger,
    taskId: 'task-run-agent-restore',
  })
  const checkpoint = checkpointRuntime.createCheckpoint({
    state: AgentGraphState.CHECKPOINT,
    plan,
    subtask: plan.subtasks[1],
    request: {
      messages: [{ role: 'user', content: 'checkpoint task' }],
      settings: {
        provider: 'openai',
        apiKey: 'do-not-persist',
        model: 'test-model',
        cwd: '/tmp/workspace',
      },
      logContext: { taskId: 'task-run-agent-restore' },
    },
    classification: {
      risk: 'medium',
      complexity: 'complex',
    },
    reason: 'before_execute_step',
  })
  const runtimeEvents = []

  await assert.rejects(
    () => runAgent({
      settings: {
        provider: 'openai',
        apiKey: '',
        model: 'test-model',
        agentArchitectureMode: 'route-first',
        executionMode: 'bounded',
        cwd: '/tmp/workspace',
      },
      messages: [
        {
          role: 'user',
          content: '恢复',
        },
      ],
      runtime: {
        graphCheckpoint: checkpoint.toJSON(),
      },
      hooks: {
        onRuntimeLog(event) {
          runtimeEvents.push(event)
        },
      },
      logContext: {
        sessionId: 'session-restore',
        taskId: 'task-run-agent-restore',
        assistantMessageId: 'assistant-restore',
      },
    }),
    error => error?.code === 'MISSING_API_KEY' && error?.graphState === AgentGraphState.RECOVER,
  )

  const pathEvent = runtimeEvents.find(event => event.event === 'agent.path.selected')
  assert.equal(pathEvent.details.pathMode, 'long')
  assert.ok(runtimeEvents.some(event => event.event === 'agent.checkpoint.restored'))
  assert.ok(runtimeEvents.some(event => event.event === 'agent.plan.restored'))
})
