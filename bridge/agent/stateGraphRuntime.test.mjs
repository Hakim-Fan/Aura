import test from 'node:test'
import assert from 'node:assert/strict'
import {
  AgentGraphState,
  createHybridPlan,
  runHybridStateGraph,
} from './stateGraphRuntime.mjs'
import { createHybridPlanFromModelPlan } from './plannerRuntime.mjs'
import { createGraphCheckpointRuntime } from './checkpointRuntime.mjs'

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
  assert.equal(plan.checkpointPolicy.restoreSupported, true)
  assert.match(plan.goal, /重构 agent 架构/)
})

test('createHybridPlan adds dynamic inspect and execute subtasks for workspace writes', () => {
  const plan = createHybridPlan({
    request: {
      messages: [
        {
          role: 'user',
          content: '修改 bridge/agent.mjs 并验证结果',
        },
      ],
    },
    classification: {
      risk: 'high',
      complexity: 'complex',
      requiresWrite: true,
      workspaceRelated: true,
    },
    now: () => 1_700_000_000_000,
    random: () => 0.123456,
  })

  assert.deepEqual(plan.subtasks.map(subtask => subtask.kind), [
    'classify',
    'inspect_step',
    'execute',
    'verify',
  ])
  assert.equal(plan.subtasks[1].requiredCapability, 'read-only')
  assert.equal(plan.subtasks[2].requiredCapability, 'local-write')
  assert.deepEqual(plan.subtasks[3].dependencies, [
    plan.subtasks[1].id,
    plan.subtasks[2].id,
  ])
})

test('runHybridStateGraph logs graph states, checkpoints, and merges route-first result', async () => {
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
  assert.equal(result.graphState, AgentGraphState.COMPLETED)
  assert.equal(result.graphCompletion.isComplete, true)
  assert.equal(result.graphPlan.subtasks[1].status, 'completed')
  assert.equal(result.graphPlan.subtasks[2].status, 'completed')
  assert.equal(result.graphCheckpoints.length, 2)

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
    AgentGraphState.CHECKPOINT,
    AgentGraphState.EXECUTE_STEP,
    AgentGraphState.OBSERVE,
    AgentGraphState.VERIFY,
    AgentGraphState.DECIDE_NEXT,
    AgentGraphState.FINALIZE,
    AgentGraphState.COMPLETED,
  ])
})

test('runHybridStateGraph continues into verification when first execution is unverified', async () => {
  const logger = createLogger()
  const requests = []
  const result = await runHybridStateGraph({
    request: {
      messages: [{ role: 'user', content: '修改文件并验证结果' }],
    },
    classification: {
      risk: 'high',
      complexity: 'complex',
      requiresWrite: true,
    },
    logger,
    executeRouteFirst: async request => {
      requests.push(request)
      if (requests.length === 1) {
        return {
          status: 'completed',
          message: 'patched',
          completionState: 'executed_unverified',
          toolEvents: [{ id: 'tool-1', name: 'apply_patch', status: 'success' }],
        }
      }
      return {
        status: 'completed',
        message: 'verified',
        completionState: 'executed_verified',
        toolEvents: [{ id: 'tool-2', name: 'exec_command', status: 'success' }],
      }
    },
  })

  assert.equal(requests.length, 2)
  assert.match(requests[1].messages.at(-1).content, /继续图执行|Graph continuation step/)
  assert.match(requests[1].messages.at(-1).content, /Verify the previous work|验证上一步工作/)
  assert.equal(result.status, 'completed')
  assert.equal(result.graphState, AgentGraphState.COMPLETED)
  assert.equal(result.graphCompletion.isComplete, true)
  assert.equal(result.graphExecutions.length, 2)
  assert.equal(result.graphPlan.subtasks.length, 4)
  assert.ok(result.graphPlan.subtasks.some(subtask => subtask.kind === 'verification_step'))

  const transitions = logger.events
    .filter(entry => entry.event === 'agent.graph.transition')
    .map(entry => entry.details.to)
  assert.equal(
    transitions.filter(state => state === AgentGraphState.EXECUTE_STEP).length,
    2,
  )
  assert.ok(transitions.includes(AgentGraphState.COMPLETED))
})

test('runHybridStateGraph executes dynamic planned subtasks before finalizing', async () => {
  const logger = createLogger()
  const requests = []
  const result = await runHybridStateGraph({
    request: {
      messages: [{ role: 'user', content: '修改 bridge/agent.mjs 并验证结果' }],
    },
    classification: {
      risk: 'high',
      complexity: 'complex',
      requiresWrite: true,
      workspaceRelated: true,
    },
    logger,
    executeRouteFirst: async request => {
      requests.push(request)
      return {
        status: 'completed',
        message: requests.length === 1 ? 'inspected' : 'implemented',
        completionState: 'executed_verified',
        toolEvents: [{ id: `tool-${requests.length}`, status: 'success' }],
      }
    },
  })

  assert.equal(requests.length, 2)
  assert.match(requests[0].messages.at(-1).content, /继续图执行|Graph planned subtask/)
  assert.match(requests[0].messages.at(-1).content, /do not mutate files|不要修改文件/)
  assert.match(requests[1].messages.at(-1).content, /execute_next_planned_subtask/)
  assert.equal(result.graphState, AgentGraphState.COMPLETED)
  assert.equal(result.graphExecutions.length, 2)
  assert.equal(result.graphPlan.subtasks[1].status, 'completed')
  assert.equal(result.graphPlan.subtasks[2].status, 'completed')
  assert.equal(result.graphPlan.subtasks[3].status, 'completed')
})

