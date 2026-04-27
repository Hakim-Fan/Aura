import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeRuntimeError } from './runtimeErrors.mjs'

test('normalizeRuntimeError maps ENOENT file reads to not_found instead of missing_dependency', () => {
  const error = Object.assign(
    new Error("ENOENT: no such file or directory, open '/workspace/src/App.vue'"),
    { code: 'ENOENT' },
  )

  const normalized = normalizeRuntimeError(error, {
    source: 'tool',
    operationLabel: 'Read a text file from inside the workspace.',
  })

  assert.equal(normalized.errorInfo.category, 'not_found')
  assert.match(normalized.message, /不存在/)
})

test('normalizeRuntimeError keeps spawn ENOENT classified as missing_dependency', () => {
  const error = Object.assign(new Error('spawn rg ENOENT'), {
    code: 'ENOENT',
  })

  const normalized = normalizeRuntimeError(error, {
    source: 'tool',
    operationLabel: 'Search the workspace using ripgrep.',
  })

  assert.equal(normalized.errorInfo.category, 'missing_dependency')
  assert.match(normalized.message, /缺少所需命令或依赖/)
})
