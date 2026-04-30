import test from 'node:test'
import assert from 'node:assert/strict'
import {
  createApplyPatchStreamingReporter,
  extractApplyPatchArgumentText,
  summarizeApplyPatchProgress,
} from './applyPatchStreaming.mjs'

test('extractApplyPatchArgumentText reads incomplete streamed JSON string arguments', () => {
  const rawArgs = '{"patch":"*** Begin Patch\\n*** Update File: src/a.ts\\n@@\\n-old'

  assert.equal(
    extractApplyPatchArgumentText(rawArgs),
    ['*** Begin Patch', '*** Update File: src/a.ts', '@@', '-old'].join('\n'),
  )
})

test('summarizeApplyPatchProgress reports affected paths before arguments are complete', () => {
  const rawArgs = '{"patch":"*** Begin Patch\\n*** Update File: src/a.ts\\n@@\\n-old'

  assert.deepEqual(summarizeApplyPatchProgress(rawArgs), {
    stage: 'patch_progress',
    phase: 'streaming_preview',
    operationCount: 1,
    affectedPaths: ['src/a.ts'],
    operations: [
      {
        kind: 'update',
        path: 'src/a.ts',
      },
    ],
    complete: false,
    summary: 'Generating patch for 1 file(s).',
  })
})

test('summarizeApplyPatchProgress includes move targets for complete patches', () => {
  const rawPatch = [
    '*** Begin Patch',
    '*** Update File: src/old.ts',
    '*** Move to: src/new.ts',
    '@@',
    '-old',
    '+new',
    '*** End Patch',
  ].join('\n')

  assert.deepEqual(summarizeApplyPatchProgress(JSON.stringify({ patch: rawPatch })), {
    stage: 'patch_progress',
    phase: 'streaming_complete',
    operationCount: 1,
    affectedPaths: ['src/old.ts', 'src/new.ts'],
    operations: [
      {
        kind: 'update',
        path: 'src/old.ts',
        moveTo: 'src/new.ts',
      },
    ],
    complete: true,
    summary: 'Generated patch for 2 file(s).',
  })
})

test('createApplyPatchStreamingReporter emits only when progress changes', () => {
  const events = []
  const reporter = createApplyPatchStreamingReporter({
    order: 5,
    hooks: {
      onToolEvent(event) {
        events.push(event)
      },
    },
  })
  const toolCall = {
    id: 'call-patch',
    index: 0,
    function: {
      name: 'apply_patch',
      arguments: '{"patch":"*** Begin Patch\\n*** Update File: src/a.ts',
    },
  }

  reporter.inspect([toolCall])
  reporter.inspect([toolCall])
  toolCall.function.arguments =
    '{"patch":"*** Begin Patch\\n*** Update File: src/a.ts\\n*** Update File: src/b.ts'
  reporter.inspect([toolCall])

  assert.equal(events.length, 2)
  assert.equal(events[0].id, events[1].id)
  assert.equal(events[0].name, 'apply_patch')
  assert.equal(events[0].status, 'running')
  assert.equal(events[0].order, 5)
  assert.deepEqual(JSON.parse(events[1].output).affectedPaths, [
    'src/a.ts',
    'src/b.ts',
  ])
})
