import test from 'node:test'
import assert from 'node:assert/strict'
import { runAgent } from './agent.mjs'

test('runAgent enters default-agent directly without classifier or planning gate', async () => {
  const runtimeEvents = []

  await assert.rejects(
    () => runAgent({
      settings: {
        provider: 'openai',
        apiKey: '',
        model: 'test-model',
        agentArchitectureMode: 'default-agent',
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
        sessionId: 'session-default-agent',
        taskId: 'task-default-agent',
        assistantMessageId: 'assistant-default-agent',
      },
    }),
    error => error?.code === 'MISSING_API_KEY',
  )

  const eventNames = runtimeEvents.map(event => event.event)
  assert.ok(eventNames.includes('agent.run.started'))
  assert.ok(eventNames.includes('agent.path.selected'))
  assert.ok(eventNames.includes('agent.error.classified'))
  assert.ok(eventNames.includes('agent.run.finished'))
  assert.ok(eventNames.includes('agent.metrics.summary'))
  assert.ok(!eventNames.includes('agent.classifier.result'))
  assert.ok(!eventNames.includes('agent.planning.started'))
  assert.ok(!eventNames.includes('agent.planning.resolved'))
  assert.ok(!eventNames.includes('agent.fast_path.started'))
  assert.ok(!eventNames.includes('agent.plan.created'))

  const pathEvent = runtimeEvents.find(event => event.event === 'agent.path.selected')
  assert.equal(pathEvent.details.pathMode, 'default')
  assert.equal(pathEvent.details.architectureMode, 'default-agent')
  assert.equal(pathEvent.details.reason, 'default-agent model-directed execution')

  const metricsEvent = runtimeEvents.find(event => event.event === 'agent.metrics.summary')
  assert.equal(metricsEvent.details.status, 'failed')
  assert.equal(metricsEvent.details.pathMode, 'default')
  assert.equal(metricsEvent.details.architectureMode, 'default-agent')
})
