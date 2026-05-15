import test from 'node:test'
import assert from 'node:assert/strict'
import {
  ErrorCategory,
  ToolExecutionError,
  shouldRetry,
} from './toolErrors.mjs'

test('tool retry budget counts retries after the first failed attempt', () => {
  const error = new ToolExecutionError({
    toolName: 'aura_install_skill',
    category: ErrorCategory.EXECUTION_FAILED,
    detail: 'HTTP 403',
    retryable: true,
    retryConfig: {
      maxRetries: 1,
      initialDelayMs: 0,
      maxDelayMs: 0,
      backoffMultiplier: 1,
      retryStrategy: 'immediate',
    },
  })

  assert.equal(shouldRetry(error, 1), true)
  assert.equal(shouldRetry(error, 2), false)
})
