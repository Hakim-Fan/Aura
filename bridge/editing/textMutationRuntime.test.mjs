import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  applyEditFileMutation,
  applyMultiEditFileMutation,
  applyWriteFileMutation,
} from './textMutationRuntime.mjs'

async function withTempWorkspace(run) {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'desk-agent-text-mutation-'))
  try {
    return await run(workspace)
  } finally {
    await fs.rm(workspace, { recursive: true, force: true })
  }
}

test('applyWriteFileMutation creates parent directories and verifies the written content', async () => {
  await withTempWorkspace(async workspace => {
    const targetPath = path.join(workspace, 'docs', 'note.md')
    const updates = []
    const result = await applyWriteFileMutation(targetPath, '# hello\n', {
      onUpdate(update) {
        updates.push(update)
      },
    })

    assert.equal(result.operation, 'write_file')
    assert.equal(result.verified, true)
    assert.equal(result.created, true)
    assert.equal(await fs.readFile(targetPath, 'utf8'), '# hello\n')
    assert.deepEqual(
      updates.map(update => update.stage),
      ['text_mutation_begin', 'text_mutation_end'],
    )
  })
})

test('applyEditFileMutation updates the file once and returns structured verification data', async () => {
  await withTempWorkspace(async workspace => {
    const targetPath = path.join(workspace, 'src', 'file.txt')
    await fs.mkdir(path.dirname(targetPath), { recursive: true })
    await fs.writeFile(targetPath, 'alpha\nbeta\n', 'utf8')

    const result = await applyEditFileMutation(targetPath, 'beta', 'gamma')

    assert.equal(result.operation, 'edit_file')
    assert.equal(result.replacedCount, 1)
    assert.equal(result.verified, true)
    assert.equal(await fs.readFile(targetPath, 'utf8'), 'alpha\ngamma\n')
  })
})

test('applyMultiEditFileMutation keeps the original file unchanged when a later replacement fails', async () => {
  await withTempWorkspace(async workspace => {
    const targetPath = path.join(workspace, 'src', 'file.txt')
    await fs.mkdir(path.dirname(targetPath), { recursive: true })
    await fs.writeFile(targetPath, 'first\nsecond\nthird\n', 'utf8')

    await assert.rejects(
      applyMultiEditFileMutation(targetPath, [
        { oldText: 'first', newText: 'updated-first' },
        { oldText: 'missing', newText: 'updated-missing' },
      ]),
      /oldText was not found/,
    )

    assert.equal(
      await fs.readFile(targetPath, 'utf8'),
      'first\nsecond\nthird\n',
    )
  })
})

test('applyMultiEditFileMutation applies all replacements in order and verifies once at the end', async () => {
  await withTempWorkspace(async workspace => {
    const targetPath = path.join(workspace, 'src', 'file.txt')
    await fs.mkdir(path.dirname(targetPath), { recursive: true })
    await fs.writeFile(targetPath, 'one\ntwo\nthree\n', 'utf8')
    const updates = []

    const result = await applyMultiEditFileMutation(
      targetPath,
      [
        { oldText: 'one', newText: 'ONE' },
        { oldText: 'two', newText: 'TWO' },
      ],
      {
        onUpdate(update) {
          updates.push(update)
        },
      },
    )

    assert.equal(result.operation, 'multi_edit_file')
    assert.equal(result.editsApplied, 2)
    assert.equal(result.verified, true)
    assert.equal(await fs.readFile(targetPath, 'utf8'), 'ONE\nTWO\nthree\n')
    assert.ok(
      updates.some(
        update =>
          update.stage === 'text_mutation_progress' &&
          update.completedEdits === 2,
      ),
    )
  })
})
