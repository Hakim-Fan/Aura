import test from 'node:test'
import assert from 'node:assert/strict'
import {
  createGraphCheckpointRuntime,
  restoreGraphCheckpoint,
} from './checkpointRuntime.mjs'

function createLogger() {
  const events = []
  return {
    events,
    emit(event, details, options = {}) {
      events.push({
        event,
        level: options.level || 'info',
        details,
      })
    },
  }
}

test('graph checkpoint runtime creates restorable graph snapshots without sensitive settings', async () => {
  const logger = createLogger()
  const runtime = createGraphCheckpointRuntime({
    logger,
    taskId: 'task-1',
  })
  const checkpoint = runtime.createCheckpoint({
    state: 'EXECUTE_STEP',
    plan: {
      id: 'plan-1',
      subtasks: [{ id: 'subtask-1', status: 'running' }],
    },
    subtask: { id: 'subtask-1' },
    request: {
      messages: [{ role: 'user', content: 'do work' }],
      settings: {
        provider: 'openai',
        model: 'test-model',
        cwd: '/tmp/workspace',
        apiKey: 'secret-key',
        agentArchitectureMode: 'default-agent',
      },
      logContext: { taskId: 'task-1' },
    },
    classification: { pathMode: 'long' },
    toolEvents: [{ id: 'tool-1', output: 'large private output' }],
    reason: 'before_execute_step',
  })

  const restored = await restoreGraphCheckpoint(checkpoint, {
    logger,
    reason: 'unit_test_restore',
  })

  assert.equal(restored.success, true)
  assert.equal(restored.graphState, 'EXECUTE_STEP')
  assert.equal(restored.graphContext.plan.id, 'plan-1')
  assert.equal(restored.graphContext.request.settings.provider, 'openai')
  assert.equal(restored.graphContext.request.settings.apiKey, undefined)
  assert.equal(restored.graphContext.toolEvents.length, 1)
  assert.equal(restored.graphContext.toolEvents[0].output, undefined)

  assert.deepEqual(logger.events.map(entry => entry.event), [
    'agent.checkpoint.created',
    'agent.checkpoint.restored',
  ])
  assert.equal(logger.events[0].details.reason, 'before_execute_step')
  assert.equal(logger.events[1].details.restoredState, 'EXECUTE_STEP')
})
