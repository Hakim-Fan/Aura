import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { parseApplyPatchShellCommand } from './applyPatchShell.mjs'
import { createBuiltinTools, invokeTool } from '../tools.mjs'

async function withTempWorkspace(run) {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'desk-agent-shell-patch-'))
  try {
    return await run(workspace)
  } finally {
    await fs.rm(workspace, { recursive: true, force: true })
  }
}

function toolResultText(value) {
  if (typeof value === 'string') {
    return value
  }
  if (!value || typeof value !== 'object') {
    return String(value)
  }
  if ('output' in value && value.output != null) {
    return typeof value.output === 'string'
      ? value.output
      : JSON.stringify(value.output)
  }
  const error = value.error
  const parts = [
    error?.message,
    error?.rawMessage,
    error?.errorInfo?.summary,
    error?.errorInfo?.detail,
    error?.originalError?.message,
    error?.originalError?.rawMessage,
    error?.originalError?.errorInfo?.summary,
    error?.originalError?.errorInfo?.detail,
    typeof error?.toStructuredReport === 'function'
      ? JSON.stringify(error.toStructuredReport(), null, 2)
      : '',
  ]
  return parts.filter(Boolean).join('\n')
}

function parseToolResultJson(value) {
  return JSON.parse(toolResultText(value))
}

test('parseApplyPatchShellCommand parses heredoc invocations with optional cd', () => {
  const parsed = parseApplyPatchShellCommand(
    [
      'cd "nested dir" && apply_patch <<\'PATCH\'',
      '*** Begin Patch',
      '*** Add File: note.txt',
      '+hello',
      '*** End Patch',
      'PATCH',
    ].join('\n'),
  )

  assert.deepEqual(parsed, {
    kind: 'valid',
    invocation: 'heredoc',
    workdir: 'nested dir',
    patch: [
      '*** Begin Patch',
      '*** Add File: note.txt',
      '+hello',
      '*** End Patch',
    ].join('\n'),
  })
})

test('parseApplyPatchShellCommand rejects apply_patch commands with trailing shell operators', () => {
  const parsed = parseApplyPatchShellCommand(
    'apply_patch "*** Begin Patch\n*** Add File: note.txt\n+hello\n*** End Patch" && echo done',
  )

  assert.equal(parsed.kind, 'invalid')
  assert.match(parsed.reason, /must not include extra shell operators/)
})

test('invokeTool routes run_shell apply_patch invocations through the verified patch runtime', async () => {
  await withTempWorkspace(async workspace => {
    const context = {
      cwd: workspace,
      todoState: { items: [] },
      cleanupHandlers: [],
    }
    const runShellTool = createBuiltinTools(context).find(tool => tool.name === 'run_shell')
    const toolEvents = []

    const output = await invokeTool(
      runShellTool,
      {
        command: [
          'cd nested && apply_patch <<\'PATCH\'',
          '*** Begin Patch',
          '*** Add File: note.txt',
          '+hello',
          '*** End Patch',
          'PATCH',
        ].join('\n'),
      },
      toolEvents,
      {
        settings: {
          cwd: workspace,
          autoApproveFileWrite: true,
          autoApproveShell: true,
          autoApproveComputerUse: true,
        },
      },
    )

    for (const cleanup of context.cleanupHandlers) {
      await cleanup()
    }

    const result = parseToolResultJson(output)
    assert.equal(result.ok, true)
    assert.equal(toolEvents.at(-1).name, 'apply_patch')
    assert.equal(toolEvents.at(-1).status, 'success')
    assert.equal(
      await fs.readFile(path.join(workspace, 'nested', 'note.txt'), 'utf8'),
      'hello\n',
    )
  })
})

test('invokeTool blocks invalid apply_patch shell invocations before normal shell execution', async () => {
  await withTempWorkspace(async workspace => {
    const context = {
      cwd: workspace,
      todoState: { items: [] },
      cleanupHandlers: [],
    }
    const runShellTool = createBuiltinTools(context).find(tool => tool.name === 'run_shell')
    const toolEvents = []

    const output = await invokeTool(
      runShellTool,
      {
        command: ['apply_patch <<\'PATCH\'', 'not a patch', 'PATCH'].join('\n'),
      },
      toolEvents,
      {
        settings: {
          cwd: workspace,
          autoApproveFileWrite: true,
          autoApproveShell: true,
          autoApproveComputerUse: true,
        },
      },
    )

    for (const cleanup of context.cleanupHandlers) {
      await cleanup()
    }

    assert.match(toolResultText(output), /无效的 apply_patch shell 调用/)
    assert.equal(toolEvents.at(-1).name, 'apply_patch')
    assert.equal(toolEvents.at(-1).status, 'error')
    assert.equal(toolEvents.at(-1).errorInfo?.code, 'INVALID_APPLY_PATCH_INVOCATION')
  })
})
