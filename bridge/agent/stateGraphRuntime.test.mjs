import test from 'node:test'
import assert from 'node:assert/strict'
import {
  AgentGraphState,
  createHybridPlan,
  runHybridStateGraph,
} from './stateGraphRuntime.mjs'

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

test('createHybridPlan builds a deterministic single-delegation plan', () => {
  const plan = createHybridPlan({
    request: {
      messages: [
        {
          role: 'user',
          content: '重构 agent 架构并保留执行能力',
        },
      ],
    },
    classification: {
      risk: 'medium',
      complexity: 'complex',
      requiresWrite: true,
    },
    now: () => 1_700_000_000_000,
    random: () => 0.123456,
  })

  assert.equal(plan.pathMode, 'long')
  assert.equal(plan.subtasks.length, 3)
  assert.equal(plan.subtasks[0].status, 'completed')
  assert.equal(plan.subtasks[1].requiredCapability, 'local-write')
  assert.match(plan.goal, /重构 agent 架构/)
})

test('runHybridStateGraph logs graph states and merges route-first result', async () => {
  const logger = createLogger()
  const result = await runHybridStateGraph({
    request: {
      messages: [{ role: 'user', content: '做一个架构迁移方案' }],
    },
    classification: {
      risk: 'medium',
      complexity: 'complex',
      requiresWrite: false,
    },
    logger,
    now: () => 1_700_000_000_000,
    random: () => 0.123456,
    executeRouteFirst: async () => ({
      status: 'completed',
      message: 'done',
      completionState: 'executed_verified',
      toolEvents: [{ id: 'tool-1' }],
    }),
  })

  assert.equal(result.pathMode, 'long')
  assert.equal(result.graphState, AgentGraphState.FINALIZE)
  assert.equal(result.graphPlan.subtasks[1].status, 'completed')
  assert.equal(result.graphPlan.subtasks[2].status, 'completed')

  const eventNames = logger.events.map(entry => entry.event)
  assert.ok(eventNames.includes('agent.plan.created'))
  assert.ok(eventNames.includes('agent.step.started'))
  assert.ok(eventNames.includes('agent.checkpoint.created'))
  assert.ok(eventNames.includes('agent.step.finished'))

  const transitions = logger.events
    .filter(entry => entry.event === 'agent.graph.transition')
    .map(entry => entry.details.to)
  assert.deepEqual(transitions, [
    AgentGraphState.CLASSIFY,
    AgentGraphState.PLAN,
    AgentGraphState.SELECT_CAPABILITY,
    AgentGraphState.EXECUTE_STEP,
    AgentGraphState.OBSERVE,
    AgentGraphState.VERIFY,
    AgentGraphState.DECIDE_NEXT,
    AgentGraphState.FINALIZE,
  ])
})

test('runHybridStateGraph logs recovery transition when delegated execution fails', async () => {
  const logger = createLogger()
  const error = new Error('failed')
  error.code = 'ROUTE_FAILED'

  await assert.rejects(
    () => runHybridStateGraph({
      request: {
        messages: [{ role: 'user', content: '做一个架构迁移方案' }],
      },
      classification: {
        risk: 'medium',
        complexity: 'complex',
      },
      logger,
      executeRouteFirst: async () => {
        throw error
      },
    }),
    caught => caught?.code === 'ROUTE_FAILED' && caught?.graphState === AgentGraphState.RECOVER,
  )

  const recoverTransition = logger.events.find(
    entry =>
      entry.event === 'agent.graph.transition' &&
      entry.details.to === AgentGraphState.RECOVER,
  )
  assert.ok(recoverTransition)
  assert.equal(recoverTransition.details.errorCode, 'ROUTE_FAILED')

  const failedStep = logger.events.find(
    entry => entry.event === 'agent.step.finished' && entry.details.status === 'failed',
  )
  assert.equal(failedStep.level, 'error')
})

