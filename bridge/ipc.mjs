import readline from 'node:readline'
import { runAgent } from './agent.mjs'

function emit(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`)
}

let pendingApprovalResolve = null
let started = false

const rl = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
})

rl.on('line', line => {
  let message
  try {
    message = JSON.parse(line)
  } catch (error) {
    emit({
      type: 'failed',
      message: `Invalid IPC message: ${error instanceof Error ? error.message : String(error)}`,
    })
    return
  }

  if (message.type === 'approval') {
    if (pendingApprovalResolve) {
      pendingApprovalResolve(message.decision === 'approve' ? 'approve' : 'deny')
      pendingApprovalResolve = null
    }
    return
  }

  if (message.type !== 'start' || started) {
    return
  }

  started = true
  emit({ type: 'started' })

  const hooks = {
    onTextDelta(delta) {
      emit({ type: 'text_delta', delta })
    },
    onReasoningDelta(delta, meta = {}) {
      emit({
        type: 'reasoning_delta',
        delta,
        blockId: meta.blockId,
        kind: meta.kind,
      })
    },
    onUsage(usage) {
      emit({ type: 'usage', usage })
    },
    onToolEvent(event) {
      emit({ type: 'tool_event', event })
    },
    onTaskTree(tree) {
      emit({ type: 'task_tree', tree })
    },
    requestApproval(request) {
      emit({ type: 'approval_required', request })
      return new Promise(resolve => {
        pendingApprovalResolve = resolve
      })
    },
  }

  runAgent({
    ...message.payload,
    hooks,
  })
    .then(result => {
      emit({
        type: 'completed',
        result,
      })
    })
    .catch(error => {
      emit({
        type: 'failed',
        message: error instanceof Error ? error.message : String(error),
      })
      process.exitCode = 1
    })
})
