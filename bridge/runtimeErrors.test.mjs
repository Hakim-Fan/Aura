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

test('normalizeRuntimeError classifies stale apply_patch context as recoverable guidance', () => {
  const error = new Error(
    'Patch context did not match the current content of attachments/NewHomePageScreen.redesigned.tsx.',
  )

  const normalized = normalizeRuntimeError(error, {
    source: 'tool',
    operationLabel: 'Apply a structured patch.',
  })

  assert.equal(normalized.errorInfo.category, 'patch_context_mismatch')
  assert.match(normalized.message, /补丁上下文和当前文件内容不一致/)
  assert.match(normalized.errorInfo.suggestedAction, /read_file/)
  assert.match(normalized.errorInfo.suggestedAction, /apply_patch/)
})

test('normalizeRuntimeError classifies exact edit misses as text context mismatch', () => {
  const error = new Error('oldText was not found in the target file.')

  const normalized = normalizeRuntimeError(error, {
    source: 'tool',
    operationLabel: 'Edit a file by replacing an exact text block.',
  })

  assert.equal(normalized.errorInfo.category, 'text_context_mismatch')
  assert.match(normalized.message, /精确文本或行号范围和当前文件内容不一致/)
  assert.match(normalized.errorInfo.suggestedAction, /replace_line_range/)
})
