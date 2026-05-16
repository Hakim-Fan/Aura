import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildPlanApprovalPreview,
  buildPlanRiskSummary,
  formatPlanApprovalRequest,
  requestPlanApproval,
} from './planApprovalRuntime.mjs'

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

const plan = {
  id: 'plan-test',
  goal: '修改 Agent 架构并验证运行结果',
  pathMode: 'long',
  risk: 'medium',
  estimatedSteps: 3,
  successCriteria: ['变更可运行', '日志可追踪'],
  checkpointPolicy: {
    restoreSupported: true,
  },
  subtasks: [
    {
      id: 'subtask-classify',
      title: 'Understand goal and approved plan',
      kind: 'classify',
      requiredCapability: 'read-only',
      successCriteria: ['内部分类完成'],
    },
    {
      id: 'subtask-inspect',
      title: 'Inspect current runtime',
      kind: 'inspect_step',
      requiredCapability: 'read-only',
      successCriteria: ['找到入口'],
    },
    {
      id: 'subtask-execute',
      title: 'Apply changes',
      kind: 'execute',
      requiredCapability: 'local-write',
      successCriteria: ['代码已更新'],
    },
  ],
}

test('buildPlanApprovalPreview hides internal classify subtasks', () => {
  const preview = buildPlanApprovalPreview({ plan })

  assert.equal(preview.estimatedSteps, 2)
  assert.deepEqual(
    preview.subtasks.map(subtask => subtask.id),
    ['subtask-inspect', 'subtask-execute'],
  )
})

test('formatPlanApprovalRequest builds a plan approval request with risk summary', () => {
  const request = formatPlanApprovalRequest({
    plan,
    classification: {
      risk: 'high',
      complexity: 'complex',
      requiresWrite: true,
      needsCurrentInfo: true,
    },
  })

  assert.equal(request.category, 'plan')
  assert.equal(request.toolName, 'plan_approval')
  assert.match(request.summary, /风险：high/)
  assert.match(request.input, /修改 Agent 架构/)
  assert.match(request.output, /file_write/)
  assert.match(request.output, /web/)
  assert.deepEqual(request.preview.risk.categories, [
    'file_write',
    'web',
    'high_risk_execution',
    'checkpoint_restore_supported',
  ])
})

test('buildPlanRiskSummary requires approval for write or high risk plans', () => {
  const summary = buildPlanRiskSummary({
    plan,
    classification: {
      risk: 'medium',
      requiresWrite: true,
    },
  })

  assert.equal(summary.requiresApproval, true)
  assert.ok(summary.validationPlan.some(item => item.includes('写入后必须')))
})

test('requestPlanApproval logs approval lifecycle and returns approved decisions', async () => {
  const logger = createLogger()
  let approvalRequest
  const approval = await requestPlanApproval({
    logger,
    plan,
    classification: {
      risk: 'medium',
      requiresWrite: true,
    },
    hooks: {
      async requestApproval(request) {
        approvalRequest = request
        return 'approve'
      },
    },
  })

  assert.equal(approval.approved, true)
  assert.equal(approval.decision, 'approved')
  assert.equal(approvalRequest.category, 'plan')

  const eventNames = logger.events.map(entry => entry.event)
  assert.deepEqual(eventNames, [
    'agent.plan.preview.created',
    'agent.plan.risk.summarized',
    'agent.plan.approval.requested',
    'agent.plan.approval.resolved',
  ])
  assert.equal(logger.events.at(-1).details.decision, 'approved')
})

test('requestPlanApproval returns rejected decisions without throwing', async () => {
  const logger = createLogger()
  const approval = await requestPlanApproval({
    logger,
    plan,
    classification: {
      risk: 'high',
      requiresWrite: false,
    },
    hooks: {
      async requestApproval() {
        return 'deny'
      },
    },
  })

  assert.equal(approval.approved, false)
  assert.equal(approval.decision, 'rejected')
  assert.equal(logger.events.at(-1).level, 'warn')
})
