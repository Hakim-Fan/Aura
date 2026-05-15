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

function createExecutionSubtasks(planId, classification = {}) {
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
      title: 'Gather current external context',
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
      title: 'Inspect relevant workspace state',
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
      ? 'Apply requested workspace changes through route-first runtime'
      : 'Execute requested work through route-first runtime',
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
  const planId = createId('plan', now, random)
  const goal = deriveGoal(request.messages)
  const createdAt = now()
  const executionSubtasks = createExecutionSubtasks(planId, classification)
  const verifySubtaskId = `${planId}-subtask-${executionSubtasks.length + 2}`
  const subtasks = [
    {
      id: `${planId}-subtask-1`,
      title: 'Understand goal and execution constraints',
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
      title: 'Verify completion and merge final result',
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
    subtasks,
  }
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
} = {}) {
  if (!plan || !Array.isArray(plan.subtasks)) return null
  const insertionIndex = afterSubtaskId
    ? plan.subtasks.findIndex(subtask => subtask.id === afterSubtaskId) + 1
    : plan.subtasks.length
  const normalizedInsertionIndex =
    insertionIndex > 0 ? insertionIndex : plan.subtasks.length
  const previous = plan.subtasks[normalizedInsertionIndex - 1] || plan.subtasks.at(-1)
  const subtask = {
    id: `${plan.id}-subtask-${plan.subtasks.length + 1}`,
    title: title || 'Continue graph execution',
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