test('runHybridStateGraph sizes the default graph pass budget to the plan', async () => {
  const logger = createLogger()
  const request = {
    messages: [{ role: 'user', content: '处理docx文档，将每个子标题生成对应的数据实体表' }],
  }
  const initialPlan = createHybridPlanFromModelPlan({
    request,
    classification: {
      risk: 'medium',
      complexity: 'complex',
      hasAttachments: true,
    },
    modelPlan: {
      goal: '处理docx文档，将每个子标题生成对应的数据实体表',
      risk: 'medium',
      steps: [
        { id: '1', description: '读取并解析用户提供的docx文档附件' },
        { id: '2', description: '提取文档中所有子标题及其相关内容' },
        { id: '3', description: '基于子标题设计数据实体表结构' },
        { id: '4', description: '生成并输出对应的数据实体表' },
      ],
    },
    now: () => 1_700_000_000_000,
    random: () => 0.123456,
  })
  const requests = []
  const result = await runHybridStateGraph({
    request,
    classification: {
      risk: 'medium',
      complexity: 'complex',
      hasAttachments: true,
    },
    initialPlan,
    logger,
    executeRouteFirst: async stepRequest => {
      requests.push(stepRequest)
      return {
        status: 'completed',
        message: `step ${requests.length}`,
        completionState: 'executed_verified',
        toolEvents: [{ id: `tool-${requests.length}`, status: 'success' }],
      }
    },
  })

  assert.equal(requests.length, 4)
  assert.equal(result.status, 'completed')
  assert.equal(result.graphState, AgentGraphState.COMPLETED)
  assert.deepEqual(
    result.graphPlan.subtasks
      .filter(subtask => subtask.kind !== 'classify')
      .map(subtask => subtask.status),
    ['completed', 'completed', 'completed', 'completed', 'completed'],
  )
})

test('runHybridStateGraph blocks unverified execute results after graph pass limit', async () => {
  const logger = createLogger()
  let calls = 0
  const result = await runHybridStateGraph({
    request: {
      messages: [{ role: 'user', content: '修改文件并验证结果' }],
    },
    classification: {
      risk: 'high',
      complexity: 'complex',
      requiresWrite: true,
    },
    logger,
    maxGraphPasses: 1,
    executeRouteFirst: async () => {
      calls += 1
      return {
        status: 'completed',
        message: 'patched',
        completionState: 'executed_unverified',
        toolEvents: [{ id: 'tool-1', name: 'apply_patch', status: 'success' }],
      }
    },
  })

  assert.equal(calls, 1)
  assert.equal(result.status, 'blocked')
  assert.equal(result.graphState, AgentGraphState.BLOCKED)
  assert.equal(result.graphCompletion.isComplete, false)
  assert.equal(result.graphCompletion.reason, 'verification_required')
  assert.equal(result.graphPlan.subtasks[1].status, 'completed')
  assert.equal(result.graphPlan.subtasks[2].status, 'blocked')

  const transitions = logger.events
    .filter(entry => entry.event === 'agent.graph.transition')
    .map(entry => entry.details.to)
  assert.ok(transitions.includes(AgentGraphState.BLOCKED))
  assert.ok(!transitions.includes(AgentGraphState.COMPLETED))
})

test('runHybridStateGraph can run a recovery continuation after failed execution result', async () => {
  const logger = createLogger()
  let calls = 0
  const result = await runHybridStateGraph({
    request: {
      messages: [{ role: 'user', content: '修复失败的构建' }],
    },
    classification: {
      risk: 'high',
      complexity: 'complex',
      requiresWrite: true,
    },
    logger,
    executeRouteFirst: async () => {
      calls += 1
      if (calls === 1) {
        return {
          status: 'completed',
          message: 'command failed',
          completionState: 'failed_after_execution',
          toolEvents: [
            {
              id: 'tool-1',
              name: 'exec_command',
              status: 'error',
              errorInfo: { code: 'COMMAND_FAILED' },
            },
          ],
        }
      }
      return {
        status: 'completed',
        message: 'recovered and verified',
        completionState: 'executed_verified',
        toolEvents: [{ id: 'tool-2', name: 'exec_command', status: 'success' }],
      }
    },
  })

  assert.equal(calls, 2)
  assert.equal(result.graphState, AgentGraphState.COMPLETED)
  assert.equal(result.graphExecutions.length, 2)
  assert.ok(result.graphPlan.subtasks.some(subtask => subtask.kind === 'recovery_step'))
})

