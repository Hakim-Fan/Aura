import test from 'node:test'
import assert from 'node:assert/strict'
import { selectTurnCapabilities } from './capabilitySelector.mjs'

function buildTool(name, aliases = []) {
  return {
    source: 'builtin',
    name,
    aliases,
  }
}

test('selectTurnCapabilities keeps execute-tool ordering stable without file-creation keyword routing', () => {
  const tools = [
    buildTool('apply_patch', ['patch']),
    buildTool('write_file', ['write']),
    buildTool('edit_file', ['edit']),
    buildTool('multi_edit_file', ['multiedit']),
  ]

  const result = selectTurnCapabilities({
    messages: [
      {
        content: '把方案写成 docs/refactor_plan.md 并保存到 docs 目录',
      },
    ],
    runtimeCapabilities: { workspaceRoot: '/tmp/workspace' },
    skillEntries: [],
    tools,
    classification: {
      answerMode: 'execute',
      workspaceRelated: true,
      needsExternalFacts: false,
      webInteractionRequired: false,
      systemBrowserRequested: false,
    },
    routeState: {
      answerMode: 'execute',
      workspaceRelated: true,
    },
  })

  assert.equal(result.selectedTools[0].name, 'apply_patch')
  assert.ok(
    result.selectedTools.findIndex(tool => tool.name === 'write_file') <
      result.selectedTools.findIndex(tool => tool.name === 'edit_file'),
  )
})

test('selectTurnCapabilities prefers apply_patch and long-lived exec tools for code changes', () => {
  const tools = [
    buildTool('run_shell', ['shell']),
    buildTool('exec_command', ['exec']),
    buildTool('write_stdin', ['stdin']),
    buildTool('apply_patch', ['patch']),
    buildTool('edit_file', ['edit']),
    buildTool('multi_edit_file', ['multiedit']),
  ]

  const result = selectTurnCapabilities({
    messages: [
      {
        content: '修复 src/app.ts 里的 bug，跑一下测试看输出，然后继续修改',
      },
    ],
    runtimeCapabilities: { workspaceRoot: '/tmp/workspace' },
    skillEntries: [],
    tools,
    classification: {
      answerMode: 'execute',
      workspaceRelated: true,
      needsExternalFacts: false,
      webInteractionRequired: false,
      systemBrowserRequested: false,
    },
    routeState: {
      answerMode: 'execute',
      workspaceRelated: true,
    },
  })

  assert.equal(result.selectedTools[0].name, 'apply_patch')
  assert.ok(
    result.selectedTools.findIndex(tool => tool.name === 'exec_command') <
      result.selectedTools.findIndex(tool => tool.name === 'run_shell'),
  )
  assert.ok(
    result.selectedTools.findIndex(tool => tool.name === 'apply_patch') <
      result.selectedTools.findIndex(tool => tool.name === 'edit_file'),
  )
})

test('selectTurnCapabilities prioritizes web tools from route semantics without keyword scoring', () => {
  const tools = [
    buildTool('read_file', ['read']),
    buildTool('web_fetch', ['fetch']),
    buildTool('web_research', ['research']),
    buildTool('web_search', ['search']),
  ]

  const result = selectTurnCapabilities({
    messages: [
      {
        content: '请处理这个问题',
      },
    ],
    runtimeCapabilities: { workspaceRoot: '/tmp/workspace' },
    skillEntries: [],
    tools,
    classification: {
      answerMode: 'advise',
      workspaceRelated: false,
      needsExternalFacts: true,
      webInteractionRequired: false,
      systemBrowserRequested: false,
      taskComplexity: 'low',
      planDepth: 'single_step',
    },
    routeState: {
      answerMode: 'advise',
      workspaceRelated: false,
      needsExternalFacts: true,
      webInteractionRequired: false,
      explicitSystemBrowserRequest: false,
    },
  })

  assert.equal(result.selectedTools[0].name, 'web_search')
  assert.ok(
    result.selectedTools.findIndex(tool => tool.name === 'web_search') <
      result.selectedTools.findIndex(tool => tool.name === 'read_file'),
  )
})

test('selectTurnCapabilities exposes all enabled skills instead of prefiltering by text match', () => {
  const result = selectTurnCapabilities({
    messages: [
      {
        content: '请处理这个问题',
      },
    ],
    runtimeCapabilities: { workspaceRoot: '/tmp/workspace' },
    skillEntries: [
      {
        id: 'skill-a',
        name: 'Skill A',
      },
      {
        id: 'skill-b',
        name: 'Skill B',
      },
    ],
    tools: [buildTool('read_file')],
    classification: {
      answerMode: 'advise',
      workspaceRelated: false,
      needsExternalFacts: false,
      webInteractionRequired: false,
      systemBrowserRequested: false,
    },
    routeState: {
      answerMode: 'advise',
      workspaceRelated: false,
    },
  })

  assert.deepEqual(
    result.selectedSkills.map(skill => skill.id),
    ['skill-a', 'skill-b'],
  )
})
