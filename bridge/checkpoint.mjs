import { stringifyOutput } from './utils.mjs'

export const CheckpointState = {
  ACTIVE: 'active',
  COMMITTED: 'committed',
  ROLLED_BACK: 'rolled_back',
}

export class ExecutionCheckpoint {
  constructor({
    taskId,
    stepId,
    state,
    contextSnapshot,
    metadata = {},
  }) {
    this.id = `checkpoint-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    this.taskId = taskId
    this.stepId = stepId
    this.state = state || CheckpointState.ACTIVE
    this.contextSnapshot = this.serializeSnapshot(contextSnapshot)
    this.metadata = metadata
    this.createdAt = Date.now()
    this.committedAt = null
    this.rolledBackAt = null
  }

  serializeSnapshot(snapshot) {
    if (!snapshot) return {}

    const serialized = {}
    for (const [key, value] of Object.entries(snapshot)) {
      try {
        if (value instanceof Map) {
          serialized[key] = Array.from(value.entries())
        } else if (typeof value === 'object' && value !== null) {
          serialized[key] = JSON.parse(JSON.stringify(value))
        } else {
          serialized[key] = value
        }
      } catch {
        serialized[key] = String(value)
      }
    }
    return serialized
  }

  deserializeSnapshot() {
    const deserialized = {}
    for (const [key, value] of Object.entries(this.contextSnapshot)) {
      if (Array.isArray(value) && value.every(v => Array.isArray(v) && v.length === 2)) {
        deserialized[key] = new Map(value)
      } else {
        deserialized[key] = value
      }
    }
    return deserialized
  }

  commit() {
    this.state = CheckpointState.COMMITTED
    this.committedAt = Date.now()
  }

  rollback() {
    this.state = CheckpointState.ROLLED_BACK
    this.rolledBackAt = Date.now()
  }

  isActive() {
    return this.state === CheckpointState.ACTIVE
  }

  toJSON() {
    return {
      id: this.id,
      taskId: this.taskId,
      stepId: this.stepId,
      state: this.state,
      contextSnapshot: this.contextSnapshot,
      metadata: this.metadata,
      createdAt: this.createdAt,
      committedAt: this.committedAt,
      rolledBackAt: this.rolledBackAt,
    }
  }

  static fromJSON(json) {
    const checkpoint = new ExecutionCheckpoint({
      taskId: json.taskId,
      stepId: json.stepId,
      state: json.state,
      contextSnapshot: json.contextSnapshot,
      metadata: json.metadata,
    })
    checkpoint.id = json.id
    checkpoint.createdAt = json.createdAt
    checkpoint.committedAt = json.committedAt
    checkpoint.rolledBackAt = json.rolledBackAt
    return checkpoint
  }
}

export class CheckpointManager {
  constructor(options = {}) {
    this.checkpoints = new Map()
    this.maxCheckpoints = options.maxCheckpoints || 10
    this.storage = options.storage || null
    this.hooks = options.hooks || {}
  }

  createCheckpoint(taskId, stepId, contextSnapshot, metadata = {}) {
    const checkpoint = new ExecutionCheckpoint({
      taskId,
      stepId,
      contextSnapshot,
      metadata,
    })

    this.checkpoints.set(checkpoint.id, checkpoint)

    if (this.hooks.onCheckpointCreated) {
      this.hooks.onCheckpointCreated(checkpoint)
    }

    this.enforceMaxCheckpoints()

    return checkpoint
  }

  enforceMaxCheckpoints() {
    if (this.checkpoints.size <= this.maxCheckpoints) return

    const sorted = [...this.checkpoints.values()].sort(
      (a, b) => b.createdAt - a.createdAt
    )

    const toRemove = sorted.slice(this.maxCheckpoints)
    for (const checkpoint of toRemove) {
      this.checkpoints.delete(checkpoint.id)
    }
  }

  getCheckpoint(checkpointId) {
    return this.checkpoints.get(checkpointId) || null
  }

  getLatestCheckpointForTask(taskId) {
    const taskCheckpoints = [...this.checkpoints.values()]
      .filter(cp => cp.taskId === taskId)
      .sort((a, b) => b.createdAt - a.createdAt)

    return taskCheckpoints[0] || null
  }

  getCheckpointsForTask(taskId) {
    return [...this.checkpoints.values()]
      .filter(cp => cp.taskId === taskId)
      .sort((a, b) => a.createdAt - b.createdAt)
  }

  commitCheckpoint(checkpointId) {
    const checkpoint = this.checkpoints.get(checkpointId)
    if (!checkpoint) return false

    checkpoint.commit()

    if (this.storage?.persist) {
      this.storage.persist(checkpoint.toJSON())
    }

    if (this.hooks.onCheckpointCommitted) {
      this.hooks.onCheckpointCommitted(checkpoint)
    }

    return true
  }

  rollbackCheckpoint(checkpointId) {
    const checkpoint = this.checkpoints.get(checkpointId)
    if (!checkpoint) return false

    checkpoint.rollback()

    if (this.hooks.onCheckpointRolledBack) {
      this.hooks.onCheckpointRolledBack(checkpoint)
    }

    return true
  }

  deleteCheckpoint(checkpointId) {
    const checkpoint = this.checkpoints.get(checkpointId)
    if (!checkpoint) return false
    this.checkpoints.delete(checkpointId)
    return true
  }

  clearAllCheckpoints() {
    this.checkpoints.clear()
  }

  getActiveCheckpoints() {
    return [...this.checkpoints.values()].filter(cp => cp.isActive())
  }

  createSnapshot(context) {
    return {
      messages: context.messages ? [...context.messages] : [],
      toolEvents: context.toolEvents ? [...context.toolEvents] : [],
      routeState: context.routeState ? { ...context.routeState } : null,
      workMemories: context.workMemories ? [...context.workMemories] : [],
      autoToolEvidence: context.autoToolEvidence ? [...context.autoToolEvidence] : [],
      artifactStore: context.artifactStore ? { ...context.artifactStore } : null,
      checkpointHints: context.checkpointHints ? [...context.checkpointHints] : [],
      taskTree: context.taskTree ? context.taskTree : null,
      runtime: context.runtime ? { ...context.runtime } : null,
      timestamp: Date.now(),
    }
  }

  async saveToStorage(checkpointId) {
    const checkpoint = this.checkpoints.get(checkpointId)
    if (!checkpoint) return false

    if (this.storage?.persist) {
      await this.storage.persist(checkpoint.toJSON())
    }

    return true
  }

  async loadFromStorage(taskId) {
    if (!this.storage?.load) return null

    const data = await this.storage.load(taskId)
    if (!data) return null

    return ExecutionCheckpoint.fromJSON(data)
  }

  toJSON() {
    return {
      checkpoints: [...this.checkpoints.values()].map(cp => cp.toJSON()),
      maxCheckpoints: this.maxCheckpoints,
    }
  }
}

export function createCheckpointManager(options = {}) {
  return new CheckpointManager(options)
}

export function buildCheckpointContext(checkpoint) {
  if (!checkpoint) return null

  return {
    taskId: checkpoint.taskId,
    stepId: checkpoint.stepId,
    context: checkpoint.deserializeSnapshot(),
    metadata: checkpoint.metadata,
    createdAt: checkpoint.createdAt,
  }
}

export async function restoreFromCheckpoint(checkpoint, executorContext) {
  if (!checkpoint || !checkpoint.isActive()) {
    return { success: false, reason: 'Invalid checkpoint' }
  }

  const context = checkpoint.deserializeSnapshot()

  if (executorContext) {
    if (context.messages) executorContext.messages = context.messages
    if (context.toolEvents) executorContext.toolEvents = context.toolEvents
    if (context.routeState) executorContext.routeState = context.routeState
    if (context.workMemories) executorContext.workMemories = context.workMemories
    if (context.autoToolEvidence) executorContext.autoToolEvidence = context.autoToolEvidence
    if (context.artifactStore) executorContext.artifactStore = context.artifactStore
    if (context.checkpointHints) executorContext.checkpointHints = context.checkpointHints
  }

  return {
    success: true,
    restoredContext: context,
    checkpointId: checkpoint.id,
    taskId: checkpoint.taskId,
    stepId: checkpoint.stepId,
  }
}

export class PersistentCheckpointStorage {
  constructor(storagePath) {
    this.storagePath = storagePath
    this.cache = new Map()
  }

  async persist(checkpointData) {
    this.cache.set(checkpointData.taskId, checkpointData)

    if (this.storagePath) {
      try {
        const fs = await import('node:fs/promises')
        const path = await import('node:path')
        const checkpointsDir = path.join(this.storagePath, 'checkpoints')
        await fs.mkdir(checkpointsDir, { recursive: true })
        const filePath = path.join(checkpointsDir, `${checkpointData.taskId}.json`)
        await fs.writeFile(filePath, JSON.stringify(checkpointData, null, 2))
      } catch (error) {
        console.warn('Failed to persist checkpoint:', error)
      }
    }
  }

  async load(taskId) {
    if (this.cache.has(taskId)) {
      return this.cache.get(taskId)
    }

    if (this.storagePath) {
      try {
        const fs = await import('node:fs/promises')
        const path = await import('node:path')
        const filePath = path.join(this.storagePath, 'checkpoints', `${taskId}.json`)
        const data = await fs.readFile(filePath, 'utf-8')
        const parsed = JSON.parse(data)
        this.cache.set(taskId, parsed)
        return parsed
      } catch {
        return null
      }
    }

    return null
  }

  async loadAll() {
    if (!this.storagePath) {
      return []
    }

    try {
      const fs = await import('node:fs/promises')
      const path = await import('node:path')
      const checkpointsDir = path.join(this.storagePath, 'checkpoints')
      await fs.mkdir(checkpointsDir, { recursive: true })
      const files = await fs.readdir(checkpointsDir)
      const checkpoints = []

      for (const file of files) {
        if (file.endsWith('.json')) {
          try {
            const filePath = path.join(checkpointsDir, file)
            const data = await fs.readFile(filePath, 'utf-8')
            checkpoints.push(JSON.parse(data))
          } catch {
            // Skip invalid files
          }
        }
      }

      return checkpoints
    } catch {
      return []
    }
  }

  async delete(taskId) {
    this.cache.delete(taskId)

    if (this.storagePath) {
      try {
        const fs = await import('node:fs/promises')
        const path = await import('node:path')
        const filePath = path.join(this.storagePath, 'checkpoints', `${taskId}.json`)
        await fs.unlink(filePath)
      } catch {
        // Ignore deletion errors
      }
    }
  }
}

export function createPersistentStorage(storagePath) {
  return new PersistentCheckpointStorage(storagePath)
}