test('runHybridStateGraph resumes remaining planned subtasks after recovering a dynamic subtask', async () => {
  const logger = createLogger()
  const calls = []
  const result = await runHybridStateGraph({
    request: {
      messages: [{ role: 'user', content: '修改 bridge/agent.mjs 并验证结果' }],
    },
    classification: {
      risk: 'high',
      complexity: 'complex',
      requiresWrite: true,
      workspaceRelated: true,
    },
    logger,
    executeRouteFirst: async request => {
      calls.push(request)
      if (calls.length === 1) {
        return {
          status: 'completed',
          message: 'inspection command failed',
          completionState: 'failed_after_execution',
          toolEvents: [
            {
              id: 'tool-inspect-failed',
              name: 'exec_command',
              status: 'error',
              errorInfo: { code: 'COMMAND_FAILED' },
            },
          ],
        }
      }
      return {
        status: 'completed',
        message: calls.length === 2 ? 'inspection recovered' : 'implemented',
        completionState: 'executed_verified',
        toolEvents: [{ id: `tool-${calls.length}`, status: 'success' }],
      }
    },
  })

  assert.equal(calls.length, 3)
  assert.equal(result.graphState, AgentGraphState.COMPLETED)
  assert.deepEqual(
    result.graphExecutions.map(entry => entry.status),
    ['failed', 'completed', 'completed'],
  )
  assert.deepEqual(
    result.graphPlan.subtasks
      .filter(subtask => ['inspect_step', 'recovery_step', 'execute'].includes(subtask.kind))
      .map(subtask => subtask.status),
    ['completed', 'completed', 'completed'],
  )
})

test('runHybridStateGraph emits ESCALATE before blocking capability blockers', async () => {
  const logger = createLogger()
  const result = await runHybridStateGraph({
    request: {
      messages: [{ role: 'user', content: '需要更高能力' }],
    },
    classification: {
      risk: 'high',
      complexity: 'complex',
    },
    logger,
    executeRouteFirst: async () => ({
      status: 'completed',
      message: 'blocked',
      completionState: 'blocked_by_capability',
      toolEvents: [],
    }),
  })

  assert.equal(result.status, 'blocked')
  assert.equal(result.graphState, AgentGraphState.BLOCKED)
  const transitions = logger.events
    .filter(entry => entry.event === 'agent.graph.transition')
    .map(entry => entry.details.to)
  assert.ok(transitions.includes(AgentGraphState.ESCALATE))
  assert.ok(transitions.includes(AgentGraphState.BLOCKED))
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

  const recoveryCheckpoint = logger.events.find(
    entry =>
      entry.event === 'agent.checkpoint.created' &&
      entry.details.reason === 'recover_after_error',
  )
  assert.ok(recoveryCheckpoint)
})

test('runHybridStateGraph restores a graph checkpoint and resumes its active subtask', async () => {
  const checkpointLogger = createLogger()
  const plan = createHybridPlan({
    request: {
      messages: [{ role: 'user', content: '恢复之前的复杂任务' }],
    },
    classification: {
      risk: 'medium',
      complexity: 'complex',
    },
  })
  const runtime = createGraphCheckpointRuntime({
    logger: checkpointLogger,
    taskId: 'task-restore',
  })
  const checkpoint = runtime.createCheckpoint({
    state: AgentGraphState.CHECKPOINT,
    plan,
    subtask: plan.subtasks[1],
    request: {
      messages: [{ role: 'user', content: '来自 checkpoint 的原始任务' }],
      settings: {
        provider: 'openai',
        apiKey: 'redacted',
        model: 'test-model',
        cwd: '/tmp/workspace',
      },
      logContext: { taskId: 'task-restore' },
    },
    classification: {
      risk: 'medium',
      complexity: 'complex',
    },
    reason: 'before_execute_step',
  })

  const logger = createLogger()
  const requests = []
  const result = await runHybridStateGraph({
    request: {
      messages: [{ role: 'user', content: '新的恢复请求外壳' }],
      settings: {
        provider: 'openai',
        apiKey: 'live-key',
        model: 'test-model',
        cwd: '/tmp/workspace',
      },
    },
    classification: {
      risk: 'medium',
      complexity: 'complex',
    },
    logger,
    restoreCheckpoint: checkpoint.toJSON(),
    executeRouteFirst: async request => {
      requests.push(request)
      return {
        status: 'completed',
        message: 'restored',
        completionState: 'executed_verified',
        toolEvents: [{ id: 'tool-restored', status: 'success' }],
      }
    },
  })

  assert.equal(result.graphState, AgentGraphState.COMPLETED)
  assert.equal(requests[0].messages[0].content, '来自 checkpoint 的原始任务')
  assert.equal(requests[0].settings.apiKey, 'live-key')
  assert.ok(logger.events.some(entry => entry.event === 'agent.checkpoint.restored'))
  assert.ok(logger.events.some(entry => entry.event === 'agent.plan.restored'))
})
