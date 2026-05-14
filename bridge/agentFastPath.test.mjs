import test from 'node:test'
import assert from 'node:assert/strict'
import { runAgent } from './agent.mjs'

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
