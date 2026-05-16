import {
  getRuntimeTaskLabels,
} from '../runtimeLanguage.mjs'

function createId(prefix, now = Date.now, random = Math.random) {
  return `${prefix}-${now().toString(36)}-${random().toString(36).slice(2, 8)}`
}

function latestUserText(messages = []) {
  const latest = [...(Array.isArray(messages) ? messages : [])]
    .reverse()
    .find(message => message?.role === 'user')
  return String(latest?.content || '').trim()
}

function truncateText(value, maxLength = 180) {
  const normalized = String(value || '').replace(/\s+/g, ' ').trim()
  if (!normalized) return ''
  return normalized.length > maxLength
    ? `${normalized.slice(0, maxLength)}...`
    : normalized
}

function deriveGoal(messages = []) {
  const text = latestUserText(messages)
  if (!text) return 'Complete the user request'
  return truncateText(text.split('\n').find(Boolean) || text, 180)
}

function requiredExecutionCapability(classification = {}) {
  if (classification?.requiresWrite) return 'local-write'
  if (classification?.needsCurrentInfo) return 'web-lookup'
  if (classification?.hasAttachments) return 'read-only'
  return 'auto'
}

function createExecutionSubtasks(planId, classification = {}, labels = getRuntimeTaskLabels()) {
  const subtasks = []
  const addSubtask = ({
    title,
    kind = 'execute',
    requiredCapability = 'auto',
    successCriteria = [],
    dependencies,
    metadata = {},
  }) => {
    const id = `${planId}-subtask-${subtasks.length + 2}`
    subtasks.push({
      id,
      title,
      kind,
      requiredCapability,
      successCriteria,
      dependencies: Array.isArray(dependencies) ? dependencies : [`${planId}-subtask-1`],
      status: 'pending',
      evidence: [],
      metadata,
    })
    return id
  }

  if (classification?.needsCurrentInfo) {
    addSubtask({
      title: labels.gatherCurrentContext,
      kind: 'research_step',
      requiredCapability: 'web-lookup',
      successCriteria: [
        'Collect current information required by the user request',
        'Keep retrieved evidence available for the execution step',
      ],
      metadata: {
        plannerReason: 'current_or_web_info_needed',
      },
    })
  }

  if (classification?.requiresWrite && classification?.workspaceRelated) {
    addSubtask({
      title: labels.inspectWorkspace,
      kind: 'inspect_step',
      requiredCapability: 'read-only',
      successCriteria: [
        'Identify the relevant files, existing behavior, and constraints',
        'Avoid mutating files during inspection',
      ],
      metadata: {
        plannerReason: 'workspace_write_requires_inspection',
      },
    })
  }

  const previousId = subtasks.at(-1)?.id || `${planId}-subtask-1`
  addSubtask({
    title: classification?.requiresWrite
      ? labels.applyWorkspaceChanges
      : labels.executeRequest,
    kind: 'execute',
    requiredCapability: requiredExecutionCapability(classification),
    successCriteria: [
      'Existing route-first capability selection is preserved',
      'Tool routing, provider recovery, and evidence policy remain active',
    ],
    dependencies: [previousId],
    metadata: {
      plannerReason: 'route_first_execution_core',
    },
  })

  return subtasks
}

export function createHybridPlan({
  request = {},
  classification = {},
  now = Date.now,
  random = Math.random,
} = {}) {
  const labels = getRuntimeTaskLabels(request?.settings || {})
  const locale = request?.settings?.locale || 'zh-CN'
  const planId = createId('plan', now, random)
  const goal = deriveGoal(request.messages)
  const createdAt = now()
  const executionSubtasks = createExecutionSubtasks(planId, classification, labels)
  const verifySubtaskId = `${planId}-subtask-${executionSubtasks.length + 2}`
  const subtasks = [
    {
      id: `${planId}-subtask-1`,
      title: labels.understandGoal,
      kind: 'classify',
      requiredCapability: 'read-only',
      successCriteria: [
        'Goal is available to the runtime',
        'Risk and path classification are recorded',
      ],
      dependencies: [],
      status: 'completed',
      evidence: ['classification'],
    },
    ...executionSubtasks,
    {
      id: verifySubtaskId,
      title: labels.verifyCompletion,
      kind: 'verify',
      requiredCapability: 'auto',
      successCriteria: [
        'Completion state and route decision are captured',
        'Final answer is returned with graph metadata',
      ],
      dependencies: executionSubtasks.map(subtask => subtask.id),
      status: 'pending',
      evidence: [],
    },
  ]

  return {
    id: planId,
    goal,
    pathMode: 'long',
    risk: classification?.risk || 'medium',
    complexity: classification?.complexity || 'complex',
    estimatedSteps: subtasks.length,
    createdAt,
    successCriteria: [
      'The delegated route-first runtime completes or reports a recoverable blocker',
      'The structured completion decision explains why the graph can finish or must block',
      'A checkpoint exists before delegated execution and after observation',
    ],
    checkpointPolicy: {
      createBeforeExecute: true,
      createAfterObserve: true,
      restoreSupported: true,
    },
    locale,
    subtasks,
  }
}

