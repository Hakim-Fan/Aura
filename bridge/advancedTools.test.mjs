import test from 'node:test'
import assert from 'node:assert/strict'
import { createAdvancedTools } from './advancedTools.mjs'

test('createAdvancedTools omits macOS-only computer tools on Windows', () => {
  const tools = createAdvancedTools({
    platform: 'win32',
    settings: {
      enableComputerUse: true,
      enableMultiAgent: false,
      browser: {
        interactive: {
          enabled: true,
        },
      },
    },
    context: {
      cwd: process.cwd(),
    },
    runtimeMeta: {},
  })

  assert.equal(tools.some(tool => tool.name.startsWith('computer_')), false)
  assert.equal(tools.some(tool => tool.name === 'system_browser_open'), true)
})

test('createAdvancedTools keeps subagent hidden unless experimental flag is enabled', () => {
  const baseOptions = {
    platform: 'darwin',
    context: {
      cwd: process.cwd(),
    },
    runtimeMeta: {},
  }

  const defaultTools = createAdvancedTools({
    ...baseOptions,
    settings: {
      enableMultiAgent: true,
    },
  })

  const experimentalTools = createAdvancedTools({
    ...baseOptions,
    settings: {
      enableMultiAgent: true,
      experimentalSubagentEnabled: true,
    },
  })

  assert.equal(defaultTools.some(tool => tool.name === 'spawn_subagent'), false)
  assert.equal(
    experimentalTools.some(tool => tool.name === 'spawn_subagent'),
    true,
  )
})
