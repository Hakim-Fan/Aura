import { createStructuredError } from '../runtimeErrors.mjs'

export const ORCHESTRATED_AGENT_AVAILABLE = false

export async function runOrchestratedAgent(request = {}) {
  const error = createStructuredError('编排模式仍在开发中，当前版本暂未开放。', {
    source: 'system',
    category: 'unsupported',
    code: 'ORCHESTRATED_MODE_UNAVAILABLE',
    detail: 'The orchestrated agent mode has not been implemented in this build yet.',
    suggestedAction: '请先切回标准模式（route-first）继续使用当前稳定执行流。',
  })

  error.agentMode = 'orchestrated'
  error.routeDecision = undefined
  if (request?.runtime?.taskTracker && request?.runtime?.currentTaskId) {
    request.runtime.taskTracker.setStatus(
      request.runtime.currentTaskId,
      'failed',
      error.message,
    )
  }
  throw error
}
