import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeWorkMemoryInput } from './workMemory.mjs'

test('oversized tool evidence memory preserves structured recentSuccesses', () => {
  const memory = normalizeWorkMemoryInput({
    kind: 'tool_evidence',
    title: 'Tool evidence checkpoint',
    summary: 'Tool evidence checkpoint: read_file succeeded.',
    content: {
      recentSuccesses: [
        {
          tool: 'read_file',
          input: {
            path: '/workspace/attachments/source.md',
            startLine: 1,
            endLine: 98,
            mode: 'raw',
          },
          file: {
            size: 22584,
            mtimeMs: 1779784390088,
            outputSha256: 'abc123',
          },
          outputPreview: 'x'.repeat(9_000),
          outputRecall: 'y'.repeat(9_000),
          recordedAt: 1779791037812,
        },
      ],
    },
  })

  assert.equal(memory.content.truncated, true)
  assert.match(memory.content.preview, /recentSuccesses/)
  assert.equal(memory.content.recentSuccesses.length, 1)
  assert.deepEqual(memory.content.recentSuccesses[0], {
    tool: 'read_file',
    input: {
      path: '/workspace/attachments/source.md',
      startLine: 1,
      endLine: 98,
      mode: 'raw',
    },
    file: {
      size: 22584,
      mtimeMs: 1779784390088,
      outputSha256: 'abc123',
    },
    recordedAt: 1779791037812,
    restoredFromWorkMemory: undefined,
    workMemoryId: undefined,
  })
})
