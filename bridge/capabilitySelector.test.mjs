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

test('selectTurnCapabilities prefers write_file for explicit file creation requests', () => {
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

  assert.equal(result.selectedTools[0].name, 'write_file')
  assert.ok(
    result.selectedTools.findIndex(tool => tool.name === 'apply_patch') <
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
