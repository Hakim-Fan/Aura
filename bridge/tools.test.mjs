import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createBuiltinTools, invokeTool } from './tools.mjs'

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

test('invokeTool blocks shell scripts that write source files', async () => {
  const events = []
  let shellRan = false

  const output = await invokeTool(
    {
      source: 'builtin',
      name: 'run_shell',
      approvalCategory: 'shell',
      description: 'Run a shell command.',
      async run() {
        shellRan = true
        return { ok: true }
      },
    },
    {
      command:
        "python3 - <<'PY'\nfrom pathlib import Path\nPath('src/App.tsx').write_text('bad')\nPY",
    },
    events,
    {
      settings: {
        autoApproveFileWrite: true,
        autoApproveShell: true,
        autoApproveComputerUse: false,
      },
      onToolEvent(event) {
        events.push(event)
      },
    },
  )

  assert.equal(shellRan, false)
  assert.match(output, /已阻止使用 shell 脚本直接修改源码文件/)
  assert.equal(events.at(-1)?.status, 'error')
  assert.equal(events.at(-1)?.errorInfo?.code, 'SHELL_FILE_MUTATION_BLOCKED')
})

test('invokeTool still allows shell commands used for verification', async () => {
  let shellRan = false

  const output = await invokeTool(
    {
      source: 'builtin',
      name: 'run_shell',
      approvalCategory: 'shell',
      description: 'Run a shell command.',
      async run() {
        shellRan = true
        return { ok: true }
      },
    },
    {
      command: 'pnpm typecheck',
    },
    [],
    {
      settings: {
        autoApproveFileWrite: true,
        autoApproveShell: true,
        autoApproveComputerUse: false,
      },
    },
  )

  assert.equal(shellRan, true)
  assert.match(output, /"ok": true/)
})

test('read_file can return a line-numbered range without shell awk', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'aura-read-file-'))
  await fs.writeFile(path.join(workspace, 'sample.ts'), 'one\ntwo\nthree\nfour\n')

  const readFile = createBuiltinTools({ cwd: workspace }).find(
    tool => tool.name === 'read_file',
  )
  const output = await readFile.run({
    path: 'sample.ts',
    startLine: 2,
    endLine: 3,
  })

  assert.equal(output, '2:two\n3:three')
})

test('read_file raw mode returns copyable text without line numbers', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'aura-read-file-'))
  await fs.writeFile(path.join(workspace, 'sample.ts'), 'one\ntwo\nthree\nfour\n')

  const readFile = createBuiltinTools({ cwd: workspace }).find(
    tool => tool.name === 'read_file',
  )
  const output = await readFile.run({
    path: 'sample.ts',
    startLine: 2,
    endLine: 3,
    mode: 'raw',
  })

  assert.equal(output, 'two\nthree')
})

test('read_file edit_context mode returns structured edit metadata', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'aura-read-file-'))
  await fs.writeFile(path.join(workspace, 'sample.ts'), 'one\ntwo\nthree\nfour\n')

  const readFile = createBuiltinTools({ cwd: workspace }).find(
    tool => tool.name === 'read_file',
  )
  const output = await readFile.run({
    path: 'sample.ts',
    startLine: 2,
    endLine: 3,
    mode: 'edit_context',
  })

  const parsed = JSON.parse(output)
  assert.equal(parsed.path, 'sample.ts')
  assert.equal(parsed.startLine, 2)
  assert.equal(parsed.endLine, 3)
  assert.equal(parsed.text, 'two\nthree')
  assert.equal(parsed.numberedText, 'L2: two\nL3: three')
  assert.equal(parsed.sha256.length, 64)
})

test('read_block returns a structured indentation block around an anchor', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'aura-read-block-'))
  await fs.writeFile(
    path.join(workspace, 'sample.ts'),
    [
      'const outside = true',
      '',
      'function demo() {',
      '  const x = 1',
      '  if (x) {',
      '    return x',
      '  }',
      '}',
      '',
      'function next() {}',
      '',
    ].join('\n'),
  )

  const readBlock = createBuiltinTools({ cwd: workspace }).find(
    tool => tool.name === 'read_block',
  )
  const output = await readBlock.run({
    path: 'sample.ts',
    anchorText: 'function demo',
  })

  const parsed = JSON.parse(output)
  assert.equal(parsed.path, 'sample.ts')
  assert.equal(parsed.anchorLine, 3)
  assert.equal(parsed.startLine, 3)
  assert.equal(parsed.endLine, 8)
  assert.match(parsed.text, /function demo\(\)/)
  assert.doesNotMatch(parsed.text, /function next/)
  assert.equal(parsed.numberedText.split('\n')[0], 'L3: function demo() {')
  assert.equal(parsed.sha256.length, 64)
})

test('apply_patch accepts compatibility input aliases', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'aura-apply-patch-alias-'))
  await fs.mkdir(path.join(workspace, 'src'), { recursive: true })
  await fs.writeFile(path.join(workspace, 'src', 'sample.txt'), 'old\n', 'utf8')

  const applyPatch = createBuiltinTools({ cwd: workspace }).find(
    tool => tool.name === 'apply_patch',
  )
  const result = await applyPatch.run({
    input: [
      '*** Begin Patch',
      '*** Update File: src/sample.txt',
      '@@',
      '-old',
      '+new',
      '*** End Patch',
    ].join('\n'),
  })

  assert.equal(result.ok, true)
  assert.equal(await fs.readFile(path.join(workspace, 'src', 'sample.txt'), 'utf8'), 'new\n')
})

test('invokeTool includes structured repair hints in tool error output', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'aura-repair-hint-'))
  await fs.writeFile(path.join(workspace, 'sample.ts'), 'one\ntwo\nthree\n')
  const replaceLineRange = createBuiltinTools({ cwd: workspace }).find(
    tool => tool.name === 'replace_line_range',
  )

  const output = await invokeTool(
    replaceLineRange,
    {
      path: 'sample.ts',
      startLine: 3,
      endLine: 2,
      content: 'bad',
    },
    [],
    {
      settings: {
        autoApproveFileWrite: true,
        autoApproveShell: true,
        autoApproveComputerUse: false,
      },
    },
  )

  assert.match(output, /repairHint/)
  assert.match(output, /"useTool": "read_file"/)
  assert.match(output, /"nextTool": "replace_line_range"/)
})
