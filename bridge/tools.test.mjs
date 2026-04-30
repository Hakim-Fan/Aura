import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createBuiltinTools, invokeTool } from './tools.mjs'

function buildStoredZip(entries) {
  const localParts = []
  const centralParts = []
  let offset = 0

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8')
    const content = Buffer.from(entry.content || '', 'utf8')
    const localHeader = Buffer.alloc(30)
    localHeader.writeUInt32LE(0x04034b50, 0)
    localHeader.writeUInt16LE(20, 4)
    localHeader.writeUInt16LE(0, 6)
    localHeader.writeUInt16LE(0, 8)
    localHeader.writeUInt32LE(0, 14)
    localHeader.writeUInt32LE(content.length, 18)
    localHeader.writeUInt32LE(content.length, 22)
    localHeader.writeUInt16LE(name.length, 26)
    localHeader.writeUInt16LE(0, 28)
    localParts.push(localHeader, name, content)

    const centralHeader = Buffer.alloc(46)
    centralHeader.writeUInt32LE(0x02014b50, 0)
    centralHeader.writeUInt16LE(20, 4)
    centralHeader.writeUInt16LE(20, 6)
    centralHeader.writeUInt16LE(0, 8)
    centralHeader.writeUInt16LE(0, 10)
    centralHeader.writeUInt32LE(0, 16)
    centralHeader.writeUInt32LE(content.length, 20)
    centralHeader.writeUInt32LE(content.length, 24)
    centralHeader.writeUInt16LE(name.length, 28)
    centralHeader.writeUInt16LE(0, 30)
    centralHeader.writeUInt16LE(0, 32)
    centralHeader.writeUInt32LE(0, 38)
    centralHeader.writeUInt32LE(offset, 42)
    centralParts.push(centralHeader, name)

    offset += localHeader.length + name.length + content.length
  }

  const centralDirectory = Buffer.concat(centralParts)
  const localFiles = Buffer.concat(localParts)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(centralDirectory.length, 12)
  eocd.writeUInt32LE(localFiles.length, 16)
  eocd.writeUInt16LE(0, 20)

  return Buffer.concat([localFiles, centralDirectory, eocd])
}

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

test('invokeTool includes apply_patch diff preview in approval requests', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'aura-apply-patch-approval-'))
  await fs.mkdir(path.join(workspace, 'src'), { recursive: true })
  await fs.writeFile(path.join(workspace, 'src', 'sample.txt'), 'old\n', 'utf8')
  const applyPatch = createBuiltinTools({ cwd: workspace }).find(
    tool => tool.name === 'apply_patch',
  )
  let approvalRequest

  const output = await invokeTool(
    applyPatch,
    {
      patch: [
        '*** Begin Patch',
        '*** Update File: src/sample.txt',
        '@@',
        '-old',
        '+new',
        '*** End Patch',
      ].join('\n'),
    },
    [],
    {
      settings: {
        cwd: workspace,
        autoApproveFileWrite: false,
        autoApproveShell: true,
        autoApproveComputerUse: true,
      },
      async requestApproval(request) {
        approvalRequest = request
        return 'deny'
      },
    },
  )

  assert.match(output, /denied by the user/)
  assert.equal(await fs.readFile(path.join(workspace, 'src', 'sample.txt'), 'utf8'), 'old\n')
  const preview = JSON.parse(approvalRequest.output)
  assert.equal(preview.stage, 'patch_progress')
  assert.equal(preview.phase, 'approval_preview')
  assert.deepEqual(preview.affectedPaths, ['src/sample.txt'])
  assert.equal(preview.files[0].path, 'src/sample.txt')
  assert.ok(Array.isArray(preview.files[0].diffPreview.lines))
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

test('search_code returns suggested read_file ranges for matches', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'aura-search-code-'))
  await fs.mkdir(path.join(workspace, 'src'), { recursive: true })
  await fs.writeFile(
    path.join(workspace, 'src', 'sample.ts'),
    ['alpha', 'function targetThing() {', '  return true', '}', 'omega'].join('\n'),
    'utf8',
  )

  const searchCode = createBuiltinTools({ cwd: workspace }).find(
    tool => tool.name === 'search_code',
  )
  const output = await searchCode.run({
    query: 'targetThing',
    path: 'src',
    contextLines: 2,
  })
  const parsed = JSON.parse(output)

  assert.equal(parsed.query, 'targetThing')
  assert.equal(parsed.total, 1)
  assert.equal(parsed.matches[0].path, 'src/sample.ts')
  assert.equal(parsed.matches[0].line, 2)
  assert.deepEqual(parsed.matches[0].suggestedRange, {
    path: 'src/sample.ts',
    startLine: 1,
    endLine: 4,
    mode: 'edit_context',
  })
  assert.deepEqual(parsed.suggestedRanges[0], parsed.matches[0].suggestedRange)
})

test('verify_artifact validates office container evidence', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'aura-verify-artifact-'))
  await fs.mkdir(path.join(workspace, 'out'), { recursive: true })
  await fs.writeFile(
    path.join(workspace, 'out', 'deck.pptx'),
    buildStoredZip([
      {
        name: '[Content_Types].xml',
        content: '<Types></Types>',
      },
      {
        name: 'ppt/presentation.xml',
        content: '<p:presentation></p:presentation>',
      },
    ]),
  )

  const verifyArtifact = createBuiltinTools({ cwd: workspace }).find(
    tool => tool.name === 'verify_artifact',
  )
  const output = await verifyArtifact.run({
    path: 'out/deck.pptx',
    expectedKind: 'pptx',
  })
  const parsed = output

  assert.equal(parsed.operation, 'verify_artifact')
  assert.equal(parsed.path, 'out/deck.pptx')
  assert.equal(parsed.verified, true)
  assert.equal(parsed.office.format, 'pptx')
  assert.equal(parsed.office.structureVerified, true)
  assert.equal(parsed.sha256.length, 64)
  assert.equal(parsed.readBackOk, true)
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
