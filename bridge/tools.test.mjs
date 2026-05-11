import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  appendRuntimeToolEvidenceToSystemPrompt,
  buildRuntimeToolEvidencePrompt,
  createBuiltinTools,
  invokeTool,
} from './tools.mjs'

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

test('invokeTool honors task-scoped approval grants for matching categories', async () => {
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
        autoApproveShell: false,
        autoApproveComputerUse: false,
      },
      isApprovalGranted(category) {
        return category === 'shell'
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

test('todo_write accepts todos JSON string compatibility input', async () => {
  const context = { cwd: await fs.mkdtemp(path.join(os.tmpdir(), 'aura-todo-')) }
  const todoWrite = createBuiltinTools(context).find(tool => tool.name === 'todo_write')

  const output = await invokeTool(
    todoWrite,
    {
      todos: JSON.stringify([
        {
          id: '1',
          content: '编写 Node.js 脚本生成 17 个数据实体表的 Word 文档',
          status: 'in_progress',
        },
        {
          id: '2',
          content: '运行脚本生成 docx 文件',
          status: 'pending',
        },
      ]),
    },
    [],
    {},
  )

  assert.match(output, /\[~\] 编写 Node\.js 脚本生成 17 个数据实体表的 Word 文档/)
  assert.match(output, /\[ \] 运行脚本生成 docx 文件/)
  assert.equal(context.todoState.items.length, 2)
})

test('todo_write records a reusable task progress checkpoint', async () => {
  const context = {
    cwd: await fs.mkdtemp(path.join(os.tmpdir(), 'aura-todo-memory-')),
    logContext: {
      sessionId: 'session-1',
      taskId: 'task-1',
      assistantMessageId: 'assistant-1',
    },
    async appControl(action, payload) {
      assert.equal(action, 'record_work_memory')
      assert.equal(payload.memory.kind, 'task_progress')
      return {
        ...payload.memory,
        createdAt: 456,
      }
    },
  }
  const todoWrite = createBuiltinTools(context).find(tool => tool.name === 'todo_write')
  let emittedMemory

  await invokeTool(
    todoWrite,
    {
      items: [
        {
          id: '1',
          content: '解析文档 XML 并提取子标题',
          status: 'completed',
        },
        {
          id: '2',
          content: '生成数据实体表',
          status: 'in_progress',
        },
      ],
    },
    [],
    {
      onWorkMemory(memory) {
        emittedMemory = memory
      },
    },
  )

  assert.equal(context.workMemories.length, 1)
  assert.equal(context.workMemories[0].kind, 'task_progress')
  assert.match(context.workMemories[0].summary, /1\/2 steps completed/)
  assert.deepEqual(context.workMemories[0].content.completed, ['解析文档 XML 并提取子标题'])
  assert.equal(emittedMemory.id, context.workMemories[0].id)

  context.logContext.assistantMessageId = 'assistant-2'
  await invokeTool(
    todoWrite,
    {
      items: [
        {
          id: '1',
          content: '解析文档 XML 并提取子标题',
          status: 'completed',
        },
        {
          id: '2',
          content: '生成数据实体表',
          status: 'completed',
        },
      ],
    },
    [],
    {},
  )

  assert.equal(context.workMemories.length, 1)
  assert.match(context.workMemories[0].summary, /2\/2 steps completed/)
})

test('record_work_memory stores a normalized phase artifact without a visible tool event', async () => {
  const context = {
    cwd: await fs.mkdtemp(path.join(os.tmpdir(), 'aura-work-memory-')),
    logContext: {
      sessionId: 'session-1',
      taskId: 'task-1',
      assistantMessageId: 'assistant-1',
    },
    async appControl(action, payload) {
      assert.equal(action, 'record_work_memory')
      assert.equal(payload.memory.sessionId, 'session-1')
      return {
        ...payload.memory,
        id: 'work-memory-1',
        createdAt: 123,
      }
    },
  }
  const recordWorkMemory = createBuiltinTools(context).find(
    tool => tool.name === 'record_work_memory',
  )
  const toolEvents = []
  let emittedMemory

  const output = await invokeTool(
    recordWorkMemory,
    {
      kind: 'schema_design',
      title: 'Schema draft',
      summary: 'Extracted reusable schema sections for the document generation step.',
      status: 'draft',
      content: {
        sections: ['users', 'roles'],
      },
      sourceRefs: [
        {
          type: 'file',
          path: 'requirements.md',
        },
      ],
      nextUse: 'Reuse these sections when generating the final artifact.',
    },
    toolEvents,
    {
      onWorkMemory(memory) {
        emittedMemory = memory
      },
    },
  )

  const parsed = JSON.parse(output)
  assert.equal(parsed.recorded, true)
  assert.equal(parsed.persisted, true)
  assert.equal(parsed.memory.id, 'work-memory-1')
  assert.equal(context.workMemories.length, 1)
  assert.equal(emittedMemory.id, 'work-memory-1')
  assert.equal(toolEvents.length, 0)
})

test('successful context-gathering tools record a tool evidence checkpoint', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'aura-tool-memory-'))
  await fs.writeFile(path.join(workspace, 'requirements.md'), '# Title\nReusable facts\n', 'utf8')
  const context = {
    cwd: workspace,
    logContext: {
      sessionId: 'session-1',
      taskId: 'task-1',
      assistantMessageId: 'assistant-1',
    },
    async appControl(action, payload) {
      assert.equal(action, 'record_work_memory')
      assert.equal(payload.memory.kind, 'tool_evidence')
      return {
        ...payload.memory,
        createdAt: 789,
      }
    },
  }
  const readFile = createBuiltinTools(context).find(tool => tool.name === 'read_file')
  let emittedMemory

  await invokeTool(
    readFile,
    {
      path: 'requirements.md',
    },
    [],
    {
      workMemoryContext: context,
      onWorkMemory(memory) {
        emittedMemory = memory
      },
    },
  )

  assert.equal(context.workMemories.length, 1)
  assert.equal(context.workMemories[0].kind, 'tool_evidence')
  assert.equal(context.workMemories[0].content.recentSuccesses[0].tool, 'read_file')
  assert.equal(context.workMemories[0].content.recentSuccesses[0].input.path, 'requirements.md')
  assert.equal(emittedMemory.id, context.workMemories[0].id)

  await invokeTool(
    readFile,
    {
      path: 'requirements.md',
    },
    [],
    {
      workMemoryContext: context,
    },
  )

  assert.equal(context.workMemories.length, 1)
  assert.equal(context.workMemories[0].content.recentSuccesses.length, 1)
  assert.match(
    buildRuntimeToolEvidencePrompt(context),
    /read_file\(requirements\.md\) succeeded/,
  )
  assert.match(
    buildRuntimeToolEvidencePrompt(context),
    /Output recall: # Title Reusable facts/,
  )
  assert.match(
    appendRuntimeToolEvidenceToSystemPrompt('base prompt', context),
    /base prompt[\s\S]*Runtime tool evidence from this ongoing task/,
  )
})

