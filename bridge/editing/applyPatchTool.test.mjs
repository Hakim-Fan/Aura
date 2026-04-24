import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { applyPatchInWorkspace } from './applyPatchTool.mjs'

async function withTempWorkspace(run) {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'desk-agent-apply-patch-'))
  try {
    return await run(workspace)
  } finally {
    await fs.rm(workspace, { recursive: true, force: true })
  }
}

test('applyPatchInWorkspace applies add, update, move, and delete with progress events', async () => {
  await withTempWorkspace(async workspace => {
    await fs.mkdir(path.join(workspace, 'src'), { recursive: true })
    await fs.writeFile(path.join(workspace, 'src', 'a.txt'), 'one\nold\nthree\n', 'utf8')
    await fs.writeFile(path.join(workspace, 'src', 'legacy.txt'), 'keep\nrename me\n', 'utf8')
    await fs.writeFile(path.join(workspace, 'src', 'delete.txt'), 'bye\n', 'utf8')

    const updates = []
    const result = await applyPatchInWorkspace(
      workspace,
      [
        '*** Begin Patch',
        '*** Update File: src/a.txt',
        '@@',
        ' one',
        '-old',
        '+new',
        ' three',
        '*** Add File: src/added.txt',
        '+hello',
        '*** Update File: src/legacy.txt',
        '*** Move to: src/renamed.txt',
        '@@',
        ' keep',
        '-rename me',
        '+renamed now',
        '*** Delete File: src/delete.txt',
        '*** End Patch',
      ].join('\n'),
      {
        onUpdate(update) {
          updates.push(update)
        },
      },
    )

    assert.equal(result.ok, true)
    assert.equal(result.verified, true)
    assert.equal(result.summary, 'added 1, updated 1, moved 1, deleted 1')
    assert.deepEqual(
      result.files.map(file => file.kind),
      ['update', 'add', 'move', 'delete'],
    )
    assert.equal(
      await fs.readFile(path.join(workspace, 'src', 'a.txt'), 'utf8'),
      'one\nnew\nthree\n',
    )
    assert.equal(
      await fs.readFile(path.join(workspace, 'src', 'added.txt'), 'utf8'),
      'hello\n',
    )
    assert.equal(
      await fs.readFile(path.join(workspace, 'src', 'renamed.txt'), 'utf8'),
      'keep\nrenamed now\n',
    )
    await assert.rejects(fs.access(path.join(workspace, 'src', 'legacy.txt')))
    await assert.rejects(fs.access(path.join(workspace, 'src', 'delete.txt')))

    assert.equal(updates[0].stage, 'patch_begin')
    assert.equal(updates.at(-1).stage, 'patch_end')
    assert.ok(
      updates.some(update => update.stage === 'patch_progress' && update.phase === 'verified'),
    )
    assert.ok(
      updates.some(
        update =>
          update.stage === 'patch_progress' &&
          update.phase === 'applied' &&
          update.completed === 4,
      ),
    )
  })
})

test('applyPatchInWorkspace rejects conflicting writes in a single patch before touching the workspace', async () => {
  await withTempWorkspace(async workspace => {
    await fs.mkdir(path.join(workspace, 'src'), { recursive: true })

    await assert.rejects(
      applyPatchInWorkspace(
        workspace,
        [
          '*** Begin Patch',
          '*** Add File: src/conflict.txt',
          '+hello',
          '*** Update File: src/conflict.txt',
          '@@',
          '-hello',
          '+world',
          '*** End Patch',
        ].join('\n'),
      ),
      /touches src\/conflict\.txt more than once/,
    )

    await assert.rejects(fs.access(path.join(workspace, 'src', 'conflict.txt')))
  })
})

test('applyPatchInWorkspace aborts the whole patch when verification fails', async () => {
  await withTempWorkspace(async workspace => {
    await fs.mkdir(path.join(workspace, 'src'), { recursive: true })
    await fs.writeFile(path.join(workspace, 'src', 'a.txt'), 'one\ntwo\nthree\n', 'utf8')

    await assert.rejects(
      applyPatchInWorkspace(
        workspace,
        [
          '*** Begin Patch',
          '*** Add File: src/new.txt',
          '+hello',
          '*** Update File: src/a.txt',
          '@@',
          ' one',
          '-missing',
          '+updated',
          ' three',
          '*** End Patch',
        ].join('\n'),
      ),
      /Patch context did not match the current content of src\/a\.txt/,
    )

    assert.equal(
      await fs.readFile(path.join(workspace, 'src', 'a.txt'), 'utf8'),
      'one\ntwo\nthree\n',
    )
    await assert.rejects(fs.access(path.join(workspace, 'src', 'new.txt')))
  })
})
