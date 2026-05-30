import test from 'node:test'
import assert from 'node:assert/strict'
import { filterToolsForSubagentRole } from './agent.mjs'

function tool(name, extra = {}) {
  return {
    source: 'builtin',
    name,
    ...extra,
  }
}

test('explorer subagent only receives read-only builtin tools', () => {
  const filtered = filterToolsForSubagentRole(
    [
      tool('read_file'),
      tool('search_code'),
      tool('todo_write'),
      tool('apply_patch', { approvalCategory: 'file_write' }),
      tool('write_file', { approvalCategory: 'file_write' }),
      tool('exec_command', { approvalCategory: 'shell' }),
      tool('plugin__demo__lookup', { source: 'plugin' }),
      tool('spawn_agent', { source: 'subagent' }),
    ],
    {
      subagentRole: 'explorer',
    },
  )

  assert.deepEqual(
    filtered.map(item => item.name),
    ['read_file', 'search_code', 'todo_write'],
  )
})

test('non-explorer subagents keep the selected tool list unchanged', () => {
  const selectedTools = [
    tool('read_file'),
    tool('apply_patch', { approvalCategory: 'file_write' }),
  ]

  assert.equal(filterToolsForSubagentRole(selectedTools, { subagentRole: 'worker' }), selectedTools)
})

test('verification subagent can inspect and run verification tools but cannot write or spawn', () => {
  const filtered = filterToolsForSubagentRole(
    [
      tool('read_file'),
      tool('search_code'),
      tool('verify_artifact'),
      tool('exec_command', { approvalCategory: 'shell' }),
      tool('write_stdin', { approvalCategory: 'shell' }),
      tool('apply_patch', { approvalCategory: 'file_write' }),
      tool('write_file', { approvalCategory: 'file_write' }),
      tool('spawn_agent', { source: 'subagent' }),
    ],
    {
      subagentRole: 'verification',
    },
  )

  assert.deepEqual(
    filtered.map(item => item.name),
    ['read_file', 'search_code', 'verify_artifact', 'exec_command', 'write_stdin'],
  )
})
