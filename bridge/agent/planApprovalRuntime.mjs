import { compactVisibleTaskTitle } from '../taskTitles.mjs'

function safeArray(value) {
  return Array.isArray(value) ? value : []
}

function compactString(value, maxLength = 900) {
  const normalized = String(value || '').replace(/\s+/g, ' ').trim()
  if (!normalized) return ''
  return normalized.length > maxLength
    ? `${normalized.slice(0, maxLength)}...`
    : normalized
}

function unique(values = []) {
  return Array.from(new Set(values.filter(Boolean)))
}

function isUserVisiblePlanSubtask(subtask = {}) {
  return subtask?.kind !== 'classify'
}

export function buildPlanRiskSummary({ plan = {}, classification = {} } = {}) {
  const riskLevel = classification?.risk || plan?.risk || 'medium'
  const categories = []

  if (classification?.requiresWrite) {
    categories.push('file_write')
  }
  if (classification?.needsCurrentInfo) {
    categories.push('web')
  }
  if (classification?.hasAttachments) {
    categories.push('attachment_read')
  }
  if (riskLevel === 'high') {
    categories.push('high_risk_execution')
  }
  if (plan?.checkpointPolicy?.restoreSupported) {
    categories.push('checkpoint_restore_supported')
  }

  const verification = unique([
    classification?.requiresWrite ? '写入后必须通过读回、测试或构建结果验证' : '',
    '最终完成判断必须经过 completion gate',
    '无法验证时必须返回明确 blocker，不得宣称完成',
  ])

  return {
    riskLevel,
    complexity: classification?.complexity || plan?.complexity,
    categories: unique(categories),
    requiresApproval: riskLevel === 'high' || classification?.requiresWrite === true,
    validationPlan: verification,
    checkpointPolicy: plan?.checkpointPolicy,
  }
}

export function buildPlanApprovalPreview({ plan = {}, classification = {} } = {}) {
  const risk = buildPlanRiskSummary({ plan, classification })
  const subtasks = safeArray(plan.subtasks)
    .filter(isUserVisiblePlanSubtask)
    .map(subtask => ({
      id: subtask.id,
      title: compactVisibleTaskTitle(subtask.title, subtask.id),
      kind: subtask.kind,
      requiredCapability: subtask.requiredCapability,
      successCriteria: safeArray(subtask.successCriteria).slice(0, 4),
    }))

  return {
    planId: plan.id,
    goal: plan.goal,
    pathMode: plan.pathMode || 'long',
    risk,
    estimatedSteps: subtasks.length,
    successCriteria: safeArray(plan.successCriteria),
    subtasks,
  }
}

export function formatPlanApprovalRequest({ plan = {}, classification = {} } = {}) {
  const preview = buildPlanApprovalPreview({ plan, classification })
  const risk = preview.risk
  const summaryParts = [
    `计划：${compactString(preview.goal, 120) || preview.planId || '复杂任务执行计划'}`,
    `风险：${risk.riskLevel}`,
    `步骤：${preview.estimatedSteps}`,
  ]

  return {
    id: `${preview.planId || 'plan'}-approval`,
    category: 'plan',
    toolName: 'plan_approval',
    summary: summaryParts.join(' · '),
    input: JSON.stringify({
      planId: preview.planId,
      goal: preview.goal,
      pathMode: preview.pathMode,
      estimatedSteps: preview.estimatedSteps,
      subtasks: preview.subtasks.map(subtask => ({
        title: subtask.title,
        kind: subtask.kind,
        requiredCapability: subtask.requiredCapability,
      })),
    }, null, 2),
    output: JSON.stringify({
      risk,
      successCriteria: preview.successCriteria,
      validationPlan: risk.validationPlan,
    }, null, 2),
    preview,
  }
}

export async function requestPlanApproval({
  hooks = {},
  logger,
  plan,
  classification,
} = {}) {
  if (typeof hooks.requestApproval !== 'function') {
    return {
      decision: 'skipped',
      approved: true,
      reason: 'approval_channel_unavailable',
    }
  }

  const request = formatPlanApprovalRequest({ plan, classification })
  logger?.emit?.('agent.plan.preview.created', {
    planId: plan?.id,
    goal: compactString(plan?.goal, 400),
    estimatedSteps: request.preview.estimatedSteps,
    riskLevel: request.preview.risk.riskLevel,
    riskCategories: request.preview.risk.categories,
  })
  logger?.emit?.('agent.plan.risk.summarized', {
    planId: plan?.id,
    riskLevel: request.preview.risk.riskLevel,
    riskCategories: request.preview.risk.categories,
    validationPlan: request.preview.risk.validationPlan,
  })
  logger?.emit?.('agent.plan.approval.requested', {
    planId: plan?.id,
    riskLevel: request.preview.risk.riskLevel,
    estimatedSteps: request.preview.estimatedSteps,
  })

  const decision = await hooks.requestApproval(request)
  const approved = decision === 'approve'
  logger?.emit?.(
    'agent.plan.approval.resolved',
    {
      planId: plan?.id,
      decision: approved ? 'approved' : 'rejected',
      riskLevel: request.preview.risk.riskLevel,
    },
    { level: approved ? 'info' : 'warn' },
  )

  return {
    approved,
    decision: approved ? 'approved' : 'rejected',
    request,
    reason: approved ? 'user_approved_plan' : 'user_rejected_plan',
  }
}

export function buildRejectedPlanResult({ plan, approval } = {}) {
  return {
    status: 'cancelled',
    message: '已取消执行计划，未进行写入或工具调用。',
    toolEvents: [],
    taskTree: [],
    reasoning: [],
    completionState: 'blocked_by_approval',
    evidenceSummary: {
      state: 'blocked_by_approval',
      issues: ['user_rejected_plan'],
      evidence: [],
    },
    routeDecision: {
      stopReason: 'user_cancelled',
      completionPolicy: {
        requiresEvidenceForDone: true,
      },
    },
    graphState: 'BLOCKED',
    graphCompletion: {
      reason: 'user_cancelled',
      nextAction: 'stop',
    },
    planApproval: {
      decision: approval?.decision || 'rejected',
      planId: plan?.id,
      reason: approval?.reason || 'user_rejected_plan',
    },
  }
}
