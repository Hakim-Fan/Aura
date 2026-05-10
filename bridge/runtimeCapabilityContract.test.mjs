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

test('runtime capability contract allows mounted shell tools for local diagnostics', () => {
  const result = evaluateRuntimeCapabilityContract({
    routeState: {
      capabilityTier: 'local-readonly',
    },
    selectedTools: [
      { name: 'read_file' },
      { name: 'exec_command', approvalCategory: 'shell' },
    ],
  })

  assert.equal(result, null)
})

test('runtime capability contract flags admin tools outside capability admin turns', () => {
  const result = evaluateRuntimeCapabilityContract({
    routeState: {
      capabilityTier: 'local-readonly',
      isCapabilityAdminTask: false,
    },
    selectedTools: [
      { name: 'read_file' },
      { name: 'aura_install_skill', approvalCategory: 'file_write' },
    ],
  })

  assert.match(result.note, /aura_install_skill:admin/)
  assert.equal(result.violations[0].name, 'aura_install_skill')
})
