import {
  ToolExecutionError,
  ToolResult,
  ErrorCategory,
  getRetryDelay,
  shouldRetry,
} from './toolErrors.mjs'
import {
  createSelfHealingEngine,
  SelfHealingStrategy,
  handleToolFailureWithSelfHealing,
  buildToolFailureSummary,
} from './selfHealing.mjs'

export const ExecutorState = {
  IDLE: 'idle',
  RUNNING: 'running',
  PAUSED: 'paused',
  COMPLETED: 'completed',
  FAILED: 'failed',
}

export class ExecutorContext {
  constructor({
    taskGraph,
    taskTracker,
    hooks = {},
    maxConcurrency = 3,
  }) {
    this.taskGraph = taskGraph
    this.taskTracker = taskTracker
    this.hooks = hooks
    this.maxConcurrency = maxConcurrency
    this.selfHealingEngine = createSelfHealingEngine(hooks)
    this.completedTaskIds = []
    this.runningTasks = new Map()
    this.results = new Map()
    this.state = ExecutorState.IDLE
  }

  async executeNextBatch() {
    const batch = this.taskGraph.getNextBatch(this.completedTaskIds, this.maxConcurrency)
    if (batch.length === 0) return []

    const promises = batch.map(task => this.executeTask(task))
    return Promise.all(promises)
  }

  async executeTask(taskNode) {
    try {
      this.state = ExecutorState.RUNNING
      taskNode.status = 'running'
      taskNode.startedAt = Date.now()

      this.hooks?.onPhaseChange?.('task_running')
      this.taskTracker?.setStatus?.(taskNode.id, 'running')

      let result
      if (taskNode.toolName) {
        result = await this.executeToolTask(taskNode)
      } else {
        result = await this.executeSubagentTask(taskNode)
      }

      taskNode.status = 'completed'
      taskNode.completedAt = Date.now()
      taskNode.result = result
      this.completedTaskIds.push(taskNode.id)
      this.results.set(taskNode.id, result)

      this.taskTracker?.completeTask?.(taskNode.id, result?.summary || 'Task completed')

      return result
    } catch (error) {
      return await this.handleTaskFailure(taskNode, error)
    }
  }