function normalizePlanStep(step, index) {
  if (!step || typeof step !== 'object') {
    return {
      id: String(index + 1),
      description: truncateText(step || `Step ${index + 1}`, 160),
    }
  }
  return {
    id: truncateText(step.id || step.stepId || String(index + 1), 80) || String(index + 1),
    description:
      truncateText(step.description || step.title || step.summary || `Step ${index + 1}`, 180) ||
      `Step ${index + 1}`,
    kind: truncateText(step.kind || step.type || '', 80),
    requiredCapability: truncateText(step.requiredCapability || step.capability || '', 80),
  }
}

export function createHybridPlanFromModelPlan({
  modelPlan = {},
  request = {},
  classification = {},
  now = Date.now,
  random = Math.random,
} = {}) {
  const base = createHybridPlan({ request, classification, now, random })
  const planId = base.id
  const rawSteps = Array.isArray(modelPlan.steps) ? modelPlan.steps : []
  const normalizedSteps = rawSteps.map(normalizePlanStep).filter(step => step.description)
  if (normalizedSteps.length === 0) {
    return base
  }

  const labels = getRuntimeTaskLabels(request?.settings || {})
  const classifySubtask = {
    ...base.subtasks[0],
    title: labels.understandGoal,
  }
  const executionSubtasks = normalizedSteps.map((step, index) => {
    const previousId = index === 0
      ? classifySubtask.id
      : `${planId}-subtask-${index + 1}`
    return {
      id: `${planId}-subtask-${index + 2}`,
      title: step.description,
      kind: step.kind || 'execute',
      requiredCapability:
        step.requiredCapability ||
        (classification?.requiresWrite ? 'local-write' : 'auto'),
      successCriteria: [
        'Step produces observable progress or a clear blocker',
      ],
      dependencies: [previousId],
      status: 'pending',
      evidence: [],
      metadata: {
        modelPlanStepId: step.id,
      },
    }
  })
  const verifySubtask = {
    ...base.subtasks.at(-1),
    id: `${planId}-subtask-${executionSubtasks.length + 2}`,
    dependencies: executionSubtasks.map(subtask => subtask.id),
  }

  return {
    ...base,
    goal: truncateText(modelPlan.goal || base.goal, 240),
    risk: modelPlan.risk || classification?.risk || base.risk,
    estimatedSteps: executionSubtasks.length + 2,
    successCriteria: Array.isArray(modelPlan.successCriteria) && modelPlan.successCriteria.length > 0
      ? modelPlan.successCriteria.map(entry => truncateText(entry, 180)).filter(Boolean)
      : base.successCriteria,
    notes: truncateText(modelPlan.notes || modelPlan.note || '', 600),
    plannerSource: 'model_planning_prompt',
    locale: request?.settings?.locale || base.locale || 'zh-CN',
    subtasks: [
      classifySubtask,
      ...executionSubtasks,
      verifySubtask,
    ],
  }
}

export function planToTaskTree(plan = {}) {
  const labels = getRuntimeTaskLabels(plan?.locale || 'zh-CN')
  const rawSubtasks = Array.isArray(plan.subtasks)
    ? plan.subtasks.filter(subtask => subtask?.kind !== 'classify')
    : []
  const subtasks = mergeVisibleVerificationSubtasks(rawSubtasks, labels)
  return [
    {
      id: `${plan.id || 'plan'}-task-tree-root`,
      title: plan.goal || labels.planTitle,
      summary: plan.notes || '',
      kind: 'plan',
      status: subtasks.some(subtask => subtask.status === 'failed' || subtask.status === 'blocked')
        ? 'failed'
        : subtasks.length > 0 && subtasks.every(subtask => subtask.status === 'completed')
          ? 'completed'
          : 'running',
      children: subtasks.map(subtask => ({
        id: subtask.id,
        title: subtask.title || subtask.id,
        summary: subtask.summary ||
          (Array.isArray(subtask.successCriteria) && subtask.successCriteria.length > 0
            ? subtask.successCriteria.join('\n')
            : ''),
        kind: subtask.kind || 'plan_step',
        status: subtask.status || 'pending',
        children: [],
        errors: [],
        retryAttempts: 0,
        checkpoint: null,
      })),
      errors: [],
      retryAttempts: 0,
      checkpoint: null,
    },
  ]
}

