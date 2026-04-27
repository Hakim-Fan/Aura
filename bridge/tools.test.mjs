import test from 'node:test'
import assert from 'node:assert/strict'
import { invokeTool } from './tools.mjs'

test('invokeTool uses live settings for approval checks before falling back to task snapshot', async () => {
  let approvalRequested = false

  const output = await invokeTool(
    {
      source: 'builtin',
      name: 'write_file',
      approvalCategory: 'file_write',
      description: 'Write a text file inside the workspace.',
      async run() {
        return { ok: true }
      },
    },
    {
      path: 'note.txt',
      content: 'hello',
    },
    [],
    {
      settings: {
        autoApproveFileWrite: false,
        autoApproveShell: false,
        autoApproveComputerUse: false,
      },
      async appControl(action) {
        assert.equal(action, 'get_settings')
        return {
          autoApproveFileWrite: true,
          autoApproveShell: false,
          autoApproveComputerUse: false,
        }
      },
      async requestApproval() {
        approvalRequested = true
        return 'deny'
      },
    },
  )

  assert.equal(approvalRequested, false)
  assert.match(output, /"ok": true/)
})

test('invokeTool falls back to task-start settings when live settings are unavailable', async () => {
  let approvalRequested = false

  const output = await invokeTool(
    {
      source: 'builtin',
      name: 'run_shell',
      approvalCategory: 'shell',
      description: 'Run a shell command.',
      async run() {
        return { ok: true }
      },
    },
    {
      command: 'echo hello',
    },
    [],
    {
      settings: {
        autoApproveFileWrite: false,
        autoApproveShell: true,
        autoApproveComputerUse: false,
      },
      async appControl() {
        throw new Error('settings bridge unavailable')
      },
      async requestApproval() {
        approvalRequested = true
        return 'deny'
      },
    },
  )

  assert.equal(approvalRequested, false)
  assert.match(output, /"ok": true/)
})