  async executeToolTask(taskNode) {
    const tool = this.hooks?.toolRegistry?.get?.(taskNode.toolName)
    if (!tool) {
      throw new ToolExecutionError({
        toolName: taskNode.toolName,
        category: ErrorCategory.NOT_FOUND,
        severity: 'permanent',
        detail: `Tool ${taskNode.toolName} not found in registry`,
        retryable: false,
      })
    }

    let args = taskNode.args
    if (typeof args === 'string') {
      try {
        args = JSON.parse(args)
      } catch {
        args = {}
      }
    }

    let lastError
    const maxAttempts = typeof taskNode.maxRetries === 'number' && taskNode.maxRetries >= 0
      ? taskNode.maxRetries + 1
      : 1
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const result = await this.hooks?.invokeToolWithRetry?.(tool, args, this.hooks?.toolEvents || [], {
          ...this.hooks,
          timelineOrder: attempt,
        })

        if (result instanceof ToolResult && !result.success) {
          if (result.error instanceof ToolExecutionError && shouldRetry(result.error, attempt)) {
            lastError = result.error
            const delay = getRetryDelay(attempt, result.error.retryConfig)
            this.hooks?.onPhaseChange?.('tool_retrying')
            await new Promise(resolve => setTimeout(resolve, delay))
            this.taskTracker?.recordRetry?.(taskNode.id)
            continue
          }
          throw result.error
        }

        return {
          success: true,
          toolName: taskNode.toolName,
          output: result instanceof ToolResult ? result.output : result,
          attempt,
        }
      } catch (error) {
        if (attempt >= maxAttempts) {
          throw error
        }
        lastError = error

        if (error instanceof ToolExecutionError && !error.retryable) {
          throw error
        }

        const delay = getRetryDelay(attempt, error.retryConfig || {})
        this.hooks?.onPhaseChange?.('tool_retrying')
        await new Promise(resolve => setTimeout(resolve, delay))
        this.taskTracker?.recordRetry?.(taskNode.id)
      }
    }

    throw lastError
  }

  async executeSubagentTask(taskNode) {
    if (typeof this.hooks?.runNestedAgent === 'function') {
      const result = await this.hooks.runNestedAgent({
        taskId: taskNode.id,
        goal: taskNode.title,
        settings: this.hooks.settings,
        parentId: taskNode.parentId,
      })
      return result
    }

    return {
      success: true,
      summary: 'Subagent task completed (no nested agent available)',
    }
  }

  async handleTaskFailure(taskNode, error) {
    taskNode.status = 'failed'
    taskNode.completedAt = Date.now()
    taskNode.error = error

    this.taskTracker?.recordError?.(taskNode.id, {
      message: error.message,
      category: error.category || ErrorCategory.UNKNOWN,
      severity: error.severity || 'transient',
      toolName: taskNode.toolName,
    })

    const summary = buildToolFailureSummary(
      taskNode.toolName || taskNode.title,
      [error],
      taskNode.retryAttempts || 0
    )

    this.taskTracker?.setStatus?.(taskNode.id, 'failed', summary.recommendation)

    if (summary.recommendation === 'escalate') {
      this.state = ExecutorState.FAILED
      throw error
    }

    return {
      success: false,
      error,
      summary,
      taskId: taskNode.id,
    }
  }

  async run() {
    this.state = ExecutorState.RUNNING
    this.hooks?.onPhaseChange?.('execution_start')

    while (this.state === ExecutorState.RUNNING) {
      const batch = await this.executeNextBatch()

      if (batch.length === 0) {
        this.state = ExecutorState.COMPLETED
        break
      }

      const hasFailures = batch.some(result => !result?.success && result?.summary?.recommendation === 'escalate')
      if (hasFailures) {
        this.state = ExecutorState.FAILED
        break
      }

      const allDone = this.taskGraph.isComplete(this.completedTaskIds)
      if (allDone) {
        this.state = ExecutorState.COMPLETED
        break
      }
    }

    this.hooks?.onPhaseChange?.('execution_complete')
    return this.getExecutionSummary()
  }

  pause() {
    this.state = ExecutorState.PAUSED
  }

  resume() {
    if (this.state === ExecutorState.PAUSED) {
      this.state = ExecutorState.RUNNING
    }
  }

  getExecutionSummary() {
    const allNodes = [...this.taskGraph.nodes.values()]
    return {
      state: this.state,
      totalTasks: allNodes.length,
      completedTasks: this.completedTaskIds.length,
      failedTasks: allNodes.filter(n => n.status === 'failed').length,
      results: this.results,
    }
  }

  getTaskResult(taskId) {
    return this.results.get(taskId)
  }

  isComplete() {
    return this.state === ExecutorState.COMPLETED
  }

  isFailed() {
    return this.state === ExecutorState.FAILED
  }
}

export function createExecutorContext(options) {
  return new ExecutorContext(options)
}

export class AsyncExecutor {
  constructor(maxConcurrency = 3) {
    this.maxConcurrency = maxConcurrency
    this.queue = []
    this.running = []
    this.completed = []
    this.failed = []
  }

  enqueue(task, tool, args, context) {
    const worker = {
      task,
      tool,
      args,
      context,
      status: 'pending',
      result: null,
      error: null,
    }
    this.queue.push(worker)
    this.schedule()
    return worker
  }

  schedule() {
    while (this.running.length < this.maxConcurrency && this.queue.length > 0) {
      const worker = this.queue.shift()
      this.running.push(worker)
      this.executeWorker(worker).finally(() => {
        this.running = this.running.filter(w => w !== worker)
        this.schedule()
      })
    }
  }

  async executeWorker(worker) {
    try {
      worker.status = 'running'
      const result = await worker.context.invokeToolWithRetry?.(
        worker.tool,
        worker.args,
        worker.context.toolEvents || [],
        worker.context.hooks
      )
      worker.result = result
      worker.status = result?.success !== false ? 'completed' : 'failed'
      this.completed.push(worker)
    } catch (error) {
      worker.error = error
      worker.status = 'failed'
      this.failed.push(worker)

      if (worker.context.handleToolFailure) {
        worker.context.handleToolFailure(worker.task, error)
      }
    }
  }

  waitForAll() {
    return new Promise((resolve) => {
      const check = () => {
        if (this.queue.length === 0 && this.running.length === 0) {
          resolve({
            completed: this.completed,
            failed: this.failed,
          })
        } else {
          setTimeout(check, 50)
        }
      }
      check()
    })
  }
}

export function createAsyncExecutor(maxConcurrency = 3) {
  return new AsyncExecutor(maxConcurrency)
}