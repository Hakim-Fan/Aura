import test from 'node:test'
import assert from 'node:assert/strict'
import {
  AgentGraphState,
  createHybridPlan,
  runHybridStateGraph,
} from './stateGraphRuntime.mjs'
import { createHybridPlanFromModelPlan, planToTaskTree } from './plannerRuntime.mjs'
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
  assert.equal(plan.subtasks.length, 2)
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
  ])
  assert.equal(plan.subtasks[1].requiredCapability, 'read-only')
  assert.equal(plan.subtasks[2].requiredCapability, 'local-write')
  assert.deepEqual(plan.subtasks[2].dependencies, [plan.subtasks[1].id])
})

test('runHybridStateGraph logs graph states, checkpoints, and merges default-agent result', async () => {
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
    executeDefaultAgent: async () => ({
      status: 'completed',
      message: 'done',
      completionState: 'executed_verified',
      toolEvents: [{ id: 'tool-1', name: 'exec_command', status: 'success' }],
    }),
  })

  assert.equal(result.pathMode, 'long')
  assert.equal(result.graphState, AgentGraphState.COMPLETED)
  assert.equal(result.graphCompletion.isComplete, true)
  assert.equal(result.graphPlan.subtasks[1].status, 'completed')
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

test('runHybridStateGraph keeps delegated default-agent task trees from replacing the plan tree', async () => {
  const logger = createLogger()
  const taskTrees = []
  const result = await runHybridStateGraph({
    request: {
      messages: [{ role: 'user', content: '根据附件生成数据实体表' }],
      hooks: {
        onTaskTree(tree) {
          taskTrees.push(tree)
        },
      },
    },
    classification: {
      risk: 'medium',
      complexity: 'complex',
      requiresWrite: false,
    },
    logger,
    executeDefaultAgent: async request => {
      request.hooks.onTaskTree([
        {
          id: 'inner-default-agent-main',
          title: '内部 default-agent 执行树',
          summary: '',
          kind: 'main',
          status: 'running',
          children: [],
        },
      ])
      return {
        status: 'completed',
        message: 'done',
        completionState: 'executed_verified',
        toolEvents: [{ id: 'tool-1', name: 'exec_command', status: 'success' }],
      }
    },
  })

  assert.equal(result.status, 'completed')
  assert.ok(taskTrees.length > 0)
  assert.ok(taskTrees.every(tree => tree[0]?.kind === 'plan'))
  assert.ok(!taskTrees.some(tree => tree[0]?.id === 'inner-default-agent-main'))
})

