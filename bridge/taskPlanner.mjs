import {
  ToolExecutionError,
  ErrorCategory,
  ErrorSeverity,
} from './toolErrors.mjs'
import {
  SelfHealingStrategy,
  createSelfHealingEngine,
} from './selfHealing.mjs'

export const TaskState = {
  PENDING: 'pending',
  RUNNING: 'running',
  WAITING_APPROVAL: 'waiting_approval',
  CHECKPOINTED: 'checkpointed',
  FAILED: 'failed',
  COMPLETED: 'completed',
  CANCELLED: 'cancelled',
}

export const TaskKind = {
  MAIN: 'main',
  SUBAGENT: 'subagent',
  TOOL_CALL: 'tool_call',
  PLANNING: 'planning',
}

export class TaskNode {
  constructor({
    id,
    title,
    kind = TaskKind.MAIN,
    dependsOn = [],
    toolName = null,
    args = null,
    parentId = null,
  }) {
    this.id = id
    this.title = title
    this.kind = kind
    this.status = TaskState.PENDING
    this.dependsOn = Array.isArray(dependsOn) ? dependsOn : []
    this.toolName = toolName
    this.args = args
    this.parentId = parentId
    this.children = []
    this.result = null
    this.error = null
    this.retryAttempts = 0
    this.maxRetries = 2
    this.checkpoint = null
    this.createdAt = Date.now()
    this.startedAt = null
    this.completedAt = null
  }

  canExecute(completedTaskIds) {
    if (this.status !== TaskState.PENDING) return false
    return this.dependsOn.every(depId => completedTaskIds.includes(depId))
  }

  isBlockedBy(pendingTaskIds) {
    return this.dependsOn.some(depId => pendingTaskIds.includes(depId))
  }
}

export class TaskGraph {
  constructor(rootTitle = 'Root Task') {
    this.nodes = new Map()
    this.rootId = null
    this.executionOrder = []
  }

  addNode(node) {
    this.nodes.set(node.id, node)
    if (!this.rootId && node.kind === TaskKind.MAIN) {
      this.rootId = node.id
    }
  }

  addEdge(fromId, toId) {
    const toNode = this.nodes.get(toId)
    if (toNode && !toNode.dependsOn.includes(fromId)) {
      toNode.dependsOn.push(fromId)
    }
  }

  getExecutableTasks(completedTaskIds = []) {
    const pendingIds = [...this.nodes.keys()].filter(
      id => !completedTaskIds.includes(id)
    )
    return [...this.nodes.values()].filter(node =>
      node.canExecute(completedTaskIds) && pendingIds.includes(node.id)
    )
  }

  getNextBatch(completedTaskIds = [], maxConcurrency = 3) {
    const executable = this.getExecutableTasks(completedTaskIds)
    return executable.slice(0, maxConcurrency)
  }

  isComplete(completedTaskIds = []) {
    return [...this.nodes.values()].every(
      node => completedTaskIds.includes(node.id) || node.status === TaskState.FAILED
    )
  }

  getFailedTasks() {
    return [...this.nodes.values()].filter(
      node => node.status === TaskState.FAILED
    )
  }

  buildExecutionPlan() {
    const plan = []
    const visited = new Set()
    const completedTaskIds = []

    const visit = (nodeId) => {
      if (visited.has(nodeId)) return
      visited.add(nodeId)

      const node = this.nodes.get(nodeId)
      if (!node) return

      for (const depId of node.dependsOn) {
        visit(depId)
      }

      plan.push(node)
    }

    for (const [id, node] of this.nodes) {
      visit(id)
    }

    return plan
  }

  toJSON() {
    return {
      rootId: this.rootId,
      nodes: [...this.nodes.values()].map(node => ({
        id: node.id,
        title: node.title,
        kind: node.kind,
        status: node.status,
        dependsOn: node.dependsOn,
        toolName: node.toolName,
        args: node.args,
        parentId: node.parentId,
        result: node.result,
        error: node.error,
        retryAttempts: node.retryAttempts,
      })),
    }
  }

  static fromJSON(json) {
    const graph = new TaskGraph()
    graph.rootId = json.rootId
    for (const nodeData of json.nodes) {
      const node = new TaskNode(nodeData)
      graph.nodes.set(node.id, node)
    }
    return graph
  }
}

export class Planner {
  constructor(hooks = {}) {
    this.hooks = hooks
    this.selfHealingEngine = createSelfHealingEngine(hooks)
  }