test('invokeTool includes editing transaction preview in apply_patch approval requests', async () => {
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
  assert.equal(preview.stage, 'edit_transaction_preview')
  assert.equal(preview.phase, 'approval_preview')
  assert.equal(preview.sourceOperation, 'apply_patch')
  assert.deepEqual(preview.affectedPaths, ['src/sample.txt'])
  assert.equal(preview.files[0].path, 'src/sample.txt')
  assert.ok(Array.isArray(preview.files[0].diffPreview.lines))
})

test('invokeTool includes editing transaction preview for exact edit approval requests', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'aura-edit-approval-'))
  await fs.mkdir(path.join(workspace, 'src'), { recursive: true })
  await fs.writeFile(path.join(workspace, 'src', 'sample.txt'), 'old\n', 'utf8')
  const editFile = createBuiltinTools({ cwd: workspace }).find(
    tool => tool.name === 'edit_file',
  )
  let approvalRequest

  const output = await invokeTool(
    editFile,
    {
      path: 'src/sample.txt',
      oldText: 'old',
      newText: 'new',
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
  assert.equal(preview.stage, 'edit_transaction_preview')
  assert.equal(preview.phase, 'approval_preview')
  assert.equal(preview.sourceOperation, 'edit_file')
  assert.deepEqual(preview.affectedPaths, ['src/sample.txt'])
  assert.equal(preview.files[0].diffStat.addedLines, 1)
  assert.equal(preview.files[0].diffStat.removedLines, 1)
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

test('invokeTool forces approval for shell commands that access external paths', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'aura-external-policy-'))
  let shellRan = false
  let approvalRequest

  const output = await invokeTool(
    {
      source: 'builtin',
      name: 'exec_command',
      approvalCategory: 'shell',
      description: 'Run a shell command.',
      async run() {
        shellRan = true
        return { ok: true }
      },
    },
    {
      cmd: 'cat /tmp/anthropics-skills/skills/docx/SKILL.md',
    },
    [],
    {
      settings: {
        cwd: workspace,
        autoApproveFileWrite: true,
        autoApproveShell: true,
        autoApproveComputerUse: false,
      },
      async requestApproval(request) {
        approvalRequest = request
        return 'deny'
      },
    },
  )

  assert.equal(shellRan, false)
  assert.match(output, /denied by the user/)
  assert.equal(approvalRequest.policy.code, 'SHELL_EXTERNAL_PATH_ACCESS')
})

