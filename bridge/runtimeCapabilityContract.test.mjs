import test from 'node:test'
import assert from 'node:assert/strict'
import { evaluateRuntimeCapabilityContract } from './runtimeCapabilityContract.mjs'

test('runtime capability contract no longer steers tool retries from natural-language drafts', () => {
  const result = evaluateRuntimeCapabilityContract({
    routeState: {
      needsExternalFacts: true,
    },
    selectedTools: [{ name: 'web_search' }],
    toolEvents: [],
    message: '我当前的工具仅限于本地代码和文件操作，无法访问实时新闻或财经数据。',
  })

  assert.equal(result, null)
})

test('runtime capability contract flags tools outside the current capability tier', () => {
  const result = evaluateRuntimeCapabilityContract({
    routeState: {
      capabilityTier: 'local-readonly',
    },
    selectedTools: [
      { name: 'read_file' },
      { name: 'exec_command', approvalCategory: 'shell' },
    ],
  })

  assert.match(result.note, /exec_command:execute/)
  assert.equal(result.violations[0].name, 'exec_command')
})