  decomposeTask(goal, context = {}) {
    const subTasks = []
    const taskId = this.hooks.createExecutionStepId?.('task', 'decomposed') || `task-${Date.now()}`

    const keywords = this.extractKeywords(goal)
    const steps = this.identifySteps(keywords, context)

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i]
      subTasks.push(new TaskNode({
        id: this.hooks.createExecutionStepId?.('task', `step-${i}`) || `step-${taskId}-${i}`,
        title: step.title,
        kind: step.kind || TaskKind.SUBAGENT,
        dependsOn: i > 0 ? [subTasks[i - 1].id] : [],
        toolName: step.toolName || null,
        args: step.args || null,
      }))
    }

    return subTasks
  }

  extractKeywords(goal) {
    const normalized = goal.toLowerCase()
    const keywords = []

    const patterns = [
      { pattern: /读取?|读取文件|查看文件|open file/i, keyword: 'read_file' },
      { pattern: /写入?|写文件|create file/i, keyword: 'write_file' },
      { pattern: /编辑?|修改文件|edit file/i, keyword: 'edit_file' },
      { pattern: /搜索?|grep|search/i, keyword: 'search' },
      { pattern: /执行?|run|execute/i, keyword: 'execute' },
      { pattern: /终端?|shell|command/i, keyword: 'shell' },
      { pattern: /浏览器?|browser|web/i, keyword: 'browser' },
      { pattern: /分析?|analyze|analysis/i, keyword: 'analyze' },
      { pattern: /生成?|create|generate/i, keyword: 'create' },
    ]

    for (const { pattern, keyword } of patterns) {
      if (pattern.test(normalized)) {
        keywords.push(keyword)
      }
    }

    return keywords.length > 0 ? keywords : ['general']
  }

  identifySteps(keywords, context = {}) {
    const steps = []

    if (keywords.includes('read_file') || keywords.includes('search')) {
      steps.push({
        title: '收集信息',
        kind: TaskKind.SUBAGENT,
        toolName: 'read_file',
      })
    }

    if (keywords.includes('analyze')) {
      steps.push({
        title: '分析数据',
        kind: TaskKind.SUBAGENT,
      })
    }

    if (keywords.includes('write_file') || keywords.includes('create')) {
      steps.push({
        title: '生成输出',
        kind: TaskKind.SUBAGENT,
        toolName: 'write_file',
      })
    }

    if (keywords.includes('shell') || keywords.includes('execute')) {
      steps.push({
        title: '执行命令',
        kind: TaskKind.SUBAGENT,
        toolName: 'run_shell',
      })
    }

    if (steps.length === 0) {
      steps.push({
        title: '执行任务',
        kind: TaskKind.SUBAGENT,
      })
    }

    return steps
  }

  buildGraphFromToolCalls(toolCalls, parentId = null) {
    const graph = new TaskGraph()

    for (const toolCall of toolCalls) {
      const node = new TaskNode({
        id: toolCall.id || `tool-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        title: toolCall.function?.name || 'Unknown Tool',
        kind: TaskKind.TOOL_CALL,
        toolName: toolCall.function?.name,
        args: toolCall.function?.arguments,
        parentId,
      })
      graph.addNode(node)
    }

    return graph
  }

  analyzeFailure(taskNode, error, context = {}) {
    if (!(error instanceof ToolExecutionError)) {
      return {
        recommendation: 'rethink',
        reason: 'Unknown error type',
      }
    }

    const strategy = this.selfHealingEngine.generateRepairStrategy(
      error,
      taskNode.toolName,
      context
    )

    if (!strategy.retryable && taskNode.retryAttempts >= taskNode.maxRetries) {
      return {
        recommendation: 'decompose',
        reason: 'Task failed with non-retryable error after max retries',
        strategy,
      }
    }

    if (strategy.requiresTaskDecomposition) {
      return {
        recommendation: 'decompose',
        reason: 'Strategy suggests task decomposition',
        strategy,
      }
    }

    return {
      recommendation: strategy.strategy,
      reason: `Error category: ${error.category}`,
      strategy,
    }
  }

  shouldEscalate(taskNode, completedAttempts) {
    const maxAttempts = 3
    return completedAttempts >= maxAttempts
  }
}

export function createPlanner(hooks) {
  return new Planner(hooks)
}

export function buildTaskGraphFromGoal(goal, hooks = {}) {
  const planner = createPlanner(hooks)
  const tasks = planner.decomposeTask(goal)

  const graph = new TaskGraph()
  for (const task of tasks) {
    graph.addNode(task)
  }

  for (let i = 1; i < tasks.length; i++) {
    graph.addEdge(tasks[i - 1].id, tasks[i].id)
  }

  return graph
}