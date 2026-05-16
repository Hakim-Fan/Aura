import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildToolCatalog,
  createToolCatalogEntry,
  inferToolPermissionScope,
  inferToolRiskLevel,
} from './catalog.mjs'

test('tool catalog infers permission scope and risk level', () => {
  assert.equal(inferToolPermissionScope({ name: 'read_file' }), 'workspace_read')
  assert.equal(inferToolRiskLevel({ name: 'read_file' }), 'low')

  assert.equal(
    inferToolPermissionScope({ name: 'apply_patch', approvalCategory: 'file_write' }),
    'workspace_write',
  )
  assert.equal(
    inferToolRiskLevel({ name: 'apply_patch', approvalCategory: 'file_write' }),
    'medium',
  )

  assert.equal(
    inferToolPermissionScope({ name: 'exec_command', approvalCategory: 'shell' }),
    'shell',
  )
  assert.equal(
    inferToolRiskLevel({ name: 'exec_command', approvalCategory: 'shell' }),
    'high',
  )

  assert.equal(
    inferToolRiskLevel({ name: 'computer_click', approvalCategory: 'computer_use' }),
    'critical',
  )
})

test('createToolCatalogEntry produces stable audit metadata', () => {
  const entry = createToolCatalogEntry(
    {
      source: 'builtin',
      name: 'write_file',
      approvalCategory: 'file_write',
      description: 'Write a file.',
    },
    {
      key: 'builtin:write_file',
      layer: 'builtin',
    },
  )

  assert.equal(entry.key, 'builtin:write_file')
  assert.equal(entry.name, 'write_file')
  assert.equal(entry.source, 'builtin')
  assert.equal(entry.permissionScope, 'workspace_write')
  assert.equal(entry.riskLevel, 'medium')
  assert.equal(entry.supportsParallel, true)
})

test('buildToolCatalog indexes entries and counts high risk tools', () => {
  const catalog = buildToolCatalog([
    { source: 'builtin', name: 'read_file' },
    { source: 'builtin', name: 'run_shell', approvalCategory: 'shell' },
    { source: 'builtin', name: 'computer_click', approvalCategory: 'computer_use' },
  ])

  assert.equal(catalog.entries.length, 3)
  assert.equal(catalog.byName.get('run_shell').permissionScope, 'shell')
  assert.equal(catalog.highRiskCount, 2)
})