function isHiddenNonVerificationSubtask(subtask = {}) {
  return subtask?.metadata?.hiddenFromTaskTree === true && subtask?.kind !== 'verification_step'
}

function isInternalVerificationSubtask(subtask = {}) {
  return subtask?.kind === 'verification_step' && subtask?.metadata?.internal === true
}

function mergeVerificationStatus(items = []) {
  if (items.some(item => item?.status === 'failed')) return 'failed'
  if (items.some(item => item?.status === 'blocked')) return 'blocked'
  if (items.some(item => item?.status === 'running')) return 'running'
  if (items.length > 0 && items.every(item => item?.status === 'completed')) return 'completed'
  return items.find(item => item?.status)?.status || 'pending'
}

function buildVisibleVerificationSubtask(items = [], labels = getRuntimeTaskLabels()) {
  const first = items[0] || {}
  return {
    ...first,
    id: items.length > 1 ? `${first.id || 'verification'}-merged` : first.id,
    title: labels.verifyPrevious,
    summary: labels.verifyPreviousSummary,
    kind: 'verification_step',
    status: mergeVerificationStatus(items),
    successCriteria: [],
    metadata: {
      ...(first.metadata || {}),
      mergedVerificationCount: items.length,
      visibleMergedVerification: true,
    },
  }
}

function mergeVisibleVerificationSubtasks(subtasks = [], labels = getRuntimeTaskLabels()) {
  const merged = []
  let pendingVerificationGroup = []

  const flushVerificationGroup = () => {
    if (pendingVerificationGroup.length === 0) {
      return
    }
    merged.push(buildVisibleVerificationSubtask(pendingVerificationGroup, labels))
    pendingVerificationGroup = []
  }

  for (const subtask of subtasks) {
    if (isHiddenNonVerificationSubtask(subtask)) {
      continue
    }
    if (isInternalVerificationSubtask(subtask)) {
      pendingVerificationGroup.push(subtask)
      continue
    }
    flushVerificationGroup()
    merged.push(subtask)
  }

  flushVerificationGroup()
  return merged
}

export function findPlanSubtask(plan, kindOrId) {
  if (!plan || !Array.isArray(plan.subtasks)) return null
  return plan.subtasks.find(
    subtask => subtask?.id === kindOrId || subtask?.kind === kindOrId,
  ) || null
}

export function updatePlanSubtask(plan, subtaskId, patch = {}) {
  const subtask = findPlanSubtask(plan, subtaskId)
  if (!subtask) return null
  const oldStatus = subtask.status
  Object.assign(subtask, patch)
  return {
    subtask,
    oldStatus,
    newStatus: subtask.status,
  }
}

export function appendPlanSubtask(plan, {
  title,
  kind = 'execute',
  requiredCapability = 'auto',
  successCriteria = [],
  dependencies,
  afterSubtaskId,
  metadata = {},
  locale = 'zh-CN',
} = {}) {
  if (!plan || !Array.isArray(plan.subtasks)) return null
  const labels = getRuntimeTaskLabels(locale)
  const insertionIndex = afterSubtaskId
    ? plan.subtasks.findIndex(subtask => subtask.id === afterSubtaskId) + 1
    : plan.subtasks.length
  const normalizedInsertionIndex =
    insertionIndex > 0 ? insertionIndex : plan.subtasks.length
  const previous = plan.subtasks[normalizedInsertionIndex - 1] || plan.subtasks.at(-1)
  const subtask = {
    id: `${plan.id}-subtask-${plan.subtasks.length + 1}`,
    title: title || labels.continueExecution,
    kind,
    requiredCapability,
    successCriteria: Array.isArray(successCriteria) ? successCriteria : [],
    dependencies: Array.isArray(dependencies)
      ? dependencies
      : previous?.id
        ? [previous.id]
        : [],
    status: 'pending',
    evidence: [],
    metadata,
  }
  plan.subtasks.splice(normalizedInsertionIndex, 0, subtask)
  plan.estimatedSteps = plan.subtasks.length
  return subtask
}
