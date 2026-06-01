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
      workspaceRelated: true,
      needsExternalFacts: false,
      webInteractionRequired: false,
      systemBrowserRequested: false,
    },
    routeState: {
      workspaceRelated: true,
    },
  })

  assert.equal(result.selectedTools[0].name, 'apply_patch')
  assert.ok(
    result.selectedTools.findIndex(tool => tool.name === 'write_file') <
      result.selectedTools.findIndex(tool => tool.name === 'edit_file'),
  )
})

test('selectTurnCapabilities keeps mounted execution tools available for model-directed code work', () => {
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
      workspaceRelated: true,
      needsExternalFacts: false,
      webInteractionRequired: false,
      systemBrowserRequested: false,
    },
    routeState: {
      workspaceRelated: true,
    },
  })

  assert.deepEqual(
    new Set(result.selectedTools.map(tool => tool.name)),
    new Set(['run_shell', 'exec_command', 'write_stdin', 'apply_patch', 'edit_file', 'multi_edit_file']),
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
      workspaceRelated: false,
      needsExternalFacts: true,
      webInteractionRequired: false,
      systemBrowserRequested: false,
      taskComplexity: 'low',
      planDepth: 'single_step',
    },
    routeState: {
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

test('selectTurnCapabilities prioritizes Aura skill tools for capability admin tasks', () => {
  const result = selectTurnCapabilities({
    messages: [
      {
        content: '安装这个 Aura skill',
      },
    ],
    runtimeCapabilities: { workspaceRoot: '/tmp/workspace' },
    skillEntries: [],
    tools: [
      buildTool('web_fetch', ['fetch']),
      buildTool('exec_command', ['exec']),
      buildTool('aura_enable_skill', ['enable']),
      buildTool('aura_install_skill', ['install']),
      buildTool('aura_import_skill', ['import']),
    ],
    classification: {
      workspaceRelated: false,
      needsExternalFacts: true,
      webInteractionRequired: false,
      isCapabilityAdmin: true,
      systemBrowserRequested: false,
    },
    routeState: {
      workspaceRelated: false,
      needsExternalFacts: true,
      isCapabilityAdminTask: true,
    },
  })

  assert.equal(result.selectedTools[0].name, 'aura_install_skill')
  assert.ok(
    result.selectedTools.findIndex(tool => tool.name === 'aura_import_skill') <
      result.selectedTools.findIndex(tool => tool.name === 'exec_command'),
  )
})

test('selectTurnCapabilities boosts spawn_agent for complex tasks', () => {
  const result = selectTurnCapabilities({
    messages: [
      {
        content: '分析这个大型代码库并并行处理几个独立问题',
      },
    ],
    runtimeCapabilities: { workspaceRoot: '/tmp/workspace' },
    skillEntries: [],
    tools: [
      buildTool('read_file', ['read']),
      buildTool('spawn_agent', ['agent']),
      buildTool('web_search', ['search']),
    ],
    classification: {
      workspaceRelated: true,
      needsExternalFacts: false,
      webInteractionRequired: false,
      systemBrowserRequested: false,
      taskComplexity: 'high',
      planDepth: 'multi_step',
    },
    routeState: {
      workspaceRelated: true,
    },
  })

  assert.ok(
    result.selectedTools.findIndex(tool => tool.name === 'spawn_agent') <
      result.selectedTools.findIndex(tool => tool.name === 'web_search'),
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
      workspaceRelated: false,
      needsExternalFacts: false,
      webInteractionRequired: false,
      systemBrowserRequested: false,
    },
    routeState: {
      workspaceRelated: false,
    },
  })

  assert.deepEqual(
    result.selectedSkills.map(skill => skill.id),
    ['skill-a', 'skill-b'],
  )
})