test('runHybridStateGraph continues into verification when first execution is unverified', async () => {
  const logger = createLogger()
  const requests = []
  const executionStepIds = []
  const taskTrees = []
  const result = await runHybridStateGraph({
    request: {
      messages: [{ role: 'user', content: '修改文件并验证结果' }],
      hooks: {
        onTaskTree(tree) {
          taskTrees.push(tree)
        },
      },
    },
    classification: {
      risk: 'high',
      complexity: 'complex',
      requiresWrite: true,
    },
    logger,
    executeDefaultAgent: async request => {
      requests.push(request)
      executionStepIds.push(request.runtime.executionStepIds.next('reasoning', 'probe'))
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
  assert.match(requests[1].messages.at(-1).content, /继续图执行|继续执行|Graph continuation step/)
  assert.match(requests[1].messages.at(-1).content, /验收标准|补足证据/)
  assert.equal(result.status, 'completed')
  assert.equal(result.graphState, AgentGraphState.COMPLETED)
  assert.equal(result.graphCompletion.isComplete, true)
  assert.equal(result.graphExecutions.length, 2)
  assert.deepEqual(
    result.toolEvents.map(event => event.id),
    ['tool-1', 'tool-2'],
  )
  assert.equal(result.graphPlan.subtasks.length, 2)
  assert.equal(result.graphPlan.subtasks.filter(subtask => subtask.kind === 'verification_step').length, 0)
  assert.ok(!taskTrees.some(tree => tree[0]?.children?.some(node => node.kind === 'verification_step')))
  assert.notEqual(executionStepIds[0], executionStepIds[1])

  const transitions = logger.events
    .filter(entry => entry.event === 'agent.graph.transition')
    .map(entry => entry.details.to)
  assert.equal(
    transitions.filter(state => state === AgentGraphState.EXECUTE_STEP).length,
    2,
  )
  assert.ok(transitions.includes(AgentGraphState.COMPLETED))
})

test('runHybridStateGraph does not chain internal verification subtasks', async () => {
  const logger = createLogger()
  let calls = 0
  const result = await runHybridStateGraph({
    request: {
      messages: [{ role: 'user', content: '读取文件并总结' }],
    },
    classification: {
      risk: 'medium',
      complexity: 'complex',
    },
    logger,
    executeDefaultAgent: async () => {
      calls += 1
      return {
        status: 'completed',
        message: calls === 1 ? 'read file' : 'checked output',
        completionState: calls === 1 ? 'executed_unverified' : 'executed_verified',
        toolEvents: [{ id: `tool-${calls}`, name: 'exec_command', status: 'success' }],
      }
    },
  })

  assert.equal(calls, 2)
  assert.equal(result.status, 'completed')
  assert.equal(result.completionState, 'executed_verified')
  assert.equal(
    result.graphPlan.subtasks.filter(subtask => subtask.kind === 'verification_step').length,
    0,
  )
  assert.ok(!logger.events.some(entry => entry.event === 'agent.graph.verification.accepted'))
})

test('planToTaskTree merges consecutive internal verification steps into one visible status', () => {
  const plan = {
    id: 'plan-test',
    goal: '测试连续验证展示',
    locale: 'zh-CN',
    subtasks: [
      {
        id: 'plan-test-subtask-1',
        kind: 'execute',
        title: '执行一步',
        status: 'completed',
        successCriteria: [],
      },
      {
        id: 'plan-test-subtask-2',
        kind: 'verification_step',
        title: 'internal verification',
        status: 'completed',
        metadata: { internal: true, hiddenFromTaskTree: true },
      },
      {
        id: 'plan-test-subtask-3',
        kind: 'verification_step',
        title: 'internal verification again',
        status: 'running',
        metadata: { internal: true, hiddenFromTaskTree: true },
      },
      {
        id: 'plan-test-subtask-4',
        kind: 'execute',
        title: '继续下一步',
        status: 'pending',
        successCriteria: [],
      },
    ],
  }

  const tree = planToTaskTree(plan)
  const children = tree[0]?.children || []
  assert.equal(children.length, 3)
  assert.equal(children[1].kind, 'verification_step')
  assert.equal(children[1].status, 'running')
  assert.equal(children[1].title, '确认上一步执行结果')
  assert.equal(children[1].summary, '确认上一步已经产生有效结果；如果发现问题，会先修复再继续后续步骤。')
})

test('runHybridStateGraph expands pass budget for hidden verification steps', async () => {
  const logger = createLogger()
  const taskTrees = []
  let calls = 0
  const initialPlan = createHybridPlanFromModelPlan({
    modelPlan: {
      goal: '完成四个顺序步骤',
      steps: [
        { description: '步骤一' },
        { description: '步骤二' },
        { description: '步骤三' },
        { description: '步骤四' },
      ],
    },
    request: {
      messages: [{ role: 'user', content: '完成四个顺序步骤' }],
    },
    classification: {
      risk: 'medium',
      complexity: 'complex',
    },
  })

  const result = await runHybridStateGraph({
    request: {
      messages: [{ role: 'user', content: '完成四个顺序步骤' }],
      hooks: {
        onTaskTree(tree) {
          taskTrees.push(tree)
        },
      },
    },
    classification: {
      risk: 'medium',
      complexity: 'complex',
    },
    initialPlan,
    logger,
    executeDefaultAgent: async () => {
      calls += 1
      return {
        status: 'completed',
        message: `step ${calls}`,
        completionState: calls % 2 === 0 ? 'executed_verified' : 'executed_unverified',
        toolEvents: [{ id: `tool-${calls}`, name: 'run_shell', status: 'success' }],
      }
    },
  })

  assert.equal(calls, 8)
  assert.equal(result.status, 'completed')
  assert.equal(result.completionState, 'executed_verified')
  assert.equal(
    result.graphPlan.subtasks.filter(subtask => subtask.kind === 'verification_step').length,
    0,
  )
  const visibleExecuteNodes = taskTrees.at(-1)?.[0]?.children?.filter(node => node.kind === 'execute') || []
  assert.equal(visibleExecuteNodes.length, 4)
  assert.ok(visibleExecuteNodes.every(node => node.status === 'completed'))
  assert.ok(
    taskTrees.every(tree => {
      const children = tree[0]?.children || []
      const hasPendingExecute = children.some(node => node.kind === 'execute' && node.status !== 'completed')
      const verifyNode = children.find(node => node.kind === 'verify')
      return !hasPendingExecute || verifyNode?.status !== 'running'
    }),
  )
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
    executeDefaultAgent: async request => {
      requests.push(request)
      const toolName = requests.length === 1 ? 'read_file' : 'apply_patch'
      return {
        status: 'completed',
        message: requests.length === 1 ? 'inspected' : 'implemented',
        completionState: 'executed_verified',
        toolEvents: [{ id: `tool-${requests.length}`, name: toolName, status: 'success' }],
      }
    },
  })

  assert.equal(requests.length, 2)
  assert.deepEqual(requests[0].hooks.activePlanStep, {
    planId: result.graphPlan.id,
    subtaskId: result.graphPlan.subtasks[1].id,
    subtaskTitle: result.graphPlan.subtasks[1].title,
  })
  assert.deepEqual(requests[1].hooks.activePlanStep, {
    planId: result.graphPlan.id,
    subtaskId: result.graphPlan.subtasks[2].id,
    subtaskTitle: result.graphPlan.subtasks[2].title,
  })
  assert.match(requests[0].messages.at(-1).content, /继续图执行|继续执行|Graph planned subtask/)
  assert.match(requests[0].messages.at(-1).content, /do not mutate files|不要修改文件/)
  assert.match(requests[1].messages.at(-1).content, /execute_next_planned_subtask/)
  assert.equal(result.graphState, AgentGraphState.COMPLETED)
  assert.equal(result.graphExecutions.length, 2)
  assert.deepEqual(
    result.toolEvents.map(event => event.id),
    ['tool-1', 'tool-2'],
  )
  assert.equal(result.graphPlan.subtasks[1].status, 'completed')
  assert.equal(result.graphPlan.subtasks[2].status, 'completed')
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
    executeDefaultAgent: async stepRequest => {
      requests.push(stepRequest)
      return {
        status: 'completed',
        message: `step ${requests.length}`,
        completionState: 'executed_verified',
        toolEvents: [{ id: `tool-${requests.length}`, name: 'exec_command', status: 'success' }],
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
    ['completed', 'completed', 'completed', 'completed'],
  )
})

test('runHybridStateGraph keeps execute steps open when only skill-read evidence is present', async () => {
  const logger = createLogger()
  const request = {
    messages: [{ role: 'user', content: '使用 docx skill 解析附件并生成实体表' }],
  }
  const initialPlan = createHybridPlanFromModelPlan({
    request,
    classification: {
      risk: 'medium',
      complexity: 'complex',
      hasAttachments: true,
    },
    modelPlan: {
      goal: '使用 docx skill 解析附件并生成实体表',
      risk: 'medium',
      steps: [
        {
          id: '1',
          description: '读取 docx skill 的使用说明',
          kind: 'context',
          acceptance: '已经了解 docx 解析方法',
          requiredEvidence: ['skill_read'],
        },
        {
          id: '2',
          description: '解析附件并生成实体表',
          kind: 'execute',
          acceptance: '已经解析附件并输出结构化实体表',
          requiredEvidence: ['file_parsed', 'structured_output'],
        },
      ],
    },
  })
  let calls = 0
  const result = await runHybridStateGraph({
    request,
    classification: {
      risk: 'medium',
      complexity: 'complex',
      hasAttachments: true,
    },
    initialPlan,
    logger,
    maxGraphPasses: 2,
    executeDefaultAgent: async () => {
      calls += 1
      return {
        status: 'completed',
        message: calls === 1 ? '已读取 docx skill' : '可以使用 Python 解析 docx',
        completionState: 'executed_verified',
        toolEvents: [{ id: `tool-${calls}`, name: 'aura_read_skill', status: 'success' }],
      }
    },
  })

  assert.equal(result.status, 'blocked')
  assert.equal(result.graphCompletion.reason, 'step_acceptance_missing_evidence')
  const executeStep = result.graphPlan.subtasks.find(subtask => subtask.title === '解析附件并生成实体表')
  assert.equal(executeStep?.status, 'blocked')
  assert.deepEqual(executeStep?.missingEvidence, ['file_parsed', 'structured_output'])
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
    executeDefaultAgent: async () => {
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
  assert.equal(result.graphPlan.subtasks[1].status, 'blocked')

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
    executeDefaultAgent: async () => {
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
    executeDefaultAgent: async request => {
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
        toolEvents: [{ id: `tool-${calls.length}`, name: 'exec_command', status: 'success' }],
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
    executeDefaultAgent: async () => ({
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
      executeDefaultAgent: async () => {
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
    executeDefaultAgent: async request => {
      requests.push(request)
      return {
        status: 'completed',
        message: 'restored',
        completionState: 'executed_verified',
        toolEvents: [{ id: 'tool-restored', name: 'exec_command', status: 'success' }],
      }
    },
  })

  assert.equal(result.graphState, AgentGraphState.COMPLETED)
  assert.equal(requests[0].messages[0].content, '来自 checkpoint 的原始任务')
  assert.equal(requests[0].settings.apiKey, 'live-key')
  assert.ok(logger.events.some(entry => entry.event === 'agent.checkpoint.restored'))
  assert.ok(logger.events.some(entry => entry.event === 'agent.plan.restored'))
})
