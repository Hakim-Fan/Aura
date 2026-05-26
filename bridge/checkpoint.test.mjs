import test from 'node:test'
import assert from 'node:assert/strict'
import {
  createCheckpointManager,
  restoreFromCheckpoint,
} from './checkpoint.mjs'

test('checkpoint snapshots preserve runtime evidence and artifact context', async () => {
  const checkpointManager = createCheckpointManager()
  const context = {
    messages: [{ role: 'user', content: '生成 PRD' }],
    toolEvents: [{ toolName: 'read_file', status: 'success' }],
    workMemories: [{ kind: 'task_progress', summary: '读取完成' }],
    autoToolEvidence: [
      {
        tool: 'read_file',
        input: { path: 'attachments/source.md' },
        file: { size: 123, mtimeMs: 456 },
      },
    ],
    artifactStore: {
      artifacts: [
        {
          id: 'artifact-1',
          type: 'tool_output',
          chunks: [{ summary: 'source text', content: 'full text' }],
        },
      ],
    },
    checkpointHints: [
      {
        reason: 'large_tool_output_spilled',
        artifacts: [{ id: 'artifact-1' }],
      },
    ],
  }

  const checkpoint = checkpointManager.createCheckpoint(
    'task-1',
    'step-1',
    checkpointManager.createSnapshot(context),
  )
  const restoredContext = {}
  const result = await restoreFromCheckpoint(checkpoint, restoredContext)

  assert.equal(result.success, true)
  assert.deepEqual(restoredContext.autoToolEvidence, context.autoToolEvidence)
  assert.deepEqual(restoredContext.artifactStore, context.artifactStore)
  assert.deepEqual(restoredContext.checkpointHints, context.checkpointHints)
})
