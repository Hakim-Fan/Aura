import assert from 'node:assert/strict'
import test from 'node:test'

import { buildTextDiffPreview } from './fileVerification.mjs'

test('buildTextDiffPreview compacts very long changed lines', () => {
  const before = `<svg>${'a'.repeat(900)}</svg>`
  const after = `<svg>${'b'.repeat(900)}</svg>`
  const preview = buildTextDiffPreview(before, after)

  const changedLines = preview.lines.filter(line => line.type === 'add' || line.type === 'remove')
  assert.equal(changedLines.length, 2)
  assert.ok(changedLines.every(line => line.text.length < 430))
  assert.ok(changedLines.every(line => line.text.includes('char(s) omitted')))
})