test('invokeTool blocks dangerous shell commands even when shell is auto approved', async () => {
  let shellRan = false

  const output = await invokeTool(
    {
      source: 'builtin',
      name: 'exec_command',
      approvalCategory: 'shell',
      description: 'Run a shell command.',
      async run() {
        shellRan = true
        return { ok: true }
      },
    },
    {
      cmd: 'rm -rf /',
    },
    [],
    {
      settings: {
        cwd: process.cwd(),
        autoApproveFileWrite: true,
        autoApproveShell: true,
        autoApproveComputerUse: false,
      },
    },
  )

  assert.equal(shellRan, false)
  assert.match(output, /危险 shell 命令/)
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

test('builtin run_shell returns structured exit evidence for successful commands', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'aura-run-shell-'))
  const runShellTool = createBuiltinTools({ cwd: workspace }).find(tool => tool.name === 'run_shell')
  const events = []

  const output = await invokeTool(
    runShellTool,
    {
      command: 'node --version',
    },
    events,
    {
      settings: {
        autoApproveFileWrite: true,
        autoApproveShell: true,
        autoApproveComputerUse: false,
      },
    },
  )
  const parsed = JSON.parse(output)

  assert.equal(parsed.status, 'exited')
  assert.equal(parsed.running, false)
  assert.equal(parsed.exitCode, 0)
  assert.match(parsed.output, /^v\d+\./)
  assert.equal(events[0].structuredOutput, undefined)
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

test('invokeTool keeps structured edit output when display output is truncated', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'aura-apply-patch-structured-'))
  await fs.mkdir(path.join(workspace, 'src'), { recursive: true })
  const patch = [
    '*** Begin Patch',
    ...Array.from({ length: 80 }, (_, index) => [
      `*** Add File: src/file-${index}.txt`,
      '+alpha',
      '+beta',
      '+gamma',
    ]).flat(),
    '*** End Patch',
  ].join('\n')
  const applyPatch = createBuiltinTools({ cwd: workspace }).find(
    tool => tool.name === 'apply_patch',
  )
  const toolEvents = []

  await invokeTool(
    applyPatch,
    { patch },
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

  assert.equal(toolEvents.length, 1)
  assert.match(toolEvents[0].output, /<truncated>/)
  assert.equal(toolEvents[0].structuredOutput.verified, true)
  assert.equal(toolEvents[0].structuredOutput.preview.length, 80)
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

test('search_code structured output stays valid JSON when compacted', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'aura-search-code-compact-'))
  await fs.mkdir(path.join(workspace, 'src'), { recursive: true })
  const longLine = `${'x'.repeat(900)} targetCompact ${'y'.repeat(900)}`
  await fs.writeFile(
    path.join(workspace, 'src', 'large.ts'),
    Array.from({ length: 120 }, (_, index) => `${index}: ${longLine}`).join('\n'),
    'utf8',
  )

  const searchCode = createBuiltinTools({ cwd: workspace }).find(
    tool => tool.name === 'search_code',
  )
  const output = await searchCode.run({
    query: 'targetCompact',
    path: 'src',
    maxMatches: 120,
  })
  const parsed = JSON.parse(output)

  assert.ok(output.length <= 12000)
  assert.equal(parsed.query, 'targetCompact')
  assert.equal(parsed.total, 120)
  assert.equal(parsed.outputTruncated, true)
  assert.ok(parsed.returnedMatches < parsed.total)
  assert.ok(Array.isArray(parsed.suggestedRanges))
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

test('aura_install_skill installs inline content into Aura skills and enables it', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'aura-install-skill-workspace-'))
  const auraRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aura-install-skill-home-'))
  const skillsDir = path.join(auraRoot, 'skills')
  const pluginsDir = path.join(auraRoot, 'plugins')
  await fs.mkdir(skillsDir, { recursive: true })
  await fs.mkdir(pluginsDir, { recursive: true })

  let settings = {
    enabledSkillIds: [],
    enabledPluginIds: [],
    mcpServers: [],
  }

  async function scanAura() {
    const skills = []
    for (const entry of await fs.readdir(skillsDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) {
        continue
      }
      const id = path.basename(entry.name, '.md')
      const entryPath = path.join(skillsDir, entry.name)
      skills.push({
        id,
        name: id,
        description: '',
        path: entryPath,
        entryPath,
        supported: true,
        supportMessage: '',
        readonly: false,
      })
    }

    return {
      homeDir: auraRoot,
      skillsDir,
      pluginsDir,
      skills,
      plugins: [],
    }
  }

  const installSkill = createBuiltinTools({
    cwd: workspace,
    async appControl(action, payload) {
      if (action === 'ensure_aura_home') {
        return scanAura()
      }
      if (action === 'get_settings') {
        return settings
      }
      if (action === 'set_settings') {
        settings = payload.settings
        return settings
      }
      throw new Error(`Unexpected app action: ${action}`)
    },
  }).find(tool => tool.name === 'aura_install_skill')

  const output = JSON.parse(
    await installSkill.run({
      content: [
        '---',
        'name: Demo Skill',
        'description: Installed from inline content.',
        '---',
        '',
        '# Demo Skill',
      ].join('\n'),
    }),
  )

  assert.equal(output.skillId, 'demo-skill')
  assert.equal(output.enabled, true)
  assert.match(output.usageHint, /aura_read_skill with skillId "demo-skill"/)
  assert.deepEqual(settings.enabledSkillIds, ['demo-skill'])
  assert.match(
    await fs.readFile(path.join(skillsDir, 'demo-skill.md'), 'utf8'),
    /Installed from inline content/,
  )
})
